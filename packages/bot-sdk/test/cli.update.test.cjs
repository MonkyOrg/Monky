const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const { test } = require('node:test');

const cliConfig = require('../dist/cli/config');
const pm2 = require('../dist/cli/pm2');
const toolingProcess = require('../dist/tooling/process');
const updates = require('../dist/cli/commands/update');
const releases = require('../dist/cli/updateReleases');
const updater = require('../dist/cli/updater');

function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function fixture(t, { version = '1.2.3', releasesConfig = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-sdk-cli-update-'));
  const globalRoot = path.join(root, 'global', 'node_modules');
  const bot = path.join(globalRoot, '@example', 'sound-bot');
  fs.mkdirSync(path.join(bot, 'dist'), { recursive: true });
  json(path.join(bot, 'package.json'), {
    name: '@example/sound-bot',
    version,
    type: 'commonjs',
    monkyBot: {
      cliName: 'sound-bot',
      displayName: 'Sound Bot',
      entry: 'dist/index.js',
      modes: ['manual'],
      ...(releasesConfig ? { releases: { url: 'https://github.com/example/sound-bot/releases' } } : {}),
    },
  });
  fs.writeFileSync(path.join(bot, 'dist', 'index.js'), 'module.exports = {};');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { root, bot, globalRoot, state: path.join(root, 'state') };
}

function tarHeader(name, size, type = '0', linkpath = '') {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(name.length, 100), 'utf8');
  header.write('0000777\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(' ', 148, 156);
  header[156] = type.charCodeAt(0);
  header.write(linkpath, 157, Math.min(linkpath.length, 100), 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function createArchive(file, entries) {
  const blocks = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    blocks.push(
      tarHeader(entry.name, entry.size ?? content.length, entry.type, entry.linkpath),
      content,
      Buffer.alloc((512 - (content.length % 512)) % 512)
    );
  }
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024, 0)])));
}

function createTarball(file, pkg) {
  createArchive(file, [{ name: 'package/package.json', content: JSON.stringify(pkg, null, 2) }]);
}

function paxRecord(key, value) {
  const suffix = ` ${key}=${value}\n`;
  const bytes = Buffer.byteLength(suffix);
  let size = bytes + 1;
  while (size !== bytes + String(size).length) size = bytes + String(size).length;
  return `${size}${suffix}`;
}

function release(definition, version, changes = {}) {
  const assetName = `${definition.cliName}-${version}.tgz`;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.split('+', 1)[0].includes('-'),
    html_url: `https://github.com/example/sound-bot/releases/tag/v${version}`,
    assets: [{ id: 77, name: assetName }],
    ...changes,
  };
}

test('semantic comparison and release selection preserve stable promotion and exact asset matching', () => {
  const definition = {
    cliName: 'sound-bot',
    displayName: 'Sound Bot',
    entry: 'dist/index.js',
    buildScript: null,
    files: ['dist'],
    modes: ['manual'],
    releases: { url: 'https://github.com/example/sound-bot/releases', repository: 'example/sound-bot', assetName: 'sound-bot-{version}.tgz', tokenEnv: 'GH_TOKEN' },
  };
  assert.ok(releases.compareVersions('2.0.0', '2.0.0-beta.4') > 0);
  assert.ok(releases.compareVersions('2.0.0-beta.10', '2.0.0-beta.2') > 0);
  assert.ok(releases.compareVersions('2.0.0-alpha-2', '2.0.0-alpha-1') > 0);
  assert.ok(releases.compareVersions('2.0.0-Beta', '2.0.0-alpha') < 0);
  assert.ok(releases.compareVersions('2.0.0-9007199254740993', '2.0.0-9007199254740992') > 0);
  assert.equal(releases.compareVersions('2.0.0+build-a', '2.0.0+build-b'), 0);
  const selected = releases.selectRelease(definition, [
    release(definition, '1.2.4-beta.1'),
    release(definition, '1.2.4'),
    release(definition, '1.2.5', { assets: [{ id: 88, name: 'other-package-1.2.5.tgz' }] }),
  ], true);
  assert.equal(selected.version, '1.2.4');
  assert.equal(releases.selectRelease(definition, [release(definition, '1.2.4-beta.1')], false), null);
  assert.equal(releases.selectRelease(definition, [release(definition, '1.2.4+build-a')], false).version, '1.2.4+build-a');
});

