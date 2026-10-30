import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { MessageType } from '@monky/shared';
import { callClient, callServer, captureCall } from '../src/renderer/core/callScope';
import { getActiveNetworkClient, setActiveNetworkClient } from '../src/renderer/core/NetworkClient';
import { SessionManager, sessionManager } from '../src/renderer/core/SessionManager';
import { voiceStore } from '../src/renderer/stores/voiceStore';

/** A call on one server while another one is on screen (#400). */
function fixture(t: TestContext) {
  voiceStore.reset();
  const sessions = new SessionManager();
  const call = sessions.create('scope-call.invalid', 10201, 'Self');
  const visible = sessions.create('scope-visible.invalid', 10202, 'Self');
  for (const [session, sessionId] of [[call, 'call-session'], [visible, 'visible-session']] as const) {
    session.serverStore.currentUser = {
      id: 'self', sessionId, clientId: 'client', nickname: 'Self', status: 'ONLINE', joinedAt: 1,
    };
  }
  const available = new Map([[call.key, call], [visible.key, visible]]);
  t.mock.method(sessionManager, 'get', (key: string) => available.get(key));
  t.mock.method(sessionManager, 'getActive', () => visible);
  // The global proxies follow the server on screen, as after activating it.
  const previousClient = getActiveNetworkClient();
  setActiveNetworkClient(visible.client);
  const sent: Array<{ server: string; type: MessageType }> = [];
  for (const session of [call, visible]) {
    t.mock.method(session.client, 'send', (type: MessageType) => { sent.push({ server: session.key, type }); });
  }
  voiceStore.setChannel('room', call.key);
  t.after(() => {
    setActiveNetworkClient(previousClient);
    voiceStore.reset();
  });
  return { call, visible, available, sent };
}

test('the call resolves to its own server while another one is on screen (R-VOICE-8)', t => {
  const f = fixture(t);
  assert.equal(callServer(), f.call);
  callClient().send(MessageType.VOICE_STATE_UPDATE, { isMuted: true });
  assert.deepEqual(f.sent, [{ server: f.call.key, type: MessageType.VOICE_STATE_UPDATE }]);
  voiceStore.reset();
  assert.equal(callServer(), f.visible, 'without a call, the server on screen answers');
});

test('a call whose server session is gone never falls back to the server on screen (R-VOICE-8)', t => {
  const f = fixture(t);
  f.available.delete(f.call.key);
  assert.equal(callServer(), null);
  const client = callClient();
  assert.notEqual(client, f.visible.client);
  assert.equal(client.getStatus(), 'DISCONNECTED', 'the call talks to a closed connection');
  client.send(MessageType.VOICE_STATE_UPDATE, { isMuted: true });
  assert.deepEqual(f.sent, [], 'nothing reaches the visible server');
});

test('a captured call stops being current when the room, the server session or the sign-in changes', t => {
  const f = fixture(t);
  const moved = captureCall();
  assert.equal(moved.isCurrent(), true);
  assert.equal(moved.server, f.call);
  voiceStore.setChannel('other-room', f.call.key);
  assert.equal(moved.isCurrent(), false, 'another room');

  voiceStore.setChannel('room', f.call.key);
  const signedIn = captureCall();
  f.call.serverStore.currentUser = { ...f.call.serverStore.currentUser!, sessionId: 'after-reconnect' };
  assert.equal(signedIn.isCurrent(), false, 'a reconnection signs in again: a new call');

  const replaced = captureCall();
  const successor = new SessionManager().create('scope-call.invalid', 10201, 'Self');
  successor.serverStore.currentUser = f.call.serverStore.currentUser;
  f.available.set(f.call.key, successor);
  assert.equal(replaced.isCurrent(), false, 'the same address, but another session');

  f.available.delete(f.call.key);
  const gone = captureCall();
  assert.equal(gone.server, null);
  assert.equal(gone.isCurrent(), false);
});
