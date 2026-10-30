const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { stripVTControlCharacters } = require('node:util');
const { PROTOCOL_VERSION } = require('@monky/shared');
const { SqlJsDriver } = require('../dist/infrastructure/database/SqliteWrapper');
const { DatabaseConnection } = require('../dist/infrastructure/database/DatabaseConnection');
const processHelpers = require('../dist/cli/process');
const pm2 = require('../dist/cli/pm2');
const prompts = require('../dist/cli/prompts');
const registry = require('../dist/cli/registry');
const targets = require('../dist/cli/target');
const onlineUsers = require('../dist/cli/onlineUsers');
const lifecycle = require('../dist/cli/commands/serverLifecycle');
const update = require('../dist/cli/commands/update');
const safety = require('../dist/cli/updateSafety');
const autoUpdate = require('../dist/cli/autoUpdate');
const { setConfigCommand } = require('../dist/cli/commands/config');
const { getCliLanguage, setCliLanguage, t: translate } = require('../dist/cli/i18n');

const previous = '17.0.3-beta';
const next = '18.0.0-beta';

function artifactFor(version) {
  const bytes = Buffer.from(`synthetic CLI archive ${version}`);
  return {
    bytes,
    artifact: {
      version, name: `monky-cli-${version}.tgz`,
      url: `https://github.com/MonkyOrg/Monky/releases/download/v${version}/monky-cli-${version}.tgz`,
      size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
  };
}

function releaseJson(version) {
  const { artifact } = artifactFor(version);
  return {
    tag_name: `v${version}`, html_url: `https://github.com/MonkyOrg/Monky/releases/tag/v${version}`, prerelease: true,
    assets: [{ name: artifact.name, browser_download_url: artifact.url, size: artifact.size, digest: artifact.digest }],
  };
}

/** A fake installed CLI: answers --version and simulates restart/start through a per-server state file. */
function stubSource(version, behavior, callsLog) {
  return `
    const fs = require('node:fs');
    const path = require('node:path');
    const behavior = ${JSON.stringify(behavior)};
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
      if (behavior.smokeFails) { console.error('Cannot find module mediasoup'); process.exit(1); }
      console.log('monky ' + ${JSON.stringify(version)});
      return;
    }
    const dataDir = args[args.indexOf('--data') + 1];
    const command = args[args.indexOf('--data') + 2];
    fs.appendFileSync(${JSON.stringify(callsLog)}, ${JSON.stringify(version)} + ' ' + command + ' ' + path.basename(dataDir) + '\\n');
    const stateFile = path.join(dataDir, 'fixture-state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const own = Object.assign({}, behavior, (behavior.perServer || {})[path.basename(dataDir)]);
    const outcome = (command === 'start' ? own.start : own.restart) || 'up';
    // The operator declined the voice warning: the old process keeps running.
    if (outcome === 'declined') return;
    if (command === 'restart' && own.copyOnRestart) {
      fs.copyFileSync(path.join(dataDir, own.copyOnRestart), path.join(dataDir, 'server.db'));
    }
    let port = state.port;
    if (command === 'restart' && own.movePortTo) {
      // A one-off --port does not survive a restart, which re-registers the real one.
      port = own.movePortTo;
      require(${JSON.stringify(path.resolve(__dirname, '../dist/cli/registry.js'))}).registerServer(dataDir, { port });
    }
    fs.writeFileSync(stateFile, JSON.stringify({ pid: state.pid + 1, status: 'online', up: outcome === 'up', startedAt: Date.now(), port }));
    process.exitCode = outcome === 'up' ? 0 : 1;
  `;
}

async function databaseWith(file, ledger, marker) {
  const driver = await SqlJsDriver.create(file);
  try {
    driver.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const version of ledger) driver.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(version, 1);
    driver.exec('CREATE TABLE marker (value TEXT)');
    driver.prepare('INSERT INTO marker VALUES (?)').run(marker);
  } finally {
    driver.close();
  }
}

async function readMarker(file) {
  const connection = await DatabaseConnection.create(file, { readOnly: true });
  try {
    return connection.getDb().prepare('SELECT value FROM marker').get().value;
  } finally {
    connection.close();
  }
}

