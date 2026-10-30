import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import {
  DM_DEFAULT_MAX_FILE_BYTES,
  MessageType,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  createProtocolOffer,
  normalizePublicKeyHex,
  type DmApi,
  type DmDispatch,
  type DmRelayItem,
  type DmResult,
  type DmSnapshot,
  type UserSummary,
} from '@monky/shared';
import { DmTransport } from '../src/renderer/core/DmTransport';
import { sessionManager, type ServerSession } from '../src/renderer/core/SessionManager';
import { DmStore } from '../src/renderer/stores/dmStore';

function newIdentity(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  return normalizePublicKeyHex(publicKey.export({ format: 'der', type: 'spki' }).toString('hex'));
}

const nothing = async (): Promise<DmResult<DmDispatch>> => ({ ok: true, value: {} });
const done = async (): Promise<DmResult<void>> => ({ ok: true, value: undefined });

/** A main process that answers every call; `overrides` record the calls a test cares about. */
function fakeApi(overrides: Partial<DmApi>): DmApi {
  return {
    snapshot: async () => ({ ok: true, value: { me: null, peers: [], conversations: [], settings: { maxFileBytes: DM_DEFAULT_MAX_FILE_BYTES } } }),
    conversation: async (peer) => ({ ok: true, value: { peer, messages: [], hasMore: false, peerReadAt: 0 } }),
    openConversation: done,
    closeConversation: done,
    sendFriendRequest: nothing,
    acceptFriend: nothing,
    declineFriend: nothing,
    cancelFriendRequest: nothing,
    removeFriend: nothing,
    block: nothing,
    unblock: nothing,
    sendMessage: nothing,
    editMessage: nothing,
    deleteMessage: nothing,
    react: nothing,
    markRead: nothing,
    typing: nothing,
    ingest: nothing,
    outgoing: nothing,
    hello: nothing,
    helloTo: nothing,
    pendingPeers: async () => ({ ok: true, value: [] }),
    observePeer: done,
    setSelfNickname: done,
    setSelfProfile: async () => ({ ok: true, value: { profile: { nickname: '', nicknameAt: 0, avatar: null, avatarAt: 0 }, dispatch: {} } }),
    updateSettings: nothing,
    readAttachment: async () => ({ ok: false, error: { code: 'not-found', message: 'not-found', details: {} } }),
    saveAttachment: async () => ({ ok: true, value: false }),
    retryAttachment: nothing,
    onEvent: () => () => undefined,
    ...overrides,
  };
}

function member(publicKey: string, name: string): UserSummary {
  return { id: name, clientId: name, publicKey, nickname: name, status: 'ONLINE', joinedAt: 1, sessionId: `${name}:device` };
}

/** A server session signed in as `signedInAs`, with the relay on and `friend` online. */
function seed(session: ServerSession, signedInAs: string, friend: string): void {
  const me = member(signedInAs, 'me');
  session.serverStore.setServerDetails({
    id: session.key, name: 'Server', createdAt: 1, maxUsers: 10, members: [me, member(friend, 'friend')], voiceStates: {},
    channels: [], myPermissions: 0, protocol: { ...createProtocolOffer('client'), version: PROTOCOL_VERSION },
  }, me);
}

