import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { BOT_SCREEN_LIMITS, BOT_SCREEN_PERMISSION_POLICY_VERSION, botScreenDocumentConsentSchema, MessageType, ProtocolErrorCode, type BotScreen, type BotScreenBridge, type BotScreenDocumentConsent, type BotScreenRemoved, type SlashCommand, type VoiceParticipantState } from '@monky/shared';
import { EventBus, appEvents } from '../src/renderer/core/EventBus';
import { sessionManager, type ServerSession } from '../src/renderer/core/SessionManager';
import { bindBotScreenEvents } from '../src/renderer/core/botScreenEvents';
import { BotScreenStore, type VoiceBotScreensUpdated } from '../src/renderer/stores/botScreenStore';
import { isForegroundEvent, routeSessionEvent } from '../src/renderer/core/sessionRouting';
import { BotScreenFrame, botScreenDocument } from '../src/renderer/views/BotScreenFrame';
import { installMiniappStorage, miniappStorageResult, readMiniappStorageRequest } from '../src/renderer/views/botScreenStorage';
import { voiceStore } from '../src/renderer/stores/voiceStore';
import { commandVoiceError, commandVoiceContextKey, getBotVoiceContext } from '../src/renderer/utils/botVoice';

const snapshot = (id = 'game', revision = 0): BotScreen => ({
  id, instanceId: `${id}-instance`, creatorUserId: 'alice', botId: 'bot', channelId: 'voice', title: 'Game', html: '<script>play()</script>',
  state: { count: revision }, revision, createdAt: 0,
});
const removal = (id = 'game', channelId = 'voice', instanceId = `${id}-instance`): BotScreenRemoved => ({
  id, instanceId, channelId, reason: 'ended', endedByUserId: 'alice',
});

test('miniapp consent requires the current policy and exact bot/screen instance before any document creation', () => {
  const consent: BotScreenDocumentConsent = {
    policyVersion: BOT_SCREEN_PERMISSION_POLICY_VERSION, serverKey: 'server',
    botId: 'bot', screenId: 'game', instanceId: 'game-instance',
  };
  assert.deepEqual(botScreenDocumentConsentSchema.parse(consent), consent);
  for (const invalid of [
    undefined, null, {}, { ...consent, policyVersion: 0 },
    { ...consent, serverKey: '' }, { ...consent, instanceId: '' }, { ...consent, allowEverything: true },
  ]) assert.equal(botScreenDocumentConsentSchema.safeParse(invalid).success, false);
  for (const field of ['botId', 'screenId', 'instanceId'] as const) {
    assert.throws(() => new BotScreenFrame(snapshot(), { id: 'alice', nickname: 'Alice', locale: 'en' },
      { ...consent, [field]: 'another-instance' }, () => {}, () => {}), /consent does not match/);
  }
});

test('storage consent is optional and can only address the bot that owns the miniapp', () => {
  const consent: BotScreenDocumentConsent = {
    policyVersion: BOT_SCREEN_PERMISSION_POLICY_VERSION, serverKey: 'server',
    botId: 'bot', screenId: 'game', instanceId: 'game-instance',
  };
  const scope = {
    serverUrl: 'wss://monky.example/ws', serverId: 'server-id', serverName: 'Server', userId: 'alice', botId: 'bot', botName: 'Bot',
  };
  for (const grant of ['none', 'session', 'always'] as const) {
    assert.equal(botScreenDocumentConsentSchema.safeParse({ ...consent, storage: { scope, grant } }).success, true, grant);
  }
  for (const storage of [
    { scope: { ...scope, botId: 'another-bot' }, grant: 'always' },
    { scope, grant: 'forever' },
    { scope: { ...scope, serverUrl: 'https://monky.example' }, grant: 'session' },
    { scope, grant: 'session', path: '/etc' },
  ]) assert.equal(botScreenDocumentConsentSchema.safeParse({ ...consent, storage }).success, false, JSON.stringify(storage));
});

