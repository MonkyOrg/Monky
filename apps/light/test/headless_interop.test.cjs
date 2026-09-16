const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { MessageType } = require('@monky/shared');
const { NativeClient } = require('./native_client.cjs');
const { createServerFixture } = require('./server_fixture.cjs');

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

    const room = await admin.peer.request(MessageType.CHANNEL_CREATE, { name: 'Other', type: 'VOICE' },
      [MessageType.CHANNEL_CREATED]);
    const otherChannelId = room.payload.channel.id;
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
  sender.peer.send(MessageType.RTC_SIGNAL, {
    fromSessionId: sender.auth.currentUser.sessionId, targetSessionId: auth.sessionId,
    signalType: 'offer', sdp: { type: 'offer', sdp: 'not a valid SDP description' },
  });
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
