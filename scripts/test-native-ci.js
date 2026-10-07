import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { load } = require('js-yaml');
const { commands, durations, run, shard } = require('./test-client-dom.cjs');
const { focusTooltipPreview } = require('../apps/client/test/tooltipSmoke.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = name => load(fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8'));
const ci = workflow('ci.yml');
const release = workflow('release.yml');
const step = (job, name) => {
  const result = job.steps.find(candidate => candidate.name === name);
  assert.ok(result, `Missing step: ${name}`);
  return result;
};

test('the cross-platform lock retains macOS DMG dependencies and packaging checks load them', () => {
  const { packages } = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.ok(packages['node_modules/dmg-builder'].optionalDependencies['dmg-license']);
  for (const name of ['dmg-license', 'iconv-corefoundation']) {
    const locked = packages[`node_modules/${name}`];
    assert.ok(locked, `Missing macOS optional dependency: ${name}`);
    assert.ok(locked.os.includes('darwin'));
    assert.ok(locked.integrity, `Missing integrity for ${name}`);
    for (const dependency of Object.keys(locked.dependencies)) {
      assert.ok(packages[`node_modules/${name}/node_modules/${dependency}`] || packages[`node_modules/${dependency}`],
        `Missing ${name} dependency: ${dependency}`);
    }
  }
  for (const [job, guarded] of [[ci.jobs['package-mac'], false], [release.jobs.build, true]]) {
    const verify = step(job, 'Verify macOS DMG packaging dependencies');
    assert.equal(verify.if, guarded ? "runner.os == 'macOS'" : undefined);
    assert.equal(verify.run, `node -e "require('dmg-builder/out/dmgLicense.js')"`);
    assert.ok(job.steps.indexOf(verify) > job.steps.indexOf(step(job, 'Install dependencies')));
  }
  assert.equal(ci.jobs['package-mac']['runs-on'], 'macos-15');
});

test('macOS corresponding-source manifests preserve their Monky commit URL for release rebinding', () => {
  const packer = fs.readFileSync(path.join(root, 'apps', 'client', 'native', 'screen-share',
    'scripts', 'packMacSources.cjs'), 'utf8');
  assert.match(packer, /monkySource: `https:\/\/github\.com\/MonkyOrg\/Monky\/tree\/\$\{sourceCommit\}`/);
});

test('beta publication requires main and cannot use a manual working-branch dispatch', () => {
  const guard = step(release.jobs.version, 'Require merged-main release flow');
  assert.equal(release.jobs.version.steps[0], guard);
  assert.deepEqual(guard.env, {
    RELEASE_EVENT: '${{ github.event_name }}',
    RELEASE_REF: '${{ github.ref }}',
    PROMOTE_TAG: '${{ github.event.inputs.promote_tag }}',
  });
  assert.match(guard.run, /"\$RELEASE_REF" != "refs\/heads\/main"/u);
  assert.match(guard.run, /"\$RELEASE_EVENT" != "push".*"\$PROMOTE_TAG"/u);
  assert.match(guard.run, /exit 1/u);
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
  for (const [event, ref, promote, expected] of [
    ['push', 'refs/heads/main', '', 0],
    ['push', 'refs/heads/work', '', 1],
    ['workflow_dispatch', 'refs/heads/work', '', 1],
    ['workflow_dispatch', 'refs/heads/main', '', 1],
    ['workflow_dispatch', 'refs/heads/work', 'v1.0.0-beta', 1],
    ['workflow_dispatch', 'refs/heads/main', 'v1.0.0-beta', 0],
  ]) {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', guard.run], {
      encoding: 'utf8', env: { ...process.env, RELEASE_EVENT: event, RELEASE_REF: ref, PROMOTE_TAG: promote },
    });
    assert.ifError(result.error);
    assert.equal(result.status, expected, `${event}/${ref}/${promote}: ${result.stderr}`);
  }
});

test('Electron is explicitly installed before browser tests instead of downloading within their deadlines', () => {
  for (const [job, dependencyStep, testStep] of [
    [ci.jobs['light-native'], 'Prepare disposable voice interoperability fixtures',
      'Exercise native and Chromium voice through a real isolated server'],
    [ci.jobs['client-dom'], 'Install dependencies', 'Exercise client DOM and microphone state in Electron'],
    [ci.jobs['client-dom-mac'], 'Install dependencies', 'Exercise client DOM and microphone state in Electron'],
    [ci.jobs['package-win'], 'Install dependencies', 'Exercise prepared application startup and scenarios'],
    [ci.jobs['package-mac'], 'Install dependencies', 'Exercise prepared application startup and scenarios'],
  ]) {
    const install = step(job, 'Install Electron runtime before tests');
    assert.equal(install.run, 'npm exec --no -- install-electron');
    assert.equal(install.if, undefined);
    assert.equal(install['continue-on-error'], undefined);
    assert.ok(job.steps.indexOf(install) > job.steps.indexOf(step(job, dependencyStep)));
    assert.ok(job.steps.indexOf(install) < job.steps.indexOf(step(job, testStep)));
  }
  assert.doesNotMatch(step(ci.jobs['light-native'], 'Prepare disposable voice interoperability fixtures').run,
    /npm rebuild[^\n]*\belectron\b/);
});

test('macOS fixtures use the complete FFmpeg codec set even when minimal FFmpeg is already installed', () => {
  for (const [job, consumer] of [[ci.jobs['client-dom-mac'], 'Exercise client DOM and microphone state in Electron'],
    [ci.jobs['package-mac'], 'Exercise prepared application startup and scenarios']]) {
    const install = step(job, 'Install FFmpeg for generated voice fixtures');
    assert.equal(install['continue-on-error'], undefined);
    assert.match(install.run, /^#[^\n]*\nbrew install ffmpeg-full/u);
    assert.doesNotMatch(install.run, /brew install ffmpeg(?:\s|$)/);
    assert.match(install.run, /ffmpeg_bin="\$\(brew --prefix ffmpeg-full\)\/bin"/);
    assert.match(install.run, /echo "\$ffmpeg_bin" >> "\$GITHUB_PATH"/);
    assert.match(install.run, /export PATH="\$ffmpeg_bin:\$PATH"/);
    assert.match(install.run, /ffmpeg -hide_banner -encoders \| grep -E .*libvorbis/);
    assert.ok(job.steps.indexOf(install) < job.steps.indexOf(step(job, consumer)));
  }
});

test('camera graphics use supported CI backends without weakening macOS or changing local startup', () => {
  const source = fs.readFileSync(path.join(root, 'apps/client/test/fixtures/ciGraphics.cjs'), 'utf8');
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const enabled of [undefined, 'false', 'true']) {
      const module = { exports: {} };
      runInNewContext(source, { module, process: { platform, env: { CI: enabled } } });
      const switches = [];
      module.exports({ commandLine: { appendSwitch: (...args) => switches.push(args) } });
      assert.deepEqual(switches, enabled !== 'true' ? [] : [
        ['use-gl', 'angle'],
        ['use-angle', platform === 'darwin' ? 'metal' : platform === 'win32' ? 'd3d11-warp' : 'swiftshader'],
        ...(platform === 'linux' ? [['enable-unsafe-swiftshader']] : []),
      ]);
    }
  }
});

