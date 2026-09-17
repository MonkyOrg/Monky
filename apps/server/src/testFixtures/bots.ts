import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket } from 'ws';
import { BOT_CAPABILITIES, MessageType, PROTOCOL_VERSION, ProtocolErrorCode, type BotCapability, type UserSummary } from '@monky/shared';
import { AttachmentService } from '../application/services/AttachmentService';
import { AuthService } from '../application/services/AuthService';
import { BotService } from '../application/services/BotService';
import { BotSelectorService } from '../application/services/BotSelectorService';
import { BotSettingsService } from '../application/services/BotSettingsService';
import { BotPermissionService } from '../application/services/BotPermissionService';
import { SqliteBotPermissionRepository } from '../infrastructure/database/SqliteBotPermissionRepository';
import { ChannelService } from '../application/services/ChannelService';
import { ChatService } from '../application/services/ChatService';
import { CommandRegistry } from '../application/services/CommandRegistry';
import { PermissionService } from '../application/services/PermissionService';
import { RoleService } from '../application/services/RoleService';
import { SignalingService } from '../application/services/SignalingService';
import { UserService } from '../application/services/UserService';
import { DatabaseConnection } from '../infrastructure/database/DatabaseConnection';
import { SqliteBotSettingsRepository } from '../infrastructure/database/SqliteBotSettingsRepository';
import { SqliteBotSelectorRepository } from '../infrastructure/database/SqliteBotSelectorRepository';
import { SqliteVoiceRestrictionRepository } from '../infrastructure/database/SqliteVoiceRestrictionRepository';
import {
  SqliteAttachmentRepository,
  SqliteBotRepository,
  SqliteChannelRepository,
  SqliteMentionRepository,
  SqliteMessageRepository,
  SqliteRoleRepository,
  SqliteServerRepository,
  SqliteUserRepository,
} from '../infrastructure/database/SqliteRepositories';
import { AttachmentStorageService } from '../infrastructure/security/AttachmentStorageService';
import { AvatarStorageService } from '../infrastructure/security/AvatarStorageService';
import { RateLimiter } from '../infrastructure/security/RateLimiter';
import { SfuManager } from '../infrastructure/sfu/SfuManager';
import { CoturnManager } from '../infrastructure/turn/CoturnManager';
import { WebSocketServer } from '../infrastructure/websocket/WebSocketServer';
import { ensureServerSeedData } from '../server';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), 'expected an object payload');
  return value;
}

export function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), 'expected an array');
  return value.map(record);
}

export function text(value: unknown): string {
  assert.equal(typeof value, 'string');
  assert.ok(typeof value === 'string');
  return value;
}

export interface Received {
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

export function identity() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
  };
}

export class Peer {
  readonly messages: Received[] = [];
  private listeners = new Set<(message: Received) => void>();

