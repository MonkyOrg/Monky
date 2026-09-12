const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable, Writable } = require('node:stream');
const { test } = require('node:test');

const cliConfig = require('../dist/cli/config');
const pm2 = require('../dist/cli/pm2');
const toolingProcess = require('../dist/tooling/process');
const updates = require('../dist/cli/commands/update');
const releases = require('../dist/cli/updateReleases');
const sources = require('../dist/cli/updateSources');
const updater = require('../dist/cli/updater');

function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function fixture(t, { version = '1.2.3', releasesConfig = true, updateSource, homeInPackage = false } = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '.monky-sdk-cli-update-'));
  t.mock.method(os, 'tmpdir', () => root);
  t.mock.method(https, 'get', () => assert.fail('Unexpected network request'));
  t.mock.method(childProcess, 'spawnSync', () => assert.fail('Unexpected external process'));
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
      ...(updateSource ? { updateSource }
        : releasesConfig ? { releases: { url: 'https://github.com/example/sound-bot/releases' } } : {}),
    },
  });
  fs.writeFileSync(path.join(bot, 'dist', 'index.js'), 'module.exports = {};');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const result = { root, bot, globalRoot, state: homeInPackage ? bot : path.join(root, 'state') };
  fixtureHome(t, result);
  return result;
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

function botManifest(version = '1.2.4', changes = {}) {
  return { name: '@example/sound-bot', version, monkyBot: { cliName: 'sound-bot' }, ...changes };
}

function mockHttp(t, handler) {
  const calls = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = (ms, onTimeout) => {
      request.timeoutMs = ms;
      request.onTimeout = onTimeout;
      return request;
    };
    request.destroy = (error) => {
      if (error) request.emit('error', error);
      return request;
    };
    options.signal?.addEventListener('abort', () => request.destroy(new Error('fixture-aborted')), { once: true });
    const call = { url: String(url), options, request };
    calls.push(call);
    queueMicrotask(() => {
      const plan = handler(call, calls.length);
      if (!plan) return;
      if (plan.error) {
        request.destroy(plan.error);
        return;
      }
      const response = plan.response ?? Readable.from(plan.body === undefined ? [] : [plan.body]);
      response.statusCode = plan.statusCode ?? 200;
      response.headers = plan.headers ?? {};
      callback(response);
    });
    return request;
  });
  return calls;
}

function archiveFixture(t, type, version = '1.2.3', options = {}) {
  const updateSource = type === 'https'
    ? { type, url: 'https://downloads.example.test/current.tgz' }
    : { type, path: '../release files/current.tgz' };
  const f = fixture(t, { ...options, version, updateSource });
  const file = type === 'file' ? path.resolve(f.bot, updateSource.path) : path.join(f.root, 'current.tgz');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const calls = type === 'https'
    ? mockHttp(t, () => ({ body: fs.readFileSync(file) }))
    : [];
  return { ...f, file, calls };
}

function fixtureHome(t, f) {
  const previousHome = process.env.MONKY_BOT_CLI_HOME;
  process.env.MONKY_BOT_CLI_HOME = f.state;
  t.after(() => {
    if (previousHome === undefined) delete process.env.MONKY_BOT_CLI_HOME;
    else process.env.MONKY_BOT_CLI_HOME = previousHome;
  });
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
  const root = fs.mkdtempSync(path.join(__dirname, '.monky-sdk-tarball-'));
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
  const pkg = JSON.parse(fs.readFileSync(path.join(f.bot, 'package.json'), 'utf8'));
  pkg.repository = 'https://github.com/example/sound-bot';
  json(path.join(f.bot, 'package.json'), pkg);
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
    /Update archive download failed/
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
  }), /Updates are not configured/);
});

