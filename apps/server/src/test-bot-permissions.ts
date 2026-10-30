import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  BOT_CAPABILITIES, MessageType, Permission, PROTOCOL_VERSION, ProtocolErrorCode, botPermissionsSnapshotSchema,
  botSettingsListResponseSchema, botSettingsSnapshotSchema, botSettingsSummarySchema, createProtocolOffer,
  type BotCapability,
} from '@monky/shared';
import { SqliteBotPermissionRepository } from './infrastructure/database/SqliteBotPermissionRepository';
import { BotPermissionService } from './application/services/BotPermissionService';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { botMessageCapabilities } from './infrastructure/websocket/botCapabilityPolicy';
import { createFixture, identity, record, records, text } from './testFixtures/bots';

async function fixture(t: TestContext) {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Capability owner');
  const caller = await f.human('Capability caller');
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  assert.equal(created.type, MessageType.BOT_CREATED);
  const botId = text(record(created.payload.bot).id);
  const token = text(created.payload.token);
  const channels = records(record(owner.auth.payload.server).channels);
  const textId = text(channels.find((channel) => channel.type === 'TEXT')?.id);
  const voiceId = text(channels.find((channel) => channel.type === 'VOICE')?.id);
  const keys = identity();
  const connectBot = () => f.bot(token, keys);
  const approve = async (granted: BotCapability[]) => {
    const state = f.botPermissions.get(botId);
    assert.ok(state);
    const response = await owner.peer.request(MessageType.BOT_PERMISSIONS_UPDATE, {
      botId, expectedRevision: state.revision, granted,
    });
    assert.equal(response.type, MessageType.BOT_PERMISSIONS_SNAPSHOT, JSON.stringify(response.payload));
    return botPermissionsSnapshotSchema.parse(response.payload).permissions;
  };
  return { ...f, owner, caller, botId, token, textId, voiceId, connectBot, approve };
}

