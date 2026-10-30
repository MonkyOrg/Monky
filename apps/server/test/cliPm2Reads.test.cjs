const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SqlJsDriver } = require('../dist/infrastructure/database/SqliteWrapper');
const { CoturnManager } = require('../dist/infrastructure/turn/CoturnManager');
const cliContext = require('../dist/cli/context');
const health = require('../dist/cli/health');
const lifecycle = require('../dist/cli/commands/serverLifecycle');
const pm2 = require('../dist/cli/pm2');
const processHelpers = require('../dist/cli/process');
const targets = require('../dist/cli/target');
const preview = require('../dist/cli/onlineUsers');
const compatibility = require('../dist/cli/botCompatibility');
const { getCliLanguage, setCliLanguage } = require('../dist/cli/i18n');

async function serverFixture(t, name = 'Fixture server') {
  const previousHome = process.env.MONKY_HOME;
  const previousLanguage = getCliLanguage();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-pm2-reads-'));
  process.env.MONKY_HOME = path.join(root, 'cli');
  setCliLanguage('en');
  t.after(() => {
    if (previousHome === undefined) delete process.env.MONKY_HOME;
    else process.env.MONKY_HOME = previousHome;
    setCliLanguage(previousLanguage);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const dataDir = path.join(root, 'server');
  const driver = await SqlJsDriver.create(path.join(dataDir, 'server.db'));
  try {
    driver.exec('CREATE TABLE server_meta (name TEXT NOT NULL, turn_enabled INTEGER)');
    driver.prepare('INSERT INTO server_meta VALUES (?, 0)').run(name);
  } finally {
    driver.close();
  }
  fs.writeFileSync(path.join(dataDir, 'monky.json'), JSON.stringify({ port: 31416 }));
  return { root, dataDir, server: { id: 'fixture', dataDir, name, port: 31416, createdAt: 1 } };
}

/** A PM2 that counts how often each command starts it. */
function fakePm2(t, processes) {
  const calls = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(processHelpers, 'commandSucceeds', (command, args) => {
    assert.equal(command, 'pm2');
    calls.push(args[0]);
    return true;
  });
  t.mock.method(processHelpers, 'runSync', (command, args) => {
    assert.equal(command, 'pm2', 'Only the simulated PM2 may run');
    calls.push(args[0]);
    assert.ok(['jlist', 'stop', 'startOrRestart', 'save', 'logs', 'delete'].includes(args[0]), `Unexpected PM2 command ${args[0]}`);
    return { status: 0, stdout: args[0] === 'jlist' ? JSON.stringify(processes) : '', stderr: '' };
  });
  t.mock.method(processHelpers, 'runAsync', () => assert.fail('Unexpected streamed process'));
  t.mock.method(preview, 'confirmDisconnectingUsers', async () => true);
  t.mock.method(preview, 'readLocalServerPreview', async () => null);
  t.mock.method(compatibility, 'printBotCompatibilityWarning', async () => {});
  t.mock.method(health, 'diagnoseServerHealth', async () => []);
  return calls;
}

function onlineEntry(dataDir, pid = 4242) {
  return {
    name: pm2.getPm2ProcessName(dataDir), pid,
    pm2_env: { status: 'online', pm_uptime: Date.now(), pm_exec_path: pm2.getServerEntryPath(), args: ['--data', dataDir] },
  };
}

const count = (calls, command) => calls.filter((call) => call === command).length;

test('each lifecycle command reads the PM2 process list once and checks PM2 at most once', async (t) => {
  const { dataDir, server } = await serverFixture(t);
  const calls = fakePm2(t, [onlineEntry(dataDir)]);
  t.mock.method(targets, 'resolveTargetServer', async () => server);
  const globalArgs = { args: [], dataDir, dataDirSpecified: true };
  const commands = {
    restart: () => lifecycle.restartServerCommand(globalArgs, []),
    stop: () => lifecycle.stopServerCommand(globalArgs),
    logs: () => lifecycle.logsServerCommand(globalArgs, ['--no-follow']),
    status: () => lifecycle.statusServerCommand(globalArgs, []),
    list: () => lifecycle.printServerTable([server, { ...server, id: 'second' }, { ...server, id: 'third' }]),
  };
  for (const [name, run] of Object.entries(commands)) {
    calls.length = 0;
    await run();
    assert.equal(count(calls, 'jlist'), 1, `${name} reads PM2 once: ${calls.join(', ')}`);
    assert.ok(count(calls, '--version') <= 1, `${name} checks PM2 at most once: ${calls.join(', ')}`);
  }
});

test('the dashboard rereads TURN only after the database changed, at most every 30s, and probes ports every 60s', async (t) => {
  const { dataDir } = await serverFixture(t);
  const database = path.join(dataDir, 'server.db');
  let turnEnabled = true;
  const reads = t.mock.method(cliContext, 'withContext', async (_dataDir, action) => action({
    serverRepo: { getLifecycleSettings: async () => ({ name: 'Fixture server', turnEnabled }) },
  }));
  t.mock.method(CoturnManager, 'describeAvailability', () => ({ supported: true }));
  const probes = t.mock.method(CoturnManager, 'checkPortReachability', async () => null);
  const touch = (seconds) => fs.utimesSync(database, new Date(seconds * 1000), new Date(seconds * 1000));
  const turn = new lifecycle.DashboardTurnStatus(dataDir);
  const tick = (seconds) => turn.refresh(seconds * 1000);

  await tick(0);
  assert.deepEqual([reads.mock.callCount(), probes.mock.callCount()], [1, 1]);
  assert.equal(turn.state.enabled, true);
  for (let seconds = 2; seconds < 60; seconds += 2) await tick(seconds);
  assert.equal(reads.mock.callCount(), 1, 'An unchanged database is never loaded again');
  assert.equal(probes.mock.callCount(), 1, 'The outside probe waits 60s');
  await tick(60);
  assert.equal(probes.mock.callCount(), 2);

  touch(1000);
  await tick(70);
  assert.equal(reads.mock.callCount(), 2, 'A changed database is read again once 30s passed since the last read');
  touch(2000);
  await tick(80);
  assert.equal(reads.mock.callCount(), 2, 'Even a busy database is read at most every 30s');
  turnEnabled = false;
  await tick(100);
  assert.deepEqual([reads.mock.callCount(), turn.state.enabled], [3, false]);
  await tick(200);
  assert.equal(probes.mock.callCount(), 2, 'A disabled relay is never probed');

  turnEnabled = true;
  touch(3000);
  await tick(202);
  assert.deepEqual([reads.mock.callCount(), turn.state.enabled], [4, true]);
  assert.equal(probes.mock.callCount(), 3, 'Enabling TURN probes it right away');
});