for (const type of ['https', 'file']) {
  test(`${type} source inspects metadata without installation for checks, equal, older and excluded beta versions`, async (t) => {
    const f = archiveFixture(t, type);
    const context = cliConfig.createCliContext(f.bot);
    const output = [];
    t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
    const npm = t.mock.method(toolingProcess, 'runNpm', () => assert.fail('must not invoke npm'));
    const find = t.mock.method(pm2, 'findProcess', () => assert.fail('must not invoke PM2'));
    const github = t.mock.method(releases, 'fetchLatestRelease', () => assert.fail('must not fall back to GitHub'));
    const packageBefore = fs.readFileSync(path.join(f.bot, 'package.json'));
    for (const [version, args, message] of [
      ['1.2.3', ['--yes'], /já está na versão mais recente/],
      ['1.2.3+build.2', ['--yes'], /já está na versão mais recente/],
      ['1.2.2', ['--yes', '--beta'], /downgrade bloqueado/],
      ['1.2.4', ['--check'], /Nova versão disponível: 1\.2\.4/],
      ['1.2.4-beta.1', ['--yes'], /Nenhuma release instalável/],
      ['1.2.4-beta.1', ['--beta', '--check'], /Nova versão disponível: 1\.2\.4-beta\.1/],
    ]) {
      createTarball(f.file, botManifest(version));
      const sourceBefore = fs.readFileSync(f.file);
      const contentsBefore = fs.readdirSync(f.root).sort();
      output.length = 0;
      const cwd = process.cwd();
      try {
        process.chdir(f.root);
        await updates.updateCommand(context, args);
      } finally {
        process.chdir(cwd);
      }
      assert.match(output.join('\n'), message);
      assert.deepEqual(fs.readFileSync(f.file), sourceBefore);
      assert.deepEqual(fs.readdirSync(f.root).sort(), contentsBefore);
      assert.deepEqual(fs.readFileSync(path.join(f.bot, 'package.json')), packageBefore);
      assert.equal(fs.existsSync(context.homeDir), false);
    }
    assert.equal(npm.mock.callCount(), 0);
    assert.equal(find.mock.callCount(), 0);
    assert.equal(github.mock.callCount(), 0);
    assert.equal(f.calls.length, type === 'https' ? 6 : 0);
  });

  test(`${type} source rejects a wrong bot identity, missing CLI identity and invalid SemVer even with --check`, async (t) => {
    const f = archiveFixture(t, type);
    const context = cliConfig.createCliContext(f.bot);
    t.mock.method(toolingProcess, 'runNpm', () => assert.fail('must not invoke npm'));
    t.mock.method(pm2, 'findProcess', () => assert.fail('must not invoke PM2'));
    for (const manifest of [
      botManifest('1.2.4', { name: '@example/other-bot' }),
      botManifest('1.2.4', { monkyBot: { cliName: 'other-bot' } }),
      botManifest('1.2.4', { monkyBot: {} }),
      botManifest('1.2.4', { monkyBot: undefined }),
      botManifest('v1.2.4'),
      botManifest('1.2.4-01'),
      botManifest('1.2'),
      botManifest(null),
      botManifest('1.2.2', { name: '@example/other-bot' }),
    ]) {
      createTarball(f.file, manifest);
      await assert.rejects(updates.updateCommand(context, ['--check']), /expected bot package|valid name\/version/);
    }
  });

  test(`${type} source retains the global-prefix installation guard and cleans its inspected archive on failure`, async (t) => {
    const f = archiveFixture(t, type);
    const context = cliConfig.createCliContext(f.bot);
    createTarball(f.file, botManifest());
    const contentsBefore = fs.readdirSync(f.root).sort();
    const npm = t.mock.method(toolingProcess, 'runNpm', (args) => {
      assert.deepEqual(args, ['root', '--global']);
      return path.join(f.root, 'different-global-prefix');
    });
    t.mock.method(pm2, 'findProcess', () => assert.fail('must not invoke PM2'));
    await assert.rejects(updates.updateCommand(context, ['--yes']), /globally installed bot CLI/);
    assert.equal(npm.mock.callCount(), 1);
    assert.deepEqual(fs.readdirSync(f.root).sort(), contentsBefore);
  });

  test(`${type} source promotes an installed beta to stable and installs only the verified snapshot while preserving profile and keys`, async (t) => {
    const f = archiveFixture(t, type, '2.0.0-beta.2');
    const context = cliConfig.createCliContext(f.bot);
    const config = cliConfig.manualConfig(context, {
      botName: 'Existing Bot',
      botDir: path.join(context.homeDir, 'runtime'),
      serverUrl: 'wss://server.example.test',
      tokenEnv: 'BOT_TOKEN',
    });
    cliConfig.writeConfig(context, config);
    const profileFile = path.join(config.botDir, 'profile.json');
    const keysFile = path.join(config.botDir, '.keys', 'registration.json');
    json(profileFile, { name: 'Personalized', avatar: 'fixture-avatar' });
    json(keysFile, { privateKey: 'fixture-key', serverToken: 'fixture-registration-token' });
    const preserved = [context.configFile, profileFile, keysFile].map((file) => [file, fs.readFileSync(file)]);
    createTarball(f.file, botManifest('2.0.0'));
    const npmCalls = [];
    let snapshot;
    t.mock.method(toolingProcess, 'runNpm', (args, options) => {
      npmCalls.push({ args, options });
      if (args[0] === 'root') return f.globalRoot;
      snapshot = args[args.length - 1];
      assert.notEqual(snapshot, f.file);
      assert.equal(releases.readPackageManifestFromTarball(snapshot).version, '2.0.0');
      const pkg = JSON.parse(fs.readFileSync(path.join(f.bot, 'package.json'), 'utf8'));
      pkg.version = '2.0.0';
      json(path.join(f.bot, 'package.json'), pkg);
      return '';
    });
    t.mock.method(pm2, 'findProcess', () => {
      createTarball(f.file, botManifest('9.0.0'));
      return { pm2_env: { status: 'online' } };
    });
    const restarted = t.mock.method(pm2, 'startOrRestart', () => {});
    const saved = t.mock.method(pm2, 'saveProcessList', () => {});
    await updates.updateCommand(context, ['--yes']);
    assert.equal(npmCalls.length, 2);
    assert.deepEqual(npmCalls[1].args.slice(0, -1), [
      'install', '-g', '--ignore-scripts', '--offline', '--no-audit', '--no-fund',
    ]);
    assert.equal(npmCalls[1].options.stdio, 'pipe');
    assert.equal(restarted.mock.callCount(), 1);
    assert.equal(saved.mock.callCount(), 1);
    for (const [file, contents] of preserved) assert.deepEqual(fs.readFileSync(file), contents);
    assert.equal(fs.existsSync(snapshot), false);
    assert.equal(releases.readPackageManifestFromTarball(f.file).version, '9.0.0');
  });
}

