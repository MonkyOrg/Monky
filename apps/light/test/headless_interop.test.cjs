const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const path = require('node:path');
const { test } = require('node:test');
const { MessageType, Permission, ProtocolErrorCode, rtcSignalSchema } = require('@monky/shared');
const { NativeClient } = require('./native_client.cjs');
const { nativeExecutable } = require('./native_test_paths.cjs');
const { createServerFixture } = require('./server_fixture.cjs');

async function until(predicate, message, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// Total energy a client has played of one participant's microphone (inbound-rtp).
async function inboundEnergy(client, sessionId) {
  const since = client.events.length;
  await client.state();
  const event = await client.wait(value => value.event === 'media-stats' && value.sessionId === sessionId &&
    Array.isArray(value.stats), since);
  const report = event.stats.find(value => value.type === 'inbound-rtp' && value.kind === 'audio');
  assert.ok(report, `No received microphone from ${sessionId}`);
  return report.totalAudioEnergy ?? 0;
}

test('native app supports Unicode password/profile, idle heartbeat and stable identity without opening audio', { timeout: 30_000 }, async t => {
  const password = 'fixture-\u00e1-only';
  const fixture = await createServerFixture(t, { password });
  const admin = await fixture.connectHuman('Fixture admin');
  const options = {
    nickname: 'Native', password, synthetic: false,
    profile: path.join(fixture.directory, 'profile-\u00e1'),
  };
  const first = new NativeClient(fixture, options);
  const auth = await first.wait('authenticated');
  const idle = await first.state();
  assert.equal(idle.phase, 'ready');
  assert.equal(idle.mediaActive, false);
  assert.equal(idle.audioDevice, null);
  assert.ok(auth.channels.some(channel => channel.type === 'VOICE'));
  assert.equal((await first.command('not-a-command')).event, 'command-error');
  await new Promise(resolve => setTimeout(resolve, 13_000));
  const stillIdle = await first.state();
  assert.equal(stillIdle.phase, 'ready');
  assert.equal(stillIdle.connection, idle.connection, 'Healthy idle client must answer heartbeat without reconnecting');
  assert.equal(stillIdle.mediaActive, false);
  await first.close();
  await admin.peer.wait(message => message.type === MessageType.USER_LEFT && message.payload.userId === auth.userId,
    0, 1000);
  const second = new NativeClient(fixture, options);
  const again = await second.wait('authenticated');
  assert.equal(again.userId, auth.userId);
  assert.equal(again.sessionId, auth.sessionId);
  assert.equal((await second.state()).mediaActive, false);
  await second.close();
});

for (const voiceMode of ['p2p', 'sfu']) {
  test(`headless clients exchange real ${voiceMode} decoded PCM through the Monky server`, { timeout: 75_000 }, async t => {
    const fixture = await createServerFixture(t, { voiceMode });
    const admin = await fixture.connectHuman('Fixture admin');
    const alice = new NativeClient(fixture, { nickname: 'Light Alice' });
    const bob = new NativeClient(fixture, { nickname: 'Light Bob' });
    const auth = await alice.wait('authenticated');
    await bob.wait('authenticated');
    const channelId = auth.channels.find(channel => channel.type === 'VOICE').id;
    await alice.join(channelId);
    const alone = await alice.state();
    if (voiceMode === 'p2p') assert.equal(alone.audioDevice.recording, false, 'An unused P2P microphone must stay stopped');
    await bob.join(channelId);
    for (const client of [alice, bob]) {
      const state = await client.untilState(value => value.audioDevice.nonzeroPlayoutCallbacks >= 25,
        'Bidirectional decoded audio did not arrive');
      assert.ok(state.audioDevice.outputRms > 0.00001);
      assert.equal(state.audioDevice.recordingErrors, 0);
      assert.equal(state.audioDevice.playoutErrors, 0);
      assert.equal(state.audioDevice.runningDevices, 1);
      assert.equal(state.voiceMode, voiceMode);
    }

    await alice.command('mute', { enabled: true });
    const muted = await alice.untilState(value => !value.audioDevice.recording && value.policy.muted,
      'Mute did not stop native capture');
    const stillReceiving = await alice.untilState(value => value.audioDevice.outputEnergy > muted.audioDevice.outputEnergy + 0.1,
      'Mute incorrectly stopped receiving audio');
    assert.equal(stillReceiving.audioDevice.recordingCallbacks, muted.audioDevice.recordingCallbacks);
    await alice.command('deafen', { enabled: true });
    const deafened = await alice.untilState(value => value.audioDevice.runningDevices === 0 && value.policy.deafened,
      'Deafen did not stop both device directions');
    await new Promise(resolve => setTimeout(resolve, 120));
    const inactive = await alice.state();
    assert.equal(inactive.audioDevice.recordingCallbacks, deafened.audioDevice.recordingCallbacks);
    assert.equal(inactive.audioDevice.playoutCallbacks, deafened.audioDevice.playoutCallbacks);
    await alice.command('deafen', { enabled: false });
    await alice.command('mute', { enabled: false });
    await alice.untilState(value => value.audioDevice.recording && value.audioDevice.playing,
      'Unmute/undeafen did not restore native audio');

    await admin.peer.request(MessageType.ADMIN_MUTE_USER, { targetUserId: auth.userId, muted: true },
      [MessageType.VOICE_RESTRICTIONS_UPDATED]);
    await alice.untilState(value => value.policy.serverMuted && !value.audioDevice.recording,
      'Server moderation did not stop physical capture');
    await alice.command('mute', { enabled: false });
    const restricted = await alice.state();
    assert.equal(restricted.policy.serverMuted, true);
    assert.equal(restricted.audioDevice.recording, false);
    await admin.peer.request(MessageType.ADMIN_MUTE_USER, { targetUserId: auth.userId, muted: false },
      [MessageType.VOICE_RESTRICTIONS_UPDATED]);
    await alice.untilState(value => !value.policy.serverMuted && value.audioDevice.recording,
      'Removing server moderation did not restore capture');
    await admin.peer.request(MessageType.ADMIN_DEAFEN_USER, { targetUserId: auth.userId, deafened: true },
      [MessageType.VOICE_RESTRICTIONS_UPDATED]);
    await alice.untilState(value => value.policy.serverDeafened && value.audioDevice.runningDevices === 0,
      'Server deafen did not stop capture and playback');
    await alice.command('deafen', { enabled: false });
    assert.equal((await alice.state()).audioDevice.runningDevices, 0);
    await admin.peer.request(MessageType.ADMIN_DEAFEN_USER, { targetUserId: auth.userId, deafened: false },
      [MessageType.VOICE_RESTRICTIONS_UPDATED]);
    await alice.untilState(value => !value.policy.serverDeafened && value.audioDevice.recording && value.audioDevice.playing,
      'Removing server deafen did not restore both audio directions');

    const charlie = new NativeClient(fixture, { nickname: 'Light Charlie' });
    const charlieAuth = await charlie.wait('authenticated');
    const bobAuth = bob.events.find(event => event.event === 'authenticated');
    await charlie.join(channelId);
    for (const client of [alice, bob, charlie]) {
      await client.untilState(value => value.participants === 3, 'Third participant was not reconciled');
      const self = client.events.find(event => event.event === 'authenticated');
      for (const peer of [auth, bobAuth, charlieAuth]) {
        if (peer.sessionId !== self.sessionId) await client.decodedFrom(peer.sessionId);
      }
    }

    const channelsSince = alice.events.length;
    const room = await admin.peer.request(MessageType.CHANNEL_CREATE, { name: 'Other', type: 'VOICE' },
      [MessageType.CHANNEL_CREATED]);
    const otherChannelId = room.payload.channel.id;
    // An interface has to be told the list changed; it must not poll the state.
    const announced = await alice.wait(event => event.event === 'channels-changed' &&
      event.channels.some(channel => channel.id === otherChannelId), channelsSince);
    assert.ok(announced.channels.every(channel => channel.serverId && channel.type),
      'The announced channel list must carry the same shape the snapshot does');
    await alice.untilState(value => value.channels.some(channel => channel.id === otherChannelId),
      'New channel was not reflected in native state');
    await alice.join(otherChannelId);
    await alice.untilState(value => value.retiringMedia === 0 && value.participants === 1,
      'Room switch did not retire the old call');
    await bob.untilState(value => value.participants === 2, 'Room switch left a stale participant');
    await bob.decodedFrom(charlieAuth.sessionId);
    await charlie.decodedFrom(bobAuth.sessionId);

    const beforeReconnect = await bob.state();
    const reconnectSince = bob.events.length;
    await bob.command('reconnect');
    const reauthenticated = await bob.wait('authenticated', reconnectSince);
    assert.equal(reauthenticated.sessionId, bobAuth.sessionId);
    await bob.wait('voice-admitted', reconnectSince);
    await bob.untilState(value => value.connection > beforeReconnect.connection && value.retiringMedia === 0 &&
      value.audioDevice.nonzeroPlayoutCallbacks > 25, 'Reconnect did not restore decoded audio in the previous room');
    await charlie.decodedFrom(bobAuth.sessionId);

    const kickSince = bob.events.length;
    await admin.peer.request(MessageType.ADMIN_KICK_VOICE, { targetSessionId: bobAuth.sessionId },
      [MessageType.ADMIN_KICK_VOICE]);
    await bob.wait('kicked', kickSince);
    const kicked = await bob.untilState(value => value.phase === 'ready' && value.retiringMedia === 0 &&
      value.audioDevice.runningDevices === 0, 'Voice kick did not retire native resources');
    const afterKick = bob.events.length;
    await bob.command('reconnect');
    await bob.wait('authenticated', afterKick);
    await new Promise(resolve => setTimeout(resolve, 150));
    const notRejoined = await bob.state();
    assert.equal(notRejoined.phase, 'ready', 'Kicked users must not automatically rejoin');
    assert.equal(notRejoined.audioDevice.createdDevices, kicked.audioDevice.createdDevices);

    await admin.peer.request(MessageType.CHANNEL_DELETE, { channelId },
      [MessageType.CHANNEL_DELETED]);
    await charlie.untilState(value => value.phase === 'ready' && value.retiringMedia === 0 &&
      value.audioDevice.runningDevices === 0, 'Channel removal did not retire its native call');
    await charlie.close();

    await alice.command('leave');
    await alice.untilState(value => value.phase === 'ready' && value.retiringMedia === 0 &&
      value.audioDevice.runningDevices === 0, 'Leaving did not release audio resources');
    await alice.close();
    await bob.close();
  });
}

test('native calls survive both live P2P/SFU topology transitions and preserve moderation', { timeout: 60_000 }, async t => {
  const fixture = await createServerFixture(t);
  const admin = await fixture.connectHuman('Fixture admin');
  const alice = new NativeClient(fixture, { nickname: 'Light Alice' });
  const bob = new NativeClient(fixture, { nickname: 'Light Bob' });
  const auth = await alice.wait('authenticated');
  const bobAuth = await bob.wait('authenticated');
  const channelId = auth.channels.find(channel => channel.type === 'VOICE').id;
  await alice.join(channelId);
  await bob.join(channelId);
  await alice.decodedFrom(bobAuth.sessionId);
  await admin.peer.request(MessageType.ADMIN_MUTE_USER, { targetUserId: auth.userId, muted: true },
    [MessageType.VOICE_RESTRICTIONS_UPDATED]);

  for (const mode of ['sfu', 'p2p']) {
    const since = alice.events.length;
    await admin.peer.request(MessageType.SERVER_UPDATE_SETTINGS, { voiceMode: mode },
      [MessageType.SERVER_SETTINGS_UPDATED]);
    await alice.wait(event => event.event === 'voice-admitted' && event.voiceMode === mode, since);
    const state = await alice.untilState(value => value.voiceMode === mode && value.phase === 'admitted' &&
      value.retiringMedia === 0 && value.audioDevice.nonzeroPlayoutCallbacks > 25,
    'Topology switch did not restore decoded remote audio');
    assert.equal(state.channelId, channelId);
    assert.equal(state.participants, 2);
    assert.equal(state.policy.serverMuted, true);
    assert.equal(state.audioDevice.recording, false);
    await alice.decodedFrom(bobAuth.sessionId);
  }
  await admin.peer.request(MessageType.ADMIN_MUTE_USER, { targetUserId: auth.userId, muted: false },
    [MessageType.VOICE_RESTRICTIONS_UPDATED]);
  await bob.decodedFrom(auth.sessionId);
  await alice.close();
  await bob.close();
});

test('native authentication failure is explicit and never starts media', { timeout: 15_000 }, async t => {
  const fixture = await createServerFixture(t, { password: 'correct-fixture-password' });
  const client = new NativeClient(fixture, { nickname: 'Wrong password', password: 'wrong-fixture-password' });
  await client.wait('session-error');
  assert.deepEqual(await client.closed, { code: 1, signal: null });
  assert.equal(client.events.some(event => event.event === 'authenticated' || event.event === 'media-initialized'), false);
});

test('a malformed P2P offer retires only its peer, not the healthy call', { timeout: 30_000 }, async t => {
  const fixture = await createServerFixture(t);
  const sender = await fixture.connectHuman('Broken signal');
  const alice = new NativeClient(fixture, { nickname: 'Light Alice' });
  const bob = new NativeClient(fixture, { nickname: 'Light Bob' });
  const auth = await alice.wait('authenticated');
  const bobAuth = await bob.wait('authenticated');
  const channelId = auth.channels.find(channel => channel.type === 'VOICE').id;
  await alice.join(channelId);
  await bob.join(channelId);
  await alice.decodedFrom(bobAuth.sessionId);
  await sender.peer.request(MessageType.VOICE_JOIN, { channelId, isMuted: true, isDeafened: true },
    [MessageType.VOICE_USER_JOINED]);
  await alice.untilState(value => value.participants === 3, 'Malformed-offer sender was not admitted');
  const since = alice.events.length;
  alice.expectedPeerFailures.add(sender.auth.currentUser.sessionId);
  sender.peer.send(MessageType.RTC_SIGNAL, rtcSignalSchema.parse({
    fromSessionId: sender.auth.currentUser.sessionId, targetSessionId: auth.sessionId,
    signalType: 'offer', subscriptionId: randomUUID(), sdp: { type: 'offer', sdp: 'not a valid SDP description' },
  }));
  const failed = await alice.wait('media-error', since);
  assert.equal(failed.sessionId, sender.auth.currentUser.sessionId);
  const before = await alice.state();
  assert.equal(before.phase, 'admitted');
  await alice.untilState(value => value.audioDevice.outputEnergy > before.audioDevice.outputEnergy + 0.1,
    'One invalid peer interrupted the healthy microphone');
  await bob.decodedFrom(auth.sessionId);
});

test('microphone authorization is on demand; denial or an unanswered prompt preserves receiving and quit', { timeout: 45_000 }, async t => {
  const fixture = await createServerFixture(t, { voiceMode: 'sfu' });
  const speaker = new NativeClient(fixture, { nickname: 'Speaker' });
  const auth = await speaker.wait('authenticated');
  const channelId = auth.channels.find(channel => channel.type === 'VOICE').id;
  await speaker.join(channelId);
  for (const access of ['granted', 'denied', 'restricted', 'pending']) {
    const receiver = new NativeClient(fixture, { nickname: `Permission ${access}`, microphoneAccess: access, muted: true });
    await receiver.wait('authenticated');
    assert.equal((await receiver.state()).audioDevice.permissionRequests, 0);
    await receiver.join(channelId);
    const initial = await receiver.untilState(value => value.audioDevice.nonzeroPlayoutCallbacks >= 25,
      'Muted entry must allow received audio without microphone authorization');
    assert.equal(initial.audioDevice.permissionRequests, 0);
    assert.equal(initial.audioDevice.recordingCallbacks, 0);
    await receiver.command('mute', { enabled: false });
    const state = await receiver.untilState(value => value.audioDevice.permissionRequests === 1 &&
      (access === 'granted' ? value.audioDevice.recording :
        access === 'pending' ? value.microphoneAccessPending : value.policy.muted),
    'Microphone access result was not applied');
    if (access !== 'granted') {
      assert.equal(state.audioDevice.recordingCallbacks, 0);
      await receiver.untilState(value => value.audioDevice.outputEnergy > state.audioDevice.outputEnergy + 0.1,
        'Waiting for microphone access must not suspend remote playback');
    }
    await receiver.close();
  }
});

test('quit, EOF, and transport closure during logout retire the native application', { timeout: 45_000 }, async t => {
  const fixture = await createServerFixture(t);
  for (const action of ['quit', 'eof', 'disconnect-and-quit']) {
    const client = new NativeClient(fixture, { nickname: `Close ${action}` });
    await client.wait('authenticated');
    const command = action === 'eof' ? '' : action === 'quit'
      ? '{"command":"quit"}\n'
      : '{"command":"reconnect"}\n{"command":"quit"}\n';
    client.child.stdin.end(command);
    assert.deepEqual(await client.closed, { code: 0, signal: null });
    assert.ok(client.events.some(event => event.event === 'stopped'));
  }
});

test('a native call follows a move into a room it cannot see, but a client that hung up follows none', { timeout: 45_000 }, async t => {
  const { VoiceSessionHandler } = require('../../server/dist/infrastructure/websocket/voice/VoiceSessionHandler.js');
  const follow = VoiceSessionHandler.FOLLOW_MOVE_MS;
  VoiceSessionHandler.FOLLOW_MOVE_MS = 500;
  t.after(() => { VoiceSessionHandler.FOLLOW_MOVE_MS = follow; });
  const fixture = await createServerFixture(t);
  const admin = await fixture.connectHuman('Fixture admin');
  const light = new NativeClient(fixture, { nickname: 'Moved Light' });
  const auth = await light.wait('authenticated');
  const lobbyId = auth.channels.find(channel => channel.type === 'VOICE').id;
  // Managers only: the client is shown it only while the server keeps it inside.
  const created = await admin.peer.request(MessageType.CHANNEL_CREATE,
    { name: 'Managers', type: 'VOICE', isPrivate: true, allowedRoleIds: [] }, [MessageType.CHANNEL_CREATED]);
  const hiddenId = created.payload.channel.id;
  const wsServer = fixture.server.wsServer;
  const room = () => wsServer.signalingService.getVoiceState(auth.sessionId)?.channelId;
  const move = channelId => admin.peer.request(MessageType.ADMIN_MOVE_USER,
    { targetSessionId: auth.sessionId, channelId }, [MessageType.ADMIN_MOVE_USER]);

  // In a call, the client follows by leaving the old room and joining the new
  // one: the server holds that leave for the join right behind it.
  await light.join(lobbyId);
  let since = light.events.length;
  await move(hiddenId);
  await light.wait(event => event.event === 'voice-admitted' && event.channelId === hiddenId, since);
  await new Promise(resolve => setTimeout(resolve, VoiceSessionHandler.FOLLOW_MOVE_MS * 3));
  assert.equal(room(), hiddenId, 'Following the move took the client out of the call');
  assert.equal((await light.state()).phase, 'admitted');

  // Hanging up as a move goes out: the server reads the move first, so it
  // reaches a client that already left. Followed, it would start a new call.
  await light.join(lobbyId);
  const voice = wsServer.voiceSessions;
  const handle = voice.handle;
  let crossed = false;
  voice.handle = async function (session, type, payload, requestId) {
    if (!crossed && type === MessageType.VOICE_LEAVE && session.sessionId === auth.sessionId) {
      crossed = true;
      await move(hiddenId);
    }
    return handle.call(this, session, type, payload, requestId);
  };
  t.after(() => { delete voice.handle; });
  since = light.events.length;
  const adminSince = admin.peer.messages.length;
  assert.equal((await light.command('leave')).event, 'command-accepted');
  // Its own join would be announced without the move's request ID.
  const outcome = await admin.peer.wait(message => message.payload?.sessionId === auth.sessionId &&
    message.payload.channelId === hiddenId && (message.type === MessageType.VOICE_USER_LEFT ||
      (message.type === MessageType.VOICE_USER_JOINED && message.requestId === undefined)), adminSince);
  assert.ok(crossed, 'The move did not cross the leave');
  assert.equal(outcome.type, MessageType.VOICE_USER_LEFT, 'The client that hung up followed the move into a call');
  assert.equal(room(), undefined);
  assert.equal(light.events.slice(since).some(event => event.event === 'voice-admitted'), false);
  const state = await light.state();
  assert.equal(state.phase, 'ready');
  assert.equal(state.mediaActive, false);
  await light.close();
});

// Two moves inside one round trip, into rooms the client sees or not. Its
// answers are held until both moves are done, so they cross them. The first
// join names the move the second overtook, and the server refuses it (#841).
async function crossTwoMoves(t, visible) {
  const fixture = await createServerFixture(t);
  const admin = await fixture.connectHuman('Fixture admin');
  const light = new NativeClient(fixture, { nickname: 'Twice moved Light' });
  const auth = await light.wait('authenticated');
  const lobbyId = auth.channels.find(channel => channel.type === 'VOICE').id;
  const rooms = [];
  for (const [index, name] of ['Managers', 'Board'].entries()) {
    const created = await admin.peer.request(MessageType.CHANNEL_CREATE,
      { name, type: 'VOICE', isPrivate: !visible[index], allowedRoleIds: [] }, [MessageType.CHANNEL_CREATED]);
    rooms.push(created.payload.channel.id);
  }
  await light.join(lobbyId);
  const wsServer = fixture.server.wsServer;
  const voice = wsServer.voiceSessions;
  const handle = voice.handle;
  const sent = [];
  let release;
  const crossed = new Promise(resolve => { release = resolve; });
  voice.handle = async function (session, type, payload, requestId) {
    if (session.sessionId === auth.sessionId) {
      sent.push(type);
      await crossed;
    }
    return handle.call(this, session, type, payload, requestId);
  };
  t.after(() => {
    release();
    delete voice.handle;
  });
  const since = light.events.length;
  for (const channelId of rooms) {
    await admin.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: auth.sessionId, channelId },
      [MessageType.ADMIN_MOVE_USER]);
  }
  release();
  return { light, rooms, sent, since, room: () => wsServer.signalingService.getVoiceState(auth.sessionId)?.channelId };
}

