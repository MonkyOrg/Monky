import assert from 'node:assert/strict';
import { listOnlineHumans } from './application/services/onlineHumans';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import {
  DEFAULT_PERMISSIONS,
  LIMITS,
  MessageType,
  Permission,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  ProtocolMessage,
  UserSummary,
  CommandAutocompletePayload,
  CommandSoundDownloadReceivedPayload,
  commandAutocompleteResultSchema,
  commandSoundDownloadReceivedSchema,
  commandSoundDownloadResultSchema,
  commandExecutionSchema,
  commandFinishedSchema,
  commandSubmitSchema,
  botSettingsSnapshotSchema,
  botSettingsListResponseSchema,
  botSelectorRespondedSchema,
  type BotSettingsDefinition,
  type BotSettingsPatch,
} from '@monky/shared';
import { AttachmentService } from './application/services/AttachmentService';
import { AuthService } from './application/services/AuthService';
import { BotService } from './application/services/BotService';
import { BotSelectorService } from './application/services/BotSelectorService';
import { BotSettingsService } from './application/services/BotSettingsService';
import { SqliteBotSettingsRepository } from './infrastructure/database/SqliteBotSettingsRepository';
import { SqliteBotSelectorRepository } from './infrastructure/database/SqliteBotSelectorRepository';
import { ChannelAccessContext, ChannelService } from './application/services/ChannelService';
import { ChatService } from './application/services/ChatService';
import type { MessageRecord } from './domain/entities';
import { CommandRegistry } from './application/services/CommandRegistry';
import { PermissionService } from './application/services/PermissionService';
import { RoleService } from './application/services/RoleService';
import { SignalingService } from './application/services/SignalingService';
import { UserService } from './application/services/UserService';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqliteVoiceRestrictionRepository } from './infrastructure/database/SqliteVoiceRestrictionRepository';
import { SqlJsDriver } from './infrastructure/database/SqliteWrapper';
import {
  SqliteAttachmentRepository,
  SqliteBotRepository,
  SqliteChannelRepository,
  SqliteMentionRepository,
  SqliteMessageRepository,
  SqliteRoleRepository,
  SqliteServerRepository,
  SqliteUserRepository,
} from './infrastructure/database/SqliteRepositories';
import { AttachmentStorageService } from './infrastructure/security/AttachmentStorageService';
import { AvatarStorageService } from './infrastructure/security/AvatarStorageService';
import { RateLimiter } from './infrastructure/security/RateLimiter';
import { SfuManager } from './infrastructure/sfu/SfuManager';
import { CoturnManager } from './infrastructure/turn/CoturnManager';
import { BotInteractionHandler, BotInteractionSession } from './infrastructure/websocket/BotInteractionHandler';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';
import { ensureServerSeedData } from './server';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const AUDIO_PREVIEW = { url: 'https://cdn.example.test/effect.mp3', fileName: 'effect.mp3', durationMs: 1200 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), 'expected an object payload');
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value.map(record);
}

function text(value: unknown): string {
  assert.equal(typeof value, 'string');
  assert.ok(typeof value === 'string');
  return value;
}

interface Received {
  type: string;
  requestId?: string;
  payload: Record<string, unknown>;
}

function readMessage(data: string): Received {
  const parsed: unknown = JSON.parse(data);
  const value = record(parsed);
  return {
    type: text(value.type),
    requestId: value.requestId === undefined ? undefined : text(value.requestId),
    payload: record(value.payload),
  };
}

function identity() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
  };
}

class Peer {
  readonly messages: Received[] = [];
  private listeners = new Set<(message: Received) => void>();

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const message = readMessage(data.toString());
      this.messages.push(message);
      for (const listener of this.listeners) listener(message);
    });
  }

  async wait(predicate: (message: Received) => boolean, since = 0): Promise<Received> {
    const existing = this.messages.slice(since).find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const listener = (message: Received) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(message);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timed out waiting for socket message; last types: ${this.messages.slice(-5).map((m) => m.type).join(', ')}`));
      }, 5000);
      this.listeners.add(listener);
    });
  }

  send(type: MessageType, payload: unknown, requestId?: string): void {
    this.ws.send(JSON.stringify({ type, payload, requestId }));
  }

  async request(type: MessageType, payload: unknown = {}): Promise<Received> {
    const requestId = randomUUID();
    const response = this.wait((message) => message.requestId === requestId);
    this.send(type, payload, requestId);
    return response;
  }

  async error(type: MessageType, payload: unknown, code: ProtocolErrorCode): Promise<void> {
    const response = await this.request(type, payload);
    assert.equal(response.type, MessageType.SERVER_ERROR);
    assert.equal(response.payload.code, code);
  }

  async barrier(): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    assert.equal((await this.request(MessageType.PING)).type, MessageType.PONG);
  }

  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = once(this.ws, 'close');
    this.ws.terminate();
    await closed;
  }
}

async function createFixture() {
  const dataDir = path.join(__dirname, '..', `.bot-test-data-${process.pid}-${randomUUID()}`);
  const database = await DatabaseConnection.create(path.join(dataDir, 'server.db'));
  const db = database.getDb();
  const serverRepo = new SqliteServerRepository(db);
  const userRepo = new SqliteUserRepository(db);
  const channelRepo = new SqliteChannelRepository(db);
  const messageRepo = new SqliteMessageRepository(db);
  const mentionRepo = new SqliteMentionRepository(db);
  const roleRepo = new SqliteRoleRepository(db);
  const botRepo = new SqliteBotRepository(db);
  const avatars = new AvatarStorageService(dataDir);
  const rateLimiter = new RateLimiter();
  const attachmentRepo = new SqliteAttachmentRepository(db);
  const attachmentService = new AttachmentService(
    attachmentRepo, serverRepo, new AttachmentStorageService(dataDir), rateLimiter
  );
  const permissions = new PermissionService(serverRepo, roleRepo);
  const roleService = new RoleService(roleRepo, userRepo, permissions);
  const channelService = new ChannelService(channelRepo, serverRepo, roleRepo, permissions);
  const registry = new CommandRegistry();
  let online: () => Map<string, { user: UserSummary }> = () => new Map();
  const userService = new UserService(userRepo, avatars, () => online());
  const botService = new BotService(botRepo, serverRepo, avatars, () => {
    const bots = new Map<string, UserSummary>();
    for (const { user } of online().values()) if (user.isBot) bots.set(user.id, user);
    return bots;
  });
  await ensureServerSeedData({ serverName: 'Bot tests', maxUsers: 10 }, serverRepo, channelRepo, roleRepo);
  const httpServer = http.createServer();
  const chatService = new ChatService(
    messageRepo, channelRepo, userRepo, mentionRepo, avatars, rateLimiter, attachmentService, serverRepo,
    (userId, channelId) => channelService.canUserAccessChannel(userId, channelId)
  );
  const wsServer = new WebSocketServer(
    httpServer,
    new AuthService(serverRepo, userRepo, channelRepo, mentionRepo, avatars, () => online(), attachmentService, permissions, roleService),
    userService,
    channelService,
    chatService,
    new SignalingService(channelRepo, new SqliteVoiceRestrictionRepository(db)),
    serverRepo,
    attachmentService,
    permissions,
    roleService,
    new CoturnManager(dataDir),
    new SfuManager(),
    botService,
    registry,
    new BotSelectorService(new SqliteBotSelectorRepository(database.getDb())),
    new BotSettingsService(new SqliteBotSettingsRepository(database.getDb()))
  );
  online = () => wsServer.getOnlineUsersMap();
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}`;
  const peers: Peer[] = [];
  const connect = async () => {
    const peer = new Peer(new WebSocket(url));
    peers.push(peer);
    await once(peer.ws, 'open');
    return peer;
  };
  const human = async (nickname: string, keys = identity(), deviceId = randomUUID(), appearOffline = false) => {
    const peer = await connect();
    const challenge = await peer.request(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION, nickname, publicKey: keys.publicKey, deviceId, appearOffline,
    });
    assert.equal(challenge.type, MessageType.AUTH_CHALLENGE);
    const signature = sign(null, Buffer.from(text(challenge.payload.nonce), 'hex'), keys.privateKey).toString('hex');
    const auth = await peer.request(MessageType.AUTH_CHALLENGE_RESPONSE, { signature });
    assert.equal(auth.type, MessageType.AUTH_SUCCESS);
    return { peer, keys, deviceId, id: text(record(auth.payload.currentUser).id), auth };
  };
  const bot = async (token: string, keys = identity(), name = 'SDK bot') => {
    const peer = await connect();
    const auth = await peer.request(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION, nickname: name, publicKey: keys.publicKey, botToken: token,
    });
    assert.equal(auth.type, MessageType.AUTH_SUCCESS);
    return { peer, keys, auth };
  };
  const dispose = async () => {
    wsServer.close();
    await Promise.all(peers.map((peer) => peer.close()));
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    rateLimiter.dispose();
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return {
    connect, human, bot, dispose, peers, wsServer, botService, botRepo, roleRepo, avatars,
    channelService, userService, registry, dataDir, messageRepo, channelRepo, userRepo, serverRepo, chatService, attachmentRepo,
    database, permissions,
  };
}

const SETTINGS_DEFINITION = {
  server: { title: 'Shared behavior', fields: [
    { name: 'count', label: 'Count', type: 'integer', min: 0, max: 10, required: true, defaultValue: 2 },
    { name: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: true },
  ] },
  user: { title: 'Individual preferences', fields: [
    { name: 'compact', label: 'Compact', type: 'boolean', defaultValue: true },
    { name: 'tags', label: 'Tags', type: 'string-list' },
  ] },
} satisfies BotSettingsDefinition;

async function createSettingsFixture(t: TestContext) {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const owner = await fixture.human('Settings owner');
  const alice = await fixture.human('Settings Alice');
  const bob = await fixture.human('Settings Bob');
  const channelId = text(records(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'TEXT')?.id);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const botId = text(record(created.payload.bot).id);
  const token = text(created.payload.token);
  const bot = await fixture.bot(token, undefined, 'Settings bot');
  const commands = [{
    name: 'run', description: 'Configured command',
    options: [{ name: 'query', description: 'Query', type: 'string', autocomplete: true }],
  }, { name: 'download', description: 'Download sound', downloadsSound: true }];
  assert.equal((await bot.peer.request(MessageType.COMMAND_REGISTER, {
    commands, settings: SETTINGS_DEFINITION,
  })).type, MessageType.COMMAND_REGISTERED);
  await bot.peer.barrier();
  const get = async (peer = owner.peer) => {
    const response = await peer.request(MessageType.BOT_SETTINGS_GET, { botId });
    assert.equal(response.type, MessageType.BOT_SETTINGS_SNAPSHOT);
    return botSettingsSnapshotSchema.parse(response.payload);
  };
  const update = async (patch: BotSettingsPatch, peer = owner.peer) => {
    const current = await get(peer);
    return peer.request(MessageType.BOT_SETTINGS_UPDATE, {
      botId, schemaRevision: current.bot.schemaRevision, expectedRevision: current.bot.revision, patch,
    });
  };
  return { ...fixture, connectBot: fixture.bot, owner, alice, bob, bot, botId, token, channelId, commands, get, update };
}

