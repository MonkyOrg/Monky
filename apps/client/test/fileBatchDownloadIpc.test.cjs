const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const shared = require('@monky/shared');
const { loadMain, fakeIpcMain } = require('./mainModules.cjs');
const { unzipSync } = require(require.resolve('fflate', { paths: [path.dirname(require.resolve('@monky/shared'))] }));

function load(directory, dialogs) {
  return loadMain('fileBatchDownloadIpc', {
    local: { i18n: { mt: (key) => key } },
    packages: { electron: {
      app: { getPath: (kind) => path.join(directory, kind) },
      dialog: {
        showOpenDialog: async (_window, options) => { dialogs.push(['open', options]); return dialogs.next(); },
        showSaveDialog: async (_window, options) => { dialogs.push(['save', options]); return dialogs.next(); },
      },
    } },
  }).registerFileBatchDownloadIpc;
}

test('batch download saves into a folder or one ZIP and never leaves partial archives', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-file-batch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const kind of ['downloads', 'temp', 'chosen']) fs.mkdirSync(path.join(directory, kind));
  const dialogs = [];
  let selection = { canceled: false, filePaths: [path.join(directory, 'chosen')] };
  dialogs.next = () => selection;
  const contents = {
    'https://server.test/a': Buffer.from('first image'),
    'https://server.test/b': Buffer.from('second, a video'),
    'https://server.test/c': Buffer.alloc(70_000, 7),
  };
  const download = async (file, destination) => {
    if (file.dm) {
      if (file.dm.fileId !== 'dm-file') throw new Error('not found');
      fs.writeFileSync(destination, 'from a dm');
      return;
    }
    if (!contents[file.url]) throw new Error('HTTP 404');
    fs.writeFileSync(destination, contents[file.url]);
  };
  const register = load(directory, dialogs);
  const webContents = { mainFrame: {}, isDestroyed: () => false };
  const window = { webContents, isDestroyed: () => false };
  const { IpcRegistry } = loadMain('ipc/registry', { globals: { console: { ...console, warn: () => {} } } });
  const ipc = fakeIpcMain();
  const handlers = ipc.handlers;
  const registry = new IpcRegistry(ipc, { main: () => webContents, overlay: () => null });
  register(registry, window, (name) => path.basename(name).replace(/[<>:"/\\|?*]/g, '_'), download);
  const handler = handlers.get(shared.FILE_BATCH_DOWNLOAD_IPC);
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const request = (mode, files) => ({ mode, archiveName: 'Mídias de #geral', files });

  // Another window, or a frame inside the main one, never opens a save dialog for files it chose.
  for (const intruder of [{ sender: {} }, { sender: webContents, senderFrame: {} }]) {
    const refused = await handler(intruder, request('folder', [{ url: 'https://server.test/a', fileName: 'a.png' }]));
    assert.deepEqual({ ...refused }, { status: 'failed', saved: 0, error: 'Unavailable sender' });
  }
  assert.equal((await handler(event, request('folder', [{ url: 'file:///etc/passwd', fileName: 'a.png' }]))).status, 'failed');
  assert.equal((await handler(event, request('folder', [{ url: 'https://server.test/a', dm: { peer: 'p', messageId: 'm', fileId: 'f' }, fileName: 'a.png' }]))).status, 'failed');
  assert.equal((await handler(event, request('folder', []))).status, 'failed');
  assert.equal(dialogs.length, 0);

  fs.writeFileSync(path.join(directory, 'chosen', 'foto.png'), 'keep me');
  const folderResult = await handler(event, request('folder', [
    { url: 'https://server.test/a', fileName: 'foto.png' },
    { url: 'https://server.test/b', fileName: '../foto.png' },
    { url: 'https://server.test/missing', fileName: 'gone.mp4' },
  ]));
  assert.deepEqual({ ...folderResult }, { status: 'failed', saved: 2, error: 'HTTP 404' });
  assert.equal(fs.readFileSync(path.join(directory, 'chosen', 'foto.png'), 'utf8'), 'keep me');
  assert.equal(fs.readFileSync(path.join(directory, 'chosen', 'foto (2).png'), 'utf8'), 'first image');
  assert.equal(fs.readFileSync(path.join(directory, 'chosen', 'foto (3).png'), 'utf8'), 'second, a video');

  selection = { canceled: false, filePath: path.join(directory, 'downloads', 'midias') };
  const zipResult = await handler(event, request('zip', [
    { url: 'https://server.test/a', fileName: 'foto.png' },
    { url: 'https://server.test/b', fileName: 'foto.png' },
    { url: 'https://server.test/c', fileName: 'vídeo.mp4' },
    { dm: { peer: 'peer-key', messageId: 'm1', fileId: 'dm-file' }, fileName: 'nota.txt' },
  ]));
  assert.deepEqual({ ...zipResult }, { status: 'saved', saved: 4 });
  assert.equal(dialogs.at(-1)[1].defaultPath, path.join(directory, 'downloads', 'Mídias de #geral.zip'));
  const archive = fs.readFileSync(path.join(directory, 'downloads', 'midias.zip'));
  const files = unzipSync(new Uint8Array(archive));
  assert.deepEqual(Object.keys(files), ['foto.png', 'foto (2).png', 'vídeo.mp4', 'nota.txt']);
  assert.equal(Buffer.from(files['nota.txt']).toString(), 'from a dm');
  assert.equal(Buffer.from(files['foto (2).png']).toString(), 'second, a video');
  assert.deepEqual(Buffer.from(files['vídeo.mp4']), contents['https://server.test/c']);
  assert.equal(archive.readUInt32LE(14), zlib.crc32(contents['https://server.test/a']));
  assert.deepEqual(fs.readdirSync(path.join(directory, 'temp')), []);

  selection = { canceled: false, filePath: path.join(directory, 'downloads', 'broken.zip') };
  const brokenZip = await handler(event, request('zip', [
    { url: 'https://server.test/a', fileName: 'a.png' },
    { url: 'https://server.test/missing', fileName: 'b.png' },
  ]));
  assert.deepEqual({ ...brokenZip }, { status: 'failed', saved: 0, error: 'HTTP 404' });
  assert.equal(fs.existsSync(path.join(directory, 'downloads', 'broken.zip')), false);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'temp')), []);

  selection = { canceled: true, filePaths: [] };
  assert.equal((await handler(event, request('folder', [{ url: 'https://server.test/a', fileName: 'a.png' }]))).status, 'cancelled');

  registry.dispose();
  assert.equal(handlers.size, 0);
});