test('miniapp storage requests are validated before they reach the main process', () => {
  assert.deepEqual(readMiniappStorageRequest({ type: 'storage', id: 1, op: 'get', key: 'nes/game/slot-1' }),
    { id: 1, request: { op: 'get', key: 'nes/game/slot-1' } });
  assert.deepEqual(readMiniappStorageRequest({ type: 'storage', id: 2, op: 'list', prefix: 'nes/' }),
    { id: 2, request: { op: 'list', prefix: 'nes/' } });
  const bytes = readMiniappStorageRequest({
    type: 'storage', id: 3, op: 'set', key: 'nes/game/auto', value: { kind: 'bytes', bytes: new Uint8Array([1, 2, 3]).buffer }, autosave: true,
  });
  assert.ok(bytes?.request.op === 'set' && bytes.request.value.kind === 'bytes' && bytes.request.autosave);
  assert.deepEqual([...bytes.request.value.bytes], [1, 2, 3]);
  for (const invalid of [
    null, 'storage', { type: 'storage', op: 'usage' }, { type: 'storage', id: 0, op: 'usage' }, { type: 'storage', id: 1.5, op: 'usage' },
    { type: 'storage', id: 4, op: 'drop' }, { type: 'storage', id: 4, op: 'get', key: '' }, { type: 'storage', id: 4, op: 'get', key: 'a/../b' },
    { type: 'storage', id: 4, op: 'get', key: '/etc/passwd' }, { type: 'storage', id: 4, op: 'get', key: 'a', scope: 'other-bot' },
    { type: 'storage', id: 4, op: 'set', key: 'a', value: { kind: 'text', text: 'x' } },
    { type: 'storage', id: 4, op: 'set', key: 'a', value: { kind: 'bytes', bytes: [1, 2] }, autosave: false },
    { type: 'storage', id: 4, op: 'set', key: 'a', value: { kind: 'text', text: 'x'.repeat(4 * 1024 * 1024 + 1) }, autosave: false },
  ]) assert.equal(readMiniappStorageRequest(invalid), null, JSON.stringify(invalid)?.slice(0, 120));
});

test('storage answers copy bytes for the document and expose only the usage it needs', () => {
  const usage = { usedBytes: 3, maxBytes: 1024 * 1024, objectCount: 1, maxObjects: 1000, level: 'ok' } as const;
  const source = new Uint8Array([7, 8, 9]);
  const { message, transfer } = miniappStorageResult(5, { ok: true, op: 'get', value: { kind: 'bytes', bytes: source }, usage });
  assert.equal(transfer.length, 1);
  assert.notEqual(transfer[0], source.buffer, 'The main-process buffer is never handed to the miniapp');
  assert.deepEqual(message, { type: 'storage-result', id: 5, ok: true, value: { kind: 'bytes', bytes: transfer[0] }, usage: { usedBytes: 3, maxBytes: 1024 * 1024, level: 'ok' } });
  assert.deepEqual(miniappStorageResult(6, { ok: false, reason: 'quota', usage }).message,
    { type: 'storage-result', id: 6, ok: false, reason: 'quota', usage: { usedBytes: 3, maxBytes: 1024 * 1024, level: 'ok' } });
  assert.deepEqual(miniappStorageResult(7, { ok: false, reason: 'denied', usage: null }).message,
    { type: 'storage-result', id: 7, ok: false, reason: 'denied', usage: null });
});

