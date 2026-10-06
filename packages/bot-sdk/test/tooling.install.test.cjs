const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  parseInstallArguments, selectReleaseAsset, verifyArchive, inspectInstallPrefix,
  configureUnixPath, shellPathBlock, runSdkInstaller,
} = require('../dist/tooling/install');
const { runNpm } = require('../dist/tooling/process');

const sha = data => createHash('sha256').update(data).digest('hex');
const repository = path.resolve(__dirname, '..', '..', '..');
const publicDirectory = path.join(repository, 'docs-site', 'public');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(__dirname, '.sdk-install-'));
  const previous = {};
  for (const [key, value] of Object.entries({
    npm_config_offline: 'true', MONKY_BOT_SDK_HOME: path.join(root, 'sdk-profile'), CI: '1',
  })) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.mock.method(console, 'log', () => {});
  const spawn = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.ok(!args.some(argument => String(argument).includes("GetEnvironmentVariable('Path'")),
      'Installer tests must never persist a real Windows PATH');
    return spawn(command, args, options);
  });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return root;
}

function release(version, prerelease = false) {
  return {
    tag_name: `v${version}`, draft: false, prerelease, published_at: '2026-01-01T00:00:00Z',
    assets: [{ name: `monky-bot-sdk-${version}.tgz`, size: 3, digest: `sha256:${sha(Buffer.from('sdk'))}` }],
  };
}