test('bot settings catalog separates configuration permissions, broadcasts safe revisions and retains offline declarations', async (t) => {
  const f = await createSettingsFixture(t);
  const publicSnapshot = await f.get(f.alice.peer);
  assert.equal(publicSnapshot.bot.canConfigure, false);
  assert.equal(publicSnapshot.bot.capabilities.downloadsSound, true);
  assert.deepEqual(publicSnapshot.definition, { user: SETTINGS_DEFINITION.user });
  assert.equal(publicSnapshot.server, undefined);
  const list = botSettingsListResponseSchema.parse((await f.alice.peer.request(MessageType.BOT_SETTINGS_LIST)).payload);
  assert.equal(list.bots[0].botId, f.botId);
  for (const key of ['token', 'tokenHash', 'bound', 'createdByUserId', 'definition', 'server']) {
    assert.equal(key in list.bots[0], false);
  }
  await f.alice.peer.error(MessageType.BOT_LIST, {}, ProtocolErrorCode.PERMISSION_DENIED);
  await f.alice.peer.error(MessageType.BOT_SETTINGS_UPDATE, {
    botId: f.botId, schemaRevision: publicSnapshot.bot.schemaRevision, expectedRevision: publicSnapshot.bot.revision,
    patch: { count: 4 },
  }, ProtocolErrorCode.PERMISSION_DENIED);
  const configRole = { id: randomUUID(), name: 'Configurators', color: null, position: 1,
    permissions: Permission.CONFIGURE_BOTS, isDefault: false, createdAt: Date.now() };
  const manageRole = { ...configRole, id: randomUUID(), name: 'Bot managers', permissions: Permission.MANAGE_BOTS };
  await f.roleRepo.create(configRole);
  await f.roleRepo.create(manageRole);
  await f.owner.peer.request(MessageType.ROLE_ASSIGN, { userId: f.bob.id, roleId: configRole.id });
  await f.owner.peer.request(MessageType.ROLE_ASSIGN, { userId: f.alice.id, roleId: manageRole.id });
  await f.owner.peer.barrier();
  assert.equal((await f.get(f.bob.peer)).bot.canConfigure, true);
  assert.equal((await f.get(f.alice.peer)).server, undefined);
  await f.bob.peer.error(MessageType.BOT_CREATE, {}, ProtocolErrorCode.PERMISSION_DENIED);
  await f.bob.peer.error(MessageType.BOT_REVOKE, { botId: f.botId }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.bob.peer.error(MessageType.BOT_UPDATE_PROFILE, { botId: f.botId, name: 'No rename' }, ProtocolErrorCode.PERMISSION_DENIED);
  const since = f.alice.peer.messages.length;
  const saved = botSettingsSnapshotSchema.parse((await f.update({ count: 0, enabled: false }, f.bob.peer)).payload);
  assert.deepEqual(saved.server?.values, { count: 0, enabled: false });
  const broadcast = await f.alice.peer.wait((message) => message.type === MessageType.BOT_SETTINGS_LIST_RESPONSE &&
    records(message.payload.bots).some((entry) => entry.botId === f.botId && entry.revision === saved.bot.revision), since);
  const safe = botSettingsListResponseSchema.parse(broadcast.payload).bots.find((entry) => entry.botId === f.botId);
  assert.ok(safe && !safe.canConfigure);
  await f.bob.peer.barrier();
  assert.equal(f.alice.peer.messages.slice(since).some((message) => message.type === MessageType.BOT_SETTINGS_SNAPSHOT), false);
  await f.bot.peer.error(MessageType.BOT_SETTINGS_UPDATE, {
    botId: f.botId, schemaRevision: saved.bot.schemaRevision, expectedRevision: saved.bot.revision, patch: { count: 1 },
  }, ProtocolErrorCode.PERMISSION_DENIED);
  const other = await f.owner.peer.request(MessageType.BOT_CREATE, {});
  await f.bot.peer.error(MessageType.BOT_SETTINGS_GET, { botId: record(other.payload.bot).id }, ProtocolErrorCode.PERMISSION_DENIED);
  const offlineSince = f.bob.peer.messages.length;
  await f.bot.peer.close();
  await f.bob.peer.wait((message) => message.type === MessageType.BOT_SETTINGS_LIST_RESPONSE &&
    records(message.payload.bots).some((entry) => entry.botId === f.botId && entry.online === false), offlineSince);
  const offline = await f.get(f.bob.peer);
  assert.equal(offline.bot.online, false);
  assert.deepEqual(offline.server?.values, { count: 0, enabled: false });
  assert.equal(offline.bot.capabilities.downloadsSound, true);
  assert.equal(f.registry.find(f.botId, 'run'), undefined);
  const newValues = botSettingsSnapshotSchema.parse((await f.update({ count: 4 }, f.bob.peer)).payload);
  const restored = await f.connectBot(f.token, f.bot.keys);
  const registration = await restored.peer.request(MessageType.COMMAND_REGISTER, { commands: f.commands, settings: SETTINGS_DEFINITION });
  assert.deepEqual(record(registration.payload.settings).values, newValues.server?.values);
  await f.owner.peer.request(MessageType.ROLE_UNASSIGN, { userId: f.bob.id, roleId: configRole.id });
  assert.equal((await f.get(f.bob.peer)).server, undefined);
  await f.owner.peer.request(MessageType.BOT_REVOKE, { botId: f.botId });
  assert.equal(botSettingsListResponseSchema.parse((await f.alice.peer.request(MessageType.BOT_SETTINGS_LIST)).payload)
    .bots.some((entry) => entry.botId === f.botId), false);
  assert.equal(f.database.getDb().prepare('SELECT bot_id FROM bot_settings WHERE bot_id = ?').get(f.botId), undefined);
});

test('bot settings reject incompatible registration atomically and support explicit resets and compare-and-set edits', async (t) => {
  const f = await createSettingsFixture(t);
  const initial = await f.get();
  assert.equal((await f.update({ count: 7 })).type, MessageType.BOT_SETTINGS_SNAPSHOT);
  const saved = await f.get();
  assert.equal(saved.bot.schemaRevision, initial.bot.schemaRevision);
  assert.ok(saved.bot.revision > initial.bot.revision);
  const tighter: BotSettingsDefinition = {
    ...SETTINGS_DEFINITION,
    server: { ...SETTINGS_DEFINITION.server, fields: SETTINGS_DEFINITION.server.fields.map((field) =>
      field.type === 'integer' ? { ...field, max: 3 } : field) },
  };
  const originalCommand = f.registry.find(f.botId, 'run');
  const rejected = await f.bot.peer.request(MessageType.COMMAND_REGISTER, {
    commands: [{ name: 'replacement', description: 'Must not replace' }], settings: tighter,
  });
  assert.equal(rejected.payload.code, ProtocolErrorCode.BOT_SETTINGS_INVALID);
  assert.match(text(rejected.payload.message), /count.*Reset/s);
  assert.equal(f.registry.find(f.botId, 'run'), originalCommand);
  assert.deepEqual(await f.get(), saved);
  await f.bot.peer.error(MessageType.COMMAND_REGISTER, { commands: [] }, ProtocolErrorCode.BOT_SETTINGS_INVALID);
  await f.owner.peer.error(MessageType.BOT_SETTINGS_UPDATE, {
    botId: f.botId, schemaRevision: saved.bot.schemaRevision, expectedRevision: saved.bot.revision,
    patch: { count: 8, enabled: 'not-a-boolean' },
  }, ProtocolErrorCode.BOT_SETTINGS_INVALID);
  assert.deepEqual((await f.get()).server, saved.server);
  await f.owner.peer.error(MessageType.BOT_SETTINGS_UPDATE, {
    botId: f.botId, schemaRevision: initial.bot.schemaRevision, expectedRevision: initial.bot.revision, patch: { count: 1 },
  }, ProtocolErrorCode.BOT_SETTINGS_CONFLICT);
  const [first, second] = await Promise.all([4, 5].map((count) => f.owner.peer.request(MessageType.BOT_SETTINGS_UPDATE, {
    botId: f.botId, schemaRevision: saved.bot.schemaRevision, expectedRevision: saved.bot.revision, patch: { count },
  })));
  assert.equal(first.type, MessageType.BOT_SETTINGS_SNAPSHOT);
  assert.equal(second.payload.code, ProtocolErrorCode.BOT_SETTINGS_CONFLICT);
  const noOpBefore = await f.get();
  const noOp = botSettingsSnapshotSchema.parse((await f.update({ count: 4 })).payload);
  assert.equal(noOp.bot.revision, noOpBefore.bot.revision);
  await f.update({ count: null });
  const reset = await f.get();
  assert.equal((await f.bot.peer.request(MessageType.COMMAND_REGISTER, { commands: f.commands, settings: tighter })).type,
    MessageType.COMMAND_REGISTERED);
  const changed = await f.get();
  assert.ok(changed.bot.schemaRevision > reset.bot.schemaRevision);
  assert.equal(changed.server?.values.count, 2);
  await f.owner.peer.error(MessageType.BOT_SETTINGS_UPDATE, {
    botId: f.botId, schemaRevision: reset.bot.schemaRevision, expectedRevision: changed.bot.revision, patch: { count: 1 },
  }, ProtocolErrorCode.BOT_SETTINGS_CONFLICT);
  const defaultChange: BotSettingsDefinition = { ...tighter,
    server: { title: 'New default', fields: [{ name: 'count', label: 'Count', type: 'integer', defaultValue: 3 }] } };
  assert.equal((await f.bot.peer.request(MessageType.COMMAND_REGISTER, { commands: f.commands, settings: defaultChange })).type,
    MessageType.COMMAND_REGISTERED);
  assert.equal((await f.get()).server?.values.count, 3);
  assert.equal((await f.bot.peer.request(MessageType.COMMAND_REGISTER, { commands: f.commands })).type, MessageType.COMMAND_REGISTERED);
  const empty = await f.get(f.alice.peer);
  assert.deepEqual(empty.definition, {});
  assert.equal(empty.bot.hasUserSettings, false);
  assert.equal(empty.bot.hasServerSettings, false);
  assert.equal(empty.bot.capabilities.downloadsSound, true);
});

test('bot settings validate private raw preferences for commands, autocomplete and independent selector responses', async (t) => {
  const f = await createSettingsFixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const invocation = await f.alice.peer.request(MessageType.COMMAND_INVOKE, {
    botId: f.botId, channelId: f.channelId, commandName: 'run', userSettings: { compact: false, tags: ['PRIVATE-ALICE'] },
  });
  const id = text(invocation.payload.invocationId);
  const execution = commandExecutionSchema.parse((await f.bot.peer.wait((message) =>
    message.type === MessageType.COMMAND_INVOKE && message.payload.invocationId === id)).payload);
  assert.deepEqual(execution.settings?.user, { compact: false, tags: ['PRIVATE-ALICE'] });
  assert.deepEqual(execution.settings?.server, { count: 2, enabled: true });
  assert.equal('userSettings' in execution, false);
  const second = await f.bob.peer.request(MessageType.COMMAND_INVOKE, {
    botId: f.botId, channelId: f.channelId, commandName: 'run',
  });
  const secondExecution = commandExecutionSchema.parse((await f.bot.peer.wait((message) =>
    message.type === MessageType.COMMAND_INVOKE && message.payload.invocationId === second.payload.invocationId)).payload);
  assert.deepEqual(secondExecution.settings?.user, { compact: true });
  for (const userSettings of [{ compact: 'false' }, { host: true }, { tags: ['a', ' A '] }]) {
    await f.alice.peer.error(MessageType.COMMAND_INVOKE, {
      botId: f.botId, channelId: f.channelId, commandName: 'run', userSettings,
    }, ProtocolErrorCode.BOT_SETTINGS_INVALID);
  }
  f.bot.peer.send(MessageType.COMMAND_PROMPT, {
    invocationId: id, interactionId: 'settings-form', form: {
      title: 'Next step', fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }],
    },
  });
  await f.alice.peer.wait((message) => message.type === MessageType.COMMAND_PROMPT && message.payload.invocationId === id);
  await f.update({ count: 5 });
  await f.alice.peer.error(MessageType.COMMAND_SUBMIT, {
    invocationId: id, interactionId: 'settings-form', values: { answer: 'ok' }, userSettings: { compact: true },
  }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
  const submitted = await f.alice.peer.request(MessageType.COMMAND_SUBMIT, {
    invocationId: id, interactionId: 'settings-form', values: { answer: 'ok' },
  });
  assert.equal('settings' in submitted.payload, false);
  assert.equal('userSettings' in submitted.payload, false);
  assert.equal(execution.settings?.server.count, 2);
  now += LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS;
  const requestId = randomUUID();
  f.alice.peer.send(MessageType.COMMAND_AUTOCOMPLETE, {
    botId: f.botId, channelId: f.channelId, commandName: 'run', optionName: 'query', query: 'settings',
    userSettings: { compact: false },
  }, requestId);
  const autocomplete = await f.bot.peer.wait((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE);
  assert.deepEqual(record(autocomplete.payload.settings).user, { compact: false });
  assert.deepEqual(record(autocomplete.payload.settings).server, { count: 5, enabled: true });
  assert.equal('userSettings' in autocomplete.payload, false);
  await f.update({ count: 6 });
  assert.equal((await f.alice.peer.wait((message) => message.requestId === requestId)).payload.code, ProtocolErrorCode.BOT_SETTINGS_CONFLICT);
  now += LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS;
  await f.bob.peer.error(MessageType.COMMAND_AUTOCOMPLETE, {
    botId: f.botId, channelId: f.channelId, commandName: 'run', optionName: 'query', query: '',
    userSettings: { compact: 'invalid' },
  }, ProtocolErrorCode.BOT_SETTINGS_INVALID);
  const selector = await f.bot.peer.request(MessageType.SELECTOR_CREATE, {
    channelId: f.channelId, title: 'Independent', choices: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
    presentation: 'buttons', responder: 'any', allowChange: true, maxResponders: 5,
  });
  const selectorId = text(selector.payload.id);
  const publicList = await f.alice.peer.request(MessageType.SELECTOR_LIST, { channelId: f.channelId });
  assert.equal(records(publicList.payload.selectors)[0].botId, f.botId);
  const since = f.bot.peer.messages.length;
  const response = await f.alice.peer.request(MessageType.SELECTOR_RESPOND, {
    id: selectorId, value: 'a', userSettings: { compact: false, tags: ['PRIVATE-SELECTOR'] },
  });
  assert.equal('settings' in response.payload, false);
  const event = botSelectorRespondedSchema.parse((await f.bot.peer.wait((message) =>
    message.type === MessageType.SELECTOR_RESPONDED && message.payload.id === selectorId, since)).payload);
  assert.equal(event.userId, f.alice.id);
  assert.deepEqual(event.settings?.user, { compact: false, tags: ['PRIVATE-SELECTOR'] });
  assert.equal(event.settings?.server.count, 6);
  await f.alice.peer.request(MessageType.SELECTOR_RESPOND, { id: selectorId, value: 'a', userSettings: {} });
  await f.bot.peer.barrier();
  assert.equal(f.bot.peer.messages.slice(since).filter((message) => message.type === MessageType.SELECTOR_RESPONDED).length, 1);
  assert.equal(f.bob.peer.messages.some((message) => message.type === MessageType.SELECTOR_RESPONDED), false);
  const stored = record(f.database.getDb().prepare('SELECT snapshot FROM bot_selectors WHERE id = ?').get(selectorId));
  assert.equal(text(stored.snapshot).includes('PRIVATE-SELECTOR'), false);
  await f.bob.peer.error(MessageType.SELECTOR_RESPOND, {
    id: selectorId, value: 'b', userSettings: { unknown: true },
  }, ProtocolErrorCode.BOT_SETTINGS_INVALID);
  await f.bot.peer.close();
  assert.equal((await f.bob.peer.request(MessageType.SELECTOR_RESPOND, {
    id: selectorId, value: 'b', userSettings: { compact: true },
  })).type, MessageType.SELECTOR_SNAPSHOT);
});

test('bot settings reject stale sessions and recheck permissions changed during authorization', async (t) => {
  const f = await createSettingsFixture(t);
  const role = { id: randomUUID(), name: 'Settings writers', color: null, position: 1,
    permissions: Permission.CONFIGURE_BOTS, isDefault: false, createdAt: Date.now() };
  await f.roleRepo.create(role);
  await f.owner.peer.request(MessageType.ROLE_ASSIGN, { userId: f.alice.id, roleId: role.id });
  await f.owner.peer.barrier();
  const snapshot = await f.get(f.alice.peer);
  const original = f.permissions.checkPermission.bind(f.permissions);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let paused = false;
  t.mock.method(f.permissions, 'checkPermission', async (userId: string, permission: Permission) => {
    const allowed = await original(userId, permission);
    if (userId === f.alice.id && permission === Permission.CONFIGURE_BOTS && !paused) {
      paused = true;
      entered();
      await gate;
    }
    return allowed;
  });
  const read = f.alice.peer.request(MessageType.BOT_SETTINGS_GET, { botId: f.botId });
  await waiting;
  await f.owner.peer.request(MessageType.ROLE_UNASSIGN, { userId: f.alice.id, roleId: role.id });
  await f.owner.peer.barrier();
  release();
  assert.equal(botSettingsSnapshotSchema.parse((await read).payload).server, undefined);
  assert.deepEqual((await f.get()).server, snapshot.server);
  t.mock.restoreAll();
  await f.owner.peer.request(MessageType.ROLE_ASSIGN, { userId: f.alice.id, roleId: role.id });
  await f.owner.peer.barrier();
  paused = false;
  const writeGate = new Promise<void>((resolve) => { release = resolve; });
  const writeWaiting = new Promise<void>((resolve) => { entered = resolve; });
  t.mock.method(f.permissions, 'checkPermission', async (userId: string, permission: Permission) => {
    const allowed = await original(userId, permission);
    if (userId === f.alice.id && permission === Permission.CONFIGURE_BOTS && !paused) {
      paused = true; entered(); await writeGate;
    }
    return allowed;
  });
  f.alice.peer.send(MessageType.BOT_SETTINGS_UPDATE, {
    botId: f.botId, schemaRevision: snapshot.bot.schemaRevision, expectedRevision: snapshot.bot.revision, patch: { count: 9 },
  }, 'stale-settings-write');
  await writeWaiting;
  const replacement = await f.human('Settings Alice', f.alice.keys, f.alice.deviceId);
  release();
  await replacement.peer.barrier();
  assert.deepEqual((await f.get()).server, snapshot.server);
});

test('bot settings selector events revalidate creator access after responder authorization', async (t) => {
  const f = await createSettingsFixture(t);
  const role = { id: randomUUID(), name: 'Private settings', color: null, position: 1,
    permissions: 0, isDefault: false, createdAt: Date.now() };
  await f.roleRepo.create(role);
  await f.roleRepo.assignRole(f.alice.id, role.id);
  await f.roleRepo.assignRole(f.bob.id, role.id);
  const channel = await f.owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'private-settings', type: 'TEXT', isPrivate: true, allowedRoleIds: [role.id],
  });
  const channelId = text(record(channel.payload.channel).id);
  const invocation = await f.alice.peer.request(MessageType.COMMAND_INVOKE, {
    botId: f.botId, commandName: 'run', channelId,
  });
  const invocationId = text(invocation.payload.invocationId);
  const selector = await f.bot.peer.request(MessageType.SELECTOR_CREATE, {
    invocationId, channelId, title: 'Private response',
    choices: [{ label: 'A', value: 'a' }], presentation: 'buttons', responder: 'any', allowChange: true, maxResponders: 5,
  });
  const id = text(selector.payload.id);
  await f.bot.peer.request(MessageType.COMMAND_FINISH, { invocationId });
  const original = f.channelService.getAccessContext.bind(f.channelService);
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let paused = false;
  t.mock.method(f.channelService, 'getAccessContext', async (userId: string) => {
    const context = await original(userId);
    if (userId === f.bob.id && !paused) {
      paused = true;
      entered();
      await gate;
    }
    return context;
  });
  const since = f.bot.peer.messages.length;
  const response = f.bob.peer.request(MessageType.SELECTOR_RESPOND, {
    id, value: 'a', userSettings: { tags: ['PRIVATE-REVOKED'] },
  });
  await waiting;
  await f.owner.peer.request(MessageType.ROLE_UNASSIGN, { userId: f.alice.id, roleId: role.id });
  await f.owner.peer.barrier();
  release();
  assert.equal((await response).type, MessageType.SELECTOR_SNAPSHOT);
  await f.bot.peer.barrier();
  assert.equal(f.bot.peer.messages.slice(since).some((message) => message.type === MessageType.SELECTOR_RESPONDED), false);
});

test('bot settings selector responses wait for registration hydration without consuming the response', async (t) => {
  const f = await createSettingsFixture(t);
  const selector = await f.bot.peer.request(MessageType.SELECTOR_CREATE, {
    channelId: f.channelId, title: 'Reconnect response', choices: [{ label: 'A', value: 'a' }],
    presentation: 'buttons', responder: 'any', allowChange: false, maxResponders: 1,
  });
  const id = text(selector.payload.id);
  await f.bot.peer.close();
  const reconnect = await f.connectBot(f.token, f.bot.keys);
  await f.alice.peer.error(MessageType.SELECTOR_RESPOND, {
    id, value: 'a', userSettings: { compact: false },
  }, ProtocolErrorCode.BOT_COMMAND_BUSY);
  const list = await f.alice.peer.request(MessageType.SELECTOR_LIST, { channelId: f.channelId });
  assert.equal(records(list.payload.selectors).find((item) => item.id === id)?.responseCount, 0);
  const registered = await reconnect.peer.request(MessageType.COMMAND_REGISTER, { commands: f.commands, settings: SETTINGS_DEFINITION });
  assert.equal(registered.type, MessageType.COMMAND_REGISTERED);
  assert.equal((await f.alice.peer.request(MessageType.SELECTOR_RESPOND, {
    id, value: 'a', userSettings: { compact: false },
  })).type, MessageType.SELECTOR_SNAPSHOT);
  const delivered = await reconnect.peer.wait((message) => message.type === MessageType.SELECTOR_RESPONDED && message.payload.id === id);
  assert.deepEqual(botSelectorRespondedSchema.parse(delivered.payload).settings?.user, { compact: false });
  assert.ok(reconnect.peer.messages.indexOf(registered) < reconnect.peer.messages.indexOf(delivered));
});

test('bot settings migration preserves revisions and overrides across database reopen and deletes revoked metadata', async (t) => {
  const dataDir = path.join(__dirname, '..', `.bot-settings-data-${process.pid}-${randomUUID()}`);
  const filename = path.join(dataDir, 'server.db');
  let database = await DatabaseConnection.create(filename);
  t.after(() => { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new SqliteUserRepository(database.getDb()).create({
    id: 'owner', clientId: 'owner', publicKey: null, nickname: 'Owner', avatarPath: null, createdAt: 0, lastSeenAt: 0,
  });
  await new SqliteBotRepository(database.getDb()).create({
    id: 'persisted', name: 'Persisted bot', tokenHash: 'test-hash', avatarPath: null, boundPublicKey: null,
    createdByUserId: 'owner', createdAt: 0, profilePending: false,
  });
  let repository = new SqliteBotSettingsRepository(database.getDb());
  let service = new BotSettingsService(repository);
  const registered = service.register('persisted', SETTINGS_DEFINITION, true);
  const changed = service.update({ botId: 'persisted', schemaRevision: registered.schemaRevision,
    expectedRevision: registered.revision, patch: { count: 0, enabled: false } });
  const before = repository.findById('persisted');
  database.close();
  database = await DatabaseConnection.create(filename);
  repository = new SqliteBotSettingsRepository(database.getDb());
  service = new BotSettingsService(repository);
  assert.deepEqual(repository.findById('persisted'), before);
  assert.deepEqual(service.register('persisted', SETTINGS_DEFINITION, true), changed);
  assert.deepEqual(service.context('persisted', { compact: false })?.server, { count: 0, enabled: false });
  assert.equal(record(database.getDb().prepare('SELECT count(*) AS count FROM schema_migrations WHERE version = ?')
    .get('023_bot_settings.sql')).count, 1);
  await new SqliteBotRepository(database.getDb()).delete('persisted');
  assert.equal(repository.findById('persisted'), undefined);
  assert.equal(record(database.getDb().prepare('SELECT count(*) AS count FROM bot_settings').get()).count, 0);
});

test('bot identity migration preserves legacy profiles and persists new pending links across restart', async (t) => {
  const dataDir = path.join(__dirname, '..', `.bot-profile-data-${process.pid}-${randomUUID()}`);
  const filename = path.join(dataDir, 'server.db');
  let database = await DatabaseConnection.create(filename);
  t.after(() => { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new SqliteUserRepository(database.getDb()).create({
    id: 'owner', clientId: 'owner', publicKey: null, nickname: 'Owner', avatarPath: null, createdAt: 0, lastSeenAt: 0,
  });
  const legacy = {
    id: 'legacy', name: 'Existing identity', tokenHash: BotService.hashToken('legacy-token'),
    avatarPath: 'legacy-avatar.png', boundPublicKey: identity().publicKey,
    createdByUserId: 'owner', createdAt: 123, profilePending: false,
  };
  await new SqliteBotRepository(database.getDb()).create(legacy);
  // Reopen the populated database with the schema immediately before this migration.
  database.getDb().exec('ALTER TABLE bots DROP COLUMN profile_pending');
  database.getDb().prepare('DELETE FROM schema_migrations WHERE version = ?').run('024_bot_profile_authority.sql');
  database.close();
  database = await DatabaseConnection.create(filename);
  const repository = new SqliteBotRepository(database.getDb());
  assert.deepEqual(await repository.findById(legacy.id), legacy);
  assert.equal(record(database.getDb().prepare('SELECT count(*) AS count FROM schema_migrations WHERE version = ?')
    .get('024_bot_profile_authority.sql')).count, 1);
  const service = new BotService(repository, new SqliteServerRepository(database.getDb()),
    new AvatarStorageService(dataDir), () => new Map<string, UserSummary>());
  const pending = await service.create('owner');
  assert.equal(pending.success, true);
  assert.ok(pending.success);
  assert.equal(pending.bot.profilePending, true);
  assert.equal(pending.bot.avatarUrl, null);
  const before = await repository.findById(pending.bot.id);
  assert.ok(before);
  assert.equal(before.tokenHash, BotService.hashToken(pending.token));
  database.close();
  database = await DatabaseConnection.create(filename);
  const restored = new SqliteBotRepository(database.getDb());
  assert.deepEqual(await restored.findById(legacy.id), legacy);
  assert.deepEqual(await restored.findById(pending.bot.id), before);
});

test('human counts exclude bot accounts and collapse multiple devices without changing the online bot map', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const owner = await fixture.human('Human counter');
  const second = await fixture.human('Human counter', owner.keys);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const bot = await fixture.bot(text(created.payload.token));
  const people = () => listOnlineHumans(fixture.wsServer.getOnlineUsersMap().values());
  assert.equal(fixture.wsServer.getOnlineUsersMap().size, 3);
  assert.deepEqual(people().map((user) => user.id), [owner.id]);
  await owner.peer.close();
  assert.equal(people().length, 1);
  await second.peer.close();
  await bot.peer.wait((message) => message.type === MessageType.USER_CONNECTION_STATE &&
    message.payload.sessionId === record(second.auth.payload.currentUser).sessionId &&
    message.payload.status === 'reconnecting');
  assert.equal(people().length, 0);
  assert.ok([...fixture.wsServer.getOnlineUsersMap().values()].some(({ user }) => user.isBot));
});

test('invisibility updates presence without fake disconnection and survives profile edits and new devices', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const owner = await fixture.human('Invisible owner');
  const sibling = await fixture.human('Invisible owner', owner.keys);
  const observer = await fixture.human('Presence observer');
  const channels = records(record(owner.auth.payload.server).channels);
  const voiceId = text(channels.find((channel) => channel.type === 'VOICE')?.id);
  await owner.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId });
  const since = observer.peer.messages.length;
  const update = await owner.peer.request(MessageType.USER_UPDATE_VISIBILITY, { appearOffline: true });
  assert.equal(record(update.payload.user).invisible, true);
  const hidden = await observer.peer.wait((message) =>
    message.type === MessageType.USER_UPDATED && record(message.payload.user).id === owner.id, since);
  assert.equal(record(hidden.payload.user).status, 'DISCONNECTED');
  assert.equal(record(hidden.payload.user).invisible, undefined);
  await observer.peer.barrier();
  assert.equal(observer.peer.messages.slice(since).some((message) =>
    message.type === MessageType.USER_LEFT || message.type === MessageType.VOICE_USER_LEFT), false);
  assert.equal(fixture.wsServer.getOnlineUsersMap().size, 3);
  assert.equal(fixture.wsServer.getVisibleOnlineUsersMap().size, 1);
  assert.ok(sibling.peer.messages.some((message) =>
    message.type === MessageType.USER_UPDATED && record(message.payload.user).invisible === true));

  const fresh = await fixture.human('New observer');
  const snapshot = record(fresh.auth.payload.server);
  assert.equal(records(snapshot.members).some((member) => member.id === owner.id), false);
  assert.equal(records(snapshot.knownMembers).find((member) => member.id === owner.id)?.status, 'DISCONNECTED');
  const beforeRename = observer.peer.messages.length;
  await owner.peer.request(MessageType.USER_CHANGE_NICKNAME, { newNickname: 'Still invisible' });
  const renamed = await observer.peer.wait((message) =>
    message.type === MessageType.USER_UPDATED && record(message.payload.user).nickname === 'Still invisible', beforeRename);
  assert.equal(record(renamed.payload.user).status, 'DISCONNECTED');
  assert.ok([...fixture.wsServer.getOnlineUsersMap().values()]
    .filter(({ user }) => user.id === owner.id).every(({ user }) => user.invisible));

  await sibling.peer.request(MessageType.USER_UPDATE_VISIBILITY, { appearOffline: false });
  await observer.peer.barrier();
  assert.equal(fixture.wsServer.getVisibleOnlineUsersMap().size, 4);
  await fixture.human('Still invisible', owner.keys, randomUUID(), true);
  assert.equal(fixture.wsServer.getVisibleOnlineUsersMap().size, 2);
  await owner.peer.error(MessageType.USER_UPDATE_VISIBILITY, { appearOffline: 'false' }, ProtocolErrorCode.BAD_REQUEST);
});