test('release lookup paginates and accepts the GITHUB_TOKEN fallback for GH_TOKEN', async (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot);
  const calls = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    calls.push({ url: String(url), headers: options.headers, rejectUnauthorized: options.rejectUnauthorized });
    const req = new Readable({ read() {} });
    req.setTimeout = (_ms, handler) => {
      req.on('timeout', handler);
      return req;
    };
    req.destroy = (error) => {
      if (error) req.emit('error', error);
      return req;
    };
    queueMicrotask(() => {
      const page = new URL(String(url)).searchParams.get('page');
      const body = page === '1'
        ? JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ tag_name: `skip-${index}`, draft: true, assets: [] })))
        : JSON.stringify([release(context.project.definition, '1.2.4')]);
      const response = Readable.from([body]);
      response.statusCode = 200;
      response.headers = {};
      response.setEncoding = () => {};
      callback(response);
    });
    return req;
  });
  const latest = await releases.fetchLatestRelease(
    context.project.definition.releases,
    context.project.definition,
    false,
    { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: 'fallback-token' }
  );
  assert.equal(latest.version, '1.2.4');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.rejectUnauthorized === true));
  assert.equal(calls[0].headers.Authorization, 'Bearer fallback-token');
  assert.match(calls[0].url, /page=1$/);
  assert.match(calls[1].url, /page=2$/);
});

