const assert = require('node:assert/strict');
const { fork, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { stripVTControlCharacters } = require('node:util');
const { MonkyServer } = require('../dist/server');
const { Logger } = require('../dist/infrastructure/logger/Logger');
const { SqlJsDriver } = require('../dist/infrastructure/database/SqliteWrapper');
const { DatabaseConnection } = require('../dist/infrastructure/database/DatabaseConnection');
const serverLock = require('../dist/infrastructure/lifecycle/serverLock');
const { runCommand } = require('../dist/cli');
const { snapshotTiming, withContext, withReadOnlyContext, withWritableContext } = require('../dist/cli/context');
const pm2 = require('../dist/cli/pm2');
const processHelpers = require('../dist/cli/process');
const targets = require('../dist/cli/target');
const registry = require('../dist/cli/registry');
const prompts = require('../dist/cli/prompts');
const onlineUsers = require('../dist/cli/onlineUsers');
const { getCliLanguage, setCliLanguage, t: translate } = require('../dist/cli/i18n');

const migrations = path.resolve(__dirname, '../dist/infrastructure/database/migrations');

function isolate(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-cli-guard-'));
  const dataDir = path.join(root, 'server data');
  const previousHome = process.env.MONKY_HOME;
  const previousLanguage = getCliLanguage();
  process.env.MONKY_HOME = path.join(root, 'cli profile');
  setCliLanguage('en');
  t.after(() => {
    if (previousHome === undefined) delete process.env.MONKY_HOME;
    else process.env.MONKY_HOME = previousHome;
    setCliLanguage(previousLanguage);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const output = [];
  t.mock.method(console, 'log', (...values) => output.push(stripVTControlCharacters(values.map(String).join(' '))));
  t.mock.method(Logger, 'info', () => {});
  t.mock.method(processHelpers, 'runSync', (command) => assert.fail(`Unexpected external process: ${command}`));
  return { root, dataDir, output, database: path.join(dataDir, 'server.db') };
}

/** A real server database with one member, created the way `monky create` seeds it. */
async function seededServer(t, { registered = false } = {}) {
  const fixture = isolate(t);
  await withContext(fixture.dataDir, async (ctx) => {
    await ctx.userRepo.create({
      id: 'fixture-user', clientId: '0123456789abcdef0123456789abcdef', publicKey: 'a'.repeat(64),
      nickname: 'Fixture', avatarPath: null, createdAt: 1, lastSeenAt: 2,
    });
  });
  const server = { id: 'fixture', dataDir: fixture.dataDir, name: 'Fixture server', port: 31999, createdAt: 1 };
  // A registered server goes through the real target resolution, as the CLI does.
  if (!registered) t.mock.method(targets, 'resolveTargetServer', async () => server);
  return { ...fixture, server };
}

function pm2State(t, entry) {
  const state = { entry };
  t.mock.method(pm2, 'listPm2Processes', () => []);
  t.mock.method(pm2, 'findPm2Process', (name) => (name === state.entry?.name ? state.entry : null));
  t.mock.method(pm2, 'findLegacyProcessFor', () => null);
  return state;
}

function onlineEntry(dataDir, pid = 4242) {
  return { name: pm2.getPm2ProcessName(dataDir), pid, pm2_env: { status: 'online' } };
}

function writeLock(dataDir, record) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(serverLock.serverLockPath(dataDir), JSON.stringify(record));
}

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '']);
  assert.ok(child.pid > 0);
  return child.pid;
}

function snapshot(file) {
  return { bytes: fs.readFileSync(file), modified: fs.statSync(file).mtimeMs };
}

function assertUnchanged(file, before) {
  assert.deepEqual(fs.readFileSync(file), before.bytes, 'server.db must keep its bytes');
  assert.equal(fs.statSync(file).mtimeMs, before.modified, 'server.db must not be rewritten');
}

async function adminRoleHolders(database) {
  const connection = await DatabaseConnection.create(database, { readOnly: true });
  try {
    return connection.getDb().prepare(
      "SELECT user_roles.user_id AS userId FROM user_roles JOIN roles ON roles.id = user_roles.role_id WHERE roles.name = 'Admin'"
    ).all().map((row) => row.userId);
  } finally {
    connection.close();
  }
}

