const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const shared = require('@monky/shared');

function fixture(compatibility, options = {}) {
  const handlers = new Map();
  const events = new Map();
  const actions = [];
  const sent = [];
  let metadataCalls = 0;
  let updaterLoads = 0;
  let fetchSignal;
  const request = async (_url, init) => {
    fetchSignal = init.signal;
    if (options.fetch) return options.fetch(init.signal);
    return new Response(JSON.stringify({
      tag_name: 'v18.0.0-beta', prerelease: true, assets: [
        { name: 'Monky-18.0.0-beta-mac-arm64.dmg', browser_download_url: 'https://github.com/asset.dmg' },
      ],
    }));
  };
  class CancellationToken {
    cancelled = false;
    cancel() { this.cancelled = true; this.onCancel?.(); }
    dispose() {}
  }
  const updater = {
    on: (name, handler) => events.set(name, handler),
    setFeedURL: (value) => actions.push({ feed: value }),
    checkForUpdates: async () => {
      actions.push('check');
      if (options.feedCheck) await options.feedCheck();
      return { updateInfo: { version: options.feedVersion ?? '18.0.0-beta' } };
    },
    downloadUpdate: async token => {
      actions.push('download');
      if (options.download) await options.download(token, events);
    },
    quitAndInstall: () => assert.fail('No fixture may install or quit the actual application'),
  };
  const dependencies = new Map([
    ['electron', {
      app: { isPackaged: true, getVersion: () => '17.0.3-beta', getPath: () => 'synthetic-temp' },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      net: { fetch: request },
      shell: { openPath: async () => { actions.push('openDmg'); return ''; } },
    }],
    ['electron-updater', { autoUpdater: updater, CancellationToken }],
    ['@monky/shared', { ...shared, fetchReleaseCompatibility: async (_v, _fetch, signal) => {
      metadataCalls++;
      if (options.metadata) return options.metadata(signal);
      return compatibility;
    } }],
    ['./i18n', { mt: (key) => key }],
    ['./updateInstall', { consumeUpdateOutcome: () => null, beginUpdateInstall: () => assert.fail('No installer') }],
    ['./updateLog', { updateLog() {} }],
    ['./releaseNotes', { fetchVersionReleaseNotes: async () => ({ status: 'unavailable' }) }],
    ['./updateDownload', { downloadToFile: async (_url, _path, signal, progress) => {
      if (options.macDownload) return options.macDownload(signal, progress);
    } }],
    ['./updateMetadataRequest', { requestUpdateMetadata: request }],
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
        if (id === 'electron-updater') updaterLoads++;
        if (dependencies.has(id)) return dependencies.get(id);
        if (id === './updateVersions') return load('updateVersions');
        assert.ok(['fs', 'https', 'path'].includes(id), `Unexpected dependency ${id}`);
        return require(id);
      },
      process: { platform: options.platform ?? 'win32', arch: 'arm64' },
      console, Buffer, URL, AbortController, AbortSignal,
      setTimeout: (callback, ms) => { assert.ok(ms >= 1000); return 0; },
      clearTimeout, setImmediate,
    }, { filename });
    return module.exports;
  };
  load('updater').setupUpdater({ webContents: { send: (...args) => sent.push(args) } },
    options.inventory ?? (async () => []));
  return { handlers, actions, events, sent, updater, metadataCalls: () => metadataCalls, fetchSignal: () => fetchSignal,
    updaterLoads: () => updaterLoads };
}

test('desktop detection does not fetch bot metadata or warn remote-only users', async () => {
  const compatibility = {
    status: 'available',
    manifest: { schemaVersion: 1, version: '18.0.0-beta', protocolVersion: 16, botSdkVersion: '18.0.0-beta' },
  };
  const { handlers, actions } = fixture(compatibility);
  const result = await handlers.get(shared.UPDATER_IPC.check)();
  assert.equal(result.ok, true);
  assert.equal(result.available, true);
  assert.equal(result.version, '18.0.0-beta');
  assert.equal(result.compatibility, undefined);
  assert.deepEqual(actions, []);
});