for (const visible of [false, true]) {
  test(`two moves inside one round trip, into rooms it ${visible ? 'sees' : 'cannot see'}, leave the native call in the last room, and no leave is sent`, { timeout: 45_000 }, async t => {
    const { light, rooms, sent, since, room } = await crossTwoMoves(t, [visible, visible]);
    await light.wait(event => event.event === 'voice-admitted' && event.channelId === rooms[1], since);
    assert.equal(sent.includes(MessageType.VOICE_LEAVE), false, 'Following a move named the room it left');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(room(), rooms[1], 'The crossed moves took the client out of the call');
    const state = await light.state();
    assert.equal(state.phase, 'admitted');
    assert.equal(state.channelId, rooms[1]);
    assert.equal(light.events.slice(since).some(event => event.event === 'session-error'), false,
      'The refused join that the second move replaced reached the interface');
    await light.close();
  });
}

test('two moves inside one round trip, into a room it sees and then one it cannot, leave the native call in the last room (#841)', { timeout: 45_000 }, async t => {
  // Each join names the move it follows: the server refuses the one the second
  // move overtook instead of admitting it into the room it sees, which would
  // pull the membership out of the hidden room the second join then needs.
  const { light, rooms, sent, since, room } = await crossTwoMoves(t, [true, false]);
  await light.wait(event => event.event === 'voice-admitted' && event.channelId === rooms[1], since);
  assert.equal(sent.includes(MessageType.VOICE_LEAVE), false, 'Following a move named the room it left');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(room(), rooms[1], 'The overtaken join took the client out of the last room');
  const state = await light.state();
  assert.equal(state.phase, 'admitted');
  assert.equal(state.channelId, rooms[1]);
  assert.equal(light.events.slice(since).some(event => event.event === 'session-error'), false,
    'The refusal of the overtaken join reached the interface');
  await light.close();
});