test('manual and legacy bots receive no grant until a human manager reviews an explicit declaration', async (t) => {
  const f = await fixture(t);
  const state = f.botPermissions.get(f.botId);
  assert.equal(state?.requested, null);
  assert.deepEqual(state?.granted, []);
  assert.equal(state?.reviewedBy, null);
  await f.owner.peer.error(MessageType.BOT_PERMISSIONS_UPDATE,
    { botId: f.botId, expectedRevision: 0, granted: ['commands'] }, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  const bot = await f.connectBot();
  await bot.peer.error(MessageType.COMMAND_REGISTER, { commands: [] }, ProtocolErrorCode.BOT_CAPABILITIES_INVALID);
  await bot.peer.error(MessageType.COMMAND_REGISTER,
    { commands: [], requestedCapabilities: ['receive_screen'] }, ProtocolErrorCode.BOT_CAPABILITIES_INVALID);
  const declaration = { requestedCapabilities: [...BOT_CAPABILITIES], commands: [{ name: 'ping', description: 'Ping' }] };
  assert.equal((await bot.peer.request(MessageType.COMMAND_REGISTER, declaration)).type, MessageType.COMMAND_REGISTERED);
  assert.equal(f.botPermissions.get(f.botId)?.reviewRequired, true);
  assert.deepEqual(f.botPermissions.get(f.botId)?.granted, []);
  assert.deepEqual((await f.caller.peer.request(MessageType.COMMANDS_LIST)).payload.commands, []);
  await f.caller.peer.error(MessageType.COMMAND_INVOKE,
    { botId: f.botId, commandName: 'ping', channelId: f.textId }, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  for (const type of [
    MessageType.CHAT_SEND, MessageType.CHAT_LOAD_HISTORY, MessageType.CHAT_REACTION_ADD,
    MessageType.VOICE_JOIN, MessageType.SFU_CONSUME, MessageType.SFU_CREATE_WEBRTC_TRANSPORT,
    MessageType.SFU_PRODUCE, MessageType.BOT_LOCAL_SOURCE_REQUEST, MessageType.BOT_LOCAL_TASK_REQUEST,
    MessageType.BOT_LOCAL_TASK_CONTROL, MessageType.BOT_LOCAL_TASK_EVENT, MessageType.BOT_LOCAL_MEDIA_SIGNAL,
    MessageType.SELECTOR_CREATE, MessageType.SELECTOR_LIST, MessageType.SELECTOR_UPDATE, MessageType.SELECTOR_FINALIZE,
    MessageType.BOT_SCREEN_CREATE, MessageType.BOT_SCREEN_LIST, MessageType.BOT_SCREEN_UPDATE,
    MessageType.COMMAND_PROMPT, MessageType.COMMAND_RESPONSE, MessageType.COMMAND_SOUND_DOWNLOAD,
    MessageType.COMMAND_AUTOCOMPLETE_RESULT, MessageType.COMMAND_AUDIO_PREVIEW_RESULT,
  ]) await bot.peer.error(type, {}, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  for (const type of [MessageType.SOUNDBOARD_PLAY, MessageType.BOT_CREATE,
    MessageType.BOT_INSTALL, MessageType.BOT_PERMISSIONS_UPDATE, MessageType.CHAT_REQUEST_UPLOAD_TOKEN]) {
    await bot.peer.error(type, {}, ProtocolErrorCode.PERMISSION_DENIED);
  }
  const before = bot.peer.messages.length;
  await f.caller.peer.request(MessageType.CHAT_SEND, { channelId: f.textId, content: 'Not shared with unreviewed bots' });
  await bot.peer.barrier();
  assert.equal(bot.peer.messages.slice(before).some((message) => message.type === MessageType.CHAT_MESSAGE), false);
  const forum = await f.channelService.createChannel({ name: 'Forum', type: 'FORUM' });
  assert.ok(forum.channel);
  const post = await f.owner.peer.request(MessageType.FORUM_CREATE_POST, {
    id: randomUUID(), channelId: forum.channel.id, title: 'Human topic', content: 'Not shared with unreviewed bots',
  });
  assert.equal(post.type, MessageType.FORUM_POST_SAVED);
  await bot.peer.barrier();
  assert.equal(bot.peer.messages.slice(before).some(message =>
    message.type === MessageType.FORUM_POST_SAVED || message.type === MessageType.CHAT_MESSAGE), false);
});

test('unlink notifies the affected bot before closing its connection, unlike a capability review', async t => {
  const f = await fixture(t);
  let bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, { requestedCapabilities: ['commands'], commands: [] });
  const reviewedMessages = bot.peer.messages.length;
  const closedForReview = once(bot.peer.ws, 'close');
  await f.approve(['commands']);
  await closedForReview;
  assert.equal(bot.peer.messages.slice(reviewedMessages).some(message => message.type === MessageType.BOT_REVOKED), false);
  bot = await f.connectBot();
  const notice = bot.peer.wait(message => message.type === MessageType.BOT_REVOKED);
  const closed = once(bot.peer.ws, 'close');
  const result = await f.owner.peer.request(MessageType.BOT_REVOKE, { botId: f.botId });
  assert.equal(result.type, MessageType.BOT_REVOKED);
  assert.equal((await notice).payload.botId, f.botId);
  await closed;
});

test('only MANAGE_BOTS may approve a requested subset, with persistent optimistic revisions', async (t) => {
  const f = await fixture(t);
  const bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, { requestedCapabilities: ['send_messages'], commands: [] });
  const state = f.botPermissions.get(f.botId);
  assert.ok(state);
  const update = { botId: f.botId, expectedRevision: state.revision, granted: ['send_messages'] };
  await f.caller.peer.error(MessageType.BOT_PERMISSIONS_UPDATE, update, ProtocolErrorCode.PERMISSION_DENIED);
  await f.caller.peer.error(MessageType.BOT_PERMISSIONS_GET, { botId: f.botId }, ProtocolErrorCode.PERMISSION_DENIED);
  const role = await f.owner.peer.request(MessageType.ROLE_CREATE, { name: 'Configure only', permissions: Permission.CONFIGURE_BOTS });
  assert.equal(role.type, MessageType.ROLES_LIST);
  const roleId = text(records(role.payload.roles).find((entry) => entry.name === 'Configure only')?.id);
  await f.owner.peer.request(MessageType.ROLE_ASSIGN, { userId: f.caller.id, roleId });
  await f.caller.peer.error(MessageType.BOT_PERMISSIONS_UPDATE, update, ProtocolErrorCode.PERMISSION_DENIED);
  await f.owner.peer.error(MessageType.BOT_PERMISSIONS_UPDATE, { ...update, granted: ['publish_voice'] }, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  await f.owner.peer.error(MessageType.BOT_PERMISSIONS_UPDATE, { ...update, expectedRevision: state.revision - 1 }, ProtocolErrorCode.BOT_PERMISSIONS_CONFLICT);
  const approved = await f.approve(['send_messages']);
  assert.equal(approved.reviewRequired, false);
  assert.equal(approved.reviewedBy, f.owner.id);
  assert.ok(approved.reviewedAt);
  const reopened = new BotPermissionService(new SqliteBotPermissionRepository(f.database.getDb()));
  assert.deepEqual(reopened.get(f.botId), approved);
  assert.equal(reopened.allows(f.botId, 'send_messages'), true);
  assert.equal(reopened.allows(f.botId, 'read_messages'), false);
  const connected = await f.connectBot();
  assert.equal((await connected.peer.request(MessageType.CHAT_SEND, { channelId: f.textId, content: 'Approved message' })).type, MessageType.CHAT_MESSAGE);
  await connected.peer.error(MessageType.CHAT_LOAD_HISTORY, { channelId: f.textId }, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  await f.owner.peer.request(MessageType.BOT_REVOKE, { botId: f.botId });
  // The live service forgets the bot at once, and nothing stored grants it anything (BOTS-5).
  for (const permissions of [f.botPermissions, new BotPermissionService(new SqliteBotPermissionRepository(f.database.getDb()))]) {
    assert.equal(permissions.get(f.botId), undefined);
    assert.equal(permissions.allows(f.botId, 'send_messages'), false);
  }
});

test('changed bot requests never increase grants and invalidate old approvals and live sockets', async (t) => {
  const f = await fixture(t);
  let bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, { requestedCapabilities: ['send_messages'], commands: [] });
  const first = await f.approve(['send_messages']);
  bot = await f.connectBot();
  const closed = once(bot.peer.ws, 'close');
  bot.peer.send(MessageType.COMMAND_REGISTER, { requestedCapabilities: ['send_messages', 'publish_voice'], commands: [] });
  await closed;
  const increased = f.botPermissions.get(f.botId);
  assert.ok(increased);
  assert.deepEqual(increased.granted, ['send_messages']);
  assert.equal(increased.reviewRequired, true);
  assert.equal(increased.reviewedBy, null);
  await f.owner.peer.error(MessageType.BOT_PERMISSIONS_UPDATE,
    { botId: f.botId, expectedRevision: first.revision, granted: ['send_messages'] }, ProtocolErrorCode.BOT_PERMISSIONS_CONFLICT);
  bot = await f.connectBot();
  assert.equal((await bot.peer.request(MessageType.COMMAND_REGISTER,
    { requestedCapabilities: ['send_messages', 'publish_voice'], commands: [] })).type, MessageType.COMMAND_REGISTERED);
  await bot.peer.error(MessageType.VOICE_JOIN, { channelId: f.voiceId }, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  assert.equal((await bot.peer.request(MessageType.CHAT_SEND, { channelId: f.textId, content: 'Retained grant' })).type, MessageType.CHAT_MESSAGE);
  const removed = once(bot.peer.ws, 'close');
  bot.peer.send(MessageType.COMMAND_REGISTER, { requestedCapabilities: [], commands: [] });
  await removed;
  assert.deepEqual(f.botPermissions.get(f.botId)?.granted, []);
});

test('reviewed grants and full migration names survive a database shutdown and reopen', async (t) => {
  const f = await fixture(t);
  const bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, { requestedCapabilities: ['send_messages'], commands: [] });
  const approved = await f.approve(['send_messages']);
  await f.wsServer.close();
  await Promise.all(f.peers.map((peer) => peer.close()));
  f.database.close();
  const persisted = await DatabaseConnection.create(path.join(f.dataDir, 'server.db'));
  try {
    const permissions = new BotPermissionService(new SqliteBotPermissionRepository(persisted.getDb()));
    assert.deepEqual(permissions.get(f.botId), approved);
    assert.equal(permissions.allows(f.botId, 'send_messages'), true);
    const migrations = records(persisted.getDb().prepare('SELECT version FROM schema_migrations').all());
    assert.equal(migrations.filter((migration) => migration.version === '026_bot_capability_consent.sql').length, 1);
    assert.ok(migrations.some((migration) => migration.version === '024_bot_profile_authority.sql'));
    assert.ok(migrations.some((migration) => migration.version === '024_bot_voice_restrictions.sql'));
  } finally {
    persisted.close();
  }
});

test('an in-flight send cannot commit after revocation or rapid re-approval', async (t) => {
  const f = await fixture(t);
  let bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, { requestedCapabilities: ['send_messages'], commands: [] });
  await f.approve(['send_messages']);
  bot = await f.connectBot();
  let entered!: () => void;
  let resume!: () => void;
  let completed!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const release = new Promise<void>((resolve) => { resume = resolve; });
  const finished = new Promise<void>((resolve) => { completed = resolve; });
  const original = f.chatService.sendBotMessage.bind(f.chatService);
  const paused = t.mock.method(f.chatService, 'sendBotMessage', async (...args: Parameters<typeof original>) => {
    entered();
    await release;
    try { return await original(...args); } finally { completed(); }
  });
  const before = f.caller.peer.messages.length;
  bot.peer.send(MessageType.CHAT_SEND, { channelId: f.textId, content: 'Must not be committed' });
  await waiting;
  await f.approve([]);
  await f.approve(['send_messages']);
  resume();
  await finished;
  paused.mock.restore();
  const replacement = await f.connectBot();
  await replacement.peer.barrier();
  await f.caller.peer.barrier();
  const history = await f.caller.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId: f.textId });
  assert.equal(history.type, MessageType.CHAT_HISTORY);
  assert.equal(JSON.stringify(history.payload).includes('Must not be committed'), false);
  assert.equal(f.caller.peer.messages.slice(before).some((message) =>
    message.type === MessageType.CHAT_MESSAGE && message.payload.content === 'Must not be committed'), false);
});

