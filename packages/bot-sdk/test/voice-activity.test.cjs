const assert = require('node:assert/strict');
const { test } = require('node:test');
const { performance } = require('node:perf_hooks');
const { MessageType } = require('@monky/shared');
const { BotVoiceConnection, SPEAKING_HANGOVER_MS } = require('../dist/voice/BotVoiceConnection');

const OPUS = Uint8Array.from([0xf8, 0xff, 0xfe]);
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(t, messages = [], channelId = 'voice', restriction = {}) {
  const self = {
    user: { id: 'bot', sessionId: 'bot:activity', isBot: true },
    voiceState: { sessionId: 'bot:activity', channelId, serverMuted: false, serverDeafened: false, ...restriction },
  };
  const errors = [];
  const voice = new BotVoiceConnection(channelId, {
    currentUser: self.user, server: { voiceMode: 'p2p' }, iceServers: [],
  }, {
    send(message) {
      messages.push(message);
      if (message.type === MessageType.VOICE_JOIN) queueMicrotask(() => voice.handle({
        type: MessageType.VOICE_USER_JOINED, requestId: message.requestId,
        payload: { ...self, channelId, sessionId: self.user.sessionId, participants: [self] },
      }));
      else if (message.type === MessageType.VOICE_LEAVE) queueMicrotask(() => voice.handle({
        type: MessageType.VOICE_USER_LEFT, requestId: message.requestId,
        payload: { channelId, sessionId: self.user.sessionId },
      }));
      else assert.equal(message.type, MessageType.VOICE_STATE_UPDATE);
    },
    participants() {}, disconnected() {}, error(error) { errors.push(error); },
  });
  await voice.join();
  t.after(() => voice.disconnect('test_finished'));
  const addPeer = (id = 'listener') => {
    const peer = {
      isReady: true, isClosed: false, writes: 0,
      write: async () => { peer.writes++; },
      close: async () => { peer.isReady = false; peer.isClosed = true; },
    };
    voice.peers.set(id, peer);
    return peer;
  };
  const restrict = (serverMuted, serverDeafened = false) => voice.handle({
    type: MessageType.VOICE_STATE_CHANGED, payload: { voiceState: { ...self.voiceState, serverMuted, serverDeafened } },
  });
  const notifyRestriction = (serverMuted, serverDeafened = false, userId = self.user.id) => voice.handle({
    type: MessageType.VOICE_RESTRICTIONS_UPDATED, payload: { userId, serverMuted, serverDeafened },
  });
  const updates = () => messages.filter(message => message.type === MessageType.VOICE_STATE_UPDATE).map(message => message.payload);
  return { voice, messages, errors, addPeer, restrict, notifyRestriction, updates };
}

function clock(t) {
  let now = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  return async ms => { now += ms; t.mock.timers.tick(ms); await turn(); };
}

test('normal bot join is unmuted and undeafened, and roster/unsent/invalid audio never announces speaking', async t => {
  const f = await fixture(t);
  assert.equal(f.messages[0].payload.isMuted, false);
  assert.equal(f.messages[0].payload.isDeafened, false);
  await f.voice.writeOpus(OPUS);
  await assert.rejects(f.voice.writeOpus(new Uint8Array(0)), /raw Opus/);
  await assert.rejects(f.voice.writeOpus(Uint8Array.of(0x80, 0)), /20 ms/);
  const peer = f.addPeer();
  peer.isReady = false;
  await f.voice.writeOpus(OPUS);
  assert.equal(peer.writes, 0);
  assert.deepEqual(f.updates(), []);
  await f.voice.close();
  assert.deepEqual(f.updates(), []);
  assert.deepEqual(f.errors, []);
});

test('normal join preferences do not override administrative restrictions already present on admission', async t => {
  for (const restriction of [{ serverMuted: true }, { serverDeafened: true }]) {
    const f = await fixture(t, [], 'voice', restriction);
    const peer = f.addPeer();
    await f.voice.writeOpus(OPUS);
    assert.equal(peer.writes, 0);
    assert.deepEqual(f.updates(), []);
    assert.equal(f.messages[0].payload.isMuted, false);
    assert.equal(f.messages[0].payload.isDeafened, false);
    f.restrict(false, false);
    assert.deepEqual(f.updates(), []);
    await f.voice.writeOpus(OPUS);
    assert.deepEqual(f.updates(), [{ isSpeaking: true }]);
    await f.voice.close();
  }
});