test('after an identity import, DMs only travel through sessions signed in as the new identity', async (context) => {
  const previous = newIdentity();
  const imported = newIdentity();
  const friend = newIdentity();
  const calls: string[] = [];
  const api = fakeApi({
    hello: async () => {
      calls.push('hello');
      return { ok: true, value: { broadcast: [{ to: imported, kind: 'signal', data: 'hello' }] } };
    },
    helloTo: async () => { calls.push('helloTo'); return { ok: true, value: {} }; },
    outgoing: async () => { calls.push('outgoing'); return { ok: true, value: {} }; },
    ingest: async () => { calls.push('ingest'); return { ok: true, value: {} }; },
  });
  const session = sessionManager.create('dm-import', 7800, 'me');
  seed(session, previous, friend);
  context.mock.method(session.client, 'getStatus', () => 'CONNECTED');
  const sent: MessageType[] = [];
  context.mock.method(session.client, 'send', (type: MessageType) => { sent.push(type); });
  const transport = new DmTransport(api);
  context.after(async () => { transport.stop(); await sessionManager.removeAll(); });

  // The store already holds the imported identity; the session still signs in as the previous one.
  transport.setIdentity(imported, [friend]);
  transport.start();
  await setImmediate();
  assert.equal(calls.length, 0, 'Nothing is sealed for a session the friend would reject');
  assert.equal(transport.isReachable(friend), false, 'The friend does not look reachable through it');
  assert.equal(sent.length, 0);

  // Items for the previous identity that still reach the session are not handed to the new store.
  session.client['notifyEventListeners'](`message.${MessageType.DM_RELAY_DELIVER}`, { from: friend, kind: 'envelope', data: 'old' });
  await setImmediate();
  assert.equal(calls.length, 0);

  // Reconnected as the imported identity: the link comes up and greets.
  seed(session, imported, friend);
  session.client['notifyEventListeners']('network.connected', {});
  transport.flushSoon();
  await setImmediate();
  assert.ok(calls.includes('hello'), 'The link greets once it is signed in as the identity of the store');
  assert.ok(calls.includes('helloTo') && calls.includes('outgoing'), 'The visible friend gets the outbox');
  assert.ok(sent.includes(MessageType.DM_RELAY_SEND));
  assert.equal(transport.isReachable(friend), true);
  session.client['notifyEventListeners'](`message.${MessageType.DM_RELAY_DELIVER}`, { from: friend, kind: 'envelope', data: 'new' });
  await setImmediate();
  assert.ok(calls.includes('ingest'));

  // A later import takes the link down again until the session signs in as that one too.
  calls.length = 0;
  transport.setIdentity(newIdentity(), [friend]);
  transport.flushSoon();
  await setImmediate();
  assert.equal(transport.isReachable(friend), false);
  assert.equal(calls.filter((call) => call === 'hello').length, 0);
});

function relayBatch(payload: unknown): { relayId: string; items: DmRelayItem[] } | null {
  if (!payload || typeof payload !== 'object' || !('relayId' in payload) || !('items' in payload)) return null;
  const { relayId, items } = payload;
  return typeof relayId === 'string' && Array.isArray(items) ? { relayId, items } : null;
}

test('relay sends stay within the server rate, and what it refuses for the rate is sent again in order', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const me = newIdentity();
  const friend = newIdentity();
  const session = sessionManager.create('dm-pacing', 7801, 'me');
  seed(session, me, friend);
  context.mock.method(session.client, 'getStatus', () => 'CONNECTED');
  const batches: Array<{ relayId: string; items: DmRelayItem[] }> = [];
  context.mock.method(session.client, 'send', (type: MessageType, payload: unknown) => {
    const batch = type === MessageType.DM_RELAY_SEND ? relayBatch(payload) : null;
    if (batch) batches.push(batch);
  });
  const transport = new DmTransport(fakeApi({}));
  context.after(async () => { transport.stop(); await sessionManager.removeAll(); });
  transport.setIdentity(me, [friend]);
  transport.start();
  await setImmediate();
  assert.equal(transport.isReachable(friend), true);

  const chunks: DmRelayItem[] = Array.from({ length: 40 }, (_, index) => ({ to: friend, kind: 'file', data: `chunk-${index}`.padEnd(175_000, '.') }));
  transport.execute({ peers: { [friend]: chunks } });
  const labels = () => batches.flatMap((batch) => batch.items.map((entry) => entry.data.replace(/\.+$/, '')));
  const burst = labels().length;
  assert.ok(burst > 0 && burst < chunks.length, `Only what the server's burst takes leaves at once (${burst})`);

  // The server still refused the first batch for the rate: it goes back to the head of the line.
  session.client['notifyEventListeners'](`message.${MessageType.SERVER_ERROR}`, {
    code: ProtocolErrorCode.RATE_LIMITED, message: 'Muitas mensagens diretas', relayId: batches[0].relayId,
  });
  assert.equal(labels().length, burst, 'Nothing goes out again before the buckets refill');
  for (let elapsed = 0; elapsed < 15_000; elapsed += 50) context.mock.timers.tick(50);
  const resent = labels().slice(burst);
  assert.deepEqual(resent, [...chunks.map((_, index) => `chunk-${index}`)], 'Refused chunks first, then the rest, in order');
});