test('a kick that crosses the join behind a move leaves no membership on the server', { timeout: 45_000 }, async t => {
  // The kick ends the move the join follows, so the server refuses that join
  // as overtaken (#841) instead of admitting a client that gave it up.
  const fixture = await createServerFixture(t);
  const admin = await fixture.connectHuman('Fixture admin');
  const light = new NativeClient(fixture, { nickname: 'Kicked while moved' });
  const auth = await light.wait('authenticated');
  const lobbyId = auth.channels.find(channel => channel.type === 'VOICE').id;
  const created = await admin.peer.request(MessageType.CHANNEL_CREATE,
    { name: 'Stage', type: 'VOICE', isPrivate: false, allowedRoleIds: [] }, [MessageType.CHANNEL_CREATED]);
  await light.join(lobbyId);
  const wsServer = fixture.server.wsServer;
  const room = () => wsServer.signalingService.getVoiceState(auth.sessionId)?.channelId;
  // The join that follows the move is held until the kick is done.
  const voice = wsServer.voiceSessions;
  const handle = voice.handle;
  const sent = [];
  const handled = [];
  let release;
  const kicked = new Promise(resolve => { release = resolve; });
  voice.handle = async function (session, type, payload, requestId) {
    if (session.sessionId === auth.sessionId) {
      sent.push(type);
      await kicked;
      try {
        return await handle.call(this, session, type, payload, requestId);
      } finally {
        handled.push(type);
      }
    }
    return handle.call(this, session, type, payload, requestId);
  };
  t.after(() => {
    release();
    delete voice.handle;
  });
  const since = light.events.length;
  await admin.peer.request(MessageType.ADMIN_MOVE_USER,
    { targetSessionId: auth.sessionId, channelId: created.payload.channel.id }, [MessageType.ADMIN_MOVE_USER]);
  await until(() => sent.includes(MessageType.VOICE_JOIN), 'The client did not follow the move');
  await admin.peer.request(MessageType.ADMIN_KICK_VOICE, { targetSessionId: auth.sessionId },
    [MessageType.ADMIN_KICK_VOICE]);
  await light.wait('kicked', since);
  release();
  await until(() => handled.includes(MessageType.VOICE_JOIN), 'The server never answered the crossed join', 5000);
  assert.equal(room(), undefined, 'The server admitted the join a kick had overtaken');
  assert.equal(light.events.slice(since).some(event => event.event === 'session-error'), false,
    'The refusal of the overtaken join reached the interface');
  const state = await light.state();
  assert.equal(state.phase, 'ready');
  assert.equal(state.mediaActive, false);
  await light.close();
});