function hasInvocation(message: Received, type: MessageType, id: string): boolean {
  return message.type === type && message.payload.invocationId === id;
}

test('public selectors persist responses, expire across restart and count distinct voters atomically', async () => {
  const dbPath = path.join(__dirname, '..', `.selector-test-${randomUUID()}.db`);
  let db = await SqlJsDriver.create(dbPath);
  try {
    db.exec(`CREATE TABLE bot_selectors (
      id TEXT PRIMARY KEY, bot_id TEXT, channel_id TEXT, snapshot TEXT, closed_at INTEGER, expires_at INTEGER
    )`);
    let selectors = new BotSelectorService(new SqliteBotSelectorRepository(db));
    const input = {
      id: 'durable-poll', channelId: 'text', title: 'Choose?', choices: [
        { label: 'A', value: 'a', description: 'Preview A', audio: AUDIO_PREVIEW }, { label: 'B', value: 'b' },
      ], presentation: 'buttons' as const, responder: 'any' as const, allowChange: true,
      expiresAt: 2000, maxResponders: 2,
    };
    const first = selectors.create('bot', input, 1000);
    const scoped = selectors.create('bot', { ...input, id: 'scoped', invocationId: 'authorized-invocation' }, 1000, 'alice');
    assert.equal(scoped.creatorUserId, 'alice');
    assert.equal(scoped.invokerId, 'alice');
    assert.equal(selectors.create('bot', input, 1000).messageId, first.messageId);
    selectors.respond(first.id, 'alice', 'a', 1001);
    selectors.respond(first.id, 'alice', 'b', 1002);
    assert.deepEqual(selectors.get(first.id)?.responses, { alice: 'b' });
    assert.equal(selectors.get(first.id)?.closedAt, null);
    db.close();
    db = await SqlJsDriver.create(dbPath);
    selectors = new BotSelectorService(new SqliteBotSelectorRepository(db));
    assert.equal(selectors.get(scoped.id)?.creatorUserId, 'alice');
    assert.equal(selectors.get(scoped.id)?.sourceInvocationId, 'authorized-invocation');
    assert.deepEqual(selectors.get(first.id)?.choices[0].audio, AUDIO_PREVIEW);
    assert.deepEqual(selectors.get(first.id)?.responses, { alice: 'b' });
    const closed = selectors.respond(first.id, 'bob', 'a', 1003);
    assert.equal(closed.closedAt, 1003);
    assert.throws(() => selectors.respond(first.id, 'alice', 'a', 1004));
    assert.throws(() => selectors.update(first.id, 'bot', { maxResponders: 3 }, 1004));
    assert.equal(selectors.markFinalized(first.id, 'bot', 'final-one').resultMessageId, 'final-one');
    assert.equal(selectors.markFinalized(first.id, 'bot', 'final-two').resultMessageId, 'final-one');
    const timed = selectors.create('bot', { ...input, id: 'timed', maxResponders: undefined }, 1000);
    assert.throws(() => selectors.respond(timed.id, 'alice', 'a', 2000));
    assert.equal(selectors.expire(2500)[0].closedAt, 2000);
    assert.deepEqual(selectors.get(timed.id)?.responses, {});
    const privateResponder = selectors.create('bot', {
      ...input, id: 'invoker-only', responder: 'invoker', invokerId: 'alice', allowChange: false,
    }, 1000);
    assert.throws(() => selectors.respond(privateResponder.id, 'bob', 'a', 1001));
    selectors.respond(privateResponder.id, 'alice', 'a', 1001);
    assert.throws(() => selectors.respond(privateResponder.id, 'alice', 'b', 1002));
    assert.throws(() => selectors.close(privateResponder.id, 'another-bot', 1002));
    assert.equal(selectors.close(privateResponder.id, 'bot', 1002).closedAt, 1002);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
});

test('public selectors publish durable controls, enforce permissions and finalize only once', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const owner = await fixture.human('Selector owner');
  const alice = await fixture.human('Selector Alice');
  const bob = await fixture.human('Selector Bob');
  const channelId = text(records(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'TEXT')?.id);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const bot = await fixture.bot(text(created.payload.token));
  const input = {
    id: randomUUID(), channelId, title: 'Choose A or B', choices: [
      { label: 'A', value: 'a', description: 'Preview A', audio: AUDIO_PREVIEW }, { label: 'B', value: 'b' },
    ], presentation: 'buttons', responder: 'any', allowChange: true, maxResponders: 2,
    metadata: { kind: 'poll', locale: 'en' },
  };
  const published = await bot.peer.request(MessageType.SELECTOR_CREATE, input);
  assert.equal(published.type, MessageType.SELECTOR_SNAPSHOT);
  assert.deepEqual(record(records(published.payload.choices)[0]).audio, AUDIO_PREVIEW);
  const id = text(published.payload.id);
  const messageId = text(published.payload.messageId);
  const replay = await bot.peer.request(MessageType.SELECTOR_CREATE, input);
  assert.equal(replay.payload.messageId, messageId);
  const history = await owner.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId });
  assert.equal(records(history.payload.messages).filter((message) => message.id === messageId).length, 1);
  const publicList = await alice.peer.request(MessageType.SELECTOR_LIST, { channelId });
  const publicSnapshot = records(publicList.payload.selectors)[0];
  assert.equal('responses' in publicSnapshot, false);
  assert.equal('metadata' in publicSnapshot, false);
  assert.deepEqual(record(records(publicSnapshot.choices)[0]).audio, AUDIO_PREVIEW);
  await bot.peer.error(MessageType.SELECTOR_RESPOND, { id, value: 'a' }, ProtocolErrorCode.PERMISSION_DENIED);
  await alice.peer.request(MessageType.SELECTOR_RESPOND, { id, value: 'a' });
  const changed = await alice.peer.request(MessageType.SELECTOR_RESPOND, { id, value: 'b' });
  assert.equal(changed.payload.responseCount, 1);
  assert.equal(changed.payload.closedAt, null);
  assert.equal(changed.payload.ownResponse, 'b');
  assert.deepEqual(record(changed.payload.counts), { a: 0, b: 1 });
  const closed = await bob.peer.request(MessageType.SELECTOR_RESPOND, { id, value: 'a' });
  assert.equal(closed.payload.responseCount, 2);
  assert.equal(closed.payload.canRespond, false);
  await alice.peer.error(MessageType.SELECTOR_RESPOND, { id, value: 'a' }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
  const results = await Promise.all([
    bot.peer.request(MessageType.SELECTOR_FINALIZE, { id, content: 'Final: tie 50% / 50%' }),
    bot.peer.request(MessageType.SELECTOR_FINALIZE, { id, content: 'Final: tie 50% / 50%' }),
  ]);
  assert.equal(results[0].payload.resultMessageId, results[1].payload.resultMessageId);
  const finalHistory = await owner.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId });
  assert.equal(records(finalHistory.payload.messages).filter((message) => message.id === results[0].payload.resultMessageId).length, 1);
  const another = await bot.peer.request(MessageType.SELECTOR_CREATE, { ...input, id: randomUUID() });
  const memberRole = await fixture.roleRepo.findByName('Membro');
  assert.ok(memberRole);
  await fixture.roleRepo.update(memberRole.id, { permissions: memberRole.permissions & ~Permission.USE_BOT_COMMANDS });
  await alice.peer.error(MessageType.SELECTOR_RESPOND, { id: another.payload.id, value: 'a' }, ProtocolErrorCode.PERMISSION_DENIED);
  await fixture.roleRepo.update(memberRole.id, { permissions: memberRole.permissions });
  const concurrent = await Promise.all([alice, bob, owner].map(({ peer }) =>
    peer.request(MessageType.SELECTOR_RESPOND, { id: another.payload.id, value: 'a' })
  ));
  assert.equal(concurrent.filter((message) => message.type === MessageType.SELECTOR_SNAPSHOT).length, 2);
  assert.equal(concurrent.filter((message) => message.type === MessageType.SERVER_ERROR).length, 1);
  await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId, botCommandsEnabled: false });
  await owner.peer.error(MessageType.SELECTOR_RESPOND, { id: another.payload.id, value: 'a' }, ProtocolErrorCode.PERMISSION_DENIED);
});

test('private channel selectors bind invocations and revalidate durable creator capabilities', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const owner = await fixture.human('Capability owner');
  const creator = await fixture.human('Capability creator');
  const voter = await fixture.human('Capability voter');
  const memberRole = await fixture.roleRepo.findByName('Membro');
  assert.ok(memberRole);
  await fixture.roleRepo.update(memberRole.id, { permissions: 0 });
  const creatorRole = {
    id: randomUUID(), name: 'Poll creators', color: '#123456', permissions: DEFAULT_PERMISSIONS,
    position: 1, isDefault: false, createdAt: Date.now(),
  };
  const voterRole = { ...creatorRole, id: randomUUID(), name: 'Poll voters' };
  await fixture.roleRepo.create(creatorRole);
  await fixture.roleRepo.create(voterRole);
  await fixture.roleRepo.assignRole(creator.id, creatorRole.id);
  await fixture.roleRepo.assignRole(voter.id, voterRole.id);
  const channel = await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'private-polls', type: 'TEXT', isPrivate: true, allowedRoleIds: [creatorRole.id, voterRole.id],
  });
  const channelId = text(record(channel.payload.channel).id);
  const publicChannelId = text(records(record(owner.auth.payload.server).channels).find((entry) => entry.type === 'TEXT')?.id);
  const account = await owner.peer.request(MessageType.BOT_CREATE, {});
  const botId = text(record(account.payload.bot).id);
  const token = text(account.payload.token);
  let bot = await fixture.bot(token);
  const otherAccount = await owner.peer.request(MessageType.BOT_CREATE, {});
  const otherBot = await fixture.bot(text(otherAccount.payload.token));
  await bot.peer.request(MessageType.COMMAND_REGISTER, { commands: [{ name: 'enquete', description: 'Private-channel poll' }] });
  const invoke = async () => {
    const call = await creator.peer.request(MessageType.COMMAND_INVOKE, {
      botId, channelId, commandName: 'enquete', locale: 'en',
    });
    return text(call.payload.invocationId);
  };
  const invocationId = await invoke();
  const input = {
    id: randomUUID(), invocationId, invokerId: creator.id, channelId, title: 'Private poll?',
    choices: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
    presentation: 'buttons', responder: 'any', allowChange: true, maxResponders: 2,
  };
  await otherBot.peer.error(MessageType.SELECTOR_CREATE, input, ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.error(MessageType.SELECTOR_CREATE, { ...input, invocationId: randomUUID() }, ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.error(MessageType.SELECTOR_CREATE, { ...input, channelId: publicChannelId }, ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.error(MessageType.SELECTOR_CREATE, { ...input, invokerId: owner.id }, ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.error(MessageType.SELECTOR_CREATE, { ...input, creatorUserId: owner.id }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
  const { invocationId: _invocation, ...rawInput } = input;
  await bot.peer.error(MessageType.SELECTOR_CREATE, rawInput, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await bot.peer.error(MessageType.CHAT_SEND, { channelId, content: 'No global inherited access' }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  const created = await bot.peer.request(MessageType.SELECTOR_CREATE, input);
  assert.equal(created.payload.creatorUserId, creator.id);
  assert.equal(created.payload.sourceInvocationId, invocationId);
  const id = text(created.payload.id);
  const messageId = text(created.payload.messageId);
  const history = await voter.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId });
  assert.equal(records(history.payload.messages).filter((message) => message.id === messageId && message.userId === botId).length, 1);
  await bot.peer.error(MessageType.CHAT_REACTION_ADD, { channelId, messageId, emoji: '👍' }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await bot.peer.request(MessageType.COMMAND_FINISH, { invocationId });
  await bot.peer.error(MessageType.SELECTOR_CREATE, { ...input, id: randomUUID() }, ProtocolErrorCode.PERMISSION_DENIED);
  const replay = await bot.peer.request(MessageType.SELECTOR_CREATE, input);
  assert.equal(replay.payload.messageId, messageId);
  assert.equal((await bot.peer.request(MessageType.SELECTOR_CREATE, rawInput)).payload.messageId, messageId,
    'Replaying an existing selector uses its persisted principal, not an active invocation or supplied user ID.');
  const visible = await voter.peer.request(MessageType.SELECTOR_LIST, { channelId });
  const snapshot = records(visible.payload.selectors)[0];
  assert.equal('creatorUserId' in snapshot, false);
  assert.equal('sourceInvocationId' in snapshot, false);
  assert.equal('responses' in snapshot, false);
  assert.deepEqual(records((await otherBot.peer.request(MessageType.SELECTOR_LIST, { channelId })).payload.selectors), []);
  await voter.peer.request(MessageType.SELECTOR_RESPOND, { id, value: 'a' });
  const keys = bot.keys;
  await bot.peer.close();
  bot = await fixture.bot(token, keys);
  await bot.peer.request(MessageType.COMMAND_REGISTER, { commands: [{ name: 'enquete', description: 'Recovered private-channel poll' }] });
  const recovered = records((await bot.peer.request(MessageType.SELECTOR_LIST, {})).payload.selectors)[0];
  assert.equal(recovered.creatorUserId, creator.id);
  assert.deepEqual(record(recovered.responses), { [voter.id]: 'a' });
  await creator.peer.request(MessageType.SELECTOR_RESPOND, { id, value: 'b' });
  const finalized = await bot.peer.request(MessageType.SELECTOR_FINALIZE, { id, content: 'Private final: tie' });
  const finalId = text(finalized.payload.resultMessageId);
  assert.equal((await bot.peer.request(MessageType.SELECTOR_FINALIZE, { id, content: 'Private final: tie' })).payload.resultMessageId, finalId);
  assert.equal(records((await voter.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId })).payload.messages)
    .filter((message) => message.id === finalId).length, 1);

  const liveInvocation = await invoke();
  const live = await bot.peer.request(MessageType.SELECTOR_CREATE, {
    ...input, id: randomUUID(), invocationId: liveInvocation, maxResponders: 10,
  });
  const liveId = text(live.payload.id);
  await bot.peer.request(MessageType.COMMAND_FINISH, { invocationId: liveInvocation });
  const access = fixture.channelService.getAccessContext.bind(fixture.channelService);
  const brokenList = t.mock.method(fixture.channelService, 'getAccessContext', async (userId: string) => {
    if (userId === creator.id) throw new Error('selector-list-database-failure');
    return access(userId);
  });
  const listFailure = await bot.peer.request(MessageType.SELECTOR_LIST, {});
  assert.equal(listFailure.type, MessageType.SERVER_ERROR);
  assert.equal(listFailure.payload.message, 'selector-list-database-failure');
  brokenList.mock.restore();
  let voterChecks = 0;
  const brokenPublic = t.mock.method(fixture.channelService, 'getAccessContext', async (userId: string) => {
    if (userId === voter.id && ++voterChecks === 2) throw new Error('selector-public-database-failure');
    return access(userId);
  });
  const publicFailure = await voter.peer.request(MessageType.SELECTOR_LIST, { channelId });
  assert.equal(publicFailure.type, MessageType.SERVER_ERROR);
  assert.equal(publicFailure.payload.message, 'selector-public-database-failure');
  brokenPublic.mock.restore();
  const brokenNotify = t.mock.method(fixture.channelService, 'getAccessContext', async (userId: string) => {
    if (userId === creator.id) throw new Error('selector-notify-database-failure');
    return access(userId);
  });
  const sinceFailure = voter.peer.messages.length;
  await voter.peer.request(MessageType.SELECTOR_RESPOND, { id: liveId, value: 'a' });
  await voter.peer.wait((message) => message.type === MessageType.SERVER_ERROR &&
    message.payload.message === 'selector-notify-database-failure', sinceFailure);
  brokenNotify.mock.restore();

  for (const permission of [Permission.READ_MESSAGES, Permission.SEND_MESSAGES, Permission.USE_BOT_COMMANDS]) {
    await fixture.roleRepo.update(creatorRole.id, { permissions: creatorRole.permissions & ~permission });
    assert.deepEqual(records((await bot.peer.request(MessageType.SELECTOR_LIST, {})).payload.selectors), []);
    assert.equal((await bot.peer.request(MessageType.SELECTOR_UPDATE, { id: liveId, patch: { title: 'Denied' } })).type, MessageType.SERVER_ERROR);
    assert.equal((await bot.peer.request(MessageType.SELECTOR_FINALIZE, { id, content: 'Private final: tie' })).type, MessageType.SERVER_ERROR);
    await fixture.roleRepo.update(creatorRole.id, { permissions: creatorRole.permissions });
  }
  await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId, allowedRoleIds: [voterRole.id] });
  const beforeRevokedVote = bot.peer.messages.length;
  await voter.peer.request(MessageType.SELECTOR_RESPOND, { id: liveId, value: 'b' });
  assert.deepEqual(records((await bot.peer.request(MessageType.SELECTOR_LIST, {})).payload.selectors), []);
  assert.equal(bot.peer.messages.slice(beforeRevokedVote).some((message) => message.type === MessageType.SELECTOR_SNAPSHOT), false,
    'Revoked creator visibility must not leak future responses to the bot.');
  await bot.peer.error(MessageType.SELECTOR_CREATE, input, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await bot.peer.error(MessageType.SELECTOR_CLOSE, { id: liveId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await bot.peer.error(MessageType.SELECTOR_FINALIZE, { id, content: 'Private final: tie' }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await owner.peer.request(MessageType.CHANNEL_UPDATE, {
    channelId, allowedRoleIds: [creatorRole.id, voterRole.id], botCommandsEnabled: false,
  });
  await bot.peer.error(MessageType.SELECTOR_UPDATE, { id: liveId, patch: { title: 'Disabled' } }, ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.request(MessageType.SELECTOR_CLOSE, { id: liveId });
  await bot.peer.request(MessageType.SELECTOR_FINALIZE, { id: liveId, content: 'Final after disabling new interactions' });
  await fixture.userRepo.delete(creator.id);
  assert.deepEqual(records((await bot.peer.request(MessageType.SELECTOR_LIST, {})).payload.selectors), []);
});

test('persisted chat replies resolve trusted originals, edits, deletion and old history without privacy leaks', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const owner = await fixture.human('Reply owner');
  const alice = await fixture.human('Reply Alice');
  const channelId = text(records(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'TEXT')?.id);
  const sent = await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Original text' });
  const originalId = text(sent.payload.id);
  const response = await alice.peer.request(MessageType.CHAT_SEND, {
    channelId, content: 'An answer', replyToMessageId: originalId, reply: { userNickname: 'Spoofed', content: 'Forged' },
  });
  assert.equal(response.type, MessageType.CHAT_MESSAGE);
  const responseId = text(response.payload.id);
  assert.equal(record(response.payload.reply).userNickname, 'Reply owner');
  assert.equal(record(response.payload.reply).content, 'Original text');
  assert.equal((await fixture.messageRepo.findById(responseId))?.replyToMessageId, originalId);
  await owner.peer.wait((message) => message.type === MessageType.CHAT_MESSAGE && message.payload.id === responseId);
  await owner.peer.request(MessageType.CHAT_EDIT, { channelId, messageId: originalId, content: 'Edited original' });
  let history = await alice.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId });
  assert.equal(record(records(history.payload.messages).find((message) => message.id === responseId)?.reply).content, 'Edited original');
  await alice.peer.error(MessageType.CHAT_EDIT, { channelId, messageId: originalId, content: 'Not mine' }, ProtocolErrorCode.PERMISSION_DENIED);
  await alice.peer.error(MessageType.CHAT_DELETE, { channelId, messageId: originalId }, ProtocolErrorCode.PERMISSION_DENIED);

  const fileId = randomUUID();
  await fixture.attachmentRepo.create({
    id: fileId, messageId: null, channelId, userId: owner.id, kind: 'file', filename: 'reply.txt',
    originalName: 'reply.txt', mimeType: 'text/plain', sizeBytes: 8, createdAt: Date.now(),
  });
  const attachmentMessage = await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: '', attachmentIds: [fileId], replyToMessageId: originalId });
  assert.equal(attachmentMessage.type, MessageType.CHAT_MESSAGE);
  assert.equal(record(attachmentMessage.payload.reply).messageId, originalId);
  const attachmentReply = await owner.peer.request(MessageType.CHAT_SEND, {
    channelId, content: 'Reply to attachment', replyToMessageId: text(attachmentMessage.payload.id),
  });
  assert.equal(record(attachmentReply.payload.reply).hasAttachments, true);
  assert.equal(record(attachmentReply.payload.reply).content, '');

  // The exact target is included even when more than a page shares its timestamp.
  const target = await fixture.messageRepo.findById(originalId);
  assert.ok(target);
  for (let index = 0; index < LIMITS.MAX_HISTORY_MESSAGES_INITIAL + 1; index++) {
    await fixture.messageRepo.create({ ...target, id: randomUUID(), content: `Paged ${index}` });
  }
  const oldPage = await alice.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId, aroundMessageId: originalId, limit: 3 });
  assert.equal(oldPage.payload.aroundMessageId, originalId);
  assert.ok(records(oldPage.payload.messages).some((message) => message.id === originalId));
  assert.ok(records(oldPage.payload.messages).length <= 3);

  const privateChannel = await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'reply-private', type: 'TEXT', isPrivate: true, allowedRoleIds: [],
  });
  const privateId = text(record(privateChannel.payload.channel).id);
  const secret = await owner.peer.request(MessageType.CHAT_SEND, { channelId: privateId, content: 'Secret reply target' });
  const secretId = text(secret.payload.id);
  await alice.peer.error(MessageType.CHAT_SEND, { channelId, content: 'Leak attempt', replyToMessageId: secretId }, ProtocolErrorCode.BAD_REQUEST);
  await alice.peer.error(MessageType.CHAT_SEND, { channelId: privateId, content: 'Private', replyToMessageId: secretId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  const deniedPage = await alice.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId, aroundMessageId: secretId });
  assert.deepEqual(deniedPage.payload.messages, []);
  await alice.peer.error(MessageType.CHAT_LOAD_HISTORY, { channelId: privateId, aroundMessageId: secretId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await alice.peer.error(MessageType.CHAT_SEND, { channelId, content: 'Invalid', replyToMessageId: 123 }, ProtocolErrorCode.BAD_REQUEST);
  await alice.peer.error(MessageType.CHAT_LOAD_HISTORY, { channelId, aroundMessageId: {} }, ProtocolErrorCode.BAD_REQUEST);
  const corrupt = { ...target, id: randomUUID(), replyToMessageId: secretId, createdAt: Date.now() + 100 };
  await fixture.messageRepo.create(corrupt);
  const corruptPage = await fixture.chatService.loadHistory(channelId, 1, undefined, corrupt.id);
  assert.equal(corruptPage[0].reply?.deleted, true);
  assert.equal(corruptPage[0].reply?.content, '');

  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const bot = await fixture.bot(text(created.payload.token), undefined, 'Reply bot');
  const botAnswer = await bot.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Bot answer', replyToMessageId: originalId });
  assert.equal(record(botAnswer.payload.reply).content, 'Edited original');
  const replyToBot = await owner.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Thanks bot', replyToMessageId: text(botAnswer.payload.id) });
  assert.equal(record(replyToBot.payload.reply).userNickname, 'Reply bot');
  await owner.peer.request(MessageType.CHAT_DELETE, { channelId, messageId: originalId });
  history = await alice.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId, aroundMessageId: responseId });
  const deletedReply = record(records(history.payload.messages).find((message) => message.id === responseId)?.reply);
  assert.equal(deletedReply.deleted, true);
  assert.equal(deletedReply.content, '');
  assert.equal(deletedReply.userNickname, '');
  await bot.peer.error(MessageType.CHAT_SEND, { channelId, content: 'Deleted target', replyToMessageId: originalId }, ProtocolErrorCode.BAD_REQUEST);
  await bot.peer.error(MessageType.CHAT_SEND, { channelId, content: 'Missing target', replyToMessageId: randomUUID() }, ProtocolErrorCode.BAD_REQUEST);
  const normal = await bot.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Normal still works' });
  assert.equal(normal.type, MessageType.CHAT_MESSAGE);
  assert.equal(normal.payload.reply, undefined);
});