test('private commands work without channel-reading or public-message grants', async (t) => {
  const f = await fixture(t);
  const declaration = {
    requestedCapabilities: ['commands', 'read_messages', 'send_messages'],
    commands: [{ name: 'ping', description: 'Private command' }],
  };
  let bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, declaration);
  await f.approve(['commands']);
  bot = await f.connectBot();
  assert.equal((await bot.peer.request(MessageType.COMMAND_REGISTER, declaration)).type, MessageType.COMMAND_REGISTERED);
  const before = bot.peer.messages.length;
  await f.owner.peer.request(MessageType.CHAT_SEND, { channelId: f.textId, content: 'Channel text is not command input' });
  const invocation = await f.caller.peer.request(MessageType.COMMAND_INVOKE,
    { botId: f.botId, commandName: 'ping', channelId: f.textId });
  assert.equal(invocation.type, MessageType.COMMAND_INVOKED);
  await bot.peer.wait((message) => message.type === MessageType.COMMAND_INVOKE, before);
  bot.peer.send(MessageType.COMMAND_RESPONSE, { invocationId: invocation.payload.invocationId, content: 'Only the caller receives this' });
  const response = await f.caller.peer.wait((message) => message.type === MessageType.COMMAND_RESPONSE &&
    message.payload.invocationId === invocation.payload.invocationId);
  assert.equal(response.payload.ephemeral, true);
  await bot.peer.error(MessageType.COMMAND_RESPONSE,
    { invocationId: invocation.payload.invocationId, content: 'Unapproved public output', ephemeral: false },
    ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  await bot.peer.error(MessageType.CHAT_SEND, { channelId: f.textId, content: 'Unapproved message' },
    ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  await bot.peer.error(MessageType.CHAT_LOAD_HISTORY, { channelId: f.textId }, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  await bot.peer.barrier();
  assert.equal(bot.peer.messages.slice(before).some((message) => message.type === MessageType.CHAT_MESSAGE), false);
  await f.owner.peer.barrier();
  assert.equal(f.owner.peer.messages.some((message) => message.type === MessageType.COMMAND_RESPONSE &&
    message.payload.invocationId === invocation.payload.invocationId), false);
  await f.approve(['commands', 'read_messages']);
  bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, declaration);
  const reading = bot.peer.messages.length;
  await f.owner.peer.request(MessageType.CHAT_SEND, { channelId: f.textId, content: 'Explicitly approved channel input' });
  await bot.peer.wait((message) => message.type === MessageType.CHAT_MESSAGE &&
    message.payload.content === 'Explicitly approved channel input', reading);
  await bot.peer.error(MessageType.CHAT_SEND, { channelId: f.textId, content: 'Reading is not publication' },
    ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
});

test('voice grants permit only publishing and revocation tears down the active room', async (t) => {
  const f = await fixture(t);
  let bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, { requestedCapabilities: ['publish_voice'], commands: [] });
  await f.approve(['publish_voice']);
  bot = await f.connectBot();
  await f.caller.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  const joined = await bot.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  assert.equal(joined.type, MessageType.VOICE_USER_JOINED);
  const permissions = { publish: true, receive: false, publishRequested: true, receiveRequested: false };
  assert.deepEqual(record(joined.payload.voiceState).botVoicePermissions, permissions);
  const botSession = text(record(bot.auth.payload.currentUser).sessionId);
  const callerSession = text(record(f.caller.auth.payload.currentUser).sessionId);
  for (const [type, key, flag] of [
    [MessageType.ADMIN_MUTE_USER, 'muted', 'serverMuted'],
    [MessageType.ADMIN_DEAFEN_USER, 'deafened', 'serverDeafened'],
  ] as const) {
    for (const enabled of [true, false]) {
      await f.owner.peer.request(type, { targetUserId: f.botId, [key]: enabled });
      const state = f.signalingService.getVoiceState(botSession);
      assert.equal(state?.[flag], enabled);
      assert.deepEqual(state?.botVoicePermissions, permissions);
      assert.deepEqual(f.botPermissions.get(f.botId)?.granted, ['publish_voice']);
    }
  }
  const signal = (from: string, target: string, direction: string) => ({
    fromSessionId: from, targetSessionId: target, signalType: 'offer', subscriptionId: 'peer-epoch',
    sdp: { type: 'offer', sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${direction}\r\n` },
  });
  await bot.peer.error(MessageType.RTC_SIGNAL, signal(botSession, callerSession, 'recvonly'), ProtocolErrorCode.PERMISSION_DENIED);
  await f.caller.peer.error(MessageType.RTC_SIGNAL, signal(callerSession, botSession, 'sendrecv'), ProtocolErrorCode.PERMISSION_DENIED);
  const before = f.caller.peer.messages.length;
  bot.peer.send(MessageType.RTC_SIGNAL, signal(botSession, callerSession, 'sendonly'));
  await f.caller.peer.wait((message) => message.type === MessageType.RTC_SIGNAL, before);
  await f.approve([]);
  await f.caller.peer.wait((message) => message.type === MessageType.VOICE_USER_LEFT && message.payload.sessionId === botSession, before);
  assert.equal(f.signalingService.getVoiceState(botSession), undefined);
});

test('listening-only bots do not report unrequested publication as a denial', async (t) => {
  const f = await fixture(t);
  let bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, { requestedCapabilities: ['receive_voice'], commands: [] });
  await f.approve(['receive_voice']);
  bot = await f.connectBot();
  await f.caller.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  const joined = await bot.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId, receiveAudio: true });
  assert.equal(joined.type, MessageType.VOICE_USER_JOINED);
  const permissions = { publish: false, receive: true, publishRequested: false, receiveRequested: true };
  assert.deepEqual(record(joined.payload.voiceState).botVoicePermissions, permissions);
  const announced = await f.caller.peer.wait(message =>
    message.type === MessageType.VOICE_USER_JOINED && message.payload.sessionId === joined.payload.sessionId);
  assert.deepEqual(record(announced.payload.voiceState).botVoicePermissions, permissions);
});

test('listening requires its own grant and opt-in, exposes authoritative directions and follows deafen', async (t) => {
  const f = await fixture(t);
  let bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, { requestedCapabilities: ['publish_voice', 'receive_voice'], commands: [] });
  await f.approve(['publish_voice']);
  bot = await f.connectBot();
  await bot.peer.error(MessageType.VOICE_JOIN, { channelId: f.voiceId, receiveAudio: true }, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  const publishing = await bot.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  assert.equal(record(publishing.payload.voiceState).receivesVoice, false);
  assert.deepEqual(record(publishing.payload.voiceState).botVoicePermissions,
    { publish: true, receive: false, publishRequested: true, receiveRequested: true });
  await f.approve(['receive_voice']);
  bot = await f.connectBot();
  await f.caller.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  const joined = await bot.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId, receiveAudio: true });
  assert.equal(joined.type, MessageType.VOICE_USER_JOINED, JSON.stringify(joined.payload));
  assert.equal(record(joined.payload.voiceState).receivesVoice, true);
  assert.deepEqual(record(joined.payload.voiceState).botVoicePermissions,
    { publish: false, receive: true, publishRequested: true, receiveRequested: true });
  const botSession = text(record(bot.auth.payload.currentUser).sessionId);
  const callerSession = text(record(f.caller.auth.payload.currentUser).sessionId);
  const signal = (direction: string) => ({
    fromSessionId: botSession, targetSessionId: callerSession, signalType: 'offer',
    subscriptionId: 'bot-listen-session',
    sdp: { type: 'offer', sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${direction}\r\n` },
  });
  await bot.peer.error(MessageType.RTC_SIGNAL, signal('sendrecv'), ProtocolErrorCode.PERMISSION_DENIED);
  const since = f.caller.peer.messages.length;
  bot.peer.send(MessageType.RTC_SIGNAL, signal('recvonly'));
  await f.caller.peer.wait(message => message.type === MessageType.RTC_SIGNAL, since);
  const forgedPermissions = { publish: true, receive: true, publishRequested: true, receiveRequested: true };
  await bot.peer.error(MessageType.VOICE_STATE_UPDATE, { receivesVoice: true, botVoicePermissions: forgedPermissions },
    ProtocolErrorCode.PERMISSION_DENIED);
  const forged = await f.caller.peer.request(MessageType.VOICE_STATE_UPDATE,
    { receivesVoice: true, botVoicePermissions: forgedPermissions });
  assert.equal(record(forged.payload.voiceState).receivesVoice, undefined);
  assert.equal(record(forged.payload.voiceState).botVoicePermissions, undefined);
  const deafened = await bot.peer.request(MessageType.VOICE_STATE_UPDATE, { isDeafened: true });
  assert.equal(record(deafened.payload.voiceState).isDeafened, true);
  await bot.peer.error(MessageType.RTC_SIGNAL, signal('recvonly'), ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.request(MessageType.VOICE_STATE_UPDATE, { isDeafened: false });
  await f.owner.peer.request(MessageType.ADMIN_DEAFEN_USER, { targetUserId: f.botId, deafened: true });
  await bot.peer.error(MessageType.RTC_SIGNAL, signal('recvonly'), ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.request(MessageType.VOICE_STATE_UPDATE, { isDeafened: false });
  assert.equal(f.signalingService.getVoiceState(botSession)?.serverDeafened, true);
  await f.owner.peer.request(MessageType.ADMIN_DEAFEN_USER, { targetUserId: f.botId, deafened: false });
  const restored = f.caller.peer.messages.length;
  bot.peer.send(MessageType.RTC_SIGNAL, signal('recvonly'));
  await f.caller.peer.wait(message => message.type === MessageType.RTC_SIGNAL, restored);
  await f.approve([]);
  await f.caller.peer.wait(message => message.type === MessageType.VOICE_USER_LEFT && message.payload.sessionId === botSession, restored);
  assert.equal(f.signalingService.getVoiceState(botSession), undefined);
});

test('SFU receiving bots may consume only same-room human microphones on their own receive transport', { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  await f.serverRepo.updateServer({ voiceMode: 'sfu' });
  let bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, { requestedCapabilities: ['publish_voice', 'receive_voice'], commands: [] });
  await f.approve(['publish_voice', 'receive_voice']);
  bot = await f.connectBot();
  await bot.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  await bot.peer.error(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, { channelId: f.voiceId, direction: 'recv' }, ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.request(MessageType.VOICE_LEAVE, { channelId: f.voiceId });
  await bot.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId, receiveAudio: true });
  await f.caller.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  const humanTransport = await f.caller.peer.request(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, { channelId: f.voiceId, direction: 'send' });
  const humanTransportId = text(record(humanTransport.payload.transportOptions).id);
  const screenTransport = await f.caller.peer.request(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, {
    channelId: f.voiceId, direction: 'send', purpose: 'screen',
  });
  const screenTransportId = text(record(screenTransport.payload.transportOptions).id);
  const sent = await bot.peer.request(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, { channelId: f.voiceId, direction: 'send' });
  const sendId = text(record(sent.payload.transportOptions).id);
  const received = await bot.peer.request(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, { channelId: f.voiceId, direction: 'recv' });
  const recvId = text(record(received.payload.transportOptions).id);
  const rtpParameters = (ssrc: number) => ({
    codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }],
    encodings: [{ ssrc }], rtcp: { cname: 'synthetic' },
  });
  const produce = async (mediaType: 'mic' | 'screen_audio', ssrc: number) => {
    const message = await f.caller.peer.request(MessageType.SFU_PRODUCE, {
      channelId: f.voiceId, transportId: mediaType === 'mic' ? humanTransportId : screenTransportId,
      kind: 'audio', rtpParameters: rtpParameters(ssrc),
      appData: mediaType === 'mic' ? { mediaType } : { mediaType, shareId: 'owned-screen' },
    });
    assert.equal(message.type, MessageType.SFU_PRODUCED, JSON.stringify(message.payload));
    return text(message.payload.id);
  };
  const mic = await produce('mic', 1111);
  const screen = await produce('screen_audio', 2222);
  const botAudio = await bot.peer.request(MessageType.SFU_PRODUCE, {
    channelId: f.voiceId, transportId: sendId, kind: 'audio', rtpParameters: rtpParameters(3333), appData: { mediaType: 'mic' },
  });
  assert.equal(botAudio.type, MessageType.SFU_PRODUCED, 'Creating a receiver preserves the bot send transport');
  const list = await bot.peer.request(MessageType.SFU_GET_PRODUCERS, { channelId: f.voiceId });
  assert.deepEqual(records(list.payload.producers).map(producer => producer.producerId), [mic]);
  const consume = {
    channelId: f.voiceId, transportId: recvId, producerId: mic,
    rtpCapabilities: { codecs: [{ kind: 'audio', mimeType: 'audio/opus', preferredPayloadType: 111,
      clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }], headerExtensions: [] },
  };
  for (const producerId of [screen, text(botAudio.payload.id), 'unknown-producer']) {
    await bot.peer.error(MessageType.SFU_CONSUME, { ...consume, producerId }, ProtocolErrorCode.PERMISSION_DENIED);
  }
  for (const transportId of [humanTransportId, sendId]) {
    await bot.peer.error(MessageType.SFU_CONSUME, { ...consume, transportId }, ProtocolErrorCode.PERMISSION_DENIED);
  }
  await bot.peer.error(MessageType.SFU_CONSUME, { ...consume, channelId: f.textId }, ProtocolErrorCode.BAD_REQUEST);
  const consumed = await bot.peer.request(MessageType.SFU_CONSUME, consume);
  assert.equal(consumed.type, MessageType.SFU_CONSUMED, JSON.stringify(consumed.payload));
  assert.equal(consumed.payload.producerId, mic);
  assert.equal(consumed.payload.producerSessionId, record(f.caller.auth.payload.currentUser).sessionId);
  const microphone = f.wsServer['sfuManager']['producers'].get(mic);
  assert.ok(microphone);
  assert.equal(microphone.producer.paused, false);
  await f.caller.peer.request(MessageType.VOICE_STATE_UPDATE, { isMuted: true });
  assert.equal(microphone.producer.paused, true, 'A muted microphone must be blocked before packets reach the bot');
  await bot.peer.request(MessageType.SFU_CONSUMER_SET_PAUSED, {
    channelId: f.voiceId, consumerId: text(consumed.payload.id), paused: false,
  });
  assert.equal(microphone.producer.paused, true, 'A consumer cannot bypass the source mute');
  await f.caller.peer.request(MessageType.VOICE_STATE_UPDATE, { isMuted: false });
  assert.equal(microphone.producer.paused, false);
  const callerId = text(record(f.caller.auth.payload.currentUser).id);
  await f.owner.peer.request(MessageType.ADMIN_MUTE_USER, { targetUserId: callerId, muted: true });
  assert.equal(microphone.producer.paused, true);
  await f.caller.peer.request(MessageType.VOICE_STATE_UPDATE, { isMuted: false });
  assert.equal(microphone.producer.paused, true, 'Personal unmute cannot override administrative mute');
  await f.owner.peer.request(MessageType.ADMIN_MUTE_USER, { targetUserId: callerId, muted: false });
  assert.equal(microphone.producer.paused, false);
  await bot.peer.request(MessageType.VOICE_STATE_UPDATE, { isDeafened: true });
  assert.equal(f.wsServer['sfuManager']['transports'].has(recvId), false);
  assert.equal(f.wsServer['sfuManager']['transports'].has(sendId), true);
  assert.equal(f.wsServer['sfuManager']['consumers'].has(text(consumed.payload.id)), false);
  await bot.peer.error(MessageType.SFU_CONSUME, consume, ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.request(MessageType.VOICE_STATE_UPDATE, { isDeafened: false });
  const resumed = await bot.peer.request(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, { channelId: f.voiceId, direction: 'recv' });
  const resumedId = text(record(resumed.payload.transportOptions).id);
  await f.owner.peer.request(MessageType.ADMIN_DEAFEN_USER, { targetUserId: f.botId, deafened: true });
  assert.equal(f.wsServer['sfuManager']['transports'].has(resumedId), false);
  await f.approve(['publish_voice']);
  assert.equal(f.wsServer['sfuManager']['transports'].has(sendId), false);
});