test('tarball verification reads the packaged name, version and cli metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-sdk-tarball-'));
  try {
    const file = path.join(root, 'sound-bot-1.2.4.tgz');
    createTarball(file, {
      name: '@example/sound-bot',
      version: '1.2.4',
      monkyBot: { cliName: 'sound-bot' },
    });
    assert.deepEqual(releases.readPackageManifestFromTarball(file), {
      name: '@example/sound-bot',
      version: '1.2.4',
      cliName: 'sound-bot',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test('update fails before network, npm or pm2 when releases are not configured', async (t) => {
  const f = fixture(t, { releasesConfig: false });
  const context = cliConfig.createCliContext(f.bot);
  const fetch = t.mock.method(releases, 'fetchLatestRelease', async () => {
    throw new Error('should not fetch');
  });
  const runNpm = t.mock.method(toolingProcess, 'runNpm', () => {
    throw new Error('should not install');
  });
  const find = t.mock.method(pm2, 'findProcess', () => {
    throw new Error('should not inspect pm2');
  });

  await assert.rejects(updates.updateCommand(context, ['--check']), /Updates are not configured/);
  await assert.rejects(updates.updateCommand(context, ['--yes']), /Updates are not configured/);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(runNpm.mock.callCount(), 0);
  assert.equal(find.mock.callCount(), 0);
});

test('update installs a verified local tarball and restarts the same managed bot', async (t) => {
  const f = fixture(t);
  const previousHome = process.env.MONKY_BOT_CLI_HOME;
  process.env.MONKY_BOT_CLI_HOME = f.state;
  t.after(() => {
    if (previousHome === undefined) delete process.env.MONKY_BOT_CLI_HOME;
    else process.env.MONKY_BOT_CLI_HOME = previousHome;
  });
  const context = cliConfig.createCliContext(f.bot);
  cliConfig.writeConfig(context, cliConfig.manualConfig(context, {
    botName: 'Updater Bot',
    botDir: path.join(f.state, '.sound-bot', 'runtime'),
    serverUrl: 'ws://localhost:3000',
    tokenEnv: 'BOT_TOKEN',
  }));

  const asset = path.join(f.root, 'sound-bot-1.2.4.tgz');
  createTarball(asset, {
    name: '@example/sound-bot',
    version: '1.2.4',
    monkyBot: { cliName: 'sound-bot' },
  });

  t.mock.method(releases, 'fetchLatestRelease', async () => ({
    version: '1.2.4',
    tagName: 'v1.2.4',
    htmlUrl: 'https://github.com/example/sound-bot/releases/tag/v1.2.4',
    assetId: 77,
    assetName: 'sound-bot-1.2.4.tgz',
    repository: 'example/sound-bot',
  }));
  t.mock.method(releases, 'downloadReleaseAsset', async (_source, _release, destination) => {
    fs.copyFileSync(asset, destination);
  });
  const npmCalls = [];
  t.mock.method(toolingProcess, 'runNpm', (args) => {
    npmCalls.push(args);
    if (args[0] === 'root') return f.globalRoot;
    const pkg = JSON.parse(fs.readFileSync(path.join(f.bot, 'package.json'), 'utf8'));
    pkg.version = '1.2.4';
    json(path.join(f.bot, 'package.json'), pkg);
    return '';
  });
  t.mock.method(pm2, 'findProcess', () => ({ pm2_env: { status: 'online' } }));
  const restarted = t.mock.method(pm2, 'startOrRestart', () => {});
  const saved = t.mock.method(pm2, 'saveProcessList', () => {});

  await updates.updateCommand(context, ['--yes']);
  assert.equal(npmCalls.length, 2);
  assert.deepEqual(npmCalls[0], ['root', '--global']);
  assert.deepEqual(npmCalls[1].slice(0, 4), ['install', '-g', '--ignore-scripts', '--offline']);
  assert.ok(path.isAbsolute(npmCalls[1][npmCalls[1].length - 1]));
  assert.equal(restarted.mock.callCount(), 1);
  assert.equal(saved.mock.callCount(), 1);
});

test('autoupdate on checks for explicit releases before consulting pm2', async (t) => {
  const f = fixture(t, { releasesConfig: false });
  const context = cliConfig.createCliContext(f.bot);
  const requirePm2 = t.mock.method(pm2, 'requirePm2', () => {
    throw new Error('should not require pm2');
  });
  await assert.rejects(updates.autoUpdateCommand(context, ['on']), /Updates are not configured/);
  assert.equal(requirePm2.mock.callCount(), 0);
});

test('auto-update follows the installed channel unless beta is explicitly pinned', (t) => {
  const f = fixture(t, { version: '1.2.3-beta.1' });
  const calls = [];
  t.mock.method(childProcess, 'spawnSync', (_command, args) => {
    calls.push(args);
    return { status: 0 };
  });

  updater.runAutoUpdateOnce({
    packageRoot: f.bot,
    updateCwd: f.bot,
    updateArgs: ['C:\\tooling\\monky-cli.cjs', 'update', '--yes'],
    schedule: '04:00',
    includeBeta: false,
  });
  assert.ok(calls[0].includes('--beta'));

  json(path.join(f.bot, 'package.json'), {
    name: '@example/sound-bot',
    version: '1.2.3',
    type: 'commonjs',
    monkyBot: {
      cliName: 'sound-bot',
      displayName: 'Sound Bot',
      entry: 'dist/index.js',
      modes: ['manual'],
      releases: { url: 'https://github.com/example/sound-bot/releases' },
    },
  });
  updater.runAutoUpdateOnce({
    packageRoot: f.bot,
    updateCwd: f.bot,
    updateArgs: ['C:\\tooling\\monky-cli.cjs', 'update', '--yes'],
    schedule: '04:00',
    includeBeta: false,
  });
  assert.equal(calls[1].includes('--beta'), false);

  updater.runAutoUpdateOnce({
    packageRoot: f.bot,
    updateCwd: f.bot,
    updateArgs: ['C:\\tooling\\monky-cli.cjs', 'update', '--yes'],
    schedule: '04:00',
    includeBeta: true,
  });
  assert.ok(calls[2].includes('--beta'));
});

test('private asset redirects never forward authentication to the CDN', async (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot);
  const calls = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    calls.push({ url: String(url), options });
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = (error) => {
      if (error) request.emit('error', error);
      return request;
    };
    queueMicrotask(() => {
      const api = new URL(String(url)).hostname === 'api.github.com';
      const response = Readable.from(api ? [] : [Buffer.from('fixture-asset')]);
      response.statusCode = api ? 302 : 200;
      response.headers = api
        ? { location: 'https://release-assets.githubusercontent.com/fixture?signature=not-a-secret' }
        : {};
      callback(response);
    });
    return request;
  });
  const asset = releases.selectRelease(context.project.definition, [release(context.project.definition, '1.2.4')], false);
  const destination = path.join(f.root, 'download.tgz');
  await releases.downloadReleaseAsset(context.project.definition.releases, asset, destination, { GH_TOKEN: 'fixture-access-token' });
  assert.equal(fs.readFileSync(destination, 'utf8'), 'fixture-asset');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].options.headers.Authorization);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.ok(calls.every((call) => call.options.rejectUnauthorized === true));
});