test('monkyScreen.storage waits for permission, and autosaves never interrupt the miniapp', async () => {
  const bridge = installMiniappStorage(8);
  const storage = bridge.api;
  const statuses: string[] = [];
  const off = storage.onStatus((status) => statuses.push(status));
  await assert.rejects(storage.get('slot'), { name: 'MonkyStorageError', reason: 'unavailable' });
  assert.equal(await storage.set('auto', 'state', { autosave: true }), false, 'No answer yet: the autosave is skipped');
  const channel = new MessageChannel();
  const sent: Array<Record<string, unknown>> = [];
  channel.port2.onmessage = (event: MessageEvent<Record<string, unknown>>) => { sent.push(event.data); };
  const next = async (): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 100 && !sent.length; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
    const message = sent.shift();
    assert.ok(message, 'The bridge posted a request');
    return message;
  };
  try {
    bridge.attach(channel.port1);
    assert.equal(bridge.receive({ type: 'storage-status', status: 'denied' }), true);
    await assert.rejects(storage.get('slot'), { reason: 'denied' });
    assert.equal(bridge.receive({ type: 'storage-status', status: 'granted' }), true);
    assert.equal(bridge.receive({ type: 'state', state: {}, revision: 1 }), false, 'Other messages are left to the bootstrap');
    assert.deepEqual(statuses, ['unavailable', 'denied', 'granted']);
    assert.equal(storage.status, 'granted');

    const original = new Uint8Array([1, 2, 3]);
    const saving = storage.set('slot', original);
    const request = await next();
    assert.equal(request.type, 'storage');
    assert.equal(request.op, 'set');
    assert.equal(request.key, 'slot');
    assert.equal(request.autosave, false);
    assert.deepEqual(original, new Uint8Array([1, 2, 3]), 'Sending never detaches the buffer of the miniapp');
    bridge.receive({ type: 'storage-result', id: request.id, ok: true, usage: null });
    assert.equal(await saving, true);

    const autosave = storage.set('auto', 'state', { autosave: true });
    const autosaveRequest = await next();
    bridge.receive({ type: 'storage-result', id: autosaveRequest.id, ok: false, reason: 'quota', usage: null });
    assert.equal(await autosave, false, 'A full storage pauses autosaves silently');
    const manual = storage.set('slot', 'state');
    const manualRequest = await next();
    bridge.receive({ type: 'storage-result', id: manualRequest.id, ok: false, reason: 'quota', usage: null });
    await assert.rejects(manual, { reason: 'quota' }, 'A save the person asked for reports the failure');

    await assert.rejects(storage.set('slot', 'more than eight bytes'), { reason: 'too_large' });
    assert.equal(await storage.set('slot', 'more than eight bytes', { autosave: true }), false);
    // @ts-expect-error The type rules this out; plain-JS miniapps still get a TypeError.
    await assert.rejects(storage.set('slot', { not: 'bytes' }), TypeError);

    const reading = storage.get('slot');
    const read = await next();
    const bytes = new Uint8Array([4, 5]).buffer;
    bridge.receive({ type: 'storage-result', id: read.id, ok: true, value: { kind: 'bytes', bytes }, usage: null });
    assert.equal(await reading, bytes);
    const listing = storage.list();
    const list = await next();
    bridge.receive({ type: 'storage-result', id: list.id, ok: true, keys: [{ key: 'slot', sizeBytes: 2, updatedAt: 1 }], usage: null });
    assert.deepEqual(await listing, [{ key: 'slot', size: 2, updatedAt: 1 }]);
    assert.equal(bridge.receive({ type: 'storage-result', id: 999, ok: true }), true, 'Unknown answers are ignored');
  } finally {
    off();
    channel.port1.close();
    channel.port2.close();
  }
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
  assert.ok(document.includes("connect-src 'self' http: https: ws: wss: data: blob:"));
  assert.ok(document.includes("worker-src 'self' http: https: data: blob:"));
  assert.ok(document.includes("'unsafe-eval'"), 'WASM and ordinary web libraries may compile code');
  assert.equal(document.includes("value: undefined"), false, 'WebRTC remains available');
  assert.ok(document.includes('"locale":"en"'));
});

