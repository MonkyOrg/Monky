import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
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
  commandExecutionSchema,
  commandFinishedSchema,
  commandSubmitSchema,
} from '@monky/shared';
import { AttachmentService } from './application/services/AttachmentService';
import { AuthService } from './application/services/AuthService';
import { BotService } from './application/services/BotService';
import { ChannelService } from './application/services/ChannelService';
import { ChatService } from './application/services/ChatService';
import { CommandRegistry } from './application/services/CommandRegistry';
import { PermissionService } from './application/services/PermissionService';
import { RoleService } from './application/services/RoleService';
import { SignalingService } from './application/services/SignalingService';
import { UserService } from './application/services/UserService';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
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
  const attachmentService = new AttachmentService(
    new SqliteAttachmentRepository(db), serverRepo, new AttachmentStorageService(dataDir), rateLimiter
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
  const wsServer = new WebSocketServer(
    httpServer,
    new AuthService(serverRepo, userRepo, channelRepo, mentionRepo, avatars, () => online(), attachmentService, permissions, roleService),
    userService,
    channelService,
    new ChatService(
      messageRepo, channelRepo, userRepo, mentionRepo, avatars, rateLimiter, attachmentService, serverRepo,
      (userId, channelId) => channelService.canUserAccessChannel(userId, channelId)
    ),
    new SignalingService(channelRepo),
    serverRepo,
    attachmentService,
    permissions,
    roleService,
    new CoturnManager(dataDir),
    new SfuManager(),
    botService,
    registry
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
  const human = async (nickname: string, keys = identity(), deviceId = randomUUID()) => {
    const peer = await connect();
    const challenge = await peer.request(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION, nickname, publicKey: keys.publicKey, deviceId,
    });
    assert.equal(challenge.type, MessageType.AUTH_CHALLENGE);
    const signature = sign(null, Buffer.from(text(challenge.payload.nonce), 'hex'), keys.privateKey).toString('hex');
    const auth = await peer.request(MessageType.AUTH_CHALLENGE_RESPONSE, { signature });
    assert.equal(auth.type, MessageType.AUTH_SUCCESS);
    return { peer, keys, deviceId, id: text(record(auth.payload.currentUser).id), auth };
  };
  const bot = async (token: string, keys = identity()) => {
    const peer = await connect();
    const auth = await peer.request(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION, nickname: 'Untrusted SDK nickname', publicKey: keys.publicKey, botToken: token,
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
    channelService, userService, registry, dataDir,
  };
}

function hasInvocation(message: Received, type: MessageType, id: string): boolean {
  return message.type === type && message.payload.invocationId === id;
}

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
  const created = await owner.peer.request(MessageType.BOT_CREATE, { name: 'Actual Bot', avatarBase64: `data:image/png;base64,${PNG}` });
  assert.equal(created.type, MessageType.BOT_CREATED);
  const botInfo = record(created.payload.bot);
  const botId = text(botInfo.id);
  const avatarUrl = text(botInfo.avatarUrl);
  const token = text(created.payload.token);
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
  let bot = await fixture.bot(token);
  const secondCreated = await owner.peer.request(MessageType.BOT_CREATE, { name: 'Other Bot' });
  const otherBotId = text(record(secondCreated.payload.bot).id);
  const otherBot = await fixture.bot(text(secondCreated.payload.token));
  const commands = [
    { name: 'ping', description: 'A simple command' },
    {
      name: 'survey', description: 'Typed options', options: [
        { name: 'topic', description: 'Topic', type: 'string', required: true, choices: [{ label: 'News', value: 'news' }] },
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

  await t.test('uses stored bot profiles and rejects invalid profile changes without partial writes', async () => {
    const authUser = record(bot.auth.payload.currentUser);
    assert.equal(authUser.nickname, 'Actual Bot');
    assert.equal(authUser.avatarUrl, avatarUrl);
    assert.ok(!records(record(bot.auth.payload.server).channels).some((channel) => channel.id === privateChannel));
    const listed = await owner.peer.request(MessageType.BOT_LIST);
    assert.equal(listed.type, MessageType.BOT_LIST_RESPONSE);
    const onlineBot = records(listed.payload.bots).find((item) => item.id === botId);
    assert.equal(onlineBot?.online, true);
    assert.equal(onlineBot?.bound, true);
    for (const key of ['token', 'tokenHash', 'boundPublicKey', 'avatarPath']) assert.ok(!(key in record(onlineBot)));
    await bob.peer.error(MessageType.BOT_UPDATE_PROFILE, { botId, name: 'Not allowed' }, ProtocolErrorCode.PERMISSION_DENIED);
    await bot.peer.error(MessageType.BOT_UPDATE_PROFILE, { botId: otherBotId, name: 'Not allowed' }, ProtocolErrorCode.PERMISSION_DENIED);
    await owner.peer.error(MessageType.BOT_UPDATE_PROFILE, { name: 'Missing id' }, ProtocolErrorCode.BOT_INVALID_PROFILE);
    await bot.peer.error(MessageType.BOT_UPDATE_PROFILE, {}, ProtocolErrorCode.BOT_INVALID_PROFILE);
    await bot.peer.error(MessageType.BOT_UPDATE_PROFILE, { name: 'Partial change', avatarBase64: 'invalid!' }, ProtocolErrorCode.AVATAR_INVALID_TYPE);
    await bot.peer.error(MessageType.BOT_UPDATE_PROFILE, { avatarBase64: `data:image/jpeg;base64,${PNG}` }, ProtocolErrorCode.AVATAR_INVALID_TYPE);
    await owner.peer.error(MessageType.BOT_CREATE, { name: 'Invalid image', avatarBase64: 'AAAA' }, ProtocolErrorCode.AVATAR_INVALID_TYPE);
    await owner.peer.error(MessageType.BOT_CREATE, { name: 'Invalid fields', avatarBase64: PNG, unexpected: true }, ProtocolErrorCode.BOT_INVALID_PROFILE);
    const tooLarge = await fixture.botService.create('Too big', owner.id, 'A'.repeat(Math.ceil(LIMITS.MAX_AVATAR_SIZE * 4 / 3) + 257));
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

  const form = {
    title: 'First step', fields: [
      { name: 'title', type: 'text', label: 'Title', required: true, minLength: 2, maxLength: 20, multiline: true, defaultValue: '' },
      { name: 'size', type: 'integer', label: 'Size', required: true, min: 1, max: 10 },
      { name: 'mode', type: 'select', label: 'Mode', required: true, choices: [{ label: 'One', value: 'one' }] },
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
    const cleared = await owner.peer.request(MessageType.BOT_UPDATE_PROFILE, { botId, avatarBase64: null });
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