test('requests for every device of a friend go through every server the friend is on; anything else through one', async (context) => {
  const me = newIdentity();
  const friend = newIdentity();
  const stranger = newIdentity();
  const sessions = [7811, 7812, 7813].map((port) => sessionManager.create(`dm-everywhere-${port}`, port, 'me'));
  seed(sessions[0], me, friend);
  seed(sessions[1], me, friend);
  seed(sessions[2], me, stranger);
  const sent = new Map(sessions.map((session) => [session.key, [] as string[]]));
  for (const session of sessions) {
    context.mock.method(session.client, 'getStatus', () => 'CONNECTED');
    context.mock.method(session.client, 'send', (type: MessageType, payload: unknown) => {
      const batch = type === MessageType.DM_RELAY_SEND ? relayBatch(payload) : null;
      for (const item of batch?.items ?? []) sent.get(session.key)?.push(item.data);
    });
  }
  const transport = new DmTransport(fakeApi({}));
  context.after(async () => { transport.stop(); await sessionManager.removeAll(); });
  transport.setIdentity(me, [friend]);
  transport.start();
  await setImmediate();

  transport.execute({ everywhere: { [friend]: [{ to: friend, kind: 'signal', data: 'pedido' }] } });
  transport.execute({ peers: { [friend]: [{ to: friend, kind: 'signal', data: 'mensagem' }] } });
  const through = (data: string) => sessions.filter((session) => sent.get(session.key)?.includes(data)).map((session) => session.key);
  assert.deepEqual(through('pedido'), [sessions[0].key, sessions[1].key], 'Each server the friend is on gets the request once');
  assert.equal(through('mensagem').length, 1, 'Anything else still goes through one of them');
});

test('the DM store reports loading until its first snapshot lands or fails, so Home tells "opening" from "empty" (R-SHELL-14)', async (context) => {
  const previous: unknown = Reflect.get(globalThis, 'window');
  context.after(async () => { Reflect.set(globalThis, 'window', previous); await sessionManager.removeAll(); });
  const open = (snapshot: DmApi['snapshot']) => {
    Reflect.set(globalThis, 'window', { api: { dm: fakeApi({ snapshot }) } });
    const store = new DmStore();
    context.after(() => store.dispose());
    let changes = 0;
    store.bus.on('changed', () => { changes += 1; });
    return { store, changes: () => changes };
  };

  let answer: (result: DmResult<DmSnapshot>) => void = () => undefined;
  const pending = open(() => new Promise((resolve) => { answer = resolve; }));
  assert.equal(pending.store.loading, false, 'Nothing loads before init');
  const started = pending.store.init();
  assert.equal(pending.store.loading, true, 'Home is drawn while the store opens in the main process');
  answer({ ok: true, value: { me: null, peers: [], conversations: [], settings: { maxFileBytes: DM_DEFAULT_MAX_FILE_BYTES } } });
  await started;
  assert.equal(pending.store.loading, false);
  assert.equal(pending.changes(), 1, 'One redraw when the snapshot lands');

  const refused = open(async () => ({ ok: false, error: { code: 'unavailable', message: 'No identity', details: {} } }));
  await refused.store.init();
  assert.equal(refused.store.loading, false, 'A refused snapshot leaves Home on its empty state, not on placeholders');
  assert.equal(refused.changes(), 1);

  const broken = open(async () => { throw new Error('Synthetic IPC failure'); });
  await assert.rejects(broken.store.init(), /Synthetic IPC failure/);
  assert.equal(broken.store.loading, false, 'A failed snapshot never strands the placeholders');
  assert.equal(broken.changes(), 1);
});
