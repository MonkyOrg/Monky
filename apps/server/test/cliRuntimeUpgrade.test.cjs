const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseConnection } = require('../dist/infrastructure/database/DatabaseConnection');
const { SqlJsDriver } = require('../dist/infrastructure/database/SqliteWrapper');
const { withContext } = require('../dist/cli/context');
const health = require('../dist/cli/health');
const lifecycle = require('../dist/cli/commands/serverLifecycle');
const pm2 = require('../dist/cli/pm2');
const processHelpers = require('../dist/cli/process');
const targets = require('../dist/cli/target');
const registry = require('../dist/cli/registry');
const preview = require('../dist/cli/onlineUsers');
const compatibility = require('../dist/cli/botCompatibility');
const { getCliLanguage, setCliLanguage, t: translate } = require('../dist/cli/i18n');

async function databaseFixture(t, withTurn = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-runtime-upgrade-'));
  const dataDir = path.join(root, 'server data & history');
  const database = path.join(dataDir, 'server.db');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const driver = await SqlJsDriver.create(database);
  try {
    driver.exec(`CREATE TABLE server_meta (name TEXT NOT NULL${withTurn ? ', turn_enabled INTEGER' : ''})`);
    driver.prepare(`INSERT INTO server_meta VALUES (?${withTurn ? ', 0' : ''})`).run('Existing server');
  } finally {
    driver.close();
  }
  fs.writeFileSync(path.join(dataDir, 'monky.json'), JSON.stringify({ port: 31415 }));
  return { root, dataDir, database };
}

test('recreation follows the executable PM2 actually runs, not its updated script setting', () => {
  const expected = pm2.getServerEntryPath();
  const old = `${expected}.previous-installation`;
  for (const status of ['online', 'stopped', 'errored']) {
    const entry = { pid: 42, pm2_env: { status, pm_exec_path: old, script: expected } };
    assert.equal(health.needsProcessRecreate(entry, expected), true, status);
  }
  assert.equal(health.needsProcessRecreate({
    pid: 42, pm2_env: { status: 'online', pm_exec_path: expected, exec_interpreter: 'old-node' },
  }, expected), false, 'A changed interpreter alone is still reapplied by PM2');
  assert.equal(health.needsProcessRecreate({
    pm2_env: { status: 'online', pm_exec_path: expected },
  }, expected), true, 'An online entry without a pid must still be recreated');
  assert.equal(health.needsProcessRecreate(null, expected), false);
  assert.equal(health.needsProcessRecreate({ pid: 42, pm2_env: { status: 'online' } }, expected), false);
  if (process.platform === 'win32') {
    assert.equal(health.needsProcessRecreate({
      pid: 42, pm2_env: { status: 'online', pm_exec_path: expected.toUpperCase() },
    }, expected), false, 'Windows spelling differences do not discard a healthy registration');
  }
});

test('status identifies both executable paths and gives a localized recovery hint', () => {
  const previous = getCliLanguage();
  try {
    for (const language of ['pt-BR', 'en']) {
      setCliLanguage(language);
      const expected = pm2.getServerEntryPath();
      const script = `${expected}.old`;
      const problems = health.evaluateServerHealth({
        entry: { pid: 42, pm2_env: { status: 'online', pm_exec_path: script, node_version: process.versions.node } },
        portState: 'listening', cliNodeVersion: process.versions.node, expectedScript: expected,
      });
      assert.deepEqual(problems, [{
        message: translate('health.scriptMismatch', { script, expected }),
        hint: translate('health.scriptMismatchHint'),
      }]);
    }
  } finally {
    setCliLanguage(previous);
  }
});

for (const withTurn of [true, false]) {
  test(`lifecycle reads old metadata without applying migrations or writing the database (TURN column=${withTurn})`, async t => {
    const fixture = await databaseFixture(t, withTurn);
    if (withTurn) {
      const writer = await SqlJsDriver.create(fixture.database);
      try {
        writer.prepare('UPDATE server_meta SET turn_enabled = ?').run(1);
      } finally {
        writer.close();
      }
    }
    const before = fs.readFileSync(fixture.database);
    const modified = fs.statSync(fixture.database).mtimeMs;
    assert.deepEqual(await lifecycle.loadStoredServer(fixture.dataDir), {
      name: 'Existing server', turnEnabled: withTurn,
    });
    assert.deepEqual(fs.readFileSync(fixture.database), before);
    const snapshot = await DatabaseConnection.create(fixture.database, { readOnly: true });
    try {
      assert.equal(snapshot.getDb().prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
      ).get(), undefined, 'A read-only opening must not even create the migration ledger');
    } finally {
      snapshot.close();
    }
    assert.deepEqual(fs.readFileSync(fixture.database), before);
    assert.equal(fs.statSync(fixture.database).mtimeMs, modified);
  });
}