test('continuous transmission emits one speaking edge and one bounded last-packet idle edge', async t => {
  const f = await fixture(t);
  const advance = clock(t);
  const peer = f.addPeer();
  for (let i = 0; i < 100; i++) {
    await f.voice.writeOpus(OPUS);
    await advance(20);
  }
  assert.equal(peer.writes, 100);
  assert.deepEqual(f.updates(), [{ isSpeaking: true }], 'Never send a state update per Opus packet.');
  await advance(SPEAKING_HANGOVER_MS - 21);
  assert.deepEqual(f.updates(), [{ isSpeaking: true }]);
  await assert.rejects(f.voice.writeOpus(Uint8Array.of(0x80, 0)), /20 ms/);
  await advance(1);
  assert.deepEqual(f.updates(), [{ isSpeaking: true }, { isSpeaking: false }]);
  await advance(10000);
  assert.equal(f.updates().length, 2);
});

test('manual pause and admin mute/deafen end speaking immediately, without self-mute preference updates', async t => {
  const f = await fixture(t);
  const advance = clock(t);
  const peer = f.addPeer();
  await f.voice.writeOpus(OPUS);
  f.voice.stopSpeaking();
  f.voice.stopSpeaking();
  assert.deepEqual(f.updates(), [{ isSpeaking: true }, { isSpeaking: false }]);
  await advance(SPEAKING_HANGOVER_MS * 2);
  assert.equal(f.updates().length, 2);
  for (const restricted of [[true, false], [false, true]]) {
    await f.voice.writeOpus(OPUS);
    f.restrict(...restricted);
    assert.deepEqual(f.updates().at(-1), { isSpeaking: false });
    const count = peer.writes;
    for (let i = 0; i < 20; i++) await f.voice.writeOpus(OPUS);
    await assert.rejects(f.voice.writeOpus(new Uint8Array(0)), /raw Opus/);
    assert.equal(peer.writes, count);
    const updateCount = f.updates().length;
    f.restrict(false, false);
    await advance(SPEAKING_HANGOVER_MS * 2);
    assert.equal(f.updates().length, updateCount, 'Unmute is not proof of new transmission.');
  }
  assert.ok(f.updates().every(payload => Object.keys(payload).join() === 'isSpeaking'));
  assert.deepEqual(f.errors, []);
});

test('identity restrictions suppress audio immediately without waiting for the voice roster broadcast', async t => {
  const f = await fixture(t);
  clock(t);
  const peer = f.addPeer();
  for (const restricted of [[true, false], [false, true]]) {
    await f.voice.writeOpus(OPUS);
    f.notifyRestriction(...restricted, 'another-bot');
    await f.voice.writeOpus(OPUS);
    assert.deepEqual(f.updates().at(-1), { isSpeaking: true });
    const writes = peer.writes;
    f.notifyRestriction(...restricted);
    assert.deepEqual(f.updates().at(-1), { isSpeaking: false });
    await f.voice.writeOpus(OPUS);
    assert.equal(peer.writes, writes, 'The targeted policy notification already stops transmission.');
    f.notifyRestriction(false, false);
    assert.deepEqual(f.updates().at(-1), { isSpeaking: false }, 'Unmute alone does not announce activity.');
  }
  await f.voice.writeOpus(OPUS);
  assert.deepEqual(f.updates().at(-1), { isSpeaking: true });
  assert.deepEqual(f.errors, []);
});

test('pause or moderation while a send is pending cannot resurrect stale activity on completion', async t => {
  const f = await fixture(t);
  const advance = clock(t);
  const peer = f.addPeer();
  for (const cancel of [
    () => f.voice.stopSpeaking(),
    () => { f.restrict(true); f.restrict(false); },
    () => { f.notifyRestriction(true); f.notifyRestriction(false); },
  ]) {
    const gate = deferred();
    peer.write = () => gate.promise;
    const writing = f.voice.writeOpus(OPUS);
    cancel();
    gate.resolve();
    await writing;
    await advance(SPEAKING_HANGOVER_MS * 2);
    assert.deepEqual(f.updates(), []);
  }
  peer.write = async () => {};
  await f.voice.writeOpus(OPUS);
  assert.deepEqual(f.updates(), [{ isSpeaking: true }]);
});