test('persistent text reactions support bot events and enforce privacy', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const owner = await fixture.human('Reaction owner');
  const alice = await fixture.human('Reaction Alice');
  const channels = records(record(owner.auth.payload.server).channels);
  const channelId = text(channels.find((channel) => channel.type === 'TEXT')?.id);
  const voiceChannelId = text(channels.find((channel) => channel.type === 'VOICE')?.id);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const botId = text(record(created.payload.bot).id);
  const bot = await fixture.bot(text(created.payload.token), undefined, 'Question bot');
  const question = await bot.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Choose with reactions' });
  assert.equal(question.type, MessageType.CHAT_MESSAGE);
  assert.equal(question.payload.userId, botId);
  assert.equal(question.payload.isBot, true);
  const messageId = text(question.payload.id);
  const reaction = { channelId, messageId, emoji: '👍' };
  const added = await alice.peer.request(MessageType.CHAT_REACTION_ADD, reaction);
  assert.equal(added.type, MessageType.CHAT_REACTION_ADDED);
  assert.equal(added.payload.userId, alice.id);
  await bot.peer.wait((message) => message.type === MessageType.CHAT_REACTION_ADDED && message.payload.messageId === messageId);
  await bot.peer.request(MessageType.CHAT_REACTION_ADD, reaction);
  await alice.peer.request(MessageType.CHAT_REACTION_ADD, { ...reaction, emoji: '❤️' });
  const firstHistory = await owner.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId });
  const historyMessage = records(firstHistory.payload.messages).find((message) => message.id === messageId);
  assert.ok(historyMessage);
  assert.equal(historyMessage.userId, botId);
  assert.equal(historyMessage.isBot, true);
  assert.equal(historyMessage.userNickname, 'Question bot');
  const reactions = records(historyMessage.reactions);
  assert.equal(reactions.length, 2);
  assert.equal(records(reactions.find((entry) => entry.emoji === '👍')?.users).length, 2);
  const since = bot.peer.messages.length;
  alice.peer.send(MessageType.CHAT_REACTION_ADD, reaction);
  await alice.peer.barrier();
  assert.equal(bot.peer.messages.slice(since).some((message) => message.type === MessageType.CHAT_REACTION_ADDED), false);
  await bot.peer.request(MessageType.CHAT_REACTION_REMOVE, reaction);
  assert.equal((await fixture.messageRepo.listReactions([messageId])).filter((entry) => entry.emoji === '👍').length, 1);
  await alice.peer.error(MessageType.CHAT_REACTION_ADD, { ...reaction, userId: botId }, ProtocolErrorCode.BAD_REQUEST);
  await alice.peer.error(MessageType.CHAT_REACTION_ADD, { ...reaction, emoji: 'not emoji' }, ProtocolErrorCode.BAD_REQUEST);
  await alice.peer.error(MessageType.CHAT_REACTION_ADD, { ...reaction, messageId: randomUUID() }, ProtocolErrorCode.BAD_REQUEST);
  await alice.peer.error(MessageType.CHAT_REACTION_ADD, { ...reaction, channelId: voiceChannelId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  const privateChannel = await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'reaction-private', type: 'TEXT', isPrivate: true, allowedRoleIds: [],
  });
  const privateId = text(record(privateChannel.payload.channel).id);
  await bot.peer.error(MessageType.CHAT_SEND, { channelId: privateId, content: 'Cannot bypass privacy' }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  const secret = await owner.peer.request(MessageType.CHAT_SEND, { channelId: privateId, content: 'Secret' });
  await bot.peer.error(MessageType.CHAT_REACTION_ADD, { channelId: privateId, messageId: text(secret.payload.id), emoji: '👍' }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await owner.peer.request(MessageType.CHAT_REACTION_ADD, { channelId: privateId, messageId: text(secret.payload.id), emoji: '👍' });
  await bot.peer.barrier();
  assert.equal(bot.peer.messages.some((message) => message.type === MessageType.CHAT_REACTION_ADDED && message.payload.channelId === privateId), false);
  const systemId = randomUUID();
  await fixture.messageRepo.create({ id: systemId, channelId, userId: owner.id, content: 'System', createdAt: Date.now(), isSystem: true });
  await owner.peer.error(MessageType.CHAT_REACTION_ADD, { ...reaction, messageId: systemId }, ProtocolErrorCode.BAD_REQUEST);
  const staleReaction = await fixture.chatService.setReaction(
    { id: alice.id, nickname: 'Reaction Alice' }, { ...reaction, emoji: '🔥' }, true, () => false
  );
  assert.equal(staleReaction.success, false);
  if (!staleReaction.success) assert.equal(staleReaction.errorCode, ProtocolErrorCode.UNAUTHORIZED);
  assert.equal((await fixture.messageRepo.listReactions([messageId])).some((entry) => entry.emoji === '🔥'), false);
  const botRecord = await fixture.botRepo.findById(botId);
  assert.ok(botRecord);
  const staleMessageId = randomUUID();
  const stalePost = await fixture.chatService.sendBotMessage(botRecord, channelId, 'Stale socket', undefined, staleMessageId, () => false);
  assert.equal(stalePost.success, false);
  assert.equal(await fixture.messageRepo.findById(staleMessageId), null);
  await owner.peer.request(MessageType.CHAT_DELETE, { channelId, messageId });
  assert.deepEqual(await fixture.messageRepo.listReactions([messageId]), []);
  await owner.peer.error(MessageType.CHAT_REACTION_ADD, reaction, ProtocolErrorCode.BAD_REQUEST);
});

test('reaction rows survive reopening SQLite and enforce atomic bounds and cleanup', async (t) => {
  const directory = path.join(__dirname, '..', `.reaction-test-data-${process.pid}-${randomUUID()}`);
  const filename = path.join(directory, 'server.db');
  let database = await DatabaseConnection.create(filename);
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let db = database.getDb();
  const serverRepo = new SqliteServerRepository(db);
  const channelRepo = new SqliteChannelRepository(db);
  const roleRepo = new SqliteRoleRepository(db);
  await ensureServerSeedData({ serverName: 'Reaction storage', maxUsers: 10 }, serverRepo, channelRepo, roleRepo);
  const server = await serverRepo.getServer();
  assert.ok(server);
  const channel = (await channelRepo.listByServerId(server.id)).find((entry) => entry.type === 'TEXT');
  assert.ok(channel);
  const userId = randomUUID();
  await new SqliteUserRepository(db).create({ id: userId, clientId: userId, nickname: 'Reactor', publicKey: null, avatarPath: null, createdAt: 1, lastSeenAt: 1 });
  let repo = new SqliteMessageRepository(db);
  const messageId = randomUUID();
  await repo.create({ id: messageId, channelId: channel.id, userId, content: 'Persist me', createdAt: 1 });
  assert.equal(await repo.setReaction(messageId, userId, '👍', true), 'changed');
  assert.equal(await repo.setReaction(messageId, userId, '👍', true), 'unchanged');
  const botId = randomUUID();
  const botMessageId = randomUUID();
  await new SqliteBotRepository(db).create({
    id: botId, name: 'Persistent bot', tokenHash: randomUUID(), avatarPath: null,
    boundPublicKey: null, createdByUserId: userId, createdAt: 1, profilePending: false,
  });
  const botMessage = {
    id: botMessageId, channelId: channel.id, userId: botId, content: 'Persistent bot question', createdAt: 2,
    botAuthor: { id: botId, name: 'Persistent bot', avatarPath: null, ownerUserId: userId },
    botCommand: { invocationId: randomUUID(), commandName: 'question', invokerId: userId, invokerNickname: 'Reactor' },
    replyToMessageId: messageId,
  };
  const [firstBotPost, retriedBotPost] = await Promise.all([
    repo.createBotMessage(botMessage), repo.createBotMessage({ ...botMessage, createdAt: 3 }),
  ]);
  assert.deepEqual(firstBotPost, retriedBotPost);
  assert.equal(await repo.setReaction(botMessageId, userId, '👍', true), 'changed');
  database.close();
  database = await DatabaseConnection.create(filename);
  db = database.getDb();
  repo = new SqliteMessageRepository(db);
  const restoredBotMessage = await repo.findById(botMessageId);
  assert.equal(restoredBotMessage?.userId, botId);
  assert.equal(restoredBotMessage?.botAuthor?.name, 'Persistent bot');
  assert.deepEqual(restoredBotMessage?.botCommand, botMessage.botCommand);
  assert.equal(restoredBotMessage?.replyToMessageId, messageId);
  assert.equal((await repo.listReactions([botMessageId])).length, 1);
  await new SqliteBotRepository(db).delete(botId);
  assert.equal((await repo.findById(botMessageId))?.userId, botId);
  assert.equal(await repo.createBotMessage({ ...botMessage, id: randomUUID() }), null);
  assert.deepEqual(await repo.listReactions([messageId]), [{ messageId, userId, userNickname: 'Reactor', emoji: '👍' }]);
  for (const emoji of ['😀', '😁', '😂', '😃', '😄', '😅', '😆', '😇', '😈', '😉', '😊', '😋', '😌', '😍', '😎', '😏', '😐', '😑', '😒']) {
    assert.equal(await repo.setReaction(messageId, userId, emoji, true), 'changed');
  }
  assert.equal(await repo.setReaction(messageId, userId, '😓', true), 'limit');
  assert.equal(await repo.setReaction(messageId, userId, '👍', false), 'changed');
  assert.equal(await repo.setReaction(messageId, userId, '😓', true), 'changed');
  const users = new SqliteUserRepository(db);
  let lastUserId = '';
  for (let index = 0; index < 481; index += 1) {
    lastUserId = randomUUID();
    await users.create({ id: lastUserId, clientId: lastUserId, nickname: `Reactor ${index}`, publicKey: null, avatarPath: null, createdAt: 1, lastSeenAt: 1 });
    assert.equal(await repo.setReaction(messageId, lastUserId, '😓', true), index < 480 ? 'changed' : 'limit');
  }
  assert.equal((await repo.listReactions([messageId])).length, 500);
  const reactingUser = (await repo.listReactions([messageId])).find((entry) => entry.userId !== userId);
  assert.ok(reactingUser);
  await users.delete(reactingUser.userId);
  assert.equal((await repo.listReactions([messageId])).length, 499);
  assert.equal(await repo.setReaction(messageId, lastUserId, '😓', true), 'changed');
  await repo.markDeleted(messageId, Date.now());
  assert.deepEqual(await repo.listReactions([messageId]), []);
  assert.equal(await repo.setReaction(messageId, userId, '👍', true), 'invalid');
});

