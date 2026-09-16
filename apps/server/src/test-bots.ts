import assert from 'node:assert/strict';
import { listOnlineHumans } from './application/services/onlineHumans';
import { randomUUID } from 'node:crypto';
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
  CommandAudioPreviewPayload,
  CommandSoundDownloadReceivedPayload,
  commandAutocompleteResultSchema,
  commandAudioPreviewResultSchema,
  commandSoundDownloadReceivedSchema,
  commandSoundDownloadResultSchema,
  commandExecutionSchema,
  commandFinishedSchema,
  commandSubmitSchema,
  botSettingsSnapshotSchema,
  botSettingsListResponseSchema,
  botSelectorRespondedSchema,
  botVoiceJoinedSchema,
  botScreenSchema,
  botScreenRemovedSchema,
  localSourceResultSchema,
  localTaskOfferSchema,
  localTaskEventSchema,
  type LocalTaskOffer,
  type LocalTaskSpec,
  type LocalRequestContext,
  type BotSettingsDefinition,
  type BotSettingsPatch,
} from '@monky/shared';
import { BotService } from './application/services/BotService';
import { BotSelectorService } from './application/services/BotSelectorService';
import { BotSettingsService } from './application/services/BotSettingsService';
import { SqliteBotSettingsRepository } from './infrastructure/database/SqliteBotSettingsRepository';
import { SqliteBotSelectorRepository } from './infrastructure/database/SqliteBotSelectorRepository';
import { ChannelAccessContext } from './application/services/ChannelService';
import type { MessageRecord } from './domain/entities';
import { CommandRegistry } from './application/services/CommandRegistry';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqliteVoiceRestrictionRepository } from './infrastructure/database/SqliteVoiceRestrictionRepository';
import { SqlJsDriver } from './infrastructure/database/SqliteWrapper';
import {
  SqliteBotRepository,
  SqliteChannelRepository,
  SqliteMessageRepository,
  SqliteRoleRepository,
  SqliteServerRepository,
  SqliteUserRepository,
} from './infrastructure/database/SqliteRepositories';
import { AvatarStorageService } from './infrastructure/security/AvatarStorageService';
import { BotInteractionHandler, BotInteractionSession } from './infrastructure/websocket/BotInteractionHandler';
import { ensureServerSeedData } from './server';
import { createFixture, identity, record, records, text, type Received } from './testFixtures/bots';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const AUDIO_PREVIEW = { url: 'https://cdn.example.test/effect.mp3', fileName: 'effect.mp3', durationMs: 1200 };

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

async function createPrivateVoiceFixture(t: TestContext, mode: 'p2p' | 'sfu' = 'p2p') {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Private voice owner');
  const caller = await f.human('Private voice caller');
  const channels = records(record(owner.auth.payload.server).channels);
  const textId = text(channels.find((channel) => channel.type === 'TEXT')?.id);
  const publicVoiceId = text(channels.find((channel) => channel.type === 'VOICE')?.id);
  const role = { id: randomUUID(), name: 'Private listeners', color: null, position: 1,
    permissions: 0, isDefault: false, createdAt: Date.now() };
  await f.roleRepo.create(role);
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: caller.id, roleId: role.id });
  const createdRoom = await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'private-listening', type: 'VOICE', isPrivate: true, allowedRoleIds: [role.id],
  });
  const voiceId = text(record(createdRoom.payload.channel).id);
  await caller.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId });
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const botId = text(record(created.payload.bot).id);
  const token = text(created.payload.token);
  await f.serverRepo.updateServer({ voiceMode: mode });
  const bot = await f.bot(token);
  const botSessionId = text(record(bot.auth.payload.currentUser).sessionId);
  await bot.peer.request(MessageType.COMMAND_REGISTER, { commands: [{ name: 'play', description: 'Play audio' }] });
  const invocation = await caller.peer.request(MessageType.COMMAND_INVOKE, { botId, channelId: textId, commandName: 'play' });
  assert.equal(invocation.type, MessageType.COMMAND_INVOKED);
  return { ...f, connectBot: f.bot, owner, caller, bot, botId, token, role, textId, voiceId, publicVoiceId, botSessionId,
    invocationId: text(invocation.payload.invocationId) };
}

