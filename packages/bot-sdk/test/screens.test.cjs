const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BotScreenClient } = require('../dist/BotScreenClient.js');

test('screen composition binds each request/event to its captured authenticated server', async () => {
  const requests = [];
  const events = [];
  const errors = [];
  const removed = [];
  const snapshot = { id: 'game', channelId: 'chat', botId: 'bot', title: 'Game', html: '<b>Game</b>', state: {}, revision: 0, createdAt: 1 };
  const client = new BotScreenClient({
    async request(serverId, type, payload) {
      requests.push({ serverId, type, payload });
      if (type === 'BOT_SCREEN_CLOSE') return { id: payload.id, channelId: 'chat' };
      if (type === 'BOT_SCREEN_LIST') return { channelId: 'chat', screens: [snapshot] };
      return snapshot;
    },
    report(serverId, event) { events.push({ serverId, ...event }); },
    removed(serverId, event) { removed.push({ serverId, ...event }); },
    error(serverId, error) { errors.push({ serverId, error }); },
  });
  await client.createScreen('server-a', { id: 'game', channelId: 'chat', title: 'Game', html: '<b>Game</b>', state: {} });
  await client.updateScreen('server-b', 'game', { state: { next: 1 }, expectedRevision: 0 });
  await client.closeScreen('server-a', 'game');
  assert.equal((await client.listScreens('server-b', 'chat')).length, 1);
  assert.deepEqual(requests.map(({ serverId, type }) => [serverId, type]), [
    ['server-a', 'BOT_SCREEN_CREATE'], ['server-b', 'BOT_SCREEN_UPDATE'], ['server-a', 'BOT_SCREEN_CLOSE'], ['server-b', 'BOT_SCREEN_LIST'],
  ]);
  assert.equal(client.handle('server-b', 'BOT_SCREEN_ACTION_EVENT', {
    screenId: 'game', channelId: 'chat', userId: 'bob', userNickname: 'Bob',
    action: 'move', payload: { to: 1 }, revision: 0, actionId: 'move-1',
  }), true);
  assert.equal(events[0].serverId, 'server-b');
  assert.equal(events[0].userId, 'bob');
  client.handle('server-a', 'BOT_SCREEN_ACTION_EVENT', { userId: 'forged' });
  assert.equal(events.length, 1);
  assert.equal(errors[0].serverId, 'server-a');
  assert.match(errors[0].error.message, /Invalid programmable screen action/);
  client.handle('server-b', 'BOT_SCREEN_REMOVED', { id: 'game', channelId: 'chat' });
  assert.deepEqual(removed, [{ serverId: 'server-b', id: 'game', channelId: 'chat' }]);
  client.handle('server-a', 'BOT_SCREEN_REMOVED', { id: 'game' });
  assert.equal(removed.length, 1);
  assert.equal(errors.length, 2);
  assert.equal(client.handle('server-a', 'UNRELATED', {}), false);
  await assert.rejects(client.updateScreen('server-a', 'game', { state: {}, expectedRevision: -1 }));
  await assert.rejects(client.createScreen('server-a', { channelId: 'chat', title: 'Game', html: 'a', state: { bad: Infinity } }));
  assert.equal(requests.length, 4);
});
