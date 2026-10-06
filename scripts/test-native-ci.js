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
const { commands, run, shard } = require('./test-client-dom.cjs');
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
  assert.deepEqual(dom.strategy.matrix.shard, [1, 2]);
  assert.equal(dom.strategy['fail-fast'], false);
  const windowsDom = step(dom, 'Exercise client DOM and microphone state in Electron');
  assert.equal(windowsDom.run, 'node scripts/test-client-dom.cjs');
  assert.deepEqual(windowsDom.env, { MONKY_DOM_SHARD: '${{ matrix.shard }}/2' });
  assert.equal(dom.strategy.matrix.shard.length, Number(windowsDom.env.MONKY_DOM_SHARD.split('/')[1]),
    'Every DOM shard must have a matrix lane.');

  const mac = ci.jobs['client-dom-mac'];
  assert.equal(mac['runs-on'], 'macos-15');
  assert.equal(mac.needs, undefined);
  assert.equal(mac.strategy, undefined, 'The macOS lane runs the whole DOM suite.');
  const macDom = step(mac, 'Exercise client DOM and microphone state in Electron');
  assert.equal(macDom.run, 'node scripts/test-client-dom.cjs');
  assert.equal(macDom.env, undefined);
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
  assert.equal(fetch.if, "steps.cache.outputs.cache-hit == 'true'");
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
  for (const [os, paths] of [['macOS', macPaths], ['Windows', winPaths]]) {
    const share = step(build, `Share the approved native runtime with later CI (${os})`);
    assert.equal(share.uses, 'actions/cache/save@v4');
    assert.equal(share.if, `needs.version.outputs.reuse_build == 'true' && runner.os == '${os}' && steps.restore.outputs.native_cache_key != ''`);
    assert.equal(share.with.key, '${{ steps.restore.outputs.native_cache_key }}');
    assert.deepEqual(lines(share.with.path), paths, 'Release seeds exactly the paths CI restores.');
    assert.ok(build.steps.indexOf(share) === build.steps.indexOf(restored) + (os === 'macOS' ? 1 : 2),
      'Seed the cache straight from the verified artifact, before any release step can touch the outputs.');
  }
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
    'npm run test:camera --workspace=apps/client',
    'node apps/client/test/footerControlsSmoke.cjs',
    'npm run test:transport --workspace=apps/client',
    'npm run test:bot-marketplace --workspace=apps/client',
    'npm run test:soundboard --workspace=apps/client',
    'npm run test:community --workspace=apps/client',
    'npm run test:pip --workspace=apps/client',
  ]);
  for (const [executable, scriptOrRun, script] of commands) {
    if (executable === 'node') assert.ok(fs.existsSync(path.join(root, ...scriptOrRun.split('/'))));
    else assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'apps', 'client', 'package.json'), 'utf8')).scripts[script]);
  }
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
  const camera = 'npm run test:camera --workspace=apps/client';
  const [first, second] = [shard('1/2'), shard('2/2')].map(part => part.map(command => command.join(' ')));
  assert.ok(first.includes(camera) !== second.includes(camera));
  assert.ok(Math.min(first.length, second.length) >= 5, 'The long camera suite must not leave one shard nearly empty.');
  const seen = [];
  run((executable, args) => { seen.push([executable === process.execPath ? 'node' : executable, ...args].join(' ')); return { status: 0 }; },
    'darwin', { MONKY_DOM_SHARD: '2/2' });
  assert.deepEqual(seen, second);
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
    assert.ok(!plan({ base: 'a', head: 'b', platform, nativeReady, packageApp: true })
      .some(candidate => candidate.label.includes('electron-builder') && candidate.skip));
  }
  assert.ok(pairs(ci).some(([pt, en]) => pt === 'CONTRIBUTING.md' && en === 'CONTRIBUTING.en.md'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts['ci:local'], 'node scripts/ci-local.cjs');
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