test('miniapp end uses authenticated creator identity, real owner permissions and terminal invocation routing', async (t) => {
  const f = await createPrivateVoiceFixture(t);
  const otherDevice = await f.human('Private voice caller', f.caller.keys);
  const create = async (invocationId: string) => {
    const response = await f.bot.peer.request(MessageType.BOT_SCREEN_CREATE, {
      id: 'reusable-game', channelId: f.voiceId, invocationId,
      title: 'Private game', html: '<p>Game</p>', state: { turn: 'X' },
    });
    assert.equal(response.type, MessageType.BOT_SCREEN_SNAPSHOT);
    return botScreenSchema.parse(response.payload);
  };
  const first = await create(f.invocationId);
  const firstRef = { id: first.id, instanceId: first.instanceId };
  assert.equal(first.creatorUserId, f.caller.id);
  assert.notEqual(first.creatorUserId, text(record(f.bot.auth.payload.currentUser).id));
  await f.owner.peer.error(MessageType.BOT_SCREEN_END, firstRef, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await otherDevice.peer.error(MessageType.BOT_SCREEN_END, firstRef, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await otherDevice.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  await f.caller.peer.request(MessageType.VOICE_LEAVE, { channelId: f.voiceId });
  await f.caller.peer.close();
  const ended = botScreenRemovedSchema.parse((await otherDevice.peer.request(MessageType.BOT_SCREEN_END, firstRef)).payload);
  assert.equal(ended.reason, 'ended');
  assert.equal(ended.reason === 'ended' && ended.endedByUserId, f.caller.id);
  assert.deepEqual((await f.bot.peer.wait((message) =>
    message.type === MessageType.BOT_SCREEN_REMOVED && message.payload.instanceId === first.instanceId)).payload, ended);
  await f.bot.peer.error(MessageType.BOT_SCREEN_UPDATE, { ...firstRef, state: {}, expectedRevision: 0 }, ProtocolErrorCode.BOT_SCREEN_NOT_FOUND);

  const invocation = await otherDevice.peer.request(MessageType.COMMAND_INVOKE, {
    botId: f.botId, channelId: f.textId, commandName: 'play',
  });
  assert.equal(invocation.type, MessageType.COMMAND_INVOKED);
  const invocationId = text(invocation.payload.invocationId);
  const second = await create(invocationId);
  assert.notEqual(second.instanceId, first.instanceId);
  const secondRef = { id: second.id, instanceId: second.instanceId };
  await otherDevice.peer.error(MessageType.BOT_SCREEN_END, firstRef, ProtocolErrorCode.BOT_SCREEN_NOT_FOUND);
  f.bot.peer.send(MessageType.COMMAND_PROMPT, {
    invocationId, interactionId: 'pending-game-option',
    form: { title: 'Game option', fields: [{ name: 'answer', label: 'Answer', type: 'text' }] },
  });
  await otherDevice.peer.wait((message) =>
    message.type === MessageType.COMMAND_PROMPT && message.payload.invocationId === invocationId);
  await f.owner.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  assert.equal(await f.permissions.getUserPermissions(f.owner.id), 0xFFFFFFFF);
  const ownerEnded = botScreenRemovedSchema.parse((await f.owner.peer.request(MessageType.BOT_SCREEN_END, secondRef)).payload);
  assert.equal(ownerEnded.reason === 'ended' && ownerEnded.endedByUserId, f.owner.id);
  for (const peer of [otherDevice.peer, f.bot.peer]) {
    const finished = await peer.wait((message) =>
      message.type === MessageType.COMMAND_FINISHED && message.payload.invocationId === invocationId);
    assert.equal(finished.payload.reason, 'cancelled');
  }
  await otherDevice.peer.error(MessageType.COMMAND_SUBMIT, {
    invocationId, interactionId: 'pending-game-option', values: { answer: 'late' },
  }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
  for (const id of ['reusable-game', 'stale-command-new-id']) {
    await f.bot.peer.error(MessageType.BOT_SCREEN_CREATE, {
      id, channelId: f.voiceId, invocationId, title: 'Stale game', html: 'Game', state: {},
    }, ProtocolErrorCode.PERMISSION_DENIED);
  }
  await f.bot.peer.error(MessageType.COMMAND_FINISH, { invocationId }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
  assert.deepEqual(records((await otherDevice.peer.request(MessageType.BOT_SCREEN_LIST, { channelId: f.voiceId })).payload.screens), []);
});

test('miniapp end rejects admin revocation committed before its role broadcast', { timeout: 15000 }, async (t) => {
  const f = await createPrivateVoiceFixture(t);
  const moderator = await f.human('Miniapp moderator');
  const adminRole = await f.roleRepo.findByName('Admin');
  assert.ok(adminRole && !adminRole.isDefault);
  await f.owner.peer.request(MessageType.ROLE_ASSIGN, { userId: moderator.id, roleId: adminRole.id });
  assert.equal((await moderator.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId })).type,
    MessageType.VOICE_USER_JOINED);
  const screen = botScreenSchema.parse((await f.bot.peer.request(MessageType.BOT_SCREEN_CREATE, {
    id: 'role-fenced-game', channelId: f.voiceId, invocationId: f.invocationId,
    title: 'Role fence', html: '<p>Game</p>', state: { turn: 'X' },
  })).payload);
  await moderator.peer.wait((message) =>
    message.type === MessageType.BOT_SCREEN_SNAPSHOT && message.payload.id === screen.id);

  let authorizationRead!: () => void;
  let resumeAuthorization!: () => void;
  let rolePersisted!: () => void;
  let resumeRoleWrite!: () => void;
  const authorizationReady = new Promise<void>((resolve) => { authorizationRead = resolve; });
  const authorizationGate = new Promise<void>((resolve) => { resumeAuthorization = resolve; });
  const persistenceReady = new Promise<void>((resolve) => { rolePersisted = resolve; });
  const persistenceGate = new Promise<void>((resolve) => { resumeRoleWrite = resolve; });
  const getAccess = f.channelService.getAccessContext.bind(f.channelService);
  let reads = 0;
  t.mock.method(f.channelService, 'getAccessContext', async (userId: string) => {
    const context = await getAccess(userId);
    // Sweep and room admission read first; hold the actual END administrator check.
    if (userId === moderator.id && ++reads === 3) {
      authorizationRead();
      await authorizationGate;
    }
    return context;
  });
  const unassignRole = f.roleRepo.unassignRole.bind(f.roleRepo);
  t.mock.method(f.roleRepo, 'unassignRole', async (userId: string, roleId: string) => {
    await unassignRole(userId, roleId);
    if (userId === moderator.id && roleId === adminRole.id) {
      rolePersisted();
      await persistenceGate;
    }
  });

  const ending = moderator.peer.request(MessageType.BOT_SCREEN_END, { id: screen.id, instanceId: screen.instanceId });
  let mutation: Promise<Received> | undefined;
  try {
    await authorizationReady;
    mutation = f.owner.peer.request(MessageType.ROLE_UNASSIGN, { userId: moderator.id, roleId: adminRole.id });
    await persistenceReady;
    assert.equal(f.permissions.getRoleAccessVersion(), null, 'the repository write is held before RoleService and WS publication finish');
    assert.equal(await f.permissions.checkPermission(moderator.id, Permission.ADMINISTRATOR), false);
    resumeAuthorization();
    const response = await ending;
    resumeRoleWrite();
    await mutation;
    assert.equal(response.type, MessageType.SERVER_ERROR, 'a stale administrator grant must not end the shared game');
    assert.equal(response.payload.code, ProtocolErrorCode.BOT_COMMAND_BUSY);
    await f.bot.peer.barrier();
    assert.equal(f.bot.peer.messages.some((message) =>
      message.type === MessageType.BOT_SCREEN_REMOVED && message.payload.instanceId === screen.instanceId), false);
    assert.equal(f.bot.peer.messages.some((message) =>
      message.type === MessageType.COMMAND_FINISHED && message.payload.invocationId === f.invocationId), false);
    const listed = await f.bot.peer.request(MessageType.BOT_SCREEN_LIST, { channelId: f.voiceId });
    assert.equal(records(listed.payload.screens)[0]?.instanceId, screen.instanceId);
  } finally {
    resumeAuthorization();
    resumeRoleWrite();
    await Promise.allSettled(mutation ? [ending, mutation] : [ending]);
  }
});

test('private invocation voice grants allow only room media, retain rosters and revoke on role loss', { timeout: 30000 }, async (t) => {
  for (const mode of ['p2p', 'sfu'] as const) await t.test(mode, async (subtest) => {
    const f = await createPrivateVoiceFixture(subtest, mode);
    const payload = { channelId: f.voiceId, invocationId: f.invocationId };
    assert.equal(records(record(f.bot.auth.payload.server).channels).some((channel) => channel.id === f.voiceId), false);
    await f.bot.peer.error(MessageType.VOICE_JOIN, { channelId: f.voiceId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
    await f.bot.peer.error(MessageType.VOICE_JOIN, { ...payload, invocationId: 'unowned' }, ProtocolErrorCode.PERMISSION_DENIED);
    await f.bot.peer.error(MessageType.VOICE_JOIN, { ...payload, channelId: f.publicVoiceId }, ProtocolErrorCode.PERMISSION_DENIED);
    const original = f.permissions.getUserPermissions.bind(f.permissions);
    for (const deniedId of [f.botId, f.caller.id]) {
      f.permissions.getUserPermissions = async (userId) => userId === deniedId ? DEFAULT_PERMISSIONS & ~Permission.SPEAK : original(userId);
      await f.bot.peer.error(MessageType.VOICE_JOIN, payload, ProtocolErrorCode.PERMISSION_DENIED);
    }
    f.permissions.getUserPermissions = original;
    const joined = await f.bot.peer.request(MessageType.VOICE_JOIN, payload);
    assert.equal(joined.type, MessageType.VOICE_USER_JOINED);
    assert.ok(records(joined.payload.participants).some((entry) => record(entry.user).id === f.caller.id));
    await f.bot.peer.request(MessageType.COMMAND_FINISH, { invocationId: f.invocationId });
    let transportId: string | undefined;
    if (mode === 'sfu') {
      const created = await f.bot.peer.request(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, { channelId: f.voiceId, direction: 'send' });
      assert.equal(created.type, MessageType.SFU_WEBRTC_TRANSPORT_CREATED);
      transportId = text(record(created.payload.transportOptions).id);
      assert.ok(f.wsServer['sfuManager']['transports'].has(transportId));
    }
    const rosterSince = f.bot.peer.messages.length;
    await f.owner.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
    await f.bot.peer.wait((message) => message.type === MessageType.VOICE_USER_JOINED &&
      message.payload.userId === f.owner.id, rosterSince);
    const privateText = await f.owner.peer.request(MessageType.CHANNEL_CREATE, {
      name: 'private-chat', type: 'TEXT', isPrivate: true, allowedRoleIds: [f.role.id],
    });
    const privateTextId = text(record(privateText.payload.channel).id);
    const since = f.bot.peer.messages.length;
    await f.owner.peer.request(MessageType.CHAT_SEND, { channelId: privateTextId, content: 'not voice permission' });
    await f.bot.peer.barrier();
    assert.equal(f.bot.peer.messages.slice(since).some((message) => message.type === MessageType.CHAT_MESSAGE &&
      message.payload.channelId === privateTextId), false);
    assert.equal(f.bot.peer.messages.some((message) => message.type === MessageType.CHANNEL_CREATED &&
      record(message.payload.channel).id === privateTextId), false);
    await f.bot.peer.error(MessageType.CHAT_LOAD_HISTORY, { channelId: privateTextId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
    assert.equal(f.wsServer['signalingService'].getVoiceState(f.botSessionId)?.channelId, f.voiceId);
    const leaveSince = f.bot.peer.messages.length;
    await f.owner.peer.request(MessageType.ROLE_UNASSIGN, { userId: f.caller.id, roleId: f.role.id });
    await f.bot.peer.wait((message) => message.type === MessageType.VOICE_USER_LEFT &&
      message.payload.sessionId === f.botSessionId, leaveSince);
    assert.equal(f.wsServer['signalingService'].getVoiceState(f.botSessionId), undefined);
    if (transportId) assert.equal(f.wsServer['sfuManager']['transports'].has(transportId), false);
    await f.bot.peer.error(MessageType.VOICE_JOIN, { channelId: f.voiceId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  });
});

test('bot speaking and moderation preserve the private voice audience and authoritative restrictions', { timeout: 30000 }, async (t) => {
  for (const mode of ['p2p', 'sfu'] as const) await t.test(mode, async (subtest) => {
    const f = await createPrivateVoiceFixture(subtest, mode);
    const outsider = await f.human('Outside the private voice room');
    assert.equal(records(record(outsider.auth.payload.server).channels).some((channel) => channel.id === f.voiceId), false);
    const joined = await f.bot.peer.request(MessageType.VOICE_JOIN, {
      channelId: f.voiceId, invocationId: f.invocationId, isMuted: false, isDeafened: false,
    });
    assert.equal(record(joined.payload.voiceState).isMuted, false);
    assert.equal(record(joined.payload.voiceState).isDeafened, false);
    await f.bot.peer.request(MessageType.COMMAND_FINISH, { invocationId: f.invocationId });
    const outsiderSince = outsider.peer.messages.length;
    const callerSince = f.caller.peer.messages.length;
    const speaking = await f.bot.peer.request(MessageType.VOICE_STATE_UPDATE, { isSpeaking: true });
    assert.equal(speaking.type, MessageType.VOICE_STATE_CHANGED);
    assert.equal(record(speaking.payload.voiceState).isSpeaking, true);
    await f.caller.peer.wait((message) => message.type === MessageType.VOICE_STATE_CHANGED &&
      record(message.payload.voiceState).sessionId === f.botSessionId &&
      record(message.payload.voiceState).isSpeaking === true, callerSince);
    await f.caller.peer.error(MessageType.ADMIN_MUTE_USER, { targetUserId: f.botId, muted: true }, ProtocolErrorCode.PERMISSION_DENIED);
    assert.equal(f.wsServer['signalingService'].getVoiceState(f.botSessionId)?.isSpeaking, true);

    for (const restriction of ['serverMuted', 'serverDeafened'] as const) {
      const type = restriction === 'serverMuted' ? MessageType.ADMIN_MUTE_USER : MessageType.ADMIN_DEAFEN_USER;
      const payload = (value: boolean) => restriction === 'serverMuted'
        ? { targetUserId: f.botId, muted: value }
        : { targetUserId: f.botId, deafened: value };
      const since = f.bot.peer.messages.length;
      await f.owner.peer.request(type, payload(true));
      const restricted = await f.bot.peer.wait((message) => message.type === MessageType.VOICE_STATE_CHANGED &&
        record(message.payload.voiceState).sessionId === f.botSessionId &&
        record(message.payload.voiceState)[restriction] === true, since);
      assert.equal(record(restricted.payload.voiceState).isSpeaking, false);
      const suppressed = await f.bot.peer.request(MessageType.VOICE_STATE_UPDATE, { isSpeaking: true });
      assert.equal(record(suppressed.payload.voiceState)[restriction], true);
      assert.equal(record(suppressed.payload.voiceState).isSpeaking, false);
      await f.owner.peer.request(type, payload(false));
      const resumed = await f.bot.peer.request(MessageType.VOICE_STATE_UPDATE, { isSpeaking: true });
      assert.equal(record(resumed.payload.voiceState)[restriction], false);
      assert.equal(record(resumed.payload.voiceState).isSpeaking, true);
    }

    const quiet = await f.bot.peer.request(MessageType.VOICE_STATE_UPDATE, { isSpeaking: false });
    assert.equal(record(quiet.payload.voiceState).isSpeaking, false);
    await outsider.peer.barrier();
    assert.equal(outsider.peer.messages.slice(outsiderSince).some((message) =>
      message.type === MessageType.VOICE_STATE_CHANGED &&
      record(message.payload.voiceState).channelId === f.voiceId), false,
    'speaking and moderation must not reveal a hidden voice room to outsiders');
  });
});

test('pending bot speaking updates cannot revive a departed voice session', { timeout: 10000 }, async (t) => {
  const f = await createPrivateVoiceFixture(t);
  await f.bot.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId, invocationId: f.invocationId });
  await f.bot.peer.request(MessageType.COMMAND_FINISH, { invocationId: f.invocationId });
  const session = f.wsServer['findSessionById'](f.botSessionId);
  assert.ok(session);
  const channels = f.wsServer['channelService'];
  const original = channels.getChannelSummary.bind(channels);
  let release!: () => void;
  let started!: () => void;
  let held = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  t.after(release);
  t.mock.method(channels, 'getChannelSummary', async (...args: Parameters<typeof original>) => {
    const channel = await original(...args);
    if (args[0] === f.voiceId && !held) {
      held = true;
      started();
      await gate;
    }
    return channel;
  });
  const since = f.caller.peer.messages.length;
  const pending = f.wsServer['handleVoiceStateUpdate'](session, { isSpeaking: true });
  await waiting;
  await f.bot.peer.request(MessageType.VOICE_LEAVE, { channelId: f.voiceId });
  await f.caller.peer.wait((message) => message.type === MessageType.VOICE_USER_LEFT &&
    message.payload.sessionId === f.botSessionId, since);
  release();
  await pending;
  await f.caller.peer.barrier();
  assert.equal(f.caller.peer.messages.slice(since).some((message) =>
    message.type === MessageType.VOICE_STATE_CHANGED &&
    record(message.payload.voiceState).sessionId === f.botSessionId), false);
  assert.equal(f.wsServer['signalingService'].getVoiceState(f.botSessionId), undefined);
});

test('private invocation voice admission rechecks caller movement, cancellation and access during joins', async (t) => {
  for (const change of ['move', 'cancel', 'permissions'] as const) await t.test(change, async (subtest) => {
    const f = await createPrivateVoiceFixture(subtest);
    const service = f.wsServer['signalingService'];
    const original = service.joinVoiceChannel.bind(service);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    subtest.after(release);
    subtest.mock.method(service, 'joinVoiceChannel', async (...args: Parameters<typeof original>) => {
      if (args[0] === f.botSessionId) { started(); await gate; }
      return original(...args);
    });
    const rejected = f.bot.peer.error(MessageType.VOICE_JOIN, {
      channelId: f.voiceId, invocationId: f.invocationId,
    }, ProtocolErrorCode.PERMISSION_DENIED);
    await waiting;
    if (change === 'move') await f.caller.peer.request(MessageType.VOICE_JOIN, { channelId: f.publicVoiceId });
    else if (change === 'cancel') await f.caller.peer.request(MessageType.COMMAND_CANCEL, { invocationId: f.invocationId });
    else await f.owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: f.voiceId, allowedRoleIds: [] });
    release();
    await rejected;
    assert.equal(service.getVoiceState(f.botSessionId), undefined);
    assert.equal(f.wsServer['findSessionById'](f.botSessionId)?.botVoiceGrant, undefined);
  });
});

test('private invocation voice grants do not survive leave, replacement or channel deletion', async (t) => {
  const f = await createPrivateVoiceFixture(t, 'sfu');
  const payload = { channelId: f.voiceId, invocationId: f.invocationId };
  assert.equal((await f.bot.peer.request(MessageType.VOICE_JOIN, payload)).type, MessageType.VOICE_USER_JOINED);
  await f.bot.peer.request(MessageType.VOICE_LEAVE, { channelId: f.voiceId });
  await f.bot.peer.error(MessageType.VOICE_JOIN, { channelId: f.voiceId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await f.bot.peer.request(MessageType.VOICE_JOIN, payload);
  const replacement = await f.connectBot(f.token, f.bot.keys);
  await replacement.peer.error(MessageType.VOICE_JOIN, { channelId: f.voiceId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await replacement.peer.error(MessageType.VOICE_JOIN, payload, ProtocolErrorCode.PERMISSION_DENIED);
  await replacement.peer.request(MessageType.COMMAND_REGISTER, { commands: [{ name: 'play', description: 'Play audio' }] });
  const invocation = await f.caller.peer.request(MessageType.COMMAND_INVOKE, { botId: f.botId, channelId: f.textId, commandName: 'play' });
  await replacement.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId, invocationId: text(invocation.payload.invocationId) });
  const transport = await replacement.peer.request(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, { channelId: f.voiceId, direction: 'send' });
  const transportId = text(record(transport.payload.transportOptions).id);
  const since = replacement.peer.messages.length;
  await f.owner.peer.request(MessageType.CHANNEL_DELETE, { channelId: f.voiceId });
  await replacement.peer.wait((message) => message.type === MessageType.VOICE_USER_LEFT &&
    message.payload.sessionId === f.botSessionId, since);
  assert.equal(f.wsServer['signalingService'].getVoiceState(f.botSessionId), undefined);
  assert.equal(f.wsServer['sfuManager']['transports'].has(transportId), false);
});

test('bot voice uses real authentication metadata, room admission and originating human session context', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Voice owner');
  const otherDevice = await f.human('Voice owner', owner.keys);
  const channels = records(record(owner.auth.payload.server).channels);
  const voiceId = text(channels.find((channel) => channel.type === 'VOICE')?.id);
  const textId = text(channels.find((channel) => channel.type === 'TEXT')?.id);
  const ownerSessionId = text(record(owner.auth.payload.currentUser).sessionId);
  assert.equal((await owner.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId })).type, MessageType.VOICE_USER_JOINED);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const botId = text(record(created.payload.bot).id);
  const token = text(created.payload.token);
  const bot = await f.bot(token);
  const botSessionId = text(record(bot.auth.payload.currentUser).sessionId);
  assert.equal(record(bot.auth.payload.server).voiceMode, 'p2p');
  assert.ok(Array.isArray(bot.auth.payload.iceServers));
  assert.equal(record(record(record(bot.auth.payload.server).voiceStates)[ownerSessionId]).channelId, voiceId);
  const joined = await bot.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId });
  assert.equal(joined.type, MessageType.VOICE_USER_JOINED);
  assert.ok(records(joined.payload.participants).some((participant) => record(participant.user).isBot === true));
  assert.ok(records(joined.payload.participants).some((participant) => record(participant.voiceState).sessionId === ownerSessionId));
  await bot.peer.error(MessageType.VOICE_JOIN, { channelId: textId }, ProtocolErrorCode.BAD_REQUEST);
  await bot.peer.request(MessageType.COMMAND_REGISTER, { commands: [{ name: 'play', description: 'Play audio' }] });
  for (const [caller, expectedChannel] of [[owner, voiceId], [otherDevice, null]] as const) {
    const since = bot.peer.messages.length;
    const invoked = await caller.peer.request(MessageType.COMMAND_INVOKE, { botId, channelId: textId, commandName: 'play' });
    assert.equal(invoked.type, MessageType.COMMAND_INVOKED);
    const execution = commandExecutionSchema.parse((await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_INVOKE && message.payload.invocationId === invoked.payload.invocationId, since)).payload);
    assert.equal(execution.invokerSessionId, record(caller.auth.payload.currentUser).sessionId);
    assert.equal(execution.invokerVoiceChannelId, expectedChannel);
  }
  await owner.peer.error(MessageType.COMMAND_INVOKE, {
    botId, channelId: textId, commandName: 'play', invokerSessionId: botSessionId, invokerVoiceChannelId: voiceId,
  }, ProtocolErrorCode.BOT_INVALID_OPTIONS);
  const leaveSince = owner.peer.messages.length;
  await f.bot(token, bot.keys);
  await owner.peer.wait((message) => message.type === MessageType.VOICE_USER_LEFT &&
    message.payload.sessionId === botSessionId, leaveSince);
  assert.equal(f.wsServer['signalingService'].getVoiceState(botSessionId), undefined);
});

test('bot voice rejects inaccessible and full rooms and applies ordinary server SPEAK permissions', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Voice permissions');
  const voiceId = text(records(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'VOICE')?.id);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const botId = text(record(created.payload.bot).id);
  const bot = await f.bot(text(created.payload.token));
  await f.channelRepo.update(voiceId, { isPrivate: true, allowedRoleIds: [] });
  await bot.peer.error(MessageType.VOICE_JOIN, { channelId: voiceId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await f.channelRepo.update(voiceId, { isPrivate: false, maxParticipants: 1 });
  await owner.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId });
  await bot.peer.error(MessageType.VOICE_JOIN, { channelId: voiceId }, ProtocolErrorCode.CHANNEL_FULL);
  const original = f.permissions.getUserPermissions.bind(f.permissions);
  f.permissions.getUserPermissions = async (id) => id === botId ? DEFAULT_PERMISSIONS & ~Permission.SPEAK : original(id);
  await bot.peer.error(MessageType.VOICE_JOIN, { channelId: voiceId }, ProtocolErrorCode.PERMISSION_DENIED);
  const left = await bot.peer.request(MessageType.VOICE_LEAVE, { channelId: voiceId });
  assert.equal(left.type, MessageType.VOICE_USER_LEFT);
});

test('bot SFU metadata is truthful and media requires admitted, owned voice transports', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('SFU bot owner');
  const voiceId = text(records(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'VOICE')?.id);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  await f.serverRepo.updateServer({ voiceMode: 'sfu' });
  const bot = await f.bot(text(created.payload.token));
  assert.equal(record(bot.auth.payload.server).voiceMode, 'sfu');
  await bot.peer.error(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, { channelId: voiceId, direction: 'send' }, ProtocolErrorCode.BAD_REQUEST);
  await bot.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId });
  await bot.peer.error(MessageType.SFU_CONNECT_WEBRTC_TRANSPORT, {
    channelId: voiceId, transportId: 'foreign-transport', dtlsParameters: {},
  }, ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.error(MessageType.SFU_CONSUME, { channelId: voiceId }, ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.error(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, { channelId: voiceId, direction: 'recv' }, ProtocolErrorCode.BAD_REQUEST);
});