test('miniapp documents start at the saved volume and embed a self-contained volume control', () => {
  const viewer = { id: 'alice', nickname: 'Alice', locale: 'en' } as const;
  const seedVolume = (volume?: number) =>
    Number(/"depth":\d+,"volume":([^,}]+)\}/.exec(botScreenDocument(snapshot(), viewer, volume))?.[1]);
  assert.equal(seedVolume(), 1, 'Unadjusted miniapps keep their own levels');
  assert.equal(seedVolume(0.35), 0.35);
  assert.equal(seedVolume(0), 0, 'A muted tile opens silently');
  assert.equal(seedVolume(5), 2, 'Amplification is capped at 200%');
  assert.equal(seedVolume(Number.NaN), 1);
  const document = botScreenDocument(snapshot(), viewer, 0.5);
  const head = document.slice(0, document.indexOf('<body>'));
  const script = /<script>([\s\S]*)<\/script>/.exec(head)?.[1] ?? '';
  assert.doesNotThrow(() => new Function(script), 'The serialized bootstrap and volume control parse in the miniapp');
  assert.ok(head.includes('HTMLMediaElement.prototype') && head.includes('AudioNode.prototype'),
    'The volume control is installed before the bot scripts');
});

const isBridge = (value: unknown): value is BotScreenBridge => typeof value === 'object' && value !== null &&
  'onBeforeClose' in value && 'onClose' in value && 'sendAction' in value && 'onState' in value;