test('leaving and joining the same room inside one round trip ends inside it on both sides', { timeout: 45_000 }, async t => {
  const fixture = await createServerFixture(t);
  const light = new NativeClient(fixture, { nickname: 'Back at once' });
  const auth = await light.wait('authenticated');
  const channelId = auth.channels.find(channel => channel.type === 'VOICE').id;
  await light.join(channelId);
  const wsServer = fixture.server.wsServer;
  const room = () => wsServer.signalingService.getVoiceState(auth.sessionId)?.channelId;
  // The departure of the stay that ends is held until the new join reaches the
  // server, and goes out before it is processed: the client hears of it while
  // that join waits for its answer, in the order the server keeps.
  const send = wsServer.send;
  let held;
  let crossed = false;
  wsServer.send = function (ws, message, frames) {
    if (!crossed && message.type === MessageType.VOICE_USER_LEFT && message.payload.sessionId === auth.sessionId &&
        ws === wsServer.sessionSockets.get(auth.sessionId)) {
      crossed = true;
      held = () => send.call(this, ws, message, frames);
      return;
    }
    return send.call(this, ws, message, frames);
  };
  const voice = wsServer.voiceSessions;
  const handle = voice.handle;
  voice.handle = async function (session, type, payload, requestId) {
    if (held && type === MessageType.VOICE_JOIN && session.sessionId === auth.sessionId) {
      const release = held;
      held = undefined;
      release();
    }
    return handle.call(this, session, type, payload, requestId);
  };
  t.after(() => {
    delete wsServer.send;
    delete voice.handle;
  });
  const since = light.events.length;
  light.child.stdin.write(`${JSON.stringify({ command: 'leave' })}\n${JSON.stringify({ command: 'join', channelId })}\n`);
  await light.wait(event => event.event === 'voice-admitted' && event.channelId === channelId, since);
  assert.ok(crossed, 'The departure never crossed the new join');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(room(), channelId, 'The server does not have the client back in the room');
  const state = await light.state();
  assert.equal(state.phase, 'admitted');
  assert.equal(state.channelId, channelId);
  await light.close();
});

