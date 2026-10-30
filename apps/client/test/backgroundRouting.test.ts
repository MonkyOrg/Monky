import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { MessageType, type ChatMessage } from '@monky/shared';
import { appEvents } from '../src/renderer/core/EventBus';
import { SessionManager, type ServerSession } from '../src/renderer/core/SessionManager';
import { isForegroundEvent, routeSessionEvent } from '../src/renderer/core/sessionRouting';
import { chatStore } from '../src/renderer/stores/chatStore';
import { getActiveServerStore } from '../src/renderer/stores/serverStore';
import { settingsStore } from '../src/renderer/stores/settingsStore';
import { voiceStore } from '../src/renderer/stores/voiceStore';

const CHAT_MESSAGE = `message.${MessageType.CHAT_MESSAGE}`;

function servers(context: TestContext) {
  const manager = new SessionManager();
  manager.install();
  const visible = manager.create('visible.test', 5201, 'Self');
  const background = manager.create('background.test', 5202, 'Self');
  manager.activate(visible.key);
  context.mock.method(settingsStore, 'save', () => {});
  context.after(() => {
    voiceStore.reset();
    void manager.dispose();
  });
  return { manager, visible, background };
}

test('a server in the background repaints the rail only when its badge changes', (context) => {
  const { background } = servers(context);
  const activity: string[] = [];
  const mentioned = new Set<string>();
  const off = [
    appEvents.on('session.background_activity', ({ key }) => activity.push(key)),
    // Stand-in for the app's handler: while routed, the proxies point at the sender.
    appEvents.on(CHAT_MESSAGE, (message) => {
      if (mentioned.has(message.id)) chatStore.markMention(message.channelId);
      else chatStore.markUnread(message.channelId);
    }),
  ];
  context.after(() => off.forEach((unbind) => unbind()));
  const route = (event: string, emit: () => void) => routeSessionEvent(background.key, event, emit);
  let sent = 0;
  const deliver = ({ channelId, mention = false }: { channelId: string; mention?: boolean }) => {
    const message: ChatMessage = {
      id: `message-${++sent}`, channelId, userId: 'peer', userNickname: 'Peer', content: 'hello', createdAt: sent,
    };
    if (mention) mentioned.add(message.id);
    route(CHAT_MESSAGE, () => appEvents.emit(CHAT_MESSAGE, message));
  };

  deliver({ channelId: 'general' });
  assert.deepEqual(activity, [background.key], 'the first message shows the unread badge');
  for (let index = 0; index < 10; index++) deliver({ channelId: index % 2 ? 'general' : 'random' });
  assert.equal(activity.length, 1, 'more messages change no badge, so the rail is not redrawn');
  deliver({ channelId: 'random', mention: true });
  assert.equal(activity.length, 2, 'a mention turns the badge red');
  route('fixture.read_elsewhere', () => {
    chatStore.clearMention('random');
    chatStore.clearUnread('random');
    chatStore.clearUnread('general');
  });
  assert.equal(activity.length, 3, 'reading on another device clears the badge without a new message');
  assert.equal(background.chatStore.hasAnyUnread(), false);
});

test('voice state changed by a background server reaches the views only after its event', async (context) => {
  const { visible, background } = servers(context);
  voiceStore.setChannel('room', background.key);
  const painted: Array<{ foreground: boolean; visibleStores: boolean }> = [];
  const off = appEvents.on('voice.state_updated', () => {
    painted.push({ foreground: isForegroundEvent(), visibleStores: getActiveServerStore() === visible.serverStore });
  });
  context.after(off);

  // The call's server ends the call while another server is on screen
  // (VOICE_USER_LEFT, voice kick, voice mode reconnect): every setter runs.
  routeSessionEvent(background.key, `message.${MessageType.VOICE_USER_LEFT}`, () => {
    voiceStore.addScreenShare('share');
    voiceStore.addScreenAudioShare('share');
    voiceStore.removeScreenAudioShare('share');
    voiceStore.removeScreenShare('share');
    voiceStore.setScreenSharing(false);
    voiceStore.setCameraOn(false);
    voiceStore.setMuted(voiceStore.isMuted);
    voiceStore.setDeafened(voiceStore.isDeafened);
    voiceStore.applyModeration({ serverMuted: true, serverDeafened: false, permissionMuted: false });
  });
  assert.equal(painted.length, 0, 'nothing is painted while the background server owns the stores');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(painted.length, 9);
  assert.ok(painted.every((entry) => entry.foreground && entry.visibleStores),
    'every view update reads the server on screen');
});

