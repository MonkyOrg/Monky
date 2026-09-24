import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PROTOCOL_VERSION, MIN_BOT_PROTOCOL } from '@monky/shared';
import { BotService } from './application/services/BotService';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import {
  SqliteBotRepository, SqliteServerRepository, SqliteUserRepository,
} from './infrastructure/database/SqliteRepositories';
import { AvatarStorageService } from './infrastructure/security/AvatarStorageService';

test('legacy links remain unchecked after migration and protocol warnings survive database reopen', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-bot-compatibility-'));
  const dbPath = path.join(root, 'server.db');
  let connection: DatabaseConnection | null = null;
  t.after(() => {
    connection?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  connection = await DatabaseConnection.create(dbPath);
  await new SqliteUserRepository(connection.getDb()).create({
    id: 'fixture-owner', clientId: 'fixture-client', publicKey: 'synthetic-owner-key',
    nickname: 'Fixture owner', avatarPath: null, createdAt: 1, lastSeenAt: 1,
  });
  await new SqliteBotRepository(connection.getDb()).create({
    id: 'fixture-bot', name: 'Fixture bot', profilePending: false, tokenHash: BotService.hashToken('synthetic-token'),
    avatarPath: null, boundPublicKey: 'synthetic-bot-key', createdByUserId: 'fixture-owner', createdAt: 1,
  });
  const initial = connection;
  initial.getDb().transaction(() => {
    initial.getDb().exec('ALTER TABLE bots DROP COLUMN last_protocol_version');
    initial.getDb().prepare('DELETE FROM schema_migrations WHERE version = ?')
      .run('025_bot_protocol_compatibility.sql');
  })();
  connection.close();
  connection = null;
  const reopen = async () => {
    connection = await DatabaseConnection.create(dbPath);
    const repository = new SqliteBotRepository(connection.getDb());
    const service = new BotService(repository, new SqliteServerRepository(connection.getDb()),
      new AvatarStorageService(root), () => new Map());
    return { connection, repository, service };
  };
  let current = await reopen();
  assert.equal((await current.repository.findById('fixture-bot'))?.boundPublicKey, 'synthetic-bot-key');
  assert.deepEqual(await current.service.getCompatibility(), {
    protocolVersion: PROTOCOL_VERSION, incompatibleBots: 0, uncheckedBots: 1,
  });
  assert.equal(await current.service.recordRejectedProtocol('wrong-token', 'synthetic-bot-key', MIN_BOT_PROTOCOL - 1), false);
  assert.equal(await current.service.recordRejectedProtocol('synthetic-token', 'wrong-key', MIN_BOT_PROTOCOL - 1), false);
  assert.equal((await current.repository.findById('fixture-bot'))?.lastProtocolVersion, null);
  assert.equal(await current.service.recordRejectedProtocol('synthetic-token', 'synthetic-bot-key', MIN_BOT_PROTOCOL - 1), true);
  current.connection.close();
  connection = null;
  current = await reopen();
  assert.equal((await current.service.getCompatibility()).incompatibleBots, 1);
  assert.equal(await current.service.recordCompatibleConnection('fixture-bot'), true);
  assert.equal(await current.service.recordCompatibleConnection('revoked-bot'), false);
  current.connection.close();
  connection = null;
  current = await reopen();
  assert.equal((await current.repository.findById('fixture-bot'))?.lastProtocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(await current.service.getCompatibility(), {
    protocolVersion: PROTOCOL_VERSION, incompatibleBots: 0, uncheckedBots: 0,
  });
});
