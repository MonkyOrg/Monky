import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { MessageType, PROTOCOL_VERSION, MIN_CLIENT_PROTOCOL, type ProtocolMessage, type ServerShutdownPayload } from '@monky/shared';
import { NetworkClient, type ConnectionStatus } from '../src/renderer/core/NetworkClient';
import { appEvents } from '../src/renderer/core/EventBus';
import { setForegroundContext, setSessionEventRouter } from '../src/renderer/core/sessionRouting';

const identity = { clientId: 'fixture-client', publicKey: 'fixture-public-key' };

function fixture(context: TestContext) {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100_000 });
  const sockets: Socket[] = [];
  class Socket {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static failConstruction = false;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    sent: ProtocolMessage[] = [];
    respondToPing = true;
    constructor(readonly url: string) {
      if (Socket.failConstruction) throw new Error('Fixture socket constructor failed');
      sockets.push(this);
    }
    send(data: string) {
      assert.equal(this.readyState, Socket.OPEN);
      const message: ProtocolMessage = JSON.parse(data);
      this.sent.push(message);
      if (message.type === MessageType.PING && this.respondToPing) {
        this.receive({ type: MessageType.PONG, payload: {} });
      }
    }
    open() {
      this.readyState = Socket.OPEN;
      this.onopen?.(new Event('open'));
    }
    close() {
      this.readyState = Socket.CLOSED;
      queueMicrotask(() => this.onclose?.(new Event('close')));
    }
    drop() {
      this.readyState = Socket.CLOSED;
      this.onclose?.(new Event('close'));
    }
    receive(message: ProtocolMessage) {
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(message) }));
    }
    auth(type = MessageType.AUTH_SUCCESS) {
      const request = this.sent.find(message => message.type === MessageType.AUTH_CONNECT);
      assert.ok(request?.requestId);
      this.receive({ type, requestId: request.requestId, payload: {} });
    }
  }
  const browser = Object.assign(new EventTarget(), {
    api: { signChallenge: async (_nonce: string) => 'fixture-signature' },
  });
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  const client = new NetworkClient();
  const statuses: ConnectionStatus[] = [];
  const offStatus = appEvents.on<ConnectionStatus>('network.status', status => statuses.push(status));
  const lastSocket = () => {
    const socket = sockets.at(-1);
    assert.ok(socket);
    return socket;
  };
  context.after(() => {
    offStatus();
    client.dispose();
    if (originalSocket) Object.defineProperty(globalThis, 'WebSocket', originalSocket);
    else Reflect.deleteProperty(globalThis, 'WebSocket');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const connect = () => client.connect('fixture.test', 46332, identity, 'Fixture');
  const connected = async () => {
    const pending = connect();
    lastSocket().open();
    lastSocket().auth();
    await pending;
    statuses.length = 0;
  };
  return { client, browser, Socket, sockets, statuses, lastSocket, connect, connected };
}

test('initial connection failure rejects without creating an automatic reconnect loop', async context => {
  const f = fixture(context);
  const failed = assert.rejects(f.connect());
  f.lastSocket().drop();
  await failed;
  context.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(f.client.getStatus(), 'DISCONNECTED');
  assert.equal(f.sockets.length, 1);
});

test('a current client retries the known legacy contract exactly once without changing identity', async context => {
  const f = fixture(context);
  const pending = f.connect();
  const socket = f.lastSocket();
  socket.open();
  const request = socket.sent[0];
  assert.equal(request.payload.protocolVersion, PROTOCOL_VERSION);
  socket.receive({ type: MessageType.SERVER_ERROR, requestId: request.requestId,
    payload: { code: 'PROTOCOL_VERSION_UNSUPPORTED', serverProtocolVersion: 24 } });
  const retry = socket.sent.at(-1);
  assert.equal(retry?.payload.protocolVersion, 24);
  assert.equal(retry?.payload.publicKey, request.payload.publicKey);
  assert.equal(retry?.payload.deviceId, request.payload.deviceId);
  socket.receive({ type: MessageType.AUTH_SUCCESS, requestId: retry?.requestId, payload: {} });
  await pending;
  assert.equal(f.client.getStatus(), 'CONNECTED');
  assert.equal(f.sockets.length, 1);
});

test('a current client never retries below the security floor', async context => {
  const f = fixture(context);
  const pending = assert.rejects(f.connect());
  const socket = f.lastSocket();
  socket.open();
  socket.receive({ type: MessageType.SERVER_ERROR, requestId: socket.sent[0].requestId,
    payload: { code: 'PROTOCOL_VERSION_UNSUPPORTED', serverProtocolVersion: MIN_CLIENT_PROTOCOL - 1 } });
  await pending;
  assert.equal(socket.sent.filter(message => message.type === MessageType.AUTH_CONNECT).length, 1);
});

test('only the original client recognizes correlated local voice leave acknowledgements', async context => {
  const f = fixture(context);
  await f.connected();
  const payload = { channelId: 'room', userId: 'self', sessionId: 'self:device' };
  const received: unknown[] = [];
  const failures: unknown[] = [];
  const other = new NetworkClient();
  const offLeft = appEvents.on(`message.${MessageType.VOICE_USER_LEFT}`, value => received.push(value));
  const offError = appEvents.on(`message.${MessageType.SERVER_ERROR}`, value => failures.push(value));
  context.after(() => { offLeft(); offError(); other.dispose(); });
  f.client.send(MessageType.VOICE_LEAVE, { channelId: 'room' });
  const requestId = f.lastSocket().sent.at(-1)?.requestId;
  assert.ok(requestId);
  f.client.send(MessageType.VOICE_JOIN, { channelId: 'room' });
  f.lastSocket().receive({ type: MessageType.VOICE_USER_LEFT, requestId, payload });
  const acknowledgement = received.at(-1);
  assert.equal(f.client.isLocalVoiceLeaveAcknowledgement(acknowledgement), true);
  assert.equal(other.isLocalVoiceLeaveAcknowledgement(acknowledgement), false);
  assert.equal(f.client.isLocalVoiceLeaveAcknowledgement(payload), false);
  assert.equal(f.client.isLocalVoiceLeaveAcknowledgement(structuredClone(acknowledgement)), false);
  for (const message of [
    { type: MessageType.VOICE_USER_LEFT, payload },
    { type: MessageType.VOICE_USER_LEFT, requestId: 'unsolicited-removal', payload },
    { type: MessageType.VOICE_USER_LEFT, requestId, payload: { ...payload, channelId: 'other-room' } },
  ]) {
    f.lastSocket().receive(message);
    assert.equal(f.client.isLocalVoiceLeaveAcknowledgement(received.at(-1)), false);
  }
  f.lastSocket().receive({ type: MessageType.VOICE_USER_LEFT, requestId, payload });
  assert.equal(f.client.isLocalVoiceLeaveAcknowledgement(received.at(-1)), true, 'a duplicate echo still belongs to the old leave');
  f.lastSocket().receive({ type: MessageType.SERVER_ERROR, requestId, payload: { message: 'Leave rejected' } });
  assert.equal(failures.length, 1, 'recognizing acknowledgements must not suppress server errors');
  f.lastSocket().drop();
  assert.equal(f.client.isLocalVoiceLeaveAcknowledgement(acknowledgement), false, 'socket retirement clears acknowledgement ownership');
});

test('voice leave correlation retains a bounded set of sent requests', async context => {
  const f = fixture(context);
  await f.connected();
  for (let index = 0; index < 300; index++) {
    f.client.send(MessageType.VOICE_LEAVE, { channelId: 'room' }, `leave-${index}`);
  }
  assert.equal(f.client['localVoiceLeaves'].size, 256);
  assert.equal(f.client['localVoiceLeaves'].has('leave-0'), false);
  assert.equal(f.client['localVoiceLeaves'].get('leave-299'), 'room');
  f.client.disconnect();
  assert.equal(f.client['localVoiceLeaves'].size, 0);
});

test('failed TCP and authentication attempts keep retrying until the server recovers', async context => {
  const f = fixture(context);
  await f.connected();
  f.lastSocket().drop();
  context.mock.timers.tick(1000);
  assert.equal(f.sockets.length, 2);
  f.lastSocket().drop();
  await setImmediate();
  context.mock.timers.tick(2000);
  assert.equal(f.sockets.length, 3);
  f.lastSocket().open();
  f.lastSocket().auth(MessageType.AUTH_FAILED);
  await setImmediate();
  context.mock.timers.tick(3000);
  assert.equal(f.sockets.length, 4);
  f.lastSocket().open();
  f.lastSocket().auth();
  await setImmediate();
  assert.equal(f.client.getStatus(), 'CONNECTED');
  assert.equal(f.client['reconnectAttempt'], 0);
  assert.equal(f.statuses.includes('DISCONNECTED'), false);
  assert.equal(f.statuses.includes('CONNECTING'), false);
});

test('dial and authentication timeouts both advance the reconnect ladder', async context => {
  const f = fixture(context);
  await f.connected();
  f.lastSocket().drop();
  context.mock.timers.tick(1000);
  const dial = f.lastSocket();
  context.mock.timers.tick(12_000);
  await setImmediate();
  assert.equal(dial.readyState, f.Socket.CLOSED);
  context.mock.timers.tick(2000);
  assert.equal(f.sockets.length, 3);
  f.lastSocket().open();
  context.mock.timers.tick(15_000);
  await setImmediate();
  context.mock.timers.tick(3000);
  assert.equal(f.sockets.length, 4);
  f.lastSocket().open();
  f.lastSocket().auth();
  await setImmediate();
  assert.equal(f.client.getStatus(), 'CONNECTED');
});

test('a constructor failure during recovery does not strand the retained session', async context => {
  const f = fixture(context);
  await f.connected();
  f.Socket.failConstruction = true;
  f.lastSocket().drop();
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(f.client.getStatus(), 'RECONNECTING');
  f.Socket.failConstruction = false;
  context.mock.timers.tick(2000);
  assert.equal(f.sockets.length, 2);
  f.lastSocket().open();
  f.lastSocket().auth();
  await setImmediate();
  assert.equal(f.client.getStatus(), 'CONNECTED');
});

test('manual disconnect cancels pending dial/auth, emits once and cannot reconnect later', async context => {
  for (const open of [false, true]) {
    await context.test(open ? 'authenticating' : 'dialling', async nested => {
      const f = fixture(nested);
      let departures = 0;
      const off = appEvents.on('network.disconnected', () => { departures++; });
      nested.after(off);
      const cancelled = assert.rejects(f.connect(), { name: 'AbortError' });
      if (open) f.lastSocket().open();
      f.client.disconnect();
      f.client.disconnect();
      await cancelled;
      f.browser.dispatchEvent(new Event('online'));
      nested.mock.timers.tick(60_000);
      await setImmediate();
      assert.equal(f.client.getStatus(), 'DISCONNECTED');
      assert.equal(f.sockets.length, 1);
      assert.equal(departures, 1);
      assert.equal(f.client['pendingAuth'], null);
      assert.equal(f.client['pendingConnect'], null);
    });
  }
});

test('the online event replaces a stalled recovery without an obsolete retry replacing the new socket', async context => {
  const f = fixture(context);
  await f.connected();
  f.lastSocket().drop();
  context.mock.timers.tick(1000);
  const stalled = f.lastSocket();
  stalled.open();
  const staleClose = stalled.onclose;
  f.browser.dispatchEvent(new Event('online'));
  assert.equal(f.sockets.length, 3);
  f.lastSocket().open();
  f.lastSocket().auth();
  staleClose?.(new Event('close'));
  await setImmediate();
  for (let tick = 0; tick < 12; tick++) context.mock.timers.tick(5000);
  await setImmediate();
  assert.equal(f.sockets.length, 3);
  assert.equal(f.client.getStatus(), 'CONNECTED');
});

test('callbacks from a retired socket cannot affect the session during reconnect backoff', async context => {
  const f = fixture(context);
  await f.connected();
  const oldClose = f.lastSocket().onclose;
  const oldMessage = f.lastSocket().onmessage;
  let messages = 0;
  const off = appEvents.on(`message.${MessageType.VOICE_USER_LEFT}`, () => { messages++; });
  context.after(off);
  f.lastSocket().drop();
  oldClose?.(new Event('close'));
  oldMessage?.(new MessageEvent('message', {
    data: JSON.stringify({ type: MessageType.VOICE_USER_LEFT, payload: { channelId: 'room', sessionId: 'self' } }),
  }));
  assert.equal(f.client['reconnectAttempt'], 1);
  assert.equal(messages, 0);
  context.mock.timers.tick(1000);
  assert.equal(f.sockets.length, 2);
});

test('late challenge signatures and failures cannot affect a replacement connection', async context => {
  for (const fail of [false, true]) {
    await context.test(fail ? 'failed signature' : 'successful signature', async nested => {
      const f = fixture(nested);
      let resolveSignature!: (value: string) => void;
      let rejectSignature!: (error: Error) => void;
      f.browser.api.signChallenge = () => new Promise((resolve, reject) => {
        resolveSignature = resolve;
        rejectSignature = reject;
      });
      const first = assert.rejects(f.connect(), { name: 'AbortError' });
      f.lastSocket().open();
      f.lastSocket().auth(MessageType.AUTH_CHALLENGE);
      const replacement = f.connect();
      await first;
      f.lastSocket().open();
      f.lastSocket().auth();
      await replacement;
      if (fail) rejectSignature(new Error('Obsolete signing failed'));
      else resolveSignature('obsolete-signature');
      await setImmediate();
      assert.equal(f.client.getStatus(), 'CONNECTED');
      assert.equal(f.lastSocket().sent.some(message => message.type === MessageType.AUTH_CHALLENGE_RESPONSE), false);
    });
  }
});

test('requests fail immediately offline and outstanding requests are rejected when the socket drops', async context => {
  const f = fixture(context);
  await assert.rejects(f.client.sendRequest(MessageType.SFU_GET_PRODUCERS, { channelId: 'room' }));
  assert.equal(f.client['pendingRequests'].size, 0);
  await f.connected();
  const pending = assert.rejects(f.client.sendRequest(MessageType.SFU_GET_PRODUCERS, { channelId: 'room' }));
  f.lastSocket().drop();
  await pending;
  assert.equal(f.client['pendingRequests'].size, 0);
  await assert.rejects(f.client.sendRequest(MessageType.SFU_GET_PRODUCERS, { channelId: 'room' }));
  assert.equal(f.client['pendingRequests'].size, 0);
});

test('a synchronous socket send failure does not leave a request or timeout behind', async context => {
  const f = fixture(context);
  await f.connected();
  f.lastSocket().send = () => { throw new Error('Fixture socket send failed'); };
  await assert.rejects(f.client.sendRequest(MessageType.SFU_GET_PRODUCERS, { channelId: 'room' }), /socket send failed/);
  assert.equal(f.client['pendingRequests'].size, 0);
});

test('a half-open socket is retired by heartbeat and an explicit leave cancels scheduled recovery', async context => {
  const f = fixture(context);
  await f.connected();
  f.lastSocket().respondToPing = false;
  context.mock.timers.tick(15_000);
  assert.equal(f.client.getStatus(), 'RECONNECTING');
  assert.equal(f.lastSocket().readyState, f.Socket.CLOSED);
  assert.equal(f.lastSocket().onmessage, null);
  f.client.disconnect();
  context.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.client.getStatus(), 'DISCONNECTED');
});