function readState(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'fixture-state.json'), 'utf8'));
}

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-update-recovery-'));
  const profile = path.join(root, 'cli profile');
  const globalRoot = path.join(root, 'global prefix', 'node_modules');
  const packageDir = path.join(globalRoot, '@monky', 'server');
  const callsLog = path.join(root, 'calls.log');
  const local = options.local ?? previous;
  const remote = options.remote ?? next;
  const behaviors = { [previous]: {}, [next]: {}, ...options.behaviors };
  const previousHome = process.env.MONKY_HOME;
  const previousLanguage = getCliLanguage();
  const timing = { ...safety.updateTiming };
  process.env.MONKY_HOME = profile;
  setCliLanguage('en');
  Object.assign(safety.updateTiming, { startupMs: 400, failedRestartGraceMs: 150, pollMs: 20 });
  t.after(() => {
    Object.assign(safety.updateTiming, timing);
    setCliLanguage(previousLanguage);
    if (previousHome === undefined) delete process.env.MONKY_HOME;
    else process.env.MONKY_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const installPackage = (version) => {
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@monky/server', version, bin: { monky: 'cli.cjs' } }));
    fs.writeFileSync(path.join(packageDir, 'cli.cjs'), stubSource(version, behaviors[version] ?? {}, callsLog));
  };
  installPackage(local);

  const servers = [];
  for (const [index, spec] of (options.servers ?? [{ status: 'online' }]).entries()) {
    const dataDir = path.join(root, `server ${index + 1}`);
    fs.mkdirSync(dataDir, { recursive: true });
    await databaseWith(path.join(dataDir, 'server.db'), ['001_initial.sql'], 'original');
    await databaseWith(path.join(dataDir, 'migrated.db'), ['001_initial.sql', '999_next.sql'], 'migrated');
    await databaseWith(path.join(dataDir, 'final.db'), ['001_initial.sql'], 'final save');
    fs.writeFileSync(path.join(dataDir, 'fixture-state.json'), JSON.stringify({
      pid: 4242 + index * 100, status: spec.status, up: spec.status === 'online', startedAt: spec.startedAt ?? Date.now() - 60_000,
      port: 41000 + index,
    }));
    servers.push(registry.registerServer(dataDir, { name: `Server ${index + 1}`, port: 41000 + index }));
  }

  const output = [];
  const commands = [];
  const questions = [];
  t.mock.method(console, 'log', (...values) => output.push(stripVTControlCharacters(values.map(String).join(' '))));
  const read = fs.readFileSync.bind(fs);
  t.mock.method(fs, 'readFileSync', (filename, ...args) => {
    if (path.resolve(String(filename)) === path.resolve(__dirname, '../package.json')) return JSON.stringify({ version: local });
    return read(filename, ...args);
  });
  t.mock.method(prompts, 'confirm', async (question) => {
    questions.push(question);
    return options.confirm ? options.confirm(question) : true;
  });
  t.mock.method(pm2, 'isPm2Available', () => true);
  t.mock.method(pm2, 'listPm2Processes', () => []);
  t.mock.method(pm2, 'findLegacyProcessFor', () => null);
  t.mock.method(pm2, 'findPm2Process', (name) => {
    const server = servers.find((entry) => pm2.getPm2ProcessName(entry.dataDir) === name);
    if (!server) return null;
    const state = readState(server.dataDir);
    return { name, pid: state.pid, pm2_env: { status: state.status, pm_uptime: state.startedAt } };
  });
  t.mock.method(onlineUsers, 'readLocalServerPreview', async (port) => {
    const state = servers.map((entry) => readState(entry.dataDir)).find((candidate) => candidate.port === port);
    return state?.status === 'online' && state.up ? { userCount: 0, voiceUserCount: 0, botCompatibility: null } : null;
  });
  t.mock.method(https, 'get', (url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => request;
    queueMicrotask(() => {
      const byTag = String(url).includes('/releases/tags/');
      const available = !byTag || options.previousRelease !== false;
      const body = byTag ? releaseJson(decodeURIComponent(String(url).split('/releases/tags/v')[1])) : [releaseJson(remote)];
      const response = Readable.from([JSON.stringify(available ? body : { message: 'Not Found' })]);
      response.statusCode = available ? 200 : 404;
      callback(response);
    });
    return request;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    for (const version of [previous, next, remote, local]) {
      const { artifact, bytes } = artifactFor(version);
      if (String(url) === artifact.url) return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    }
    const version = /monky-compatibility-(.+)\.json$/.exec(String(url))?.[1];
    assert.ok(version, `Unexpected download: ${url}`);
    return new Response(JSON.stringify({ schemaVersion: 1, version, protocolVersion: PROTOCOL_VERSION, botSdkVersion: version }));
  });
  t.mock.method(processHelpers, 'runSync', (command, args, settings = {}) => {
    commands.push(`${command} ${args[0]}`);
    if (command === 'pm2') {
      assert.equal(args[0], 'stop', 'Only the rollback stops a process directly');
      const server = servers.find((entry) => pm2.getPm2ProcessName(entry.dataDir) === args[1]);
      assert.ok(server);
      fs.writeFileSync(path.join(server.dataDir, 'fixture-state.json'), JSON.stringify({ ...readState(server.dataDir), status: 'stopped', up: false }));
      return { status: 0, stdout: '', stderr: '' };
    }
    assert.equal(command, 'npm', 'No real package manager or process manager may run');
    if (args[0] === '-v') return { status: 0, stdout: '11.17.0\n' };
    if (args[0] === 'root') return { status: 0, stdout: `${globalRoot}\n` };
    assert.equal(args[0], 'install');
    const archive = read(path.join(settings.cwd, 'package.tgz'));
    const version = [previous, next, remote].find((candidate) => artifactFor(candidate).bytes.equals(archive));
    assert.ok(version, 'The verified archive is the one installed');
    installPackage(version);
    return { status: 0 };
  });
  const calls = () => (fs.existsSync(callsLog) ? read(callsLog, 'utf8').trim().split('\n').filter(Boolean) : []);
  const installedVersion = () => JSON.parse(read(path.join(packageDir, 'package.json'), 'utf8')).version;
  return { root, profile, servers, output, commands, questions, calls, installedVersion };
}

const run = (servers, args, dataDir) => update.updateCommand(
  dataDir ? { args: [], dataDir, dataDirSpecified: true } : { args: [], dataDir: process.cwd(), dataDirSpecified: false },
  args,
);

test('a release that cannot start on this host is uninstalled before any server restarts', async (t) => {
  const f = await fixture(t, { behaviors: { [next]: { smokeFails: true } } });
  await assert.rejects(run(f.servers, ['--beta', '--yes']), { message: translate('update.installRolledBack', { version: next, previous }) });
  assert.equal(f.installedVersion(), previous);
  assert.deepEqual(f.calls(), [], 'No server was restarted onto the broken package');
  assert.deepEqual(f.commands.filter((command) => command === 'npm install').length, 2);
});

test('the first server that does not come up is rolled back and its migrated database restored', async (t) => {
  const f = await fixture(t, { behaviors: { [next]: { restart: 'down', copyOnRestart: 'migrated.db' } } });
  const [server] = f.servers;
  await assert.rejects(run(f.servers, ['--beta', '--yes']), { message: translate('update.rolledBack', { version: next, previous }) });
  assert.deepEqual(f.calls(), [`${next} restart server 1`, `${previous} start server 1`]);
  assert.ok(f.commands.includes('pm2 stop'), 'The crash loop is stopped before the database is restored');
  assert.equal(f.installedVersion(), previous);
  assert.equal(await readMarker(path.join(server.dataDir, 'server.db')), 'original');
  const backups = fs.readdirSync(path.join(server.dataDir, 'backups'));
  assert.equal(backups.length, 1);
  assert.equal(await readMarker(path.join(server.dataDir, 'backups', backups[0])), 'original');
  assert.ok(f.output.some((line) => line.includes(translate('update.databaseRestored', { backup: path.join(server.dataDir, 'backups', backups[0]) }))));
});

test('a failed version that never migrated keeps the last save of the previous server', async (t) => {
  const f = await fixture(t, { behaviors: { [next]: { restart: 'down', copyOnRestart: 'final.db' } } });
  await assert.rejects(run(f.servers, ['--beta', '--yes']), { message: translate('update.rolledBack', { version: next, previous }) });
  assert.equal(await readMarker(path.join(f.servers[0].dataDir, 'server.db')), 'final save');
});

test('without a previous release to reinstall, the failure points at the database copy', async (t) => {
  const f = await fixture(t, { previousRelease: false, behaviors: { [next]: { restart: 'down' } } });
  const error = await run(f.servers, ['--beta', '--yes']).then(() => assert.fail('The update must fail'), (reason) => reason);
  assert.match(error.message, new RegExp(translate('update.previousReleaseUnavailable', { version: previous }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(error.message.includes(path.join(f.servers[0].dataDir, 'backups')));
});

test('forcing a reinstall is offered for the same version only and never downgrades', async (t) => {
  await t.test('older channel release', async (subtest) => {
    const f = await fixture(subtest, { local: '40.7.11-beta', remote: '40.7.7' });
    await run(f.servers, ['--beta']);
    assert.deepEqual(f.questions, []);
    assert.ok(f.output.includes(translate('update.noDowngrade', { local: '40.7.11-beta', remote: '40.7.7' })));
    assert.ok(!f.commands.includes('npm install'));
  });
  await t.test('same version', async (subtest) => {
    const f = await fixture(subtest, { local: previous, remote: previous, confirm: () => false });
    await run(f.servers, ['--beta']);
    assert.deepEqual(f.questions, [translate('update.forceReinstall')]);
    assert.ok(!f.commands.includes('npm install'));
  });
});

test('every running server is restarted onto the new version while stopped ones stay stopped', async (t) => {
  const f = await fixture(t, { servers: [{ status: 'online' }, { status: 'stopped' }, { status: 'online' }] });
  await run(f.servers, ['--beta', '--yes']);
  assert.deepEqual(f.calls(), [`${next} restart server 1`, `${next} restart server 3`]);
  assert.equal(readState(f.servers[1].dataDir).status, 'stopped');
  const backupsOf = (server) => fs.existsSync(path.join(server.dataDir, 'backups')) ? fs.readdirSync(path.join(server.dataDir, 'backups')) : [];
  assert.equal(backupsOf(f.servers[0]).length, 1);
  assert.equal(backupsOf(f.servers[1]).length, 0);
});

test('the health check follows the port the restart registers, not a one-off port from before', async (t) => {
  const f = await fixture(t, { behaviors: { [next]: { movePortTo: 41500 } } });
  await run(f.servers, ['--beta', '--yes']);
  assert.deepEqual(f.calls(), [`${next} restart server 1`], 'A healthy server on its configured port is not rolled back');
  assert.equal(f.installedVersion(), next);
  assert.ok(!f.commands.includes('pm2 stop'));
});

test('a declined restart does not use up the rollback: the first server that really runs the new version gets it', async (t) => {
  const f = await fixture(t, {
    servers: [{ status: 'online' }, { status: 'online' }],
    behaviors: { [next]: { restart: 'down', copyOnRestart: 'migrated.db', perServer: { 'server 1': { restart: 'declined' } } } },
  });
  await assert.rejects(run(f.servers, ['--beta', '--yes']), { message: translate('update.rolledBack', { version: next, previous }) });
  assert.deepEqual(f.calls(), [`${next} restart server 1`, `${next} restart server 2`, `${previous} start server 2`]);
  assert.equal(await readMarker(path.join(f.servers[1].dataDir, 'server.db')), 'original');
  assert.equal(f.installedVersion(), previous);
});

test('servers restarted later onto an installed version still get a backup and a rollback', async (t) => {
  const f = await fixture(t, {
    local: next, remote: next,
    servers: [{ status: 'online', startedAt: Date.now() - 60_000 }],
    behaviors: { [next]: { restart: 'down', copyOnRestart: 'migrated.db' } },
  });
  safety.recordInstall(next, previous, Date.now() - 1_000);
  await assert.rejects(run(f.servers, ['--beta', '--yes']), { message: translate('update.rolledBack', { version: next, previous }) });
  assert.deepEqual(f.calls(), [`${next} restart server 1`, `${previous} start server 1`]);
  assert.equal(fs.readdirSync(path.join(f.servers[0].dataDir, 'backups')).length, 1);
  assert.equal(await readMarker(path.join(f.servers[0].dataDir, 'server.db')), 'original');
  assert.equal(f.installedVersion(), previous);
  assert.equal(safety.readInstallRecord().version, next, 'A rollback leaves the record on the failed version');
});
test('a late restart never rolls the package back under a server already running the new version', async (t) => {
  const f = await fixture(t, {
    local: next, remote: next,
    servers: [{ status: 'online', startedAt: Date.now() }, { status: 'online', startedAt: Date.now() - 60_000 }],
    behaviors: { [next]: { restart: 'down' } },
  });
  safety.recordInstall(next, previous, Date.now() - 30_000);
  // Like the per-server updaters of older versions, which pass --data.
  const error = await run(f.servers, ['--beta', '--yes'], f.servers[1].dataDir).then(() => assert.fail('The update must fail'), (reason) => reason);
  assert.ok(error.message.startsWith(translate('update.serverDidNotStart', { name: 'Server 2', backup: '' }).trimEnd()), error.message);
  assert.deepEqual(f.calls(), [`${next} restart server 2`]);
  assert.equal(f.installedVersion(), next, 'Server 1 keeps the package it runs');
  assert.ok(!f.commands.includes('pm2 stop'));
});
test('the restart after an update leaves a stopped server stopped', async (t) => {
  const f = await fixture(t, { servers: [{ status: 'stopped' }] });
  const [server] = f.servers;
  t.mock.method(pm2, 'requirePm2', () => true);
  t.mock.method(pm2, 'isMonkyServerRegistered', () => true);
  t.mock.method(targets, 'resolveTargetServer', async () => server);
  assert.equal(await lifecycle.restartServerCommand({ args: [], dataDir: server.dataDir, dataDirSpecified: true }, ['--after-update']), false);
  assert.deepEqual(f.commands, []);
  assert.ok(f.output.includes(translate('lifecycle.updateLeftStopped')));
});

test('an unattended run restarts servers still running the code that was replaced', async (t) => {
  const f = await fixture(t, { local: previous, remote: previous, confirm: () => false, servers: [{ status: 'online', startedAt: Date.now() - 60_000 }] });
  safety.recordInstall(previous, '16.0.0-beta', Date.now() - 1_000);
  await run(f.servers, ['--beta']);
  assert.deepEqual(f.calls(), [], 'An interactive run only reports it');
  assert.ok(f.output.includes(translate('update.outdatedServers', { names: 'Server 1' })));
  await run(f.servers, ['--beta', '--yes']);
  assert.deepEqual(f.calls(), [`${previous} restart server 1`]);
  await run(f.servers, ['--beta', '--yes']);
  assert.deepEqual(f.calls(), [`${previous} restart server 1`], 'A server started after the install is current');
});

test('updates on one machine run one at a time, and a stale lock does not block them', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.profile, 'update.lock');
  const release = await safety.acquireUpdateLock();
  await assert.rejects(safety.acquireUpdateLock(100), { message: translate('update.lockTimeout', { pid: process.pid }) });
  release();
  assert.equal(fs.existsSync(file), false);

  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(file, JSON.stringify({ pid: dead, hostname: os.hostname(), id: 'crashed' }));
  (await safety.acquireUpdateLock(100))();

  fs.writeFileSync(file, '');
  await assert.rejects(safety.acquireUpdateLock(100), /PID \?/, 'A lock being written is not mistaken for a stale one');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  (await safety.acquireUpdateLock(100))();
});

test('auto-update schedules are validated before anything is registered', () => {
  assert.equal(autoUpdate.parseDailyTime('4:05'), '04:05');
  assert.equal(autoUpdate.parseDailyTime(' 23:59 '), '23:59');
  for (const value of ['24:00', '04:60', '4h', '', '04:5']) assert.throws(() => autoUpdate.parseDailyTime(value), /HH:MM/);
  assert.equal(autoUpdate.parseIntervalHours('1'), 1);
  assert.equal(autoUpdate.parseIntervalHours('168'), 168);
  for (const value of ['0', '169', '720', '1.5', '-2', 'x']) {
    assert.throws(() => autoUpdate.parseIntervalHours(value), { message: translate('config.invalidIntervalHours', { value, max: 168 }) });
  }
});

test('the interactive schedule asks again after an invalid answer', async (t) => {
  await fixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete process.stdin.isTTY;
  });
  t.mock.method(prompts, 'askChoice', async (_question, choices) => choices[1]);
  const answers = ['720', '6'];
  t.mock.method(prompts, 'ask', async () => answers.shift());
  assert.deepEqual(await autoUpdate.askAutoUpdateSchedule(), { type: 'interval', hours: 6 });
  assert.deepEqual(answers, []);
});