test('DOM lanes run from the start on both systems, independently of native compilation, behind one gate', () => {
  const dom = ci.jobs['client-dom'];
  assert.equal(dom['runs-on'], 'windows-2022');
  assert.equal(dom.needs, undefined);
  const mac = ci.jobs['client-dom-mac'];
  assert.equal(mac['runs-on'], 'macos-15');
  assert.equal(mac.needs, undefined);
  for (const [job, shards, label] of [[dom, [1, 2, 3], 'Windows'], [mac, [1, 2], 'macOS']]) {
    assert.deepEqual(job.strategy.matrix.shard, shards);
    assert.equal(job.strategy['fail-fast'], false);
    assert.equal(job.name, `Client DOM (${label} \${{ matrix.shard }}/${shards.length})`);
    const lane = step(job, 'Exercise client DOM and microphone state in Electron');
    assert.equal(lane.run, 'node scripts/test-client-dom.cjs');
    assert.deepEqual(lane.env, { MONKY_DOM_SHARD: `\${{ matrix.shard }}/${shards.length}` },
      'Every DOM shard must have exactly one matrix lane.');
  }
  const macDom = step(mac, 'Exercise client DOM and microphone state in Electron');
  assert.ok(mac.steps.indexOf(step(mac, 'Prepare an isolated macOS test Keychain')) < mac.steps.indexOf(macDom));
  assert.equal(step(mac, 'Restore macOS Keychain configuration').if, 'always()');

  for (const job of [dom, mac]) {
    assert.equal(step(job, 'Build workspaces').run, 'npm run build');
    assert.equal(step(job, 'Install dependencies').run, 'npm ci');
    assert.ok(!job.steps.some(candidate => /prepare:native-screen|prepareMacRtc|buildMacRtc|download-artifact/u
      .test(`${candidate.run ?? ''}${candidate.uses ?? ''}`)), 'DOM lanes must not wait for or build native outputs.');
  }
  for (const job of [ci.jobs['package-win'], ci.jobs['package-mac']])
    assert.ok(!job.steps.some(candidate => candidate.run?.includes('test-client-dom.cjs')), 'DOM must not run twice.');

  const gate = ci.jobs.build;
  assert.equal(gate.name, 'Build check (${{ matrix.platform }})');
  assert.deepEqual(gate.strategy.matrix.platform, ['win', 'mac']);
  assert.equal(gate.if, 'always()');
  assert.deepEqual(gate.needs, ['package-win', 'package-mac', 'client-dom', 'client-dom-mac', 'mac-native-sources']);
  const check = step(gate, 'Require packaging, DOM and native hardware success');
  assert.deepEqual(check.env, {
    PACKAGE_WIN: '${{ needs.package-win.result }}', PACKAGE_MAC: '${{ needs.package-mac.result }}',
    DOM_WIN: '${{ needs.client-dom.result }}', DOM_MAC: '${{ needs.client-dom-mac.result }}',
    NATIVE_MAC: '${{ needs.mac-native-sources.result }}',
  });
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : 'bash';
  const lanes = Object.keys(check.env);
  for (const failed of [null, ...lanes]) for (const outcome of ['failure', 'skipped', 'cancelled']) {
    if (failed === null && outcome !== 'failure') continue;
    const env = Object.fromEntries(lanes.map(lane => [lane, lane === failed ? outcome : 'success']));
    const result = spawnSync(bash, ['--noprofile', '--norc', '-e', '-c', check.run],
      { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.ifError(result.error);
    assert.equal(result.status === 0, failed === null, `${failed ?? 'all lanes'} ${outcome}`);
  }
});

test('CI exercises channel permissions and screen privacy alongside voice lifecycle tests', () => {
  const server = step(ci.jobs['bot-tests'], 'Test server, client state and real bot conversations');
  assert.ok(server.run.split('\n').includes('npm run test:community --workspace=apps/server'));
  const command = server.run.split('\n').find(line => line.startsWith('node --test '));
  assert.ok(command);
  assert.ok(command.split(' ').includes('apps/server/dist/test-screen-subscriptions.js'));
  assert.ok(command.split(' ').includes('apps/server/dist/test-voice.js'));
  assert.equal(server['continue-on-error'], undefined);
});

test('both build lanes and release retain the qualified Windows toolchain and no validation bypass', () => {
  for (const job of [ci.jobs['client-dom'], ci.jobs['package-win'], release.jobs.build]) {
    assert.deepEqual(step(job, 'Setup MSVC (Windows)').with, {
      vsversion: '2022', toolset: '14.44', sdk: '10.0.26100.0',
    });
  }
  for (const job of [ci.jobs['client-dom'], ci.jobs['client-dom-mac'], ci.jobs['package-win'], ci.jobs['package-mac'],
    ci.jobs['mac-native'], ci.jobs['mac-sources'], release.jobs.build]) {
    assert.equal(job.steps.find(candidate => candidate.uses === 'actions/setup-python@v5').with['python-version'], '3.11');
    assert.equal(job.steps.find(candidate => candidate.uses === 'actions/setup-node@v4').with['node-version'], 22);
    assert.ok(job.steps.every(candidate => !candidate['continue-on-error']));
  }
  for (const [platform, packaging] of [['win', ci.jobs['package-win']], ['mac', ci.jobs['package-mac']]]) {
    assert.match(step(packaging, 'Exercise native screen contracts and legal metadata').run,
      /npm run test:native-screen --workspace=apps\/client\s+npm run test:legal/u);
    assert.match(step(packaging, 'Exercise prepared application startup and scenarios').run, /npm run test:qa/u);
    assert.match(step(packaging, 'Exercise shortcut capture and worker recovery').run, /shortcutWorkerSmoke\.cjs/u);
    assert.equal(step(packaging, `Package ${platform} (dir, no publish)`).run,
      `npx --no-install electron-builder --${platform} --dir --publish never`);
  }
});

test('every CI and release job has a bounded runtime instead of the six-hour default', () => {
  for (const [name, definition] of [['ci.yml', ci], ['release.yml', release],
    ['native-macos-validation.yml', workflow('native-macos-validation.yml')]]) {
    for (const [id, job] of Object.entries(definition.jobs)) {
      if (job.uses) continue;
      assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 180,
        `${name} ${id} needs timeout-minutes`);
    }
  }
});

test('download caches stay download-only; compiled native outputs reuse only exact, re-verified keys', () => {
  for (const [job, namespace] of [[ci.jobs['package-win'], 'ci'], [release.jobs.build, 'release']]) {
    const cache = step(job, 'Cache verified native screen archives (Windows)');
    assert.equal(cache.uses, 'actions/cache@v4');
    assert.equal(cache.with.path, '.native-screen\\downloads');
    assert.equal(cache.with['restore-keys'], undefined);
    assert.equal(cache.id, undefined, 'Archive cache hits never decide whether to compile.');
    if (namespace === 'release') {
      assert.match(cache.if, /runner\.os == 'Windows'/u);
      assert.match(cache.if, /needs\.version\.outputs\.reuse_build != 'true'/u);
    } else {
      assert.equal(cache.if, undefined);
      assert.equal(job['runs-on'], 'windows-2022');
    }
    assert.ok(cache.with.key.startsWith(`native-screen-archives-v1-${namespace}-windows-x64-`));
    for (const input of ['scripts/fetchObs.cjs', 'scripts/buildTools.cjs', 'src/vendor/obs/sources.json',
      'src/vendor/obs/runtime-inputs.json', 'src/capture/runtime-additions.json']) {
      assert.ok(cache.with.key.includes(`'apps/client/native/screen-share/${input}'`));
      assert.ok(fs.existsSync(path.join(root, 'apps', 'client', 'native', 'screen-share', ...input.split('/'))));
    }
    const prepare = job.steps.find(candidate => candidate.run?.includes('npm run prepare:native-screen')
      && candidate.run.includes('--jobs=4'));
    assert.ok(prepare);
    assert.ok(job.steps.indexOf(cache) < job.steps.indexOf(prepare));
    assert.match(prepare.run, /--python="\$env:PYTHON" --git="\$Git" --jobs=4/u);
  }
  assert.ok(!release.jobs.build.steps.some(candidate => candidate.uses?.startsWith('actions/cache/restore')),
    'The release never compiles or publishes from a cache hit.');
  assert.doesNotMatch(step(release.jobs.build, 'Build native screen runtime and corresponding sources (Windows)').if, /cache-hit/u);

  const native = 'apps/client/native/screen-share';
  const macPaths = [`${native}/bin/darwin-arm64`, `${native}/bin/darwin-x64`];
  const winPaths = [`${native}/bin/win32-x64`, `${native}/licenses`, `${native}/LICENSE`, `${native}/THIRD_PARTY_NOTICES`];
  const lines = value => value.trim().split('\n');
  for (const [job, platform, paths, compileName, acceptance] of [
    [ci.jobs['mac-native'], 'mac', macPaths, 'Build native macOS runtime', 'Verify native runtime against this checkout'],
    [ci.jobs['package-win'], 'win', winPaths, 'Build native screen runtime and corresponding-source inputs (Windows)',
      'Exercise native screen contracts and legal metadata'],
  ]) {
    const key = step(job, 'Identify native runtime inputs and toolchain');
    assert.equal(key.id, 'key');
    assert.equal(key.run, `node scripts/native-cache-key.cjs ${platform}`);
    const restore = step(job, 'Restore verified native runtime');
    assert.equal(restore.uses, 'actions/cache/restore@v4');
    assert.equal(restore.id, 'cache');
    assert.deepEqual(restore.with, { path: restore.with.path, key: '${{ steps.key.outputs.key }}' },
      'Only the exact content key may restore compiled outputs; no restore-keys.');
    assert.deepEqual(lines(restore.with.path), paths);
    const compile = step(job, compileName);
    assert.equal(compile.if, "steps.cache.outputs.cache-hit != 'true'");
    const verify = step(job, 'Verify native runtime against this checkout');
    assert.equal(verify.if, undefined, 'Built and restored outputs pass the same acceptance checks.');
    assert.match(verify.run, new RegExp(`verifyOutputs\\.cjs ${platform}$`, 'mu'));
    const save = step(job, 'Save verified native runtime');
    assert.equal(save.uses, 'actions/cache/save@v4');
    assert.equal(save.if, "steps.cache.outputs.cache-hit != 'true'");
    assert.deepEqual(save.with, restore.with);
    const order = [key, restore, compile, verify, step(job, acceptance), save].map(candidate => job.steps.indexOf(candidate));
    assert.ok(order.every((index, position) => position === 0 || index >= order[position - 1]), `${platform} cache order`);
  }
  const fetch = step(ci.jobs['package-win'], 'Fetch corresponding-source inputs for the cached runtime (Windows)');
  assert.equal(fetch.if, "steps.cache.outputs.cache-hit == 'true' && steps.sources.outputs.cache-hit != 'true'",
    'Pinned sources are fetched only when a cached runtime still needs its source archive packed.');
  assert.match(fetch.run, /npm run prepare:native-screen -- --python="\$env:PYTHON" --git="\$Git" --fetch-only$/mu);
  assert.ok(ci.jobs['package-win'].steps.indexOf(fetch)
    < ci.jobs['package-win'].steps.indexOf(step(ci.jobs['package-win'], 'Package reusable corresponding sources (Windows)')));
  assert.equal(ci.jobs['mac-native'].outputs['cache-key'], '${{ steps.key.outputs.key }}');
  assert.equal(step(ci.jobs['package-win'], 'Export verified desktop build').env.MONKY_NATIVE_CACHE_KEY,
    '${{ steps.key.outputs.key }}');
  assert.equal(step(ci.jobs['package-mac'], 'Export verified desktop build').env.MONKY_NATIVE_CACHE_KEY,
    '${{ needs.mac-native.outputs.cache-key }}');

  const build = release.jobs.build;
  const restored = step(build, 'Restore approved desktop build');
  assert.equal(restored.id, 'restore');
  const guarded = os => `needs.version.outputs.reuse_build == 'true' && runner.os == '${os}' && steps.restore.outputs.native_cache_key != ''`;
  const order = [];
  for (const [os, paths, platform] of [['macOS', macPaths, 'mac'], ['Windows', winPaths, 'win']]) {
    const verify = step(build, `Verify the approved native runtime before sharing it (${os})`);
    assert.equal(verify.if, guarded(os));
    assert.match(verify.run, new RegExp(`verifyOutputs\\.cjs ${platform}$`, 'mu'));
    if (os === 'macOS') assert.match(verify.run, /^arch -x86_64 \/usr\/bin\/true$/mu, 'x64 self-tests need Rosetta.');
    const share = step(build, `Share the approved native runtime with later CI (${os})`);
    assert.equal(share.uses, 'actions/cache/save@v4');
    assert.equal(share.if, guarded(os));
    assert.equal(share.with.key, '${{ steps.restore.outputs.native_cache_key }}');
    assert.deepEqual(lines(share.with.path), paths, 'Release seeds exactly the paths CI restores.');
    assert.equal(build.steps.indexOf(share), build.steps.indexOf(verify) + 1,
      'A runtime is shared only right after passing the same acceptance checks as CI.');
    order.push(build.steps.indexOf(verify), build.steps.indexOf(share));
  }
  const { cachePaths } = require('./native-sources-cache.cjs');
  for (const [os, platform, id] of [['macOS', 'mac', 'mac-sources'], ['Windows', 'win', 'win-sources']]) {
    const verify = step(build, `Verify the approved corresponding sources before sharing them (${os})`);
    assert.equal(verify.id, id);
    assert.equal(verify.if, `needs.version.outputs.reuse_build == 'true' && runner.os == '${os}'`);
    assert.equal(verify.run, `node scripts/native-sources-cache.cjs verify ${platform} --legacy-ok`);
    const share = step(build, `Share the approved corresponding sources with later CI (${os})`);
    assert.equal(share.uses, 'actions/cache/save@v4');
    assert.equal(share.if, `needs.version.outputs.reuse_build == 'true' && runner.os == '${os}' && steps.${id}.outputs.key != ''`,
      'Artifacts packed before source keys existed are not shared.');
    assert.equal(share.with.key, `\${{ steps.${id}.outputs.key }}`);
    assert.deepEqual(lines(share.with.path), cachePaths[platform], 'Release seeds exactly the paths CI restores.');
    assert.equal(build.steps.indexOf(share), build.steps.indexOf(verify) + 1);
    order.push(build.steps.indexOf(verify), build.steps.indexOf(share));
  }
  assert.deepEqual(order, order.map((_, index) => build.steps.indexOf(restored) + 1 + index),
    'Verify and seed straight from the restored artifact, before any release step can touch the outputs.');
  assert.ok(order.every(index => index < build.steps.indexOf(step(build, 'Bind approved corresponding sources to release (Windows)'))
    && index < build.steps.indexOf(step(build, 'Bind approved corresponding sources to release (macOS)'))),
  'Sources are shared before rebinding moves them to the release name.');
});

test('corresponding sources are packed once per committed native inputs and verified before every use', () => {
  const { cachePaths } = require('./native-sources-cache.cjs');
  const lines = value => value.trim().split('\n');
  for (const [job, platform, ids, prepare, pack, verifyName, saveName, restoreName] of [
    [ci.jobs['mac-sources'], 'mac', { cache: 'cache' }, ['Prepare the pinned macOS RTC SDK', 'Generate notices from both GN target graphs'],
      'Package corresponding sources with parallel xz', 'Verify corresponding sources against this checkout',
      'Save verified corresponding sources', 'Restore verified corresponding sources'],
    [ci.jobs['package-win'], 'win', { cache: 'sources' }, ['Fetch corresponding-source inputs for the cached runtime (Windows)'],
      'Package reusable corresponding sources (Windows)', 'Verify corresponding sources against this checkout (Windows)',
      'Save verified corresponding sources (Windows)', 'Restore verified corresponding sources (Windows)'],
  ]) {
    const key = job.steps.find(candidate => candidate.id === 'key');
    assert.equal(key.run, `node scripts/native-cache-key.cjs ${platform}`);
    const restore = step(job, restoreName);
    assert.equal(restore.id, ids.cache);
    assert.equal(restore.uses, 'actions/cache/restore@v4');
    assert.deepEqual(restore.with, { path: restore.with.path, key: '${{ steps.key.outputs.sources_key }}' },
      'Only the exact source key may restore an archive; no restore-keys.');
    assert.deepEqual(lines(restore.with.path), cachePaths[platform]);
    const miss = `steps.${ids.cache}.outputs.cache-hit != 'true'`;
    for (const name of [...prepare, pack]) assert.match(step(job, name).if, new RegExp(miss.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')), name);
    const verify = step(job, verifyName);
    assert.equal(verify.if, undefined, 'Restored and freshly packed sources pass the same checks.');
    assert.equal(verify.run, `node scripts/native-sources-cache.cjs verify ${platform}`, 'CI never accepts legacy archives.');
    const save = step(job, saveName);
    assert.equal(save.if, miss);
    assert.deepEqual(save.with, restore.with);
    const order = [key, restore, step(job, pack), verify, save].map(candidate => job.steps.indexOf(candidate));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), `${platform} sources cache order`);
  }
  const select = step(ci.jobs['package-win'], 'Select Python for native tooling (Windows)');
  assert.equal(select.if, undefined, 'Source archive tests need Python even when nothing is compiled.');
  assert.ok(ci.jobs['package-win'].steps.indexOf(select)
    < ci.jobs['package-win'].steps.indexOf(step(ci.jobs['package-win'], 'Exercise native screen contracts and legal metadata')));
  for (const file of ['packSources.cjs', 'packMacSources.cjs']) {
    const packer = fs.readFileSync(path.join(root, 'apps', 'client', 'native', 'screen-share', 'scripts', file), 'utf8');
    assert.match(packer, /nativeSourceKey: sourcesKey\('(?:win|mac)', \{ base: repository \}\)/u,
      `${file} must record the committed native inputs its archive corresponds to.`);
  }
});

test('the corresponding-source key covers every packed checkout input, is OS-independent and ignores unrelated files', t => {
  const { sourceInputs, sourcesKey, SOURCES_KEY, inputs } = require('./native-cache-key.cjs');
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'monky-sources-key-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: base, encoding: 'utf8' });
  git('-c', 'init.templateDir=', 'init', '--quiet');
  const isFile = entry => /(\.[a-z]+|LICENSE)$/u.test(entry);
  const write = (relative, text) => {
    fs.mkdirSync(path.dirname(path.join(base, relative)), { recursive: true });
    fs.writeFileSync(path.join(base, relative), text);
  };
  const commit = message => {
    git('add', '--all');
    assert.equal(git('-c', 'user.name=F', '-c', 'user.email=f@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '--allow-empty', '-m', message).status, 0);
  };
  const all = [...new Set(Object.values(sourceInputs).flat())];
  // Everything the packers copy from the checkout into the archive or its notices must be in the key.
  const native = 'apps/client/native/screen-share';
  const packed = {
    win: [`${native}/src`, `${native}/scripts`, `${native}/README.md`, `${native}/README.en.md`,
      'patches/h264-profile-level-id+2.3.3.patch', 'LICENSE', 'scripts/legal.cjs'],
    mac: [`${native}/src/rtc`, `${native}/src/mac`, `${native}/scripts`, `${native}/README.md`, `${native}/README.en.md`,
      'LICENSE', 'scripts/legal.cjs'],
  };
  for (const platform of ['mac', 'win'])
    for (const entry of packed[platform]) assert.ok(sourceInputs[platform].includes(entry), `${platform} source key misses ${entry}`);
  for (const entry of all) write(isFile(entry) ? entry : `${entry}/input.txt`, `original ${entry}\n`);
  write('apps/client/src/unrelated.ts', 'original');
  commit('inputs');
  for (const platform of ['mac', 'win']) {
    for (const entry of inputs[platform]) assert.ok(sourceInputs[platform].includes(entry), `Sources cover runtime input ${entry}`);
    const original = sourcesKey(platform, { base });
    assert.match(original, SOURCES_KEY);
    write('apps/client/src/unrelated.ts', 'changed'); commit('unrelated');
    assert.equal(sourcesKey(platform, { base }), original, 'Unrelated commits keep the archive reusable.');
    write(isFile(sourceInputs[platform][0]) ? sourceInputs[platform][0] : `${sourceInputs[platform][0]}/input.txt`, 'dirty');
    assert.equal(sourcesKey(platform, { base }), original, 'The key describes committed content; packing requires a clean tree.');
    git('checkout', '--', '.');
    for (const entry of sourceInputs[platform]) {
      const relative = isFile(entry) ? entry : `${entry}/input.txt`;
      write(relative, 'changed\r\n'); commit(`change ${entry}`);
      assert.notEqual(sourcesKey(platform, { base }), original, `${entry} must be part of the source key`);
      write(relative, `original ${entry}\n`); commit(`restore ${entry}`);
      assert.equal(sourcesKey(platform, { base }), original);
    }
  }
  for (const entry of all) assert.ok(fs.existsSync(path.join(root, ...entry.split('/'))), `Missing source input: ${entry}`);
  assert.throws(() => sourcesKey('linux', { base }), /mac or win/u);
});

test('the native cache key changes with every compiled input and toolchain, and ignores unrelated files', t => {
  const { cacheKey, inputs } = require('./native-cache-key.cjs');
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'monky-native-key-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const isFile = entry => /(?:\.cjs|^LICENSE)$/u.test(entry);
  const write = (relative, text) => {
    fs.mkdirSync(path.dirname(path.join(base, relative)), { recursive: true });
    fs.writeFileSync(path.join(base, relative), text);
  };
  for (const entry of new Set([...inputs.mac, ...inputs.win]))
    write(isFile(entry) ? entry : `${entry}/nested/input.cc`, `original ${entry}`);
  write('apps/client/src/unrelated.ts', 'original');
  const tools = { xcode: '16.4', node: 'v22' };
  for (const platform of ['mac', 'win']) {
    const original = cacheKey(platform, { tools, base });
    assert.match(original, new RegExp(`^native-${platform}-v1-[a-f0-9]{16}-[a-f0-9]{64}$`, 'u'));
    assert.equal(cacheKey(platform, { tools: { ...tools }, base }), original);
    write('apps/client/src/unrelated.ts', 'changed');
    assert.equal(cacheKey(platform, { tools, base }), original, 'Unrelated files must not invalidate native outputs.');
    assert.notEqual(cacheKey(platform, { tools: { ...tools, xcode: '16.5' }, base }), original);
    for (const entry of inputs[platform]) {
      const relative = isFile(entry) ? entry : `${entry}/nested/input.cc`;
      write(relative, 'changed');
      assert.notEqual(cacheKey(platform, { tools, base }), original, `${entry} must be part of the key`);
      write(relative, `original ${entry}`);
      if (!isFile(entry)) {
        write(`${entry}/added.cc`, 'new');
        assert.notEqual(cacheKey(platform, { tools, base }), original, `New files in ${entry} must change the key`);
        fs.rmSync(path.join(base, entry, 'added.cc'));
      }
      assert.equal(cacheKey(platform, { tools, base }), original);
    }
  }
  const macKey = cacheKey('mac', { tools, base }), winKey = cacheKey('win', { tools, base });
  write(`${inputs.win[0]}/capture/windows-only.cc`, 'windows only');
  assert.equal(cacheKey('mac', { tools, base }), macKey, 'Windows-only sources do not invalidate the macOS runtime.');
  assert.notEqual(cacheKey('win', { tools, base }), winKey);
  assert.match(cacheKey('mac', { tools, base: root }), /^native-mac-v1-/u);
  for (const entry of [...inputs.mac, ...inputs.win]) assert.ok(fs.existsSync(path.join(root, ...entry.split('/'))), entry);
  assert.throws(() => cacheKey('linux', { tools, base }), /mac or win/u);
});

test('release still generates corresponding sources from the clean version commit before version mutation', () => {
  const build = release.jobs.build;
  const prepare = step(build, 'Build native screen runtime and corresponding sources (Windows)');
  assert.match(prepare.run, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/u);
  assert.match(prepare.run, /npm run pack:native-sources -- --version=\$\{\{ needs\.version\.outputs\.version \}\}/u);
  assert.ok(build.steps.indexOf(prepare) < build.steps.indexOf(step(build, 'Set build version')));
  const rebind = step(build, 'Bind approved corresponding sources to release (Windows)');
  assert.equal(rebind.if, "needs.version.outputs.reuse_build == 'true' && runner.os == 'Windows'");
  assert.match(rebind.run, /pack:native-sources -- --from-ci --version=/);
  assert.ok(build.steps.indexOf(rebind) < build.steps.indexOf(step(build, 'Set build version')));
  assert.equal(step(release.jobs.version, 'Calculate Semantic Version').env.RELEASE_CHANNEL, 'beta');
  const verification = step(release.jobs.release, 'Verify corresponding sources before publishing binaries');
  assert.match(verification.run, /node scripts\/check-native-source-release\.js/u);
  assert.match(step(build, 'Upload build artifacts').with.path, /release\/monky-native-sources-\*\.tar\.xz/u);
});

test('macOS native runtime is built once, sourced in parallel, validated on its hardware and reused by release', () => {
  const nativeWorkflow = workflow('native-macos-validation.yml');
  assert.deepEqual(Object.keys(nativeWorkflow.on), ['workflow_call'],
    'No post-merge rerun: the merged tree is the PR tree CI already validated, and it could not block the release.');
  assert.deepEqual(nativeWorkflow.on.workflow_call.inputs['runtime-artifact'], {
    description: nativeWorkflow.on.workflow_call.inputs['runtime-artifact'].description, type: 'string', required: true,
  });
  const caller = ci.jobs['mac-native-sources'];
  assert.equal(caller.uses, './.github/workflows/native-macos-validation.yml');
  assert.equal(caller.needs, 'mac-native');
  assert.deepEqual(caller.with, { 'runtime-artifact': '${{ needs.mac-native.outputs.artifact }}' });
  const nativeMac = nativeWorkflow.jobs.sources;
  assert.deepEqual(nativeMac.strategy.matrix.include, [{ os: 'macos-15', arch: 'arm64' }, { os: 'macos-15-intel', arch: 'x64' }]);
  assert.equal(nativeMac['timeout-minutes'], 45);
  assert.ok(nativeMac.steps.every(candidate => !candidate['continue-on-error']));
  assert.ok(!nativeMac.steps.some(candidate => /prepareMacRtc|buildMac(?:Rtc)?\.cjs|notices\.cjs/u.test(candidate.run ?? '')),
    'Hardware validation tests the shipped binaries instead of compiling different ones.');
  const install = step(nativeMac, 'Install dependencies and compile the application contracts');
  assert.match(install.run, /^npm ci --ignore-scripts$/mu, 'The unused mediasoup worker must not compile from source on Intel.');
  assert.doesNotMatch(install.run, /mediasoup/u);
  const download = step(nativeMac, 'Download the shipped native runtime');
  assert.equal(download.uses, 'actions/download-artifact@v4');
  assert.equal(download.with.name, '${{ inputs.runtime-artifact }}');
  const verify = step(nativeMac, 'Verify source inventory, binary hashes and runtime on this hardware');
  assert.match(verify.run, /tar -xf "\$RUNNER_TEMP\/mac-native\/mac-native-runtime\.tar" -C apps\/client\/native\/screen-share/u);
  assert.match(verify.run, /verifyOutputs\.cjs mac --arch=\$\{\{ matrix\.arch \}\}$/mu);
  assert.equal(step(nativeMac, 'Exercise native screen contracts').run, 'npm run test:native-screen --workspace=apps/client');
  assert.match(step(nativeMac, 'Exercise actual VideoToolbox H264 encoding and callback retirement').run,
    /bin\/darwin-\$\{\{ matrix\.arch \}\}\/monky-screen-mac --encoder-smoke/u);
  const audio = step(nativeMac, 'Build native audio and verify AppKit lifecycle requirements');
  assert.match(audio.run, /node-gyp rebuild --directory=apps\/client\/native\/screen-audio/);
  assert.match(audio.run, /macAudioRuntime\.test\.cjs/);
  for (const name of ['Download the shipped native runtime', 'Verify source inventory, binary hashes and runtime on this hardware'])
    assert.ok(nativeMac.steps.indexOf(step(nativeMac, name)) < nativeMac.steps.indexOf(step(nativeMac, 'Exercise native screen contracts')));

  const compile = step(ci.jobs['mac-native'], 'Build native macOS runtime');
  assert.match(compile.run, /arch -x86_64 \/usr\/bin\/true/u);
  assert.match(compile.run, /prepareMacRtc\.cjs\n[\s\S]*for architecture in arm64 x64/u);
  assert.match(compile.run, /buildMac\.cjs --arch=\$architecture\n\s+node \S+buildMacRtc\.cjs --arch=\$architecture/u);
  assert.equal(ci.jobs['mac-native'].outputs.artifact, 'mac-native-runtime-${{ github.run_attempt }}');
  const bundle = step(ci.jobs['mac-native'], 'Bundle native runtime');
  assert.match(bundle.run, /^tar -cf "\$RUNNER_TEMP\/mac-native-runtime\.tar" -C apps\/client\/native\/screen-share bin\/darwin-arm64 bin\/darwin-x64$/u);
  const runtimeUpload = step(ci.jobs['mac-native'], 'Upload native runtime for packaging and hardware validation');
  assert.equal(runtimeUpload.with.name, ci.jobs['mac-native'].outputs.artifact);
  assert.ok(ci.jobs['mac-native'].steps.indexOf(step(ci.jobs['mac-native'], 'Verify native runtime against this checkout'))
    < ci.jobs['mac-native'].steps.indexOf(bundle));

  const sources = ci.jobs['mac-sources'];
  assert.equal(sources.needs, undefined, 'Corresponding sources need the GN graph, not compiled objects.');
  const notices = step(sources, 'Generate notices from both GN target graphs');
  assert.match(notices.run, /buildMacRtc\.cjs --arch=\$architecture --configure/u);
  assert.match(notices.run, /notices\.cjs --mac --architectures=arm64,x64$/mu);
  const pack = step(sources, 'Package corresponding sources with parallel xz');
  assert.deepEqual(pack.env, { MONKY_SOURCE_XZ: 'required' });
  assert.match(pack.run, /packMacSources\.cjs --version=0\.0\.0-ci --architectures=arm64,x64$/mu);
  assert.ok(sources.steps.indexOf(step(sources, 'Prepare the pinned macOS RTC SDK')) < sources.steps.indexOf(notices));
  assert.ok(sources.steps.indexOf(notices) < sources.steps.indexOf(pack));
  assert.equal(step(sources, 'Upload corresponding sources for packaging').with.name, sources.outputs.artifact);

  const packaging = ci.jobs['package-mac'];
  assert.deepEqual(packaging.needs, ['mac-native', 'mac-sources']);
  for (const [name, artifact] of [['Download the tested native runtime', '${{ needs.mac-native.outputs.artifact }}'],
    ['Download corresponding sources and notices', '${{ needs.mac-sources.outputs.artifact }}']])
    assert.equal(step(packaging, name).with.name, artifact);
  const installed = step(packaging, 'Verify native runtime against its corresponding sources');
  assert.match(installed.run, /verifyOutputs\.cjs mac --legal$/mu);
  for (const later of ['Exercise native screen contracts and legal metadata', 'Package mac (dir, no publish)', 'Export verified desktop build'])
    assert.ok(packaging.steps.indexOf(installed) < packaging.steps.indexOf(step(packaging, later)));

  const fresh = step(release.jobs.build, 'Build native media and corresponding sources (macOS)');
  assert.match(fresh.if, /needs\.version\.outputs\.reuse_build != 'true'/);
  const rebind = step(release.jobs.build, 'Bind approved corresponding sources to release (macOS)');
  assert.equal(rebind.if, "needs.version.outputs.reuse_build == 'true' && runner.os == 'macOS'");
  assert.match(rebind.run, /packMacSources\.cjs --from-ci --version=/);
  assert.ok(release.jobs.build.steps.indexOf(rebind)
    < release.jobs.build.steps.indexOf(step(release.jobs.build, 'Set build version')));
  const verification = step(release.jobs.release, 'Verify corresponding sources before publishing binaries');
  assert.match(verification.run, /check-native-source-release\.js[\s\S]*--mac/);
});

test('CI uploads only inventoried build outputs after testing, namespaced by immutable run attempt', () => {
  assert.deepEqual(ci.permissions, { contents: 'read' });
  assert.equal(step(ci.jobs['bot-tests'], 'Setup Python 3.11 (artifact regression tests)').with['python-version'], '3.11');
  for (const [job, variant, exportName, uploadName, tested] of [
    [ci.jobs['bot-tests'], 'cli', 'Export verified CLI build', 'Upload reusable CLI build', 'Exercise an isolated SDK installation'],
    [ci.jobs['package-win'], 'win', 'Export verified desktop build', 'Upload reusable desktop build',
      'Exercise shortcut capture and worker recovery'],
    [ci.jobs['package-mac'], 'mac', 'Export verified desktop build', 'Upload reusable desktop build',
      'Exercise shortcut capture and worker recovery'],
  ]) {
    const collect = step(job, exportName), upload = step(job, uploadName);
    assert.ok(job.steps.indexOf(collect) > job.steps.indexOf(step(job, tested)));
    assert.ok(job.steps.indexOf(upload) > job.steps.indexOf(collect));
    assert.equal(collect.run, `node scripts/ci-build-artifact.js collect ${variant} "\${{ runner.temp }}/ci-build-${variant}"`);
    assert.equal(upload.uses, 'actions/upload-artifact@v4');
    assert.equal(upload.with.name, `ci-build-${variant}-\${{ github.run_attempt }}`);
    assert.equal(upload.with.path, `\${{ runner.temp }}/ci-build-${variant}`);
    assert.equal(upload.with['if-no-files-found'], 'error');
    assert.equal(upload.with['compression-level'], 0);
    assert.equal(upload.with['retention-days'], 7);
    assert.equal(upload.with['include-hidden-files'], true);
  }
  const pack = step(ci.jobs['package-win'], 'Package reusable corresponding sources (Windows)');
  assert.equal(pack.run, 'npm run pack:native-sources -- --version=0.0.0-ci');
  assert.deepEqual(pack.env, { MONKY_SOURCE_XZ: 'required' }, 'CI must not silently fall back to single-thread compression.');
});

test('release reuses approved artifacts but always versions, packages, signs and verifies final distributables', () => {
  assert.equal(release.permissions.actions, 'read');
  assert.equal(release.jobs.version.outputs.reuse_build, '${{ steps.ci.outputs.reuse }}');
  const selection = step(release.jobs.version, 'Select approved CI build');
  assert.match(selection.run, /git rev-parse "\$\{CHECKOUT_REF\}\^\{commit\}"/);
  assert.equal(selection.env.GH_TOKEN, '${{ github.token }}');
  for (const name of ['Build workspaces', 'Cache verified native screen archives (Windows)',
    'Build native screen runtime and corresponding sources (Windows)']) {
    assert.match(step(release.jobs.build, name).if, /^needs\.version\.outputs\.reuse_build != 'true'/);
  }
  for (const name of ['Build shared and server', 'Build bot-sdk', 'Prepare the SFU worker for SDK voice tests', 'Test bot-sdk interactions']) {
    assert.match(step(release.jobs.cli, name).if, /^needs\.version\.outputs\.reuse_build != 'true'/);
  }
  for (const [job, name] of [[release.jobs.build, 'Restore approved desktop build'], [release.jobs.cli, 'Restore approved CLI build']]) {
    const restore = step(job, name);
    assert.equal(restore.if, "needs.version.outputs.reuse_build == 'true'");
    assert.match(restore.run, /ci-build-artifact.js restore/);
    assert.equal(restore.env.GH_TOKEN, '${{ github.token }}');
    assert.ok(job.steps.indexOf(restore) > job.steps.indexOf(step(job, 'Install dependencies')));
    assert.ok(job.steps.some(candidate => candidate.uses === 'actions/setup-python@v5'));
  }
  for (const name of ['Set build version', 'Build ${{ matrix.platform }} distributables', 'Upload build artifacts']) {
    assert.equal(step(release.jobs.build, name).if, undefined);
  }
  assert.match(step(release.jobs.build, 'Build ${{ matrix.platform }} distributables').run, /electron-builder/);
  assert.match(step(release.jobs.release, 'Verify corresponding sources before publishing binaries').run, /check-native-source-release/);
  assert.ok(step(release.jobs.release, 'Sign checksums with Cosign (keyless)'));
});

test('the extracted DOM lane preserves every existing test command and its ordering', () => {
  assert.deepEqual(commands.map(command => command.join(' ')), [
    'npm run test:bots:ui --workspace=apps/client',
    'npm run test:development --workspace=apps/client',
    'npm run test:updates --workspace=apps/client',
    'npm run test:editing --workspace=apps/client',
    'npm run test:clipboard --workspace=apps/client',
    'node apps/client/test/messageClipboardDomSmoke.cjs --system-clipboard',
    'npm run test:screens --workspace=apps/client',
    'node packages/bot-sdk/test-browser/voiceRendererSmoke.cjs',
    'node apps/client/test/userContextMenuSmoke.cjs',
    'node apps/client/test/audioDeviceSmoke.cjs',
    'node apps/client/test/liveAudioDeviceSmoke.cjs',
    'node apps/client/test/dropdownSmoke.cjs',
    'node apps/client/test/tooltipSmoke.cjs',
    'node apps/client/test/tooltipSmoke.cjs --delayed-native-input',
    'node apps/client/test/microphoneStateSmoke.cjs',
    'node apps/client/test/microphoneTestSmoke.cjs',
    'node apps/client/test/settingsNavigationSmoke.cjs',
    'node apps/client/test/settingsNavigationSmoke.cjs --release-notes',
    'node apps/client/test/settingsNavigationSmoke.cjs --quality-settings',
    'node apps/client/test/settingsNavigationSmoke.cjs --screen-stage',
    'node apps/client/test/settingsNavigationSmoke.cjs --screen-audience',
    'node apps/client/test/settingsNavigationSmoke.cjs --overlay-window',
    'npm run test:settings:ui --workspace=apps/client',
    'node apps/client/test/cameraEffectsSmoke.cjs',
    'node apps/client/test/cameraEffectsSmoke.cjs --packaged',
    'node apps/client/test/cameraEffectsSmoke.cjs --packaged --cpu-compositor --chroma-only --transitions-only',
    'node apps/client/test/cameraPublicationSmoke.cjs',
    'node apps/client/test/footerControlsSmoke.cjs',
    'npm run test:transport --workspace=apps/client',
    'npm run test:bot-marketplace --workspace=apps/client',
    'npm run test:soundboard --workspace=apps/client',
    'npm run test:community --workspace=apps/client',
    'npm run test:pip --workspace=apps/client',
  ]);
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'apps', 'client', 'package.json'), 'utf8')).scripts;
  for (const [executable, scriptOrRun, script] of commands) {
    if (executable === 'node') assert.ok(fs.existsSync(path.join(root, ...scriptOrRun.split('/'))));
    else assert.ok(scripts[script]);
  }
  // The camera suite runs as separate commands so shards can balance it; it must stay exactly test:camera.
  const camera = scripts['test:camera'].split('&&').map(part => part.trim().replace(/^node test\//u, 'node apps/client/test/'));
  assert.ok(camera.every(part => part.startsWith('node apps/client/test/')), 'test:camera must stay a chain of node commands.');
  const runner = commands.map(command => command.join(' '));
  const start = runner.indexOf(camera[0]);
  assert.deepEqual(runner.slice(start, start + camera.length), camera, 'The DOM runner must run every test:camera command, in order.');
  assert.ok(!runner.includes('npm run test:camera --workspace=apps/client'), 'Camera tests must not run twice.');
});

test('DOM runner preserves Windows npm shell handling, runs every command and reports all failures at the end', t => {
  t.mock.method(console, 'log', () => {});
  for (const platform of ['win32', 'darwin']) {
    const calls = [];
    run((executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0 };
    }, platform, {});
    assert.equal(calls.length, commands.length);
    for (const [index, call] of calls.entries()) {
      const [executable, ...args] = commands[index];
      assert.equal(call.executable, executable === 'node' ? process.execPath : 'npm');
      assert.deepEqual(call.args, args);
      assert.equal(call.options.cwd, path.resolve(root));
      assert.equal(call.options.shell, platform === 'win32' && executable === 'npm');
    }
  }
  const failing = new Map([[1, { status: 1 }], [4, { status: null, signal: 'SIGTERM' }], [7, { error: new Error('spawn failure') }]]);
  const labels = [...failing.keys()].map(index => commands[index].join(' '));
  for (const githubActions of [undefined, 'true']) {
    const logged = [];
    t.mock.method(console, 'log', line => logged.push(line));
    let calls = 0;
    assert.throws(() => run(() => failing.get(calls++) ?? { status: 0 }, 'win32', { GITHUB_ACTIONS: githubActions }),
      error => labels.every(label => error.message.includes(label)) && /3 DOM command\(s\) failed/u.test(error.message));
    assert.equal(calls, commands.length, 'A failure must not hide the results of the remaining commands.');
    const summary = logged.find(line => line.startsWith('FALHAS: '));
    assert.ok(summary && labels.every(label => summary.includes(label)));
    assert.match(summary, /exit 1/u);
    assert.match(summary, /exit SIGTERM/u);
    assert.match(summary, /spawn failure/u);
    const annotations = logged.filter(line => line.startsWith('::error::FALHOU '));
    assert.equal(annotations.length, githubActions === 'true' ? 3 : 0);
  }
  t.mock.method(console, 'log', () => {});
  let calls = 0;
  assert.throws(() => run(() => { calls++; return { status: 1 }; }, 'darwin', { MONKY_DOM_FAIL_FAST: '1' }), /1 DOM command/u);
  assert.equal(calls, 1);
});

test('DOM shards run every command exactly once, keep the suite order and balance the measured cost', () => {
  assert.equal(shard(undefined), commands);
  assert.equal(shard(''), commands);
  for (const invalid of ['0/2', '3/2', '1', '1/0', 'a/b', '1/2/3'])
    assert.throws(() => shard(invalid), /Invalid DOM shard/u);
  for (const count of [1, 2, 3]) {
    const parts = Array.from({ length: count }, (_, index) => shard(`${index + 1}/${count}`));
    assert.deepEqual(parts.flat().map(command => command.join(' ')).sort(),
      commands.map(command => command.join(' ')).sort());
    for (const part of parts) {
      assert.ok(part.length > 0);
      assert.deepEqual(part, commands.filter(command => part.includes(command)), 'Shards keep the original order.');
    }
  }
  for (const [platform, count] of [['win32', 3], ['darwin', 2]]) {
    const cost = command => durations[platform][command.join(' ')] ?? 10;
    const loads = Array.from({ length: count }, (_, index) =>
      shard(`${index + 1}/${count}`, commands, platform).reduce((total, command) => total + cost(command), 0));
    assert.ok(Math.max(...loads) <= 1.1 * Math.min(...loads), `Unbalanced ${platform} DOM shards: ${loads.join(' / ')} s`);
    for (const command of Object.keys(durations[platform]))
      assert.ok(commands.some(candidate => candidate.join(' ') === command), `Stale DOM duration: ${command}`);
  }
  const second = shard('2/2', commands, 'darwin').map(command => command.join(' '));
  const seen = [];
  run((executable, args) => { seen.push([executable === process.execPath ? 'node' : executable, ...args].join(' ')); return { status: 0 }; },
    'darwin', { MONKY_DOM_SHARD: '2/2' });
  assert.deepEqual(seen, second, 'The runner uses the shard of its own platform.');
});

test('ci:local mirrors CI commands from ci.yml and the DOM runner, skipping only runner-only steps', () => {
  const { plan, pairs } = require('./ci-local.cjs');
  for (const platform of ['win32', 'darwin']) for (const nativeReady of [true, false]) {
    const steps = plan({ base: 'a'.repeat(40), head: 'b'.repeat(40), platform, nativeReady });
    const labels = steps.map(candidate => candidate.label);
    for (const command of commands.map(command => command.join(' '))) assert.ok(labels.includes(command), command);
    for (const name of ['Test bot contracts and SDK', 'Test server, client state and real bot conversations',
      'Exercise an isolated SDK installation']) {
      for (const line of step(ci.jobs['bot-tests'], name).run.split('\n').map(text => text.trim())
        .filter(text => text && !text.startsWith('#')))
        assert.ok(labels.includes(line.replace(/^xvfb-run -a /u, '')), line);
    }
    const packaging = ci.jobs[platform === 'darwin' ? 'package-mac' : 'package-win'];
    for (const name of ['Exercise prepared application startup and scenarios', 'Exercise shortcut capture and worker recovery',
      'Exercise native screen contracts and legal metadata'])
      for (const line of step(packaging, name).run.split('\n').map(text => text.trim()).filter(Boolean))
        assert.ok(labels.includes(line), line);
    const skipped = steps.filter(candidate => candidate.skip).map(candidate => candidate.label);
    assert.ok(skipped.includes('node apps/client/test/messageClipboardDomSmoke.cjs --system-clipboard'));
    assert.ok(skipped.some(label => label.startsWith('node scripts/ci-build-artifact.js collect')));
    assert.ok(skipped.some(label => label.includes('electron-builder')), 'Packaging is opt-in locally.');
    assert.equal(steps.filter(candidate => candidate.stage === 'native').every(candidate => !!candidate.skip), !nativeReady);
    assert.equal(skipped.length, nativeReady ? 3 : 6);
    const addon = labels.indexOf('npm exec --no -- node-gyp rebuild --directory=apps/client/native/screen-audio');
    assert.ok(addon >= 0 && addon < labels.indexOf('node apps/client/test/shortcutsDomSmoke.cjs'),
      'Without packaging, the screen-audio addon must be built before the shortcut smokes load it.');
    assert.ok(!plan({ base: 'a', head: 'b', platform, nativeReady, packageApp: true })
      .some(candidate => (candidate.label.includes('electron-builder') && candidate.skip)
        || candidate.label.includes('node-gyp rebuild --directory=apps/client/native/screen-audio')));
  }
  assert.ok(pairs(ci).some(([pt, en]) => pt === 'CONTRIBUTING.md' && en === 'CONTRIBUTING.en.md'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts['ci:local'], 'node scripts/ci-local.cjs');
  const { checkClean } = require('./ci-local.cjs');
  const last = plan({ base: 'a', head: 'b', platform: 'win32', nativeReady: true, before: new Set() }).at(-1);
  assert.equal(last.stage, 'clean', 'The clean-checkout check runs after every other step.');
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'ci-local.cjs'), 'utf8'), /step\.stage !== 'clean'/u,
    '--only must not skip the clean-checkout check.');
  checkClean(new Set([' M scripts/edited.js']), new Set([' M scripts/edited.js']));
  assert.throws(() => checkClean(new Set([' M scripts/edited.js']), new Set([' M scripts/edited.js', '?? scripts/__pycache__/'])),
    /scripts\/__pycache__/u, 'Files left by the steps must fail locally, as the CI build export does.');
});

