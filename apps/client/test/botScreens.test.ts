import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOT_SCREEN_LIMITS, MessageType, ProtocolErrorCode, type BotScreen, type BotScreenRemoved, type SlashCommand, type VoiceParticipantState } from '@monky/shared';
import { EventBus, appEvents } from '../src/renderer/core/EventBus';
import { sessionManager, type ServerSession } from '../src/renderer/core/SessionManager';
import { bindBotScreenEvents } from '../src/renderer/core/botScreenEvents';
import { BotScreenStore, type VoiceBotScreensUpdated } from '../src/renderer/stores/botScreenStore';
import { isForegroundEvent, routeSessionEvent } from '../src/renderer/core/sessionRouting';
import { botScreenDocument } from '../src/renderer/views/BotScreenFrame';
import { voiceStore } from '../src/renderer/stores/voiceStore';
import { commandVoiceError, commandVoiceContextKey, getBotVoiceContext } from '../src/renderer/utils/botVoice';

const snapshot = (id = 'game', revision = 0): BotScreen => ({
  id, instanceId: `${id}-instance`, creatorUserId: 'alice', botId: 'bot', channelId: 'voice', title: 'Game', html: '<script>play()</script>',
  state: { count: revision }, revision, createdAt: 0,
});
const removal = (id = 'game', channelId = 'voice', instanceId = `${id}-instance`): BotScreenRemoved => ({
  id, instanceId, channelId, reason: 'ended', endedByUserId: 'alice',
});

test('screen stores preserve revisions, bind channel ownership and have a finite cache', () => {
  const store = new BotScreenStore();
  store.bus = new EventBus();
  let changes = 0;
  store.bus.on('bot.screens_updated', () => { changes++; });
  store.upsert(snapshot('game', 2));
  store.upsert(snapshot('game', 1));
  store.upsert({ ...snapshot('game', 3), channelId: 'other' });
  assert.equal(store.get('game')?.revision, 2);
  assert.equal(changes, 1);
  for (let i = 0; i < BOT_SCREEN_LIMITS.activePerServer + 10; i++) store.upsert(snapshot(`screen-${i}`));
  assert.equal(store.list('voice').length, BOT_SCREEN_LIMITS.activePerServer);
  store.replace('voice', [snapshot('restored', 4)]);
  assert.deepEqual(store.list('voice').map((screen) => screen.id), ['restored']);
  store.remove(removal('restored', 'other'));
  assert.ok(store.get('restored'));
  store.remove(removal('restored'));
  assert.equal(store.list('voice').length, 0);
});

test('explicit local exit dismisses only that invitation until reopening or ending its voice lifetime', () => {
  const store = new BotScreenStore();
  const other = new BotScreenStore();
  store.upsert(snapshot('game', 2));
  other.upsert(snapshot('game', 2));
  const version = store.version;
  store.setInvitationDismissed('game', true);
  assert.equal(store.isInvitationDismissed('game'), true);
  assert.equal(other.isInvitationDismissed('game'), false, 'same IDs on another server are independent');
  assert.equal(store.version, version, 'local exit does not invalidate a pending authoritative list');
  assert.deepEqual(store.get('game')?.state, { count: 2 }, 'local exit never changes bot-owned state');
  store.upsert(snapshot('game', 3));
  store.replace('voice', [snapshot('game', 4), snapshot('new')]);
  assert.equal(store.isInvitationDismissed('game'), true, 'snapshots and list refreshes preserve the exit');
  assert.equal(store.isInvitationDismissed('new'), false, 'another app still invites normally');
  store.remove(removal('game', 'wrong-room'));
  assert.equal(store.isInvitationDismissed('game'), true);
  store.setInvitationDismissed('game', false);
  assert.equal(store.isInvitationDismissed('game'), false, 'explicit reopening reverses the local exit');
  store.setInvitationDismissed('game', true);
  store.remove(removal());
  assert.equal(store.isInvitationDismissed('game'), false);
  store.setInvitationDismissed('new', true);
  store.replace('voice', []);
  assert.equal(store.isInvitationDismissed('new'), false, 'removed snapshots release local preference state');
  store.upsert(snapshot());
  store.setInvitationDismissed('game', true);
  for (let i = 0; i < BOT_SCREEN_LIMITS.activePerServer; i++) store.upsert(snapshot(`evict-${i}`));
  assert.equal(store.isInvitationDismissed('game'), false, 'cache eviction releases local preference state');
  store.setInvitationDismissed('evict-0', true);
  store.clear();
  assert.equal(store.isInvitationDismissed('evict-0'), false, 'leaving voice starts a fresh invitation lifetime');
  store.setInvitationDismissed('absent', true);
  assert.equal(store.isInvitationDismissed('absent'), false);
});