test('a server owns server.lock from creation until its database is closed', async (t) => {
  const fixture = isolate(t);
  const server = await MonkyServer.create({ port: 0, dataDir: fixture.dataDir, serverName: 'Lock fixture' });
  let stopped = false;
  t.after(async () => { if (!stopped) await server.stop(); });
  const lockFile = serverLock.serverLockPath(fixture.dataDir);
  const record = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.equal(record.pid, process.pid);
  assert.equal(record.hostname, os.hostname());
  assert.deepEqual(serverLock.findLiveServerLock(fixture.dataDir), { pid: process.pid, path: lockFile });

  pm2State(t, null);
  await assert.rejects(runCommand({ args: ['admin', 'add', 'anyone'], dataDir: fixture.dataDir, dataDirSpecified: true }), {
    message: `${translate('guard.serverRunningOther', { pid: process.pid })}\n${translate('guard.staleLockHint', { path: lockFile })}`,
  });

  await server.stop();
  stopped = true;
  assert.equal(fs.existsSync(lockFile), false, 'Stopping releases the lock after the last database write');
  assert.equal(serverLock.findLiveServerLock(fixture.dataDir), null);
});

test('a lock left by a dead, rebooted or copied server never blocks the CLI', async (t) => {
  const fixture = isolate(t);
  const stale = [
    { pid: deadPid(), hostname: os.hostname(), id: 'dead' },
    { pid: process.pid, hostname: `${os.hostname()}-copied-elsewhere`, id: 'foreign' },
    'not json at all',
    { hostname: os.hostname() },
  ];
  if (process.platform === 'linux') stale.push({ pid: process.pid, hostname: os.hostname(), bootId: 'previous-boot', id: 'reboot' });
  for (const record of stale) {
    writeLock(fixture.dataDir, record);
    assert.equal(serverLock.findLiveServerLock(fixture.dataDir), null, JSON.stringify(record));
  }
  writeLock(fixture.dataDir, { pid: process.pid, hostname: os.hostname(), id: 'live' });
  assert.equal(serverLock.findLiveServerLock(fixture.dataDir)?.pid, process.pid);
});

test('a new server takes a stale lock over and releases only its own', async (t) => {
  const fixture = isolate(t);
  writeLock(fixture.dataDir, { pid: deadPid(), hostname: os.hostname(), id: 'previous-crash' });
  const lock = serverLock.acquireServerLock(fixture.dataDir);
  assert.equal(serverLock.findLiveServerLock(fixture.dataDir)?.pid, process.pid);
  writeLock(fixture.dataDir, { pid: process.pid, hostname: os.hostname(), id: 'newer-owner' });
  lock.release();
  assert.equal(JSON.parse(fs.readFileSync(serverLock.serverLockPath(fixture.dataDir), 'utf8')).id, 'newer-owner');
});

for (const running of ['pm2', 'lock']) {
  test(`every data-changing command is refused while the server runs (${running}), without touching server.db`, async (t) => {
    const fixture = await seededServer(t);
    const lockFile = serverLock.serverLockPath(fixture.dataDir);
    if (running === 'pm2') {
      pm2State(t, onlineEntry(fixture.dataDir));
    } else {
      pm2State(t, null);
      writeLock(fixture.dataDir, { pid: process.pid, hostname: os.hostname(), id: 'live' });
    }
    const expected = running === 'pm2'
      ? translate('guard.serverRunningPm2', { process: `${pm2.getPm2ProcessName(fixture.dataDir)}, PID 4242` })
      : `${translate('guard.serverRunningOther', { pid: process.pid })}\n${translate('guard.staleLockHint', { path: lockFile })}`;
    t.mock.method(prompts, 'ask', async () => assert.fail('Refusal happens before any question'));
    const before = snapshot(fixture.database);
    for (const args of [
      ['admin', 'add', 'Fixture'], ['admin', 'remove', 'Fixture'], ['roles', 'create', 'Moderators', '#123456', 'SEND_MESSAGES'],
      ['roles', 'assign', 'Fixture', 'Admin'], ['roles', 'unassign', 'Fixture', 'Admin'], ['roles', 'delete', 'Admin'],
      ['config', 'set', 'name', 'Renamed'], ['config', 'set', 'maxUsers', '50'], ['config', 'set', 'turn', 'false'],
      ['config', 'set', 'voiceMode', 'p2p'], ['config', 'set', 'password', 'clear'],
    ]) {
      await assert.rejects(runCommand({ args, dataDir: fixture.dataDir, dataDirSpecified: true }), { message: expected }, args.join(' '));
    }
    assertUnchanged(fixture.database, before);
  });
}