test('bot voice moderation is permission-checked and survives leaving and replacing the bot connection', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Bot moderator');
  const listener = await f.human('Listener');
  const voiceId = text(records(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'VOICE')?.id);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const botId = text(record(created.payload.bot).id);
  const token = text(created.payload.token);
  const bot = await f.bot(token);
  const botSessionId = text(record(bot.auth.payload.currentUser).sessionId);
  await bot.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId });
  await listener.peer.error(MessageType.ADMIN_MUTE_USER, { targetUserId: botId, muted: true }, ProtocolErrorCode.PERMISSION_DENIED);
  await listener.peer.error(MessageType.ADMIN_DEAFEN_USER, { targetUserId: botId, deafened: true }, ProtocolErrorCode.PERMISSION_DENIED);
  await listener.peer.error(MessageType.ADMIN_GET_VOICE_RESTRICTIONS, { targetUserId: botId }, ProtocolErrorCode.PERMISSION_DENIED);
  await listener.peer.error(MessageType.ADMIN_KICK_VOICE, { targetSessionId: botSessionId }, ProtocolErrorCode.PERMISSION_DENIED);
  const updateSince = bot.peer.messages.length;
  const muted = await owner.peer.request(MessageType.ADMIN_MUTE_USER, { targetUserId: botId, muted: true });
  assert.equal(muted.type, MessageType.VOICE_RESTRICTIONS_UPDATED);
  assert.equal(muted.payload.serverMuted, true);
  const deafened = await owner.peer.request(MessageType.ADMIN_DEAFEN_USER, { targetUserId: botId, deafened: true });
  assert.equal(deafened.payload.serverDeafened, true);
  await bot.peer.wait((message) => message.type === MessageType.VOICE_RESTRICTIONS_UPDATED &&
    message.payload.userId === botId && message.payload.serverMuted === true && message.payload.serverDeafened === true, updateSince);
  await bot.peer.wait((message) => message.type === MessageType.VOICE_STATE_CHANGED &&
    record(message.payload.voiceState).sessionId === botSessionId &&
    record(message.payload.voiceState).serverMuted === true, updateSince);
  await bot.peer.request(MessageType.VOICE_LEAVE, { channelId: voiceId });
  const restrictions = await owner.peer.request(MessageType.ADMIN_GET_VOICE_RESTRICTIONS, { targetUserId: botId });
  assert.deepEqual(restrictions.payload, { userId: botId, serverMuted: true, serverDeafened: true });
  const replacement = await f.bot(token, bot.keys);
  assert.deepEqual(replacement.auth.payload.voiceRestrictions, { serverMuted: true, serverDeafened: true });
  const joined = await replacement.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId });
  assert.equal(record(joined.payload.voiceState).serverMuted, true);
  assert.equal(record(joined.payload.voiceState).serverDeafened, true);
  const kickedSince = replacement.peer.messages.length;
  await owner.peer.request(MessageType.ADMIN_KICK_VOICE, { targetSessionId: botSessionId });
  await replacement.peer.wait((message) => message.type === MessageType.VOICE_USER_LEFT &&
    message.payload.sessionId === botSessionId, kickedSince);
  assert.equal(f.wsServer['signalingService'].getVoiceState(botSessionId), undefined);
  const afterKick = await replacement.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId });
  assert.equal(record(afterKick.payload.voiceState).serverMuted, true);
  assert.equal(record(afterKick.payload.voiceState).serverDeafened, true);
  await owner.peer.request(MessageType.BOT_REVOKE, { botId });
  assert.equal(record(f.database.getDb().prepare('SELECT count(*) AS count FROM bot_voice_restrictions').get()).count, 0);
});

test('administrative moves carry authenticated participant metadata into and out of a bot room', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Move moderator');
  const listener = await f.human('Moved listener');
  const listenerUser = record(listener.auth.payload.currentUser);
  const voiceId = text(records(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'VOICE')?.id);
  const destination = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'Other voice', type: 'VOICE' });
  const destinationId = text(record(destination.payload.channel).id);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const bot = await f.bot(text(created.payload.token));
  await bot.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId });
  await listener.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId });
  for (const channelId of [destinationId, voiceId]) {
    const since = bot.peer.messages.length;
    await owner.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: listenerUser.sessionId, channelId });
    const arrival = await bot.peer.wait((message) => message.type === MessageType.VOICE_USER_JOINED &&
      message.payload.sessionId === listenerUser.sessionId && message.payload.channelId === channelId, since);
    const joined = botVoiceJoinedSchema.parse(arrival.payload);
    assert.equal(joined.user.id, listenerUser.id);
    assert.equal(joined.user.sessionId, listenerUser.sessionId);
    assert.notEqual(joined.user.isBot, true);
    assert.equal(record(arrival.payload.user).nickname, 'Moved listener');
  }
});

test('bot voice restrictions persist across database reopen without weakening human foreign keys', async (t) => {
  const dataDir = path.join(__dirname, '..', `.bot-voice-data-${process.pid}-${randomUUID()}`);
  const filename = path.join(dataDir, 'server.db');
  let database = await DatabaseConnection.create(filename);
  t.after(() => { database.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  await new SqliteUserRepository(database.getDb()).create({
    id: 'owner', clientId: 'owner', publicKey: null, nickname: 'Owner', avatarPath: null, createdAt: 0, lastSeenAt: 0,
  });
  await new SqliteBotRepository(database.getDb()).create({
    id: 'voice-bot', name: 'Voice bot', tokenHash: 'test-hash', avatarPath: null, boundPublicKey: null,
    profilePending: false, createdByUserId: 'owner', createdAt: 0,
  });
  new SqliteVoiceRestrictionRepository(database.getDb()).save('voice-bot', { serverMuted: true, serverDeafened: false });
  database.close();
  database = await DatabaseConnection.create(filename);
  const repository = new SqliteVoiceRestrictionRepository(database.getDb());
  assert.deepEqual(repository.getForUser('voice-bot'), { serverMuted: true, serverDeafened: false });
  assert.throws(() => repository.save('missing', { serverMuted: true, serverDeafened: false }), /FOREIGN KEY/);
  await new SqliteBotRepository(database.getDb()).delete('voice-bot');
  assert.deepEqual(repository.getForUser('voice-bot'), { serverMuted: false, serverDeafened: false });
});

test('live bot voice context follows the exact caller device after prompts and rejects invalid capabilities', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Voice context owner');
  const caller = await f.human('Voice context caller');
  const otherDevice = await f.human('Voice context caller', caller.keys);
  const channels = records(record(owner.auth.payload.server).channels);
  const textId = text(channels.find((channel) => channel.type === 'TEXT')?.id);
  const firstRoom = text(channels.find((channel) => channel.type === 'VOICE')?.id);
  const createdRoom = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'other-voice-room', type: 'VOICE' });
  const secondRoom = text(record(createdRoom.payload.channel).id);
  await caller.peer.request(MessageType.VOICE_JOIN, { channelId: firstRoom });
  await otherDevice.peer.request(MessageType.VOICE_JOIN, { channelId: secondRoom });
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const botId = text(record(created.payload.bot).id);
  const bot = await f.bot(text(created.payload.token));
  await bot.peer.request(MessageType.COMMAND_REGISTER, { commands: [{ name: 'play', description: 'Pick music' }] });
  const invoke = async () => {
    const response = await caller.peer.request(MessageType.COMMAND_INVOKE, { botId, channelId: textId, commandName: 'play' });
    assert.equal(response.type, MessageType.COMMAND_INVOKED);
    const id = text(response.payload.invocationId);
    await bot.peer.wait((message) => message.type === MessageType.COMMAND_INVOKE && message.payload.invocationId === id);
    return id;
  };
  const query = async (invocationId: string) => {
    const response = await bot.peer.request(MessageType.BOT_VOICE_CONTEXT, { invocationId });
    assert.equal(response.type, MessageType.BOT_VOICE_CONTEXT_RESULT);
    assert.equal(response.payload.invocationId, invocationId);
    return response.payload.voiceChannelId;
  };
  const id = await invoke();
  assert.equal(await query(id), firstRoom);
  const otherAccount = await owner.peer.request(MessageType.BOT_CREATE, {});
  const otherBot = await f.bot(text(otherAccount.payload.token));
  await otherBot.peer.error(MessageType.BOT_VOICE_CONTEXT, { invocationId: id }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
  await caller.peer.error(MessageType.BOT_VOICE_CONTEXT, { invocationId: id }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
  await bot.peer.error(MessageType.BOT_VOICE_CONTEXT, {
    invocationId: id, sessionId: record(otherDevice.auth.payload.currentUser).sessionId,
  }, ProtocolErrorCode.BAD_REQUEST);
  bot.peer.send(MessageType.COMMAND_PROMPT, {
    invocationId: id, interactionId: 'voice-choice', form: {
      title: 'Pick audio', fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }],
    },
  });
  await caller.peer.wait((message) => message.type === MessageType.COMMAND_PROMPT && message.payload.invocationId === id);
  await caller.peer.request(MessageType.VOICE_JOIN, { channelId: secondRoom });
  await caller.peer.request(MessageType.COMMAND_SUBMIT, { invocationId: id, interactionId: 'voice-choice', values: { answer: 'selected' } });
  await bot.peer.wait((message) => message.type === MessageType.COMMAND_SUBMITTED && message.payload.invocationId === id);
  assert.equal(await query(id), secondRoom);
  await caller.peer.request(MessageType.VOICE_LEAVE, { channelId: secondRoom });
  assert.equal(await query(id), null, 'the other device still in voice is not the invoking session');
  await caller.peer.request(MessageType.COMMAND_CANCEL, { invocationId: id });
  await bot.peer.error(MessageType.BOT_VOICE_CONTEXT, { invocationId: id }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);

  const permissionId = await invoke();
  const permissions = f.permissions.getUserPermissions.bind(f.permissions);
  f.permissions.getUserPermissions = async (userId) => userId === caller.id
    ? DEFAULT_PERMISSIONS & ~Permission.USE_BOT_COMMANDS : permissions(userId);
  await bot.peer.error(MessageType.BOT_VOICE_CONTEXT, { invocationId: permissionId }, ProtocolErrorCode.PERMISSION_DENIED);
  f.permissions.getUserPermissions = permissions;
  const disconnectedId = await invoke();
  await caller.peer.close();
  await bot.peer.wait((message) => message.type === MessageType.COMMAND_FINISHED && message.payload.invocationId === disconnectedId);
  await bot.peer.error(MessageType.BOT_VOICE_CONTEXT, { invocationId: disconnectedId }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
});

test('normal room changes notify the old private audience without exposing the destination or losing peers on denied moves', async (t) => {
  const f = await createPrivateVoiceFixture(t);
  await f.bot.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId, invocationId: f.invocationId });
  await f.bot.peer.request(MessageType.COMMAND_FINISH, { invocationId: f.invocationId });
  await f.owner.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  const denied = await f.owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'forbidden-destination', type: 'VOICE', isPrivate: true, allowedRoleIds: [],
  });
  const deniedId = text(record(denied.payload.channel).id);
  const beforeDenied = f.bot.peer.messages.length;
  await f.caller.peer.error(MessageType.VOICE_JOIN, { channelId: deniedId }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await f.bot.peer.barrier();
  assert.equal(f.bot.peer.messages.slice(beforeDenied).some((message) =>
    message.type === MessageType.VOICE_USER_LEFT && message.payload.userId === f.caller.id), false);
  assert.equal(f.signalingService.getVoiceState(text(record(f.caller.auth.payload.currentUser).sessionId))?.channelId, f.voiceId);
  const destination = await f.owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'permitted-hidden-destination', type: 'VOICE', isPrivate: true, allowedRoleIds: [f.role.id],
  });
  const destinationId = text(record(destination.payload.channel).id);
  const beforeMove = f.bot.peer.messages.length;
  const callerBeforeMove = f.caller.peer.messages.length;
  const joined = await f.caller.peer.request(MessageType.VOICE_JOIN, { channelId: destinationId });
  assert.equal(joined.type, MessageType.VOICE_USER_JOINED);
  const left = await f.bot.peer.wait((message) => message.type === MessageType.VOICE_USER_LEFT &&
    message.payload.userId === f.caller.id, beforeMove);
  assert.deepEqual(left.payload, {
    channelId: f.voiceId, userId: f.caller.id, sessionId: record(f.caller.auth.payload.currentUser).sessionId,
  });
  assert.equal(left.requestId, undefined);
  await f.bot.peer.barrier();
  assert.equal(f.bot.peer.messages.slice(beforeMove).some((message) =>
    message.type === MessageType.VOICE_USER_JOINED && message.payload.channelId === destinationId), false);
  assert.deepEqual(f.signalingService.getParticipantsInChannel(f.voiceId).map((member) => member.userId).sort(),
    [f.owner.id, f.botId].sort());
  const movement = f.caller.peer.messages.slice(callerBeforeMove);
  const departureIndex = movement.findIndex((message) =>
    message.type === MessageType.VOICE_USER_LEFT && message.payload.channelId === f.voiceId && message.payload.userId === f.caller.id);
  const arrivalIndex = movement.findIndex((message) =>
    message.type === MessageType.VOICE_USER_JOINED && message.payload.channelId === destinationId && message.payload.userId === f.caller.id);
  assert.ok(departureIndex >= 0 && arrivalIndex > departureIndex);
});