test('the mediasoup worker cache pins the locked package, host and compiler, and restores only verified workers', async t => {
  const { workerKey, verifyWorker, binary } = require('./mediasoup-worker.cjs');
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'monky-mediasoup-key-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const writeLock = (version, integrity) => fs.writeFileSync(path.join(base, 'package-lock.json'),
    JSON.stringify({ packages: { 'node_modules/mediasoup': { version, integrity } } }));
  const writeXcode = version => {
    fs.mkdirSync(path.join(base, 'apps', 'light'), { recursive: true });
    fs.writeFileSync(path.join(base, 'apps', 'light', 'dependencies.json'), JSON.stringify({ buildTools: { ciXcode: version } }));
  };
  writeLock('3.26.0', 'sha512-a'); writeXcode('16.4');
  const key = (overrides = {}) => workerKey({ base, platform: 'darwin', arch: 'x64', image: 'macos15', ...overrides });
  const original = key();
  assert.match(original, /^mediasoup-worker-v1-darwin-x64-[a-f0-9]{12}-3\.26\.0-[a-f0-9]{16}$/u);
  assert.equal(key(), original);
  for (const changed of [{ arch: 'arm64' }, { platform: 'linux' }, { image: 'macos26' }])
    assert.notEqual(key(changed), original, JSON.stringify(changed));
  writeXcode('26.0'); assert.notEqual(key(), original, 'The compiler selection is part of the key.'); writeXcode('16.4');
  writeLock('3.26.0', 'sha512-b'); assert.notEqual(key(), original, 'The exact locked package is part of the key.');
  writeLock('3.27.0', 'sha512-a'); assert.notEqual(key(), original);
  writeLock('3.26.0', undefined); assert.throws(() => key(), /integrity/u);

  assert.equal(binary, `node_modules/mediasoup/worker/out/Release/mediasoup-worker${process.platform === 'win32' ? '.exe' : ''}`);
  const job = ci.jobs['light-native'];
  const id = step(job, 'Identify the mediasoup worker build');
  const restore = step(job, 'Restore the verified mediasoup worker');
  const install = step(job, 'Install the mediasoup worker');
  const verify = step(job, 'Verify the mediasoup worker on this host');
  const tests = step(job, 'Exercise native and Chromium voice through a real isolated server');
  const save = step(job, 'Save the verified mediasoup worker');
  assert.equal(id.run, 'node scripts/mediasoup-worker.cjs key');
  assert.equal(restore.uses, 'actions/cache/restore@v4');
  assert.deepEqual(restore.with, { path: '${{ steps.mediasoup.outputs.path }}', key: '${{ steps.mediasoup.outputs.key }}' });
  assert.equal(install.if, "steps.mediasoup-cache.outputs.cache-hit != 'true'");
  assert.equal(install.run, 'npm rebuild mediasoup');
  assert.equal(verify.if, undefined, 'Restored and freshly installed workers pass the same checks.');
  assert.equal(save.if, "steps.mediasoup-cache.outputs.cache-hit != 'true'");
  assert.deepEqual(save.with, restore.with);
  const order = [id, restore, install, verify, tests, save].map(candidate => job.steps.indexOf(candidate));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'A worker is cached only after it ran the real interop tests.');
  assert.doesNotMatch(step(job, 'Prepare disposable voice interoperability fixtures').run, /mediasoup/u);
  const python = job.steps.find(candidate => candidate.uses === 'actions/setup-python@v5');
  assert.deepEqual(python.with, { 'python-version': '3.11', cache: 'pip', 'cache-dependency-path': 'apps/light/dependencies.json' },
    'The pinned CMake wheel comes from the pip cache, keyed by the manifest that pins it.');
  assert.match(step(job, 'Install the compatible CMake series').run, /cmake==\$\{\{ steps\.native-tools\.outputs\.cmake \}\}/u);

  const fake = path.join(base, ...binary.split('/'));
  await assert.rejects(verifyWorker({ base }), /ENOENT|Missing mediasoup worker/u);
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.copyFileSync(process.execPath, fake);
  await assert.rejects(verifyWorker({ base }), /does not run on this host/u, 'A binary that is not the worker is rejected.');
});