test('late SFU receive allocation cannot replace reception restored after deafen', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await f.serverRepo.updateServer({ voiceMode: 'sfu' });
  let bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, { requestedCapabilities: ['receive_voice'], commands: [] });
  await f.approve(['receive_voice']);
  bot = await f.connectBot();
  await bot.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId, receiveAudio: true });
  const sfu = f.wsServer['sfuManager'];
  const allocate = sfu.createWebRtcTransport.bind(sfu);
  let announce!: (id: string) => void;
  let release!: () => void;
  const allocated = new Promise<string>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  t.mock.method(sfu, 'createWebRtcTransport', async (...args: Parameters<typeof allocate>) => {
    const transport = await allocate(...args);
    if (first) {
      first = false;
      announce(transport.id);
      await gate;
    }
    return transport;
  });
  const pending = bot.peer.request(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, { channelId: f.voiceId, direction: 'recv' });
  try {
    const oldId = await allocated;
    await f.owner.peer.request(MessageType.ADMIN_DEAFEN_USER, { targetUserId: f.botId, deafened: true });
    assert.equal(sfu['transports'].has(oldId), false);
    await f.owner.peer.request(MessageType.ADMIN_DEAFEN_USER, { targetUserId: f.botId, deafened: false });
    const replacing = bot.peer.request(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, { channelId: f.voiceId, direction: 'recv' });
    release();
    const [obsolete, replacement] = await Promise.all([pending, replacing]);
    const replacementId = text(record(replacement.payload.transportOptions).id);
    assert.equal(obsolete.type, MessageType.SERVER_ERROR);
    assert.equal(obsolete.payload.code, ProtocolErrorCode.BAD_REQUEST);
    assert.deepEqual([...sfu['transports'].keys()], [replacementId]);
    assert.equal(sfu['transports'].get(replacementId)?.transport.closed, false);
    await bot.peer.request(MessageType.VOICE_LEAVE, { channelId: f.voiceId });
    assert.equal(sfu['transports'].size, 0);
  } finally {
    release();
    await pending;
  }
});