const manifest = { status: 'available', manifest: {
  schemaVersion: 1, version: '18.0.0-beta', protocolVersion: 40, minimumBotProtocol: 24, botSdkVersion: '18.0.0-beta',
} };
const bots = [
  { id: 'compatible', name: 'Compatible', protocolVersion: 30 },
  { id: 'old', name: '<Old bot>', protocolVersion: 23 },
  { id: 'unknown', name: 'Offline unknown', protocolVersion: null },
  { id: 'future', name: 'Newer SDK', protocolVersion: 41 },
];
test('local preflight compares each saved bot against the target protocol floor, not the client protocol', async () => {
  const f = fixture(manifest, { inventory: async () => [{ serverId: 'a', serverName: 'Stopped server', bots }] });
  await f.handlers.get(shared.UPDATER_IPC.check)(null, 'check');
  const result = await f.handlers.get(shared.UPDATER_IPC.preflight)(null, '18.0.0-beta', 'assess');
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.warnings)), [{
    serverName: 'Stopped server', bots: [
      { name: '<Old bot>', status: 'incompatible' }, { name: 'Offline unknown', status: 'unknown' },
      { name: 'Newer SDK', status: 'unknown' },
    ],
  }]);
  assert.equal(f.metadataCalls(), 1);
  assert.deepEqual(f.actions, []);
});

test('no local bots skips metadata; missing metadata only marks registered local bots as unknown', async () => {
  for (const hasBots of [false, true]) {
    const f = fixture({ status: 'unavailable', reason: 'timeout' }, {
      inventory: async () => [{ serverId: 'a', serverName: 'Local', bots: hasBots ? bots : [] }],
    });
    await f.handlers.get(shared.UPDATER_IPC.check)();
    const result = await f.handlers.get(shared.UPDATER_IPC.preflight)(null, '18.0.0-beta', 'assess');
    assert.equal(result.ok, true);
    assert.equal(f.metadataCalls(), hasBots ? 1 : 0);
    assert.equal(result.warnings.length, hasBots ? 1 : 0);
    if (hasBots) assert.ok(result.warnings[0].bots.every(bot => bot.status === 'unknown'));
  }
});

test('unreadable local data is an explicit failure rather than success or fabricated compatibility', async () => {
  const f = fixture(manifest, { inventory: async () => { throw new Error('corrupt database'); } });
  await f.handlers.get(shared.UPDATER_IPC.check)();
  const result = await f.handlers.get(shared.UPDATER_IPC.preflight)(null, '18.0.0-beta', 'assess');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'error.updateInventoryFailed');
  assert.equal(f.metadataCalls(), 0);
});

test('cancelling detection aborts the underlying network request and rejects its late result', async () => {
  const f = fixture(manifest, { fetch: signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const pending = f.handlers.get(shared.UPDATER_IPC.check)(null, 'check-a');
  await f.handlers.get(shared.UPDATER_IPC.cancel)(null, 'other');
  assert.equal(f.fetchSignal().aborted, false, 'Cancellation IDs must not stop someone else\'s request');
  assert.equal((await f.handlers.get(shared.UPDATER_IPC.cancel)(null, 'check-a')).cancelled, true);
  assert.equal((await pending).cancelled, true);
  assert.equal(f.fetchSignal().aborted, true);
});

test('cancellation between a completed preflight and download IPC prevents a late download from starting', async () => {
  const f = fixture(manifest);
  await f.handlers.get(shared.UPDATER_IPC.check)();
  await f.handlers.get(shared.UPDATER_IPC.preflight)(null, '18.0.0-beta', 'flow-a');
  await f.handlers.get(shared.UPDATER_IPC.cancel)(null, 'flow-a');
  assert.equal((await f.handlers.get(shared.UPDATER_IPC.download)(null, '18.0.0-beta', 'flow-a')).cancelled, true);
  assert.deepEqual(f.actions, []);
});

test('Windows cancellation stops the real updater token without an error or later auto-install-on-quit', async () => {
  let token;
  const f = fixture(manifest, { download: value => new Promise((_resolve, reject) => {
    token = value;
    value.onCancel = () => reject(new Error('cancelled'));
  }) });
  await f.handlers.get(shared.UPDATER_IPC.check)();
  const pending = f.handlers.get(shared.UPDATER_IPC.download)(null, '18.0.0-beta', 'download-a');
  while (!token) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.handlers.get(shared.UPDATER_IPC.cancel)(null, 'download-a')).cancelled, true);
  assert.equal((await pending).cancelled, true);
  f.events.get('update-downloaded')({ version: '18.0.0-beta' });
  f.events.get('error')(new Error('Late cancelled download error'));
  assert.equal(f.sent.length, 0);
  assert.equal(f.updater.autoInstallOnAppQuit, false);
});

