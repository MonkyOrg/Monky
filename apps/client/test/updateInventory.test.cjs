const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const initSqlJs = require('sql.js');
const { MonkyServer, readStoredUpdateInventory } = require('@monky/server');
const { SqlJsDriver } = require('../../server/dist/infrastructure/database/SqliteWrapper');

for (const oldSchema of [false, true]) {
  test(`stopped server inventory is a read-only snapshot, including offline bots (${oldSchema ? 'legacy' : 'current'})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-update-inventory-'));
    const dbPath = path.join(root, 'server.db');
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    try {
      db.exec(`CREATE TABLE server_meta (name TEXT);
        INSERT INTO server_meta VALUES ('Stopped server');
        CREATE TABLE bots (id TEXT, name TEXT${oldSchema ? '' : ', last_protocol_version INTEGER'});
        INSERT INTO bots VALUES ('music', 'Music'${oldSchema ? '' : ', 23'});
        INSERT INTO bots VALUES ('offline', 'Offline'${oldSchema ? '' : ', NULL'});`);
      fs.writeFileSync(dbPath, Buffer.from(db.export()));
      const before = fs.readFileSync(dbPath);
      const result = await readStoredUpdateInventory(dbPath);
      assert.deepEqual(result, {
        serverName: 'Stopped server',
        bots: [
          { id: 'music', name: 'Music', protocolVersion: oldSchema ? null : 23 },
          { id: 'offline', name: 'Offline', protocolVersion: null },
        ],
      });
      assert.deepEqual(fs.readFileSync(dbPath), before, 'Reading must not migrate, rewrite or flush a snapshot');
      assert.deepEqual(fs.readdirSync(root), ['server.db']);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('corrupt or missing local databases fail explicitly without creating new data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-update-inventory-'));
  try {
    const target = path.join(root, 'server.db');
    await assert.rejects(readStoredUpdateInventory(target), /ENOENT/);
    assert.deepEqual(fs.readdirSync(root), []);
    fs.writeFileSync(target, 'invalid sqlite');
    await assert.rejects(readStoredUpdateInventory(target));
    assert.equal(fs.readFileSync(target, 'utf8'), 'invalid sqlite');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a running server exposes unflushed bot records from its live database, without starting another server', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-update-inventory-'));
  const dbPath = path.join(root, 'server.db');
  const db = await SqlJsDriver.create(dbPath);
  try {
    db.exec(`CREATE TABLE server_meta (name TEXT);
      INSERT INTO server_meta VALUES ('Live server');
      CREATE TABLE bots (id TEXT, name TEXT, last_protocol_version INTEGER);
      INSERT INTO bots VALUES ('new', 'Just connected', 40);`);
    const result = MonkyServer.prototype.getUpdateInventory.call({ dbConn: { getDb: () => db } });
    assert.deepEqual(result, {
      serverName: 'Live server', bots: [{ id: 'new', name: 'Just connected', protocolVersion: 40 }],
    });
    await assert.rejects(readStoredUpdateInventory(dbPath), /server_meta/,
      'The disk snapshot deliberately does not yet contain the new live schema or bot');
  } finally {
    db.close({ discardChanges: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
