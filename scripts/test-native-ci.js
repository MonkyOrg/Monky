import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { load } = require('js-yaml');
const { commands, run } = require('./test-client-dom.cjs');
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
  for (const job of [ci.jobs.package, release.jobs.build]) {
    const verify = step(job, 'Verify macOS DMG packaging dependencies');
    assert.equal(verify.if, "runner.os == 'macOS'");
    assert.equal(verify.run, `node -e "require('dmg-builder/out/dmgLicense.js')"`);
    assert.ok(job.steps.indexOf(verify) > job.steps.indexOf(step(job, 'Install dependencies')));
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

test('Windows DOM runs independently of native compilation while the existing required checks gate both', () => {
  const dom = ci.jobs['client-dom'];
  const packaging = ci.jobs.package;
  assert.equal(dom['runs-on'], 'windows-2022');
  assert.equal(dom.needs, undefined);
  assert.equal(packaging.needs, undefined);
  assert.equal(step(dom, 'Build workspaces').run, 'npm run build');
  assert.equal(step(dom, 'Install dependencies').run, 'npm ci');
  assert.equal(step(dom, 'Exercise client DOM and microphone state in Electron').run, 'node scripts/test-client-dom.cjs');
  const mac = step(packaging, 'Exercise client DOM and microphone state in Electron');
  assert.equal(mac.if, "runner.os == 'macOS'");
  assert.equal(mac.run, 'node scripts/test-client-dom.cjs');
  assert.ok(!dom.steps.some(candidate => candidate.run?.includes('prepare:native-screen')));

  const gate = ci.jobs.build;
  assert.equal(gate.name, 'Build check (${{ matrix.platform }})');
  assert.deepEqual(gate.strategy.matrix.platform, ['win', 'mac']);
  assert.equal(gate.if, 'always()');
  assert.deepEqual(gate.needs, ['package', 'client-dom']);
  const check = step(gate, 'Require packaging and DOM success');
  assert.deepEqual(check.env, {
    PACKAGE_RESULT: '${{ needs.package.result }}', DOM_RESULT: '${{ needs.client-dom.result }}',
  });
  assert.equal(check.run, 'test "$PACKAGE_RESULT" = success && test "$DOM_RESULT" = success');
});

test('both build lanes and release retain the qualified Windows toolchain and no validation bypass', () => {
  for (const job of [ci.jobs['client-dom'], ci.jobs.package, release.jobs.build]) {
    assert.deepEqual(step(job, 'Setup MSVC (Windows)').with, {
      vsversion: '2022', toolset: '14.44', sdk: '10.0.26100.0',
    });
    assert.equal(job.steps.find(candidate => candidate.uses === 'actions/setup-python@v5').with['python-version'], '3.11');
    assert.equal(job.steps.find(candidate => candidate.uses === 'actions/setup-node@v4').with['node-version'], 22);
    assert.ok(job.steps.every(candidate => !candidate['continue-on-error']));
  }
  const packaging = ci.jobs.package;
  assert.match(step(packaging, 'Exercise native screen contracts and legal metadata').run,
    /npm run test:native-screen --workspace=apps\/client\s+npm run test:legal/u);
  assert.match(step(packaging, 'Exercise prepared application startup and scenarios').run, /npm run test:qa/u);
  assert.match(step(packaging, 'Exercise shortcut capture and worker recovery').run, /shortcutWorkerSmoke\.cjs/u);
  assert.match(step(packaging, 'Package ${{ matrix.platform }} (dir, no publish)').run, /--dir --publish never/u);
});

test('native caches contain only pinned OBS downloads and cannot restore PR output into release', () => {
  for (const [job, namespace] of [[ci.jobs.package, 'ci'], [release.jobs.build, 'release']]) {
    const cache = step(job, 'Cache verified native screen archives (Windows)');
    assert.equal(cache.uses, 'actions/cache@v4');
    assert.equal(cache.with.path, '.native-screen\\downloads');
    assert.equal(cache.with['restore-keys'], undefined);
    assert.match(cache.if, /^runner\.os == 'Windows'/u);
    assert.ok(cache.with.key.startsWith(`native-screen-archives-v1-${namespace}-windows-x64-`));
    for (const input of ['scripts/fetchObs.cjs', 'scripts/buildTools.cjs', 'src/vendor/obs/sources.json',
      'src/vendor/obs/runtime-inputs.json', 'src/capture/runtime-additions.json']) {
      assert.ok(cache.with.key.includes(`'apps/client/native/screen-share/${input}'`));
      assert.ok(fs.existsSync(path.join(root, 'apps', 'client', 'native', 'screen-share', ...input.split('/'))));
    }
    const prepare = job.steps.find(candidate => candidate.run?.includes('npm run prepare:native-screen'));
    assert.ok(prepare);
    assert.ok(job.steps.indexOf(cache) < job.steps.indexOf(prepare));
    assert.equal(prepare.if.includes('cache-hit'), false);
    assert.match(prepare.run, /--python="\$env:PYTHON" --git="\$Git" --jobs=4/u);
  }
});

test('release still generates corresponding sources from the clean version commit before version mutation', () => {
  const build = release.jobs.build;
  const prepare = step(build, 'Build native screen runtime and corresponding sources (Windows)');
  assert.match(prepare.run, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/u);
  assert.match(prepare.run, /npm run pack:native-sources -- --version=\$\{\{ needs\.version\.outputs\.version \}\}/u);
  assert.ok(build.steps.indexOf(prepare) < build.steps.indexOf(step(build, 'Set build version')));
  assert.equal(step(release.jobs.version, 'Calculate Semantic Version').env.RELEASE_CHANNEL, 'beta');
  const verification = step(release.jobs.release, 'Verify corresponding sources before publishing binaries');
  assert.match(verification.run, /node scripts\/check-native-source-release\.js/u);
  assert.match(step(build, 'Upload build artifacts').with.path, /release\/monky-native-sources-\*\.tar\.xz/u);
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
    'npm run test:settings:ui --workspace=apps/client',
    'npm run test:camera --workspace=apps/client',
    'node apps/client/test/footerControlsSmoke.cjs',
    'npm run test:transport --workspace=apps/client',
    'npm run test:bot-marketplace --workspace=apps/client',
  ]);
  for (const [executable, scriptOrRun, script] of commands) {
    if (executable === 'node') assert.ok(fs.existsSync(path.join(root, ...scriptOrRun.split('/'))));
    else assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'apps', 'client', 'package.json'), 'utf8')).scripts[script]);
  }
});

test('DOM runner preserves Windows npm shell handling and stops immediately on failure or signal', t => {
  t.mock.method(console, 'log', () => {});
  for (const platform of ['win32', 'darwin']) {
    const calls = [];
    run((executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0 };
    }, platform);
    assert.equal(calls.length, commands.length);
    for (const [index, call] of calls.entries()) {
      const [executable, ...args] = commands[index];
      assert.equal(call.executable, executable === 'node' ? process.execPath : 'npm');
      assert.deepEqual(call.args, args);
      assert.equal(call.options.cwd, path.resolve(root));
      assert.equal(call.options.shell, platform === 'win32' && executable === 'npm');
    }
  }
  for (const result of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { error: new Error('spawn failure') }]) {
    let calls = 0;
    assert.throws(() => run(() => { calls++; return result; }), /failed|spawn failure/u);
    assert.equal(calls, 1);
  }
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