test('a native client joins a server with forums, categories and an idle listener in the AFK room', { timeout: 60_000 }, async t => {
  const fixture = await createServerFixture(t, { voiceMode: 'sfu' });
  const admin = await fixture.connectHuman('Fixture admin');
  const lobbyId = admin.auth.server.channels.find(channel => channel.type === 'VOICE').id;
  await admin.peer.request(MessageType.CATEGORY_CREATE, { name: 'Community' }, [MessageType.CATEGORIES_UPDATED]);
  await admin.peer.request(MessageType.CHANNEL_CREATE, { name: 'Ideas', type: 'FORUM' }, [MessageType.CHANNEL_CREATED]);
  const settings = await admin.peer.request(MessageType.SERVER_UPDATE_SETTINGS,
    { afkChannelEnabled: true, afkChannelName: 'Away' }, [MessageType.SERVER_SETTINGS_UPDATED]);
  const afkId = settings.payload.afkChannelId;
  // Moved to the AFK room, a member listens with nobody to hear: an idle call.
  const away = await fixture.connectHuman('Away member');
  const awaySession = away.auth.currentUser.sessionId;
  await away.peer.request(MessageType.VOICE_JOIN, { channelId: lobbyId, isMuted: true, isDeafened: false },
    [MessageType.VOICE_USER_JOINED]);
  away.peer.send(MessageType.USER_UPDATE_CUSTOM_STATUS,
    { customStatus: { text: 'Back soon', color: '#33aa66', showEmoji: false, showTag: false } });
  await away.peer.request(MessageType.VOICE_AFK, { channelId: lobbyId }, [MessageType.ADMIN_MOVE_USER]);
  await away.peer.request(MessageType.VOICE_JOIN, { channelId: afkId, isMuted: true, isDeafened: false },
    [MessageType.VOICE_USER_JOINED]);
  // A transport nothing is ever negotiated on, as a listen-only client leaves it.
  await away.peer.request(MessageType.SFU_CREATE_WEBRTC_TRANSPORT, { channelId: afkId, direction: 'recv' },
    [MessageType.SFU_WEBRTC_TRANSPORT_CREATED]);
  await away.peer.request(MessageType.VOICE_JOIN, { channelId: afkId, isMuted: true, isDeafened: false },
    [MessageType.VOICE_USER_JOINED]);
  const listener = fixture.server.wsServer.signalingService.getVoiceState(awaySession);
  assert.equal(listener.connectionHealth, 'idle', 'The scenario needs an idle call on the server');
  assert.equal(listener.permissionMuted, true);

  const alice = new NativeClient(fixture, { nickname: 'Light Alice' });
  const bob = new NativeClient(fixture, { nickname: 'Light Bob' });
  const auth = await alice.wait('authenticated');
  const bobAuth = await bob.wait('authenticated');
  assert.ok(auth.channels.some(channel => channel.type === 'FORUM'), 'The forum must be listed, never refused');
  await alice.join(lobbyId);
  await bob.join(lobbyId);
  await alice.decodedFrom(bobAuth.sessionId);
  await bob.decodedFrom(auth.sessionId);
  for (const client of [alice, bob]) {
    assert.deepEqual(client.events.filter(event => event.event === 'session-error'), [],
      'Data a newer server sends was refused');
  }
  await alice.close();
  await bob.close();
});

