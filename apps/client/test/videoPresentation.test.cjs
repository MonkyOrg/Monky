const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../src/main/videoPresentation.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(compiled, sourcePath);
const { configureVideoPresentation } = loaded.exports;

function fixture() {
  const switches = new Map([
    ['enable-features', 'AllowWgcScreenCapturer,AllowWgcWindowCapturer'],
    ['autoplay-policy', 'no-user-gesture-required'],
    ['user-data-dir', 'owned-profile'],
  ]);
  const calls = [];
  return {
    switches,
    calls,
    commandLine: {
      appendSwitch(name, value) {
        calls.push(['append', name, value]);
        switches.set(name, value);
      },
      removeSwitch(name) {
        calls.push(['remove', name]);
        switches.delete(name);
      },
    },
  };
}

test('Windows disables only Chromium video-overlay promotion with the supported workaround name', () => {
  const { commandLine, switches, calls } = fixture();
  const original = [...switches];
  configureVideoPresentation(commandLine, 'win32');
  assert.deepEqual(calls, [
    ['remove', 'enable-direct-composition-video-overlays'],
    ['append', 'disable_direct_composition_video_overlays', '1'],
  ]);
  assert.deepEqual([...switches], [...original, ['disable_direct_composition_video_overlays', '1']]);
  for (const name of ['disable-gpu', 'disable-gpu-compositing', 'disable-accelerated-video-decode',
    'disable-accelerated-video-encode', 'disable-direct-composition-video-overlays']) {
    assert.equal(switches.has(name), false, name);
  }
});

test('a force-enable switch or disabled workaround cannot undo the Windows compatibility policy', () => {
  const { commandLine, switches } = fixture();
  switches.set('enable-direct-composition-video-overlays', '');
  switches.set('disable_direct_composition_video_overlays', '0');
  configureVideoPresentation(commandLine, 'win32');
  assert.equal(switches.has('enable-direct-composition-video-overlays'), false);
  assert.equal(switches.get('disable_direct_composition_video_overlays'), '1');
  const configured = [...switches];
  configureVideoPresentation(commandLine, 'win32');
  assert.deepEqual([...switches], configured);
});

test('explicit unrelated GPU preferences are preserved', () => {
  const { commandLine, switches } = fixture();
  switches.set('disable-gpu', '');
  configureVideoPresentation(commandLine, 'win32');
  assert.equal(switches.get('disable-gpu'), '');
});

for (const platform of ['darwin', 'linux', 'freebsd']) {
  test(`${platform} retains its existing graphics configuration`, () => {
    const { commandLine, switches, calls } = fixture();
    const original = [...switches];
    configureVideoPresentation(commandLine, platform);
    assert.deepEqual(calls, []);
    assert.deepEqual([...switches], original);
  });
}

test('configuration errors propagate instead of silently leaving a different presentation policy', () => {
  const failure = new Error('Cannot configure Chromium');
  assert.throws(() => configureVideoPresentation({
    removeSwitch() {},
    appendSwitch() { throw failure; },
  }, 'win32'), error => error === failure);
});

test('normal Main configures presentation before service construction and application startup', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../src/main/main.ts'), 'utf8');
  const configuration = main.indexOf('configureVideoPresentation(app.commandLine, process.platform);');
  assert.ok(configuration >= 0);
  assert.match(main, /^configureVideoPresentation\(app\.commandLine, process\.platform\);$/m);
  assert.ok(configuration < main.indexOf('const developmentQa = loadDevelopmentQa('));
  assert.ok(configuration < main.indexOf('new ServerManager()'));
  assert.ok(configuration < main.indexOf('app.requestSingleInstanceLock()'));
});