test('cancellation during the provider check cannot begin a package download', async () => {
  let release;
  const f = fixture(manifest, { feedCheck: () => new Promise(resolve => { release = resolve; }) });
  await f.handlers.get(shared.UPDATER_IPC.check)();
  const pending = f.handlers.get(shared.UPDATER_IPC.download)(null, '18.0.0-beta', 'download-a');
  await f.handlers.get(shared.UPDATER_IPC.cancel)(null, 'download-a');
  release();
  assert.equal((await pending).cancelled, true);
  assert.ok(!f.actions.includes('download'));
});

test('provider metadata cannot silently swap the release whose bots were reviewed', async () => {
  const f = fixture(manifest, { feedVersion: '19.0.0-beta' });
  await f.handlers.get(shared.UPDATER_IPC.check)();
  assert.equal((await f.handlers.get(shared.UPDATER_IPC.download)(null, '18.0.0-beta', 'download-a')).ok, false);
  assert.ok(!f.actions.includes('download'));
});

test('downloaded event is the irreversible boundary and cannot be cancelled or installed twice', async () => {
  const f = fixture(manifest, { download: async (_token, events) => events.get('update-downloaded')({ version: '18.0.0-beta' }) });
  await f.handlers.get(shared.UPDATER_IPC.check)();
  await f.handlers.get(shared.UPDATER_IPC.download)(null, '18.0.0-beta', 'download-a');
  assert.equal((await f.handlers.get(shared.UPDATER_IPC.cancel)(null, 'download-a')).cancelled, false);
  assert.equal((await f.handlers.get(shared.UPDATER_IPC.install)()).ok, false);
  assert.equal(f.sent.filter(([channel]) => channel === 'updater:downloaded').length, 1);
});

test('electron-updater loads with the first download, already configured, never just to open Monky (#490)', async () => {
  const f = fixture(manifest, { download: async (_token, events) => events.get('update-downloaded')({ version: '18.0.0-beta' }) });
  f.updater.autoDownload = true;
  f.updater.autoInstallOnAppQuit = true;
  assert.equal(f.updaterLoads(), 0, 'opening the window does not read electron-updater');
  await f.handlers.get(shared.UPDATER_IPC.check)();
  assert.equal(f.updaterLoads(), 0, 'checking asks GitHub directly');
  assert.equal((await f.handlers.get(shared.UPDATER_IPC.download)(null, '18.0.0-beta', 'download-a')).ok, true);
  assert.ok(f.updaterLoads() > 0, 'the download loads it');
  assert.equal(f.updater.autoDownload, false, 'configured before it is used');
  assert.equal(f.updater.autoInstallOnAppQuit, false);
  assert.ok(f.updater.logger, 'its log goes to the update log');
  assert.deepEqual([...f.events.keys()].sort(), ['download-progress', 'error', 'update-downloaded']);
  assert.equal(f.sent.filter(([channel]) => channel === 'updater:downloaded').length, 1);
});

test('macOS cancelled downloads never open the image or schedule a quit', async () => {
  const f = fixture(manifest, { platform: 'darwin', macDownload: signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  await f.handlers.get(shared.UPDATER_IPC.check)();
  const pending = f.handlers.get(shared.UPDATER_IPC.download)(null, '18.0.0-beta', 'download-a');
  await f.handlers.get(shared.UPDATER_IPC.cancel)(null, 'download-a');
  assert.equal((await pending).cancelled, true);
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.sent, []);
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
