const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const shared = require('@monky/shared');

function fixture(compatibility) {
  const handlers = new Map();
  const actions = [];
  const updater = {
    on() {},
    setFeedURL: (value) => actions.push({ feed: value }),
    checkForUpdates: async () => { actions.push('check'); return { updateInfo: { version: '18.0.0-beta' } }; },
    downloadUpdate: async () => { actions.push('download'); },
    quitAndInstall: () => assert.fail('No fixture may install or quit the actual application'),
  };
  const dependencies = new Map([
    ['electron', {
      app: { isPackaged: true, getVersion: () => '17.0.3-beta' },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    }],
    ['electron-updater', { autoUpdater: updater }],
    ['@monky/shared', { ...shared, fetchReleaseCompatibility: async () => compatibility }],
    ['./i18n', { mt: (key) => key }],
    ['./updateInstall', { consumeUpdateOutcome: () => null, beginUpdateInstall: () => assert.fail('No installer') }],
    ['./updateLog', { updateLog() {} }],
    ['./releaseNotes', { fetchVersionReleaseNotes: async () => ({ status: 'unavailable' }) }],
  ]);
  const main = path.resolve(__dirname, '../src/main');
  const cache = new Map();
  const load = (name) => {
    if (cache.has(name)) return cache.get(name);
    const filename = path.join(main, `${name}.ts`);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} };
    cache.set(name, module.exports);
    vm.runInNewContext(code, {
      module, exports: module.exports, __dirname: main, __filename: filename,
      require(id) {
        if (dependencies.has(id)) return dependencies.get(id);
        if (id === './updateVersions') return load('updateVersions');
        assert.ok(['fs', 'https', 'path'].includes(id), `Unexpected dependency ${id}`);
        return require(id);
      },
      process: { platform: 'win32', arch: 'x64' },
      console, Buffer, URL, setTimeout, clearTimeout, setImmediate,
      fetch: async () => new Response(JSON.stringify({
        tag_name: 'v18.0.0-beta', prerelease: true, assets: [],
      })),
    }, { filename });
    return module.exports;
  };
  load('updater').setupUpdater({ webContents: { send() {} } });
  return { handlers, actions };
}

test('desktop update check delivers authoritative bot compatibility through the typed IPC contract', async () => {
  const compatibility = {
    status: 'available',
    manifest: { schemaVersion: 1, version: '18.0.0-beta', protocolVersion: 16, botSdkVersion: '18.0.0-beta' },
  };
  const { handlers, actions } = fixture(compatibility);
  const result = await handlers.get(shared.UPDATER_IPC.check)();
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.version, '18.0.0-beta');
  assert.deepEqual(result.compatibility, compatibility);
  assert.deepEqual(actions, []);
});

test('desktop download cannot silently replace the version whose compatibility the user accepted', async () => {
  const { handlers, actions } = fixture({ status: 'unavailable', reason: 'metadata missing' });
  await handlers.get(shared.UPDATER_IPC.check)();
  for (const value of ['19.0.0-beta', '18.0.0-beta\n', null, {}, '../18.0.0-beta']) {
    assert.equal((await handlers.get(shared.UPDATER_IPC.download)(null, value)).ok, false);
  }
  assert.deepEqual(actions, []);
  assert.equal((await handlers.get(shared.UPDATER_IPC.download)(null, '18.0.0-beta')).ok, true);
  assert.equal(actions[0].feed.url, 'https://github.com/MonkyOrg/Monky/releases/download/v18.0.0-beta');
  assert.deepEqual(actions.slice(1), ['check', 'download']);
});

test('changing release channel invalidates the previous consent/download target', async () => {
  const { handlers, actions } = fixture({ status: 'unavailable', reason: 'metadata missing' });
  await handlers.get(shared.UPDATER_IPC.check)();
  await handlers.get(shared.UPDATER_IPC.setChannel)(null, true);
  assert.equal((await handlers.get(shared.UPDATER_IPC.download)(null, '18.0.0-beta')).ok, false);
  assert.deepEqual(actions, []);
});