test('local missing, directory, unreadable and corrupt archives fail explicitly without a source fallback', async (t) => {
  const f = archiveFixture(t, 'file');
  const context = cliConfig.createCliContext(f.bot);
  t.mock.method(releases, 'fetchLatestRelease', () => assert.fail('must not fall back'));
  t.mock.method(toolingProcess, 'runNpm', () => assert.fail('must not invoke npm'));
  t.mock.method(pm2, 'findProcess', () => assert.fail('must not invoke PM2'));
  await assert.rejects(updates.updateCommand(context, ['--check']), /local update archive is missing/);
  fs.mkdirSync(f.file);
  await assert.rejects(updates.updateCommand(context, ['--check']), /regular file/);
  fs.rmdirSync(f.file);
  for (const contents of [Buffer.from('not a tgz'), zlib.gzipSync(Buffer.from('not a tar'))]) {
    fs.writeFileSync(f.file, contents);
    await assert.rejects(updates.updateCommand(context, ['--check']), /valid.*\.tgz|gzip-compressed/);
  }
  createTarball(f.file, botManifest());
  const originalOpen = fs.openSync;
  const open = t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === f.file) throw Object.assign(new Error('fixture-private-path-and-token'), { code: 'EACCES' });
    return originalOpen(file, ...args);
  });
  await assert.rejects(updates.updateCommand(context, ['--check']), (error) => {
    assert.match(error.message, /Could not read or copy.*EACCES/);
    assert.equal(error.message.includes('fixture-private-path-and-token'), false);
    return true;
  });
  open.mock.restore();
  assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith('sound-bot-update-')), false);
});

