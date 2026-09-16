const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MessageType } = require('@monky/shared');
const { createServerFixture } = require('./server_fixture.cjs');

test('disposable Light server fixture uses real human admission and stable device identity', { timeout: 30_000 }, async t => {
  const fixture = await createServerFixture(t, { password: 'fixture-only' });
  const human = await fixture.connectHuman('Light fixture');
  const { currentUser, server } = human.auth;
  assert.equal(currentUser.isBot, undefined);
  assert.equal(currentUser.sessionId, `${currentUser.id}:${human.deviceId}`);
  assert.equal(server.voiceMode, 'p2p');
  const channel = server.channels.find(value => value.type === 'VOICE');
  assert.ok(channel);
  const joined = await human.peer.request(MessageType.VOICE_JOIN, {
    channelId: channel.id, isMuted: false, isDeafened: false,
  }, [MessageType.VOICE_USER_JOINED]);
  assert.ok(joined.requestId);
  assert.equal(joined.payload.sessionId, currentUser.sessionId);
  assert.equal(joined.payload.participants.length, 1);
  assert.equal(joined.payload.participants[0].user.id, currentUser.id);
  await human.peer.close();
  const again = await fixture.connectHuman('Light fixture', human);
  assert.equal(again.auth.currentUser.id, currentUser.id);
  assert.equal(again.auth.currentUser.sessionId, currentUser.sessionId);
  assert.deepEqual(again.auth.server.voiceStates, {});
});