test('revoking interactive capabilities closes durable selectors and voice miniapps without reviving stale controls', async (t) => {
  const f = await fixture(t);
  const requested: BotCapability[] = ['commands', 'send_messages', 'selectors', 'miniapps'];
  const declaration = {
    requestedCapabilities: requested,
    commands: [{ name: 'screen', description: 'Interactive fixture', voiceRequirement: 'joined' }],
  };
  let bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, declaration);
  await f.approve(requested);
  bot = await f.connectBot();
  assert.equal((await bot.peer.request(MessageType.COMMAND_REGISTER, declaration)).type, MessageType.COMMAND_REGISTERED);
  await f.caller.peer.request(MessageType.VOICE_JOIN, { channelId: f.voiceId });
  const invocation = await f.caller.peer.request(MessageType.COMMAND_INVOKE,
    { botId: f.botId, channelId: f.textId, commandName: 'screen' });
  assert.equal(invocation.type, MessageType.COMMAND_INVOKED);
  const screen = await bot.peer.request(MessageType.BOT_SCREEN_CREATE, {
    id: 'permission-screen', invocationId: invocation.payload.invocationId, channelId: f.voiceId,
    title: 'Permission screen', html: '<p>Approved interaction</p>', state: {},
  });
  assert.equal(screen.type, MessageType.BOT_SCREEN_SNAPSHOT);
  const action = { id: screen.payload.id, instanceId: screen.payload.instanceId, action: 'select', payload: null,
    revision: 0, actionId: 'before-revocation' };
  assert.equal((await f.caller.peer.request(MessageType.BOT_SCREEN_ACTION, action)).type, MessageType.BOT_SCREEN_SNAPSHOT);
  const selector = await bot.peer.request(MessageType.SELECTOR_CREATE, {
    id: 'permission-selector', channelId: f.textId, title: 'Reviewed choices',
    choices: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }],
    presentation: 'buttons', responder: 'any', allowChange: true, maxResponders: 2,
  });
  assert.equal(selector.type, MessageType.SELECTOR_SNAPSHOT, JSON.stringify(selector.payload));
  await bot.peer.error(MessageType.CHAT_LOAD_HISTORY, { channelId: f.textId }, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  const selectorId = text(selector.payload.id);
  const before = f.caller.peer.messages.length;
  await f.approve(['commands', 'send_messages']);
  await f.caller.peer.wait((message) => message.type === MessageType.BOT_SCREEN_REMOVED &&
    message.payload.instanceId === screen.payload.instanceId, before);
  const closedSelectors = await f.caller.peer.request(MessageType.SELECTOR_LIST, { channelId: f.textId });
  const closed = records(closedSelectors.payload.selectors).find((entry) => entry.id === selectorId);
  assert.ok(closed);
  assert.equal(closed.canRespond, false);
  assert.equal(typeof closed.closedAt, 'number');
  await f.caller.peer.error(MessageType.SELECTOR_RESPOND, { id: selectorId, value: 'a' }, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  await f.caller.peer.error(MessageType.BOT_SCREEN_ACTION, { ...action, actionId: 'after-revocation' },
    ProtocolErrorCode.BOT_SCREEN_NOT_FOUND);
  await f.approve(requested);
  bot = await f.connectBot();
  await bot.peer.request(MessageType.COMMAND_REGISTER, declaration);
  await f.caller.peer.error(MessageType.SELECTOR_RESPOND, { id: selectorId, value: 'a' }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
  assert.deepEqual((await f.caller.peer.request(MessageType.BOT_SCREEN_LIST, { channelId: f.voiceId })).payload.screens, []);
  await bot.peer.barrier();
  assert.equal(bot.peer.messages.some((message) =>
    message.type === MessageType.SELECTOR_RESPONDED || message.type === MessageType.BOT_SCREEN_ACTION_EVENT), false);
});

test('install previews bind identity, requests and administrator session before issuing a token', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Manifest owner');
  const otherDevice = await f.human('Manifest owner', owner.keys);
  const keys = identity();
  let requestedCapabilities: BotCapability[] | undefined = ['send_messages'];
  let registrations = 0;
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    if (request.url === '/manifest') {
      response.end(JSON.stringify({ name: 'Manifest bot', requestedCapabilities, registrationUrl: `http://127.0.0.1:${address.port}/register` }));
    } else {
      registrations++;
      request.resume();
      response.end(JSON.stringify({ publicKey: keys.publicKey }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const manifestUrl = `http://127.0.0.1:${address.port}/manifest`;
  const preview = async () => {
    const result = await owner.peer.request(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl });
    assert.equal(result.type, MessageType.BOT_INSTALL_PREVIEW_RESULT);
    return text(result.payload.previewId);
  };
  let previewId = await preview();
  await otherDevice.peer.error(MessageType.BOT_INSTALL, { previewId, grantedCapabilities: ['send_messages'] }, ProtocolErrorCode.BOT_MANIFEST_CHANGED);
  requestedCapabilities = ['send_messages', 'publish_voice'];
  await owner.peer.error(MessageType.BOT_INSTALL, { previewId, grantedCapabilities: ['send_messages'] }, ProtocolErrorCode.BOT_MANIFEST_CHANGED);
  assert.equal(registrations, 0);
  assert.equal(await f.botRepo.count(), 0);
  previewId = await preview();
  await owner.peer.error(MessageType.BOT_INSTALL, { previewId, grantedCapabilities: ['read_messages'] }, ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  previewId = await preview();
  const installed = await owner.peer.request(MessageType.BOT_INSTALL, { previewId, grantedCapabilities: ['send_messages'] });
  assert.equal(installed.type, MessageType.BOT_INSTALLED);
  const botId = text(record(installed.payload.bot).id);
  assert.deepEqual(f.botPermissions.get(botId)?.granted, ['send_messages']);
  assert.equal(f.botPermissions.get(botId)?.reviewedBy, owner.id);
  assert.equal(registrations, 1);
  await owner.peer.error(MessageType.BOT_INSTALL, { previewId, grantedCapabilities: ['send_messages'] }, ProtocolErrorCode.BOT_MANIFEST_CHANGED);
  requestedCapabilities = undefined;
  await owner.peer.error(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl }, ProtocolErrorCode.BOT_CAPABILITIES_INVALID);
  assert.equal(registrations, 1);
});

test('bot manifests and registration replies are read with a ceiling and never follow redirects', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Bounded owner');
  const keys = identity();
  let redirectedHits = 0;
  let streamedBytes = 0;
  let registrationReply: 'redirect' | 'oversized' | 'valid' = 'redirect';
  const server = http.createServer((request, response) => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const manifest = JSON.stringify({ name: 'Bounded bot', requestedCapabilities: ['commands'], registrationUrl: `${base}/register` });
    if (request.url === '/elsewhere') {
      redirectedHits++;
      request.resume();
      response.setHeader('Content-Type', 'application/json');
      response.end(request.method === 'POST' ? JSON.stringify({ publicKey: keys.publicKey }) : manifest);
    } else if (request.url === '/redirect') {
      response.writeHead(302, { Location: `${base}/elsewhere` });
      response.end();
    } else if (request.url === '/tls-redirect') {
      // What Caddy answers on http:// by default, with a body to make sure it is not read.
      response.writeHead(308, { Location: `https://127.0.0.1:${address.port}/elsewhere`, 'Content-Type': 'text/html' });
      response.end('<a href="https://127.0.0.1/elsewhere">Permanent Redirect</a>');
    } else if (request.url === '/streamed') {
      // Far more than any manifest may hold, with no declared length.
      response.writeHead(200, { 'Content-Type': 'application/json' });
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      const pump = (): void => {
        while (!response.destroyed && streamedBytes < 64 * 1024 * 1024) {
          streamedBytes += chunk.length;
          if (!response.write(chunk)) {
            response.once('drain', pump);
            return;
          }
        }
        response.end();
      };
      pump();
    } else if (request.url === '/declared') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(20 * 1024 * 1024) });
      response.write('{');
    } else if (request.url === '/manifest') {
      response.setHeader('Content-Type', 'application/json');
      response.end(manifest);
    } else if (request.url === '/register') {
      request.resume();
      if (registrationReply === 'redirect') {
        // 307 keeps the method and body, so following it would deliver the token elsewhere.
        response.writeHead(307, { Location: `${base}/elsewhere` });
        response.end();
        return;
      }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(registrationReply === 'valid'
        ? { publicKey: keys.publicKey } : { publicKey: keys.publicKey, padding: 'x'.repeat(8 * 1024) }));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  for (const target of ['/redirect', '/tls-redirect']) {
    const redirected = await owner.peer.request(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl: `${base}${target}` });
    assert.equal(redirected.type, MessageType.SERVER_ERROR, target);
    assert.equal(redirected.payload.code, ProtocolErrorCode.BAD_REQUEST, target);
    const message = text(redirected.payload.message);
    assert.match(message, /redireciona/, `${target}: a redirect is explained as such, not as a connection failure`);
    assert.doesNotMatch(message, /firewall|porta/, target);
    assert.doesNotMatch(message, /30[278]|elsewhere|127\.0\.0\.1/, `${target}: neither the status nor the target is echoed`);
  }
  assert.equal(redirectedHits, 0, 'The manifest request never follows a redirect');
  const failedStatus = await owner.peer.request(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl: `${base}/missing` });
  assert.equal(failedStatus.type, MessageType.SERVER_ERROR);
  assert.doesNotMatch(text(failedStatus.payload.message), /404|HTTP/, 'The status of an arbitrary URL is only logged');

  await owner.peer.error(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl: `${base}/streamed` }, ProtocolErrorCode.BOT_INVALID_PROFILE);
  assert.ok(streamedBytes < 32 * 1024 * 1024, `The server stopped reading after ${streamedBytes} bytes`);
  const started = Date.now();
  await owner.peer.error(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl: `${base}/declared` }, ProtocolErrorCode.BOT_INVALID_PROFILE);
  assert.ok(Date.now() - started < 4_000, 'A declared oversized manifest is refused without waiting for it');

  const install = async () => {
    const preview = await owner.peer.request(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl: `${base}/manifest` });
    assert.equal(preview.type, MessageType.BOT_INSTALL_PREVIEW_RESULT);
    return owner.peer.request(MessageType.BOT_INSTALL, { previewId: preview.payload.previewId, grantedCapabilities: ['commands'] });
  };
  for (const reply of ['redirect', 'oversized'] as const) {
    registrationReply = reply;
    const failed = await install();
    assert.equal(failed.type, MessageType.SERVER_ERROR, reply);
    assert.doesNotMatch(text(failed.payload.message), /307|HTTP/);
    assert.equal(await f.botRepo.count(), 0, `A ${reply} registration reply leaves no bot account`);
  }
  assert.equal(redirectedHits, 0, 'The token never follows a redirect');
  registrationReply = 'valid';
  assert.equal((await install()).type, MessageType.BOT_INSTALLED);
});