test('local copy rejects oversized or concurrently changing files before installation', async (t) => {
  const f = archiveFixture(t, 'file');
  createTarball(f.file, botManifest());
  const destination = path.join(f.root, 'snapshot.tgz');
  const originalStat = fs.fstatSync;
  const stat = t.mock.method(fs, 'fstatSync', (...args) =>
    Object.assign(originalStat(...args), { size: 200 * 1024 * 1024 + 1 }));
  await assert.rejects(releases.copyLocalUpdateArchive(f.file, destination), /size limit/);
  stat.mock.restore();
  assert.equal(fs.existsSync(destination), false);
  const originalRead = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (...args) => {
    const stream = originalRead(...args);
    stream.once('end', () => fs.appendFileSync(f.file, 'changed-during-copy'));
    return stream;
  });
  await assert.rejects(releases.copyLocalUpdateArchive(f.file, destination), /changed while being copied/);
  fs.rmSync(destination);
});

test('an absolute local source is supported independently of the operator working directory', async (t) => {
  const f = archiveFixture(t, 'file');
  createTarball(f.file, botManifest());
  const pkg = JSON.parse(fs.readFileSync(path.join(f.bot, 'package.json'), 'utf8'));
  pkg.monkyBot.updateSource.path = f.file;
  json(path.join(f.bot, 'package.json'), pkg);
  const context = cliConfig.createCliContext(f.bot);
  let observedVersion;
  await sources.withUpdateCandidate(context.project, false, (candidate) => { observedVersion = candidate?.version; });
  assert.equal(observedVersion, '1.2.4');
  assert.ok(path.isAbsolute(context.project.definition.updateSource.path));
});

test('direct HTTPS credentials are optional env-only Bearer tokens and same-origin redirects preserve them', async (t) => {
  const f = fixture(t, { releasesConfig: false });
  const secret = 'fixture-https-private-access';
  const calls = mockHttp(t, (_call, index) => index === 1
    ? { statusCode: 302, headers: { location: '/download/current.tgz?signature=fixture-signed-response' } }
    : { body: Buffer.from('fixture-archive') });
  const source = { type: 'https', url: 'https://downloads.example.test/current.tgz', tokenEnv: 'BOT_UPDATE_TOKEN' };
  await releases.downloadHttpsUpdateArchive(source, path.join(f.root, 'current.tgz'), { BOT_UPDATE_TOKEN: secret });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.options.headers.Authorization === `Bearer ${secret}`));
  assert.ok(calls.every((call) => call.options.rejectUnauthorized === true));
  assert.ok(calls.every((call) => call.request.timeoutMs === 60_000));
  await assert.rejects(releases.downloadHttpsUpdateArchive(source, path.join(f.root, 'missing.tgz'), {}), /Set BOT_UPDATE_TOKEN/);
  await assert.rejects(
    releases.downloadHttpsUpdateArchive(source, path.join(f.root, 'invalid.tgz'), { BOT_UPDATE_TOKEN: `${secret}\r\ninjected` }),
    /header-safe token/
  );
  assert.equal(calls.length, 2);
});

test('direct HTTPS redirects reject other origins, credentials, non-HTTPS and excessive chains', async (t) => {
  const f = fixture(t, { releasesConfig: false });
  let location;
  const calls = mockHttp(t, () => ({ statusCode: 302, headers: { location } }));
  const source = { type: 'https', url: 'https://downloads.example.test/current.tgz' };
  for (location of [
    'https://different.example.test/current.tgz',
    'https://downloads.example.test:8443/current.tgz',
    'http://downloads.example.test/current.tgz',
    'https://user:fixture-secret@downloads.example.test/current.tgz',
    'https://@downloads.example.test/current.tgz',
    'https://[',
    '/current.tgz#fragment',
  ]) {
    await assert.rejects(releases.downloadHttpsUpdateArchive(source, path.join(f.root, 'archive.tgz'), {}), /redirect/i);
  }
  assert.equal(calls.length, 7);
  location = '/current.tgz';
  await assert.rejects(releases.downloadHttpsUpdateArchive(source, path.join(f.root, 'archive.tgz'), {}), /excessive.*redirect/);
  assert.equal(calls.length, 13);
  assert.equal(fs.existsSync(path.join(f.root, 'archive.tgz')), false);
});