test('leaving from a reconnect notification cannot schedule a timer after teardown', async context => {
  const f = fixture(context);
  await f.connected();
  const off = appEvents.on('network.reconnecting', () => f.client.disconnect());
  context.after(off);
  f.lastSocket().drop();
  context.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(f.client.getStatus(), 'DISCONNECTED');
  assert.equal(f.sockets.length, 1);
  assert.equal(f.client['reconnectTimeout'], null);
});

test('a background server update notice reaches global UI without reconnecting or losing its identity', async context => {
  const f = fixture(context);
  f.client.sessionKey = 'background-server';
  await f.connected();
  f.lastSocket().receive({ type: MessageType.SERVER_SETTINGS_UPDATED, payload: { name: 'Remote fixture server' } });
  const notices: Array<ServerShutdownPayload & { serverName?: string }> = [];
  const off = appEvents.on<ServerShutdownPayload & { serverName?: string }>('network.server_shutdown', notice => notices.push(notice));
  setSessionEventRouter(() => {});
  context.after(() => {
    off();
    setForegroundContext(true);
    setSessionEventRouter((_key, _event, emit) => emit());
  });
  setForegroundContext(false);
  f.lastSocket().receive({ type: MessageType.SERVER_SHUTDOWN, payload: { reasonCode: 'update' } });
  assert.equal(notices.length, 0, 'UI waits for the borrowed background routing scope to finish');
  setForegroundContext(true);
  await setImmediate();
  assert.deepEqual(notices, [{ reasonCode: 'update', serverName: 'Remote fixture server' }]);
  assert.equal(f.client.getStatus(), 'DISCONNECTED');
  context.mock.timers.tick(60_000);
  await setImmediate();
  assert.equal(f.sockets.length, 1, 'Intentional shutdown keeps the existing manual-reconnection behavior');
});