test('members, roles and config are read from a snapshot that never rewrites server.db', async (t) => {
  const fixture = await seededServer(t);
  pm2State(t, onlineEntry(fixture.dataDir));
  writeLock(fixture.dataDir, { pid: process.pid, hostname: os.hostname(), id: 'live' });
  t.mock.method(pm2, 'listPm2Processes', () => []);
  const before = snapshot(fixture.database);
  for (const args of [['members'], ['members', 'info', 'Fixture'], ['roles'], ['config', 'show']]) {
    await runCommand({ args, dataDir: fixture.dataDir, dataDirSpecified: true });
  }
  const text = fixture.output.join('\n');
  assert.ok(text.includes('Fixture'));
  assert.ok(text.includes('Admin'));
  assert.ok(text.includes(translate('config.title')));
  assertUnchanged(fixture.database, before);
});

test('a write that waited while the server started, or that failed, saves nothing', async (t) => {
  const fixture = await seededServer(t);
  pm2State(t, null);
  const before = snapshot(fixture.database);
  await assert.rejects(withWritableContext(fixture.dataDir, async (ctx) => {
    await ctx.serverRepo.updateServer({ name: 'Lost to the server' });
    // Longer than sql.js waits before saving on its own, like an operator at a prompt.
    await new Promise((resolve) => setTimeout(resolve, 3_300));
    writeLock(fixture.dataDir, { pid: process.pid, hostname: os.hostname(), id: 'started-meanwhile' });
  }), { message: translate('guard.startedDuringCommand') });
  assertUnchanged(fixture.database, before);

  fs.rmSync(serverLock.serverLockPath(fixture.dataDir));
  await assert.rejects(withWritableContext(fixture.dataDir, async (ctx) => {
    await ctx.serverRepo.updateServer({ name: 'Half applied' });
    throw new Error('fixture validation failure');
  }), /fixture validation failure/);
  assertUnchanged(fixture.database, before);
});

test('with the server stopped the change is saved and survives the next server start', async (t) => {
  const fixture = await seededServer(t);
  pm2State(t, null);
  await runCommand({ args: ['admin', 'add', 'Fixture'], dataDir: fixture.dataDir, dataDirSpecified: true });
  assert.ok(fixture.output.some((line) => line.includes(translate('members.adminGranted', { nickname: 'Fixture' }))));
  assert.deepEqual(await adminRoleHolders(fixture.database), ['fixture-user']);

  const server = await MonkyServer.create({ port: 0, dataDir: fixture.dataDir });
  await server.stop();
  assert.deepEqual(await adminRoleHolders(fixture.database), ['fixture-user'], 'The server loads the change instead of overwriting it');
});

async function legacyDatabase(dataDir) {
  const files = fs.readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort();
  const pending = files[files.length - 1];
  const driver = await SqlJsDriver.create(path.join(dataDir, 'server.db'));
  try {
    driver.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const file of files.slice(0, -1)) {
      driver.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
      driver.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(file, 1);
    }
  } finally {
    driver.close();
  }
  return pending;
}

async function ledgerHas(database, version) {
  const connection = await DatabaseConnection.create(database, { readOnly: true });
  try {
    return connection.getDb().prepare('SELECT version FROM schema_migrations').all().some((row) => row.version === version);
  } finally {
    connection.close();
  }
}

test('a database older than the CLI is upgraded only while no server holds it', async (t) => {
  const fixture = isolate(t);
  const pending = await legacyDatabase(fixture.dataDir);
  const timing = { ...snapshotTiming };
  Object.assign(snapshotTiming, { upgradeWaitMs: 300, pollMs: 20 });
  t.after(() => Object.assign(snapshotTiming, timing));
  const state = pm2State(t, onlineEntry(fixture.dataDir));
  const before = snapshot(fixture.database);
  await assert.rejects(withReadOnlyContext(fixture.dataDir, async () => assert.fail('No read on an outdated schema')), {
    message: translate('guard.outdatedSchemaRunning'),
  });
  assertUnchanged(fixture.database, before);
  assert.equal(await ledgerHas(fixture.database, pending), false);

  state.entry = null;
  let members;
  await withReadOnlyContext(fixture.dataDir, async (ctx) => { members = await ctx.userRepo.listAll(); });
  assert.deepEqual(members, []);
  assert.equal(await ledgerHas(fixture.database, pending), true, 'A stopped server is upgraded like "monky start" would');
});