test('HTTPS archive downloads enforce declared and streamed byte limits without installing', async (t) => {
  const f = fixture(t, { releasesConfig: false });
  const source = { type: 'https', url: 'https://downloads.example.test/current.tgz' };
  mockHttp(t, () => ({ headers: { 'content-length': String(200 * 1024 * 1024 + 1) } }));
  await assert.rejects(releases.downloadHttpsUpdateArchive(source, path.join(f.root, 'archive.tgz'), {}), /size limit/);
  assert.equal(fs.existsSync(path.join(f.root, 'archive.tgz')), false);
  const chunk = Buffer.alloc(1024 * 1024);
  mockHttp(t, () => ({ response: Readable.from(Array.from({ length: 201 }, () => chunk)) }));
  t.mock.method(fs, 'createWriteStream', () => new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
  await assert.rejects(releases.downloadHttpsUpdateArchive(source, path.join(f.root, 'archive.tgz'), {}), /size limit/);
});

test('an HTTPS source HTTP error or corrupt archive never falls back to GitHub or npm', async (t) => {
  const f = archiveFixture(t, 'https');
  const context = cliConfig.createCliContext(f.bot);
  let response = { statusCode: 404, body: 'fixture-private-response-body' };
  const calls = mockHttp(t, () => response);
  t.mock.method(releases, 'fetchLatestRelease', () => assert.fail('must not fall back to GitHub'));
  t.mock.method(toolingProcess, 'runNpm', () => assert.fail('must not invoke npm'));
  t.mock.method(pm2, 'findProcess', () => assert.fail('must not invoke PM2'));
  await assert.rejects(updates.updateCommand(context, ['--check']), /download failed with HTTP 404/);
  response = { body: Buffer.from('fixture-corrupt-private-content') };
  await assert.rejects(updates.updateCommand(context, ['--check']), /gzip-compressed.*\.tgz/);
  assert.equal(calls.length, 2);
  assert.equal(fs.readdirSync(f.root).some((name) => name.startsWith('sound-bot-update-')), false);
});

test('HTTP lookups and transfers have wall-clock deadlines even before a socket becomes ready', async (t) => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = mockHttp(t, () => null);
  const context = cliConfig.createCliContext(f.bot);
  const lookup = releases.fetchLatestRelease(context.project.definition.releases, context.project.definition, false, {});
  const lookupRejected = assert.rejects(lookup, /Timed out/);
  t.mock.timers.tick(15_000);
  await lookupRejected;
  const download = releases.downloadHttpsUpdateArchive(
    { type: 'https', url: 'https://downloads.example.test/current.tgz' },
    path.join(f.root, 'archive.tgz'), {}
  );
  const downloadRejected = assert.rejects(download, /Timed out/);
  t.mock.timers.tick(60_000);
  await downloadRejected;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.signal.aborted, true);
});

test('private GitHub custom tokens, HTTP errors and transport errors never expose credential values', async (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot);
  const source = { ...context.project.definition.releases, tokenEnv: 'BOT_RELEASE_TOKEN' };
  const secret = 'fixture-private-release-token';
  let response = { body: JSON.stringify([release(context.project.definition, '1.2.4')]) };
  const calls = mockHttp(t, () => response);
  const latest = await releases.fetchLatestRelease(source, context.project.definition, false, { BOT_RELEASE_TOKEN: secret });
  assert.equal(latest.version, '1.2.4');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${secret}`);
  for (const statusCode of [401, 403, 404, 500]) {
    response = { statusCode, body: secret };
    await assert.rejects(
      releases.fetchLatestRelease(source, context.project.definition, false, { BOT_RELEASE_TOKEN: secret }),
      (error) => {
        assert.equal(error.message.includes(secret), false);
        assert.match(error.message, /GitHub/);
        return true;
      }
    );
  }
  response = { error: new Error(`request failed with Authorization: Bearer ${secret}`) };
  await assert.rejects(
    releases.fetchLatestRelease(source, context.project.definition, false, { BOT_RELEASE_TOKEN: secret }),
    (error) => !error.message.includes(secret) && /GitHub releases API/.test(error.message)
  );
  await assert.rejects(
    releases.downloadHttpsUpdateArchive(
      { type: 'https', url: 'https://downloads.example.test/current.tgz', tokenEnv: 'BOT_RELEASE_TOKEN' },
      path.join(f.root, 'archive.tgz'), { BOT_RELEASE_TOKEN: secret }
    ),
    (error) => !error.message.includes(secret) && /download failed/.test(error.message)
  );
  const selected = releases.selectRelease(context.project.definition, [
    release(context.project.definition, '1.2.4', { html_url: `https://user:${secret}@untrusted.example.test/` }),
  ], false);
  assert.equal(selected.htmlUrl, 'https://github.com/example/sound-bot/releases/tag/v1.2.4');
});