for (const voiceMode of ['p2p', 'sfu']) {
  test(`a room without Speak keeps native microphones closed while the ${voiceMode} call goes on`, { timeout: 75_000 }, async t => {
    const fixture = await createServerFixture(t, { voiceMode });
    const admin = await fixture.connectHuman('Fixture admin');
    const alice = new NativeClient(fixture, { nickname: 'Light Alice' });
    const bob = new NativeClient(fixture, { nickname: 'Light Bob' });
    const auth = await alice.wait('authenticated');
    const bobAuth = await bob.wait('authenticated');
    const created = await admin.peer.request(MessageType.CHANNEL_CREATE, { name: 'Stage', type: 'VOICE' },
      [MessageType.CHANNEL_CREATED]);
    const channelId = created.payload.channel.id;
    await alice.untilState(value => value.channels.some(channel => channel.id === channelId), 'Room not listed');
    await bob.untilState(value => value.channels.some(channel => channel.id === channelId), 'Room not listed');
    await alice.join(channelId);
    await bob.join(channelId);
    await alice.decodedFrom(bobAuth.sessionId);

    const deny = [{ roleId: null, allow: 0, deny: Permission.SPEAK }];
    await admin.peer.request(MessageType.CHANNEL_UPDATE, { channelId, permissionOverwrites: deny },
      [MessageType.CHANNEL_UPDATED]);
    for (const client of [alice, bob]) {
      const denied = await client.untilState(value => value.policy.permissionMuted && !value.audioDevice.recording,
        'Losing Speak did not close the microphone');
      assert.equal(denied.phase, 'admitted');
      assert.equal(denied.policy.muted, false, 'A denied permission is not the user\'s own mute');
    }
    await alice.command('mute', { enabled: false });
    assert.equal((await alice.state()).audioDevice.recording, false, 'Unmuting reopened a microphone without Speak');
    // In P2P the same receiver stays; what it played of Alice so far is the baseline.
    const silent = voiceMode === 'p2p' ? await inboundEnergy(bob, auth.sessionId) : 0;

    // Entering the room unmuted, without Speak, is a call that only listens.
    const charlie = new NativeClient(fixture, { nickname: 'Light Charlie' });
    await charlie.wait('authenticated');
    await charlie.join(channelId);
    const listening = await charlie.untilState(value => value.participants === 3 && value.policy.permissionMuted,
      'Entering a room without Speak did not apply it');
    assert.equal(listening.audioDevice.recording, false);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await charlie.state()).phase, 'admitted', 'Entering a room without Speak ended the call');

    await admin.peer.request(MessageType.CHANNEL_UPDATE, { channelId, permissionOverwrites: [] },
      [MessageType.CHANNEL_UPDATED]);
    for (const client of [alice, bob, charlie]) {
      await client.untilState(value => !value.policy.permissionMuted && value.audioDevice.recording,
        'Granting Speak did not reopen the microphone');
    }
    if (voiceMode === 'p2p') {
      // The same receiver plays Alice again, so its totals grow past the denial.
      await until(async () => (await inboundEnergy(bob, auth.sessionId)) > silent + 0.01,
        'Granting Speak did not let Bob hear Alice again');
    } else {
      // A new microphone is a new consumer, with totals of its own.
      await bob.decodedFrom(auth.sessionId);
    }
    for (const client of [alice, bob, charlie]) {
      assert.deepEqual(client.events.filter(event => event.event === 'media-error'), []);
    }
    await charlie.close();
    await alice.close();
    await bob.close();
  });
}