function evaluateUpdater(script, clock) {
  const timers = [];
  const spawned = [];
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const fixtureRequire = (name) => {
    assert.equal(name, 'child_process');
    return { spawnSync: (...args) => { spawned.push(args); return { status: 0 }; } };
  };
  new Function('require', 'process', 'console', 'setTimeout', 'Date', script)(
    fixtureRequire, { execPath: 'node-fixture' }, { log() {}, error() {} },
    (callback, delay) => timers.push({ callback, delay }), FixtureDate,
  );
  return { timers, spawned };
}

test('the updater daemon never arms a timer beyond Node\'s limit and updates every server at once', () => {
  const clock = { now: Date.UTC(2026, 0, 1, 12) };
  const script = autoUpdate.generateUpdaterScript({ cliEntry: '/fixture/cli.js', beta: true, schedule: { type: 'interval', hours: 720 } });
  const { timers, spawned } = evaluateUpdater(script, clock);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay <= 2 ** 31 - 1);
  assert.equal(timers[0].delay, 168 * 60 * 60 * 1000, 'A hand-edited interval is capped at one week');
  timers[0].callback();
  assert.equal(spawned.length, 0, 'Nothing runs before the due time');
  clock.now += timers[0].delay;
  timers[1].callback();
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0][1], ['/fixture/cli.js', 'update', '--yes', '--beta']);

  const daily = evaluateUpdater(autoUpdate.generateUpdaterScript({
    cliEntry: '/fixture/cli.js', beta: false, schedule: { type: 'daily', time: '04:00' },
  }), clock);
  assert.ok(daily.timers[0].delay > 0 && daily.timers[0].delay <= 24 * 60 * 60 * 1000);
});

