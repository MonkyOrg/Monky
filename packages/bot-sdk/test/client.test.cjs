const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { BotClient, MessageType, PROTOCOL_VERSION, ProtocolErrorCode } = require('../dist/index.js');

const form = {
  title: 'Your choice',
  fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }],
};

async function makeServer(t, handlers = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const frames = [];
  const events = new EventEmitter();
  let socket;
  server.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      frames.push(message);
      events.emit('frame', message);
      if (message.type === MessageType.AUTH_CONNECT) {
        if (handlers.authenticate) handlers.authenticate(ws, message);
        else ws.send(JSON.stringify({ type: MessageType.AUTH_SUCCESS, payload: {} }));
      } else if (message.type === MessageType.BOT_UPDATE_PROFILE) {
        if (handlers.profile) handlers.profile(ws, message);
        else ws.send(JSON.stringify({
          type: MessageType.BOT_PROFILE_UPDATED, requestId: message.requestId, payload: { bot: { id: 'bot-one' } },
        }));
      }
    });
  });
  t.after(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const next = (type, predicate = () => true, timeout = 3000) => {
    const index = frames.findIndex((message) => message.type === type && predicate(message));
    if (index !== -1) return Promise.resolve(frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        events.off('frame', onFrame);
        reject(new Error(`Missing ${type}`));
      }, timeout);
      const onFrame = (message) => {
        if (message.type !== type || !predicate(message)) return;
        clearTimeout(timer);
        events.off('frame', onFrame);
        frames.splice(frames.indexOf(message), 1);
        resolve(message);
      };
      events.on('frame', onFrame);
    });
  };
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    next,
    frames,
    startClosing: () => { socket.pause(); socket.close(); },
    resumeClosing: () => socket.resume(),
    send: (type, payload, requestId) => socket.send(JSON.stringify({ type, payload, requestId })),
    invoke: (invocationId, commandName, extra = {}) => socket.send(JSON.stringify({
      type: MessageType.COMMAND_INVOKE,
      payload: {
        invocationId, commandName, botId: 'bot-one', channelId: 'channel-one',
        invokerId: invocationId, invokerNickname: 'Caller', locale: 'en', ...extra,
      },
    })),
  };
}

function makeBot(t, server, options = {}) {
  const bot = new BotClient({
    publicKey: 'a'.repeat(64), token: 'test-token', serverUrl: server.url, autoReconnect: false, ...options,
  });
  const errors = [];
  bot.on('error', (error) => errors.push(error));
  t.after(() => bot.close());
  return { bot, errors };
}

function registrationFile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-sdk-registrations-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'registrations.json');
}

