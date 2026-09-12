const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { loadBotProject, isBotVersion, releaseAssetName, botEntryPath } = require('../dist/tooling/config');
const { buildBotPackage, parseBuildArguments } = require('../dist/tooling/build');
const { bundleDependencies } = require('../dist/tooling/bundle');
const { runNpm } = require('../dist/tooling/process');

function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(__dirname, '.monky-sdk-tooling-'));
  t.mock.method(os, 'tmpdir', () => root);
  const source = path.join(root, 'bot with spaces');
  const output = path.join(root, 'package');
  fs.mkdirSync(source);
  fs.mkdirSync(output);
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { root, source, output };
}

function moduleAt(directory, name, version, extra = {}, code = `module.exports = ${JSON.stringify(version)};`) {
  json(path.join(directory, 'package.json'), { name, version, main: 'index.js', ...extra });
  fs.writeFileSync(path.join(directory, 'index.js'), code);
}

function botAt(directory, extra = {}) {
  json(path.join(directory, 'package.json'), {
    name: '@fixture/sound-bot', version: '1.2.3', type: 'module',
    dependencies: { '@monky/bot-sdk': '*' },
    monkyBot: { cliName: 'sound-bot', displayName: 'Sound Bot', entry: 'dist/index.js' },
    ...extra,
  });
  fs.mkdirSync(path.join(directory, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'dist', 'index.js'), 'console.log("bot runtime");');
  const sdk = path.join(directory, 'node_modules', '@monky', 'bot-sdk');
  json(path.join(sdk, 'package.json'), {
    name: '@monky/bot-sdk', version: '1.0.0', main: 'dist/index.js',
    scripts: { postinstall: 'should never run while installing the release' },
  });
  fs.mkdirSync(path.join(sdk, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'dist', 'index.js'), `
exports.PROTOCOL_VERSION = 13;
exports.runBotCli = async (root, args) => {
  const pkg = JSON.parse(require('node:fs').readFileSync(require('node:path').join(root, 'package.json'), 'utf8'));
  console.log(pkg.monkyBot.cliName + ' ' + pkg.version);
};`);
}

test('project metadata defaults are portable and do not infer update configuration from repository', (t) => {
  const f = fixture(t);
  json(path.join(f.source, 'package.json'), {
    name: '@example/sound-bot', version: '1.2.3',
    main: 'dist/main/index.js', repository: 'https://github.com/example/sound-bot',
  });
  const project = loadBotProject(f.source);
  assert.equal(project.definition.cliName, 'sound-bot');
  assert.equal(project.definition.releases, undefined);
  assert.equal(project.definition.updateSource, undefined);
  assert.deepEqual(project.definition.modes, ['manual']);
  assert.deepEqual(project.definition.files, ['dist']);
});

test('release sources are explicit GitHub-only URLs with optional asset and environment-token metadata', (t) => {
  const f = fixture(t);
  botAt(f.source, { monkyBot: {
    cliName: 'sound-bot', displayName: 'Sound Bot',
    releases: { url: 'https://github.com/example/sound-bot/releases', assetName: 'sound-{version}.tgz', tokenEnv: 'BOT_RELEASE_TOKEN' },
  } });
  const { definition } = loadBotProject(f.source);
  assert.equal(definition.releases.repository, 'example/sound-bot');
  assert.equal(definition.releases.tokenEnv, 'BOT_RELEASE_TOKEN');
  assert.equal(releaseAssetName(definition, '2.0.0-beta.3'), 'sound-2.0.0-beta.3.tgz');
  for (const releases of [
    { url: 'https://example.org/releases' },
    { url: 'http://github.com/example/sound-bot/releases' },
    { url: 'https://secret@github.com/example/sound-bot/releases' },
    { url: 'https://github.com/example/sound-bot/releases?token=secret' },
    { url: 'https://github.com/example/sound-bot/releases', token: 'must-not-be-embedded' },
    { url: 'https://github.com/example/sound-bot/releases', assetName: '../escape.tgz' },
  ]) {
    botAt(f.source, { monkyBot: { releases } });
    assert.throws(() => loadBotProject(f.source));
  }
});