test('malformed, non-HTTPS, credential-bearing and untrusted asset redirects are rejected', async (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot);
  const asset = releases.selectRelease(context.project.definition, [release(context.project.definition, '1.2.4')], false);
  let location;
  let requests = 0;
  t.mock.method(https, 'get', (_url, _options, callback) => {
    requests += 1;
    const request = new EventEmitter();
    request.setTimeout = () => request;
    queueMicrotask(() => {
      const response = Readable.from([]);
      response.statusCode = 302;
      response.headers = { location };
      callback(response);
    });
    return request;
  });
  const targets = [
    'https://[',
    'http://release-assets.githubusercontent.com/asset',
    'https://example.test/asset',
    'https://user:fixture@release-assets.githubusercontent.com/asset',
    'https://release-assets.githubusercontent.com:8443/asset',
  ];
  for (location of targets) {
    await assert.rejects(
      releases.downloadReleaseAsset(context.project.definition.releases, asset, path.join(f.root, 'download.tgz'), {}),
      /redirect/i
    );
  }
  assert.equal(requests, targets.length);
  assert.equal(fs.existsSync(path.join(f.root, 'download.tgz')), false);
});

test('a failed asset transfer closes its file before temporary download cleanup', async (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot);
  const asset = releases.selectRelease(context.project.definition, [release(context.project.definition, '1.2.4')], false);
  t.mock.method(https, 'get', (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = {};
      callback(response);
      response.write('partial download');
      setImmediate(() => response.destroy(new Error('fixture-transfer-failed')));
    });
    return request;
  });
  const destination = path.join(f.root, 'incomplete.tgz');
  await assert.rejects(
    releases.downloadReleaseAsset(context.project.definition.releases, asset, destination, {}),
    /fixture-transfer-failed/
  );
  if (fs.existsSync(destination)) fs.rmSync(destination);
  assert.equal(fs.existsSync(destination), false);
});

test('tar verification honors PAX paths and rejects duplicate, linked or oversized manifests', (t) => {
  const f = fixture(t);
  const file = path.join(f.root, 'archive.tgz');
  const pkg = { name: '@example/sound-bot', version: '1.2.4', monkyBot: { cliName: 'sound-bot' } };
  const manifest = { name: 'package/package.json', content: JSON.stringify(pkg) };
  const pax = { name: 'PaxHeader/renamed.json', type: 'x', content: paxRecord('path', 'package/package.json') };
  createArchive(file, [pax, { ...manifest, name: 'package/renamed.json' }]);
  assert.equal(releases.readPackageManifestFromTarball(file).name, pkg.name);
  createArchive(file, [manifest, pax, { ...manifest, name: 'package/renamed.json' }]);
  assert.throws(() => releases.readPackageManifestFromTarball(file), /duplicate/);
  createArchive(file, [{ name: 'package/package.json', type: '2', linkpath: 'other.json' }]);
  assert.throws(() => releases.readPackageManifestFromTarball(file), /regular file/);
  createArchive(file, [{ name: 'package/package.json', size: 1024 * 1024 + 1 }]);
  assert.throws(() => releases.readPackageManifestFromTarball(file), /size limit/);
  createArchive(file, [{ name: 'package/oversized.bin', size: 200 * 1024 * 1024 + 1 }]);
  assert.throws(() => releases.readPackageManifestFromTarball(file), /unpacked size/);
});