test('bot interactions over authenticated WebSockets', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const owner = await fixture.human('Owner');
  let alice = await fixture.human('Alice');
  const otherDevice = await fixture.human('Alice', alice.keys);
  const bob = await fixture.human('Bob');
  const channels = records(record(owner.auth.payload.server).channels);
  const textChannel = text(channels.find((channel) => channel.type === 'TEXT')?.id);
  const voiceChannel = text(channels.find((channel) => channel.type === 'VOICE')?.id);
  const privateRole = { id: randomUUID(), name: 'Private members', color: '#123456', permissions: 0, position: 1, isDefault: false, createdAt: Date.now() };
  await fixture.roleRepo.create(privateRole);
  await fixture.roleRepo.assignRole(alice.id, privateRole.id);
  const privateCreated = await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'private-bot-tests', type: 'TEXT', isPrivate: true, allowedRoleIds: [privateRole.id],
  });
  const privateChannel = text(record(privateCreated.payload.channel).id);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  assert.equal(created.type, MessageType.BOT_CREATED);
  const botInfo = record(created.payload.bot);
  const botId = text(botInfo.id);
  const token = text(created.payload.token);
  await t.test('reserves only a pending link and rejects client-supplied identity, including owner changes', async () => {
    assert.equal(botInfo.profilePending, true);
    assert.equal(botInfo.bound, false);
    assert.equal(botInfo.online, false);
    assert.equal(botInfo.avatarUrl, null);
    const catalog = botSettingsListResponseSchema.parse((await owner.peer.request(MessageType.BOT_SETTINGS_LIST)).payload);
    assert.deepEqual(catalog.bots, []);
    await owner.peer.error(MessageType.BOT_SETTINGS_GET, { botId }, ProtocolErrorCode.BAD_REQUEST);
    for (const profile of [{ name: 'Client name' }, { avatarBase64: PNG }, { name: 'Client name', avatarBase64: PNG }]) {
      await owner.peer.error(MessageType.BOT_CREATE, profile, ProtocolErrorCode.BAD_REQUEST);
      await owner.peer.error(MessageType.BOT_UPDATE_PROFILE, { botId, ...profile }, ProtocolErrorCode.PERMISSION_DENIED);
    }
    assert.equal(await fixture.botRepo.count(), 1);
    assert.equal((await fixture.botRepo.findById(botId))?.profilePending, true);
  });
  await t.test('rejects incompatible bot protocols before authentication or TOFU binding', async () => {
    const rejected = await fixture.connect();
    const keys = identity();
    for (const protocolVersion of [PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1, String(PROTOCOL_VERSION), undefined]) {
      const response = await rejected.request(MessageType.AUTH_CONNECT, {
        protocolVersion, nickname: 'Incompatible bot', publicKey: keys.publicKey, botToken: token,
      });
      assert.equal(response.type, MessageType.SERVER_ERROR);
      assert.equal(response.payload.code, ProtocolErrorCode.PROTOCOL_VERSION_UNSUPPORTED);
      assert.equal(response.payload.serverProtocolVersion, PROTOCOL_VERSION);
      assert.equal((await fixture.botRepo.findById(botId))?.boundPublicKey, null);
      assert.equal((await fixture.botService.list()).find((item) => item.id === botId)?.online, false);
      assert.equal(await fixture.botRepo.count(), 1);
    }
    await rejected.error(MessageType.COMMAND_REGISTER, {
      commands: [{ name: 'legacy', description: 'Must not register' }],
    }, ProtocolErrorCode.UNAUTHORIZED);
    await rejected.error(MessageType.COMMAND_RESPONSE, {
      userId: owner.id, channelId: textChannel, content: 'Legacy response without invocation id',
    }, ProtocolErrorCode.UNAUTHORIZED);
    assert.equal(fixture.registry.listAll().length, 0);
    await rejected.close();
  });
  await t.test('rejects an invalid bot-announced name before claiming the token', async () => {
    const rejected = await fixture.connect();
    const keys = identity();
    for (const nickname of [undefined, '', 'x', 'x'.repeat(33)]) {
      await rejected.error(MessageType.AUTH_CONNECT, {
        protocolVersion: PROTOCOL_VERSION, nickname, publicKey: keys.publicKey, botToken: token,
      }, ProtocolErrorCode.BOT_INVALID_PROFILE);
      assert.equal((await fixture.botRepo.findById(botId))?.boundPublicKey, null);
      assert.equal((await fixture.botRepo.findById(botId))?.profilePending, true);
    }
    await rejected.close();
  });
  let bot = await fixture.bot(token, undefined, 'Actual Bot');
  const initialProfile = await bot.peer.request(MessageType.BOT_UPDATE_PROFILE, {
    avatarBase64: `data:image/png;base64,${PNG}`,
  });
  assert.equal(initialProfile.type, MessageType.BOT_PROFILE_UPDATED);
  const avatarUrl = text(record(initialProfile.payload.bot).avatarUrl);
  const secondCreated = await owner.peer.request(MessageType.BOT_CREATE, {});
  const otherBotId = text(record(secondCreated.payload.bot).id);
  const otherBot = await fixture.bot(text(secondCreated.payload.token));
  const commands = [
    { name: 'ping', description: 'A simple command' },
    {
      name: 'survey', description: 'Typed options', options: [
        { name: 'topic', description: 'Topic', type: 'string', required: true, choices: [{
          label: 'News', value: 'news', description: 'News preview', audio: AUDIO_PREVIEW,
        }] },
        { name: 'count', description: 'Count', type: 'integer', required: true, min: 1, max: 10 },
        { name: 'notify', description: 'Notify', type: 'boolean', required: true },
        { name: 'target', description: 'Target', type: 'user', required: true },
      ],
    },
  ];
  const register = async () => {
    const response = await bot.peer.request(MessageType.COMMAND_REGISTER, { commands });
    assert.equal(response.type, MessageType.COMMAND_REGISTERED);
    assert.equal(response.payload.registered, 2);
  };
  await register();
  const invoke = async (peer = alice.peer, channelId = textChannel, options?: unknown, commandName = 'ping') => {
    const response = await peer.request(MessageType.COMMAND_INVOKE, { botId, commandName, channelId, options, locale: 'en' });
    assert.equal(response.type, MessageType.COMMAND_INVOKED);
    const id = text(response.payload.invocationId);
    const execution = commandExecutionSchema.parse((await bot.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_INVOKE, id))).payload);
    assert.equal(execution.invocationId, id);
    return { id, execution };
  };
  const finish = async (id: string) => {
    const response = await bot.peer.request(MessageType.COMMAND_FINISH, { invocationId: id });
    assert.equal(response.type, MessageType.COMMAND_FINISHED);
    assert.equal(response.payload.reason, 'completed');
  };
  const barrier = async () => {
    await bot.peer.barrier();
    await Promise.all(fixture.peers.map((peer) => peer.barrier()));
  };

  await t.test('uses bot-announced profiles and rejects human edits without partial writes', async () => {
    const authUser = record(bot.auth.payload.currentUser);
    assert.equal(authUser.nickname, 'Actual Bot');
    assert.equal(authUser.avatarUrl, undefined);
    assert.equal((await fixture.botService.getInfo(botId))?.avatarUrl, avatarUrl);
    assert.ok(!records(record(bot.auth.payload.server).channels).some((channel) => channel.id === privateChannel));
    const listed = await owner.peer.request(MessageType.BOT_LIST);
    assert.equal(listed.type, MessageType.BOT_LIST_RESPONSE);
    const onlineBot = records(listed.payload.bots).find((item) => item.id === botId);
    assert.equal(onlineBot?.online, true);
    assert.equal(onlineBot?.bound, true);
    assert.equal(onlineBot?.profilePending, false);
    for (const key of ['token', 'tokenHash', 'boundPublicKey', 'avatarPath']) assert.ok(!(key in record(onlineBot)));
    await bob.peer.error(MessageType.BOT_UPDATE_PROFILE, { botId, name: 'Not allowed' }, ProtocolErrorCode.PERMISSION_DENIED);
    await bot.peer.error(MessageType.BOT_UPDATE_PROFILE, { botId: otherBotId, name: 'Not allowed' }, ProtocolErrorCode.PERMISSION_DENIED);
    await owner.peer.error(MessageType.BOT_UPDATE_PROFILE, { botId, name: 'Owner override' }, ProtocolErrorCode.PERMISSION_DENIED);
    await owner.peer.error(MessageType.BOT_UPDATE_PROFILE, { name: 'Missing id' }, ProtocolErrorCode.PERMISSION_DENIED);
    await bot.peer.error(MessageType.BOT_UPDATE_PROFILE, {}, ProtocolErrorCode.BOT_INVALID_PROFILE);
    await bot.peer.error(MessageType.BOT_UPDATE_PROFILE, { name: 'Partial change', avatarBase64: 'invalid!' }, ProtocolErrorCode.AVATAR_INVALID_TYPE);
    await bot.peer.error(MessageType.BOT_UPDATE_PROFILE, { avatarBase64: `data:image/jpeg;base64,${PNG}` }, ProtocolErrorCode.AVATAR_INVALID_TYPE);
    await owner.peer.error(MessageType.BOT_CREATE, { name: 'Invalid image', avatarBase64: 'AAAA' }, ProtocolErrorCode.BAD_REQUEST);
    await owner.peer.error(MessageType.BOT_CREATE, { name: 'Invalid fields', avatarBase64: PNG, unexpected: true }, ProtocolErrorCode.BAD_REQUEST);
    const tooLarge = await fixture.botService.updateProfile(botId, {
      name: 'Too big', avatarBase64: 'A'.repeat(Math.ceil(LIMITS.MAX_AVATAR_SIZE * 4 / 3) + 257),
    });
    assert.equal(tooLarge.success, false);
    if (!tooLarge.success) assert.equal(tooLarge.errorCode, ProtocolErrorCode.AVATAR_TOO_LARGE);
    assert.equal((await fixture.botRepo.findById(botId))?.name, 'Actual Bot');
    assert.equal(await fixture.botRepo.count(), 2);
    const updated = await bot.peer.request(MessageType.BOT_UPDATE_PROFILE, { name: 'Updated Bot', avatarBase64: PNG });
    assert.equal(updated.type, MessageType.BOT_PROFILE_UPDATED);
    const profile = record(updated.payload.bot);
    assert.equal(profile.name, 'Updated Bot');
    assert.notEqual(profile.avatarUrl, avatarUrl);
    await barrier();
    assert.ok(alice.peer.messages.some((m) => m.type === MessageType.USER_UPDATED && record(m.payload.user).nickname === 'Updated Bot'));
    const commandsResponse = await alice.peer.request(MessageType.COMMANDS_LIST);
    assert.equal(commandsResponse.type, MessageType.COMMANDS_LIST_RESPONSE);
    assert.ok(records(commandsResponse.payload.commands).every((c) => c.botName === 'Updated Bot' && c.botAvatarUrl === profile.avatarUrl));
    const surveyCommand = records(commandsResponse.payload.commands).find((command) => command.name === 'survey');
    assert.deepEqual(record(records(record(records(surveyCommand?.options)[0]).choices)[0]).audio, AUDIO_PREVIEW);
    const filename = text(profile.avatarUrl).split('/').pop();
    assert.ok(filename);
    const saved = fixture.avatars.getAvatarFile(filename);
    assert.ok(saved);
    assert.deepEqual(fs.readFileSync(saved.filePath), Buffer.from(PNG, 'base64'));
    const oldFilename = avatarUrl.split('/').pop();
    assert.ok(oldFilename);
    assert.equal(fixture.avatars.getAvatarFile(oldFilename), null);
  });

  await t.test('validates an entire registry replacement before removing valid commands', async () => {
    for (const badCommands of [
      [{ name: 'bad name', description: 'No sanitization' }],
      [{ name: 'ping', description: 'First' }, { name: 'ping', description: 'Duplicate' }],
      [{ name: 'bad', description: 'Option duplicates', options: [{ name: 'same', type: 'string', description: 'One' }, { name: 'same', type: 'boolean', description: 'Two' }] }],
      [{ name: 'bad', description: 'Wrong type', options: [{ name: 'arg', type: 'number', description: 'Number' }] }],
      [{ name: 'bad', description: 'Invalid option name', options: [{ name: '8value', type: 'string', description: 'Initial digit' }] }],
      [{ name: 'bad', description: 'Unsafe name', options: [{ name: 'constructor', type: 'string', description: 'Unsafe' }] }],
      Array.from({ length: LIMITS.MAX_COMMANDS_PER_BOT + 1 }, (_, i) => ({ name: `cmd${i}`, description: 'Too many' })),
    ]) {
      await bot.peer.error(MessageType.COMMAND_REGISTER, { commands: badCommands }, ProtocolErrorCode.BOT_INVALID_OPTIONS);
      assert.equal(fixture.registry.listAll().length, 2);
    }
  });

  await t.test('supports command names beginning with digits without loosening option names', async () => {
    const registered = await bot.peer.request(MessageType.COMMAND_REGISTER, {
      commands: [...commands, { name: '8ball', description: 'Starts with a digit' }],
    });
    assert.equal(registered.type, MessageType.COMMAND_REGISTERED);
    assert.equal(registered.payload.registered, 3);
    const invoked = await invoke(alice.peer, textChannel, undefined, '8ball');
    assert.equal(invoked.execution.commandName, '8ball');
    assert.deepEqual(invoked.execution.options, {});
    await finish(invoked.id);
    await register();
  });

  await t.test('rejects unauthorized, missing, malformed or mistyped options before dispatch', async () => {
    const valid = { topic: 'news', count: 3, notify: false, target: bob.id };
    const before = bot.peer.messages.length;
    for (const options of [
      {}, { ...valid, topic: undefined }, { ...valid, topic: 'other' }, { ...valid, count: '3' },
      { ...valid, count: 1.5 }, { ...valid, count: 11 }, { ...valid, notify: 'false' },
      { ...valid, extra: true }, { ...valid, target: 'missing-member' },
    ]) {
      await alice.peer.error(MessageType.COMMAND_INVOKE, { commandName: 'survey', botId, channelId: textChannel, options }, ProtocolErrorCode.BOT_INVALID_OPTIONS);
    }
    await alice.peer.error(MessageType.COMMAND_INVOKE, { commandName: 'ping', botId, channelId: textChannel, args: 'stale args' }, ProtocolErrorCode.BOT_INVALID_OPTIONS);
    await alice.peer.error(MessageType.COMMAND_INVOKE, { commandName: 'ping', botId, channelId: voiceChannel }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
    await alice.peer.error(MessageType.COMMAND_INVOKE, { commandName: 'ping', botId, channelId: 'missing' }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
    await bob.peer.error(MessageType.COMMAND_INVOKE, { commandName: 'ping', botId, channelId: privateChannel }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
    await alice.peer.error(MessageType.COMMAND_INVOKE, { commandName: 'missing', botId, channelId: textChannel }, ProtocolErrorCode.BOT_COMMAND_NOT_FOUND);
    await alice.peer.error(MessageType.COMMAND_INVOKE, { commandName: 'ping', botId: 'offline', channelId: textChannel }, ProtocolErrorCode.BOT_OFFLINE);
    await bot.peer.error(MessageType.COMMAND_INVOKE, { commandName: 'ping', botId, channelId: textChannel }, ProtocolErrorCode.PERMISSION_DENIED);
    await barrier();
    assert.equal(bot.peer.messages.slice(before).filter((m) => m.type === MessageType.COMMAND_INVOKE).length, 0);
    const invoked = await invoke(alice.peer, textChannel, valid, 'survey');
    assert.deepEqual(invoked.execution.options, valid);
    assert.equal(invoked.execution.locale, 'en');
    assert.equal(invoked.execution.invokerId, alice.id);
    assert.equal(invoked.execution.invokerNickname, 'Alice');
    await finish(invoked.id);
  });

  await t.test('newly connected members receive the existing command registry after authentication', async () => {
    const joined = await fixture.human('Late caller');
    const initial = await joined.peer.wait((message) =>
      message.type === MessageType.COMMANDS_LIST_RESPONSE && records(message.payload.commands).some((command) => command.botId === botId)
    );
    assert.ok(joined.peer.messages.findIndex((message) => message.type === MessageType.AUTH_SUCCESS) <
      joined.peer.messages.indexOf(initial));
    assert.ok(records(initial.payload.commands).some((command) => command.name === 'ping'));
    const requested = await joined.peer.request(MessageType.COMMANDS_LIST);
    assert.equal(requested.type, MessageType.COMMANDS_LIST_RESPONSE);
    assert.deepEqual(requested.payload, initial.payload);
    await joined.peer.close();
  });

  await t.test('isolates callers and devices, defaults to private, and scopes explicit public replies', async () => {
    const first = await invoke();
    const second = await invoke(bob.peer);
    bot.peer.send(MessageType.COMMAND_RESPONSE, { invocationId: first.id, content: 'Only Alice' });
    bot.peer.send(MessageType.COMMAND_RESPONSE, { invocationId: second.id, content: 'Only Bob' });
    await barrier();
    const privateMessage = await alice.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, first.id));
    assert.equal(privateMessage.payload.ephemeral, true);
    assert.equal(privateMessage.payload.botId, botId);
    assert.equal(privateMessage.payload.botName, 'Updated Bot');
    assert.equal(privateMessage.payload.channelId, textChannel);
    assert.equal(privateMessage.payload.botAvatarUrl, fixture.registry.find(botId, 'ping')?.botAvatarUrl);
    assert.equal(privateMessage.payload.commandName, 'ping');
    assert.equal(privateMessage.payload.invokerId, alice.id);
    assert.equal(privateMessage.payload.invokerNickname, 'Alice');
    assert.equal(privateMessage.payload.invokerAvatarUrl, null);
    assert.match(text(privateMessage.payload.messageId), /^[0-9a-f-]{36}$/);
    assert.equal(typeof privateMessage.payload.createdAt, 'number');
    assert.ok(!bob.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, first.id)));
    assert.ok(!alice.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, second.id)));
    assert.ok(!otherDevice.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, first.id)));
    assert.ok(!owner.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, first.id)));
    await bot.peer.error(MessageType.COMMAND_RESPONSE, { invocationId: first.id, content: 'Forged', userId: bob.id, channelId: textChannel }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    await bot.peer.error(MessageType.COMMAND_RESPONSE, {
      invocationId: first.id, content: 'Forged attribution', commandName: 'other',
      invokerId: bob.id, invokerNickname: 'Bob', invokerAvatarUrl: PNG,
    }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    await otherBot.peer.error(MessageType.COMMAND_RESPONSE, { invocationId: first.id, content: 'Forged' }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    bot.peer.send(MessageType.COMMAND_RESPONSE, { invocationId: first.id, content: 'Public channel', ephemeral: false });
    await barrier();
    const publicMessage = bob.peer.messages.find((m) => m.payload.content === 'Public channel');
    assert.ok(publicMessage);
    assert.equal(publicMessage.payload.commandName, 'ping');
    assert.equal(publicMessage.payload.invokerId, alice.id);
    assert.equal(publicMessage.payload.invokerNickname, 'Alice');
    assert.equal(publicMessage.payload.options, undefined);
    const persistedHistory = await bob.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId: textChannel });
    const persisted = records(persistedHistory.payload.messages).find((message) => message.id === publicMessage.payload.messageId);
    assert.ok(persisted);
    assert.equal(persisted.isBot, true);
    assert.equal(persisted.userId, botId);
    assert.equal(record(persisted.botCommand).invocationId, first.id);
    assert.equal(record(persisted.botCommand).invokerId, alice.id);
    assert.equal(records(persistedHistory.payload.messages).some((message) => message.id === privateMessage.payload.messageId), false);
    assert.ok(otherDevice.peer.messages.some((m) => m.payload.content === 'Public channel'));
    const secret = await invoke(alice.peer, privateChannel);
    bot.peer.send(MessageType.COMMAND_RESPONSE, { invocationId: secret.id, content: 'Private channel publication', ephemeral: false });
    await barrier();
    assert.ok(owner.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, secret.id)));
    assert.ok(otherDevice.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, secret.id)));
    assert.ok(!bob.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, secret.id)));
    assert.ok(!otherBot.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, secret.id)));
    await finish(first.id);
    await finish(second.id);
    await finish(secret.id);
    await bob.peer.request(MessageType.CHAT_REACTION_ADD, { channelId: textChannel, messageId: text(publicMessage.payload.messageId), emoji: '👍' });
    await bot.peer.wait((message) => message.type === MessageType.CHAT_REACTION_ADDED && message.payload.messageId === publicMessage.payload.messageId);
  });

  await t.test('delivers the last asynchronous private-channel publication before completion', async () => {
    const { id } = await invoke(alice.peer, privateChannel);
    bot.peer.send(MessageType.COMMAND_RESPONSE, {
      invocationId: id, content: 'Final public result in a private channel', ephemeral: false,
    });
    bot.peer.send(MessageType.COMMAND_FINISH, { invocationId: id });
    await alice.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, id));
    await barrier();
    const related = alice.peer.messages.filter((m) => m.payload.invocationId === id);
    const responseIndex = related.findIndex((m) => m.type === MessageType.COMMAND_RESPONSE);
    const finishedIndex = related.findIndex((m) => m.type === MessageType.COMMAND_FINISHED);
    assert.ok(responseIndex >= 0 && responseIndex < finishedIndex);
    assert.equal(related[responseIndex].payload.ephemeral, false);
    assert.equal(related[finishedIndex].payload.reason, 'completed');
    assert.ok(owner.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, id)));
    assert.ok(otherDevice.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, id)));
    assert.ok(!bob.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, id)));
    assert.ok(!otherBot.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_RESPONSE, id)));
  });

  await t.test('queues command finish behind explicitly blocked persistent publication', async () => {
    const { id } = await invoke(alice.peer, privateChannel);
    const gate = new EventEmitter();
    const started = once(gate, 'started');
    const released = once(gate, 'release');
    const create = fixture.messageRepo.createBotMessage.bind(fixture.messageRepo);
    const delayed = t.mock.method(fixture.messageRepo, 'createBotMessage', async (message: MessageRecord) => {
      gate.emit('started');
      await released;
      return create(message);
    });
    try {
      bot.peer.send(MessageType.COMMAND_RESPONSE, { invocationId: id, content: 'Delayed persistent result', ephemeral: false });
      bot.peer.send(MessageType.COMMAND_FINISH, { invocationId: id });
      await started;
      await alice.peer.barrier();
      assert.equal(alice.peer.messages.some((message) => hasInvocation(message, MessageType.COMMAND_FINISHED, id)), false);
      gate.emit('release');
      await alice.peer.wait((message) => hasInvocation(message, MessageType.COMMAND_FINISHED, id));
      const related = alice.peer.messages.filter((message) => message.payload.invocationId === id);
      const responseIndex = related.findIndex((message) => message.type === MessageType.COMMAND_RESPONSE);
      const finishIndex = related.findIndex((message) => message.type === MessageType.COMMAND_FINISHED);
      assert.ok(responseIndex >= 0 && responseIndex < finishIndex);
      const messageId = text(related[responseIndex].payload.messageId);
      const persisted = await fixture.messageRepo.findById(messageId);
      assert.equal(persisted?.content, 'Delayed persistent result');
      assert.equal(persisted?.userId, botId);
      const history = await alice.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId: privateChannel });
      assert.equal(records(history.payload.messages).filter((message) => message.id === messageId).length, 1);
      await bot.peer.error(MessageType.COMMAND_RESPONSE, { invocationId: id, content: 'Genuinely late', ephemeral: false }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    } finally {
      gate.emit('release');
      delayed.mock.restore();
    }
  });

  const form = {
    title: 'First step', fields: [
      { name: 'title', type: 'text', label: 'Title', required: true, minLength: 2, maxLength: 20, multiline: true, defaultValue: '' },
      { name: 'size', type: 'integer', label: 'Size', required: true, min: 1, max: 10 },
      { name: 'mode', type: 'select', label: 'Mode', required: true, choices: [{
        label: 'One', value: 'one', description: 'Preview one', audio: AUDIO_PREVIEW,
      }] },
      { name: 'enabled', type: 'boolean', label: 'Enabled', required: true },
      { name: 'teams', type: 'string-list', label: 'Teams', required: true, minItems: 2, maxItems: 3, defaultValue: [] },
    ],
  };
  const formValues = { title: 'Example', size: 2, mode: 'one', enabled: false, teams: [' Team A ', 'Team B'] };
  const ask = async (invocationId: string, interactionId: string, nextForm: unknown = form) => {
    bot.peer.send(MessageType.COMMAND_PROMPT, { invocationId, interactionId, form: nextForm });
    return alice.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_PROMPT, invocationId) && m.payload.interactionId === interactionId);
  };

  await t.test('supports private form rounds with single-consumption and replay protection', async () => {
    const { id } = await invoke();
    await bot.peer.error(MessageType.COMMAND_PROMPT, { invocationId: id, interactionId: 'bad-default', form: { title: 'Bad', fields: [{ name: 'x', label: 'X', type: 'integer', min: 2, defaultValue: 1 }] } }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    const prompt = await ask(id, 'round-one');
    assert.equal(prompt.payload.botName, 'Updated Bot');
    assert.equal(prompt.payload.channelId, textChannel);
    assert.deepEqual(record(records(record(records(record(prompt.payload.form).fields)[2]).choices)[0]).audio, AUDIO_PREVIEW);
    assert.ok(typeof prompt.payload.expiresAt === 'number' && prompt.payload.expiresAt > Date.now());
    await barrier();
    for (const peer of [bob.peer, otherDevice.peer, otherBot.peer, owner.peer]) {
      assert.ok(!peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_PROMPT, id)));
    }
    await bot.peer.error(MessageType.COMMAND_PROMPT, { invocationId: id, interactionId: 'parallel', form }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    await otherBot.peer.error(MessageType.COMMAND_PROMPT, { invocationId: id, interactionId: 'forged', form }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    const submission = { invocationId: id, interactionId: 'round-one', values: formValues };
    for (const peer of [bob.peer, otherDevice.peer, otherBot.peer]) {
      await peer.error(MessageType.COMMAND_SUBMIT, submission, ProtocolErrorCode.BOT_INTERACTION_INVALID);
      await peer.error(MessageType.COMMAND_CANCEL, { invocationId: id }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    }
    await otherBot.peer.error(MessageType.COMMAND_FINISH, { invocationId: id }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    for (const values of [
      {}, { ...formValues, size: '2' }, { ...formValues, mode: 'unknown' },
      { ...formValues, teams: ['Same', ' same '] }, { ...formValues, unexpected: true },
    ]) {
      await alice.peer.error(MessageType.COMMAND_SUBMIT, { ...submission, values }, ProtocolErrorCode.BOT_INVALID_OPTIONS);
    }
    await alice.peer.error(MessageType.COMMAND_SUBMIT, { ...submission, interactionId: 'wrong-round' }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    const accepted = await alice.peer.request(MessageType.COMMAND_SUBMIT, submission);
    assert.equal(accepted.type, MessageType.COMMAND_SUBMITTED);
    assert.deepEqual(commandSubmitSchema.parse(accepted.payload).values, { ...formValues, teams: ['Team A', 'Team B'] });
    await bot.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_SUBMITTED, id));
    await alice.peer.error(MessageType.COMMAND_SUBMIT, submission, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    await bot.peer.error(MessageType.COMMAND_PROMPT, { invocationId: id, interactionId: 'round-one', form }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    await ask(id, 'round-two', { title: 'Second step', fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }] });
    const second = await alice.peer.request(MessageType.COMMAND_SUBMIT, { invocationId: id, interactionId: 'round-two', values: { answer: 'Done' } });
    assert.equal(second.type, MessageType.COMMAND_SUBMITTED);
    await barrier();
    assert.equal(bot.peer.messages.filter((m) => hasInvocation(m, MessageType.COMMAND_SUBMITTED, id)).length, 2);
    bot.peer.send(MessageType.COMMAND_RESPONSE, { invocationId: id, content: 'Reply before finish' });
    bot.peer.send(MessageType.COMMAND_FINISH, { invocationId: id });
    await alice.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, id));
    const related = alice.peer.messages.filter((m) => m.payload.invocationId === id);
    assert.ok(related.findIndex((m) => m.payload.content === 'Reply before finish') < related.findIndex((m) => m.type === MessageType.COMMAND_FINISHED));
    assert.ok(related.some((m) => m.payload.content === 'Reply before finish'));
    await alice.peer.error(MessageType.COMMAND_SUBMIT, submission, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
  });

  await t.test('acknowledges invocation and submission before dispatching to the bot', async () => {
    const sends: ProtocolMessage<unknown>[] = [];
    const original = fixture.wsServer.send.bind(fixture.wsServer);
    const spy = t.mock.method(fixture.wsServer, 'send', (ws: WebSocket, message: ProtocolMessage<unknown>) => {
      sends.push(message);
      original(ws, message);
    });
    try {
      const { id } = await invoke();
      const matching = (message: ProtocolMessage<unknown>) => record(message.payload).invocationId === id;
      const related = sends.filter(matching);
      assert.equal(related[0].type, MessageType.COMMAND_INVOKED);
      assert.equal(related[1].type, MessageType.COMMAND_INVOKE);
      await ask(id, 'ack-order');
      await alice.peer.request(MessageType.COMMAND_SUBMIT, { invocationId: id, interactionId: 'ack-order', values: formValues });
      await barrier();
      const submitted = sends.filter((m) => m.type === MessageType.COMMAND_SUBMITTED && matching(m));
      assert.equal(submitted.length, 2);
      assert.equal(typeof submitted[0].requestId, 'string');
      assert.equal(submitted[1].requestId, undefined);
      await finish(id);
    } finally {
      spy.mock.restore();
    }
  });

  await t.test('cancels the whole invocation and rejects late replies and submissions', async () => {
    const { id } = await invoke();
    await ask(id, 'cancel-me');
    const cancelled = await alice.peer.request(MessageType.COMMAND_CANCEL, { invocationId: id });
    assert.equal(cancelled.type, MessageType.COMMAND_FINISHED);
    assert.equal(commandFinishedSchema.parse(cancelled.payload).reason, 'cancelled');
    assert.equal((await bot.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, id))).payload.reason, 'cancelled');
    await alice.peer.error(MessageType.COMMAND_SUBMIT, { invocationId: id, interactionId: 'cancel-me', values: formValues }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    await bot.peer.error(MessageType.COMMAND_RESPONSE, { invocationId: id, content: 'Too late', ephemeral: false }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    await barrier();
    assert.ok(!bob.peer.messages.some((m) => m.payload.content === 'Too late'));
  });

  await t.test('bounds concurrent invocations per originating socket and releases capacity', async () => {
    const active = [];
    for (let i = 0; i < LIMITS.MAX_BOT_INVOCATIONS_PER_SESSION; i++) active.push(await invoke());
    await alice.peer.error(MessageType.COMMAND_INVOKE, { commandName: 'ping', botId, channelId: textChannel }, ProtocolErrorCode.BOT_COMMAND_BUSY);
    const independent = await invoke(otherDevice.peer);
    await alice.peer.request(MessageType.COMMAND_CANCEL, { invocationId: active[0].id });
    const replacement = await invoke();
    for (const { id } of [...active.slice(1), independent, replacement]) await finish(id);
  });

  await t.test('expires interactions on later activity and rejects previously valid submissions', async () => {
    const { id } = await invoke();
    await ask(id, 'expires');
    const now = Date.now();
    const clock = t.mock.method(Date, 'now', () => now + LIMITS.BOT_INTERACTION_TIMEOUT_MS + 1);
    try {
      await alice.peer.error(MessageType.COMMAND_SUBMIT, { invocationId: id, interactionId: 'expires', values: formValues }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
      assert.equal((await bot.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, id))).payload.reason, 'expired');
    } finally {
      clock.mock.restore();
    }
  });

  await t.test('permission loss, privacy changes and channel deletion clean pending state', async () => {
    const active = await invoke();
    await ask(active.id, 'permissions');
    const member = await fixture.roleRepo.findByName('Membro');
    assert.ok(member);
    const changed = await owner.peer.request(MessageType.ROLE_UPDATE, { roleId: member.id, permissions: DEFAULT_PERMISSIONS & ~Permission.SEND_MESSAGES });
    assert.equal(changed.type, MessageType.ROLES_LIST);
    assert.equal((await alice.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, active.id))).payload.reason, 'cancelled');
    await alice.peer.error(MessageType.COMMAND_INVOKE, { commandName: 'ping', botId, channelId: textChannel }, ProtocolErrorCode.PERMISSION_DENIED);
    await alice.peer.error(MessageType.COMMAND_SUBMIT, { invocationId: active.id, interactionId: 'permissions', values: formValues }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    await owner.peer.request(MessageType.ROLE_UPDATE, { roleId: member.id, permissions: DEFAULT_PERMISSIONS });
    const secret = await invoke(alice.peer, privateChannel);
    await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: privateChannel, allowedRoleIds: [] });
    assert.equal((await alice.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, secret.id))).payload.reason, 'cancelled');
    await bot.peer.error(MessageType.COMMAND_RESPONSE, { invocationId: secret.id, content: 'Leaked after privacy change', ephemeral: false }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    const ownerPrivate = await invoke(owner.peer, privateChannel);
    await owner.peer.request(MessageType.CHANNEL_DELETE, { channelId: privateChannel });
    assert.equal((await bot.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, ownerPrivate.id))).payload.reason, 'cancelled');
    await bot.peer.error(MessageType.COMMAND_RESPONSE, { invocationId: ownerPrivate.id, content: 'Leaked after deletion', ephemeral: false }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    await barrier();
    assert.ok(!bob.peer.messages.some((m) => String(m.payload.content).startsWith('Leaked')));
  });

  await t.test('bot channel switches preserve defaults and block admins and existing forms', async () => {
    assert.equal((await fixture.channelService.getChannelSummary(textChannel))?.botCommandsEnabled, true);
    const created = await owner.peer.request(MessageType.CHANNEL_CREATE, {
      name: 'disabled-bots', type: 'TEXT', botCommandsEnabled: false,
    });
    const channel = record(created.payload.channel);
    assert.equal(channel.botCommandsEnabled, false);
    const disabledId = text(channel.id);
    await owner.peer.error(MessageType.COMMAND_INVOKE, {
      channelId: disabledId, botId, commandName: 'ping',
    }, ProtocolErrorCode.PERMISSION_DENIED);
    const renamed = await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: disabledId, name: 'still-disabled' });
    assert.equal(record(renamed.payload.channel).botCommandsEnabled, false);
    assert.equal((await fixture.channelService.getChannelSummary(disabledId))?.botCommandsEnabled, false);
    await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: disabledId, botCommandsEnabled: true });
    const active = await invoke(owner.peer, disabledId);
    bot.peer.send(MessageType.COMMAND_PROMPT, { invocationId: active.id, interactionId: 'disable-channel', form });
    await owner.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_PROMPT, active.id));
    await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: disabledId, botCommandsEnabled: false });
    assert.equal((await owner.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, active.id))).payload.reason, 'cancelled');
    await owner.peer.error(MessageType.COMMAND_SUBMIT, {
      invocationId: active.id, interactionId: 'disable-channel', values: formValues,
    }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    await bot.peer.error(MessageType.COMMAND_RESPONSE, {
      invocationId: active.id, content: 'Blocked even for admins', ephemeral: false,
    }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    await owner.peer.request(MessageType.CHANNEL_DELETE, { channelId: disabledId });
  });

  await t.test('USE_BOT_COMMANDS revocation cancels forms without revoking ordinary chat', async () => {
    const member = await fixture.roleRepo.findByName('Membro');
    assert.ok(member);
    const active = await invoke();
    await ask(active.id, 'revoke-bot-permission');
    try {
      await owner.peer.request(MessageType.ROLE_UPDATE, {
        roleId: member.id, permissions: DEFAULT_PERMISSIONS & ~Permission.USE_BOT_COMMANDS,
      });
      assert.equal((await alice.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, active.id))).payload.reason, 'cancelled');
      await alice.peer.error(MessageType.COMMAND_INVOKE, {
        channelId: textChannel, botId, commandName: 'ping',
      }, ProtocolErrorCode.PERMISSION_DENIED);
      await alice.peer.error(MessageType.COMMAND_SUBMIT, {
        invocationId: active.id, interactionId: 'revoke-bot-permission', values: formValues,
      }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
      const sent = await alice.peer.request(MessageType.CHAT_SEND, { channelId: textChannel, content: 'Chat still allowed' });
      assert.equal(sent.type, MessageType.CHAT_MESSAGE);
    } finally {
      await owner.peer.request(MessageType.ROLE_UPDATE, { roleId: member.id, permissions: DEFAULT_PERMISSIONS });
    }
  });

  await t.test('checks bot permission and channel switch again at submission without broadcasts', async () => {
    const member = await fixture.roleRepo.findByName('Membro');
    assert.ok(member);
    for (const revoked of ['permission', 'channel']) {
      const active = await invoke();
      await ask(active.id, `direct-${revoked}`);
      try {
        if (revoked === 'permission') {
          await fixture.roleRepo.update(member.id, { permissions: DEFAULT_PERMISSIONS & ~Permission.USE_BOT_COMMANDS });
        } else {
          await fixture.channelService.updateChannel({ channelId: textChannel, botCommandsEnabled: false });
        }
        await alice.peer.error(MessageType.COMMAND_SUBMIT, {
          invocationId: active.id, interactionId: `direct-${revoked}`, values: formValues,
        }, ProtocolErrorCode.PERMISSION_DENIED);
        assert.ok(!bot.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_SUBMITTED, active.id)));
      } finally {
        await fixture.roleRepo.update(member.id, { permissions: DEFAULT_PERMISSIONS });
        await fixture.channelService.updateChannel({ channelId: textChannel, botCommandsEnabled: true });
      }
    }
  });

  await t.test('MANAGE_BOTS grants management independently from bot command permission', async () => {
    await alice.peer.error(MessageType.BOT_CREATE, {}, ProtocolErrorCode.PERMISSION_DENIED);
    const managerRole = {
      id: randomUUID(), name: 'Bot managers', color: '#123456', permissions: Permission.MANAGE_BOTS,
      position: 2, isDefault: false, createdAt: Date.now(),
    };
    await fixture.roleRepo.create(managerRole);
    await fixture.roleRepo.assignRole(alice.id, managerRole.id);
    try {
      const managed = await alice.peer.request(MessageType.BOT_CREATE, {});
      assert.equal(managed.type, MessageType.BOT_CREATED);
      const managedId = text(record(managed.payload.bot).id);
      await alice.peer.error(MessageType.BOT_UPDATE_PROFILE, { botId, name: 'Manager override' }, ProtocolErrorCode.PERMISSION_DENIED);
      assert.equal((await alice.peer.request(MessageType.BOT_REVOKE, { botId: managedId })).type, MessageType.BOT_REVOKED);
    } finally {
      await fixture.roleRepo.delete(managerRole.id);
    }
  });

  await t.test('revalidates access on submissions and replies even without a visibility broadcast', async () => {
    const member = await fixture.roleRepo.findByName('Membro');
    assert.ok(member);
    const submission = await invoke();
    await ask(submission.id, 'recheck');
    await fixture.roleRepo.update(member.id, { permissions: DEFAULT_PERMISSIONS & ~Permission.SEND_MESSAGES });
    try {
      await alice.peer.error(MessageType.COMMAND_SUBMIT, {
        invocationId: submission.id, interactionId: 'recheck', values: formValues,
      }, ProtocolErrorCode.PERMISSION_DENIED);
      assert.equal((await bot.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, submission.id))).payload.reason, 'cancelled');
      assert.ok(!bot.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_SUBMITTED, submission.id)));
    } finally {
      await fixture.roleRepo.update(member.id, { permissions: DEFAULT_PERMISSIONS });
    }

    const publicReply = await invoke();
    await fixture.roleRepo.update(member.id, { permissions: DEFAULT_PERMISSIONS & ~Permission.SEND_MESSAGES });
    try {
      await bot.peer.error(MessageType.COMMAND_RESPONSE, {
        invocationId: publicReply.id, content: 'Denied publication', ephemeral: false,
      }, ProtocolErrorCode.PERMISSION_DENIED);
      assert.equal((await alice.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, publicReply.id))).payload.reason, 'cancelled');
      await barrier();
      assert.ok(!bob.peer.messages.some((m) => m.payload.content === 'Denied publication'));
    } finally {
      await fixture.roleRepo.update(member.id, { permissions: DEFAULT_PERMISSIONS });
    }
  });

  await t.test('socket replacement cannot inherit another connection’s pending form', async () => {
    const old = await invoke();
    await ask(old.id, 'old-device');
    alice = await fixture.human('Alice', alice.keys, alice.deviceId);
    const ended = await bot.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, old.id));
    assert.equal(ended.payload.reason, 'caller_disconnected');
    await alice.peer.error(MessageType.COMMAND_SUBMIT, { invocationId: old.id, interactionId: 'old-device', values: formValues }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    assert.ok(!alice.peer.messages.some((m) => hasInvocation(m, MessageType.COMMAND_PROMPT, old.id)));
    const botOld = await invoke();
    await ask(botOld.id, 'old-bot');
    bot = await fixture.bot(token, bot.keys);
    assert.equal((await alice.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, botOld.id))).payload.reason, 'bot_disconnected');
    assert.equal(fixture.registry.listAll().filter((command) => command.botId === botId).length, 0);
    await bot.peer.error(MessageType.COMMAND_RESPONSE, { invocationId: botOld.id, content: 'Replacement response' }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    await register();
  });

  await t.test('caller loss, bot disconnect, and member removal end both endpoints', async () => {
    const departed = await invoke(bob.peer);
    await bob.peer.close();
    assert.equal((await bot.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, departed.id))).payload.reason, 'caller_disconnected');
    const disconnectedBot = await invoke();
    await bot.peer.close();
    assert.equal((await alice.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, disconnectedBot.id))).payload.reason, 'bot_disconnected');
    bot = await fixture.bot(token, bot.keys);
    await register();
    const kicked = await fixture.human('Kickable');
    const kickedOtherDevice = await fixture.human('Kickable', kicked.keys);
    const kickedInvocation = await invoke(kicked.peer);
    const closed = Promise.all([once(kicked.peer.ws, 'close'), once(kickedOtherDevice.peer.ws, 'close')]);
    assert.equal((await owner.peer.request(MessageType.MEMBER_KICK, { targetUserId: kicked.id })).type, MessageType.MEMBER_KICKED);
    assert.equal((await bot.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, kickedInvocation.id))).payload.reason, 'caller_disconnected');
    await closed;
    for (const { peer } of [kicked, kickedOtherDevice]) {
      const notifications = peer.messages.filter((message) =>
        message.type === MessageType.MEMBER_KICKED && message.payload.userId === kicked.id
      );
      assert.equal(notifications.length, 1, 'every removed device must receive its kick reason before closure');
      assert.equal(notifications[0].payload.nickname, 'Kickable');
    }
  });

  await t.test('removes avatars explicitly and does not report success when storage fails', async () => {
    const before = await fixture.botRepo.findById(botId);
    assert.ok(before?.avatarPath);
    const failStorage = t.mock.method(fixture.avatars, 'saveAvatar', async () => { throw new Error('Test storage failure'); });
    try {
      await bot.peer.error(MessageType.BOT_UPDATE_PROFILE, { name: 'Must not persist', avatarBase64: PNG }, ProtocolErrorCode.INTERNAL_ERROR);
      assert.equal((await fixture.botRepo.findById(botId))?.name, before.name);
      assert.equal((await fixture.botRepo.findById(botId))?.avatarPath, before.avatarPath);
      assert.ok(fixture.avatars.getAvatarFile(before.avatarPath));
    } finally {
      failStorage.mock.restore();
    }
    await owner.peer.error(MessageType.BOT_UPDATE_PROFILE, { botId, avatarBase64: null }, ProtocolErrorCode.PERMISSION_DENIED);
    assert.equal((await fixture.botRepo.findById(botId))?.avatarPath, before.avatarPath);
    const cleared = await bot.peer.request(MessageType.BOT_UPDATE_PROFILE, { avatarBase64: null });
    assert.equal(cleared.type, MessageType.BOT_PROFILE_UPDATED);
    assert.equal(record(cleared.payload.bot).avatarUrl, null);
    assert.equal(fixture.registry.find(botId, 'ping')?.botAvatarUrl, null);
    assert.equal(fixture.avatars.getAvatarFile(before.avatarPath), null);
  });

  await t.test('installs typed manifests with actual photos and rejects invalid images', async () => {
    let registration: Record<string, unknown> | undefined;
    let icon = PNG;
    const keys = identity();
    let registrationStatus = 200;
    let registrationKey = keys.publicKey;
    const manifestServer = http.createServer((req, res) => {
      if (req.url === '/manifest') {
        const address = manifestServer.address();
        assert.ok(address && typeof address === 'object');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ name: 'Installed Bot', icon, registrationUrl: `http://127.0.0.1:${address.port}/register` }));
      } else {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          registration = record(parsed);
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = registrationStatus;
          res.end(JSON.stringify({ publicKey: registrationKey }));
        });
      }
    });
    manifestServer.listen(0, '127.0.0.1');
    await once(manifestServer, 'listening');
    const address = manifestServer.address();
    assert.ok(address && typeof address === 'object');
    const manifestUrl = `http://127.0.0.1:${address.port}/manifest`;
    try {
      const installed = await owner.peer.request(MessageType.BOT_INSTALL, { manifestUrl });
      assert.equal(installed.type, MessageType.BOT_INSTALLED);
      const installedBot = record(installed.payload.bot);
      assert.equal(installedBot.name, 'Installed Bot');
      assert.equal(installedBot.bound, true);
      assert.match(text(installedBot.avatarUrl), /^\/avatars\/.+\.png$/);
      assert.ok(registration);
      assert.match(text(registration.token), /^[a-f0-9]{64}$/);
      assert.equal(registration.serverName, 'Bot tests');
      const count = await fixture.botRepo.count();
      icon = 'not an image';
      await owner.peer.error(MessageType.BOT_INSTALL, { manifestUrl }, ProtocolErrorCode.AVATAR_INVALID_TYPE);
      assert.equal(await fixture.botRepo.count(), count);
      icon = PNG;
      registrationStatus = 502;
      const rejected = await owner.peer.request(MessageType.BOT_INSTALL, { manifestUrl });
      assert.equal(rejected.type, MessageType.SERVER_ERROR);
      assert.equal(rejected.payload.code, ProtocolErrorCode.BAD_REQUEST);
      assert.match(text(rejected.payload.message), /registro.*502/);
      assert.equal(await fixture.botRepo.count(), count, 'a rejected registration must not leave an offline account behind');
      registrationStatus = 200;
      registrationKey = 'invalid-key';
      await owner.peer.error(MessageType.BOT_INSTALL, { manifestUrl }, ProtocolErrorCode.BAD_REQUEST);
      assert.equal(await fixture.botRepo.count(), count, 'an invalid confirmation must not leave an account behind');
    } finally {
      await new Promise<void>((resolve, reject) => manifestServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  await t.test('revocation clears commands, aborts active work, and prevents token reuse', async () => {
    const active = await invoke();
    await ask(active.id, 'revoked');
    const revoked = await owner.peer.request(MessageType.BOT_REVOKE, { botId });
    assert.equal(revoked.type, MessageType.BOT_REVOKED);
    assert.equal((await alice.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, active.id))).payload.reason, 'bot_disconnected');
    assert.equal(fixture.registry.find(botId, 'ping'), undefined);
    assert.equal(await fixture.botRepo.findById(botId), null);
    const rejected = await fixture.connect();
    const response = await rejected.request(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION, nickname: 'Revoked', publicKey: bot.keys.publicKey, botToken: token,
    });
    assert.equal(response.type, MessageType.AUTH_FAILED);
  });

  await t.test('shutdown notifies both endpoints before closing sockets', async () => {
    const registered = await otherBot.peer.request(MessageType.COMMAND_REGISTER, { commands: [{ name: 'alive', description: 'Pending on shutdown' }] });
    assert.equal(registered.type, MessageType.COMMAND_REGISTERED);
    const active = await alice.peer.request(MessageType.COMMAND_INVOKE, { botId: otherBotId, commandName: 'alive', channelId: textChannel });
    const id = text(active.payload.invocationId);
    fixture.wsServer.close();
    assert.equal((await alice.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, id))).payload.reason, 'failed');
    assert.equal((await otherBot.peer.wait((m) => hasInvocation(m, MessageType.COMMAND_FINISHED, id))).payload.reason, 'failed');
  });
});