test('voice-bound bot interactions protect commands, searches, previews and exact-device membership', { timeout: 30000 }, async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Voice policy owner');
  const caller = await f.human('Voice policy caller');
  const otherDevice = await f.human('Voice policy caller', caller.keys);
  const callerSessionId = text(record(caller.auth.payload.currentUser).sessionId);
  const channels = records(record(owner.auth.payload.server).channels);
  const textId = text(channels.find((channel) => channel.type === 'TEXT')?.id);
  const firstRoom = text(channels.find((channel) => channel.type === 'VOICE')?.id);
  const secondRoom = text(record((await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'Other voice', type: 'VOICE' })).payload.channel).id);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const botId = text(record(created.payload.bot).id);
  const bot = await f.bot(text(created.payload.token));
  const botSessionId = text(record(bot.auth.payload.currentUser).sessionId);
  const musicNames = ['play', 'queue', 'nowplaying', 'pause', 'resume', 'skip', 'stop', 'leave', 'remove', 'clear'];
  assert.equal((await bot.peer.request(MessageType.COMMAND_REGISTER, { commands: [
    ...musicNames.map((name) => ({
      name, description: 'Music', voiceRequirement: 'same-bot-channel',
      ...(name === 'play' ? { options: [{ name: 'busca', description: 'Music', type: 'string', autocomplete: true }] } : {}),
    })),
    { name: 'game', description: 'Miniapp', voiceRequirement: 'joined' },
    { name: 'ping', description: 'No voice required' },
  ] })).type, MessageType.COMMAND_REGISTERED);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const commandInput = (commandName: string) => ({ botId, channelId: textId, commandName, locale: 'en' });
  const invoke = async (name: string) => {
    const response = await caller.peer.request(MessageType.COMMAND_INVOKE, commandInput(name));
    assert.equal(response.type, MessageType.COMMAND_INVOKED);
    const id = text(response.payload.invocationId);
    const execution = await bot.peer.wait((message) => message.type === MessageType.COMMAND_INVOKE && message.payload.invocationId === id);
    return { id, execution };
  };
  const finish = async (invocationId: string) => {
    assert.equal((await bot.peer.request(MessageType.COMMAND_FINISH, { invocationId })).type, MessageType.COMMAND_FINISHED);
  };
  const searchInput = () => ({ ...commandInput('play'), optionName: 'busca', query: 'Authorized original' });
  const search = async (page?: number) => {
    now += LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS;
    const requestId = randomUUID();
    const since = bot.peer.messages.length;
    caller.peer.send(MessageType.COMMAND_AUTOCOMPLETE, { ...searchInput(), ...(page !== undefined ? { page } : {}) }, requestId);
    const execution = await bot.peer.wait((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE, since);
    return { requestId, providerId: text(execution.requestId) };
  };
  await otherDevice.peer.request(MessageType.VOICE_JOIN, { channelId: secondRoom });
  for (const name of [...musicNames, 'game']) {
    await caller.peer.error(MessageType.COMMAND_INVOKE, commandInput(name), ProtocolErrorCode.BOT_VOICE_REQUIRED);
  }
  await caller.peer.error(MessageType.COMMAND_AUTOCOMPLETE, searchInput(), ProtocolErrorCode.BOT_VOICE_REQUIRED);
  assert.equal(bot.peer.messages.some((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE), false);
  await finish((await invoke('ping')).id);
  await caller.peer.request(MessageType.VOICE_JOIN, { channelId: firstRoom });

  const access = f.channelService.getAccessContext.bind(f.channelService);
  let moved = false;
  f.channelService.getAccessContext = async (userId) => {
    const context = await access(userId);
    if (userId === caller.id && !moved) {
      moved = true;
      await f.signalingService.joinVoiceChannel(callerSessionId, caller.id, secondRoom);
    }
    return context;
  };
  try {
    await caller.peer.error(MessageType.COMMAND_INVOKE, commandInput('queue'), ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
  } finally { f.channelService.getAccessContext = access; }
  assert.equal(moved, true);
  await caller.peer.request(MessageType.VOICE_JOIN, { channelId: firstRoom });
  await bot.peer.request(MessageType.VOICE_JOIN, { channelId: secondRoom });
  for (const name of musicNames) {
    await caller.peer.error(MessageType.COMMAND_INVOKE, commandInput(name), ProtocolErrorCode.BOT_VOICE_CHANNEL_MISMATCH);
  }
  now += LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS;
  await caller.peer.error(MessageType.COMMAND_AUTOCOMPLETE, searchInput(), ProtocolErrorCode.BOT_VOICE_CHANNEL_MISMATCH);

  const game = await invoke('game');
  assert.equal(game.execution.payload.invokerVoiceChannelId, firstRoom);
  const screen = await bot.peer.request(MessageType.BOT_SCREEN_CREATE, {
    id: 'voice-game', channelId: firstRoom, invocationId: game.id,
    title: 'Voice game', html: '<p>Game</p>', state: { turn: 'X' },
  });
  assert.equal(screen.type, MessageType.BOT_SCREEN_SNAPSHOT);
  await caller.peer.wait((message) => message.type === MessageType.BOT_SCREEN_SNAPSHOT && message.payload.id === 'voice-game');
  for (const peer of [owner.peer, otherDevice.peer]) {
    await peer.barrier();
    assert.equal(peer.messages.some((message) => message.type === MessageType.BOT_SCREEN_SNAPSHOT), false);
    await peer.error(MessageType.BOT_SCREEN_LIST, { channelId: firstRoom }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  }
  await finish(game.id);
  await bot.peer.request(MessageType.VOICE_LEAVE, { channelId: secondRoom });
  const accepted = await invoke('play');
  assert.equal(accepted.execution.payload.invokerVoiceChannelId, firstRoom);
  await bot.peer.request(MessageType.VOICE_JOIN, { channelId: firstRoom, invocationId: accepted.id });
  await finish(accepted.id);

  const pending = await invoke('play');
  const query = await search();
  await otherDevice.peer.request(MessageType.VOICE_LEAVE, { channelId: secondRoom });
  await bot.peer.barrier();
  assert.equal(bot.peer.messages.some((message) =>
    message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === query.providerId), false);
  bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, { status: 'ok', choices: [{
    label: 'Original', value: 'original', audio: { resourceId: 'private-preview', durationMs: 10_000 },
  }] }, query.providerId);
  const choices = commandAutocompleteResultSchema.parse((await caller.peer.wait((message) =>
    message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === query.requestId)).payload);
  assert.equal(choices.status, 'ok');
  if (choices.status !== 'ok') throw new Error('Expected authorized music choices.');
  const audio = choices.choices[0].audio;
  assert.ok(audio && 'resourceId' in audio);
  const nextQuery = await search(1);
  bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, { status: 'ok', choices: [{
    label: 'Next', value: 'next', audio: { resourceId: 'next-private-preview' },
  }] }, nextQuery.providerId);
  await caller.peer.wait((message) =>
    message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === nextQuery.requestId);
  const previewInput = {
    botId, channelId: textId, commandName: 'play', optionName: 'busca',
    autocompleteRequestId: query.requestId, resourceId: audio.resourceId,
  };
  const previewId = randomUUID();
  caller.peer.send(MessageType.COMMAND_AUDIO_PREVIEW, previewInput, previewId);
  const preview = await bot.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW);
  assert.equal(preview.payload.resourceId, 'private-preview');
  await caller.peer.request(MessageType.VOICE_LEAVE, { channelId: firstRoom });
  await bot.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === preview.requestId);
  await bot.peer.wait((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === query.providerId);
  await bot.peer.wait((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === nextQuery.providerId);
  await caller.peer.wait((message) =>
    message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === nextQuery.requestId);
  assert.equal((await caller.peer.wait((message) =>
    message.type === MessageType.COMMAND_FINISHED && message.payload.invocationId === pending.id)).payload.reason, 'cancelled');
  assert.deepEqual(commandAudioPreviewResultSchema.parse((await caller.peer.wait((message) =>
    message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT && message.requestId === previewId)).payload),
  { status: 'failed', reason: 'expired' });
  bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, {
    status: 'ok', mimeType: 'audio/ogg', audioBase64: 'AAECAw==',
  }, preview.requestId);
  assert.equal((await bot.peer.wait((message) => message.type === MessageType.SERVER_ERROR && message.requestId === preview.requestId)).payload.code,
    ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
  await caller.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, previewInput, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
  await bot.peer.error(MessageType.BOT_VOICE_CONTEXT, { invocationId: pending.id }, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
  assert.equal(f.signalingService.getVoiceState(botSessionId)?.channelId, firstRoom, 'Accepted playback is independent of the caller leaving.');

  await otherDevice.peer.request(MessageType.VOICE_JOIN, { channelId: firstRoom });
  const retained = await otherDevice.peer.request(MessageType.BOT_SCREEN_LIST, { channelId: firstRoom });
  assert.equal(retained.type, MessageType.BOT_SCREEN_LIST_RESULT);
  assert.equal(records(retained.payload.screens)[0].id, 'voice-game');
  await caller.peer.error(MessageType.BOT_SCREEN_LIST, { channelId: firstRoom }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
  await caller.peer.error(MessageType.COMMAND_INVOKE, commandInput('queue'), ProtocolErrorCode.BOT_VOICE_REQUIRED);
  assert.equal((await bot.peer.request(MessageType.BOT_SCREEN_UPDATE, {
    id: 'voice-game', instanceId: screen.payload.instanceId, expectedRevision: 0, state: { turn: 'O' },
  })).type, MessageType.BOT_SCREEN_SNAPSHOT);

  await bot.peer.request(MessageType.VOICE_LEAVE, { channelId: firstRoom });
  await caller.peer.request(MessageType.VOICE_JOIN, { channelId: firstRoom });
  const movedQuery = await search();
  await caller.peer.request(MessageType.VOICE_JOIN, { channelId: secondRoom });
  await bot.peer.wait((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === movedQuery.providerId);
  assert.equal((await caller.peer.wait((message) => message.requestId === movedQuery.requestId)).payload.code, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
  await finish((await invoke('queue')).id);
});

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

test('localized bot settings retain labels without exposing an unauthorized shared scope', async (t) => {
  const f = await createSettingsFixture(t);
  const before = await f.get();
  const userField = SETTINGS_DEFINITION.user?.fields[0];
  assert.ok(userField);
  const definition: BotSettingsDefinition = {
    ...SETTINGS_DEFINITION,
    localizations: {
      'pt-BR': {
        server: { title: 'Comportamento', fields: { count: { label: 'Quantidade' } } },
        user: { title: 'Preferencias', fields: { [userField.name]: { label: 'Preferencia individual' } } },
      },
    },
  };
  assert.equal((await f.bot.peer.request(MessageType.COMMAND_REGISTER, {
    commands: f.commands, settings: definition,
  })).type, MessageType.COMMAND_REGISTERED);
  const owner = await f.get();
  assert.deepEqual(owner.server?.values, before.server?.values);
  assert.equal(owner.definition.localizations?.['pt-BR']?.server?.title, 'Comportamento');
  const member = await f.get(f.alice.peer);
  assert.equal(member.server, undefined);
  assert.equal(member.definition.server, undefined);
  assert.equal(member.definition.localizations?.['pt-BR']?.server, undefined);
  assert.equal(member.definition.localizations?.['pt-BR']?.user?.title, 'Preferencias');
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

  await t.test('lazy audio preview settings reuse only the authorized search snapshot and invalidate on shared changes', async (t) => {
    const f = await createSettingsFixture(t);
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const queryId = randomUUID();
    f.alice.peer.send(MessageType.COMMAND_AUTOCOMPLETE, {
      botId: f.botId, channelId: f.channelId, commandName: 'run', optionName: 'query', query: 'clip',
      userSettings: { compact: false, tags: ['PRIVATE-PREVIEW'] },
    }, queryId);
    const query = await f.bot.peer.wait((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE);
    f.bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, {
      status: 'ok', choices: [{ label: 'Clip', value: 'canonical', audio: { resourceId: 'provider-clip' } }],
    }, query.requestId);
    const choices = commandAutocompleteResultSchema.parse((await f.alice.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === queryId)).payload);
    assert.ok(choices.status === 'ok' && choices.choices[0].audio && 'resourceId' in choices.choices[0].audio);
    now += LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS;
    const nextQueryId = randomUUID();
    const beforeNext = f.bot.peer.messages.length;
    f.alice.peer.send(MessageType.COMMAND_AUTOCOMPLETE, {
      botId: f.botId, channelId: f.channelId, commandName: 'run', optionName: 'query', query: 'clip', page: 1,
      userSettings: { tags: ['PRIVATE-PREVIEW'], compact: false },
    }, nextQueryId);
    const nextQuery = await f.bot.peer.wait((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE, beforeNext);
    assert.deepEqual(nextQuery.payload.settings, query.payload.settings);
    f.bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, {
      status: 'ok', choices: [{ label: 'Next clip', value: 'canonical-next', audio: { resourceId: 'provider-next' } }],
    }, nextQuery.requestId);
    await f.alice.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === nextQueryId);
    const requestId = randomUUID();
    f.alice.peer.send(MessageType.COMMAND_AUDIO_PREVIEW, {
      botId: f.botId, channelId: f.channelId, commandName: 'run', optionName: 'query',
      autocompleteRequestId: queryId, resourceId: choices.choices[0].audio.resourceId,
    }, requestId);
    const preview = await f.bot.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW);
    assert.deepEqual(preview.payload.settings, query.payload.settings);
    assert.deepEqual(record(preview.payload.settings).user, { compact: false, tags: ['PRIVATE-PREVIEW'] });
    assert.equal(f.bob.peer.messages.some((message) => JSON.stringify(message.payload).includes('PRIVATE-PREVIEW')), false);
    await f.update({ count: 3 });
    await f.bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === preview.requestId);
    for (const pageId of [queryId, nextQueryId]) {
      await f.alice.peer.wait((message) =>
        message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === pageId);
    }
    assert.deepEqual((await f.alice.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT && message.requestId === requestId)).payload,
    { status: 'failed', reason: 'expired' });
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
  assert.deepEqual(await repository.findById(legacy.id), { ...legacy, lastProtocolVersion: null });
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
  assert.deepEqual(await restored.findById(legacy.id), { ...legacy, lastProtocolVersion: null });
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
    assert.equal(botInfo.lastProtocolVersion, null);
    assert.equal(botInfo.requiredProtocolVersion, PROTOCOL_VERSION);
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
      assert.equal((await fixture.botRepo.findById(botId))?.lastProtocolVersion, null);
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
  await t.test('authenticates and persists the bot protocol; pending compatibility clears only after verification', async () => {
    assert.equal((await fixture.botRepo.findById(botId))?.lastProtocolVersion, PROTOCOL_VERSION);
    assert.deepEqual(await fixture.botService.getCompatibility(), {
      protocolVersion: PROTOCOL_VERSION, incompatibleBots: 0, uncheckedBots: 0,
    });
    await fixture.botRepo.update(botId, { lastProtocolVersion: PROTOCOL_VERSION - 1 });
    assert.equal((await fixture.botService.getCompatibility()).incompatibleBots, 1);
    const listed = (await fixture.botService.list()).find((item) => item.id === botId);
    assert.equal(listed?.lastProtocolVersion, PROTOCOL_VERSION - 1);
    assert.equal(listed?.requiredProtocolVersion, PROTOCOL_VERSION);
    await fixture.botRepo.update(botId, { lastProtocolVersion: null });
    assert.equal((await fixture.botService.getCompatibility()).uncheckedBots, 1);
    await fixture.botService.recordCompatibleConnection(botId);
    assert.equal((await fixture.botRepo.findById(botId))?.lastProtocolVersion, PROTOCOL_VERSION);
    assert.equal((await fixture.botService.getCompatibility()).uncheckedBots, 0);
  });
  await t.test('an obsolete duplicate cannot mark a currently connected compatible bot as incompatible', async () => {
    const rejected = await fixture.connect();
    await rejected.error(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION - 1, nickname: 'Obsolete duplicate',
      publicKey: bot.keys.publicKey, botToken: token,
    }, ProtocolErrorCode.PROTOCOL_VERSION_UNSUPPORTED);
    assert.equal((await fixture.botRepo.findById(botId))?.lastProtocolVersion, PROTOCOL_VERSION);
    assert.equal((await fixture.botService.getCompatibility()).incompatibleBots, 0);
    await rejected.close();
  });
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
    return { peer, requestId, execution, searchInput: input, botRequestId: text(execution.requestId) };
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
  const previewResult = { status: 'ok', mimeType: 'audio/ogg', audioBase64: Buffer.from([0xf8, 0xff, 0xfe]).toString('base64') };
  const lazySearch = async (
    peer = alice.peer, overrides: Partial<CommandAutocompletePayload> = {}, requestId = randomUUID(),
    pagination: { hasMore?: boolean; nextCursor?: string } = {},
  ) => {
    const query = await search(peer, overrides, requestId);
    bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, {
      status: 'ok', ...pagination, choices: [
        { label: 'First clip', value: 'canonical-first', audio: { resourceId: 'source-first', fileName: 'first.ogg', durationMs: 10_000 } },
        { label: 'Second clip', value: 'canonical-second', audio: { resourceId: 'source-second', fileName: 'second.ogg' } },
        result.choices[0],
      ],
    }, query.botRequestId);
    const received = commandAutocompleteResultSchema.parse((await peer.wait((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === query.requestId)).payload);
    assert.equal(received.status, 'ok');
    if (received.status !== 'ok') throw new Error('Missing lazy choices');
    const audio = received.choices[0].audio;
    const second = received.choices[1].audio;
    assert.ok(audio && 'resourceId' in audio && second && 'resourceId' in second);
    assert.notEqual(audio.resourceId, 'source-first');
    assert.notEqual(second.resourceId, 'source-second');
    assert.deepEqual(received.choices[2].audio, AUDIO_PREVIEW, 'HTTPS choices must not be rewritten');
    const input: CommandAudioPreviewPayload = {
      botId, commandName: 'search', channelId: overrides.channelId ?? channelId, optionName: 'sound',
      autocompleteRequestId: query.requestId, resourceId: audio.resourceId,
    };
    return { ...query, input, received, secondResourceId: second.resourceId };
  };
  const startPreview = async (query: Awaited<ReturnType<typeof lazySearch>>, requestId = randomUUID(), resourceId = query.input.resourceId) => {
    const since = bot.peer.messages.length;
    query.peer.send(MessageType.COMMAND_AUDIO_PREVIEW, { ...query.input, resourceId }, requestId);
    const execution = await bot.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW, since);
    return { requestId, execution, botRequestId: text(execution.requestId) };
  };

  await t.test('correlates identical client IDs privately and authenticates the responding bot', async () => {
    await alice.peer.error(MessageType.COMMAND_AUTOCOMPLETE, {
      ...searchInput(), localPreparation: { capability: 'youtube-audio', permit: 'ab'.repeat(32) },
    }, ProtocolErrorCode.BOT_INVALID_OPTIONS);
    const sharedId = randomUUID();
    const first = await search(alice.peer, {
      channelId: privateChannelId, localPreparation: { capability: 'youtube-audio' },
    }, sharedId);
    const second = await search(bob.peer, {}, sharedId);
    assert.notEqual(first.botRequestId, second.botRequestId);
    assert.notEqual(first.botRequestId, sharedId);
    assert.deepEqual(first.execution.payload, {
      botId, channelId: privateChannelId, invokerId: alice.id, invokerNickname: 'Download Alice',
      invokerSessionId: record(alice.auth.payload.currentUser).sessionId, invokerVoiceChannelId: null,
      commandName: 'search', optionName: 'sound', query: first.execution.payload.query,
      options: { count: 0, enabled: false }, locale: 'en',
    });
    assert.equal(second.execution.payload.invokerId, bob.id);
    assert.equal(second.execution.payload.invokerSessionId, record(bob.auth.payload.currentUser).sessionId);
    assert.equal('localPreparation' in first.execution.payload, false);
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

  await t.test('paginated autocomplete forwards opaque cursors and preserves metadata and page-scoped preview authorities', async () => {
    const first = await lazySearch(alice.peer, { locale: undefined }, randomUUID(), { hasMore: true, nextCursor: 'opaque:page/1' });
    assert.equal('page' in first.execution.payload, false, 'The first page keeps the legacy execution envelope');
    assert.equal('cursor' in first.execution.payload, false);
    assert.equal(first.received.hasMore, true);
    assert.equal(first.received.nextCursor, 'opaque:page/1');
    const firstPreview = await startPreview(first);
    const second = await lazySearch(alice.peer, {
      ...first.searchInput, options: { enabled: false, count: 0 }, locale: 'pt-BR', userSettings: {},
      page: 1, cursor: first.received.nextCursor,
    }, randomUUID(), { hasMore: false });
    assert.equal(second.execution.payload.page, 1);
    assert.equal(second.execution.payload.cursor, 'opaque:page/1');
    assert.equal(second.received.hasMore, false);
    assert.equal('nextCursor' in second.received, false);
    assert.notEqual(first.input.resourceId, second.input.resourceId);
    assert.equal(bot.peer.messages.some((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === first.botRequestId), false);
    assert.equal(bot.peer.messages.some((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === firstPreview.botRequestId), false,
    'Loading a page must not cancel a preview from an earlier page');
    for (const input of [
      { ...first.input, resourceId: second.input.resourceId },
      { ...second.input, resourceId: first.input.resourceId },
    ]) await alice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, input, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    await otherDevice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, first.input, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    otherDevice.peer.send(MessageType.COMMAND_AUTOCOMPLETE_CANCEL, { requestId: first.requestId });
    await otherDevice.peer.barrier();
    const secondPreview = await startPreview(second);
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === firstPreview.botRequestId);
    assert.deepEqual((await alice.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT &&
      message.requestId === firstPreview.requestId)).payload, { status: 'failed', reason: 'expired' });
    bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, previewResult, firstPreview.botRequestId);
    assert.equal((await bot.peer.wait((message) => message.type === MessageType.SERVER_ERROR &&
      message.requestId === firstPreview.botRequestId)).payload.code, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, previewResult, secondPreview.botRequestId);
    assert.deepEqual((await alice.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT &&
      message.requestId === secondPreview.requestId)).payload, previewResult);
    const replay = await startPreview(first);
    assert.equal(replay.execution.payload.resourceId, 'source-first');
    alice.peer.send(MessageType.COMMAND_AUTOCOMPLETE_CANCEL, { requestId: second.requestId });
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === second.botRequestId);
    assert.equal(bot.peer.messages.some((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === replay.botRequestId), false,
    'Cancelling one page cannot cancel another page’s preview');
    alice.peer.send(MessageType.COMMAND_AUTOCOMPLETE_CANCEL, { requestId: first.requestId });
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === replay.botRequestId);
    for (const page of [first, second]) {
      await alice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, page.input, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    }
  });

  await t.test('page throttles, provider failures, legacy responses and cancelled continuations preserve valid earlier pages', async () => {
    const first = await lazySearch(alice.peer, {}, randomUUID(), { hasMore: true });
    const continuation = { ...first.searchInput, page: 1 };
    await alice.peer.error(MessageType.COMMAND_AUTOCOMPLETE, continuation, ProtocolErrorCode.RATE_LIMITED);
    for (const [response, expected] of [
      [{ status: 'failed', reason: 'handler_failed' }, { status: 'failed', reason: 'handler_failed' }],
      [{ ...result, choices: Array.from({ length: 21 }, (_, index) => ({ label: `Choice ${index}`, value: `${index}` })) },
        { status: 'failed', reason: 'invalid_response' }],
      [{ ...result, nextCursor: 'without-has-more' }, { status: 'failed', reason: 'invalid_response' }],
      [result, result],
      [{ status: 'ok', choices: [] }, { status: 'ok', choices: [] }],
    ]) {
      const page = await search(alice.peer, continuation);
      bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, response, page.botRequestId);
      assert.deepEqual((await alice.peer.wait((message) =>
        message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === page.requestId)).payload, expected);
    }
    const timeout = await search(alice.peer, continuation);
    now += LIMITS.BOT_AUTOCOMPLETE_TIMEOUT_MS;
    bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, result, timeout.botRequestId);
    assert.deepEqual((await alice.peer.wait((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT &&
      message.requestId === timeout.requestId)).payload, { status: 'failed', reason: 'timeout' });
    const superseded = await search(alice.peer, continuation);
    await alice.peer.error(MessageType.COMMAND_AUTOCOMPLETE, { ...continuation, page: 2 }, ProtocolErrorCode.RATE_LIMITED);
    assert.equal(bot.peer.messages.some((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === superseded.botRequestId), false,
    'A throttle must not cancel the existing in-flight page');
    const cancelled = await search(alice.peer, { ...continuation, page: 2 });
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === superseded.botRequestId);
    alice.peer.send(MessageType.COMMAND_AUTOCOMPLETE_CANCEL, { requestId: cancelled.requestId });
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === cancelled.botRequestId);
    for (const page of [superseded, cancelled]) {
      bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, result, page.botRequestId);
      assert.equal((await bot.peer.wait((message) => message.type === MessageType.SERVER_ERROR &&
        message.requestId === page.botRequestId)).payload.code, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
      assert.equal(alice.peer.messages.some((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT &&
        message.requestId === page.requestId), false);
    }
    now += LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS;
    alice.peer.send(MessageType.COMMAND_AUTOCOMPLETE, continuation, first.requestId);
    assert.equal((await alice.peer.wait((message) => message.type === MessageType.SERVER_ERROR &&
      message.requestId === first.requestId)).payload.code, ProtocolErrorCode.BOT_INTERACTION_INVALID,
    'A new page cannot overwrite a retained page’s request ID');
    assert.equal(bot.peer.messages.some((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === first.botRequestId), false);
    const preview = await startPreview(first);
    bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, previewResult, preview.botRequestId);
    assert.deepEqual((await alice.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT &&
      message.requestId === preview.requestId)).payload, previewResult);
  });

  await t.test('autocomplete limits choices per response without capping a search at twenty results', async () => {
    const input = searchInput();
    let delivered = 0;
    const providerIds: string[] = [];
    for (let page = 0; page < 3; page++) {
      const pending = await search(alice.peer, { ...input, page });
      assert.equal(pending.execution.payload.page, page);
      providerIds.push(pending.botRequestId);
      bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, {
        status: 'ok', hasMore: page < 2, choices: Array.from({ length: 20 }, (_, index) => ({
          label: `Choice ${page}-${index}`, value: `${page}-${index}`,
          audio: { resourceId: `resource-${page}-${index}` },
        })),
      }, pending.botRequestId);
      const received = commandAutocompleteResultSchema.parse((await alice.peer.wait((message) =>
        message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === pending.requestId)).payload);
      assert.ok(received.status === 'ok');
      assert.equal(received.choices.length, 20);
      assert.equal(received.hasMore, page < 2);
      delivered += received.choices.length;
    }
    assert.equal(delivered, 60);
    assert.equal(bot.peer.messages.some((message) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && providerIds.includes(text(message.payload.requestId))), false);
  });

  await t.test('changed search identities and page zero immediately revoke every page even when throttled', async () => {
    const changes: Partial<CommandAutocompletePayload>[] = [
      { page: 0 }, { page: undefined }, { query: 'replacement' }, { optionName: 'count' },
      { commandName: 'plain' }, { botId: text(record(otherCreated.payload.bot).id) },
      { channelId: privateChannelId }, { locale: 'pt-BR' }, { options: { count: 1, enabled: false } },
      { userSettings: { changed: true } },
    ];
    for (const change of changes) {
      const first = await lazySearch();
      const second = await lazySearch(alice.peer, { ...first.searchInput, page: 1 });
      await alice.peer.error(MessageType.COMMAND_AUTOCOMPLETE, {
        ...first.searchInput, page: 2, ...change,
      }, ProtocolErrorCode.RATE_LIMITED);
      for (const page of [first, second]) {
        await bot.peer.wait((message) =>
          message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === page.botRequestId);
        await alice.peer.wait((message) =>
          message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === page.requestId);
        await alice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, page.input, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
      }
    }
  });

  await t.test('validates partial inputs and throttles across devices while cancelling superseded work', async () => {
    for (const invalid of [
      { optionName: 'count' }, { query: 'x'.repeat(201) }, { options: { sound: 'edited' } },
      { options: { count: 'wrong' } }, { options: { count: 11 } }, { options: { target: 'non-member' } },
      { page: -1 }, { page: 1.5 }, { page: Number.MAX_SAFE_INTEGER + 1 }, { cursor: 'x'.repeat(513) },
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

  await t.test('lazy audio previews require an advertised opaque choice, the exact caller, device and command context', async () => {
    const before = bot.peer.messages.filter((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW).length;
    const sharedId = randomUUID();
    const first = await lazySearch(alice.peer, { channelId: privateChannelId }, sharedId);
    const second = await lazySearch(bob.peer, {}, sharedId);
    assert.equal(bot.peer.messages.filter((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW).length, before,
      'Searching cannot start a preview provider');
    for (const input of [
      { ...first.input, resourceId: 'source-first' }, { ...first.input, resourceId: second.input.resourceId },
      { ...first.input, autocompleteRequestId: 'stale-query' }, { ...first.input, commandName: 'plain' },
      { ...first.input, botId: text(record(otherCreated.payload.bot).id) }, { ...first.input, optionName: 'enabled' },
      { ...first.input, channelId }, { ...first.input, invokerId: bob.id },
    ]) await alice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, input, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    await otherDevice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, first.input, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    await bob.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, first.input, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    await bot.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, first.input, ProtocolErrorCode.PERMISSION_DENIED);
    assert.equal(bot.peer.messages.filter((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW).length, before);
    const samePreviewId = randomUUID();
    first.input.localPreparation = { capability: 'youtube-audio' };
    const alicePreview = await startPreview(first, samePreviewId);
    const bobPreview = await startPreview(second, samePreviewId);
    assert.notEqual(alicePreview.botRequestId, samePreviewId);
    assert.notEqual(alicePreview.botRequestId, bobPreview.botRequestId);
    assert.deepEqual(alicePreview.execution.payload, {
      botId, channelId: privateChannelId, invokerId: alice.id, invokerNickname: 'Download Alice',
      invokerSessionId: record(alice.auth.payload.currentUser).sessionId, invokerVoiceChannelId: null,
      commandName: 'search', optionName: 'sound', resourceId: 'source-first', locale: 'en',
    });
    assert.equal(bobPreview.execution.payload.invokerId, bob.id);
    assert.equal(bobPreview.execution.payload.invokerSessionId, record(bob.auth.payload.currentUser).sessionId);
    assert.equal('localPreparation' in alicePreview.execution.payload, false);
    otherBot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, previewResult, alicePreview.botRequestId);
    assert.equal((await otherBot.peer.wait((message) =>
      message.requestId === alicePreview.botRequestId && message.type === MessageType.SERVER_ERROR)).payload.code,
    ProtocolErrorCode.BOT_INTERACTION_INVALID);
    const bobResult = { ...previewResult, audioBase64: Buffer.from([1, 2, 3]).toString('base64') };
    bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, bobResult, bobPreview.botRequestId);
    bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, previewResult, alicePreview.botRequestId);
    for (const [peer, expected] of [[alice.peer, previewResult], [bob.peer, bobResult]] as const) {
      assert.deepEqual(commandAudioPreviewResultSchema.parse((await peer.wait((message) =>
        message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT && message.requestId === samePreviewId)).payload), expected);
    }
    await otherDevice.peer.barrier();
    assert.equal(otherDevice.peer.messages.some((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT), false);
    assert.equal(alice.peer.messages.some((message) => message.type === MessageType.COMMAND_INVOKED), false);
  });

  await t.test('lazy audio preview replacement, cancellation and stale queries abort only the owning provider', async () => {
    const query = await lazySearch();
    const first = await startPreview(query);
    otherDevice.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_CANCEL, { requestId: first.requestId });
    await otherDevice.peer.barrier();
    assert.equal(bot.peer.messages.some((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === first.botRequestId), false);
    const replacement = await startPreview(query, randomUUID(), query.secondResourceId);
    assert.equal(replacement.execution.payload.resourceId, 'source-second');
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === first.botRequestId);
    assert.equal((await alice.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT && message.requestId === first.requestId)).payload.status, 'failed');
    alice.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_CANCEL, { requestId: replacement.requestId });
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === replacement.botRequestId);
    bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, previewResult, replacement.botRequestId);
    assert.equal((await bot.peer.wait((message) => message.type === MessageType.SERVER_ERROR &&
      message.requestId === replacement.botRequestId)).payload.code, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    assert.equal(alice.peer.messages.some((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT &&
      message.requestId === replacement.requestId), false);
    const old = await startPreview(query);
    await search();
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === old.botRequestId);
    await alice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, query.input, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
  });

  await t.test('lazy audio preview payload limits and malformed provider replies fail explicitly', async () => {
    const query = await lazySearch();
    for (const invalid of [
      { ...previewResult, audioBase64: '' }, { ...previewResult, audioBase64: '!!!!' },
      { ...previewResult, mimeType: 'text/html' }, { ...previewResult, url: 'https://example.com/untrusted.ogg' },
      { ...previewResult, audioBase64: Buffer.alloc(LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES + 1).toString('base64') },
    ]) {
      const pending = await startPreview(query);
      bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, invalid, pending.botRequestId);
      assert.deepEqual((await alice.peer.wait((message) =>
        message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT && message.requestId === pending.requestId)).payload,
      { status: 'failed', reason: 'invalid_response' });
    }
    const pending = await startPreview(query);
    bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, { status: 'failed', reason: 'handler_failed' }, pending.botRequestId);
    assert.deepEqual((await alice.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT && message.requestId === pending.requestId)).payload,
    { status: 'failed', reason: 'handler_failed' });
  });

  await t.test('lazy audio previews revalidate access before dispatch and delivery, and abort on registry changes', async () => {
    const member = await fixture.roleRepo.findByName('Membro');
    assert.ok(member);
    for (const stage of ['request', 'result']) {
      for (const permission of [Permission.USE_BOT_COMMANDS, Permission.SEND_MESSAGES]) {
        const query = await lazySearch();
        const nextPage = await lazySearch(alice.peer, { ...query.searchInput, page: 1 });
        const pending = stage === 'result' ? await startPreview(query) : null;
        const before = bot.peer.messages.filter((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW).length;
        await fixture.roleRepo.update(member.id, { permissions: DEFAULT_PERMISSIONS & ~permission });
        try {
          if (pending) {
            bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, previewResult, pending.botRequestId);
            assert.equal((await alice.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT &&
              message.requestId === pending.requestId)).payload.status, 'failed');
          } else {
            const denied = await alice.peer.request(MessageType.COMMAND_AUDIO_PREVIEW, query.input);
            assert.equal(denied.type, MessageType.COMMAND_AUDIO_PREVIEW_RESULT);
            assert.deepEqual(denied.payload, { status: 'failed', reason: 'expired' });
            assert.equal(bot.peer.messages.filter((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW).length, before);
          }
        } finally {
          await fixture.roleRepo.update(member.id, { permissions: DEFAULT_PERMISSIONS });
        }
        for (const page of [query, nextPage]) {
          await alice.peer.wait((message) =>
            message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && message.payload.requestId === page.requestId);
          await alice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, page.input, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
        }
      }
    }
    const query = await lazySearch(alice.peer, { channelId: privateChannelId });
    const pending = await startPreview(query);
    await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: privateChannelId, botCommandsEnabled: false });
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === pending.botRequestId);
    assert.equal((await alice.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT &&
      message.requestId === pending.requestId)).payload.status, 'failed');
    await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: privateChannelId, botCommandsEnabled: true });
    const privateQuery = await lazySearch(alice.peer, { channelId: privateChannelId });
    const privatePreview = await startPreview(privateQuery);
    await owner.peer.request(MessageType.ROLE_UNASSIGN, { userId: alice.id, roleId: role.id });
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === privatePreview.botRequestId);
    await alice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, privateQuery.input, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: alice.id, roleId: role.id });
    const changed = await lazySearch();
    const changedPage = await lazySearch(alice.peer, { ...changed.searchInput, page: 1 });
    const active = await startPreview(changed);
    await bot.peer.request(MessageType.COMMAND_REGISTER, { commands: definitions.filter((command) => command.name !== 'search') });
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === active.botRequestId);
    for (const page of [changed, changedPage]) {
      await alice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, page.input, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    }
    await register();
  });

  await t.test('lazy audio preview contexts expire and cannot survive replacement sockets, bot disconnects or channel deletion', async () => {
    const expired = await lazySearch();
    const before = bot.peer.messages.filter((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW).length;
    now += LIMITS.BOT_AUTOCOMPLETE_CHOICE_TTL_MS;
    const rejected = await alice.peer.request(MessageType.COMMAND_AUDIO_PREVIEW, expired.input);
    assert.deepEqual(rejected.payload, { status: 'failed', reason: 'expired' });
    assert.equal(bot.peer.messages.filter((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW).length, before);
    const old = await lazySearch();
    const oldPage = await lazySearch(alice.peer, { ...old.searchInput, page: 1 });
    const active = await startPreview(old);
    alice = await fixture.human('Download Alice', alice.keys, alice.deviceId);
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === active.botRequestId);
    for (const page of [old, oldPage]) {
      await alice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, page.input, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    }
    const disconnected = await lazySearch();
    const disconnectedPage = await lazySearch(alice.peer, { ...disconnected.searchInput, page: 1 });
    const generating = await startPreview(disconnected);
    const keys = bot.keys;
    await bot.peer.close();
    assert.equal((await alice.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT &&
      message.requestId === generating.requestId)).payload.status, 'failed');
    bot = await fixture.bot(token, keys);
    await register();
    for (const page of [disconnected, disconnectedPage]) {
      await alice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, page.input, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    }
    const channel = await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'preview-lifetime', type: 'TEXT' });
    const target = text(record(channel.payload.channel).id);
    const removed = await lazySearch(alice.peer, { channelId: target });
    const removedPage = await lazySearch(alice.peer, { ...removed.searchInput, page: 1 });
    const removing = await startPreview(removed);
    await owner.peer.request(MessageType.CHANNEL_DELETE, { channelId: target });
    await bot.peer.wait((message) =>
      message.type === MessageType.COMMAND_AUDIO_PREVIEW_CANCEL && message.payload.requestId === removing.botRequestId);
    for (const page of [removed, removedPage]) {
      await alice.peer.error(MessageType.COMMAND_AUDIO_PREVIEW, page.input, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
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

    const lazyChoice = async (
      session: BotInteractionSession, requestId: string, overrides: Partial<CommandAutocompletePayload> = {},
    ): Promise<CommandAudioPreviewPayload> => {
      await handler.autocomplete(session, { ...input, ...overrides }, requestId);
      const queryId = text(lastMessage(MessageType.COMMAND_AUTOCOMPLETE).requestId);
      await handler.autocompleteResult(bot, {
        status: 'ok', choices: [{ label: 'Clip', value: 'canonical', audio: { resourceId: 'provider-clip' } }],
      }, queryId);
      const result = commandAutocompleteResultSchema.parse(lastMessage(MessageType.COMMAND_AUTOCOMPLETE_RESULT).payload);
      assert.ok(result.status === 'ok' && result.choices[0].audio && 'resourceId' in result.choices[0].audio);
      return {
        botId: 'timer', commandName: 'search', channelId, optionName: 'sound',
        autocompleteRequestId: requestId, resourceId: result.choices[0].audio.resourceId,
      };
    };
    const leaseOwner = origin(1900);
    const firstLease = await lazyChoice(leaseOwner, 'first-page-lease');
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_CHOICE_TTL_MS / 2);
    const secondLease = await lazyChoice(leaseOwner, 'second-page-lease', { page: 1 });
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_CHOICE_TTL_MS / 2);
    await flush();
    const beforeExpiredPreview = messages.filter(({ message }) => message.type === MessageType.COMMAND_AUDIO_PREVIEW).length;
    await handler.audioPreview(leaseOwner, firstLease, 'expired-first-page');
    assert.equal(errors.pop()?.code, ProtocolErrorCode.BOT_INTERACTION_INVALID);
    assert.equal(messages.filter(({ message }) => message.type === MessageType.COMMAND_AUDIO_PREVIEW).length, beforeExpiredPreview);
    await handler.audioPreview(leaseOwner, secondLease, 'unexpired-second-page');
    assert.equal(record(lastMessage(MessageType.COMMAND_AUDIO_PREVIEW).payload).resourceId, 'provider-clip');
    handler.cancelAudioPreview(leaseOwner, { requestId: 'unexpired-second-page' });
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_CHOICE_TTL_MS / 2);
    await flush();
    await handler.audioPreview(leaseOwner, secondLease, 'expired-second-page');
    assert.equal(errors.pop()?.code, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    for (const page of [firstLease, secondLease]) {
      assert.equal(messages.filter(({ ws, message }) => ws === leaseOwner.ws &&
        message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL &&
        record(message.payload).requestId === page.autocompleteRequestId).length, 1,
      'Each page expires on its own original lease');
    }

    const pageRaceOwner = origin(1901);
    const retained = await lazyChoice(pageRaceOwner, 'retained-before-race');
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS);
    await handler.autocomplete(pageRaceOwner, { ...input, page: 1 }, 'cancelled-page-race');
    const cancelledPageId = text(lastMessage(MessageType.COMMAND_AUTOCOMPLETE).requestId);
    accessGate = new Promise((resolve) => { releaseAccess = resolve; });
    const latePage = handler.autocompleteResult(bot, {
      status: 'ok', hasMore: true, choices: [{ label: 'Late', value: 'late', audio: { resourceId: 'late-resource' } }],
    }, cancelledPageId);
    accessGate = null;
    handler.cancelAutocomplete(pageRaceOwner, { requestId: 'cancelled-page-race' });
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS);
    await handler.autocomplete(pageRaceOwner, { ...input, page: 1 }, 'retry-page-race');
    assert.ok(releaseAccess);
    releaseAccess(granted);
    await latePage;
    assert.equal(messages.some(({ message }) =>
      message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === 'cancelled-page-race'), false);
    handler.cancelAutocomplete(pageRaceOwner, { requestId: 'retry-page-race' });
    await handler.audioPreview(pageRaceOwner, retained, 'retained-after-race');
    assert.equal(record(lastMessage(MessageType.COMMAND_AUDIO_PREVIEW).payload).resourceId, 'provider-clip');
    handler.cancelAutocomplete(pageRaceOwner, { requestId: 'retained-before-race' });

    const retainedOrigins = origins.slice(0, LIMITS.MAX_BOT_AUTOCOMPLETE_REQUESTS / 2);
    const firstPages: CommandAudioPreviewPayload[] = [];
    const secondPages: CommandAudioPreviewPayload[] = [];
    for (const [index, session] of retainedOrigins.entries()) {
      firstPages.push(await lazyChoice(session, `retained-first-${index}`));
    }
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS);
    for (const [index, session] of retainedOrigins.entries()) {
      secondPages.push(await lazyChoice(session, `retained-second-${index}`, { page: 1 }));
    }
    assert.equal(errors.length, 0);
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS);
    await handler.autocomplete(retainedOrigins[0], { ...input, page: 2 }, 'retained-capacity-full');
    assert.equal(errors.pop()?.code, ProtocolErrorCode.BOT_COMMAND_BUSY,
      'Settled preview pages share the existing global outstanding request limit');
    await handler.audioPreview(retainedOrigins[0], firstPages[0], 'retained-despite-capacity');
    assert.equal(record(lastMessage(MessageType.COMMAND_AUDIO_PREVIEW).payload).resourceId, 'provider-clip');
    handler.cancelAutocomplete(retainedOrigins[0], { requestId: firstPages[0].autocompleteRequestId });
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS);
    await lazyChoice(retainedOrigins[0], 'retained-capacity-released', { page: 2 });
    assert.equal(errors.length, 0, 'Cancelling one retained page immediately releases its global slot');
    await handler.audioPreview(retainedOrigins[0], secondPages[0], 'retained-after-capacity');
    assert.equal(record(lastMessage(MessageType.COMMAND_AUDIO_PREVIEW).payload).resourceId, 'provider-clip');
    handler.settingsChanged('timer');
    assert.equal(errors.length, 0);
    const afterRetainedCleanup = messages.length;
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_CHOICE_TTL_MS * 2);
    await flush();
    assert.equal(messages.length, afterRetainedCleanup, 'Invalidating page groups releases every page and preview timer');

    const previewOwner = origin(2001);
    const choice = await lazyChoice(previewOwner, 'lazy-timeout-query');
    await handler.audioPreview(previewOwner, choice, 'lazy-timeout');
    const timedPreviewId = text(lastMessage(MessageType.COMMAND_AUDIO_PREVIEW).requestId);
    t.mock.timers.tick(LIMITS.BOT_AUDIO_PREVIEW_TIMEOUT_MS);
    await flush();
    assert.deepEqual(lastMessage(MessageType.COMMAND_AUDIO_PREVIEW_RESULT).payload, { status: 'failed', reason: 'timeout' });
    await handler.audioPreviewResult(bot, { status: 'ok', mimeType: 'audio/ogg', audioBase64: 'AAAA' }, timedPreviewId);
    assert.equal(errors.pop()?.code, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_CHOICE_TTL_MS);
    await flush();
    await handler.audioPreview(previewOwner, choice, 'expired-choices');
    assert.equal(errors.pop()?.code, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);

    const previewOrigins = Array.from({ length: LIMITS.MAX_BOT_AUDIO_PREVIEW_REQUESTS + 1 }, (_, index) => origin(3000 + index));
    const previewInputs: CommandAudioPreviewPayload[] = [];
    const previewIds: string[] = [];
    for (const [index, session] of previewOrigins.entries()) {
      const input = await lazyChoice(session, `preview-query-${index}`);
      previewInputs.push(input);
      await handler.audioPreview(session, input, `preview-${index}`);
      if (index < LIMITS.MAX_BOT_AUDIO_PREVIEW_REQUESTS) previewIds.push(text(lastMessage(MessageType.COMMAND_AUDIO_PREVIEW).requestId));
    }
    assert.equal(errors.pop()?.code, ProtocolErrorCode.BOT_COMMAND_BUSY);
    handler.cancelAudioPreview(previewOrigins[0], { requestId: 'preview-0' });
    const extraPreviewOrigin = previewOrigins.at(-1);
    const extraPreviewInput = previewInputs.at(-1);
    assert.ok(extraPreviewOrigin && extraPreviewInput);
    await handler.audioPreview(extraPreviewOrigin, extraPreviewInput, 'preview-released');
    assert.equal(errors.length, 0, 'Cancellation immediately releases the server request slot');
    handler.cancelAudioPreview(previewOrigins[1], { requestId: 'preview-1' });
    let releasePreviewAccess: ((value: ChannelAccessContext) => void) | undefined;
    accessGate = new Promise((resolve) => { releasePreviewAccess = resolve; });
    const blockedStart = handler.audioPreview(previewOrigins[0], previewInputs[0], 'cancel-before-dispatch');
    handler.cancelAudioPreview(previewOrigins[0], { requestId: 'cancel-before-dispatch' });
    accessGate = null;
    const beforeDispatch = messages.filter(({ message }) => message.type === MessageType.COMMAND_AUDIO_PREVIEW).length;
    assert.ok(releasePreviewAccess);
    releasePreviewAccess(granted);
    await blockedStart;
    assert.equal(messages.filter(({ message }) => message.type === MessageType.COMMAND_AUDIO_PREVIEW).length, beforeDispatch);
    accessGate = new Promise((resolve) => { releasePreviewAccess = resolve; });
    const blockedResult = handler.audioPreviewResult(bot, { status: 'ok', mimeType: 'audio/ogg', audioBase64: 'AAAA' }, previewIds[2]);
    handler.cancelAutocomplete(previewOrigins[2], { requestId: 'preview-query-2' });
    accessGate = null;
    const beforeResult = messages.length;
    releasePreviewAccess(granted);
    await blockedResult;
    assert.equal(messages.length, beforeResult, 'Cancellation during delivery authorization discards the audio');
    handler.settingsChanged('timer');
    const afterPreviewCleanup = messages.length;
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_CHOICE_TTL_MS * 2);
    await flush();
    assert.equal(messages.length, afterPreviewCleanup, 'Invalidated lazy choices and previews leave no active timers');

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
    const closeFirst = await lazyChoice(downloader, 'close-first');
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS);
    const closeSecond = await lazyChoice(downloader, 'close-second', { page: 1 });
    await handler.audioPreview(downloader, closeFirst, 'close-preview');
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS);
    await handler.autocomplete(downloader, { ...input, page: 2 }, 'close-pending');
    const closePendingId = text(lastMessage(MessageType.COMMAND_AUTOCOMPLETE).requestId);
    handler.close();
    for (const page of [closeFirst, closeSecond]) {
      assert.equal(messages.some(({ ws, message }) => ws === downloader.ws &&
        message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL &&
        record(message.payload).requestId === page.autocompleteRequestId), true);
    }
    assert.equal(messages.some(({ ws, message }) => ws === bot.ws &&
      message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL && record(message.payload).requestId === closePendingId), true);
    assert.equal(lastMessage(MessageType.COMMAND_AUDIO_PREVIEW_RESULT).requestId, 'close-preview');
    const afterClose = messages.length;
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_CHOICE_TTL_MS * 2);
    await flush();
    await handler.autocomplete(downloader, input, 'closed');
    assert.equal(messages.length, afterClose);
  } finally {
    handler.close();
    t.mock.timers.reset();
  }
});