test('npm failure output is captured and never exposes credentials or restarts the existing bot', async (t) => {
  const f = archiveFixture(t, 'file');
  createTarball(f.file, botManifest());
  const context = cliConfig.createCliContext(f.bot);
  const secret = 'fixture-npm-output-token';
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(pm2, 'findProcess', () => ({ pm2_env: { status: 'online' } }));
  t.mock.method(pm2, 'startOrRestart', () => assert.fail('must not restart'));
  t.mock.method(toolingProcess, 'runNpm', (args, options) => {
    if (args[0] === 'root') return f.globalRoot;
    assert.equal(options.stdio, 'pipe');
    throw new Error(`npm install failed (1).\nfixture-output ${secret}`);
  });
  await assert.rejects(updates.updateCommand(context, ['--yes']), (error) => {
    output.push(error.message);
    return /offline npm installation failed/.test(error.message);
  });
  assert.equal(output.join('\n').includes(secret), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.bot, 'package.json'))).version, '1.2.3');
});

test('scheduled updates reload the author source and invoke the same source-resolving update command', async (t) => {
  const f = archiveFixture(t, 'file');
  createTarball(f.file, botManifest());
  const context = cliConfig.createCliContext(f.bot);
  const required = t.mock.method(pm2, 'requirePm2', () => {});
  const started = t.mock.method(pm2, 'startOrRestart', () => {});
  t.mock.method(pm2, 'saveProcessList', () => {});
  await updates.autoUpdateCommand(context, ['on', '03:45']);
  assert.equal(required.mock.callCount(), 1);
  assert.equal(started.mock.callCount(), 1);
  const settings = {
    packageRoot: f.bot, updateCwd: f.root,
    updateArgs: [...context.cliInvocation.args, 'update', '--yes'],
    schedule: '03:45', includeBeta: false,
  };
  const commands = [];
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    commands.push({ command, args, options, source: sources.configuredUpdateSource(cliConfig.createCliContext(f.bot).project) });
    return { status: 0 };
  });
  updater.runAutoUpdateOnce(settings, { BOT_UPDATE_TOKEN: 'fixture-env-token' });
  const pkg = JSON.parse(fs.readFileSync(path.join(f.bot, 'package.json'), 'utf8'));
  pkg.monkyBot.updateSource = { type: 'https', url: 'https://downloads.example.test/current.tgz', tokenEnv: 'BOT_UPDATE_TOKEN' };
  pkg.version = '1.2.4-beta.1';
  json(path.join(f.bot, 'package.json'), pkg);
  updater.runAutoUpdateOnce(settings, { BOT_UPDATE_TOKEN: 'fixture-env-token' });
  assert.equal(commands[0].source.type, 'file');
  assert.equal(commands[1].source.type, 'https');
  assert.deepEqual(commands[0].args, settings.updateArgs);
  assert.deepEqual(commands[1].args, [...settings.updateArgs, '--beta']);
  assert.ok(commands.every((call) => call.command === process.execPath && call.options.shell === false));
  assert.ok(commands.every((call) => call.options.env.BOT_UPDATE_TOKEN === 'fixture-env-token'));
  assert.ok(commands.every((call) => !call.args.join(' ').includes('fixture-env-token')));
  assert.equal(fs.readFileSync(context.updaterEcosystemFile, 'utf8').includes('fixture-env-token'), false);
});