test('a read right after a server starts waits for it to save its upgraded database', async (t) => {
  const fixture = isolate(t);
  const pending = await legacyDatabase(fixture.dataDir);
  const timing = { ...snapshotTiming };
  Object.assign(snapshotTiming, { upgradeWaitMs: 5_000, pollMs: 20 });
  t.after(() => Object.assign(snapshotTiming, timing));
  pm2State(t, onlineEntry(fixture.dataDir));
  const saved = new Promise((resolve, reject) => setTimeout(() => {
    DatabaseConnection.create(fixture.database).then((connection) => { connection.close(); resolve(); }, reject);
  }, 100));
  let members;
  await withReadOnlyContext(fixture.dataDir, async (ctx) => { members = await ctx.userRepo.listAll(); });
  await saved;
  assert.deepEqual(members, []);
  assert.equal(await ledgerHas(fixture.database, pending), true);
});

/**
 * A registered server whose live process answers `/preview` on its current
 * port with two people in voice, so the restart's warning is real.
 */
async function portFixture(t, options = {}) {
  const fixture = await seededServer(t, { registered: true });
  const voice = http.createServer((_request, response) => response.end(JSON.stringify({ userCount: 2, voiceUserCount: 2 })));
  await new Promise((resolve) => voice.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => voice.close(resolve)));
  const oldPort = voice.address().port;
  const newPort = oldPort === 65535 ? oldPort - 1 : oldPort + 1;
  fs.writeFileSync(path.join(fixture.dataDir, 'monky.json'), JSON.stringify({ port: oldPort }));
  registry.registerServer(fixture.dataDir, { name: 'Fixture server', port: oldPort });
  const state = pm2State(t, options.running === false
    ? { ...onlineEntry(fixture.dataDir), pm2_env: { status: 'stopped' } }
    : onlineEntry(fixture.dataDir));
  const commands = [];
  const questions = [];
  t.mock.method(pm2, 'requirePm2', () => true);
  t.mock.method(pm2, 'isMonkyServerRegistered', () => true);
  t.mock.method(prompts, 'confirm', async (question) => { questions.push(question); return options.accept !== false; });
  // Only the bot-compatibility check after the restart is simulated; the voice check queries the old port for real.
  t.mock.method(onlineUsers, 'readLocalServerPreview', async (port) => (port === newPort && state.entry?.pid === 4343
    ? { userCount: 0, voiceUserCount: 0, botCompatibility: null } : null));
  t.mock.method(processHelpers, 'runSync', (command, args) => {
    assert.equal(command, 'pm2');
    commands.push(args[0]);
    if (args[0] === 'startOrRestart') {
      if (options.restartFails) return { status: 1, stdout: '', stderr: 'fixture refusal' };
      state.entry = onlineEntry(fixture.dataDir, 4343);
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  const voiceWarning = translate('voiceUsers.warning', { people: translate('voiceUsers.many', { count: 2 }), server: 'Fixture server' });
  return { ...fixture, state, commands, questions, oldPort, newPort, voiceWarning };
}

test('config set port restarts through the regular restart, warning the people in voice and saving PM2', async (t) => {
  const fixture = await portFixture(t);
  await runCommand({ args: ['config', 'set', 'port', String(fixture.newPort)], dataDir: fixture.dataDir, dataDirSpecified: true });
  assert.deepEqual(fixture.questions, [translate('config.restartForPort')]);
  assert.ok(fixture.output.includes(fixture.voiceWarning), 'The warning checks the port the server still runs on');
  assert.deepEqual(fixture.commands, ['startOrRestart', 'save'], 'pm2 save keeps the new port after a reboot');
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'monky.json'), 'utf8')).port, fixture.newPort);
  assert.match(fs.readFileSync(pm2.getEcosystemPath(fixture.dataDir), 'utf8'), new RegExp(`--port ${fixture.newPort}`));
  assert.equal(registry.findServerByDataDir(fixture.dataDir).port, fixture.newPort);
  assert.ok(fixture.output.includes(translate('lifecycle.restarted')));
});