const LOCAL_TEST_URL = 'https://www.youtube.com/watch?v=abcdefghijk';
const LOCAL_TEST_TRACK = { id: 'abcdefghijk', title: 'Authored local fixture', url: LOCAL_TEST_URL, duration: 1 };
const LOCAL_TEST_SDP = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n';
const LOCAL_TEST_COMMANDS = [
  { name: 'local', description: 'Local fixture', localCapabilities: ['youtube-audio'],
    options: [{ name: 'query', description: 'Query', type: 'string', autocomplete: true }] },
  { name: 'plain', description: 'Legacy fixture' },
];

async function createLocalExecutionFixture(t: TestContext) {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Local owner');
  const caller = await f.human('Local caller');
  const channels = records(record(owner.auth.payload.server).channels);
  const textId = text(channels.find((channel) => channel.type === 'TEXT')?.id);
  const voiceId = text(channels.find((channel) => channel.type === 'VOICE')?.id);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const botId = text(record(created.payload.bot).id);
  const token = text(created.payload.token);
  const bot = await f.bot(token, undefined, 'Local fixture bot');
  assert.equal((await bot.peer.request(MessageType.COMMAND_REGISTER, { commands: LOCAL_TEST_COMMANDS })).type,
    MessageType.COMMAND_REGISTERED);
  const invoke = async (peer = caller.peer, commandName = 'local', requestId = randomUUID()) => {
    const since = peer.messages.length;
    peer.send(MessageType.COMMAND_INVOKE, {
      botId, channelId: textId, commandName, ...(commandName === 'local' ? { localPreparation: { capability: 'youtube-audio' } } : {}),
    }, requestId);
    const response = await peer.wait((message) => message.requestId === requestId, since);
    assert.equal(response.type, MessageType.COMMAND_INVOKED);
    return { id: text(response.payload.invocationId), requestId };
  };
  const retain = async (invocationId: string) => {
    const response = await bot.peer.request(MessageType.BOT_LOCAL_SOURCE_REQUEST,
      { action: 'retain', invocationId, url: LOCAL_TEST_URL });
    assert.equal(response.type, MessageType.BOT_LOCAL_SOURCE_RESULT);
    const result = localSourceResultSchema.parse(response.payload);
    assert.equal(result.status, 'retained');
    if (result.status !== 'retained') throw new Error('Expected retained source');
    return result.source;
  };
  const task = async (
    context: LocalRequestContext, spec: LocalTaskSpec = { operation: 'youtube.resolve', url: LOCAL_TEST_URL },
    botPeer = bot.peer, executor = caller.peer,
  ) => {
    const response = await botPeer.request(MessageType.BOT_LOCAL_TASK_REQUEST, {
      context, spec, ...(spec.operation === 'youtube.stream' ? { voiceChannelId: voiceId } : {}),
    });
    assert.equal(response.type, MessageType.BOT_LOCAL_TASK_OFFER, JSON.stringify(response.payload));
    const offer = localTaskOfferSchema.parse(response.payload);
    const received = await executor.wait((message) => message.type === MessageType.BOT_LOCAL_TASK_OFFER &&
      message.payload.taskId === offer.taskId);
    assert.equal(received.requestId, undefined, 'unsolicited delegation must not settle an executor UI request');
    const executorOffer = localTaskOfferSchema.parse(received.payload);
    assert.equal(executorOffer.taskId, offer.taskId);
    return { offer, executorOffer };
  };
  const event = async (offer: LocalTaskOffer, state: string, peer = bot.peer) => localTaskEventSchema.parse(
    (await peer.wait((message) => message.type === MessageType.BOT_LOCAL_TASK_EVENT &&
      message.payload.taskId === offer.taskId && message.payload.state === state)).payload);
  const join = async (invocationId: string) => {
    assert.equal((await caller.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId })).type, MessageType.VOICE_USER_JOINED);
    assert.equal((await bot.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId, invocationId })).type,
      MessageType.VOICE_USER_JOINED);
  };
  const negotiate = async (offer: LocalTaskOffer, botPeer = bot.peer, executor = caller.peer) => {
    assert.ok(offer.media);
    executor.send(MessageType.BOT_LOCAL_MEDIA_SIGNAL, {
      taskId: offer.taskId, mediaGeneration: offer.media.generation,
      signal: { signalType: 'offer', sdp: { type: 'offer', sdp: LOCAL_TEST_SDP } },
    });
    await botPeer.wait((message) => message.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL && message.payload.taskId === offer.taskId);
    botPeer.send(MessageType.BOT_LOCAL_MEDIA_SIGNAL, {
      taskId: offer.taskId, mediaGeneration: offer.media.generation,
      signal: { signalType: 'answer', sdp: { type: 'answer', sdp: LOCAL_TEST_SDP } },
    });
    await executor.wait((message) => message.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL && message.payload.taskId === offer.taskId);
  };
  return { ...f, connectBot: f.bot, owner, caller, bot, botId, token, textId, voiceId, invoke, retain, task, event, join, negotiate };
}