test('reusing a miniapp ID starts a fresh invitation and stale removals cannot destroy it', () => {
  const store = new BotScreenStore();
  store.upsert(snapshot('game', 5));
  store.setInvitationDismissed('game', true);
  const replacement = { ...snapshot(), instanceId: 'replacement', createdAt: 1 };
  store.upsert(replacement);
  assert.equal(store.get('game')?.revision, 0);
  assert.equal(store.isInvitationDismissed('game'), false);
  store.remove(removal());
  store.upsert(snapshot('game', 99));
  assert.deepEqual(store.get('game'), replacement);
  store.setInvitationDismissed('game', true);
  store.replace('voice', [{ ...replacement, instanceId: 'third-instance', createdAt: 2 }]);
  assert.equal(store.isInvitationDismissed('game'), false);
  store.remove(removal('game', 'voice', 'third-instance'));
  assert.equal(store.get('game'), undefined);
});

test('screen init JSON cannot break out into the trusted or author script document', () => {
  const document = botScreenDocument({ ...snapshot(), state: { text: '</script><script>ESCAPE()</script>' } }, { id: 'alice', nickname: '</script>', locale: 'en' });
  assert.equal(document.includes('<script>ESCAPE()'), false);
  assert.ok(document.includes('\\u003c/script>'));
  assert.ok(document.includes("default-src 'none'"));
  assert.ok(document.includes("connect-src 'none'"));
  assert.ok(document.includes('"locale":"en"'));
});

test('viewer updates describe only the exact removed instance and never replay duplicate notices', () => {
  const store = new BotScreenStore('toast-lifetime');
  store.bus = new EventBus();
  voiceStore.setChannel('voice', 'toast-lifetime');
  const updates: VoiceBotScreensUpdated[] = [];
  const off = appEvents.on<VoiceBotScreensUpdated>('voice.bot_screens_updated', (update) => updates.push(update));
  try {
    store.upsert(snapshot());
    assert.equal(updates.at(-1)?.removed, undefined);
    const ended = removal();
    store.remove(ended);
    assert.deepEqual(updates.at(-1), { key: 'toast-lifetime', channelId: 'voice', removed: ended });
    const version = store.version;
    store.remove(ended);
    assert.equal(store.version, version + 1, 'duplicate removals still invalidate pending lists');
    assert.equal(updates.at(-1)?.removed, undefined, 'an unseen or duplicate removal is not a new viewer notice');
    store.upsert({ ...snapshot(), instanceId: 'replacement', createdAt: 1 });
    const count = updates.length;
    store.remove(ended);
    assert.equal(updates.length, count, 'an old instance cannot notify about its replacement');
    store.clear();
    assert.equal(updates.at(-1)?.removed, undefined, 'disconnect and view reset are not human END notices');
  } finally {
    off();
    voiceStore.reset();
  }
});

function voiceState(sessionId: string, userId = 'alice', channelId = 'voice'): VoiceParticipantState {
  return {
    sessionId, userId, channelId, isMuted: false, isDeafened: false, isSpeaking: false,
    isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false, serverMuted: false, serverDeafened: false,
  };
}

function seed(session: ServerSession): void {
  const user = { id: 'alice', clientId: 'alice', sessionId: `${session.key}:device`, nickname: 'Alice', status: 'ONLINE' as const, joinedAt: 1 };
  session.serverStore.setServerDetails({
    id: session.key, name: 'Server', createdAt: 1, maxUsers: 10, members: [user], voiceStates: {},
    channels: ['voice', 'other'].map((id) => ({
      id, serverId: session.key, name: id, type: 'VOICE', position: 0, createdAt: 1,
      botCommandsEnabled: false, isPrivate: false, allowedRoleIds: [],
    })),
    myPermissions: 0xffffffff,
  }, user);
  session.participants.addUser(user);
  session.participants.updateVoiceState(voiceState(user.sessionId));
}

test('background voice snapshots notify global UI only after restoring the visible server', async (testContext) => {
  sessionManager.install();
  const a = sessionManager.create('screens-a', 7800, 'alice');
  const b = sessionManager.create('screens-b', 7800, 'alice');
  seed(a); seed(b);
  testContext.mock.method(a.client, 'getStatus', () => 'CONNECTED');
  testContext.mock.method(b.client, 'getStatus', () => 'CONNECTED');
  testContext.mock.method(b.client, 'sendRequest', async () => ({ channelId: 'voice', screens: [] }));
  sessionManager.activate(a.key);
  voiceStore.setChannel('voice', b.key);
  const unbind = bindBotScreenEvents();
  await Promise.resolve(); await Promise.resolve();
  let repaints = 0;
  const off = appEvents.on('voice.bot_screens_updated', () => {
    repaints++;
    assert.equal(isForegroundEvent(), true);
    assert.equal(sessionManager.getActive(), a);
  });
  try {
    routeSessionEvent(b.key, `message.${MessageType.BOT_SCREEN_SNAPSHOT}`, () =>
      appEvents.emit(`message.${MessageType.BOT_SCREEN_SNAPSHOT}`, snapshot()));
    assert.equal(a.botScreenStore.list('voice').length, 0);
    assert.equal(b.botScreenStore.list('voice').length, 1);
    assert.equal(repaints, 0);
    await Promise.resolve();
    assert.equal(repaints, 1);
    const captured = a.botScreenStore;
    captured.upsert(snapshot('late-a'));
    assert.equal(repaints, 1);
    assert.equal(b.botScreenStore.get('late-a'), undefined);
    routeSessionEvent(b.key, `message.${MessageType.BOT_SCREEN_REMOVED}`, () =>
      appEvents.emit(`message.${MessageType.BOT_SCREEN_REMOVED}`, removal()));
    await Promise.resolve();
    assert.equal(repaints, 2);
    assert.equal(b.botScreenStore.list('voice').length, 0);
  } finally {
    off(); unbind(); voiceStore.reset(); await sessionManager.removeAll();
  }
});