test('closing a CLI snapshot cannot overwrite a newer snapshot saved by the running server', async t => {
  const fixture = await databaseFixture(t);
  const live = await SqlJsDriver.create(fixture.database);
  let latest;
  try {
    await withContext(fixture.dataDir, async ctx => {
      assert.equal((await ctx.serverRepo.getLifecycleSettings()).name, 'Existing server');
      live.prepare('UPDATE server_meta SET name = ?').run('Saved by the live server');
      live.close();
      latest = fs.readFileSync(fixture.database);
      assert.equal((await ctx.serverRepo.getLifecycleSettings()).name, 'Existing server',
        'The reader still owns its earlier in-memory snapshot');
    }, false, { readOnly: true });
    assert.deepEqual(fs.readFileSync(fixture.database), latest);
    assert.equal((await lifecycle.loadStoredServer(fixture.dataDir)).name, 'Saved by the live server');
  } finally {
    live.close();
  }
});

test('read-only snapshots reject writes and never create missing database files', async t => {
  const fixture = await databaseFixture(t);
  const before = fs.readFileSync(fixture.database);
  const snapshot = await DatabaseConnection.create(fixture.database, { readOnly: true });
  const db = snapshot.getDb();
  try {
    assert.throws(() => db.prepare('UPDATE server_meta SET name = ?').run('Wrong'), /read.only/i);
    assert.throws(() => db.exec('DELETE FROM server_meta'), /read.only/i);
    assert.throws(() => db.transaction(() => {})(), /read.only/i);
    await assert.rejects(db.transactionAsync(async () => {}), /read.only/i);
    assert.throws(() => db.pragma('query_only = OFF'), /read.only/i);
    assert.throws(() => db.prepare("UPDATE server_meta SET name = 'Wrong' RETURNING name").get(), /readonly/i);
  } finally {
    snapshot.close();
  }
  assert.deepEqual(fs.readFileSync(fixture.database), before);
  const missing = path.join(fixture.root, 'must not create', 'server.db');
  await assert.rejects(DatabaseConnection.create(missing, { readOnly: true }), { code: 'ENOENT' });
  assert.equal(fs.existsSync(path.dirname(missing)), false);
  await assert.rejects(withContext(fixture.dataDir, async () => assert.fail('No seeding'), true, { readOnly: true }),
    /cannot seed/);
});