function registerAt(listener, registration) {
  return fetch(`http://127.0.0.1:${listener.address().port}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registration),
  });
}

test('named options retain their types and public output is explicit', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  let context;
  bot.command({
    name: '8ball', description: 'Typed command',
    options: [
      { name: 'question', description: 'Question', type: 'string', required: true },
      { name: 'count', description: 'Count', type: 'integer', min: 2, max: 100 },
      { name: 'enabled', description: 'Enabled', type: 'boolean' },
    ],
    handler: (ctx) => {
      context = ctx;
      ctx.reply('Only you');
      ctx.publish('For the channel');
    },
  });
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER);
  server.invoke('typed', '8ball', { options: { question: 'Will this work with spaces?', count: 20, enabled: false } });
  const privateReply = await server.next(MessageType.COMMAND_RESPONSE);
  const publicReply = await server.next(MessageType.COMMAND_RESPONSE);
  const completed = await server.next(MessageType.COMMAND_FINISH);
  assert.deepEqual(context.args, { question: 'Will this work with spaces?', count: 20, enabled: false });
  assert.equal(context.locale, 'en');
  assert.equal(privateReply.payload.ephemeral, true);
  assert.equal(publicReply.payload.ephemeral, false);
  assert.equal(privateReply.payload.invocationId, 'typed');
  assert.equal(completed.payload.failed, false);
  assert.equal(context.signal.aborted, true);
  assert.throws(() => context.reply('Too late'), /already ended/);
  assert.deepEqual(errors, []);
});

test('calling connect repeatedly does not create competing sessions', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  let connects = 0;
  bot.on('connected', () => connects++);
  bot.command({ name: 'ping', description: 'Ping', handler: (ctx) => ctx.reply('Pong') });
  bot.connect();
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER);
  bot.connect();
  server.invoke('single-connection', 'ping');
  await server.next(MessageType.COMMAND_RESPONSE);
  assert.equal(bot.serverCount, 1);
  assert.equal(connects, 1);
  assert.deepEqual(errors, []);
});

test('concurrent callers complete two private rounds without sharing answers', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  bot.command({
    name: 'wizard', description: 'Two rounds',
    handler: async (ctx) => {
      const first = await ctx.prompt(form);
      if (!first) return;
      const second = await ctx.prompt({ ...form, title: `Confirm ${first.answer}` });
      if (second) ctx.reply(`${first.answer} / ${second.answer}`);
    },
  });
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER);
  server.invoke('alice', 'wizard');
  server.invoke('bob', 'wizard');
  const alice = await server.next(MessageType.COMMAND_PROMPT, (m) => m.payload.invocationId === 'alice');
  const bob = await server.next(MessageType.COMMAND_PROMPT, (m) => m.payload.invocationId === 'bob');
  assert.notEqual(alice.payload.interactionId, bob.payload.interactionId);
  server.send(MessageType.COMMAND_SUBMITTED, { ...bob.payload, form: undefined, values: { answer: 'B1' } });
  const bobAgain = await server.next(MessageType.COMMAND_PROMPT, (m) => m.payload.invocationId === 'bob');
  server.send(MessageType.COMMAND_SUBMITTED, { ...alice.payload, form: undefined, values: { answer: 'A1' } });
  const aliceAgain = await server.next(MessageType.COMMAND_PROMPT, (m) => m.payload.invocationId === 'alice');
  assert.equal(bobAgain.payload.form.title, 'Confirm B1');
  assert.equal(aliceAgain.payload.form.title, 'Confirm A1');
  for (const [prompt, answer] of [[bobAgain, 'B2'], [aliceAgain, 'A2']]) {
    server.send(MessageType.COMMAND_SUBMITTED, {
      invocationId: prompt.payload.invocationId,
      interactionId: prompt.payload.interactionId,
      values: { answer },
    });
  }
  const bobResult = await server.next(MessageType.COMMAND_RESPONSE, (m) => m.payload.invocationId === 'bob');
  const aliceResult = await server.next(MessageType.COMMAND_RESPONSE, (m) => m.payload.invocationId === 'alice');
  assert.equal(bobResult.payload.content, 'B1 / B2');
  assert.equal(aliceResult.payload.content, 'A1 / A2');
  assert.deepEqual(errors, []);
});

test('cancelling a form resolves null and aborts the handler', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  let finished;
  const result = new Promise((resolve) => { finished = resolve; });
  bot.command({
    name: 'cancel', description: 'Cancellation',
    handler: async (ctx) => {
      const answer = await ctx.prompt(form);
      finished({ answer, aborted: ctx.signal.aborted });
    },
  });
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER);
  server.invoke('cancel-me', 'cancel');
  await server.next(MessageType.COMMAND_PROMPT);
  server.send(MessageType.COMMAND_FINISHED, { invocationId: 'cancel-me', channelId: 'channel-one', reason: 'cancelled' });
  assert.deepEqual(await result, { answer: null, aborted: true });
  assert.equal(server.frames.some((frame) => frame.type === MessageType.COMMAND_RESPONSE), false);
  assert.deepEqual(errors, []);
});

test('the same invocation ID on different servers stays isolated', { timeout: 10000 }, async (t) => {
  const firstServer = await makeServer(t);
  const secondServer = await makeServer(t);
  const { bot, errors } = makeBot(t, firstServer);
  bot.command({
    name: 'servers', description: 'Separate servers',
    handler: async (ctx) => {
      const answer = await ctx.prompt(form);
      if (answer) ctx.reply(`${ctx.serverId}: ${answer.answer}`);
    },
  });
  bot.connect({ serverId: 'first' });
  bot.connect({ serverId: 'second', serverUrl: secondServer.url });
  await Promise.all([firstServer.next(MessageType.COMMAND_REGISTER), secondServer.next(MessageType.COMMAND_REGISTER)]);
  firstServer.invoke('same-id', 'servers');
  secondServer.invoke('same-id', 'servers');
  const firstPrompt = await firstServer.next(MessageType.COMMAND_PROMPT);
  const secondPrompt = await secondServer.next(MessageType.COMMAND_PROMPT);
  secondServer.send(MessageType.COMMAND_SUBMITTED, {
    invocationId: 'same-id', interactionId: secondPrompt.payload.interactionId, values: { answer: 'second answer' },
  });
  firstServer.send(MessageType.COMMAND_SUBMITTED, {
    invocationId: 'same-id', interactionId: firstPrompt.payload.interactionId, values: { answer: 'first answer' },
  });
  assert.equal((await firstServer.next(MessageType.COMMAND_RESPONSE)).payload.content, 'first: first answer');
  assert.equal((await secondServer.next(MessageType.COMMAND_RESPONSE)).payload.content, 'second: second answer');
  assert.deepEqual(errors, []);
});

test('server rejection of a prompt ends the invocation with a reported failure', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  bot.command({ name: 'failure', description: 'Failure', handler: async (ctx) => { await ctx.prompt(form); } });
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER);
  server.invoke('reject-me', 'failure');
  const prompt = await server.next(MessageType.COMMAND_PROMPT);
  server.send(MessageType.SERVER_ERROR, { code: 'BOT_INTERACTION_INVALID', message: 'Invalid form.' }, prompt.requestId);
  assert.equal((await server.next(MessageType.COMMAND_FINISH)).payload.failed, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Invalid form/);
});

test('disconnect settles every pending form and rejects late replies', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot } = makeBot(t, server);
  let complete;
  const done = new Promise((resolve) => { complete = resolve; });
  let ctx;
  bot.command({
    name: 'disconnect', description: 'Pending form',
    handler: async (context) => {
      ctx = context;
      complete(await context.prompt(form));
    },
  });
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER);
  server.invoke('disconnect-me', 'disconnect');
  await server.next(MessageType.COMMAND_PROMPT);
  bot.disconnect();
  assert.equal(await done, null);
  assert.equal(ctx.signal.aborted, true);
  assert.throws(() => ctx.publish('Too late'), /already ended/);
  assert.equal(bot.serverCount, 0);
});

test('a handler finishing during the close handshake does not reject unhandled', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  let complete;
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  const done = new Promise((resolve) => { complete = resolve; });
  bot.command({
    name: 'closing', description: 'Finish while closing',
    handler: async () => { started(); await done; },
  });
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER);
  server.invoke('closing', 'closing');
  await start;
  server.startClosing();
  await new Promise((resolve) => setTimeout(resolve, 50));
  complete();
  await new Promise((resolve) => setTimeout(resolve, 20));
  server.resumeClosing();
  assert.deepEqual(errors, []);
});

test('an in-flight registration cannot reconnect a bot during shutdown', { timeout: 10000 }, async (t) => {
  const wsServer = await makeServer(t);
  const { bot, errors } = makeBot(t, wsServer);
  const listener = await bot.serve({ name: 'Closing Bot', port: 0, host: '127.0.0.1' });
  const receivedRequest = once(listener, 'request');
  const request = http.request({
    hostname: '127.0.0.1', port: listener.address().port, path: '/register', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const response = once(request, 'response');
  request.write('{"token":');
  await receivedRequest;
  const closed = bot.close();
  request.end(JSON.stringify('token') + `,"serverName":"Server","serverUrl":${JSON.stringify(wsServer.url)}}`);
  const [result] = await response;
  result.resume();
  assert.equal(result.statusCode, 503);
  await closed;
  await bot.close();
  assert.equal(bot.serverCount, 0);
  assert.throws(() => bot.connect(), /closed/);
  assert.throws(() => bot.serve({ name: 'Again' }), /closed/);
  assert.deepEqual(errors, []);
});

test('marketplace manifest and registration carry the profile and serve real HTTP', { timeout: 10000 }, async (t) => {
  const wsServer = await makeServer(t);
  const avatar = 'data:image/png;base64,iVBORw0KGgo=';
  const { bot, errors } = makeBot(t, wsServer, { avatarBase64: avatar });
  bot.command({ name: 'ping', description: 'Ping', handler: (ctx) => ctx.reply('Pong') });
  const httpServer = await bot.serve({ name: 'Photo Bot', port: 0, host: '127.0.0.1', publicHost: '127.0.0.1' });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const response = await fetch(`${base}/manifest`);
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.equal(manifest.name, 'Photo Bot');
  assert.equal(manifest.icon, avatar);
  assert.equal(manifest.registrationUrl, `${base}/register`);
  const registration = await fetch(manifest.registrationUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId: 'marketplace', serverName: 'Server', serverUrl: wsServer.url, token: 'token' }),
  });
  assert.equal(registration.status, 200);
  await wsServer.next(MessageType.COMMAND_REGISTER);
  const profile = await wsServer.next(MessageType.BOT_UPDATE_PROFILE);
  assert.equal(profile.payload.name, 'Photo Bot');
  assert.equal(profile.payload.avatarBase64, avatar);
  const invalid = await fetch(manifest.registrationUrl, {
    method: 'POST', body: JSON.stringify({ serverName: 'Bad', token: 'token', serverUrl: 'file:///etc/passwd' }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(errors, []);
});

test('marketplace registrations survive a bot restart without being added again', { timeout: 10000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-sdk-registrations-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registrationFile = path.join(directory, 'registrations.json');
  const wsServer = await makeServer(t);
  const first = makeBot(t, wsServer, { registrationFile });
  first.bot.command({ name: 'ping', description: 'Ping', handler: (ctx) => ctx.reply('Pong') });
  const listener = await first.bot.serve({ name: 'Persistent Bot', port: 0, host: '127.0.0.1' });
  const registration = {
    serverId: 'persistent-server', serverName: 'Server', serverUrl: wsServer.url, token: 'saved-token',
  };
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registration),
  });
  assert.equal(response.status, 200);
  await wsServer.next(MessageType.COMMAND_REGISTER);
  await first.bot.close();

  const restarted = makeBot(t, wsServer, { registrationFile });
  restarted.bot.command({ name: 'ping', description: 'Ping', handler: (ctx) => ctx.reply('Pong again') });
  await restarted.bot.serve({ name: 'Persistent Bot', port: 0, host: '127.0.0.1' });
  await wsServer.next(MessageType.COMMAND_REGISTER);
  assert.deepEqual(restarted.bot.serverIds, ['persistent-server']);
  const saved = JSON.parse(fs.readFileSync(registrationFile, 'utf8'));
  assert.deepEqual(saved.registrations, [registration]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(registrationFile).mode & 0o777, 0o600);
  assert.deepEqual([...first.errors, ...restarted.errors], []);
});

test('concurrent authenticated registrations are all restored after restart', { timeout: 10000 }, async (t) => {
  const file = registrationFile(t);
  const servers = await Promise.all([makeServer(t), makeServer(t)]);
  const first = makeBot(t, servers[0], { registrationFile: file });
  first.bot.command({ name: 'ping', description: 'Ping', handler: () => {} });
  const listener = await first.bot.serve({ name: 'Multi-server', port: 0, host: '127.0.0.1' });
  const responses = await Promise.all(servers.map((server, index) => registerAt(listener, {
    serverId: `server-${index}`, serverName: `Server ${index}`, serverUrl: server.url, token: `token-${index}`,
  })));
  assert.ok(responses.every((response) => response.status === 200));
  await Promise.all(servers.map((server) => server.next(MessageType.COMMAND_REGISTER)));
  assert.equal(first.bot.registeredServerCount, 2);
  await first.bot.close();
  const restarted = makeBot(t, servers[0], { registrationFile: file });
  restarted.bot.command({ name: 'ping', description: 'Ping', handler: () => {} });
  await restarted.bot.serve({ name: 'Multi-server', port: 0, host: '127.0.0.1' });
  await Promise.all(servers.map((server) => server.next(MessageType.COMMAND_REGISTER)));
  assert.deepEqual(restarted.bot.serverIds.sort(), ['server-0', 'server-1']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).registrations.length, 2);
  assert.deepEqual([...first.errors, ...restarted.errors], []);
});

test('invalid credentials cannot overwrite a saved registration', { timeout: 10000 }, async (t) => {
  const file = registrationFile(t);
  const server = await makeServer(t, {
    authenticate: (ws, message) => ws.send(JSON.stringify(message.payload.botToken === 'valid-token'
      ? { type: MessageType.AUTH_SUCCESS, payload: {} }
      : { type: MessageType.AUTH_FAILED, payload: { code: ProtocolErrorCode.UNAUTHORIZED, message: 'Token rejected.' } })),
  });
  const { bot, errors } = makeBot(t, server, { registrationFile: file });
  bot.command({ name: 'ping', description: 'Ping', handler: (ctx) => ctx.reply('Still connected') });
  const listener = await bot.serve({ name: 'Safe registration', port: 0, host: '127.0.0.1' });
  const registration = { serverId: 'same-server', serverName: 'Server', serverUrl: server.url, token: 'valid-token' };
  assert.equal((await registerAt(listener, registration)).status, 200);
  await server.next(MessageType.COMMAND_REGISTER);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal((await registerAt(listener, { ...registration, token: 'invalid-token' })).status, 502);
  assert.equal((await registerAt(listener, { ...registration, serverUrl: 'ws://127.0.0.1:1' })).status, 502);
  server.invoke('unchanged-registration', 'ping');
  assert.equal((await server.next(MessageType.COMMAND_RESPONSE)).payload.content, 'Still connected');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(bot.serverIds, ['same-server']);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => /already registered/.test(error.message)));
});

test('a rejected first registration never saves the supplied token', async (t) => {
  const file = registrationFile(t);
  const server = await makeServer(t, {
    authenticate: (ws) => ws.send(JSON.stringify({
      type: MessageType.AUTH_FAILED,
      payload: { code: ProtocolErrorCode.UNAUTHORIZED, message: 'Token rejected.' },
    })),
  });
  const { bot, errors } = makeBot(t, server, { registrationFile: file });
  const listener = await bot.serve({ name: 'Rejected registration', port: 0, host: '127.0.0.1' });
  const response = await registerAt(listener, {
    serverId: 'unknown-server', serverName: 'Server', serverUrl: server.url, token: 'invalid-token',
  });
  assert.equal(response.status, 502);
  assert.equal(fs.existsSync(file), false);
  assert.equal(bot.registeredServerCount, 0);
  assert.equal(bot.serverCount, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Token rejected/);
});

test('registration fails explicitly when credentials cannot be saved', { timeout: 10000 }, async (t) => {
  const file = registrationFile(t);
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server, { registrationFile: file });
  bot.command({ name: 'ping', description: 'Ping', handler: () => {} });
  const listener = await bot.serve({ name: 'Storage failure', port: 0, host: '127.0.0.1' });
  fs.mkdirSync(file);
  const response = await registerAt(listener, {
    serverId: 'not-saved', serverName: 'Server', serverUrl: server.url, token: 'token',
  });
  assert.equal(response.status, 502);
  assert.equal(bot.serverCount, 0);
  assert.equal(bot.registeredServerCount, 0);
  assert.equal(server.frames.some((message) => message.type === MessageType.COMMAND_REGISTER), false);
  assert.equal(errors.length, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['registrations.json']);
});

test('corrupt saved registrations stop startup without erasing data', async (t) => {
  const file = registrationFile(t);
  const corrupt = '{"registrations": incomplete';
  fs.writeFileSync(file, corrupt);
  const { bot } = makeBot(t, { url: 'ws://127.0.0.1:1' }, { registrationFile: file });
  await assert.rejects(bot.serve({ name: 'Corrupt file', port: 0, host: '127.0.0.1' }), /invalid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  assert.equal(bot.serverCount, 0);
});

test('saved registrations cannot be loaded with a different bot identity', async (t) => {
  const file = registrationFile(t);
  const contents = JSON.stringify({ version: 1, publicKey: 'b'.repeat(64), registrations: [] });
  fs.writeFileSync(file, contents);
  const { bot } = makeBot(t, { url: 'ws://127.0.0.1:1' }, { registrationFile: file });
  await assert.rejects(bot.serve({ name: 'Wrong identity', port: 0, host: '127.0.0.1' }), /different bot identity/);
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
});

test('close also settles a marketplace listener whose startup is pending', async (t) => {
  const { bot } = makeBot(t, { url: 'ws://127.0.0.1:1' });
  const starting = bot.serve({ name: 'Closing startup', port: 0, host: '127.0.0.1' });
  const rejected = assert.rejects(starting, /closed/);
  await bot.close();
  await rejected;
  assert.equal(bot.serverCount, 0);
});

test('a rejected avatar is reported without disconnecting the bot or hiding commands', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t, {
    profile: (ws, message) => ws.send(JSON.stringify({
      type: MessageType.SERVER_ERROR, requestId: message.requestId,
      payload: { code: ProtocolErrorCode.INTERNAL_ERROR, message: 'Avatar storage failed.' },
    })),
  });
  const { bot, errors } = makeBot(t, server, { name: 'Profile bot' });
  let authFailures = 0;
  bot.on('auth_failed', () => authFailures++);
  bot.command({ name: 'ping', description: 'Ping', handler: (ctx) => ctx.reply('Still working') });
  const reported = once(bot, 'error');
  bot.connect();
  await Promise.all([server.next(MessageType.COMMAND_REGISTER), reported]);
  assert.equal(bot.serverCount, 1);
  assert.equal(authFailures, 0);
  server.invoke('profile-failed', 'ping');
  assert.equal((await server.next(MessageType.COMMAND_RESPONSE)).payload.content, 'Still working');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Avatar storage failed/);
});

test('authentication rejection is logged and does not retry an invalid token', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t, {
    authenticate: (ws) => ws.send(JSON.stringify({
      type: MessageType.AUTH_FAILED,
      payload: { code: ProtocolErrorCode.UNAUTHORIZED, message: 'Invalid token or identity.' },
    })),
  });
  const { bot, errors } = makeBot(t, server, { autoReconnect: true });
  const reported = once(bot, 'error');
  bot.connect();
  await reported;
  assert.equal(bot.serverCount, 0);
  assert.equal(bot.connections.size, 0);
  assert.match(errors[0].message, /Invalid token or identity/);
});

test('a protocol mismatch can recover after the server is updated', { timeout: 12000 }, async (t) => {
  let attempts = 0;
  const server = await makeServer(t, {
    authenticate: (ws) => ws.send(JSON.stringify(++attempts === 1
      ? {
        type: MessageType.SERVER_ERROR,
        payload: {
          code: ProtocolErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
          message: 'Update the server.', serverProtocolVersion: PROTOCOL_VERSION - 1,
        },
      }
      : { type: MessageType.AUTH_SUCCESS, payload: {} })),
  });
  const { bot, errors } = makeBot(t, server, { autoReconnect: true });
  bot.command({ name: 'ping', description: 'Ping', handler: () => {} });
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER, () => true, 8000);
  assert.equal(attempts, 2);
  assert.equal(bot.serverCount, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Update the server/);
});