test('a failed or departed peer cannot announce speaking; healthy recipients retain activity', async t => {
  const f = await fixture(t);
  clock(t);
  const old = f.addPeer();
  const gate = deferred();
  old.write = () => gate.promise;
  const writing = f.voice.writeOpus(OPUS);
  f.voice.peers.delete('listener');
  await old.close();
  const current = f.addPeer();
  gate.resolve();
  await writing;
  assert.deepEqual(f.updates(), []);
  await f.voice.writeOpus(OPUS);
  const broken = f.addPeer('broken');
  broken.write = async () => { throw new Error('Peer send failed.'); };
  await f.voice.writeOpus(OPUS);
  assert.deepEqual(f.updates(), [{ isSpeaking: true }]);
  assert.equal(f.errors.length, 1);
  assert.equal(current.isReady, true);
  f.voice.handle({
    type: MessageType.VOICE_USER_LEFT, payload: { channelId: 'voice', sessionId: 'listener' },
  });
  assert.deepEqual(f.updates().at(-1), { isSpeaking: false });
  assert.equal(f.voice.isClosed, false);
});

test('a wholly failed send is explicit and never produces a speaking edge', async t => {
  const f = await fixture(t);
  const peer = f.addPeer();
  peer.write = async () => { throw new Error('SRTP failed.'); };
  await assert.rejects(f.voice.writeOpus(OPUS), /SRTP failed/);
  assert.deepEqual(f.updates(), []);
  assert.equal(f.errors.length, 1);
});

test('close sends the final false before leave; retired timers and sends cannot affect a new connection', async t => {
  const messages = [];
  const f = await fixture(t, messages);
  const advance = clock(t);
  const timers = [];
  const setTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, delay, ...args) => {
    if (delay === SPEAKING_HANGOVER_MS) timers.push(callback);
    return setTimeout(callback, delay, ...args);
  });
  const peer = f.addPeer();
  await f.voice.writeOpus(OPUS);
  const gate = deferred();
  peer.write = () => gate.promise;
  const writing = f.voice.writeOpus(OPUS);
  await f.voice.close();
  assert.deepEqual(messages.slice(-2).map(message => [message.type, message.payload.isSpeaking]), [
    [MessageType.VOICE_STATE_UPDATE, false], [MessageType.VOICE_LEAVE, undefined],
  ]);
  const next = await fixture(t, messages, 'new-voice');
  next.addPeer();
  await next.voice.writeOpus(OPUS);
  const count = messages.length;
  timers[0]();
  gate.resolve();
  await writing;
  assert.equal(messages.length, count);
  assert.deepEqual(next.updates().at(-1), { isSpeaking: true });
  await next.voice.close();
  const closedCount = messages.length;
  await advance(SPEAKING_HANGOVER_MS * 2);
  assert.equal(messages.length, closedCount);
});

test('signaling loss cancels speaking without late wire updates or a new departure request', async t => {
  const f = await fixture(t);
  const advance = clock(t);
  f.addPeer();
  await f.voice.writeOpus(OPUS);
  const count = f.messages.length;
  await f.voice.disconnect('socket_lost');
  await advance(SPEAKING_HANGOVER_MS * 2);
  assert.equal(f.messages.length, count);
  assert.equal(f.voice.speaking, false);
  assert.equal(f.voice.speakingTimer, undefined);
});

test('activity publication errors are bounded and explicit without failing transmitted audio', async t => {
  const f = await fixture(t);
  const advance = clock(t);
  const peer = f.addPeer();
  const send = f.voice.callbacks.send;
  f.voice.callbacks.send = message => {
    if (message.type === MessageType.VOICE_STATE_UPDATE) throw new Error('Status signaling unavailable.');
    send(message);
  };
  for (let i = 0; i < 50; i++) await f.voice.writeOpus(OPUS);
  assert.equal(peer.writes, 50);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /Voice activity signaling failed/);
  assert.equal(f.voice.isClosed, false);
  await advance(SPEAKING_HANGOVER_MS);
  assert.equal(f.errors.length, 2);
  await f.voice.close();
});