test('native tooltip input requires actual window and renderer focus, not a fixed showInactive delay', async () => {
  const calls = [];
  let shown = false, nativeFocused = false, rendererFocused = false;
  const browser = {
    show() { calls.push('show'); shown = true; },
    focus() { assert.ok(shown); calls.push('focus'); nativeFocused = true; },
    isVisible: () => shown,
    isFocused: () => nativeFocused,
    webContents: {
      focus() { assert.ok(nativeFocused); calls.push('renderer-focus'); rendererFocused = true; },
      async executeJavaScript() {
        calls.push('readiness');
        return { rendererFocus: rendererFocused, visibility: 'visible' };
      },
    },
  };
  assert.deepEqual(await focusTooltipPreview(browser), {
    visible: true, nativeFocus: true, rendererFocus: true, visibility: 'visible',
  });
  assert.deepEqual(calls, ['show', 'focus', 'renderer-focus', 'readiness']);

  for (const missing of ['visible', 'nativeFocus', 'rendererFocus', 'visibility']) {
    const state = { visible: true, nativeFocus: true, rendererFocus: true, visibility: 'visible',
      [missing]: missing === 'visibility' ? 'hidden' : false };
    const unavailable = {
      show() {}, focus() {}, isVisible: () => state.visible, isFocused: () => state.nativeFocus,
      webContents: {
        focus() {},
        async executeJavaScript() { return { rendererFocus: state.rendererFocus, visibility: state.visibility }; },
      },
    };
    await assert.rejects(focusTooltipPreview(unavailable, 0), /native pointer prerequisite not ready/u);
  }
});

test('native tooltip readiness waits for asynchronous renderer focus instead of assuming show focused it', async () => {
  let reads = 0;
  const browser = {
    show() {}, focus() {}, isVisible: () => true, isFocused: () => true,
    webContents: {
      focus() {},
      async executeJavaScript() { return { rendererFocus: ++reads > 1, visibility: 'visible' }; },
    },
  };
  assert.equal((await focusTooltipPreview(browser)).rendererFocus, true);
  assert.equal(reads, 2);
});