test('a microphone the native SFU call cannot receive, or that the server refuses, costs only that audio', { timeout: 75_000 }, async t => {
  const fixture = await createServerFixture(t, { voiceMode: 'sfu' });
  const bob = new NativeClient(fixture, { nickname: 'Light Bob' });
  const charlie = new NativeClient(fixture, { nickname: 'Light Charlie' });
  const alice = new NativeClient(fixture, { nickname: 'Light Alice' });
  const bobAuth = await bob.wait('authenticated');
  const charlieAuth = await charlie.wait('authenticated');
  const auth = await alice.wait('authenticated');
  const channelId = auth.channels.find(channel => channel.type === 'VOICE').id;
  await bob.join(channelId);
  await charlie.join(channelId);
  await bob.decodedFrom(charlieAuth.sessionId);

  const wsServer = fixture.server.wsServer;
  const sfuManager = fixture.server.sfuManager;
  const sfu = wsServer.sfuSignaling;
  const handle = sfu.handle;
  let bobConsumes = 0;
  let refuseProduce = true;
  let refusedProduces = 0;
  const closedConsumers = [];
  sfu.handle = async function (session, type, payload, requestId) {
    if (session.sessionId === auth.sessionId) {
      // The server refuses Bob's microphone once, as during a change of room or permission.
      if (type === MessageType.SFU_CONSUME && sfuManager.getProducer(payload.producerId)?.sessionId === bobAuth.sessionId &&
          bobConsumes++ === 0) {
        this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Injected consume refusal', requestId);
        return;
      }
      // And Alice's own microphone, until the scenario lets it through.
      if (type === MessageType.SFU_PRODUCE && refuseProduce) {
        refusedProduces++;
        this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Injected produce refusal', requestId);
        return;
      }
      if (type === MessageType.SFU_CONSUMER_CLOSED) closedConsumers.push(payload.consumerId);
    }
    return handle.call(this, session, type, payload, requestId);
  };
  // Charlie's microphone reaches her with parameters her transport cannot open.
  const send = wsServer.send;
  let unopenable;
  wsServer.send = function (ws, message, frames) {
    if (!unopenable && message.type === MessageType.SFU_CONSUMED &&
        message.payload.producerSessionId === charlieAuth.sessionId && ws === wsServer.sessionSockets.get(auth.sessionId)) {
      unopenable = message.payload.id;
      const codecs = [{ mimeType: 'audio/unknown', payloadType: 100, clockRate: 48000, channels: 2 }];
      return send.call(this, ws, { ...message, payload: { ...message.payload,
        rtpParameters: { ...message.payload.rtpParameters, codecs } } });
    }
    return send.call(this, ws, message, frames);
  };
  t.after(() => {
    delete sfu.handle;
    delete wsServer.send;
  });

  alice.expectedPeerFailures.add(bobAuth.sessionId);
  alice.expectedPeerFailures.add(charlieAuth.sessionId);
  const since = alice.events.length;
  await alice.join(channelId);
  await alice.wait(event => event.event === 'media-error' && event.sessionId === bobAuth.sessionId, since);
  await alice.wait(event => event.event === 'media-error' && event.sessionId === charlieAuth.sessionId, since);
  await alice.wait(event => event.event === 'media-warning' && event.detail.includes('Microphone not published'), since);
  // Any policy event may try the microphone again; refused, the call keeps only receiving.
  await new Promise(resolve => setTimeout(resolve, 500));
  const receiving = await alice.state();
  assert.equal(receiving.phase, 'admitted', 'One unreceivable microphone ended the call');
  assert.equal(receiving.audioDevice.recording, false, 'A refused microphone kept capturing');
  assert.ok(refusedProduces < 10, `A refused microphone was retried in a loop (${refusedProduces} times)`);
  await until(() => unopenable && closedConsumers.includes(unopenable) &&
    !sfuManager.ownsConsumer(auth.sessionId, channelId, unopenable),
  'The consumer the server created for an unopenable microphone was left behind');

  // Once the server accepts it, the next policy change publishes the microphone.
  refuseProduce = false;
  await alice.command('mute', { enabled: true });
  await alice.command('mute', { enabled: false });
  await alice.untilState(value => value.audioDevice.recording, 'The refused microphone was never tried again');
  await bob.decodedFrom(auth.sessionId);
  await charlie.decodedFrom(auth.sessionId);
  // A new microphone of the same person is received as any other.
  await charlie.command('leave');
  // Joining the same room again before its departure arrives races that departure.
  await until(() => !wsServer.signalingService.getVoiceState(charlieAuth.sessionId), 'Charlie never left');
  await new Promise(resolve => setTimeout(resolve, 200));
  await charlie.join(channelId);
  await alice.decodedFrom(charlieAuth.sessionId);
  assert.equal(bobConsumes, 1, 'A refused microphone was asked for again');
  await alice.close();
  await bob.close();
  await charlie.close();
});

test('a native SFU call recovers from transport drops in a row, each recovery starting over', { timeout: 60_000 }, async t => {
  const fixture = await createServerFixture(t, { voiceMode: 'sfu' });
  const alice = new NativeClient(fixture, { nickname: 'Light Alice' });
  const bob = new NativeClient(fixture, { nickname: 'Light Bob' });
  const auth = await alice.wait('authenticated');
  const bobAuth = await bob.wait('authenticated');
  const channelId = auth.channels.find(channel => channel.type === 'VOICE').id;
  await alice.join(channelId);
  await bob.join(channelId);
  await alice.decodedFrom(bobAuth.sessionId);
  for (let drop = 1; drop <= 2; ++drop) {
    const since = alice.events.length;
    // The server loses the call's receiving transport, as on a network change.
    fixture.server.sfuManager.closeTransportsFor(auth.sessionId, channelId, 'recv');
    const retry = await alice.wait(event => event.event === 'media-reconnecting', since, 30_000);
    // Each drop after a recovery is a first attempt again, not the next step down.
    assert.equal(retry.detail, 'Retrying SFU transport in 1 seconds', `Drop ${drop} continued an earlier recovery`);
    await alice.wait(event => event.event === 'media-connected', since, 30_000);
    await alice.decodedFrom(bobAuth.sessionId);
  }
  assert.equal((await alice.state()).phase, 'admitted');
  await alice.close();
  await bob.close();
});

test('broadcasts the native core never reads stay out of its queue, and one that falls behind reconnects', { timeout: 75_000 }, async t => {
  const fixture = await createServerFixture(t, { voiceMode: 'sfu' });
  const admin = await fixture.connectHuman('Fixture admin');
  const light = new NativeClient(fixture, { nickname: 'Busy Light' });
  const auth = await light.wait('authenticated');
  const channelId = auth.channels.find(channel => channel.type === 'VOICE').id;
  await light.join(channelId);
  await admin.peer.request(MessageType.VOICE_JOIN, { channelId, isMuted: true, isDeafened: true },
    [MessageType.VOICE_USER_JOINED]);
  const before = await light.state();
  // Every sound has to reach the client, however fast they come.
  const WebSocketServer = fixture.server.wsServer.constructor;
  const limits = WebSocketServer.flowLimits;
  WebSocketServer.flowLimits = { ...limits, OUTBOUND_DISCARDABLE_BYTES: 30 * 1024 * 1024 };
  t.after(() => { WebSocketServer.flowLimits = limits; });

  // Five sounds, the most one person may play at once, carry ~20 MiB the core never reads.
  const audioBase64 = Buffer.alloc(3 * 1024 * 1024 - 1).toString('base64');
  let since = light.events.length;
  let mark = admin.peer.messages.length;
  const stall = light.command('fixture-stall', { milliseconds: 4000 });
  await light.wait('fixture-stalling', since);
  for (let index = 0; index < 5; ++index) {
    admin.peer.send(MessageType.SOUNDBOARD_PLAY,
      { channelId, soundName: `Burst ${index}`, audioBase64, mimeType: 'audio/mpeg' });
  }
  await until(() => admin.peer.messages.slice(mark).filter(message => message.type === MessageType.SOUNDBOARD_PLAYED)
    .length === 5, 'The soundboard burst did not reach the call');
  assert.equal((await stall).event, 'command-accepted');
  const after = await light.state();
  assert.equal(after.connection, before.connection, 'Broadcasts the core never reads cost its connection');
  assert.equal(after.phase, 'admitted');

  // Held long enough for its own input to outrun it, the core starts over on a
  // new connection, and back into the call, instead of ending the process.
  since = light.events.length;
  mark = admin.peer.messages.length;
  const held = light.command('fixture-stall', { milliseconds: 6000 });
  await light.wait('fixture-stalling', since);
  for (let index = 0; index < 300; ++index) {
    admin.peer.send(MessageType.VOICE_STATE_UPDATE, { isMuted: index % 2 === 0, isDeafened: false });
  }
  await until(() => admin.peer.messages.slice(mark).filter(message => message.type === MessageType.VOICE_STATE_CHANGED)
    .length >= 300, 'The state updates did not reach the call');
  assert.equal((await held).event, 'command-accepted');
  await light.wait(event => event.event === 'warning' && event.detail.includes('outpaced'), since);
  const rejoined = await light.wait(event => event.event === 'voice-admitted' && event.channelId === channelId, since);
  assert.ok(rejoined.generation > before.generation);
  const recovered = await light.state();
  assert.ok(recovered.connection > before.connection, 'The core did not start a new connection');
  assert.equal(recovered.phase, 'admitted');
  await light.close();
});