  constructor(readonly ws: WebSocket, private readonly requestedCapabilities?: BotCapability[]) {
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
    if (type === MessageType.COMMAND_REGISTER && this.requestedCapabilities && isRecord(payload) &&
        !Object.hasOwn(payload, 'requestedCapabilities')) {
      payload = { ...payload, requestedCapabilities: this.requestedCapabilities };
    }
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

/** Existing API regressions run with explicitly pre-approved bot fixtures. Consent tests use createFixture(). */
export function createApprovedBotFixture() {
  return createFixture({ approvedBotCapabilities: [...BOT_CAPABILITIES] });
}

export async function createFixture(options: {
  approvedBotCapabilities?: BotCapability[];
  webSocketHeaders?: Record<string, string>;
  webSocketPath?: string;
} = {}) {
  const dataDir = path.join(__dirname, '..', '..', `.bot-test-data-${process.pid}-${randomUUID()}`);
  const database = await DatabaseConnection.create(path.join(dataDir, 'server.db'));
  const db = database.getDb();
  const serverRepo = new SqliteServerRepository(db);
  const userRepo = new SqliteUserRepository(db);
  const channelRepo = new SqliteChannelRepository(db);
  const messageRepo = new SqliteMessageRepository(db);
  const mentionRepo = new SqliteMentionRepository(db);
  const roleRepo = new SqliteRoleRepository(db);
  const botRepo = new SqliteBotRepository(db);
  const botPermissions = new BotPermissionService(new SqliteBotPermissionRepository(db));
  const avatars = new AvatarStorageService(dataDir);
  const rateLimiter = new RateLimiter();
  const attachmentRepo = new SqliteAttachmentRepository(db);
  const attachmentService = new AttachmentService(
    attachmentRepo, serverRepo, new AttachmentStorageService(dataDir), rateLimiter
  );
  const permissions = new PermissionService(serverRepo, roleRepo);
  const roleService = new RoleService(roleRepo, userRepo, permissions);
  const channelService = new ChannelService(channelRepo, serverRepo, roleRepo, permissions, botPermissions);
  const registry = new CommandRegistry();
  let online: () => Map<string, { user: UserSummary }> = () => new Map();
  const userService = new UserService(userRepo, avatars, () => online());
  const botService = new BotService(botRepo, serverRepo, avatars, () => {
    const bots = new Map<string, UserSummary>();
    for (const { user } of online().values()) if (user.isBot) bots.set(user.id, user);
    return bots;
  }, botPermissions);
  await ensureServerSeedData({ serverName: 'Bot tests', maxUsers: 10 }, serverRepo, channelRepo, roleRepo);
  const httpServer = http.createServer();
  const chatService = new ChatService(
    messageRepo, channelRepo, userRepo, mentionRepo, avatars, rateLimiter, attachmentService, serverRepo,
    (userId, channelId) => channelService.canUserAccessChannel(userId, channelId)
  );
  const signalingService = new SignalingService(channelRepo, new SqliteVoiceRestrictionRepository(db));
  const coturnManager = new CoturnManager(dataDir);
  const wsServer = new WebSocketServer(
    httpServer,
    new AuthService(serverRepo, userRepo, channelRepo, mentionRepo, avatars, () => online(), attachmentService, permissions, roleService),
    userService,
    channelService,
    chatService,
    signalingService,
    serverRepo,
    attachmentService,
    permissions,
    roleService,
    coturnManager,
    new SfuManager(),
    botService,
    registry,
    new BotSelectorService(new SqliteBotSelectorRepository(database.getDb())),
    new BotSettingsService(new SqliteBotSettingsRepository(database.getDb()), botPermissions)
  );
  online = () => wsServer.getOnlineUsersMap();
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const address = httpServer.address();
  assert.ok(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}`;
  const peers: Peer[] = [];
  const connect = async () => {
    const peer = new Peer(new WebSocket(`${url}${options.webSocketPath ?? ''}`, {
      headers: options.webSocketHeaders,
    }), options.approvedBotCapabilities);
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
    if (options.approvedBotCapabilities) {
      const linked = await botRepo.findByTokenHash(BotService.hashToken(token));
      if (linked && botPermissions.get(linked.id)?.requested === null) {
        const { permissions: state } = botPermissions.declare(linked.id, options.approvedBotCapabilities);
        botPermissions.approve(linked.createdByUserId, {
          botId: linked.id, expectedRevision: state.revision, granted: options.approvedBotCapabilities,
        });
      }
    }
    const peer = await connect();
    const auth = await peer.request(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION, nickname: name, publicKey: keys.publicKey, botToken: token,
    });
    assert.equal(auth.type, MessageType.AUTH_SUCCESS);
    return { peer, keys, auth };
  };
  const dispose = async () => {
    await wsServer.close();
    await Promise.all(peers.map((peer) => peer.close()));
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    rateLimiter.dispose();
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return {
    url,
    connect, human, bot, dispose, peers, wsServer, botService, botRepo, roleRepo, avatars,
    channelService, userService, registry, dataDir, messageRepo, channelRepo, userRepo, serverRepo, chatService, attachmentRepo,
    database, permissions, botPermissions, signalingService, coturnManager,
  };
}
