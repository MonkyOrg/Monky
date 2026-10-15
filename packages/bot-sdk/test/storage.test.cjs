const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const { test } = require('node:test');
const { WebSocketServer } = require('ws');
const {
  BotClient, BotRequestError, MessageType, ProtocolErrorCode,
} = require('../dist/index.js');

const SERVER_ID = 'storage-server';

async function makeServer(t, features, respond = () => undefined) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const frames = [];
  const events = new EventEmitter();
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      frames.push(message);
      events.emit('frame', message);
      if (message.type === MessageType.AUTH_CONNECT) {
        ws.send(JSON.stringify({ type: MessageType.AUTH_SUCCESS, payload: {
          currentUser: { id: 'bot-one' }, server: { protocol: { minimumVersion: 24, features } },
        } }));
      } else {
        const reply = respond(message);
        if (reply) ws.send(JSON.stringify({ ...reply, requestId: message.requestId }));
      }
    });
  });
  t.after(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const next = (type) => new Promise((resolve, reject) => {
    const found = frames.find((message) => message.type === type);
    if (found) return resolve(found);
    const timer = setTimeout(() => reject(new Error(`Missing ${type}`)), 3000);
    const onFrame = (message) => {
      if (message.type !== type) return;
      clearTimeout(timer);
      events.off('frame', onFrame);
      resolve(message);
    };
    events.on('frame', onFrame);
  });
  return { url: `ws://127.0.0.1:${server.address().port}`, frames, next };
}

async function connectedBot(t, server, requestedCapabilities = ['server_storage']) {
  const bot = new BotClient({
    requestedCapabilities, publicKey: 'a'.repeat(64), token: 'token', serverUrl: server.url, autoReconnect: false,
  });
  bot.on('error', () => undefined);
  t.after(() => bot.close());
  bot.connect({ serverId: SERVER_ID });
  const registration = await server.next(MessageType.COMMAND_REGISTER);
  return { bot, registration };
}

test('storage is available only to bots that declare server_storage', async (t) => {
  const server = await makeServer(t, ['bot-storage']);
  const { bot } = await connectedBot(t, server, ['commands']);
  assert.throws(() => bot.storage(SERVER_ID), /server_storage/);
});

test('objects travel as base64 and come back as bytes, with the key checked on both ends', async (t) => {
  const stored = new Map();
  const server = await makeServer(t, ['bot-storage'], (message) => {
    const { payload } = message;
    if (message.type === MessageType.BOT_STORAGE_PUT) {
      stored.set(payload.key, payload);
      return { type: MessageType.BOT_STORAGE_SAVED, payload: {
        key: payload.key, sizeBytes: Buffer.from(payload.data, 'base64').byteLength, contentType: payload.contentType ?? null, updatedAt: 1,
      } };
    }
    if (message.type === MessageType.BOT_STORAGE_GET) {
      const object = stored.get(payload.key);
      return { type: MessageType.BOT_STORAGE_GET_RESULT, payload: { key: payload.key, object: object ? {
        key: object.key, data: object.data, sizeBytes: Buffer.from(object.data, 'base64').byteLength,
        contentType: object.contentType ?? null, updatedAt: 1,
      } : null } };
    }
    if (message.type === MessageType.BOT_STORAGE_DELETE) {
      return { type: MessageType.BOT_STORAGE_DELETED, payload: { key: payload.key, deleted: stored.delete(payload.key) } };
    }
    if (message.type === MessageType.BOT_STORAGE_LIST) {
      return { type: MessageType.BOT_STORAGE_LIST_RESULT, payload: { objects: [...stored.values()].map((object) => ({
        key: object.key, sizeBytes: Buffer.from(object.data, 'base64').byteLength, contentType: object.contentType ?? null, updatedAt: 1,
      })), next: null } };
    }
    if (message.type === MessageType.BOT_STORAGE_USAGE) {
      return { type: MessageType.BOT_STORAGE_USAGE_RESULT, payload: {
        usedBytes: 11, maxBytes: 100 * 1024 * 1024, objectCount: 1, maxObjects: 10000, level: 'ok',
      } };
    }
    return undefined;
  });
  const { bot, registration } = await connectedBot(t, server, ['commands', 'server_storage', 'device_storage']);
  assert.deepEqual(registration.payload.requestedCapabilities, ['commands', 'server_storage', 'device_storage']);
  const storage = bot.storage(SERVER_ID);
  const saved = await storage.put('nes/rom/slot-1', new Uint8Array([1, 2, 3]), { contentType: 'application/octet-stream' });
  assert.deepEqual(saved, { key: 'nes/rom/slot-1', sizeBytes: 3, contentType: 'application/octet-stream', updatedAt: 1 });
  assert.equal(stored.get('nes/rom/slot-1').data, 'AQID');
  await storage.put('note', 'olá mundo');
  const note = await storage.get('note');
  assert.equal(Buffer.from(note.data).toString('utf8'), 'olá mundo');
  assert.deepEqual([...(await storage.get('nes/rom/slot-1')).data], [1, 2, 3]);
  assert.equal(await storage.get('missing'), null);
  assert.deepEqual((await storage.list()).objects.map((object) => object.key).sort(), ['nes/rom/slot-1', 'note']);
  await assert.rejects(storage.list({ prefix: 'nes/' }), /outside the prefix/);
  assert.equal(await storage.delete('note'), true);
  assert.equal((await storage.usage()).level, 'ok');
  await assert.rejects(storage.put('../escape', 'x'));
  await assert.rejects(storage.get('a//b'));
  assert.equal(server.frames.some((message) => message.payload?.key === '../escape'), false, 'Invalid keys never reach the server');
});