test('equal or older releases cannot be forced and checking a newer version is read-only', async (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot);
  let version = '1.2.3';
  t.mock.method(releases, 'fetchLatestRelease', async () =>
    releases.selectRelease(context.project.definition, [release(context.project.definition, version)], false));
  t.mock.method(toolingProcess, 'runNpm', () => assert.fail('npm must not be called'));
  t.mock.method(pm2, 'findProcess', () => assert.fail('PM2 must not be called'));
  t.mock.method(releases, 'downloadReleaseAsset', () => assert.fail('must not download'));
  await updates.updateCommand(context, ['--yes']);
  version = '1.2.2';
  await updates.updateCommand(context, ['--yes']);
  version = '1.2.4';
  await updates.updateCommand(context, ['--check']);
});

test('source checkouts and other npm prefixes cannot install an update into an unrelated location', async (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot);
  t.mock.method(releases, 'fetchLatestRelease', async () =>
    releases.selectRelease(context.project.definition, [release(context.project.definition, '1.2.4')], false));
  const npm = t.mock.method(toolingProcess, 'runNpm', (args) => {
    assert.deepEqual(args, ['root', '--global']);
    return path.join(f.root, 'different-global-prefix');
  });
  t.mock.method(pm2, 'findProcess', () => assert.fail('must not invoke PM2'));
  t.mock.method(releases, 'downloadReleaseAsset', () => assert.fail('must not download'));
  await assert.rejects(updates.updateCommand(context, ['--yes']), /globally installed bot CLI/);
  assert.equal(npm.mock.callCount(), 1);
});

test('mismatched bot identity or version is rejected before npm install', async (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot);
  let manifest;
  t.mock.method(releases, 'fetchLatestRelease', async () =>
    releases.selectRelease(context.project.definition, [release(context.project.definition, '1.2.4')], false));
  t.mock.method(releases, 'downloadReleaseAsset', async (_source, _release, destination) => createTarball(destination, manifest));
  t.mock.method(pm2, 'findProcess', () => null);
  t.mock.method(toolingProcess, 'runNpm', (args) => {
    assert.deepEqual(args, ['root', '--global']);
    return f.globalRoot;
  });
  for (manifest of [
    { name: '@example/other-bot', version: '1.2.4', monkyBot: { cliName: 'sound-bot' } },
    { name: '@example/sound-bot', version: '1.2.3', monkyBot: { cliName: 'sound-bot' } },
    { name: '@example/sound-bot', version: '1.2.4', monkyBot: { cliName: 'other-bot' } },
  ]) {
    await assert.rejects(updates.updateCommand(context, ['--yes']), /does not match the expected bot package/);
  }
});

test('the scheduler stops before spawning an updater when release metadata is removed', (t) => {
  const f = fixture(t, { releasesConfig: false });
  t.mock.method(childProcess, 'spawnSync', () => assert.fail('must not spawn an updater'));
  assert.throws(() => updater.runAutoUpdateOnce({
    packageRoot: f.bot, updateCwd: f.bot, updateArgs: ['fixture.cjs', 'update', '--yes'],
    schedule: '04:00', includeBeta: false,
  }), /no longer configures a GitHub Releases source/);
});