test('the miniapp bridge announces lifecycle hooks, answers close requests and goes quiet once closing', async () => {
  const document = botScreenDocument(snapshot(), { id: 'alice', nickname: 'Alice', locale: 'en' });
  const script = /<script>([\s\S]*)<\/script>/.exec(document.slice(0, document.indexOf('<body>')))?.[1];
  assert.ok(script);
  const scope = new EventTarget();
  // Window messages to the parent; the bridge posts its download hand-off this way, not on the port.
  const handOffs: unknown[] = [];
  const parent = {
    // Like a real postMessage, the parent receives a structured clone (here, from the test's realm).
    postMessage: (message: unknown, targetOrigin: string) => { handOffs.push([structuredClone(message), targetOrigin]); },
  };
  const errors: unknown[] = [];
  vm.runInNewContext(script, {
    window: scope, parent, structuredClone, TextEncoder,
    // Outside a browser the volume control cannot install; that warning is expected here.
    console: { warn: () => {}, error: (error: unknown) => { errors.push(error); } },
  });
  const bridge: unknown = Object.getOwnPropertyDescriptor(scope, 'monkyScreen')?.value;
  assert.ok(isBridge(bridge));
  assert.throws(() => Reflect.apply(bridge.onClose, bridge, ['not a function']), /Expected a close handler/);
  assert.throws(() => Reflect.apply(bridge.onBeforeClose, bridge, [null]), /Expected a before-close handler/);

  const { port1, port2 } = new MessageChannel();
  const received: unknown[] = [];
  port1.onmessage = (event: MessageEvent<unknown>) => { received.push(event.data); };
  port1.start();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const take = async (): Promise<unknown> => {
    for (let attempt = 0; !received.length; attempt++) {
      assert.ok(attempt < 200, 'Expected a message from the bridge');
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return received.shift();
  };
  try {
    const closes: string[] = [];
    let release = (): void => {};
    bridge.onClose(async ({ reason }) => {
      closes.push(reason);
      await new Promise<void>((resolve) => { release = () => resolve(); });
    });
    await settle();
    assert.deepEqual(received, [], 'Nothing is announced before the parent connects');
    scope.dispatchEvent(Object.assign(new Event('message'), { source: parent, data: 'monky-screen-connect', ports: [port2] }));
    assert.deepEqual(await take(), { type: 'hooks', beforeClose: false, close: true }, 'Hooks registered while loading are announced on connect');

    const asked: string[] = [];
    const answers: Array<boolean | undefined> = [false, undefined];
    const offAsk = bridge.onBeforeClose(({ reason }) => {
      asked.push(reason);
      return answers.shift();
    });
    assert.deepEqual(await take(), { type: 'hooks', beforeClose: true, close: true });
    const offBroken = bridge.onBeforeClose(() => { throw new Error('A broken hook'); });
    await settle();
    assert.deepEqual(received, [], 'Only a change in the kinds of hooks is announced');

    port1.postMessage({ type: 'beforeClose', id: 'first', reason: 'leave' });
    assert.deepEqual(await take(), { type: 'beforeCloseAck', id: 'first' }, 'The bridge acknowledges before asking anything');
    assert.deepEqual(await take(), { type: 'beforeCloseResult', id: 'first', proceed: false }, 'false keeps the view open');
    assert.deepEqual(handOffs, [], 'Staying open needs no hand-off');
    port1.postMessage({ type: 'beforeClose', id: 'second', reason: 'end' });
    assert.deepEqual(await take(), { type: 'beforeCloseAck', id: 'second' });
    assert.deepEqual(await take(), { type: 'beforeCloseResult', id: 'second', proceed: true });
    assert.deepEqual(handOffs, [[{ type: 'monky-screen-handoff', id: 'second' }, '*']],
      'Agreeing to close also hands off over the window, after anything the answer started');
    assert.deepEqual(asked, ['leave', 'end'], 'Handlers run in order and stop at the first false');
    assert.equal(errors.length, 1, 'A throwing hook is reported in the miniapp console and cannot hold its person');

    offAsk();
    offBroken();
    assert.deepEqual(await take(), { type: 'hooks', beforeClose: false, close: true });
    assert.equal(bridge.sendAction('move', { cell: 1 }), true);
    assert.deepEqual(await take(), { action: 'move', payload: { cell: 1 }, revision: 0 });

    const revisions: number[] = [];
    bridge.onState((_state, revision) => { revisions.push(revision); });
    port1.postMessage({ type: 'close', reason: 'revoked' });
    await settle();
    assert.deepEqual(closes, ['revoked']);
    assert.deepEqual(received, [], 'The parent waits until every onClose handler settles');
    assert.equal(bridge.sendAction('late', {}), false, 'A closing view has no bridge');
    port1.postMessage({ type: 'state', state: { count: 9 }, revision: 9 });
    port1.postMessage({ type: 'beforeClose', id: 'third', reason: 'leave' });
    bridge.onBeforeClose(() => true);
    release();
    assert.deepEqual(await take(), { type: 'closed' });
    await settle();
    assert.deepEqual(revisions, [0], 'Nothing but the close reaches a closing view');
    assert.deepEqual(received, [], 'A closing view neither answers nor announces again');
    assert.equal(handOffs.length, 1, 'A closing view hands nothing else off');
  } finally {
    port1.close();
  }
});

test('like a sharer screen audio, a bot miniapp mute covers the call and ends with it', () => {
  const changes: unknown[] = [];
  const off = appEvents.on('voice.miniapp_mute_changed', (change) => changes.push(change));
  try {
    voiceStore.setChannel('voice', 'miniapp-mute');
    voiceStore.setMiniappMuted('bot', true);
    voiceStore.setMiniappMuted('bot', true);
    assert.equal(voiceStore.isMiniappMuted('bot'), true);
    assert.equal(voiceStore.isMiniappMuted('other-bot'), false, 'Another bot keeps playing');
    voiceStore.setChannel('voice', 'miniapp-mute');
    assert.equal(voiceStore.isMiniappMuted('bot'), true, 'Rejoining the same room keeps the mute');
    voiceStore.setChannel(null);
    assert.equal(voiceStore.isMiniappMuted('bot'), false, 'Leaving the call clears the mute');
    assert.deepEqual(changes, [{ botId: 'bot', muted: true }], 'Only real changes are announced');
  } finally {
    off();
    voiceStore.reset();
  }
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