test('autocomplete and sound downloads over authenticated WebSockets', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const owner = await fixture.human('Download owner');
  let alice = await fixture.human('Download Alice');
  const otherDevice = await fixture.human('Download Alice', alice.keys);
  const bob = await fixture.human('Download Bob');
  const channels = records(record(owner.auth.payload.server).channels);
  const channelId = text(channels.find((channel) => channel.type === 'TEXT')?.id);
  const voiceChannelId = text(channels.find((channel) => channel.type === 'VOICE')?.id);
  const role = { id: randomUUID(), name: 'Download members', color: '#123456', permissions: 0, position: 1, isDefault: false, createdAt: Date.now() };
  await fixture.roleRepo.create(role);
  await fixture.roleRepo.assignRole(alice.id, role.id);
  const privateCreated = await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'private-downloads', type: 'TEXT', isPrivate: true, allowedRoleIds: [role.id],
  });
  const privateChannelId = text(record(privateCreated.payload.channel).id);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const botId = text(record(created.payload.bot).id);
  const token = text(created.payload.token);
  let bot = await fixture.bot(token, undefined, 'Downloader');
  const otherCreated = await owner.peer.request(MessageType.BOT_CREATE, {});
  const otherBot = await fixture.bot(text(otherCreated.payload.token));
  const definitions = [
    {
      name: 'search', description: 'Search audio', downloadsSound: true,
      options: [
        { name: 'sound', description: 'Sound', type: 'string', required: true, autocomplete: true },
        { name: 'count', description: 'Count', type: 'integer', min: 0, max: 10 },
        { name: 'enabled', description: 'Enabled', type: 'boolean' },
        { name: 'target', description: 'Target', type: 'user' },
      ],
    },
    { name: 'plain', description: 'No download' },
  ];
  const register = async () => {
    assert.equal((await bot.peer.request(MessageType.COMMAND_REGISTER, { commands: definitions })).type, MessageType.COMMAND_REGISTERED);
  };
  await register();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let queryNumber = 0;
  const searchInput = (overrides: Partial<CommandAutocompletePayload> = {}): CommandAutocompletePayload => ({
    botId, commandName: 'search', channelId, optionName: 'sound',
    query: `query-${++queryNumber}`, options: { count: 0, enabled: false }, locale: 'en', ...overrides,
  });
  const search = async (peer = alice.peer, overrides: Partial<CommandAutocompletePayload> = {}, requestId = randomUUID()) => {
    now += LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS;
    const input = searchInput(overrides);
    const since = bot.peer.messages.length;
    peer.send(MessageType.COMMAND_AUTOCOMPLETE, input, requestId);
    const execution = await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE && message.payload.query === input.query, since);
    return { peer, requestId, execution, botRequestId: text(execution.requestId) };
  };
  const invoke = async (peer = alice.peer, commandName = 'search', targetChannelId = channelId) => {
    const acknowledged = await peer.request(MessageType.COMMAND_INVOKE, {
      botId, commandName, channelId: targetChannelId, locale: 'en',
      options: commandName === 'search' ? { sound: `/instant/${'x'.repeat(503)}` } : {},
      allowSoundDownload: commandName === 'search',
    });
    assert.equal(acknowledged.type, MessageType.COMMAND_INVOKED);
    const id = text(acknowledged.payload.invocationId);
    const execution = await bot.peer.wait((message) => hasInvocation(message, MessageType.COMMAND_INVOKE, id));
    assert.equal(execution.payload.invokerId, peer === alice.peer ? alice.id : bob.id);
    return id;
  };
  const sound = { url: 'https://example.com/sound.mp3', fileName: 'sound.mp3', title: 'Selected sound' };
  const download = async (invocationId: string, peer = alice.peer) => {
    const requestId = randomUUID();
    bot.peer.send(MessageType.COMMAND_SOUND_DOWNLOAD, { invocationId, ...sound }, requestId);
    const message = await peer.wait((entry) => hasInvocation(entry, MessageType.COMMAND_SOUND_DOWNLOAD, invocationId));
    return { requestId, received: commandSoundDownloadReceivedSchema.parse(message.payload) };
  };
  const finish = async (invocationId: string) => {
    assert.equal((await bot.peer.request(MessageType.COMMAND_FINISH, { invocationId })).type, MessageType.COMMAND_FINISHED);
  };
  const result = {
    status: 'ok',
    choices: [{ label: 'Sound', value: `/instant/${'x'.repeat(503)}`, description: 'Audio', audio: AUDIO_PREVIEW }],
  };

  await t.test('correlates identical client IDs privately and authenticates the responding bot', async () => {
    const sharedId = randomUUID();
    const first = await search(alice.peer, { channelId: privateChannelId }, sharedId);
    const second = await search(bob.peer, {}, sharedId);
    assert.notEqual(first.botRequestId, second.botRequestId);
    assert.notEqual(first.botRequestId, sharedId);
    assert.deepEqual(first.execution.payload, {
      commandName: 'search', optionName: 'sound', query: first.execution.payload.query,
      options: { count: 0, enabled: false }, locale: 'en',
    });
    const denied = otherBot.peer.wait((message) => message.type === MessageType.SERVER_ERROR && message.requestId === first.botRequestId);
    otherBot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, result, first.botRequestId);
    assert.equal((await denied).payload.code, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    otherDevice.peer.send(MessageType.COMMAND_AUTOCOMPLETE_CANCEL, { requestId: sharedId });
    await otherDevice.peer.barrier();
    assert.equal(bot.peer.messages.some((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === first.botRequestId), false);
    bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, result, second.botRequestId);
    bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, result, first.botRequestId);
    for (const peer of [alice.peer, bob.peer]) {
      const received = await peer.wait((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === sharedId);
      assert.deepEqual(commandAutocompleteResultSchema.parse(received.payload), result);
    }
    await otherDevice.peer.barrier();
    assert.equal(otherDevice.peer.messages.some((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT), false);
    assert.equal(alice.peer.messages.some((message) => message.type === MessageType.COMMAND_INVOKED), false);
  });

  await t.test('validates partial inputs and throttles across devices while cancelling superseded work', async () => {
    for (const invalid of [
      { optionName: 'count' }, { query: 'x'.repeat(201) }, { options: { sound: 'edited' } },
      { options: { count: 'wrong' } }, { options: { count: 11 } }, { options: { target: 'non-member' } },
    ]) {
      now += LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS;
      await alice.peer.error(MessageType.COMMAND_AUTOCOMPLETE, { ...searchInput(), ...invalid }, ProtocolErrorCode.BOT_INVALID_OPTIONS);
    }
    now += LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS;
    await alice.peer.error(MessageType.COMMAND_AUTOCOMPLETE, searchInput({ channelId: voiceChannelId }), ProtocolErrorCode.CHANNEL_NOT_FOUND);
    await bot.peer.error(MessageType.COMMAND_AUTOCOMPLETE, searchInput(), ProtocolErrorCode.PERMISSION_DENIED);
    const old = await search();
    await otherDevice.peer.error(MessageType.COMMAND_AUTOCOMPLETE, searchInput(), ProtocolErrorCode.RATE_LIMITED);
    const nextId = randomUUID();
    alice.peer.send(MessageType.COMMAND_AUTOCOMPLETE, searchInput(), nextId);
    assert.equal((await alice.peer.wait((message) => message.requestId === nextId)).payload.code, ProtocolErrorCode.RATE_LIMITED);
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === old.botRequestId);
    bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, result, old.botRequestId);
    assert.equal((await bot.peer.wait((message) =>
      message.type === MessageType.SERVER_ERROR && message.requestId === old.botRequestId)).payload.code, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    assert.equal(alice.peer.messages.some((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === old.requestId), false);
  });

  await t.test('rejects invalid choices, expires late replies and aborts on explicit cancellation or registry changes', async () => {
    const invalid = await search();
    bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, { ...result, choices: [result.choices[0], result.choices[0]] }, invalid.botRequestId);
    assert.deepEqual((await alice.peer.wait((message) => message.requestId === invalid.requestId)).payload, {
      status: 'failed', reason: 'invalid_response',
    });
    const expired = await search();
    now += LIMITS.BOT_AUTOCOMPLETE_TIMEOUT_MS;
    bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, result, expired.botRequestId);
    assert.deepEqual((await alice.peer.wait((message) => message.requestId === expired.requestId)).payload, {
      status: 'failed', reason: 'timeout',
    });
    const cancelled = await search();
    alice.peer.send(MessageType.COMMAND_AUTOCOMPLETE_CANCEL, { requestId: cancelled.requestId });
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === cancelled.botRequestId);
    const replaced = await search();
    await register();
    assert.equal((await alice.peer.wait((message) => message.requestId === replaced.requestId)).payload.code, ProtocolErrorCode.BOT_COMMAND_NOT_FOUND);
  });

  await t.test('revalidates autocomplete permission and channel access on replies without a broadcast', async () => {
    const member = await fixture.roleRepo.findByName('Membro');
    assert.ok(member);
    for (const revoked of ['permission', 'send', 'channel']) {
      const pending = await search();
      try {
        if (revoked === 'channel') await fixture.channelService.updateChannel({ channelId, botCommandsEnabled: false });
        else await fixture.roleRepo.update(member.id, {
          permissions: DEFAULT_PERMISSIONS & ~(revoked === 'permission' ? Permission.USE_BOT_COMMANDS : Permission.SEND_MESSAGES),
        });
        bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, result, pending.botRequestId);
        const denied = await alice.peer.wait((message) => message.requestId === pending.requestId);
        assert.equal(denied.type, MessageType.SERVER_ERROR);
        assert.equal(denied.payload.code, ProtocolErrorCode.PERMISSION_DENIED);
        await bot.peer.wait((message) =>
          message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === pending.botRequestId);
      } finally {
        await fixture.roleRepo.update(member.id, { permissions: DEFAULT_PERMISSIONS });
        await fixture.channelService.updateChannel({ channelId, botCommandsEnabled: true });
      }
    }
  });

  await t.test('requires explicit declared consent and never upgrades an existing invocation through re-registration', async () => {
    for (const allowSoundDownload of [undefined, false]) {
      await alice.peer.error(MessageType.COMMAND_INVOKE, {
        botId, commandName: 'search', channelId, options: { sound: 'selected' }, allowSoundDownload,
      }, ProtocolErrorCode.PERMISSION_DENIED);
    }
    await alice.peer.error(MessageType.COMMAND_INVOKE, {
      botId, commandName: 'plain', channelId, allowSoundDownload: true,
    }, ProtocolErrorCode.BOT_INVALID_OPTIONS);
    await bot.peer.error(MessageType.COMMAND_INVOKE, {
      botId, commandName: 'search', channelId, options: { sound: 'selected' }, allowSoundDownload: true,
    }, ProtocolErrorCode.PERMISSION_DENIED);
    await bot.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD, {
      ...sound, invocationId: randomUUID(),
    }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    const invocationId = await invoke(alice.peer, 'plain');
    await bot.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD, { ...sound, invocationId }, ProtocolErrorCode.PERMISSION_DENIED);
    await bot.peer.request(MessageType.COMMAND_REGISTER, {
      commands: definitions.map((definition) => ({ ...definition, downloadsSound: true })),
    });
    await bot.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD, { ...sound, invocationId }, ProtocolErrorCode.PERMISSION_DENIED);
    await finish(invocationId);
    await register();
  });

  await t.test('routes downloads and results only to the original device with trusted attribution and single consumption', async () => {
    const invocationId = await invoke(alice.peer, 'search', privateChannelId);
    await bot.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD, {
      ...sound, invocationId, userId: bob.id, channelId,
    }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    await otherBot.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD, { ...sound, invocationId }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    const pending = await download(invocationId);
    assert.equal(pending.received.botId, botId);
    assert.equal(pending.received.botName, 'Downloader');
    assert.equal(pending.received.commandName, 'search');
    assert.equal(pending.received.channelId, privateChannelId);
    assert.equal(pending.received.invokerId, alice.id);
    assert.equal(pending.received.invokerNickname, 'Download Alice');
    assert.equal(pending.received.expiresAt - pending.received.createdAt, LIMITS.BOT_SOUND_DOWNLOAD_TIMEOUT_MS);
    assert.notEqual(pending.received.downloadId, pending.requestId);
    await bot.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD, { ...sound, invocationId }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    const submitted = { invocationId, downloadId: pending.received.downloadId, result: { status: 'downloaded' } };
    for (const peer of [otherDevice.peer, bob.peer, bot.peer, otherBot.peer]) {
      await peer.error(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, submitted, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    }
    for (const invalid of [
      { ...submitted, downloadId: 'forged' },
      { ...submitted, result: { status: 'downloaded', filePath: 'C:\\Private\\sound.mp3' } },
      { ...submitted, userId: bob.id },
    ]) await alice.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, invalid, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    const ack = await alice.peer.request(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, submitted);
    assert.equal(ack.type, MessageType.COMMAND_SOUND_DOWNLOAD_RESULT);
    const delivered = await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_SOUND_DOWNLOAD_RESULT && message.requestId === pending.requestId);
    assert.deepEqual(commandSoundDownloadResultSchema.parse(delivered.payload), submitted);
    for (const peer of [otherDevice.peer, bob.peer, otherBot.peer]) {
      await peer.barrier();
      assert.equal(peer.messages.some((message) => hasInvocation(message, MessageType.COMMAND_SOUND_DOWNLOAD, invocationId)), false);
      assert.equal(peer.messages.some((message) => hasInvocation(message, MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, invocationId)), false);
    }
    await alice.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, submitted, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    await bot.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD, { ...sound, invocationId }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    await finish(invocationId);
  });

  await t.test('forwards exists, failure and cancellation without renewing the download allowance', async () => {
    for (const outcome of [{ status: 'exists' }, { status: 'failed', reason: 'too_large' }, { status: 'cancelled' }]) {
      const invocationId = await invoke();
      const pending = await download(invocationId);
      await alice.peer.request(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
        invocationId, downloadId: pending.received.downloadId, result: outcome,
      });
      const delivered = await bot.peer.wait((message) =>
        message.type === MessageType.COMMAND_SOUND_DOWNLOAD_RESULT && message.requestId === pending.requestId);
      assert.deepEqual(delivered.payload.result, outcome);
      await bot.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD, { ...sound, invocationId }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
      await finish(invocationId);
    }
  });

  await t.test('cancels pending I/O with invocation lifecycle and rechecks permissions before accepting a result', async () => {
    const invocationId = await invoke();
    const pending = await download(invocationId);
    await alice.peer.request(MessageType.COMMAND_CANCEL, { invocationId });
    const cancellation = await alice.peer.wait((message) => hasInvocation(message, MessageType.COMMAND_SOUND_DOWNLOAD_CANCEL, invocationId));
    assert.equal(cancellation.payload.downloadId, pending.received.downloadId);
    await alice.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
      invocationId, downloadId: pending.received.downloadId, result: { status: 'downloaded' },
    }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    const member = await fixture.roleRepo.findByName('Membro');
    assert.ok(member);
    for (const revoked of ['permission', 'channel']) {
      const active = await invoke();
      const downloadRequest = await download(active);
      try {
        if (revoked === 'channel') await fixture.channelService.updateChannel({ channelId, botCommandsEnabled: false });
        else await fixture.roleRepo.update(member.id, { permissions: DEFAULT_PERMISSIONS & ~Permission.USE_BOT_COMMANDS });
        await alice.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
          invocationId: active, downloadId: downloadRequest.received.downloadId, result: { status: 'downloaded' },
        }, ProtocolErrorCode.PERMISSION_DENIED);
        await alice.peer.wait((message) => hasInvocation(message, MessageType.COMMAND_SOUND_DOWNLOAD_CANCEL, active));
        assert.equal((await bot.peer.wait((message) => hasInvocation(message, MessageType.COMMAND_FINISHED, active))).payload.reason, 'cancelled');
        assert.equal(bot.peer.messages.some((message) => hasInvocation(message, MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, active)), false);
      } finally {
        await fixture.roleRepo.update(member.id, { permissions: DEFAULT_PERMISSIONS });
        await fixture.channelService.updateChannel({ channelId, botCommandsEnabled: true });
      }
    }
  });

  await t.test('channel deletion cancels both autocomplete and local download work', async () => {
    const invocationId = await invoke(alice.peer, 'search', privateChannelId);
    await download(invocationId);
    const pending = await search(alice.peer, { channelId: privateChannelId });
    await owner.peer.request(MessageType.CHANNEL_DELETE, { channelId: privateChannelId });
    assert.equal((await alice.peer.wait((message) => message.requestId === pending.requestId)).payload.code, ProtocolErrorCode.CHANNEL_NOT_FOUND);
    await alice.peer.wait((message) => hasInvocation(message, MessageType.COMMAND_SOUND_DOWNLOAD_CANCEL, invocationId));
    assert.equal((await bot.peer.wait((message) => hasInvocation(message, MessageType.COMMAND_FINISHED, invocationId))).payload.reason, 'cancelled');
  });

  await t.test('replacement sockets and bot disconnects cannot inherit pending downloads or searches', async () => {
    const invocationId = await invoke();
    const pendingDownload = await download(invocationId);
    const pendingSearch = await search();
    alice = await fixture.human('Download Alice', alice.keys, alice.deviceId);
    assert.equal((await bot.peer.wait((message) => hasInvocation(message, MessageType.COMMAND_FINISHED, invocationId))).payload.reason, 'caller_disconnected');
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === pendingSearch.botRequestId);
    await alice.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
      invocationId, downloadId: pendingDownload.received.downloadId, result: { status: 'downloaded' },
    }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    assert.equal(alice.peer.messages.some((message) => hasInvocation(message, MessageType.COMMAND_SOUND_DOWNLOAD, invocationId)), false);
    const active = await invoke();
    await download(active);
    const searchBeforeDisconnect = await search();
    const keys = bot.keys;
    await bot.peer.close();
    await alice.peer.wait((message) => hasInvocation(message, MessageType.COMMAND_SOUND_DOWNLOAD_CANCEL, active));
    assert.equal((await alice.peer.wait((message) => hasInvocation(message, MessageType.COMMAND_FINISHED, active))).payload.reason, 'bot_disconnected');
    assert.equal((await alice.peer.wait((message) => message.requestId === searchBeforeDisconnect.requestId)).payload.code, ProtocolErrorCode.BOT_OFFLINE);
    bot = await fixture.bot(token, keys);
    await register();
    await bot.peer.error(MessageType.COMMAND_SOUND_DOWNLOAD, { ...sound, invocationId: active }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
  });
});