test('the installed manifest URL reaches only bot managers whose client negotiated it', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const offer = createProtocolOffer('client');
  // A client built before `bot-manifest-url` offers every other feature and rejects unknown summary fields.
  const olderOffer = { ...offer, features: offer.features.filter((feature) => feature !== 'bot-manifest-url') };
  const olderSummary = botSettingsSummarySchema.omit({ manifestUrl: true });
  const connect = (name: string, keys = identity(), protocolOffer = offer) =>
    f.human(name, keys, randomUUID(), false, PROTOCOL_VERSION, protocolOffer);
  const owner = await connect('Manifest owner');
  const olderOwner = await connect('Manifest owner', owner.keys, olderOffer);
  const configurer = await connect('Manifest configurer');
  const member = await connect('Manifest member');
  const configRole = { id: randomUUID(), name: 'Configurators', color: null, position: 1,
    permissions: Permission.CONFIGURE_BOTS, isDefault: false, createdAt: Date.now() };
  await f.roleRepo.create(configRole);
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: configurer.id, roleId: configRole.id });
  await owner.peer.barrier();
  const keys = identity();
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    if (request.url === '/manifest') {
      response.end(JSON.stringify({ name: 'Manifest bot', requestedCapabilities: ['commands'], registrationUrl: `http://127.0.0.1:${address.port}/register` }));
    } else {
      request.resume();
      response.end(JSON.stringify({ publicKey: keys.publicKey }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const manifestUrl = `http://127.0.0.1:${address.port}/manifest`;
  const preview = await owner.peer.request(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl });
  assert.equal(preview.type, MessageType.BOT_INSTALL_PREVIEW_RESULT);
  const since = olderOwner.peer.messages.length;
  const installed = await owner.peer.request(MessageType.BOT_INSTALL, { previewId: preview.payload.previewId, grantedCapabilities: ['commands'] });
  assert.equal(installed.type, MessageType.BOT_INSTALLED);
  const botId = text(record(installed.payload.bot).id);
  assert.equal('manifestUrl' in record(installed.payload.bot), false, 'Bot listings never carry the manifest URL');
  assert.equal((await f.botRepo.findById(botId))?.manifestUrl, manifestUrl);

  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const linkedId = text(record(created.payload.bot).id);
  await f.bot(text(created.payload.token), identity(), 'Token bot');
  const summaries = async (peer = owner.peer) =>
    botSettingsListResponseSchema.parse((await peer.request(MessageType.BOT_SETTINGS_LIST, {})).payload).bots;
  const snapshot = async (peer = owner.peer, id = botId) =>
    botSettingsSnapshotSchema.parse((await peer.request(MessageType.BOT_SETTINGS_GET, { botId: id })).payload).bot;
  const listed = await summaries();
  assert.equal(listed.find((bot) => bot.botId === botId)?.manifestUrl, manifestUrl);
  assert.equal(listed.find((bot) => bot.botId === linkedId)?.manifestUrl, null, 'Token links have no recorded manifest');
  assert.equal((await snapshot()).manifestUrl, manifestUrl);
  assert.equal((await snapshot(owner.peer, linkedId)).manifestUrl, null);

  for (const peer of [configurer.peer, member.peer]) {
    for (const summary of [...await summaries(peer), await snapshot(peer)]) {
      assert.equal('manifestUrl' in summary, false, 'People who cannot manage bots never receive the URL');
    }
  }
  const olderSummaries: Record<string, unknown>[] = [...await summaries(olderOwner.peer), await snapshot(olderOwner.peer)];
  await olderOwner.peer.barrier();
  for (const message of olderOwner.peer.messages.slice(since)) {
    if (message.type === MessageType.BOT_SETTINGS_LIST_RESPONSE) olderSummaries.push(...records(message.payload.bots));
    if (message.type === MessageType.BOT_SETTINGS_SNAPSHOT) olderSummaries.push(record(message.payload.bot));
  }
  assert.ok(olderSummaries.length >= 4 && olderSummaries.some((summary) => summary.canManage === true));
  for (const summary of olderSummaries) {
    assert.equal(olderSummary.safeParse(summary).success, true, `A manager on an older client still parses ${JSON.stringify(summary)}`);
  }
});