test('local execution real sockets expose only authenticated public keys and derive retained sources from original invocation capability', async (t) => {
  const f = await createLocalExecutionFixture(t);
  const otherDevice = await f.human('Local caller', f.caller.keys);
  const commands = records((await f.caller.peer.request(MessageType.COMMANDS_LIST)).payload.commands);
  assert.equal(commands.find((command) => command.name === 'local')?.botPublicKey, f.bot.keys.publicKey);
  await f.bot.peer.error(MessageType.COMMAND_REGISTER, {
    commands: [{ ...LOCAL_TEST_COMMANDS[0], botPublicKey: identity().publicKey }],
  }, ProtocolErrorCode.BOT_INVALID_OPTIONS);
  const invocation = await f.invoke();
  const source = await f.retain(invocation.id);
  assert.equal(source.invokerId, f.caller.id);
  assert.equal(source.invokerSessionId, record(f.caller.auth.payload.currentUser).sessionId);
  assert.notEqual(source.invokerSessionId, record(otherDevice.auth.payload.currentUser).sessionId);
  assert.equal(source.originChannelId, f.textId);
  assert.equal(source.botPublicKey, f.bot.keys.publicKey);
  assert.equal(source.url, LOCAL_TEST_URL);
  assert.equal('permit' in source, false);
  assert.equal('subject' in source, false);
  await f.caller.peer.error(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'retain', invocationId: invocation.id, url: LOCAL_TEST_URL }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.bot.peer.error(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'retain', invocationId: 'forged-invocation', url: LOCAL_TEST_URL }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.bot.peer.error(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'retain', invocationId: invocation.id, url: LOCAL_TEST_URL, invokerId: otherDevice.id }, ProtocolErrorCode.BAD_REQUEST);
  await f.bot.peer.error(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'retain', invocationId: invocation.id, url: LOCAL_TEST_URL, permit: 'native-secret' }, ProtocolErrorCode.BAD_REQUEST);
  await f.caller.peer.error(MessageType.COMMAND_INVOKE, {
    botId: f.botId, channelId: f.textId, commandName: 'local',
    localPreparation: { capability: 'youtube-audio', permit: 'native-secret' },
  }, ProtocolErrorCode.BOT_INVALID_OPTIONS);
  const legacy = await f.invoke(f.caller.peer, 'plain');
  assert.equal((await f.bot.peer.request(MessageType.COMMAND_REGISTER, { commands: [
    LOCAL_TEST_COMMANDS[0], { ...LOCAL_TEST_COMMANDS[1], localCapabilities: ['youtube-audio'] },
  ] })).type, MessageType.COMMAND_REGISTERED);
  await f.bot.peer.error(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'retain', invocationId: legacy.id, url: LOCAL_TEST_URL }, ProtocolErrorCode.PERMISSION_DENIED);
  const before = f.caller.peer.messages.length;
  f.caller.peer.send(MessageType.COMMAND_INVOKE, { botId: f.botId, channelId: f.textId, commandName: 'local' });
  const noCorrelation = await f.caller.peer.wait((message) => message.type === MessageType.COMMAND_INVOKED, before);
  await f.bot.peer.error(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'retain', invocationId: noCorrelation.payload.invocationId, url: LOCAL_TEST_URL }, ProtocolErrorCode.PERMISSION_DENIED);
  const other = await f.owner.peer.request(MessageType.BOT_CREATE, {});
  const foreign = await f.connectBot(text(other.payload.token));
  await foreign.peer.error(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'retain', invocationId: invocation.id, url: LOCAL_TEST_URL }, ProtocolErrorCode.PERMISSION_DENIED);
  await foreign.peer.error(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'release', sourceContextId: source.sourceContextId }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.bot.peer.error(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'release', sourceContextId: randomUUID() }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.bot.peer.error(MessageType.BOT_LOCAL_TASK_REQUEST, {
    context: { kind: 'source', sourceContextId: source.sourceContextId },
    spec: { operation: 'youtube.resolve', url: 'https://www.youtube.com/watch?v=zyxwvutsrqp' },
  }, ProtocolErrorCode.BAD_REQUEST);
  const { offer } = await f.task({ kind: 'invocation', invocationId: invocation.id });
  assert.equal(offer.requestId, invocation.requestId);
  assert.equal(offer.bot.botPublicKey, f.bot.keys.publicKey);
  assert.equal(offer.bot.botName, 'Local fixture bot');
  assert.equal(otherDevice.peer.messages.some((message) => message.type === MessageType.BOT_LOCAL_TASK_OFFER), false);
  await otherDevice.peer.error(MessageType.BOT_LOCAL_TASK_ACCEPT, {
    taskId: offer.taskId, result: { operation: 'youtube.resolve', track: LOCAL_TEST_TRACK },
  }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.bot.peer.error(MessageType.BOT_LOCAL_TASK_ACCEPT, {
    taskId: offer.taskId, result: { operation: 'youtube.resolve', track: LOCAL_TEST_TRACK },
  }, ProtocolErrorCode.PERMISSION_DENIED);
  f.caller.peer.send(MessageType.BOT_LOCAL_TASK_ACCEPT, {
    taskId: offer.taskId, result: { operation: 'youtube.resolve', track: LOCAL_TEST_TRACK },
  });
  await f.event(offer, 'accepted');
  await f.event(offer, 'completed');
  const completedSince = f.caller.peer.messages.length;
  f.caller.peer.send(MessageType.BOT_LOCAL_TASK_EVENT, { taskId: offer.taskId, state: 'completed' });
  await f.caller.peer.barrier();
  assert.equal(f.caller.peer.messages.slice(completedSince).some((message) => message.type === MessageType.SERVER_ERROR), false);
  assert.equal((await f.bot.peer.request(MessageType.COMMAND_FINISH, { invocationId: invocation.id })).type, MessageType.COMMAND_FINISHED);
  const retainedTask = await f.task({ kind: 'source', sourceContextId: source.sourceContextId });
  assert.notEqual(retainedTask.offer.requestId, invocation.requestId);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual((await f.bot.peer.request(MessageType.BOT_LOCAL_SOURCE_REQUEST,
      { action: 'release', sourceContextId: source.sourceContextId })).payload,
    { status: 'released', sourceContextId: source.sourceContextId });
  }
  assert.deepEqual(await f.event(retainedTask.offer, 'cancelled'),
    { state: 'cancelled', taskId: retainedTask.offer.taskId, cause: 'source_released' });
});