function packageSdk(root, version, failWhenActive = false) {
  const source = path.join(root, `source-${version}`);
  fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
  const info = {
    name: '@monky/bot-sdk', version, authoringVersion: 1, protocolVersion: 21,
    generators: ['command', 'form', 'selector', 'settings', 'screen'], locales: ['pt-BR', 'en-US'],
  };
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
    name: '@monky/bot-sdk', version, bin: { 'monky-bot-sdk': 'dist/tools.js' },
    scripts: { postinstall: 'node dist/postinstall.js' },
  }));
  fs.writeFileSync(path.join(source, 'dist', 'tools.js'), `#!/usr/bin/env node
const info = ${JSON.stringify(info)};
if (${failWhenActive} && __dirname.split(require('node:path').sep).includes('current')) info.version = '0.0.0';
console.log(JSON.stringify(info));
`);
  fs.writeFileSync(path.join(source, 'dist', 'postinstall.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'unwanted-script'))}, 'must not run');`);
  runNpm(['pack', '--ignore-scripts', '--silent', '--pack-destination', root], { cwd: source });
  const file = path.join(root, `monky-bot-sdk-${version}.tgz`);
  return ['--file', file, '--sha256', sha(fs.readFileSync(file))];
}

function installedManifest(prefix) {
  return path.join(prefix, 'current', ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', '@monky', 'bot-sdk', 'package.json');
}

test('installer selects stable unless beta/version is explicit and validates input before doing work', () => {
  assert.equal(parseInstallArguments([]).beta, false);
  assert.equal(parseInstallArguments(['--beta']).beta, true);
  assert.equal(parseInstallArguments(['--no-path']).addToPath, false);
  assert.equal(parseInstallArguments(['--version', 'v23.1.0-beta', '--locale', 'en-US']).version, '23.1.0-beta');
  assert.equal(parseInstallArguments(['--locale', 'pt-br']).locale, 'pt-BR');
  for (const args of [
    ['--version'], ['--version', '../escape'], ['--prefix', '--beta'], ['--wat'], ['--beta', '--beta'],
    ['--locale', 'fr'], ['--file', 'sdk.tgz'], ['--sha256', 'a'.repeat(64)],
    ['--file', 'sdk.tgz', '--sha256', 'a'.repeat(64), '--beta'],
    ['--file', 'sdk.tgz', '--sha256', 'a'.repeat(64), '--version', '1.0.0'],
    ['--file', 'sdk.tgz', '--sha256', 'nope'], ['--prefix', 'bad\npath'],
  ]) assert.throws(() => parseInstallArguments(args), args.join(' '));
});

test('release discovery checks the exact SDK asset, publication, channel, size and GitHub digest', () => {
  const stable = release('23.1.0');
  const beta = { ...release('23.2.0-beta', true), published_at: '2026-02-01T00:00:00Z' };
  const draft = { ...release('99.0.0'), draft: true, published_at: '2026-03-01T00:00:00Z' };
  const asset = selectReleaseAsset([beta, stable, draft], false, 'en-US');
  assert.equal(asset.version, '23.1.0');
  assert.equal(asset.url, 'https://github.com/MonkyOrg/Monky/releases/download/v23.1.0/monky-bot-sdk-23.1.0.tgz');
  assert.equal(selectReleaseAsset([stable, draft, beta], true, 'en-US').version, '23.2.0-beta');
  for (const value of [
    { ...stable, assets: [] }, { ...stable, draft: true }, { ...stable, tag_name: '../../bad' },
    { ...stable, assets: [{ ...stable.assets[0], digest: undefined }] },
    { ...stable, assets: [{ ...stable.assets[0], size: 64 * 1024 * 1024 + 1 }] },
    { ...stable, assets: [{ ...stable.assets[0], digest: 'sha1:abc' }] },
  ]) assert.throws(() => selectReleaseAsset(value, false, 'en-US'));
  assert.throws(() => selectReleaseAsset(beta, false, 'en-US'));
});

test('archive corruption and unsafe prefixes are rejected without modifying an existing directory', t => {
  const root = fixture(t), data = Buffer.from('sdk');
  verifyArchive(data, sha(data), data.length);
  assert.throws(() => verifyArchive(data, 'a'.repeat(64)), /SHA-256/);
  assert.throws(() => verifyArchive(data, sha(data), data.length + 1), /size|tamanho/);
  assert.throws(() => verifyArchive(Buffer.alloc(0), sha(Buffer.alloc(0))));
  fs.writeFileSync(path.join(root, 'sentinel'), 'preserve');
  assert.throws(() => inspectInstallPrefix(root));
  assert.throws(() => inspectInstallPrefix(os.homedir()));
  assert.throws(() => inspectInstallPrefix(path.parse(root).root));
  assert.equal(fs.readFileSync(path.join(root, 'sentinel'), 'utf8'), 'preserve');
  assert.deepEqual(fs.readdirSync(root), ['sentinel']);
});

test('Unix PATH setup preserves existing profiles, is idempotent and does not shadow .profile with a new .bash_profile', t => {
  const root = fixture(t), bin = "/opt/Monky's SDK/current/bin";
  fs.writeFileSync(path.join(root, '.bashrc'), 'export EXISTING=yes\n');
  fs.writeFileSync(path.join(root, '.profile'), 'export LOGIN=yes\n');
  assert.equal(configureUnixPath(bin, root, '/bin/bash').length, 2);
  const rc = fs.readFileSync(path.join(root, '.bashrc'), 'utf8');
  assert.ok(rc.startsWith('export EXISTING=yes\n'));
  assert.equal(configureUnixPath(bin, root, '/bin/bash').length, 0);
  assert.equal(fs.readFileSync(path.join(root, '.bashrc'), 'utf8'), rc);
  assert.equal(fs.existsSync(path.join(root, '.bash_profile')), false);
  assert.equal(configureUnixPath(bin, root, '/bin/zsh').length, 1);
  assert.throws(() => configureUnixPath(bin, root, '/bin/fish'), /--no-path/);
  assert.ok(shellPathBlock(bin).includes("'\\''"));
});

test('Unix PATH setup rolls back a partial profile change on write failure', t => {
  const root = fixture(t), append = fs.appendFileSync;
  fs.writeFileSync(path.join(root, '.bashrc'), 'keep bash\n');
  fs.writeFileSync(path.join(root, '.profile'), 'keep login\n');
  t.mock.method(fs, 'appendFileSync', (file, ...args) => {
    if (file === path.join(root, '.profile')) throw new Error('fixture profile denied');
    return append(file, ...args);
  });
  assert.throws(() => configureUnixPath('/opt/monky/bin', root, '/bin/bash'), /profile denied/);
  assert.equal(fs.readFileSync(path.join(root, '.bashrc'), 'utf8'), 'keep bash\n');
  assert.equal(fs.readFileSync(path.join(root, '.profile'), 'utf8'), 'keep login\n');
});

test('installer verifies real launchers, disables npm lifecycle scripts, updates atomically and restores a failed activation', async t => {
  const root = fixture(t);
  const prefix = path.join(root, 'SDK with spaces & characters');
  const args = ['--prefix', prefix, '--no-path', '--locale', 'en-US'];
  await runSdkInstaller([...args, ...packageSdk(root, '1.0.0')]);
  assert.equal(JSON.parse(fs.readFileSync(installedManifest(prefix))).version, '1.0.0');
  await runSdkInstaller([...args, ...packageSdk(root, '1.0.1')]);
  assert.equal(JSON.parse(fs.readFileSync(installedManifest(prefix))).version, '1.0.1');
  await assert.rejects(runSdkInstaller([...args, ...packageSdk(root, '1.0.2', true)]), /verification failed/);
  assert.equal(JSON.parse(fs.readFileSync(installedManifest(prefix))).version, '1.0.1');
  assert.deepEqual(fs.readdirSync(prefix).sort(), ['.monky-bot-sdk-install.json', 'current']);
  assert.equal(fs.existsSync(path.join(root, 'unwanted-script')), false);
  assert.equal(fs.existsSync(process.env.MONKY_BOT_SDK_HOME), false);
});

test('download corruption and redirects outside HTTPS GitHub hosts are rejected before an install is created', async t => {
  const root = fixture(t), prefix = path.join(root, 'sdk');
  const stable = release('23.1.0');
  const requests = [];
  t.mock.method(global, 'fetch', async (address, options) => {
    requests.push(String(address));
    assert.equal(options.headers.Authorization, undefined);
    return String(address).includes('api.github.com')
      ? new Response(JSON.stringify(stable), { status: 200 })
      : new Response('bad', { status: 200 });
  });
  await assert.rejects(runSdkInstaller(['--prefix', prefix, '--no-path']), /SHA-256/);
  assert.ok(requests[0].endsWith('/latest'));
  assert.equal(fs.existsSync(prefix), false);
  t.mock.method(global, 'fetch', async () => new Response('', { status: 302, headers: { location: 'http://example.test/sdk.tgz' } }));
  await assert.rejects(runSdkInstaller(['--prefix', prefix, '--no-path']), /HTTPS/);
  assert.equal(fs.existsSync(prefix), false);
});

test('bootstrappers verify their digest and preserve arguments with spaces without installing or changing profiles', t => {
  const root = fixture(t);
  const bootstrap = path.join(root, 'bootstrap with spaces.cjs');
  fs.writeFileSync(bootstrap, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const digest = sha(fs.readFileSync(bootstrap));
  const runners = process.platform === 'win32'
    ? [[path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(publicDirectory, 'install-bot-sdk.ps1')]]]
    : [];
  const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
  if (fs.existsSync(bash)) runners.push([bash, [path.join(publicDirectory, 'install-bot-sdk.sh')]]);
  assert.ok(runners.length, 'A supported shell must be available to exercise its bootstrap');
  for (const [command, base] of runners) {
    const result = childProcess.spawnSync(command, [...base, '--bootstrap-file', bootstrap, '--bootstrap-sha256', digest,
      '--prefix', path.join(root, 'with spaces & punctuation'), '--no-path', '--locale', 'en-US'],
    { encoding: 'utf8', shell: false, windowsHide: true, timeout: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), ['--prefix', path.join(root, 'with spaces & punctuation'), '--no-path', '--locale', 'en-US']);
    const bad = childProcess.spawnSync(command, [...base, '--bootstrap-file', bootstrap, '--bootstrap-sha256', 'a'.repeat(64), '--locale', 'en-US'],
      { encoding: 'utf8', shell: false, windowsHide: true, timeout: 20_000 });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout + bad.stderr, /SHA-256 mismatch/);
    assert.doesNotMatch(bad.stdout, /^\[/);
  }
});