test('an invalid scheduler source or failed updater process cannot fall back or leak failure details', (t) => {
  const f = archiveFixture(t, 'file');
  const settings = {
    packageRoot: f.bot, updateCwd: f.root, updateArgs: ['fixture.cjs', 'update', '--yes'],
    schedule: '04:00', includeBeta: false,
  };
  const secret = 'fixture-spawn-private-token';
  t.mock.method(childProcess, 'spawnSync', () => ({ error: new Error(secret), status: null }));
  assert.throws(() => updater.runAutoUpdateOnce(settings), (error) =>
    !error.message.includes(secret) && /Could not start/.test(error.message));
  t.mock.method(childProcess, 'spawnSync', () => { throw new Error(secret); });
  assert.throws(() => updater.runAutoUpdateOnce(settings), (error) =>
    !error.message.includes(secret) && /Could not start/.test(error.message));
  t.mock.method(childProcess, 'spawnSync', () => ({ status: 1 }));
  assert.throws(() => updater.runAutoUpdateOnce(settings), /failed with status 1/);
  const pkg = JSON.parse(fs.readFileSync(path.join(f.bot, 'package.json'), 'utf8'));
  pkg.monkyBot.updateSource = { type: 'npm', package: '@example/sound-bot' };
  json(path.join(f.bot, 'package.json'), pkg);
  const spawn = t.mock.method(childProcess, 'spawnSync', () => assert.fail('must not spawn'));
  assert.throws(() => updater.runAutoUpdateOnce(settings), /Unsupported.*updateSource/);
  assert.equal(spawn.mock.callCount(), 0);
});

test('operator update-source overrides are unsupported and never echo embedded credentials', async (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot);
  const secret = 'fixture-unsupported-argument-secret';
  const option = `--source=https://user:${secret}@downloads.example.test/bot.tgz`;
  const safeError = (error) => /Unknown/.test(error.message) && !error.message.includes(secret);
  await assert.rejects(updates.updateCommand(context, [option]), safeError);
  await assert.rejects(updates.autoUpdateCommand(context, ['on', option]), safeError);
  await assert.rejects(updates.autoUpdateCommand(context, [option]), safeError);
});

for (const kind of ['config home', 'runtime profile and keys', 'symlinked runtime data']) {
  test(`update preserves ${kind} inside an installed package by refusing unsafe replacement`, async (t) => {
    const insideHome = kind === 'config home';
    const f = archiveFixture(t, 'file', '1.2.3', { homeInPackage: insideHome });
    const context = cliConfig.createCliContext(f.bot);
    createTarball(f.file, botManifest());
    let botDir = insideHome ? context.homeDir : path.join(f.bot, 'runtime');
    if (kind === 'symlinked runtime data') {
      fs.mkdirSync(botDir);
      const link = path.join(f.root, 'runtime-link');
      fs.symlinkSync(botDir, link, process.platform === 'win32' ? 'junction' : 'dir');
      botDir = link;
    }
    const config = cliConfig.manualConfig(context, {
      botName: 'Existing Bot',
      botDir,
      serverUrl: 'wss://server.example.test',
      tokenEnv: 'BOT_TOKEN',
    });
    cliConfig.writeConfig(context, config);
    const keys = path.join(config.botDir, '.keys', 'registration.json');
    json(keys, { privateKey: 'fixture-persistent-key' });
    const configBefore = fs.readFileSync(context.configFile);
    const keysBefore = fs.readFileSync(keys);
    const npm = t.mock.method(toolingProcess, 'runNpm', (args) => {
      assert.deepEqual(args, ['root', '--global']);
      return f.globalRoot;
    });
    t.mock.method(pm2, 'findProcess', () => assert.fail('must not invoke PM2'));
    await updates.updateCommand(context, ['--check']);
    assert.equal(npm.mock.callCount(), 0);
    await assert.rejects(updates.updateCommand(context, ['--yes']), /outside the package.*profile and keys/);
    assert.equal(npm.mock.callCount(), 1);
    assert.deepEqual(fs.readFileSync(context.configFile), configBefore);
    assert.deepEqual(fs.readFileSync(keys), keysBefore);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.bot, 'package.json'))).version, '1.2.3');
  });
}