test('a full storage makes autosaves resolve null while explicit saves reject with the code', async (t) => {
  const server = await makeServer(t, ['bot-storage'], (message) => message.type === MessageType.BOT_STORAGE_PUT
    ? { type: MessageType.SERVER_ERROR, payload: { code: ProtocolErrorCode.STORAGE_FULL, message: 'The bot storage on this server is full.' } }
    : undefined);
  const { bot } = await connectedBot(t, server);
  const storage = bot.storage(SERVER_ID);
  assert.equal(await storage.put('autosave', 'state', { autosave: true }), null);
  await assert.rejects(storage.put('slot-1', 'state'), (error) => {
    assert.ok(error instanceof BotRequestError);
    assert.equal(error.code, ProtocolErrorCode.STORAGE_FULL);
    return true;
  });
});

test('servers without bot-storage never receive the capability names or a storage request', async (t) => {
  const server = await makeServer(t, ['message-length-setting']);
  const { bot, registration } = await connectedBot(t, server, ['commands', 'server_storage', 'device_storage']);
  assert.deepEqual(registration.payload.requestedCapabilities, ['commands']);
  const sent = server.frames.length;
  await assert.rejects(bot.storage(SERVER_ID).put('save', 'state', { autosave: true }), (error) => {
    assert.ok(error instanceof BotRequestError);
    assert.equal(error.code, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
    return true;
  });
  assert.equal(server.frames.length, sent);
});

test('the manifest lists storage capabilities only for servers that announce bot-storage', async (t) => {
  const bot = new BotClient({
    requestedCapabilities: ['miniapps', 'server_storage', 'device_storage'], publicKey: 'a'.repeat(64), autoReconnect: false,
  });
  t.after(() => bot.close());
  const listener = await bot.serve({ name: 'Storage bot', host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${listener.address().port}/manifest`;
  const legacy = await (await fetch(url)).json();
  assert.deepEqual(legacy.requestedCapabilities, ['miniapps']);
  const current = await (await fetch(url, { headers: { 'X-Monky-Protocol-Features': 'message-length-setting, bot-storage' } })).json();
  assert.deepEqual(current.requestedCapabilities, ['miniapps', 'server_storage', 'device_storage']);
});
