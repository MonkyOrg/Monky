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
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('reports the running game by reading what Steam already wrote to disk', async () => {
  const { root, cleanup } = steamFixture();
  try {
    const { SteamPresence } = load({ registry: { RunningAppID: '0x85e4e', SteamPath: root } });
    const seen = [];
    const presence = new SteamPresence((activity) => seen.push(activity));

    presence.setEnabled(true);
    await settle();
    presence.stop();

    assert.deepEqual(presence.getCurrent(), {
      source: 'steam', appId: 548430, name: 'Deep Rock Galactic',
    });
    // Only the app id and the title travel: the manifest path and anything else
    // read along the way stay in the main process.
    assert.deepEqual(seen, [{ source: 'steam', appId: 548430, name: 'Deep Rock Galactic' }]);
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