test('the restrictions of the call arrive in a single notification', (context) => {
  servers(context);
  let notifications = 0;
  const off = appEvents.on('voice.state_updated', () => { notifications++; });
  context.after(off);

  voiceStore.applyModeration({ serverMuted: true, serverDeafened: true, permissionMuted: false });
  assert.equal(notifications, 1, 'one moderation update, one redraw');
  assert.deepEqual([voiceStore.serverMuted, voiceStore.serverDeafened, voiceStore.permissionMuted], [true, true, false]);
  voiceStore.setPermissionMuted(true);
  assert.equal(notifications, 2);
  assert.deepEqual([voiceStore.serverMuted, voiceStore.serverDeafened, voiceStore.permissionMuted], [true, true, true],
    'a single flag keeps the others');
});

/** Sockets that open and sign in only when told to. */
function fixtureSockets(context: TestContext) {
  class FixtureSocket {
    static readonly OPEN = 1;
    readyState = 0;
    sent: Array<{ type: MessageType; requestId: string }> = [];
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    constructor() { opened.push(this); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    open() {
      this.readyState = FixtureSocket.OPEN;
      this.onopen?.(new Event('open'));
    }
    drop() {
      this.readyState = 3;
      this.onclose?.(new Event('close'));
    }
    signIn() {
      const request = this.sent.find(message => message.type === MessageType.AUTH_CONNECT);
      this.onmessage?.(new MessageEvent('message', {
        data: JSON.stringify({ type: MessageType.AUTH_SUCCESS, requestId: request?.requestId, payload: {} }),
      }));
    }
  }
  const opened: FixtureSocket[] = [];
  const originals = (['WebSocket', 'window'] as const).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: FixtureSocket });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  context.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  return opened;
}

// A refused or cancelled automatic connection must not look like a server
// going away: views close their menus and dialogs on that, the microphone test
// stops and the automatic entry gives up (#490 review).
test('an attempt that never signed in and is not on screen leaves without a word', async (context) => {
  const opened = fixtureSockets(context);
  const { manager } = servers(context);
  const heard: string[] = [];
  const off = (['network.disconnected', 'session.changed', 'session.connections_changed'] as const)
    .map((name) => appEvents.on(name, () => heard.push(name)));
  context.after(() => off.forEach((unbind) => unbind()));
  const attempt = (session: ServerSession) => {
    const settled = session.client.connect(session.host, session.port, { clientId: 'self', publicKey: 'self-key' }, 'Self')
      .then(() => undefined, () => undefined);
    const socket = opened.at(-1);
    assert.ok(socket);
    return { socket, settled };
  };

  const refused = manager.create('refused.test', 5203, 'Self');
  const failing = attempt(refused);
  failing.socket.drop();
  await failing.settled;
  manager.remove(refused.key);
  assert.deepEqual(heard, ['session.connections_changed'], 'a refused attempt only takes its place off the rail');

  heard.length = 0;
  const unanswered = manager.create('cancelled.test', 5204, 'Self');
  const cancelled = attempt(unanswered);
  manager.remove(unanswered.key);
  await cancelled.settled;
  assert.deepEqual(heard, ['session.connections_changed'], 'cancelling one in the background is as quiet');

  heard.length = 0;
  const known = manager.create('known.test', 5205, 'Self');
  const signedIn = attempt(known);
  signedIn.socket.open();
  signedIn.socket.signIn();
  await signedIn.settled;
  assert.equal(known.client.getStatus(), 'CONNECTED');
  manager.remove(known.key);
  assert.deepEqual(heard, ['network.disconnected', 'session.connections_changed'],
    'a server it signed in to is gone, and the app must hear of it');

  const shown = manager.create('shown.test', 5206, 'Self');
  manager.activate(shown.key);
  const onScreen = attempt(shown);
  onScreen.socket.drop();
  await onScreen.settled;
  heard.length = 0;
  manager.remove(shown.key);
  assert.deepEqual(heard, ['network.disconnected', 'session.changed', 'session.connections_changed'],
    'an attempt on screen still takes the app back where it came from');
});