test('HTTPS and file update sources are author metadata, explicit and mutually exclusive with releases', (t) => {
  const f = fixture(t);
  const sources = [
    { type: 'https', url: 'https://downloads.example.test/bots/sound-bot.tgz' },
    { type: 'https', url: 'https://downloads.example.test:8443/bot.tgz', tokenEnv: 'BOT_UPDATE_TOKEN' },
    { type: 'file', path: '../releases/sound-bot.tgz' },
    { type: 'file', path: path.join(f.root, 'release files', 'sound-bot.tgz') },
  ];
  for (const updateSource of sources) {
    botAt(f.source, { monkyBot: { updateSource } });
    const { definition } = loadBotProject(f.source);
    assert.deepEqual(definition.updateSource, updateSource);
    assert.equal(definition.releases, undefined);
    assert.equal(releaseAssetName(definition, '1.2.4'), 'sound-bot-1.2.4.tgz');
  }
  botAt(f.source, { monkyBot: {
    releases: { url: 'https://github.com/example/sound-bot/releases' },
    updateSource: sources[0],
  } });
  assert.throws(() => loadBotProject(f.source), /not both/);
});

test('update definitions reject malformed origins and credentials without exposing their values', (t) => {
  const f = fixture(t);
  const secret = 'fixture-update-credential';
  const malformed = [
    null, [], 'https://downloads.example.test/bot.tgz', {},
    { type: 'npm', name: 'sound-bot' },
    { type: 'github', url: 'https://github.com/example/sound-bot' },
    { type: 'https', url: 'http://downloads.example.test/bot.tgz' },
    { type: 'https', url: `https://${secret}@downloads.example.test/bot.tgz` },
    { type: 'https', url: `https://user:${secret}@downloads.example.test/bot.tgz` },
    { type: 'https', url: `https://downloads.example.test/bot.tgz?token=${secret}` },
    { type: 'https', url: `https://downloads.example.test/bot.tgz#${secret}` },
    { type: 'https', url: 'https://downloads.example.test/bot.zip' },
    { type: 'https', url: 'https://downloads.example.test/bot.tgz?' },
    { type: 'https', url: 'https://downloads.example.test/bot.tgz#' },
    { type: 'https', url: 'https://@downloads.example.test/bot.tgz' },
    { type: 'https', url: 'https:\\\\downloads.example.test\\bot.tgz' },
    { type: 'https', url: 'https://downloads.example.test/bot.tgz', token: secret },
    { type: 'https', url: 'https://downloads.example.test/bot.tgz', tokenEnv: secret },
    { type: 'https', url: 'https://downloads.example.test/bot.tgz', path: 'other.tgz' },
    { type: 'file', path: '' },
    { type: 'file', path: 'https://downloads.example.test/bot.tgz' },
    { type: 'file', path: 'file:///bot.tgz' },
    { type: 'file', path: '*.tgz' },
    { type: 'file', path: 'bot.zip' },
    { type: 'file', path: 'bot\u0000.tgz' },
    { type: 'file', path: 'C:bot.tgz' },
    { type: 'file', path: '\\\\server\\share\\bot.tgz' },
    { type: 'file', path: 'bot.tgz', tokenEnv: 'BOT_UPDATE_TOKEN' },
    { type: 'file', path: 'bot.tgz', url: 'https://downloads.example.test/bot.tgz' },
    { type: 'https', url: 'https://downloads.example.test/bot.tgz', [secret]: true },
  ];
  if (process.platform === 'win32') {
    malformed.push(
      { type: 'file', path: '/opt/releases/bot.tgz' },
      { type: 'file', path: '\\releases\\bot.tgz' },
      { type: 'file', path: 'C:\\releases\\NUL.tgz' },
      { type: 'file', path: 'C:\\releases\\name:stream.tgz' },
      { type: 'file', path: '\\\\?\\C:\\releases\\bot.tgz' }
    );
  } else {
    malformed.push({ type: 'file', path: 'C:\\releases\\bot.tgz' });
  }
  for (const updateSource of malformed) {
    botAt(f.source, { monkyBot: { updateSource } });
    assert.throws(() => loadBotProject(f.source), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test('configuration rejects traversing paths, typos and malformed semantic versions', (t) => {
  const f = fixture(t);
  for (const monkyBot of [
    { entry: '../outside.js' }, { files: ['.'] }, { files: ['dist/**/*.js'] },
    { release: { url: 'https://github.com/example/sound-bot' } }, { modes: ['unsupported'] },
  ]) {
    botAt(f.source, { monkyBot });
    assert.throws(() => loadBotProject(f.source));
  }
  for (const version of ['1.0', '01.2.3', '1.2.3-beta..1', '1.2.3-01', '999999999999999999.0.0']) {
    assert.equal(isBotVersion(version), false, version);
  }
  for (const version of ['1.2.3', '0.0.0-issue.632.1', '2.0.0-rc.1+build.4']) assert.equal(isBotVersion(version), true);
  assert.throws(() => parseBuildArguments(['--out']), /requires a value/);
  assert.throws(() => parseBuildArguments(['--unknown']), /Unknown build option/);
});

test('dependency bundling preserves per-requester versions, installed optional modules and safe cycles', (t) => {
  const f = fixture(t);
  json(path.join(f.source, 'package.json'), { dependencies: { first: '*', second: '*', alpha: '*' } });
  for (const [name, version] of [['first', '1.0.0'], ['second', '2.0.0']]) {
    const directory = path.join(f.source, 'node_modules', name);
    moduleAt(directory, name, '1.0.0', { dependencies: { leaf: '*' } }, 'module.exports = require("leaf");');
    moduleAt(path.join(directory, 'node_modules', 'leaf'), 'leaf', version);
  }
  moduleAt(path.join(f.source, 'node_modules', 'leaf'), 'leaf', '9.0.0');
  moduleAt(path.join(f.source, 'node_modules', 'alpha'), 'alpha', '1.0.0', { dependencies: { beta: '*' } });
  moduleAt(path.join(f.source, 'node_modules', 'beta'), 'beta', '1.0.0', { dependencies: { alpha: '*' } });
  const result = bundleDependencies(f.source, f.output);
  assert.equal(result.packageCount, 6);
  const from = (name) => createRequire(path.join(f.output, 'node_modules', name, 'package.json'));
  assert.equal(from('first')('./index.js'), '1.0.0');
  assert.equal(from('second')('./index.js'), '2.0.0');
  assert.equal(createRequire(path.join(f.output, 'node_modules', 'alpha', 'node_modules', 'beta', 'package.json'))('alpha'), '1.0.0');
});

test('workspace dependencies resolve from their real workspace, not a different caller copy', (t) => {
  const f = fixture(t);
  const workspace = path.join(f.root, 'workspace');
  const sdk = path.join(workspace, 'packages', 'sdk');
  json(path.join(sdk, 'package.json'), { name: '@monky/bot-sdk', version: '1.0.0', main: 'dist/index.js', dependencies: { leaf: '*' } });
  fs.mkdirSync(path.join(sdk, 'dist'));
  fs.writeFileSync(path.join(sdk, 'dist', 'index.js'), 'module.exports = require("leaf");');
  moduleAt(path.join(workspace, 'node_modules', 'leaf'), 'leaf', '2.0.0');
  moduleAt(path.join(f.source, 'node_modules', 'leaf'), 'leaf', '9.0.0');
  json(path.join(f.source, 'package.json'), { dependencies: { '@monky/bot-sdk': '*' } });
  fs.mkdirSync(path.join(f.source, 'node_modules', '@monky'), { recursive: true });
  fs.symlinkSync(sdk, path.join(f.source, 'node_modules', '@monky', 'bot-sdk'), process.platform === 'win32' ? 'junction' : 'dir');
  bundleDependencies(f.source, f.output);
  const installed = createRequire(path.join(f.output, 'node_modules', '@monky', 'bot-sdk', 'package.json'));
  assert.equal(installed('./dist/index.js'), '2.0.0');
});

test('only optional missing dependencies may be omitted', (t) => {
  const f = fixture(t);
  json(path.join(f.source, 'package.json'), { dependencies: { missing: '*' } });
  assert.throws(() => bundleDependencies(f.source, f.output), /Missing required dependency/);
  json(path.join(f.source, 'package.json'), { optionalDependencies: { missing: '*' } });
  assert.deepEqual(bundleDependencies(f.source, f.output), { dependencies: {}, packageCount: 0 });
  json(path.join(f.source, 'package.json'), { peerDependencies: { peer: '*' } });
  assert.throws(() => bundleDependencies(f.source, f.output), /Missing required dependency/);
});

test('build compiles the bot and emits an offline-installable ESM package with a generated CJS CLI', (t) => {
  const f = fixture(t);
  botAt(f.source, {
    scripts: { build: 'node compile.cjs' },
    monkyBot: { cliName: 'sound-bot', displayName: 'Sound Bot', entry: 'dist/index.js', files: ['dist', 'assets'] },
  });
  fs.mkdirSync(path.join(f.source, 'assets'));
  fs.writeFileSync(path.join(f.source, 'assets', 'catalog.json'), '{"ok":true}');
  fs.writeFileSync(path.join(f.source, 'compile.cjs'),
    'require("node:fs").writeFileSync("dist/index.js", "console.log(123)");');
  fs.writeFileSync(path.join(f.source, '.env'), 'ACTUAL_SECRET=must-not-be-in-the-archive');
  json(path.join(f.source, '.keys', 'registrations.json'), { token: 'must-not-be-in-the-archive' });
  const result = buildBotPackage({ root: f.source, out: f.output, version: '2.0.0-beta.1' });
  assert.equal(result.cliName, 'sound-bot');
  assert.equal(result.protocolVersion, 13);
  assert.equal(path.basename(result.file), 'sound-bot-2.0.0-beta.1.tgz');

  const install = path.join(f.root, 'isolated install');
  runNpm(['install', '--prefix', install, '--cache', path.join(f.root, 'empty cache'), '--offline',
    '--ignore-scripts', '--no-audit', '--no-fund', result.file], { cwd: f.root });
  const packageRoot = path.join(install, 'node_modules', '@fixture', 'sound-bot');
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json')));
  assert.deepEqual(pkg.bin, { 'sound-bot': './monky-cli.cjs' });
  assert.equal(pkg.scripts, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.dependencies['@monky/bot-sdk'], '1.0.0');
  assert.equal(pkg.monkyBot.buildScript, false);
  assert.equal(fs.existsSync(path.join(packageRoot, '.env')), false);
  assert.equal(fs.existsSync(path.join(packageRoot, '.keys')), false);
  assert.equal(fs.existsSync(path.join(packageRoot, 'assets', 'catalog.json')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(packageRoot, 'node_modules', '@monky', 'bot-sdk', 'package.json'))).scripts, undefined);
  const cli = spawnSync(process.execPath, ['--no-global-search-paths', path.join(packageRoot, 'monky-cli.cjs'), '--version'], {
    cwd: install, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), 'sound-bot 2.0.0-beta.1');
  assert.equal(botEntryPath(loadBotProject(packageRoot)), path.join(packageRoot, 'dist', 'index.js'));
});

test('private files inside a runtime directory, compiler recursion and incompatible SDKs fail explicitly', (t) => {
  const f = fixture(t);
  botAt(f.source);
  fs.writeFileSync(path.join(f.source, 'dist', '.env'), 'SECRET=not-for-releases');
  assert.throws(() => buildBotPackage({ root: f.source, out: f.output }), /private runtime data/);
  fs.unlinkSync(path.join(f.source, 'dist', '.env'));
  fs.writeFileSync(path.join(f.source, 'dist', '.npmrc'), '//registry.example/:_authToken=not-for-releases');
  assert.throws(() => buildBotPackage({ root: f.source, out: f.output }), /private runtime data/);
  fs.unlinkSync(path.join(f.source, 'dist', '.npmrc'));
  botAt(f.source, { scripts: { build: 'monky-bot-sdk build' } });
  assert.throws(() => buildBotPackage({ root: f.source, out: f.output }), /recursively/);
  botAt(f.source);
  const entry = path.join(f.source, 'node_modules', '@monky', 'bot-sdk', 'dist', 'index.js');
  delete require.cache[require.resolve(entry)];
  fs.writeFileSync(entry, 'exports.PROTOCOL_VERSION = 13;');
  assert.throws(() => buildBotPackage({ root: f.source, out: f.output }), /reusable CLI/);
});

test('packaged bots retain the author update source for GitHub, HTTPS and local archives', (t) => {
  const f = fixture(t);
  const declarations = [
    { releases: { url: 'https://github.com/example/sound-bot/releases', assetName: 'sound-{version}.tgz', tokenEnv: 'BOT_RELEASE_TOKEN' } },
    { updateSource: { type: 'https', url: 'https://downloads.example.test/sound-bot.tgz', tokenEnv: 'BOT_UPDATE_TOKEN' } },
    { updateSource: { type: 'file', path: '../bot-updates/sound-bot.tgz' } },
  ];
  for (const [index, declaration] of declarations.entries()) {
    botAt(f.source, { monkyBot: { cliName: 'sound-bot', displayName: 'Sound Bot', ...declaration } });
    const result = buildBotPackage({ root: f.source, out: f.output, skipBuild: true });
    const unpacked = path.join(f.root, `source-${index}`);
    fs.mkdirSync(unpacked);
    require('tar').x({ file: result.file, cwd: unpacked, sync: true });
    const packageRoot = path.join(unpacked, 'package');
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.monkyBot.releases, declaration.releases);
    assert.deepEqual(pkg.monkyBot.updateSource, declaration.updateSource);
    const installed = loadBotProject(packageRoot);
    assert.deepEqual(installed.definition.updateSource, declaration.updateSource);
    assert.equal(installed.definition.releases?.repository, declaration.releases ? 'example/sound-bot' : undefined);
  }
});