test('bot permission migration preserves existing roles and channels and runs only once', async (t) => {
  const dataDir = path.join(__dirname, '..', `.bot-migration-data-${process.pid}-${randomUUID()}`);
  const dbPath = path.join(dataDir, 'server.db');
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const legacy = await SqlJsDriver.create(dbPath);
  const migrations = path.join(__dirname, 'infrastructure', 'database', 'migrations');
  legacy.exec('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const file of fs.readdirSync(migrations).filter((name) => name.endsWith('.sql') && name < '017').sort()) {
    legacy.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
    legacy.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, Date.now());
  }
  const previous = [0, Permission.SEND_MESSAGES, Permission.MANAGE_BOTS, 0xFFFFFFFF];
  previous.forEach((permissions, index) => {
    legacy.prepare('INSERT INTO roles (id, name, permissions, created_at) VALUES (?, ?, ?, ?)')
      .run(`legacy-${index}`, `Legacy ${index}`, permissions, 0);
  });
  legacy.prepare('INSERT INTO channels (id, server_id, name, type, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('legacy-channel', 'legacy-server', 'Legacy', 'TEXT', 0);
  legacy.close();
  const migrated = await DatabaseConnection.create(dbPath);
  try {
    const roleRepo = new SqliteRoleRepository(migrated.getDb());
    for (const [index, permissions] of previous.entries()) {
      assert.equal((await roleRepo.findById(`legacy-${index}`))?.permissions, (permissions | Permission.USE_BOT_COMMANDS) >>> 0);
    }
    const channelRepo = new SqliteChannelRepository(migrated.getDb());
    assert.equal((await channelRepo.findById('legacy-channel'))?.botCommandsEnabled, true);
    await channelRepo.update('legacy-channel', { botCommandsEnabled: false });
    await roleRepo.update('legacy-0', { permissions: 0 });
  } finally {
    migrated.close();
  }
  const reopened = await DatabaseConnection.create(dbPath);
  try {
    assert.equal((await new SqliteRoleRepository(reopened.getDb()).findById('legacy-0'))?.permissions, 0);
    assert.equal((await new SqliteChannelRepository(reopened.getDb()).findById('legacy-channel'))?.botCommandsEnabled, false);
  } finally {
    reopened.close();
  }
});

