import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import {
  DM_DEFAULT_MAX_FILE_BYTES,
  MessageType,
  PROTOCOL_VERSION,
  createProtocolOffer,
  normalizePublicKeyHex,
  type DmApi,
  type DmDispatch,
  type DmResult,
  type UserSummary,
} from '@monky/shared';
import { DmTransport } from '../src/renderer/core/DmTransport';
import { sessionManager, type ServerSession } from '../src/renderer/core/SessionManager';

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