test('enabling auto-update replaces the per-server updaters with one machine updater', async (t) => {
  const f = await fixture(t);
  const [server] = f.servers;
  fs.writeFileSync(path.join(server.dataDir, 'auto-update.cjs'), '// per-server updater');
  const pm2Commands = [];
  t.mock.method(pm2, 'ensurePm2', () => {});
  t.mock.method(pm2, 'listPm2Processes', () => [
    { name: pm2.getUpdaterProcessName(server.dataDir) }, { name: 'monky-updater' },
    { name: autoUpdate.AUTO_UPDATER_PROCESS_NAME }, { name: pm2.getPm2ProcessName(server.dataDir) },
  ]);
  t.mock.method(processHelpers, 'runSync', (command, args) => {
    assert.equal(command, 'pm2');
    pm2Commands.push(args);
    return { status: 0, stdout: '', stderr: '' };
  });
  await autoUpdate.enableAutoUpdate({ type: 'daily', time: '05:30' });
  const deleted = pm2Commands.filter((args) => args[0] === 'delete').map((args) => args[1]);
  assert.deepEqual(deleted.sort(), [pm2.getUpdaterProcessName(server.dataDir), 'monky-updater', autoUpdate.AUTO_UPDATER_PROCESS_NAME].sort());
  const start = pm2Commands.find((args) => args[0] === 'start');
  assert.ok(start);
  assert.equal(start[1], autoUpdate.getAutoUpdaterScriptPath());
  assert.equal(start[start.indexOf('--name') + 1], autoUpdate.AUTO_UPDATER_PROCESS_NAME);
  assert.deepEqual(pm2Commands[pm2Commands.length - 1], ['save']);
  const script = fs.readFileSync(autoUpdate.getAutoUpdaterScriptPath(), 'utf8');
  assert.match(script, /"update",\s*"--yes"/);
  assert.doesNotMatch(script, /--data/);
  assert.equal(fs.existsSync(path.join(server.dataDir, 'auto-update.cjs')), false);
});

test('turning auto-update off needs no server and removes every updater', async (t) => {
  await fixture(t);
  t.mock.method(targets, 'resolveTargetServer', async () => assert.fail('The machine updater targets no server'));
  t.mock.method(pm2, 'listPm2Processes', () => [{ name: 'monky-updater-abcdef12' }, { name: autoUpdate.AUTO_UPDATER_PROCESS_NAME }]);
  const pm2Commands = [];
  t.mock.method(processHelpers, 'runSync', (command, args) => {
    assert.equal(command, 'pm2');
    pm2Commands.push(args.join(' '));
    return { status: 0, stdout: '', stderr: '' };
  });
  await setConfigCommand({ args: [], dataDir: process.cwd(), dataDirSpecified: false }, 'autoUpdate', 'false');
  assert.deepEqual(pm2Commands, ['delete monky-updater-abcdef12', `delete ${autoUpdate.AUTO_UPDATER_PROCESS_NAME}`, 'save']);
});