test('end of an unseen instance invalidates an in-flight room list before it can restore an invitation', async (testContext) => {
  sessionManager.install();
  const session = sessionManager.create('end-before-list', 7800, 'alice');
  seed(session);
  testContext.mock.method(session.client, 'getStatus', () => 'CONNECTED');
  let finishList: (value: unknown) => void = () => { throw new Error('No pending list.'); };
  let requests = 0;
  testContext.mock.method(session.client, 'sendRequest', () => {
    requests++;
    return requests === 1 ? new Promise((resolve) => { finishList = resolve; })
      : Promise.resolve({ channelId: 'voice', screens: [] });
  });
  sessionManager.activate(session.key);
  voiceStore.setChannel('voice', session.key);
  const unbind = bindBotScreenEvents();
  try {
    assert.equal(requests, 1);
    routeSessionEvent(session.key, `message.${MessageType.BOT_SCREEN_REMOVED}`, () =>
      appEvents.emit(`message.${MessageType.BOT_SCREEN_REMOVED}`, removal()));
    finishList({ channelId: 'voice', screens: [snapshot()] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(requests, 2);
    assert.equal(session.botScreenStore.get('game'), undefined);
    assert.equal(session.botScreenStore.isInvitationDismissed('game'), false);
  } finally {
    unbind(); voiceStore.reset(); await sessionManager.removeAll();
  }
});

test('voice-required commands authorize the originating device and bot room, not active text or account presence', async (testContext) => {
  const a = sessionManager.create('command-a', 7800, 'alice');
  const b = sessionManager.create('command-b', 7800, 'alice');
  seed(a); seed(b);
  testContext.mock.method(a.client, 'getStatus', () => 'CONNECTED');
  testContext.mock.method(b.client, 'getStatus', () => 'CONNECTED');
  const command: SlashCommand = { botId: 'bot', botName: 'Bot', name: 'arbitrary-name', description: '', voiceRequirement: 'same-bot-channel' };
  try {
    voiceStore.reset();
    assert.equal(commandVoiceError(command, a.client, a.serverStore), ProtocolErrorCode.BOT_VOICE_REQUIRED);
    voiceStore.setChannel('voice', a.key);
    sessionManager.activate(b.key);
    assert.equal(commandVoiceError(command, a.client, a.serverStore), undefined, 'a bot outside voice can be summoned');
    assert.equal(commandVoiceError(command, b.client, b.serverStore), ProtocolErrorCode.BOT_VOICE_REQUIRED);
    const before = commandVoiceContextKey(command, a.client, a.serverStore);
    a.participants.addUser({ id: 'bot', clientId: 'bot', sessionId: 'bot-device', nickname: 'Bot', status: 'ONLINE', joinedAt: 1, isBot: true });
    a.participants.updateVoiceState(voiceState('bot-device', 'bot'));
    assert.equal(commandVoiceContextKey(command, a.client, a.serverStore), before,
      'A bot joining the authorized room must not invalidate the selected music while its command is being confirmed.');
    a.participants.updateVoiceState(voiceState('bot-device', 'bot', 'other'));
    assert.equal(commandVoiceError(command, a.client, a.serverStore), ProtocolErrorCode.BOT_VOICE_CHANNEL_MISMATCH);
    assert.notEqual(commandVoiceContextKey(command, a.client, a.serverStore), before);
    assert.equal(commandVoiceError({ ...command, voiceRequirement: 'joined' }, a.client, a.serverStore), undefined);
    a.participants.updateVoiceState(voiceState('bot-device', 'bot'));
    assert.equal(commandVoiceError(command, a.client, a.serverStore), undefined);
    a.participants.removeVoiceState(a.serverStore.currentUser!.sessionId!);
    a.participants.addUser({ ...a.serverStore.currentUser!, sessionId: 'other-device' });
    a.participants.updateVoiceState(voiceState('other-device'));
    assert.equal(getBotVoiceContext(), null);
    assert.equal(commandVoiceError(command, a.client, a.serverStore), ProtocolErrorCode.BOT_VOICE_REQUIRED);
    assert.equal(commandVoiceError({ ...command, voiceRequirement: undefined }, a.client, a.serverStore), undefined);
  } finally {
    voiceStore.reset(); await sessionManager.removeAll();
  }
});