test('local execution real stream routing bootstraps before Main acceptance and cancels only active physical voice/socket leases', async (t) => {
  const f = await createLocalExecutionFixture(t);
  const invocation = await f.invoke();
  const source = await f.retain(invocation.id);
  await f.join(invocation.id);
  await f.bot.peer.request(MessageType.COMMAND_FINISH, { invocationId: invocation.id });
  const context: LocalRequestContext = { kind: 'source', sourceContextId: source.sourceContextId };
  const { offer } = await f.task(context, { operation: 'youtube.stream', url: LOCAL_TEST_URL });
  assert.ok(offer.media);
  await f.negotiate(offer);
  assert.equal(f.bot.peer.messages.some((message) => message.type === MessageType.BOT_LOCAL_TASK_EVENT &&
    message.payload.taskId === offer.taskId && message.payload.state === 'accepted'), false);
  const ready = { state: 'ready', taskId: offer.taskId, mediaGeneration: offer.media.generation };
  f.bot.peer.send(MessageType.BOT_LOCAL_TASK_EVENT, ready);
  f.caller.peer.send(MessageType.BOT_LOCAL_TASK_EVENT, ready);
  await f.caller.peer.barrier();
  assert.equal(f.bot.peer.messages.some((message) => message.type === MessageType.BOT_LOCAL_TASK_EVENT &&
    message.payload.taskId === offer.taskId && message.payload.state === 'ready'), false);
  f.caller.peer.send(MessageType.BOT_LOCAL_TASK_ACCEPT, {
    taskId: offer.taskId, result: { operation: 'youtube.stream', track: LOCAL_TEST_TRACK },
  });
  await f.event(offer, 'ready');
  assert.deepEqual(f.bot.peer.messages.filter((message) => message.type === MessageType.BOT_LOCAL_TASK_EVENT &&
    message.payload.taskId === offer.taskId).map((message) => message.payload.state), ['accepted', 'ready']);
  f.bot.peer.send(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: offer.taskId, revision: 1, action: 'pause' });
  await f.caller.peer.wait((message) => message.type === MessageType.BOT_LOCAL_TASK_CONTROL && message.payload.taskId === offer.taskId);
  f.caller.peer.send(MessageType.BOT_LOCAL_TASK_EVENT, { state: 'paused', taskId: offer.taskId, revision: 1 });
  await f.event(offer, 'paused');
  await f.caller.peer.request(MessageType.USER_UPDATE_VISIBILITY, { appearOffline: true });
  await f.caller.peer.request(MessageType.VOICE_STATE_UPDATE, { isMuted: true });
  assert.equal(f.bot.peer.messages.some((message) => message.type === MessageType.BOT_LOCAL_TASK_EVENT &&
    message.payload.taskId === offer.taskId && message.payload.state === 'cancelled'), false);
  await f.caller.peer.request(MessageType.VOICE_LEAVE, { channelId: f.voiceId });
  assert.deepEqual(await f.event(offer, 'cancelled'), { state: 'cancelled', taskId: offer.taskId, cause: 'requester_left_voice' });
  await f.caller.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  const next = await f.task(context, { operation: 'youtube.stream', url: LOCAL_TEST_URL });
  assert.notEqual(next.offer.taskId, offer.taskId);
  assert.notEqual(next.offer.media?.generation, offer.media.generation);
  await f.bot.peer.request(MessageType.VOICE_LEAVE, { channelId: f.voiceId });
  assert.deepEqual(await f.event(next.offer, 'cancelled'), { state: 'cancelled', taskId: next.offer.taskId, cause: 'bot_left_voice' });
  const joinInvocation = await f.invoke();
  await f.bot.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId, invocationId: joinInvocation.id });
  const active = await f.task(context, { operation: 'youtube.stream', url: LOCAL_TEST_URL });
  const replacement = await f.human('Local caller', f.caller.keys, f.caller.deviceId);
  assert.equal(record(replacement.auth.payload.currentUser).sessionId, source.invokerSessionId);
  assert.deepEqual(await f.event(active.offer, 'cancelled'),
    { state: 'cancelled', taskId: active.offer.taskId, cause: 'requester_disconnected' });
  const refused = await f.bot.peer.request(MessageType.BOT_LOCAL_TASK_REQUEST,
    { context, spec: { operation: 'youtube.resolve', url: LOCAL_TEST_URL } });
  assert.equal(refused.type, MessageType.SERVER_ERROR);
  assert.equal(refused.payload.message, 'requester_disconnected');
  assert.equal(replacement.peer.messages.some((message) => message.type === MessageType.BOT_LOCAL_TASK_OFFER), false);
  assert.equal((await f.bot.peer.request(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'release', sourceContextId: source.sourceContextId })).type, MessageType.BOT_LOCAL_SOURCE_RESULT);
});