test('bot installation preserves the connection endpoint and rejects remote loopback before issuing credentials', async t => {
  const cases: {
    name: string;
    headers?: Record<string, string>;
    path?: string;
    registrationUrl?: string;
    expectedUrl?: string;
    error?: 'loopback' | 'invalid';
  }[] = [
    { name: 'public hostname and external port', headers: { host: 'pc.example.test:4100' }, expectedUrl: 'ws://pc.example.test:4100/' },
    { name: 'bracketed IPv6', headers: { host: '[2001:db8::1]:4100' }, expectedUrl: 'ws://[2001:db8::1]:4100/' },
    {
      name: 'TLS proxy preserves path without trusting forwarded host',
      headers: { host: 'pc.example.test', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'not-the-server.invalid' },
      path: '/monky/ws?route=qa', expectedUrl: 'wss://pc.example.test/monky/ws?route=qa',
    },
    { name: 'TLS on an explicit nonstandard port', headers: { host: 'pc.example.test:80', 'x-forwarded-proto': 'https' }, expectedUrl: 'wss://pc.example.test:80/' },
    { name: 'co-located loopback remains supported' },
    { name: 'remote bot with a loopback server', registrationUrl: 'http://bot.example.test/register', error: 'loopback' },
    { name: 'trailing-dot localhost', headers: { host: 'localhost.:4100' }, registrationUrl: 'http://bot.example.test/register', error: 'loopback' },
    { name: 'IPv4-mapped loopback', headers: { host: '[::ffff:127.0.0.1]:4100' }, registrationUrl: 'http://bot.example.test/register', error: 'loopback' },
    { name: 'unspecified address', headers: { host: '0.0.0.0:4100' }, error: 'invalid' },
    { name: 'credentials in authority', headers: { host: 'user@pc.example.test' }, error: 'invalid' },
    { name: 'request target cannot replace authority', path: '//not-the-server.invalid', error: 'invalid' },
    { name: 'invalid forwarded protocol', headers: { host: 'pc.example.test', 'x-forwarded-proto': 'file' }, error: 'invalid' },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async t => {
      const f = await createFixture({ webSocketHeaders: entry.headers, webSocketPath: entry.path });
      t.after(() => f.dispose());
      const owner = await f.human('Address owner');
      const keys = identity();
      let registration: Record<string, unknown> | undefined;
      const manifest = http.createServer((request, response) => {
        response.setHeader('Content-Type', 'application/json');
        const address = manifest.address();
        assert.ok(address && typeof address === 'object');
        if (request.url === '/manifest') {
          response.end(JSON.stringify({
            name: 'Address bot', requestedCapabilities: ['commands'],
            registrationUrl: entry.registrationUrl ?? `http://127.0.0.1:${address.port}/register`,
          }));
          return;
        }
        let body = '';
        request.on('data', chunk => { body += chunk.toString(); });
        request.on('end', () => {
          registration = record(JSON.parse(body));
          response.end(JSON.stringify({ publicKey: keys.publicKey }));
        });
      });
      manifest.listen(0, '127.0.0.1');
      await once(manifest, 'listening');
      t.after(() => new Promise<void>((resolve, reject) => manifest.close(error => error ? reject(error) : resolve())));
      const address = manifest.address();
      assert.ok(address && typeof address === 'object');
      const preview = await owner.peer.request(MessageType.BOT_INSTALL_PREVIEW, {
        manifestUrl: `http://127.0.0.1:${address.port}/manifest`,
      });
      if (entry.error) {
        assert.equal(preview.type, MessageType.SERVER_ERROR);
        assert.equal(preview.payload.code, ProtocolErrorCode.BAD_REQUEST);
        assert.match(text(preview.payload.message), entry.error === 'loopback' ? /localhost/ : /endereço do servidor/);
        assert.equal(registration, undefined, 'A rejected address must not receive a token.');
        assert.equal(await f.botRepo.count(), 0, 'A rejected address must not leave a bot account.');
        return;
      }
      assert.equal(preview.type, MessageType.BOT_INSTALL_PREVIEW_RESULT);
      const result = await owner.peer.request(MessageType.BOT_INSTALL, {
        previewId: preview.payload.previewId, grantedCapabilities: ['commands'],
      });
      assert.equal(result.type, MessageType.BOT_INSTALLED);
      assert.ok(registration);
      assert.equal(registration.serverUrl, entry.expectedUrl ?? `${f.url}/`);
    });
  }
});