test('invocation limits and timers bound memory and release all capacity', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const caller = await fixture.human('Timer user');
  const channelId = text(records(record(caller.auth.payload.server).channels).find((c) => c.type === 'TEXT')?.id);
  const botPeer = await fixture.connect();
  const origin: BotInteractionSession = {
    ws: caller.peer.ws, sessionId: `${caller.id}:timer`,
    user: { id: caller.id, clientId: 'timer', nickname: 'Timer user', status: 'ONLINE', joinedAt: 0 },
  };
  const bot: BotInteractionSession = {
    ws: botPeer.ws, sessionId: 'bot:timer', isBot: true, botId: 'timer',
    user: { id: 'timer', clientId: 'bot-timer', nickname: 'Timer bot', status: 'ONLINE', joinedAt: 0, isBot: true },
  };
  const messages: ProtocolMessage<unknown>[] = [];
  const errors: ProtocolErrorCode[] = [];
  const registry = new CommandRegistry();
  registry.register('timer', 'Timer bot', [{ name: 'timer', description: 'Expire' }]);
  const handler = new BotInteractionHandler({
    isCurrent: () => true,
    findBot: () => bot,
    send: (_ws, message) => { messages.push(message); },
    sendError: (_ws, code) => { errors.push(code); },
    broadcastToChannel: async () => { assert.fail('Timer test must not publish'); },
    publishResponse: async () => { assert.fail('Timer test must not publish'); },
  }, fixture.channelService, fixture.userService, registry);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    for (let i = 0; i < LIMITS.MAX_BOT_INVOCATIONS_PER_SESSION; i++) {
      await handler.invoke(origin, { botId: 'timer', commandName: 'timer', channelId });
    }
    t.mock.timers.tick(LIMITS.BOT_INTERACTION_TIMEOUT_MS);
    const finished = messages.filter((m) => m.type === MessageType.COMMAND_FINISHED);
    assert.equal(finished.length, LIMITS.MAX_BOT_INVOCATIONS_PER_SESSION * 2);
    assert.ok(finished.every((m) => commandFinishedSchema.parse(m.payload).reason === 'expired'));
    await handler.invoke(origin, { botId: 'timer', commandName: 'timer', channelId });
    assert.deepEqual(errors, []);
    handler.disconnect(origin);

    const origins: BotInteractionSession[] = [];
    const originCount = Math.ceil(LIMITS.MAX_BOT_INVOCATIONS / LIMITS.MAX_BOT_INVOCATIONS_PER_SESSION);
    for (let i = 0; i < originCount; i++) {
      const peer = await fixture.connect();
      origins.push({ ...origin, ws: peer.ws, sessionId: randomUUID() });
    }
    const start = messages.length;
    for (let i = 0; i < LIMITS.MAX_BOT_INVOCATIONS; i++) {
      await handler.invoke(origins[Math.floor(i / LIMITS.MAX_BOT_INVOCATIONS_PER_SESSION)], {
        botId: 'timer', commandName: 'timer', channelId,
      });
    }
    assert.deepEqual(errors, []);
    await handler.invoke(origin, { botId: 'timer', commandName: 'timer', channelId });
    assert.deepEqual(errors, [ProtocolErrorCode.BOT_COMMAND_BUSY]);
    const firstId = text(record(messages[start].payload).invocationId);
    handler.cancel(origins[0], { invocationId: firstId });
    await handler.invoke(origin, { botId: 'timer', commandName: 'timer', channelId });
    assert.equal(errors.length, 1);
    handler.close();
    const afterClose = messages.length;
    t.mock.timers.tick(LIMITS.BOT_INTERACTION_TIMEOUT_MS * 2);
    assert.equal(messages.length, afterClose, 'closed invocations must not leave live timers');
  } finally {
    handler.close();
    t.mock.timers.reset();
  }
});

test('autocomplete and sound download timers bound state and discard responses cancelled during authorization', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const caller = await fixture.human('Download timers');
  const channelId = text(records(record(caller.auth.payload.server).channels).find((channel) => channel.type === 'TEXT')?.id);
  const current = new Set<BotInteractionSession>();
  const socket = (): WebSocket => {
    // Transport-only sockets avoid opening a thousand network connections for the capacity test.
    const value: unknown = Reflect.construct(WebSocket, [null, undefined, { autoPong: true, closeTimeout: 0 }]);
    assert.ok(value instanceof WebSocket);
    return value;
  };
  const origin = (index: number): BotInteractionSession => {
    const session: BotInteractionSession = {
      ws: socket(), sessionId: `caller-${index}:device`,
      user: { id: `caller-${index}`, clientId: `client-${index}`, nickname: `Caller ${index}`, status: 'ONLINE', joinedAt: 0 },
    };
    current.add(session);
    return session;
  };
  const bot: BotInteractionSession = {
    ws: socket(), sessionId: 'bot:timer', isBot: true, botId: 'timer',
    user: { id: 'timer', clientId: 'bot-timer', nickname: 'Timer bot', status: 'ONLINE', joinedAt: 0, isBot: true },
  };
  current.add(bot);
  const messages: Array<{ ws: WebSocket; message: ProtocolMessage<unknown> }> = [];
  const errors: Array<{ ws: WebSocket; code: ProtocolErrorCode; requestId?: string }> = [];
  const registry = new CommandRegistry();
  registry.register('timer', 'Timer bot', [{
    name: 'search', description: 'Search', downloadsSound: true,
    options: [{ name: 'sound', description: 'Sound', type: 'string', required: true, autocomplete: true }],
  }]);
  const handler = new BotInteractionHandler({
    isCurrent: (session) => current.has(session),
    findBot: () => bot,
    send: (ws, message) => { messages.push({ ws, message }); },
    sendError: (ws, code, _message, requestId) => { errors.push({ ws, code, requestId }); },
    broadcastToChannel: async () => assert.fail('Downloads must not be broadcast'),
    publishResponse: async () => assert.fail('Downloads must not be published'),
  }, fixture.channelService, fixture.userService, registry);
  const granted: ChannelAccessContext = { permissions: DEFAULT_PERMISSIONS, roleIds: [] };
  let accessGate: Promise<ChannelAccessContext> | null = null;
  t.mock.method(fixture.userService, 'isMember', async () => true);
  t.mock.method(fixture.channelService, 'getAccessContext', async () => accessGate ?? granted);
  const input = { botId: 'timer', commandName: 'search', channelId, optionName: 'sound', query: 'sound' };
  const sound = { url: 'https://example.com/sound.mp3', fileName: 'sound.mp3', title: 'Sound' };
  const lastMessage = (type: MessageType): ProtocolMessage<unknown> => {
    const entry = messages.filter(({ message }) => message.type === type).pop();
    assert.ok(entry);
    return entry.message;
  };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const first = origin(0);
    await handler.autocomplete(first, input, 'first-query');
    const firstId = text(lastMessage(MessageType.COMMAND_AUTOCOMPLETE).requestId);
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_TIMEOUT_MS);
    await flush();
    const timeout = lastMessage(MessageType.COMMAND_AUTOCOMPLETE_RESULT);
    assert.equal(timeout.requestId, 'first-query');
    assert.deepEqual(timeout.payload, { status: 'failed', reason: 'timeout' });
    await handler.autocompleteResult(bot, { status: 'ok', choices: [] }, firstId);
    assert.equal(errors.pop()?.code, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);

    await handler.autocomplete(first, input, 'race-old');
    const oldId = text(lastMessage(MessageType.COMMAND_AUTOCOMPLETE).requestId);
    let releaseAccess: ((value: ChannelAccessContext) => void) | undefined;
    accessGate = new Promise((resolve) => { releaseAccess = resolve; });
    const lateResponse = handler.autocompleteResult(bot, {
      status: 'ok', choices: [{ label: 'Stale', value: 'stale' }],
    }, oldId);
    accessGate = null;
    handler.cancelAutocomplete(first, { requestId: 'race-old' });
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS);
    await handler.autocomplete(first, input, 'race-new');
    assert.ok(releaseAccess);
    releaseAccess(granted);
    await lateResponse;
    assert.equal(messages.some(({ message }) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === 'race-old'), false);
    handler.cancelAutocomplete(first, { requestId: 'race-new' });

    const origins = Array.from({ length: LIMITS.MAX_BOT_AUTOCOMPLETE_REQUESTS }, (_, index) => origin(index + 1));
    for (const [index, session] of origins.entries()) {
      await handler.autocomplete(session, input, `capacity-${index}`);
    }
    assert.equal(errors.length, 0);
    const extra = origin(LIMITS.MAX_BOT_AUTOCOMPLETE_REQUESTS + 1);
    await handler.autocomplete(extra, input, 'capacity-full');
    assert.equal(errors.pop()?.code, ProtocolErrorCode.BOT_COMMAND_BUSY);
    handler.cancelAutocomplete(origins[0], { requestId: 'capacity-0' });
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS);
    await handler.autocomplete(extra, input, 'capacity-released');
    assert.equal(errors.length, 0);
    current.delete(bot);
    handler.disconnect(bot);
    assert.equal(errors.length, LIMITS.MAX_BOT_AUTOCOMPLETE_REQUESTS);
    assert.ok(errors.every((error) => error.code === ProtocolErrorCode.BOT_OFFLINE));
    errors.length = 0;
    current.add(bot);

    const downloader = origin(LIMITS.MAX_BOT_AUTOCOMPLETE_REQUESTS + 2);
    await handler.autocomplete(downloader, input, 'before-invocation');
    const invocationInput = {
      botId: 'timer', commandName: 'search', channelId, options: { sound: 'selected' }, allowSoundDownload: true,
    };
    await handler.invoke(downloader, invocationInput);
    const invocationId = text(record(lastMessage(MessageType.COMMAND_INVOKED).payload).invocationId);
    await handler.downloadSound(bot, { ...sound, invocationId }, 'download-timeout');
    const received: CommandSoundDownloadReceivedPayload =
      commandSoundDownloadReceivedSchema.parse(lastMessage(MessageType.COMMAND_SOUND_DOWNLOAD).payload);
    t.mock.timers.tick(LIMITS.BOT_SOUND_DOWNLOAD_TIMEOUT_MS);
    await flush();
    assert.deepEqual(lastMessage(MessageType.COMMAND_SOUND_DOWNLOAD_CANCEL).payload, {
      invocationId, downloadId: received.downloadId,
    });
    const timedResult = lastMessage(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT);
    assert.equal(timedResult.requestId, 'download-timeout');
    assert.deepEqual(commandSoundDownloadResultSchema.parse(timedResult.payload).result, { status: 'failed', reason: 'timeout' });
    await handler.respond(bot, { invocationId, content: 'The download timed out.' });
    assert.equal(record(lastMessage(MessageType.COMMAND_RESPONSE).payload).ephemeral, true);
    await handler.downloadSound(bot, { ...sound, invocationId }, 'duplicate');
    assert.equal(errors.pop()?.code, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    handler.complete(bot, { invocationId });

    await handler.invoke(downloader, invocationInput);
    const cancelledId = text(record(lastMessage(MessageType.COMMAND_INVOKED).payload).invocationId);
    await handler.downloadSound(bot, { ...sound, invocationId: cancelledId }, 'cancelled-download');
    handler.cancel(downloader, { invocationId: cancelledId });
    const afterCancellation = messages.length;
    t.mock.timers.tick(LIMITS.BOT_INTERACTION_TIMEOUT_MS * 2);
    await flush();
    assert.equal(messages.length, afterCancellation, 'Cancelled work must leave no live timers.');
    handler.close();
    await handler.autocomplete(downloader, input, 'closed');
    assert.equal(messages.length, afterCancellation);
  } finally {
    handler.close();
    t.mock.timers.reset();
  }
});
