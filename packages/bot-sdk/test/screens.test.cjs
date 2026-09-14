const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BotScreenClient } = require('../dist/BotScreenClient.js');

test('screen composition binds each request/event to its captured authenticated server', async () => {
  const requests = [];
  const events = [];
  const errors = [];
  const removed = [];
  const snapshot = { id: 'game', instanceId: 'instance', channelId: 'chat', botId: 'bot', title: 'Game', html: '<b>Game</b>', state: {}, revision: 0, createdAt: 1 };
  const client = new BotScreenClient({
    async request(serverId, type, payload) {
      requests.push({ serverId, type, payload });
      if (type === 'BOT_SCREEN_CLOSE') return { ...payload, channelId: 'chat', reason: 'closed' };
      if (type === 'BOT_SCREEN_LIST') return { channelId: 'chat', screens: [snapshot] };
      return snapshot;
    },
    report(serverId, event) { events.push({ serverId, ...event }); },
    removed(serverId, event) { removed.push({ serverId, ...event }); },
    error(serverId, error) { errors.push({ serverId, error }); },
  });
  await client.createScreen('server-a', { id: 'game', channelId: 'chat', title: 'Game', html: '<b>Game</b>', state: {} });
  await client.updateScreen('server-b', snapshot, { state: { next: 1 }, expectedRevision: 0 });
  await client.closeScreen('server-a', snapshot);
  assert.equal((await client.listScreens('server-b', 'chat')).length, 1);
  assert.deepEqual(requests.map(({ serverId, type }) => [serverId, type]), [
    ['server-a', 'BOT_SCREEN_CREATE'], ['server-b', 'BOT_SCREEN_UPDATE'], ['server-a', 'BOT_SCREEN_CLOSE'], ['server-b', 'BOT_SCREEN_LIST'],
  ]);
  assert.equal(client.handle('server-b', 'BOT_SCREEN_ACTION_EVENT', {
    screenId: 'game', instanceId: 'instance', channelId: 'chat', userId: 'bob', userNickname: 'Bob',
    action: 'move', payload: { to: 1 }, revision: 0, actionId: 'move-1',
  }), true);
  assert.equal(events[0].serverId, 'server-b');
  assert.equal(events[0].userId, 'bob');
  client.handle('server-a', 'BOT_SCREEN_ACTION_EVENT', { userId: 'forged' });
  assert.equal(events.length, 1);
  assert.equal(errors[0].serverId, 'server-a');
  assert.match(errors[0].error.message, /Invalid programmable screen action/);
  client.handle('server-b', 'BOT_SCREEN_REMOVED', { id: 'game', instanceId: 'instance', channelId: 'chat', reason: 'ended', endedByUserId: 'alice' });
  assert.deepEqual(removed, [{ serverId: 'server-b', id: 'game', instanceId: 'instance', channelId: 'chat', reason: 'ended', endedByUserId: 'alice' }]);
  client.handle('server-a', 'BOT_SCREEN_REMOVED', { id: 'game' });
  assert.equal(removed.length, 1);
  assert.equal(errors.length, 2);
  assert.equal(client.handle('server-a', 'UNRELATED', {}), false);
  await assert.rejects(client.updateScreen('server-a', snapshot, { state: {}, expectedRevision: -1 }));
  await assert.rejects(client.updateScreen('server-a', 'game', { state: {}, expectedRevision: 0 }));
  await assert.rejects(client.createScreen('server-a', { channelId: 'chat', title: 'Game', html: 'a', state: { bad: Infinity } }));
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[1].payload, { id: 'game', instanceId: 'instance', state: { next: 1 }, expectedRevision: 0 });
  assert.deepEqual(requests[2].payload, { id: 'game', instanceId: 'instance' });
});

test('removal overtaking create, update or list never returns a live snapshot to the bot', async () => {
  const screen = {
    id: 'game', instanceId: 'instance', channelId: 'voice', botId: 'bot', title: 'Game',
    html: '<p>Game</p>', state: {}, revision: 0, createdAt: 1, creatorUserId: 'alice',
  };
  for (const operation of ['create', 'update', 'list']) {
    let resolve;
    const removed = [];
    const client = new BotScreenClient({
      request() { return new Promise(done => { resolve = done; }); },
      report() {},
      removed(serverId, event) { removed.push({ serverId, ...event }); },
      error(_serverId, error) { throw error; },
    });
    const pending = operation === 'create'
      ? client.createScreen('server', { channelId: 'voice', title: 'Game', html: 'Game', state: null })
      : operation === 'update' ? client.updateScreen('server', screen, { state: {}, expectedRevision: 0 })
        : client.listScreens('server', 'voice');
    const rejected = assert.rejects(pending, /removed while its request was in flight/);
    client.handle('server', 'BOT_SCREEN_REMOVED', {
      id: 'game', instanceId: 'instance', channelId: 'voice', reason: 'ended', endedByUserId: 'alice',
    });
    resolve(operation === 'list' ? { channelId: 'voice', screens: [screen] } : screen);
    await rejected;
    assert.equal(removed.length, 1);
    assert.equal(removed[0].endedByUserId, 'alice');
  }
});

test('late removal is isolated by server and instance; malformed acknowledgments cannot close a replacement', async () => {
  const screen = {
    id: 'game', instanceId: 'replacement', channelId: 'voice', botId: 'bot', title: 'Game',
    html: 'Game', state: null, revision: 0, createdAt: 2,
  };
  let resolve;
  const client = new BotScreenClient({
    request(_server, type) {
      if (type === 'BOT_SCREEN_CLOSE') return Promise.resolve({
        id: 'game', instanceId: 'previous', channelId: 'voice', reason: 'closed',
      });
      return new Promise(done => { resolve = done; });
    },
    report() {}, removed() {}, error(_server, error) { throw error; },
  });
  const pending = client.updateScreen('server-a', screen, { state: {}, expectedRevision: 0 });
  client.handle('server-a', 'BOT_SCREEN_REMOVED', { id: 'game', instanceId: 'previous', channelId: 'voice', reason: 'closed' });
  client.handle('server-b', 'BOT_SCREEN_REMOVED', { id: 'game', instanceId: 'replacement', channelId: 'voice', reason: 'closed' });
  resolve(screen);
  assert.deepEqual(await pending, screen);
  await assert.rejects(client.closeScreen('server-a', screen), /does not match/);
});