test('a native core whose events nobody reads leaves the call and logs out', { skip: process.platform !== 'win32', timeout: 30_000 }, async t => {
  // macOS ends the process with SIGPIPE before any of this can run (D7).
  const fixture = await createServerFixture(t);
  const admin = await fixture.connectHuman('Fixture admin');
  const light = new NativeClient(fixture, { nickname: 'Unread Light' });
  const auth = await light.wait('authenticated');
  const channelId = auth.channels.find(channel => channel.type === 'VOICE').id;
  await light.join(channelId);
  const since = admin.peer.messages.length;
  // Whoever read the events went away, as when the console window is closed.
  light.child.stdout.destroy();
  light.child.stdin.write('{"command":"stats"}\n');
  await admin.peer.wait(message => message.type === MessageType.USER_LEFT && message.payload.userId === auth.userId,
    since, 10_000);
  assert.equal(admin.peer.messages.slice(since).some(message => message.type === MessageType.USER_CONNECTION_STATE),
    false, 'The core dropped its connection instead of logging out');
  assert.deepEqual(await light.closed, { code: 1, signal: null });
});

test('closing the native console logs out at once and ends the process through main, also under an interface',
  { skip: process.platform !== 'win32', timeout: 45_000 }, async t => {
    const fixture = await createServerFixture(t);
    const admin = await fixture.connectHuman('Fixture admin');
    for (const tray of [false, true]) {
      const light = new NativeClient(fixture, { nickname: tray ? 'Closed tray' : 'Closed console', tray, pseudoConsole: true });
      const auth = await light.wait('authenticated');
      await light.join(auth.channels.find(channel => channel.type === 'VOICE').id);
      const since = admin.peer.messages.length;
      const started = Date.now();
      light.child.stdin.write('#close\n');
      await admin.peer.wait(message => message.type === MessageType.USER_LEFT && message.payload.userId === auth.userId,
        since, 4000);
      assert.equal(admin.peer.messages.slice(since).some(message => message.type === MessageType.USER_CONNECTION_STATE),
        false, 'The core dropped its connection instead of logging out');
      // 0xC000013A: Windows ended the process when the hold ran out, main never returned.
      assert.deepEqual(await light.closed, { code: 0, signal: null }, 'Windows ended the process instead of main');
      assert.ok(Date.now() - started < 3000, 'The process sat out the whole hold instead of exiting through main');
      assert.ok(light.events.some(event => event.event === 'stopped'));
      if (tray) {
        assert.ok(light.events.some(event => event.event === 'fixture-interface-stopped'),
          'The interface never heard that the core stopped, so the tray icon would stay behind');
      }
    }

    // As a person runs it: the console is the core's input and output too.
    await closeConsoleWindow(fixture, admin, { nickname: 'Console window', command: '#close' });
  });

test('a native console closed as Windows 10 and Windows Server 2022 do, which stop serving it at once, still logs out and ends with 0',
  { skip: process.platform !== 'win32', timeout: 45_000 }, async t => {
    const fixture = await createServerFixture(t);
    const admin = await fixture.connectHuman('Fixture admin');
    for (const tray of [false, true]) {
      await closeConsoleWindow(fixture, admin,
        { nickname: tray ? 'Abrupt tray' : 'Abrupt console', command: '#close-abruptly', tray });
    }
  });

// Runs the core with the console as its input and output, joins the call and
// closes that console with the console host's command. What the console showed
// is kept, to tell what the core said if it fails.
async function closeConsoleWindow(fixture, admin, { nickname, command, tray = false }) {
  const channelId = admin.auth.server.channels.find(channel => channel.type === 'VOICE').id;
  const env = { ...process.env };
  delete env.MONKY_LIGHT_PASSWORD;
  const since = admin.peer.messages.length;
  const host = spawn(nativeExecutable('monky-light-console-host'), ['--console-stdio',
    nativeExecutable('monky-light-fixture'), '--profile', path.join(fixture.directory, `native-${randomUUID()}`),
    '--server', fixture.url, '--nickname', nickname, '--channel', channelId, ...(tray ? ['--tray'] : [])],
  { stdio: 'pipe', env });
  const exited = once(host, 'close');
  fixture.onCleanup(async () => {
    if (host.exitCode === null && host.signalCode === null) host.kill();
    await exited;
  });
  let shown = '';
  const keep = chunk => { shown = (shown + chunk).slice(-8000); };
  host.stdout.setEncoding('utf8').on('data', keep);
  host.stderr.setEncoding('utf8').on('data', keep);
  const arrival = await admin.peer.wait(message => message.type === MessageType.VOICE_USER_JOINED &&
    message.payload.channelId === channelId && message.payload.userId !== admin.auth.currentUser.id, since, 15_000);
  const left = admin.peer.messages.length;
  const started = Date.now();
  host.stdin.write(`${command}\n`);
  await admin.peer.wait(message => message.type === MessageType.USER_LEFT &&
    message.payload.userId === arrival.payload.userId, left, 4000);
  assert.equal(admin.peer.messages.slice(left).some(message => message.type === MessageType.USER_CONNECTION_STATE),
    false, 'The core in a closed console window dropped its connection instead of logging out');
  const [code, signal] = await exited;
  // 0xC000013A: Windows ended the process when the hold ran out, main never returned.
  assert.notEqual(code, 0xC000013A, 'Windows ended the core of a closed console window instead of main');
  const text = shown.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');
  assert.deepEqual([code, signal], [0, null], `The core of a closed console window failed; the console showed:\n${text}`);
  assert.ok(Date.now() - started < 3000, 'The core of a closed console window sat out the whole hold');
}