test('config set port reports a failed restart and never claims the server restarted', async (t) => {
  const fixture = await portFixture(t, { restartFails: true });
  await assert.rejects(runCommand({ args: ['config', 'set', 'port', String(fixture.newPort)], dataDir: fixture.dataDir, dataDirSpecified: true }), {
    message: translate('lifecycle.restartFailed'),
  });
  assert.deepEqual(fixture.commands, ['startOrRestart']);
  assert.ok(!fixture.output.includes(translate('lifecycle.restarted')));
  assert.equal(registry.findServerByDataDir(fixture.dataDir).port, fixture.oldPort, 'The registry keeps the port still in use');
});

test('a declined or unnecessary port restart leaves PM2 alone', async (t) => {
  for (const options of [{ accept: false }, { running: false }]) {
    await t.test(JSON.stringify(options), async (subtest) => {
      const fixture = await portFixture(subtest, options);
      await runCommand({ args: ['config', 'set', 'port', String(fixture.newPort)], dataDir: fixture.dataDir, dataDirSpecified: true });
      assert.deepEqual(fixture.commands, []);
      assert.deepEqual(fixture.questions, options.running === false ? [] : [translate('config.restartForPort')]);
      assert.ok(fixture.output.includes(translate(options.running === false ? 'config.portNextStart' : 'config.portNextStartOrRestart')));
      assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'monky.json'), 'utf8')).port, fixture.newPort);
      assert.equal(registry.findServerByDataDir(fixture.dataDir).port, options.running === false ? fixture.newPort : fixture.oldPort);
    });
  }
});

test('the built CLI refuses to write while a real server process holds the data directory', { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-cli-guard-process-'));
  const dataDir = path.join(root, 'server data');
  const preload = path.join(root, 'loopback.cjs');
  fs.writeFileSync(preload, `
    const http = require('node:http');
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function () {
      this.once('listening', () => process.send({ qaPort: this.address().port }));
      return listen.call(this, 0, '127.0.0.1');
    };
    require(${JSON.stringify(path.resolve(__dirname, '../dist/infrastructure/discovery/LanBroadcaster.js'))})
      .LanBroadcaster.prototype.start = async () => {};
  `);
  // Only Node on PATH: the CLI must not reach a real PM2 daemon from a test.
  const env = { ...process.env, MONKY_HOME: path.join(root, 'cli profile'), PM2_HOME: path.join(root, 'pm2'), PATH: path.dirname(process.execPath) };
  delete env.MONKY_LANG;
  const child = fork(path.resolve(__dirname, '../dist/index.js'), ['--data', dataDir], {
    execArgv: ['--require', preload], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server readiness timed out: ${stderr}`)), 15_000);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited (${code}): ${stderr}`)); });
    child.on('message', (message) => {
      if (message && typeof message === 'object' && Number.isInteger(message.qaPort)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const cli = (...args) => spawnSync(process.execPath, [path.resolve(__dirname, '../dist/cli.js'), '--lang', 'en-US', '--data', dataDir, ...args], {
    cwd: root, env, input: '', encoding: 'utf8', timeout: 20_000,
  });

  const lockFile = serverLock.serverLockPath(dataDir);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid, child.pid);
  const refused = cli('config', 'set', 'name', 'Renamed while running');
  assert.equal(refused.status, 1, refused.stdout);
  assert.ok(refused.stderr.includes(`PID ${child.pid}`), refused.stderr);
  const listed = cli('members');
  assert.equal(listed.status, 0, listed.stderr);

  const exited = once(child, 'exit');
  child.send('shutdown');
  assert.deepEqual(await exited, [0, null]);
  assert.equal(fs.existsSync(lockFile), false, 'A graceful stop releases the lock');
  const renamed = cli('config', 'set', 'name', 'Renamed while stopped');
  assert.equal(renamed.status, 0, renamed.stderr);
  const connection = await DatabaseConnection.create(path.join(dataDir, 'server.db'), { readOnly: true });
  try {
    assert.equal(connection.getDb().prepare('SELECT name FROM server_meta').get().name, 'Renamed while stopped');
  } finally {
    connection.close();
  }
});