async function restartFixture(t, { command, changed = true, deletionFails = false }) {
  const fixture = await databaseFixture(t);
  const name = pm2.getPm2ProcessName(fixture.dataDir);
  const expected = pm2.getServerEntryPath();
  let entry = {
    name, pid: command === 'start' ? 0 : 42,
    pm2_env: {
      status: command === 'start' ? 'stopped' : 'online',
      pm_exec_path: changed ? `${expected}.old` : expected,
    },
  };
  const actions = [];
  const output = [];
  t.mock.method(console, 'log', value => output.push(String(value)));
  t.mock.method(pm2, 'requirePm2', () => true);
  t.mock.method(pm2, 'ensurePm2', () => {});
  t.mock.method(pm2, 'findPm2Process', () => entry);
  t.mock.method(pm2, 'findLegacyProcessFor', () => null);
  t.mock.method(pm2, 'isMonkyServerRegistered', () => !!entry);
  t.mock.method(processHelpers, 'commandSucceeds', () => assert.fail('Unexpected external availability probe'));
  t.mock.method(processHelpers, 'runAsync', () => assert.fail('Unexpected external process'));
  t.mock.method(targets, 'resolveTargetServer', async () => ({ dataDir: fixture.dataDir, port: 31415 }));
  t.mock.method(registry, 'registerServer', (dataDir, details) => {
    assert.equal(dataDir, fixture.dataDir);
    assert.equal(details.name, 'Existing server');
    actions.push('registered');
  });
  t.mock.method(preview, 'confirmDisconnectingUsers', async () => { actions.push('confirmed'); return true; });
  t.mock.method(compatibility, 'printBotCompatibilityWarning', async () => {});
  t.mock.method(processHelpers, 'runSync', (executable, args) => {
    assert.equal(executable, 'pm2', 'No unisolated process manager or package installation is allowed');
    actions.push(args[0]);
    if (args[0] === 'delete') {
      assert.equal(args[1], name);
      if (deletionFails) return { status: 1, stdout: '', stderr: 'fixture deletion refused' };
      entry = null;
    } else if (args[0] === 'startOrRestart') {
      const app = require(args[1]).apps[0];
      assert.equal(app.name, name);
      assert.equal(app.script, expected);
      assert.equal(app.cwd, fixture.dataDir);
      entry = { pid: 43, pm2_env: { status: 'online', pm_exec_path: entry?.pm2_env.pm_exec_path ?? app.script } };
    } else {
      assert.equal(args[0], 'save');
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  return {
    ...fixture, actions, output, expected,
    run: (args = []) => lifecycle[command === 'start' ? 'startServerCommand' : 'restartServerCommand']({
      dataDir: fixture.dataDir, dataDirSpecified: true, args,
    }, args),
    entry: () => entry,
  };
}

for (const command of ['start', 'restart']) {
  for (const changed of [true, false]) {
    test(`${command} ${changed ? 'replaces the previous executable' : 'preserves a matching registration'}`, async t => {
      const fixture = await restartFixture(t, { command, changed });
      const before = fs.readFileSync(fixture.database);
      await fixture.run();
      if (command === 'restart') assert.equal(fixture.actions[0], 'confirmed', 'Confirmation precedes any PM2 mutation');
      assert.deepEqual(fixture.actions.filter(action => action !== 'confirmed'),
        [...(changed ? ['delete'] : []), 'startOrRestart', 'save', 'registered']);
      assert.equal(fixture.entry().pm2_env.pm_exec_path, fixture.expected);
      assert.deepEqual(fs.readFileSync(fixture.database), before, 'The CLI does not migrate or rewrite the live database');
    });
  }

  test(`${command} never claims success or reuses the old executable after a failed deletion`, async t => {
    const fixture = await restartFixture(t, { command, deletionFails: true });
    await assert.rejects(fixture.run(), /fixture deletion refused/);
    assert.deepEqual(fixture.actions.filter(action => action !== 'confirmed'), ['delete']);
    assert.ok(!fixture.output.some(line => line.includes(translate(`lifecycle.${command === 'start' ? 'started' : 'restarted'}`))));
  });
}

test('declining a restart leaves the stale registration and stored database untouched', async t => {
  const fixture = await restartFixture(t, { command: 'restart' });
  const before = fs.readFileSync(fixture.database);
  const confirmation = t.mock.method(preview, 'confirmDisconnectingUsers', async () => false);
  await fixture.run();
  assert.equal(confirmation.mock.callCount(), 1);
  assert.deepEqual(fixture.actions, []);
  assert.equal(fixture.entry().pm2_env.pm_exec_path, `${fixture.expected}.old`);
  assert.deepEqual(fs.readFileSync(fixture.database), before);
});

test('explicit --fresh can still recreate a matching executable', async t => {
  const fixture = await restartFixture(t, { command: 'restart', changed: false });
  await fixture.run(['--fresh']);
  assert.deepEqual(fixture.actions, ['confirmed', 'delete', 'startOrRestart', 'save', 'registered']);
});

test('detailed status reads real legacy metadata without migrations and checks the running executable', async t => {
  const fixture = await restartFixture(t, { command: 'restart' });
  const before = fs.readFileSync(fixture.database);
  const diagnosis = t.mock.method(health, 'diagnoseServerHealth', async (_entry, _port, expected) => {
    assert.equal(expected, fixture.expected);
    return [];
  });
  await lifecycle.statusServerCommand({ dataDir: fixture.dataDir, dataDirSpecified: true, args: [] });
  assert.equal(diagnosis.mock.callCount(), 1);
  assert.ok(fixture.output.some(line => line.includes(translate('lifecycle.turnTitle'))));
  assert.deepEqual(fixture.actions, []);
  assert.deepEqual(fs.readFileSync(fixture.database), before);
});