test('the bot dispatcher is closed by default and separates publication, privacy and local requests', () => {
  assert.deepEqual(botMessageCapabilities(MessageType.COMMAND_RESPONSE, { ephemeral: true }), ['commands']);
  assert.deepEqual(botMessageCapabilities(MessageType.COMMAND_RESPONSE, {}), ['commands']);
  assert.deepEqual(botMessageCapabilities(MessageType.COMMAND_RESPONSE, { ephemeral: false }), ['commands', 'send_messages']);
  assert.deepEqual(botMessageCapabilities(MessageType.CHAT_SEND, { replyToMessageId: 'message' }), ['send_messages', 'read_messages']);
  assert.deepEqual(botMessageCapabilities(MessageType.BOT_LOCAL_TASK_REQUEST, {}), ['local_execution']);
  assert.deepEqual(botMessageCapabilities(MessageType.COMMAND_SOUND_DOWNLOAD, {}), ['commands', 'sound_download']);
  assert.deepEqual(botMessageCapabilities(MessageType.SFU_CONSUME, {}), ['receive_voice']);
  assert.deepEqual(botMessageCapabilities(MessageType.VOICE_JOIN, { receiveAudio: true }), ['receive_voice']);
  assert.deepEqual(botMessageCapabilities(MessageType.VOICE_JOIN, {}), ['publish_voice']);
  assert.equal(botMessageCapabilities(MessageType.BOT_LOCAL_TASK_ACCEPT, {}), undefined);
  assert.equal(botMessageCapabilities(MessageType.ROLE_ASSIGN, {}), undefined);
});

test('installation stays powerless during registration and rejects runtime declaration or administrator races', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Registration owner');
  const manager = await f.human('Registration manager');
  const role = await owner.peer.request(MessageType.ROLE_CREATE, { name: 'Bot installation', permissions: Permission.MANAGE_BOTS });
  const roleId = text(records(role.payload.roles).find((entry) => entry.name === 'Bot installation')?.id);
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: manager.id, roleId });
  const channels = records(record(owner.auth.payload.server).channels);
  const channelId = text(channels.find((channel) => channel.type === 'TEXT')?.id);
  interface Registration {
    token: string;
    keys: ReturnType<typeof identity>;
    respond: () => void;
  }
  const queued: Registration[] = [];
  const responses = new Set<http.ServerResponse>();
  let waiting: ((registration: Registration) => void) | undefined;
  let requests = 0;
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    if (request.url === '/manifest') {
      response.end(JSON.stringify({
        name: 'Registration bot', requestedCapabilities: ['send_messages'],
        registrationUrl: `http://127.0.0.1:${address.port}/register`,
      }));
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      requests++;
      responses.add(response);
      const keys = identity();
      const registration: Registration = {
        token: text(record(JSON.parse(body)).token),
        keys,
        respond: () => {
          responses.delete(response);
          response.end(JSON.stringify({ publicKey: keys.publicKey }));
        },
      };
      if (waiting) { const resolve = waiting; waiting = undefined; resolve(registration); }
      else queued.push(registration);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const response of responses) response.end('{}');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const manifestUrl = `http://127.0.0.1:${address.port}/manifest`;
  const registration = async (): Promise<Registration> => {
    const ready = queued.shift();
    if (ready) return ready;
    return new Promise((resolve) => { waiting = resolve; });
  };
  const preview = async (peer = owner.peer) => {
    const result = await peer.request(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl });
    assert.equal(result.type, MessageType.BOT_INSTALL_PREVIEW_RESULT);
    return { previewId: text(result.payload.previewId), grantedCapabilities: ['send_messages'] };
  };

  let install = owner.peer.request(MessageType.BOT_INSTALL, await preview());
  let pending = await registration();
  let bot = await f.bot(pending.token, pending.keys);
  const botId = text(record(bot.auth.payload.currentUser).id);
  assert.deepEqual(f.botPermissions.get(botId)?.granted, []);
  assert.equal((await bot.peer.request(MessageType.COMMAND_REGISTER,
    { requestedCapabilities: ['send_messages'], commands: [] })).type, MessageType.COMMAND_REGISTERED);
  await bot.peer.error(MessageType.CHAT_SEND, { channelId, content: 'Not approved during registration' },
    ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  pending.respond();
  assert.equal((await install).type, MessageType.BOT_INSTALLED);
  assert.deepEqual(f.botPermissions.get(botId)?.granted, ['send_messages']);
  assert.equal((await bot.peer.request(MessageType.CHAT_SEND, { channelId, content: 'Approved after registration' })).type,
    MessageType.CHAT_MESSAGE);

  install = owner.peer.request(MessageType.BOT_INSTALL, await preview());
  pending = await registration();
  bot = await f.bot(pending.token, pending.keys);
  const changedId = text(record(bot.auth.payload.currentUser).id);
  const closed = once(bot.peer.ws, 'close');
  bot.peer.send(MessageType.COMMAND_REGISTER,
    { requestedCapabilities: ['send_messages', 'publish_voice'], commands: [] });
  await closed;
  pending.respond();
  const changed = await install;
  assert.equal(changed.type, MessageType.SERVER_ERROR);
  assert.equal(changed.payload.code, ProtocolErrorCode.BOT_MANIFEST_CHANGED);
  assert.equal(await f.botRepo.findById(changedId), null);
  assert.equal(f.botPermissions.get(changedId), undefined);

  install = manager.peer.request(MessageType.BOT_INSTALL, await preview(manager.peer));
  pending = await registration();
  await owner.peer.request(MessageType.ROLE_UPDATE, { roleId, permissions: 0 });
  pending.respond();
  const denied = await install;
  assert.equal(denied.type, MessageType.SERVER_ERROR);
  assert.equal(denied.payload.code, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal(await f.botRepo.count(), 1, 'neither failed registration may leave an approved account');
  assert.equal(requests, 3);

  const expiring = await owner.peer.request(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl });
  const expiredAt = expiring.payload.expiresAt;
  assert.equal(typeof expiredAt, 'number');
  assert.ok(typeof expiredAt === 'number');
  const clock = t.mock.method(Date, 'now', () => expiredAt + 1);
  try {
    await owner.peer.error(MessageType.BOT_INSTALL, {
      previewId: expiring.payload.previewId, grantedCapabilities: ['send_messages'],
    }, ProtocolErrorCode.BOT_MANIFEST_CHANGED);
  } finally {
    clock.mock.restore();
  }
  assert.equal(requests, 3, 'an expired preview must not issue another token');
});