test('local execution real preview RPC accepts only a completed one-shot proof for its remapped context and original UI', async (t) => {
  const f = await createLocalExecutionFixture(t);
  const queryId = randomUUID();
  f.caller.peer.send(MessageType.COMMAND_AUTOCOMPLETE, {
    botId: f.botId, channelId: f.textId, commandName: 'local', optionName: 'query', query: 'authored fixture',
    localPreparation: { capability: 'youtube-audio' },
  }, queryId);
  const execution = await f.bot.peer.wait((message) => message.type === MessageType.COMMAND_AUTOCOMPLETE);
  const remappedQuery = text(execution.requestId);
  assert.notEqual(remappedQuery, queryId);
  const search = await f.task({ kind: 'autocomplete', requestId: remappedQuery }, { operation: 'youtube.search', query: 'authored fixture' });
  assert.equal(search.offer.requestId, queryId);
  f.caller.peer.send(MessageType.BOT_LOCAL_TASK_ACCEPT, {
    taskId: search.offer.taskId, result: { operation: 'youtube.search', tracks: [LOCAL_TEST_TRACK] },
  });
  await f.event(search.offer, 'completed');
  f.bot.peer.send(MessageType.COMMAND_AUTOCOMPLETE_RESULT, { status: 'ok', choices: [{
    label: 'Authored fixture', value: LOCAL_TEST_URL, audio: { resourceId: 'fixture-resource', fileName: 'fixture.ogg' },
  }] }, remappedQuery);
  const choices = commandAutocompleteResultSchema.parse((await f.caller.peer.wait((message) =>
    message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT && message.requestId === queryId)).payload);
  assert.ok(choices.status === 'ok');
  const audio = choices.choices[0].audio;
  assert.ok(audio && 'resourceId' in audio);
  const preview = async () => {
    const requestId = randomUUID();
    const since = f.bot.peer.messages.length;
    f.caller.peer.send(MessageType.COMMAND_AUDIO_PREVIEW, {
      botId: f.botId, channelId: f.textId, commandName: 'local', optionName: 'query',
      autocompleteRequestId: queryId, resourceId: audio.resourceId, localPreparation: { capability: 'youtube-audio' },
    }, requestId);
    const execution = await f.bot.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW, since);
    return { requestId, remapped: text(execution.requestId) };
  };
  const cancelled = await preview();
  const cancelledTask = await f.task({ kind: 'audio-preview', requestId: cancelled.remapped },
    { operation: 'youtube.preview', url: LOCAL_TEST_URL });
  f.caller.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_CANCEL, { requestId: cancelled.requestId });
  assert.deepEqual(await f.event(cancelledTask.offer, 'cancelled'),
    { state: 'cancelled', taskId: cancelledTask.offer.taskId, cause: 'requested' });
  const forged = await preview();
  f.bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, {
    status: 'local', localPreviewId: 'forged-handle', taskId: 'forged-task', requestId: forged.requestId,
    executorSessionId: text(record(f.caller.auth.payload.currentUser).sessionId),
  }, forged.remapped);
  assert.deepEqual((await f.caller.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT &&
    message.requestId === forged.requestId)).payload, { status: 'failed', reason: 'invalid_response' });
  const request = await preview();
  const local = await f.task({ kind: 'audio-preview', requestId: request.remapped }, { operation: 'youtube.preview', url: LOCAL_TEST_URL });
  assert.equal(local.offer.requestId, request.requestId);
  const result = {
    localPreviewId: 'renderer-owned-opaque-handle', taskId: local.offer.taskId,
    requestId: request.requestId, executorSessionId: local.offer.invokerSessionId,
  };
  f.caller.peer.send(MessageType.BOT_LOCAL_TASK_ACCEPT, {
    taskId: local.offer.taskId, result: { operation: 'youtube.preview', ...result },
  });
  await f.event(local.offer, 'completed');
  f.bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, { status: 'local', ...result }, request.remapped);
  const returned = await f.caller.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT &&
    message.requestId === request.requestId);
  assert.deepEqual(returned.payload, { status: 'local', ...result });
  assert.equal('audioBase64' in returned.payload, false);
  assert.equal('url' in returned.payload, false);
  const staleSince = f.bot.peer.messages.length;
  f.bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, { status: 'local', ...result }, request.remapped);
  assert.equal((await f.bot.peer.wait((message) => message.type === MessageType.SERVER_ERROR &&
    message.requestId === request.remapped, staleSince)).payload.code, ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
  const replay = await preview();
  f.bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT, { status: 'local', ...result, requestId: replay.requestId }, replay.remapped);
  assert.deepEqual((await f.caller.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT &&
    message.requestId === replay.requestId)).payload, { status: 'failed', reason: 'invalid_response' });
  const legacy = await preview();
  f.bot.peer.send(MessageType.COMMAND_AUDIO_PREVIEW_RESULT,
    { status: 'ok', mimeType: 'audio/ogg', audioBase64: 'AAAA' }, legacy.remapped);
  assert.equal((await f.caller.peer.wait((message) => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT &&
    message.requestId === legacy.requestId)).payload.status, 'ok');
});

test('local execution real lifetimes cancel scoped work and invalidate references on capabilities, ACL and bot key changes', async (t) => {
  const f = await createLocalExecutionFixture(t);
  const invocation = await f.invoke();
  const source = await f.retain(invocation.id);
  const ephemeral = await f.task({ kind: 'invocation', invocationId: invocation.id });
  await f.caller.peer.request(MessageType.COMMAND_CANCEL, { invocationId: invocation.id });
  assert.deepEqual(await f.event(ephemeral.offer, 'cancelled'),
    { state: 'cancelled', taskId: ephemeral.offer.taskId, cause: 'requested' });
  const retained = await f.task({ kind: 'source', sourceContextId: source.sourceContextId });
  assert.equal((await f.bot.peer.request(MessageType.COMMAND_REGISTER, { commands: [{ name: 'local', description: 'No capability' }] })).type,
    MessageType.COMMAND_REGISTERED);
  assert.deepEqual(await f.event(retained.offer, 'cancelled'),
    { state: 'cancelled', taskId: retained.offer.taskId, cause: 'permission_revoked' });
  await f.bot.peer.error(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'release', sourceContextId: source.sourceContextId }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.bot.peer.request(MessageType.COMMAND_REGISTER, { commands: LOCAL_TEST_COMMANDS });
  const second = await f.invoke();
  const secondSource = await f.retain(second.id);
  const secondTask = await f.task({ kind: 'source', sourceContextId: secondSource.sourceContextId });
  await f.owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: f.textId, botCommandsEnabled: false });
  assert.deepEqual(await f.event(secondTask.offer, 'cancelled'),
    { state: 'cancelled', taskId: secondTask.offer.taskId, cause: 'permission_revoked' });
  await f.bot.peer.error(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'release', sourceContextId: secondSource.sourceContextId }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: f.textId, botCommandsEnabled: true });
  const third = await f.invoke();
  const thirdSource = await f.retain(third.id);
  const thirdTask = await f.task({ kind: 'source', sourceContextId: thirdSource.sourceContextId });
  await f.botRepo.update(f.botId, { boundPublicKey: identity().publicKey });
  f.caller.peer.send(MessageType.BOT_LOCAL_TASK_ACCEPT, {
    taskId: thirdTask.offer.taskId, result: { operation: 'youtube.resolve', track: LOCAL_TEST_TRACK },
  });
  assert.deepEqual(await f.event(thirdTask.offer, 'cancelled'),
    { state: 'cancelled', taskId: thirdTask.offer.taskId, cause: 'permission_revoked' });
  await f.bot.peer.error(MessageType.BOT_LOCAL_SOURCE_REQUEST,
    { action: 'release', sourceContextId: thirdSource.sourceContextId }, ProtocolErrorCode.PERMISSION_DENIED);
});

test('local execution real bot reconnect keeps references but exact requester replacement during an await cannot gain a lease', async (t) => {
  const f = await createLocalExecutionFixture(t);
  const invocation = await f.invoke();
  const source = await f.retain(invocation.id);
  const first = await f.task({ kind: 'source', sourceContextId: source.sourceContextId });
  const reconnected = await f.connectBot(f.token, f.bot.keys, 'Local fixture bot');
  assert.deepEqual(await f.event(first.offer, 'cancelled', f.caller.peer),
    { state: 'cancelled', taskId: first.offer.taskId, cause: 'bot_disconnected' });
  await reconnected.peer.request(MessageType.COMMAND_REGISTER, { commands: LOCAL_TEST_COMMANDS });
  const next = await f.task({ kind: 'source', sourceContextId: source.sourceContextId },
    { operation: 'youtube.resolve', url: LOCAL_TEST_URL }, reconnected.peer);
  f.caller.peer.send(MessageType.BOT_LOCAL_TASK_ACCEPT, {
    taskId: next.offer.taskId, result: { operation: 'youtube.resolve', track: LOCAL_TEST_TRACK },
  });
  await f.event(next.offer, 'completed', reconnected.peer);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = f.channelService.getAccessContext.bind(f.channelService);
  let held = false;
  t.mock.method(f.channelService, 'getAccessContext', async (userId: string) => {
    const access = await original(userId);
    if (userId === f.caller.id && !held) { held = true; enter(); await gate; }
    return access;
  });
  const pending = reconnected.peer.request(MessageType.BOT_LOCAL_TASK_REQUEST, {
    context: { kind: 'source', sourceContextId: source.sourceContextId },
    spec: { operation: 'youtube.resolve', url: LOCAL_TEST_URL },
  });
  try {
    await entered;
    const replacement = await f.human('Local caller', f.caller.keys, f.caller.deviceId);
    release();
    const refused = await pending;
    assert.equal(refused.type, MessageType.SERVER_ERROR);
    assert.equal(refused.payload.message, 'requester_disconnected');
    assert.equal(replacement.peer.messages.some((message) => message.type === MessageType.BOT_LOCAL_TASK_OFFER), false);
  } finally {
    release();
    await pending;
  }
});

test('local execution real private ICE uses authorized per-recipient TURN, excludes TURN in SFU and never masks builder failure', async (t) => {
  const f = await createLocalExecutionFixture(t);
  const invocation = await f.invoke();
  const source = await f.retain(invocation.id);
  await f.join(invocation.id);
  const context: LocalRequestContext = { kind: 'source', sourceContextId: source.sourceContextId };
  t.mock.method(f.coturnManager, 'isRunning', () => true);
  await f.serverRepo.updateServer({ turnEnabled: true, turnSecret: 'fixture-only-turn-secret', voiceMode: 'p2p' });
  const p2p = await f.task(context, { operation: 'youtube.stream', url: LOCAL_TEST_URL });
  const botTurn = p2p.offer.media?.iceServers.find((ice) => ice.username);
  const executorTurn = p2p.executorOffer.media?.iceServers.find((ice) => ice.username);
  assert.ok(botTurn && executorTurn);
  assert.ok(botTurn.username?.endsWith(`:${f.botId}`));
  assert.ok(executorTurn.username?.endsWith(`:${f.caller.id}`));
  f.bot.peer.send(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: p2p.offer.taskId, revision: 0, action: 'cancel' });
  await f.event(p2p.offer, 'cancelled');
  await f.serverRepo.updateServer({ voiceMode: 'sfu' });
  const sfu = await f.task(context, { operation: 'youtube.stream', url: LOCAL_TEST_URL });
  assert.equal(sfu.offer.media?.iceServers.some((ice) => ice.username), false);
  assert.equal(sfu.executorOffer.media?.iceServers.some((ice) => ice.username), false);
  f.bot.peer.send(MessageType.BOT_LOCAL_TASK_CONTROL, { taskId: sfu.offer.taskId, revision: 0, action: 'cancel' });
  await f.event(sfu.offer, 'cancelled');
  t.mock.method(f.coturnManager, 'buildIceServers', () => { throw new Error('Controlled local ICE builder failure'); });
  const failed = await f.bot.peer.request(MessageType.BOT_LOCAL_TASK_REQUEST, {
    context, spec: { operation: 'youtube.stream', url: LOCAL_TEST_URL }, voiceChannelId: f.voiceId,
  });
  assert.equal(failed.type, MessageType.SERVER_ERROR);
  assert.equal(failed.payload.message, 'transport_failed');
});

test('local execution real voice mode change and bot removal cancel private tasks before allowing further work', async (t) => {
  const f = await createLocalExecutionFixture(t);
  const invocation = await f.invoke();
  const source = await f.retain(invocation.id);
  await f.join(invocation.id);
  const context: LocalRequestContext = { kind: 'source', sourceContextId: source.sourceContextId };
  const stream = await f.task(context, { operation: 'youtube.stream', url: LOCAL_TEST_URL });
  t.mock.method(f.wsServer['sfuManager'], 'checkPortAvailability', async () => null);
  t.mock.method(f.wsServer['sfuManager'], 'init', async () => true);
  assert.equal((await f.owner.peer.request(MessageType.SERVER_UPDATE_SETTINGS, { voiceMode: 'sfu' })).type,
    MessageType.SERVER_SETTINGS_UPDATED);
  assert.deepEqual(await f.event(stream.offer, 'cancelled'),
    { state: 'cancelled', taskId: stream.offer.taskId, cause: 'voice_mode_changed' });
  const metadata = await f.task(context);
  assert.equal((await f.owner.peer.request(MessageType.BOT_REVOKE, { botId: f.botId })).type, MessageType.BOT_REVOKED);
  assert.deepEqual(await f.event(metadata.offer, 'cancelled', f.caller.peer),
    { state: 'cancelled', taskId: metadata.offer.taskId, cause: 'permission_revoked' });
  assert.deepEqual(f.wsServer['botLocalExecution'].counts, { tasks: 0, sources: 0, released: 0, previews: 0, retired: 0 });
});
