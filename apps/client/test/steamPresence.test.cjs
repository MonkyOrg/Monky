const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const shared = require('@monky/shared');

/**
 * Loads steamPresence.ts with the registry and the clock under our control, so
 * the Steam-shaped disk layout can be exercised on any platform (#675).
 */
function load({ registry = {}, platform = 'win32' } = {}) {
  const filename = path.resolve(__dirname, '../src/main/steamPresence.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;

  const execFile = (_file, args, _options, callback) => {
    const name = args[args.length - 1];
    const value = registry[name];
    if (value === undefined) {
      callback(new Error('not found'));
      return;
    }
    callback(null, { stdout: `\r\n    ${name}    REG_SZ    ${value}\r\n`, stderr: '' });
  };
  // promisify looks for this symbol before falling back to the callback form.
  execFile[require('node:util').promisify.custom] = (_file, args) =>
    new Promise((resolve, reject) => {
      execFile(_file, args, {}, (err, out) => (err ? reject(err) : resolve(out)));
    });

  const module = { exports: {} };
  // Same realm as the test on purpose: a fresh context would give the objects a
  // different Object.prototype and every deepEqual would fail on identity.
  const wrapper = vm.runInThisContext(
    `(function (module, exports, require, process, __filename, __dirname) {${code}\n})`,
    { filename }
  );
  wrapper(
    module,
    module.exports,
    (id) => {
      if (id === 'child_process') return { execFile };
      if (id === '@monky/shared') return shared;
      assert.ok(['fs', 'path', 'util'].includes(id), `Unexpected dependency ${id}`);
      return require(id);
    },
    { platform },
    filename,
    path.dirname(filename)
  );
  return module.exports;
}

/** Lets the detector's chain of awaits (registry, manifest) settle. */
async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function steamFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-steam-'));
  const steamapps = path.join(root, 'steamapps');
  const extraLibrary = path.join(root, 'other-disk');
  fs.mkdirSync(steamapps, { recursive: true });
  fs.mkdirSync(path.join(extraLibrary, 'steamapps'), { recursive: true });
  fs.writeFileSync(path.join(steamapps, 'libraryfolders.vdf'), `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"${root.replace(/\\/g, '\\\\')}"
\t}
\t"1"
\t{
\t\t"path"\t\t"${extraLibrary.replace(/\\/g, '\\\\')}"
\t}
}
`);
  fs.writeFileSync(path.join(extraLibrary, 'steamapps', 'appmanifest_548430.acf'), `"AppState"
{
\t"appid"\t\t"548430"
\t"name"\t\t"Deep Rock Galactic"
\t"StateFlags"\t\t"4"
}
`);
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    /** Writes the icon exactly where Steam caches it, hash-named and all. */
    writeIcon: (appId, bytes) => {
      const dir = path.join(root, 'appcache', 'librarycache', String(appId));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${'a'.repeat(40)}.jpg`), bytes);
    },
  };
}

/** Smallest thing that still starts with the JPEG magic the validator demands. */
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

test('reports the running game by reading what Steam already wrote to disk', async () => {
  const { root, cleanup } = steamFixture();
  try {
    const { SteamPresence } = load({ registry: { RunningAppID: '0x85e4e', SteamPath: root } });
    const seen = [];
    const presence = new SteamPresence((activity) => seen.push(activity));

    presence.setEnabled(true);
    await settle();
    presence.stop();

    const { startedAt, ...current } = presence.getCurrent();
    assert.deepEqual(current, { source: 'steam', appId: 548430, name: 'Deep Rock Galactic' });
    assert.ok(startedAt > 0 && startedAt <= Date.now(), 'o início é carimbado na detecção');
    // Only the app id, the title and the start travel: the manifest path and
    // anything else read along the way stay in the main process.
    assert.equal(seen.length, 1);
    const { startedAt: emitted, ...emittedRest } = seen[0];
    assert.deepEqual(emittedRest, { source: 'steam', appId: 548430, name: 'Deep Rock Galactic' });
    assert.equal(emitted, startedAt);
  } finally {
    cleanup();
  }
});

test('the same game keeps its original start across polls', async () => {
  const { root, cleanup } = steamFixture();
  try {
    const { SteamPresence } = load({ registry: { RunningAppID: '0x85e4e', SteamPath: root } });
    const seen = [];
    const presence = new SteamPresence((activity) => seen.push(activity));

    presence.setEnabled(true);
    await settle();
    const first = presence.getCurrent().startedAt;

    // A second read of the registry is not a second match: restamping here
    // would reset the counter on everyone else's screen every ten seconds.
    await presence.poll();
    await settle();
    presence.stop();

    assert.equal(presence.getCurrent().startedAt, first);
    assert.equal(seen.length, 1, 'nada é reemitido enquanto o jogo é o mesmo');
  } finally {
    cleanup();
  }
});

test('carries the icon Steam already cached for the game', async () => {
  const { root, cleanup, writeIcon } = steamFixture();
  try {
    writeIcon(548430, JPEG_BYTES);
    const { SteamPresence } = load({ registry: { RunningAppID: '0x85e4e', SteamPath: root } });
    const presence = new SteamPresence(() => {});

    presence.setEnabled(true);
    await settle();
    presence.stop();

    const { iconBase64 } = presence.getCurrent();
    assert.equal(iconBase64, JPEG_BYTES.toString('base64'));
    // What the renderer will rebuild into a data URI has to pass the same shape
    // check the server applies, or the icon is dropped in transit.
    assert.equal(shared.userActivitySchema.safeParse(presence.getCurrent()).success, true);
  } finally {
    cleanup();
  }
});

test('a game with no cached icon still reports, just without one', async () => {
  const { root, cleanup } = steamFixture();
  try {
    const { SteamPresence } = load({ registry: { RunningAppID: '0x85e4e', SteamPath: root } });
    const presence = new SteamPresence(() => {});

    presence.setEnabled(true);
    await settle();
    presence.stop();

    const current = presence.getCurrent();
    assert.equal(current.name, 'Deep Rock Galactic');
    assert.equal('iconBase64' in current, false, 'ausência é ausência, não string vazia');
  } finally {
    cleanup();
  }
});

test('anything that is not a JPEG never becomes an icon', async () => {
  const { root, cleanup, writeIcon } = steamFixture();
  try {
    // A PNG in the icon slot is not a corrupted JPEG: it is a file whose bytes
    // disagree with its name, and the extension is not what we trust.
    writeIcon(548430, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const { SteamPresence } = load({ registry: { RunningAppID: '0x85e4e', SteamPath: root } });
    const presence = new SteamPresence(() => {});

    presence.setEnabled(true);
    await settle();
    presence.stop();

    assert.equal('iconBase64' in presence.getCurrent(), false);
  } finally {
    cleanup();
  }
});

test('an oversized icon is refused instead of travelling', async () => {
  const { root, cleanup, writeIcon } = steamFixture();
  try {
    const huge = Buffer.concat([JPEG_BYTES, Buffer.alloc(64 * 1024, 0x41)]);
    writeIcon(548430, huge);
    const { SteamPresence } = load({ registry: { RunningAppID: '0x85e4e', SteamPath: root } });
    const presence = new SteamPresence(() => {});

    presence.setEnabled(true);
    await settle();
    presence.stop();

    assert.equal('iconBase64' in presence.getCurrent(), false);
  } finally {
    cleanup();
  }
});

test('turning sharing off clears the activity instead of only pausing detection', async () => {
  const { root, cleanup } = steamFixture();
  try {
    const { SteamPresence } = load({ registry: { RunningAppID: '0x85e4e', SteamPath: root } });
    const seen = [];
    const presence = new SteamPresence((activity) => seen.push(activity));

    presence.setEnabled(true);
    await settle();
    presence.setEnabled(false);

    // Without the trailing null the last game would stay on everyone's card.
    assert.equal(seen.at(-1), null);
    assert.equal(presence.getCurrent(), null);
  } finally {
    cleanup();
  }
});

test('stays quiet when Steam is installed but idle', async () => {
  const { root, cleanup } = steamFixture();
  try {
    const { SteamPresence } = load({ registry: { RunningAppID: '0x0', SteamPath: root } });
    const seen = [];
    const presence = new SteamPresence((activity) => seen.push(activity));
    presence.setEnabled(true);
    await settle();
    presence.stop();
    assert.deepEqual(seen, []);
  } finally {
    cleanup();
  }
});

test('lobby links only become steam:// URLs from validated parts', () => {
  const { buildLobbyUrl, parseLobbyLink } = load();

  const invite = parseLobbyLink('steam://joinlobby/1966720/109775244618626185/76561199149453591');
  assert.deepEqual(invite, {
    source: 'steam',
    appId: 1966720,
    lobbyId: '109775244618626185',
    hostSteamId: '76561199149453591',
  });
  assert.equal(
    buildLobbyUrl(invite),
    'steam://joinlobby/1966720/109775244618626185/76561199149453591'
  );

  // Anything that is not exactly a lobby link is refused rather than passed on
  // to the OS protocol handler.
  for (const bad of [
    'steam://run/1966720',
    'steam://joinlobby/1966720/abc/76561199149453591',
    'https://example.com',
    'steam://joinlobby/1966720/1/2 && calc.exe',
    '',
  ]) {
    assert.equal(parseLobbyLink(bad), null, bad);
  }
  assert.equal(buildLobbyUrl({ source: 'steam', appId: -1, lobbyId: '1', hostSteamId: '2' }), null);
});
