const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const {
  BotClient, LIMITS, MessageType, PROTOCOL_VERSION, ProtocolErrorCode, resolveBotSettingsValues,
} = require('../dist/index.js');

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
    disconnect: () => socket.close(),
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

test('manual authentication announces the bot-owned name before profile and command publication', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server, { name: 'Author Bot' });
  const connected = once(bot, 'connected');
  bot.connect();
  await connected;
  const auth = await server.next(MessageType.AUTH_CONNECT);
  assert.equal(auth.payload.nickname, 'Author Bot');
  const profile = await server.next(MessageType.BOT_UPDATE_PROFILE);
  assert.equal(profile.payload.name, 'Author Bot');
  assert.deepEqual(errors, []);
});

test('a bot can explicitly remove its previous avatar through the SDK', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server, { name: 'No Photo Bot', avatarBase64: null });
  const connected = once(bot, 'connected');
  bot.connect();
  await connected;
  assert.equal((await server.next(MessageType.BOT_UPDATE_PROFILE)).payload.avatarBase64, null);
  assert.deepEqual(errors, []);
});

test('selection metadata is preserved in command choices, autocomplete, forms and selectors', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  const preview = { url: 'https://cdn.example.test/effect.mp3', fileName: 'effect.mp3', durationMs: 1200 };
  const choice = { label: 'Effect', value: 'effect', description: 'Short effect', audio: preview };
  let selected;
  let selector;
  bot.command({
    name: 'sound', description: 'Sound',
    options: [
      { name: 'static', description: 'Static', type: 'string', required: true, choices: [choice] },
      { name: 'query', description: 'Query', type: 'string', autocomplete: true },
    ],
    autocomplete: async () => [{ ...choice, value: `/instant/${'a'.repeat(503)}` }],
    handler: async (ctx) => {
      selected = await ctx.choose({ title: 'Pick', choices: [choice], presentation: 'buttons' });
      selector = await ctx.createSelector({
        id: 'sound-selector', title: 'Pick publicly', choices: [choice],
        presentation: 'buttons', responder: 'any', allowChange: true, maxResponders: 1,
      });
    },
  });
  const connected = once(bot, 'connected');
  bot.connect({ serverId: 'selection-server' });
  await connected;

  const registered = await server.next(MessageType.COMMAND_REGISTER);
  assert.deepEqual(registered.payload.commands[0].options[0].choices[0], choice);

  server.send(MessageType.COMMAND_AUTOCOMPLETE, {
    commandName: 'sound', optionName: 'query', query: 'eff', options: { static: 'effect' }, locale: 'en',
  }, 'autocomplete-one');
  assert.deepEqual((await server.next(MessageType.COMMAND_AUTOCOMPLETE_RESULT)).payload, {
    status: 'ok', choices: [{ ...choice, value: `/instant/${'a'.repeat(503)}` }],
  });

  server.invoke('caller-one', 'sound', { options: { static: 'effect' } });
  const prompt = await server.next(MessageType.COMMAND_PROMPT);
  assert.deepEqual(prompt.payload.form.fields[0].choices[0], choice);
  server.send(MessageType.COMMAND_SUBMITTED, {
    invocationId: 'caller-one', interactionId: prompt.payload.interactionId, values: { choice: 'effect' },
  });
  const created = await server.next(MessageType.SELECTOR_CREATE);
  assert.deepEqual(created.payload.choices[0], choice);
  const { invocationId, ...selectorDefinition } = created.payload;
  const snapshot = {
    ...selectorDefinition, botId: 'bot-one', messageId: 'selector-message',
    createdAt: 1, closedAt: null, responses: {}, resultMessageId: null, sourceInvocationId: invocationId,
  };
  server.send(MessageType.SELECTOR_SNAPSHOT, snapshot, created.requestId);
  assert.equal((await server.next(MessageType.COMMAND_FINISH)).payload.failed, false);
  assert.equal(selected, 'effect');
  assert.deepEqual(selector.choices[0], choice);
  assert.deepEqual(errors, []);
});

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

test('durable selectors correlate acknowledgements, emit updates and outlive invocations', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  let published;
  bot.command({
    name: 'poll', description: 'Poll',
    handler: async (ctx) => {
      published = await ctx.createSelector({
        id: 'poll-one', title: 'Question?', choices: [{ label: 'A', value: 'a' }],
        presentation: 'buttons', responder: 'any', allowChange: true, maxResponders: 2,
      });
    },
  });
  const connected = once(bot, 'connected');
  bot.connect({ serverId: 'selector-server' });
  await connected;
  server.invoke('caller-one', 'poll');
  const created = await server.next(MessageType.SELECTOR_CREATE);
  assert.equal(created.payload.channelId, 'channel-one');
  assert.equal(created.payload.invokerId, 'caller-one');
  assert.equal(created.payload.invocationId, 'caller-one');
  const { invocationId: sourceInvocationId, ...definition } = created.payload;
  const selector = {
    ...definition, id: 'poll-one', botId: 'bot-one', messageId: 'question-one',
    createdAt: 1, closedAt: null, responses: {}, resultMessageId: null, messagePublished: true,
    creatorUserId: 'caller-one', sourceInvocationId,
  };
  server.send(MessageType.SELECTOR_SNAPSHOT, selector, created.requestId);
  await server.next(MessageType.COMMAND_FINISH);
  assert.equal(published.id, selector.id);
  const updated = once(bot, 'selectorUpdate');
  server.send(MessageType.SELECTOR_SNAPSHOT, { ...selector, responses: { human: 'a' } });
  assert.deepEqual((await updated)[0], {
    serverId: 'selector-server', selector: { ...selector, responses: { human: 'a' } },
  });
  const listing = bot.listSelectors('selector-server');
  const listRequest = await server.next(MessageType.SELECTOR_LIST);
  server.send(MessageType.SELECTOR_LIST_RESULT, { selectors: [selector] }, listRequest.requestId);
  assert.equal((await listing)[0].id, selector.id);
  const update = bot.updateSelector('selector-server', selector.id, { title: 'Updated?' });
  const updateRequest = await server.next(MessageType.SELECTOR_UPDATE);
  assert.deepEqual(updateRequest.payload.patch, { title: 'Updated?' });
  server.send(MessageType.SELECTOR_SNAPSHOT, { ...selector, title: 'Updated?' }, updateRequest.requestId);
  assert.equal((await update).title, 'Updated?');
  const close = bot.closeSelector('selector-server', selector.id);
  const closeRequest = await server.next(MessageType.SELECTOR_CLOSE);
  const closedSelector = { ...selector, closedAt: 2 };
  server.send(MessageType.SELECTOR_SNAPSHOT, closedSelector, closeRequest.requestId);
  await close;
  const finalize = bot.finalizeSelector('selector-server', selector.id, 'Final result');
  const finalRequest = await server.next(MessageType.SELECTOR_FINALIZE);
  server.send(MessageType.SELECTOR_SNAPSHOT, { ...closedSelector, resultMessageId: 'final-one' }, finalRequest.requestId);
  assert.equal((await finalize).resultMessageId, 'final-one');
  const denied = bot.closeSelector('selector-server', 'another-bots-selector');
  const rejected = assert.rejects(denied, /not owned/);
  const deniedRequest = await server.next(MessageType.SELECTOR_CLOSE);
  server.send(MessageType.SERVER_ERROR, { message: 'not owned' }, deniedRequest.requestId);
  await rejected;
  const interrupted = bot.listSelectors('selector-server');
  const disconnected = assert.rejects(interrupted, /disconnected/);
  await bot.close();
  await disconnected;
  assert.deepEqual(errors, []);
});

test('public message reply option preserves trusted acknowledgement metadata', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  const connected = once(bot, 'connected');
  bot.connect({ serverId: 'reply-server' });
  await connected;
  const sent = bot.sendMessage('reply-server', 'channel-one', 'Answer', { replyToMessageId: 'original' });
  const frame = await server.next(MessageType.CHAT_SEND);
  assert.equal(frame.payload.replyToMessageId, 'original');
  const reply = { messageId: 'original', userNickname: 'Alice', content: 'Question', deleted: false, hasAttachments: false };
  server.send(MessageType.CHAT_MESSAGE, {
    id: 'response', channelId: 'channel-one', userId: 'bot-one', userNickname: 'Answer bot',
    content: frame.payload.content, createdAt: Date.now(), isBot: true, reply,
  }, frame.requestId);
  assert.deepEqual((await sent).reply, reply);
  await assert.rejects(bot.sendMessage('reply-server', 'channel-one', 'Invalid', { replyToMessageId: '' }));
  await bot.close();
  assert.deepEqual(errors, []);
});

test('persistent messages are acknowledged and reactions outlive command invocations', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  const connected = once(bot, 'connected');
  bot.connect({ serverId: 'reaction-server' });
  await connected;
  const sent = bot.sendMessage('reaction-server', 'channel-one', 'First question?');
  const frame = await server.next(MessageType.CHAT_SEND);
  assert.equal(frame.payload.content, 'First question?');
  server.send(MessageType.CHAT_MESSAGE, {
    id: 'question-one', channelId: 'channel-one', userId: 'bot-one', userNickname: 'Question bot',
    content: frame.payload.content, createdAt: Date.now(), isBot: true,
  }, frame.requestId);
  const message = await sent;
  assert.equal(message.id, 'question-one');
  const events = [];
  const removeListener = bot.onReactionAdded((event, context) => events.push({ event, context }));
  const event = { channelId: 'channel-one', messageId: message.id, emoji: '👍', userId: 'human-one', userNickname: 'Alice' };
  const added = once(bot, 'reactionAdded');
  server.send(MessageType.CHAT_REACTION_ADDED, event);
  await added;
  assert.deepEqual(events, [{ event, context: { serverId: 'reaction-server' } }]);
  removeListener();
  bot.addReaction('reaction-server', 'channel-one', message.id, '❤️');
  assert.deepEqual((await server.next(MessageType.CHAT_REACTION_ADD)).payload, { channelId: 'channel-one', messageId: message.id, emoji: '❤️' });
  bot.removeReaction('reaction-server', 'channel-one', message.id, '❤️');
  assert.equal((await server.next(MessageType.CHAT_REACTION_REMOVE)).payload.emoji, '❤️');
  const removed = once(bot, 'reactionRemoved');
  server.send(MessageType.CHAT_REACTION_REMOVED, event);
  assert.deepEqual((await removed)[0], event);
  assert.throws(() => bot.addReaction('reaction-server', 'channel-one', message.id, 'not emoji'));
  const denied = bot.sendMessage('reaction-server', 'private', 'Not allowed');
  const rejected = assert.rejects(denied, /permission denied/);
  const deniedFrame = await server.next(MessageType.CHAT_SEND);
  server.send(MessageType.SERVER_ERROR, { message: 'permission denied' }, deniedFrame.requestId);
  await rejected;
  const interrupted = bot.sendMessage('reaction-server', 'channel-one', 'Unacknowledged');
  const disconnected = assert.rejects(interrupted, /connection closed/);
  await bot.close();
  await disconnected;
  assert.deepEqual(errors, []);
});

test('reaction subscriptions filter a human answer, advance the question and unsubscribe', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  const connected = once(bot, 'connected');
  bot.connect({ serverId: 'question-server' });
  await connected;
  const firstQuestion = bot.sendMessage('question-server', 'channel-one', 'Continue? React 👍');
  const firstFrame = await server.next(MessageType.CHAT_SEND);
  server.send(MessageType.CHAT_MESSAGE, {
    id: 'question-one', channelId: 'channel-one', userId: 'bot-one', userNickname: 'Question bot',
    content: firstFrame.payload.content, createdAt: Date.now(), isBot: true,
  }, firstFrame.requestId);
  const question = await firstQuestion;
  const baseline = bot.listenerCount('reactionAdded');
  let nextQuestion;
  let matchingAnswers = 0;
  const stop = bot.onReactionAdded((reaction, origin) => {
    if (origin.serverId !== 'question-server' || reaction.channelId !== question.channelId ||
        reaction.messageId !== question.id || reaction.userId !== 'human-one' || reaction.emoji !== '👍') return;
    stop();
    clearTimeout(timeout);
    matchingAnswers += 1;
    nextQuestion = bot.sendMessage(origin.serverId, question.channelId, 'Next question: which game?');
  });
  const timeout = setTimeout(stop, 5000);
  t.after(() => { clearTimeout(timeout); stop(); });
  const answer = { channelId: question.channelId, messageId: question.id, emoji: '👍', userId: 'human-one', userNickname: 'Alice' };
  for (const distractor of [
    { channelId: 'another-channel' }, { messageId: 'another-question' },
    { userId: 'bot-one' }, { emoji: '👎' },
  ]) server.send(MessageType.CHAT_REACTION_ADDED, { ...answer, ...distractor });
  server.send(MessageType.CHAT_REACTION_ADDED, answer);
  server.send(MessageType.CHAT_REACTION_ADDED, answer);
  const nextFrame = await server.next(MessageType.CHAT_SEND);
  assert.equal(nextFrame.payload.content, 'Next question: which game?');
  assert.equal(matchingAnswers, 1);
  assert.equal(bot.listenerCount('reactionAdded'), baseline);
  server.send(MessageType.CHAT_MESSAGE, {
    id: 'question-two', channelId: question.channelId, userId: 'bot-one', userNickname: 'Question bot',
    content: nextFrame.payload.content, createdAt: Date.now(), isBot: true,
  }, nextFrame.requestId);
  assert.equal((await nextQuestion).id, 'question-two');
  assert.deepEqual(errors, []);
});

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

test('private choices support button and confirmed dropdown turns', { timeout: 10000 }, async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  bot.command({
    name: 'choose', description: 'Choose twice',
    handler: async (ctx) => {
      const first = await ctx.choose({
        title: 'First turn', presentation: 'buttons',
        choices: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }],
      });
      if (first === null) return;
      const second = await ctx.choose({
        title: `After ${first}`, submitLabel: 'Confirm',
        choices: [{ label: 'Continue', value: 'continue' }],
      });
      if (second !== null) ctx.reply(`${first}:${second}`);
    },
  });
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER);
  server.invoke('choice-flow', 'choose');
  const first = await server.next(MessageType.COMMAND_PROMPT);
  assert.equal(first.payload.form.fields[0].presentation, 'buttons');
  server.send(MessageType.COMMAND_SUBMITTED, {
    invocationId: 'choice-flow', interactionId: first.payload.interactionId, values: { choice: 'two' },
  });
  const second = await server.next(MessageType.COMMAND_PROMPT);
  assert.equal(second.payload.form.title, 'After two');
  assert.equal(second.payload.form.fields[0].presentation, 'dropdown');
  assert.equal(second.payload.form.submitLabel, 'Confirm');
  server.send(MessageType.COMMAND_SUBMITTED, {
    invocationId: 'choice-flow', interactionId: second.payload.interactionId, values: { choice: 'continue' },
  });
  assert.equal((await server.next(MessageType.COMMAND_RESPONSE)).payload.content, 'two:continue');
  await server.next(MessageType.COMMAND_FINISH);
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
  assert.equal((await wsServer.next(MessageType.AUTH_CONNECT)).payload.nickname, 'Photo Bot');
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

const autocompleteOptions = [
  { name: 'sound', description: 'Sound', type: 'string', autocomplete: true, required: true },
  { name: 'count', description: 'Count', type: 'integer', min: 0, max: 10 },
  { name: 'enabled', description: 'Enabled', type: 'boolean' },
];
const soundDownloadRequest = { url: 'https://example.com/sound.mp3', fileName: 'sound.mp3', title: 'Sound' };

function autocompleteRequest(query, options = {}) {
  return { commandName: 'search', optionName: 'sound', query, options, locale: 'en' };
}

async function sdkBarrier(server) {
  server.send(MessageType.PING, {});
  await server.next(MessageType.PONG);
}

test('autocomplete registration and callbacks preserve typed partial options without invoking commands', async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  assert.throws(() => bot.command({
    name: 'search', description: 'Search', options: autocompleteOptions, handler: () => {},
  }), /autocomplete handler/);
  const value = `/instant/${'x'.repeat(503)}`;
  let context;
  bot.command({
    name: 'search', description: 'Search', options: autocompleteOptions, downloadsSound: true,
    autocomplete: (ctx) => {
      context = ctx;
      return [{ label: 'Sound', value, description: 'Audio' }];
    },
    handler: () => assert.fail('Autocomplete must not invoke the command'),
  });
  bot.connect({ serverId: 'autocomplete-server' });
  const registration = await server.next(MessageType.COMMAND_REGISTER);
  assert.equal(registration.payload.commands[0].downloadsSound, true);
  assert.equal(registration.payload.commands[0].options[0].autocomplete, true);
  assert.equal('autocomplete' in registration.payload.commands[0], false);
  server.send(MessageType.COMMAND_AUTOCOMPLETE, autocompleteRequest('hello', { count: 0, enabled: false }), 'query');
  const result = await server.next(MessageType.COMMAND_AUTOCOMPLETE_RESULT);
  assert.equal(result.requestId, 'query');
  assert.deepEqual(result.payload, { status: 'ok', choices: [{ label: 'Sound', value, description: 'Audio' }] });
  assert.equal(context.query, 'hello');
  assert.equal(context.optionName, 'sound');
  assert.equal(context.locale, 'en');
  assert.equal(context.serverId, 'autocomplete-server');
  assert.deepEqual(context.args, { count: 0, enabled: false });
  assert.equal(context.signal.aborted, true);
  assert.equal('invokerId' in context, false);
  assert.equal('downloadSound' in context, false);
  assert.equal(server.frames.some((frame) => frame.type === MessageType.COMMAND_FINISH), false);
  assert.deepEqual(errors, []);
});

test('autocomplete cancellation and disconnect isolate identical request IDs across servers and suppress late results', async (t) => {
  const first = await makeServer(t);
  const second = await makeServer(t);
  const { bot, errors } = makeBot(t, first);
  const pending = new Map();
  let count = 0;
  let ready;
  let thirdReady;
  const bothStarted = new Promise((resolve) => { ready = resolve; });
  const thirdStarted = new Promise((resolve) => { thirdReady = resolve; });
  bot.command({
    name: 'search', description: 'Search', options: autocompleteOptions, handler: () => {},
    autocomplete: (ctx) => new Promise((resolve) => {
      pending.set(ctx.serverId, { ctx, resolve });
      count += 1;
      if (count === 2) ready();
      if (count === 3) thirdReady();
    }),
  });
  bot.connect({ serverId: 'first' });
  bot.connect({ serverId: 'second', serverUrl: second.url });
  await Promise.all([first.next(MessageType.COMMAND_REGISTER), second.next(MessageType.COMMAND_REGISTER)]);
  first.send(MessageType.COMMAND_AUTOCOMPLETE, autocompleteRequest('first'), 'same');
  second.send(MessageType.COMMAND_AUTOCOMPLETE, autocompleteRequest('second'), 'same');
  await bothStarted;
  first.send(MessageType.COMMAND_AUTOCOMPLETE, autocompleteRequest('duplicate'), 'same');
  first.send(MessageType.COMMAND_AUTOCOMPLETE_CANCEL, { requestId: 'same' });
  await sdkBarrier(first);
  assert.equal(count, 2, 'A duplicate correlation must not launch another callback.');
  assert.equal(pending.get('first').ctx.signal.aborted, true);
  assert.equal(pending.get('second').ctx.signal.aborted, false);
  pending.get('first').resolve([{ label: 'Old', value: 'old' }]);
  pending.get('second').resolve([{ label: 'Current', value: 'current' }]);
  assert.equal((await second.next(MessageType.COMMAND_AUTOCOMPLETE_RESULT)).payload.choices[0].value, 'current');
  await sdkBarrier(first);
  assert.equal(first.frames.some((frame) => frame.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT), false);
  first.send(MessageType.COMMAND_AUTOCOMPLETE, autocompleteRequest('disconnect'), 'disconnected');
  await thirdStarted;
  bot.disconnect('first');
  assert.equal(pending.get('first').ctx.signal.aborted, true);
  pending.get('first').resolve([]);
  await sdkBarrier(second);
  assert.deepEqual(errors, []);
});

test('autocomplete reports source errors, rejects invalid choices and bounds its own timeout', async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  let timedContext;
  let finish;
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  bot.command({
    name: 'search', description: 'Search', options: autocompleteOptions, handler: () => {},
    autocomplete: (ctx) => {
      if (ctx.query === 'throw') throw new Error('Source failed');
      if (ctx.query === 'invalid') return [{ label: 'Duplicate', value: 'same' }, { label: 'Duplicate', value: 'same' }];
      if (ctx.query === 'empty') return [];
      timedContext = ctx;
      started();
      return new Promise((resolve) => { finish = resolve; });
    },
  });
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER);
  for (const [query, expected] of [
    ['throw', { status: 'failed', reason: 'handler_failed' }],
    ['invalid', { status: 'failed', reason: 'invalid_response' }],
    ['empty', { status: 'ok', choices: [] }],
  ]) {
    server.send(MessageType.COMMAND_AUTOCOMPLETE, autocompleteRequest(query), query);
    assert.deepEqual((await server.next(MessageType.COMMAND_AUTOCOMPLETE_RESULT)).payload, expected);
  }
  server.send(MessageType.COMMAND_AUTOCOMPLETE, autocompleteRequest('bad args', { sound: 'edited option' }), 'invalid-option');
  assert.equal((await server.next(MessageType.COMMAND_AUTOCOMPLETE_RESULT)).payload.reason, 'invalid_response');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    server.send(MessageType.COMMAND_AUTOCOMPLETE, autocompleteRequest('timeout'), 'timed');
    await began;
    t.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_TIMEOUT_MS);
    const expired = await server.next(MessageType.COMMAND_AUTOCOMPLETE_RESULT);
    assert.deepEqual(expired.payload, { status: 'failed', reason: 'timeout' });
    assert.equal(timedContext.signal.aborted, true);
    finish([{ label: 'Late', value: 'late' }]);
    await sdkBarrier(server);
    assert.equal(server.frames.some((frame) => frame.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT), false);
  } finally {
    t.mock.timers.reset();
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Source failed/);
});

test('sound downloads await structured outcomes, remain private and consume one request per invocation', async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  t.mock.method(globalThis, 'fetch', () => assert.fail('The SDK must not download audio'));
  const outcomes = new Map();
  bot.command({
    name: 'download', description: 'Download', downloadsSound: true,
    handler: async (ctx) => {
      const pending = ctx.downloadSound(soundDownloadRequest);
      assert.throws(() => ctx.downloadSound(soundDownloadRequest), /Only one/);
      const result = await pending;
      outcomes.set(ctx.invocationId, result);
      assert.throws(() => ctx.downloadSound(soundDownloadRequest), /Only one/);
      if (result) ctx.reply(result.status);
    },
  });
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER);
  assert.equal(LIMITS.MAX_SOUNDBOARD_FILE_SIZE, 3 * 1024 * 1024);
  assert.equal('downloadSound' in bot, false);
  const results = [
    { status: 'downloaded' }, { status: 'exists' },
    { status: 'failed', reason: 'too_large' }, { status: 'cancelled' },
    { status: 'failed', reason: 'timeout' },
  ];
  for (const [index, result] of results.entries()) {
    const invocationId = `download-${index}`;
    server.invoke(invocationId, 'download', { allowSoundDownload: true });
    const request = await server.next(MessageType.COMMAND_SOUND_DOWNLOAD);
    assert.deepEqual(request.payload, { ...soundDownloadRequest, invocationId });
    assert.ok(request.requestId);
    assert.equal(outcomes.has(invocationId), false);
    assert.equal(server.frames.some((frame) => frame.type === MessageType.COMMAND_FINISH && frame.payload.invocationId === invocationId), false);
    server.send(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
      invocationId: 'forged-invocation', downloadId: 'download-id', result,
    }, request.requestId);
    await sdkBarrier(server);
    assert.equal(outcomes.has(invocationId), false);
    server.send(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, { invocationId, downloadId: 'download-id', result }, request.requestId);
    const response = await server.next(MessageType.COMMAND_RESPONSE);
    assert.equal(response.payload.ephemeral, true);
    assert.equal(response.payload.content, result.status);
    await server.next(MessageType.COMMAND_FINISH);
    assert.deepEqual(outcomes.get(invocationId), result);
  }
  assert.deepEqual(errors, []);
});

test('sound downloads reject missing consent, invalid metadata and server errors without leaking another invocation', async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  let context;
  bot.command({
    name: 'download', description: 'Download', downloadsSound: true,
    handler: async (ctx) => {
      context = ctx;
      assert.throws(() => ctx.downloadSound({ ...soundDownloadRequest, fileName: '..\\escape.mp3' }));
      await ctx.downloadSound(soundDownloadRequest);
    },
  });
  bot.command({
    name: 'plain', description: 'Not a downloader',
    handler: async (ctx) => { await ctx.downloadSound(soundDownloadRequest); },
  });
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER);
  for (const [invocationId, commandName, extra] of [
    ['no-consent', 'download', {}], ['undeclared', 'plain', { allowSoundDownload: true }],
  ]) {
    server.invoke(invocationId, commandName, extra);
    assert.equal((await server.next(MessageType.COMMAND_FINISH)).payload.failed, true);
    assert.equal(server.frames.some((frame) => frame.type === MessageType.COMMAND_SOUND_DOWNLOAD), false);
  }
  server.invoke('denied', 'download', { allowSoundDownload: true });
  const request = await server.next(MessageType.COMMAND_SOUND_DOWNLOAD);
  server.send(MessageType.SERVER_ERROR, { code: ProtocolErrorCode.PERMISSION_DENIED, message: 'Download denied.' }, request.requestId);
  assert.equal((await server.next(MessageType.COMMAND_FINISH)).payload.failed, true);
  assert.equal(context.signal.aborted, true);
  assert.throws(() => context.downloadSound(soundDownloadRequest), /already ended/);
  server.invoke('invalid-result', 'download', { allowSoundDownload: true });
  const invalid = await server.next(MessageType.COMMAND_SOUND_DOWNLOAD);
  server.send(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
    invocationId: 'invalid-result', downloadId: 'download-id', result: { status: 'downloaded', filePath: 'private-path' },
  }, invalid.requestId);
  assert.equal((await server.next(MessageType.COMMAND_FINISH)).payload.failed, true);
  assert.equal(errors.length, 4);
});

test('sound download cancellation, completion and disconnection settle pending handlers with null', async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  const outcomes = new Map();
  const contexts = new Map();
  const completed = new EventEmitter();
  bot.command({
    name: 'download', description: 'Download', downloadsSound: true,
    handler: async (ctx) => {
      contexts.set(ctx.invocationId, ctx);
      outcomes.set(ctx.invocationId, await ctx.downloadSound(soundDownloadRequest));
      completed.emit('done');
    },
  });
  bot.connect();
  await server.next(MessageType.COMMAND_REGISTER);
  for (const reason of ['cancelled', 'expired', 'bot_disconnected', 'caller_disconnected', 'failed', 'completed']) {
    server.invoke(reason, 'download', { allowSoundDownload: true });
    await server.next(MessageType.COMMAND_SOUND_DOWNLOAD);
    const done = once(completed, 'done');
    server.send(MessageType.COMMAND_FINISHED, { invocationId: reason, channelId: 'channel-one', reason });
    await done;
    assert.equal(outcomes.get(reason), null);
    assert.equal(contexts.get(reason).signal.aborted, true);
    assert.throws(() => contexts.get(reason).downloadSound(soundDownloadRequest), /already ended/);
  }
  server.invoke('disconnected', 'download', { allowSoundDownload: true });
  await server.next(MessageType.COMMAND_SOUND_DOWNLOAD);
  const disconnected = once(completed, 'done');
  await bot.close();
  await disconnected;
  assert.equal(outcomes.get('disconnected'), null);
  assert.equal(server.frames.some((frame) => frame.type === MessageType.COMMAND_FINISH), false);
  assert.deepEqual(errors, []);
});

test('sound downloads correlate identical invocation IDs on different servers and clean unawaited requests', async (t) => {
  const first = await makeServer(t);
  const second = await makeServer(t);
  const { bot, errors } = makeBot(t, first);
  const results = new Map();
  let unawaited;
  bot.command({
    name: 'download', description: 'Download', downloadsSound: true,
    handler: async (ctx) => { results.set(ctx.serverId, await ctx.downloadSound(soundDownloadRequest)); },
  });
  bot.command({
    name: 'unawaited', description: 'Unawaited', downloadsSound: true,
    handler: (ctx) => { unawaited = ctx.downloadSound(soundDownloadRequest); },
  });
  bot.connect({ serverId: 'first' });
  bot.connect({ serverId: 'second', serverUrl: second.url });
  await Promise.all([first.next(MessageType.COMMAND_REGISTER), second.next(MessageType.COMMAND_REGISTER)]);
  first.invoke('same', 'download', { allowSoundDownload: true });
  second.invoke('same', 'download', { allowSoundDownload: true });
  const [firstRequest, secondRequest] = await Promise.all([
    first.next(MessageType.COMMAND_SOUND_DOWNLOAD), second.next(MessageType.COMMAND_SOUND_DOWNLOAD),
  ]);
  first.send(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
    invocationId: 'same', downloadId: 'second-download', result: { status: 'exists' },
  }, secondRequest.requestId);
  await sdkBarrier(first);
  assert.equal(results.size, 0);
  first.send(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
    invocationId: 'same', downloadId: 'first-download', result: { status: 'downloaded' },
  }, firstRequest.requestId);
  second.send(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
    invocationId: 'same', downloadId: 'second-download', result: { status: 'exists' },
  }, secondRequest.requestId);
  await Promise.all([first.next(MessageType.COMMAND_FINISH), second.next(MessageType.COMMAND_FINISH)]);
  assert.deepEqual(results.get('first'), { status: 'downloaded' });
  assert.deepEqual(results.get('second'), { status: 'exists' });
  first.invoke('unawaited', 'unawaited', { allowSoundDownload: true });
  await first.next(MessageType.COMMAND_SOUND_DOWNLOAD);
  await first.next(MessageType.COMMAND_FINISH);
  assert.equal(await unawaited, null);
  assert.deepEqual(errors, []);
});

function settingsDefinition() {
  return {
    server: {
      title: 'Shared settings',
      fields: [
        { name: 'enabled', label: 'Enabled', type: 'boolean', required: true, defaultValue: true },
        { name: 'limit', label: 'Limit', type: 'integer', required: true, min: 0, max: 20, defaultValue: 2 },
        { name: 'labels', label: 'Labels', type: 'string-list', maxItems: 3, maxLength: 30, defaultValue: ['general'] },
        { name: 'note', label: 'Note', type: 'text', maxLength: 100, defaultValue: 'Shared note' },
      ],
    },
    user: {
      title: 'Personal preferences',
      fields: [
        {
          name: 'tone', label: 'Tone', type: 'select', required: true, defaultValue: 'brief',
          choices: [{ label: 'Brief', value: 'brief' }, { label: 'Full', value: 'full' }],
        },
        { name: 'muted', label: 'Muted', type: 'boolean', required: true, defaultValue: false },
        { name: 'aliases', label: 'Aliases', type: 'string-list', maxItems: 3, maxLength: 30, defaultValue: ['default'] },
        { name: 'note', label: 'Note', type: 'text', maxLength: 100, defaultValue: 'Personal note' },
      ],
    },
  };
}

function serverSettings(values = {}, schemaRevision = 2, revision = 3) {
  return {
    schemaRevision, revision,
    values: { enabled: true, limit: 2, labels: ['general'], note: 'Shared note', ...values },
  };
}

function executionSettings(snapshot, user = {}) {
  return structuredClone({
    schemaRevision: snapshot.schemaRevision, serverRevision: snapshot.revision,
    server: snapshot.values, user: { tone: 'brief', muted: false, aliases: ['default'], note: 'Personal note', ...user },
  });
}

function detailedSettings(snapshot, definition = settingsDefinition(), botId = 'bot-one') {
  return structuredClone({
    bot: {
      botId, name: 'Settings bot', online: true, capabilities: { downloadsSound: false },
      schemaRevision: snapshot.schemaRevision, revision: snapshot.revision,
      hasServerSettings: !!definition.server, hasUserSettings: !!definition.user, canConfigure: !!definition.server,
    },
    definition, ...(definition.server ? { server: snapshot } : {}),
  });
}

function makeSettingsServer(t) {
  return makeServer(t, {
    authenticate: (ws) => ws.send(JSON.stringify({
      type: MessageType.AUTH_SUCCESS, payload: { currentUser: { id: 'bot-one' } },
    })),
  });
}

async function hydrateSettings(server, snapshot, registered = 1) {
  server.send(MessageType.COMMAND_REGISTERED, { registered, settings: snapshot });
  await sdkBarrier(server);
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

test('settings validate defaults, register cloned declarations and hydrate immutable snapshots', { timeout: 10000 }, async (t) => {
  const server = await makeSettingsServer(t);
  const { bot, errors } = makeBot(t, server);
  const declaration = settingsDefinition();
  const expected = structuredClone(declaration);
  const snapshot = serverSettings();
  assert.equal(PROTOCOL_VERSION, 14);
  assert.deepEqual(resolveBotSettingsValues(declaration.server, {}), { success: true, values: snapshot.values });
  assert.equal(bot.settings(declaration), bot);
  const invalid = settingsDefinition();
  delete invalid.user.fields[0].defaultValue;
  assert.throws(() => bot.settings(invalid), /default/i);
  assert.throws(() => bot.settings({ ...declaration, downloadPath: 'C:\\private\\sounds' }));
  declaration.server.fields[2].defaultValue.push('changed after declaration');
  declaration.user.fields[0].choices[0].label = 'Changed';
  bot.command({ name: 'ping', description: 'Ping', handler: () => {} });

  const first = [];
  const second = [];
  const stopFirst = bot.onSettingsChanged((value, context) => {
    assertDeepFrozen(value);
    assertDeepFrozen(context);
    assert.equal(Reflect.set(value.values, 'limit', 19), false);
    assert.throws(() => value.values.labels.push('mutation'));
    first.push({ value, context });
  });
  const stopSecond = bot.onSettingsChanged((value, context) => second.push({ value, context }));
  let connectedSnapshot = 'not connected';
  bot.on('connected', ({ serverId }) => { connectedSnapshot = bot.getServerSettings(serverId); });
  const connected = once(bot, 'connected');
  bot.connect({ serverId: 'settings-server' });
  assert.equal(bot.getServerSettings('settings-server'), undefined);
  assert.throws(() => bot.settings({}), /before connecting or serving/);
  await connected;
  assert.equal(connectedSnapshot, undefined, 'Connected must not wait for the registration acknowledgement.');
  const registration = await server.next(MessageType.COMMAND_REGISTER);
  assert.deepEqual(registration.payload.settings, expected);
  assert.equal(bot.getServerSettings('missing-server'), undefined);
  await hydrateSettings(server, snapshot);
  assert.deepEqual(first, [{ value: snapshot, context: { serverId: 'settings-server' } }]);
  assert.deepEqual(second, first);
  assert.notEqual(first[0].value, second[0].value);
  assert.notEqual(first[0].value.values.labels, second[0].value.values.labels);
  const value = bot.getServerSettings('settings-server');
  assertDeepFrozen(value);
  assert.deepEqual(value, snapshot);
  assert.notEqual(value, bot.getServerSettings('settings-server'));
  assert.notEqual(value.values.labels, first[0].value.values.labels);
  assert.equal(Reflect.set(value, 'revision', 100), false);
  assert.equal(Reflect.deleteProperty(value.values, 'enabled'), false);

  await hydrateSettings(server, { ...snapshot, values: { note: 'Shared note', labels: ['general'], limit: 2, enabled: true } });
  assert.equal(first.length, 1, 'Equivalent repeated acknowledgements must not notify again.');
  const updated = serverSettings({ limit: 4, labels: ['updated'] }, 2, 4);
  server.send(MessageType.BOT_SETTINGS_SNAPSHOT, detailedSettings(updated));
  await sdkBarrier(server);
  assert.deepEqual(bot.getServerSettings('settings-server'), updated);
  assert.equal(first.length, 2);
  assert.deepEqual(value, snapshot, 'Previously returned snapshots cannot change.');
  stopFirst();
  const newest = serverSettings({ limit: 5 }, 2, 5);
  server.send(MessageType.BOT_SETTINGS_SNAPSHOT, detailedSettings(newest));
  await sdkBarrier(server);
  assert.equal(first.length, 2);
  assert.equal(second.length, 3);
  stopSecond();
  assert.equal(bot.listenerCount('settingsChanged'), 0);
  assert.deepEqual(errors, []);
});

test('settings declarations are static while a port-zero marketplace fixture is starting or serving', async (t) => {
  const server = await makeServer(t);
  const { bot, errors } = makeBot(t, server);
  bot.settings(settingsDefinition());
  const starting = bot.serve({ name: 'Settings fixture', host: '127.0.0.1', port: 0 });
  assert.throws(() => bot.settings({}), /before connecting or serving/);
  const listener = await starting;
  assert.equal((await fetch(`http://127.0.0.1:${listener.address().port}/manifest`)).status, 200);
  assert.throws(() => bot.settings({}), /before connecting or serving/);
  await bot.close();
  assert.throws(() => bot.settings({}), /closed/);
  assert.deepEqual(errors, []);
});

test('settings snapshots reject stale, conflicting, malformed and wrong-bot data without replacing the cache', { timeout: 10000 }, async (t) => {
  const server = await makeSettingsServer(t);
  const { bot, errors } = makeBot(t, server);
  bot.settings(settingsDefinition());
  const changes = [];
  const origins = [];
  bot.onSettingsChanged((snapshot) => changes.push(snapshot));
  bot.on('error', (_error, context) => origins.push(context));
  bot.connect({ serverId: 'settings-server' });
  await server.next(MessageType.COMMAND_REGISTER);
  const snapshot = serverSettings();
  await hydrateSettings(server, snapshot, 0);
  const changedDefinition = settingsDefinition();
  changedDefinition.server.title = 'Different declaration';
  const inconsistent = detailedSettings(serverSettings({}, 2, 4));
  inconsistent.bot.revision = 5;
  const redacted = detailedSettings(snapshot);
  delete redacted.definition.server;
  delete redacted.server;
  redacted.bot.canConfigure = false;
  const invalid = [
    [MessageType.COMMAND_REGISTERED, { registered: 0 }],
    [MessageType.COMMAND_REGISTERED, { registered: 0, settings: { ...snapshot, values: {} } }],
    [MessageType.COMMAND_REGISTERED, { registered: 0, settings: { ...snapshot, revision: -1 } }],
    [MessageType.COMMAND_REGISTERED, { registered: 0, settings: serverSettings({ limit: 21 }, 2, 4) }],
    [MessageType.COMMAND_REGISTERED, { registered: 0, settings: serverSettings({ labels: ['same', 'SAME'] }, 2, 4) }],
    [MessageType.COMMAND_REGISTERED, { registered: 0, settings: serverSettings({ hostPath: 'C:\\private' }, 2, 4) }],
    [MessageType.COMMAND_REGISTERED, { registered: 0, settings: serverSettings({ enabled: false }) }],
    [MessageType.BOT_SETTINGS_SNAPSHOT, detailedSettings(serverSettings({}, 2, 2))],
    [MessageType.BOT_SETTINGS_SNAPSHOT, detailedSettings(serverSettings({}, 1, 4))],
    [MessageType.BOT_SETTINGS_SNAPSHOT, detailedSettings(serverSettings({}, 2, 4), settingsDefinition(), 'another-bot')],
    [MessageType.BOT_SETTINGS_SNAPSHOT, detailedSettings(serverSettings({}, 2, 4), changedDefinition)],
    [MessageType.BOT_SETTINGS_SNAPSHOT, inconsistent],
    [MessageType.BOT_SETTINGS_SNAPSHOT, redacted],
    [MessageType.BOT_SETTINGS_SNAPSHOT, { ...detailedSettings(snapshot), userSettings: { note: 'private' } }],
    [MessageType.BOT_SETTINGS_SNAPSHOT, snapshot],
    [MessageType.COMMAND_REGISTERED, {
      registered: 0, settings: serverSettings({ note: 'x'.repeat(LIMITS.MAX_BOT_SETTINGS_VALUES_BYTES + 1) }, 2, 4),
    }],
  ];
  for (const [index, [type, payload]] of invalid.entries()) {
    server.send(type, payload);
    await sdkBarrier(server);
    assert.equal(errors.length, index + 1, `Invalid settings case ${index} must be reported.`);
    assert.deepEqual(origins[index], { serverId: 'settings-server' });
    assert.deepEqual(bot.getServerSettings('settings-server'), snapshot);
    assert.equal(changes.length, 1);
  }
  const newer = serverSettings({ limit: 6 }, 3, 6);
  server.send(MessageType.BOT_SETTINGS_SNAPSHOT, detailedSettings(newer));
  await sdkBarrier(server);
  assert.deepEqual(bot.getServerSettings('settings-server'), newer);
  assert.equal(changes.length, 2);
});

test('settings and preferences isolate identical command, autocomplete and selector IDs across servers', { timeout: 10000 }, async (t) => {
  const first = await makeSettingsServer(t);
  const second = await makeSettingsServer(t);
  const { bot, errors } = makeBot(t, first);
  bot.settings(settingsDefinition());
  const commands = new Map();
  const autocompletes = new Map();
  const responses = [];
  const observers = [];
  bot.command({
    name: 'search', description: 'Search', options: autocompleteOptions,
    handler: (ctx) => { commands.set(ctx.serverId, ctx); ctx.reply('OK'); },
    autocomplete: (ctx) => { autocompletes.set(ctx.serverId, ctx); return []; },
  });
  const stop = bot.onSelectorResponse((event, context) => {
    assertDeepFrozen(event);
    assertDeepFrozen(context);
    assert.equal(Reflect.set(event, 'value', 'changed'), false);
    assert.equal(Reflect.set(context.settings.user, 'tone', 'changed'), false);
    responses.push({ event, context });
  });
  const stopObserver = bot.onSelectorResponse((event, context) => observers.push({ event, context }));
  const firstSnapshot = serverSettings({ limit: 1, labels: ['first'] });
  const secondSnapshot = serverSettings({ limit: 9, labels: ['second'] }, 5, 9);
  const expected = new Map([
    ['first', executionSettings(firstSnapshot, { note: 'first preference', aliases: ['first'] })],
    ['second', executionSettings(secondSnapshot, { tone: 'full', muted: true, note: 'second preference', aliases: ['second'] })],
  ]);
  bot.connect({ serverId: 'first' });
  bot.connect({ serverId: 'second', serverUrl: second.url });
  for (const [server, snapshot] of [[first, firstSnapshot], [second, secondSnapshot]]) {
    assert.deepEqual((await server.next(MessageType.COMMAND_REGISTER)).payload.settings, settingsDefinition());
    await hydrateSettings(server, snapshot);
  }
  for (const [serverId, server] of [['first', first], ['second', second]]) {
    const settings = expected.get(serverId);
    server.invoke('same-invocation', 'search', { options: { sound: 'selected' }, settings });
    server.send(MessageType.COMMAND_AUTOCOMPLETE, { ...autocompleteRequest('same'), settings }, 'same-request');
    server.send(MessageType.SELECTOR_RESPONDED, {
      id: 'same-selector', channelId: 'same-channel', userId: 'same-human', value: serverId, settings,
    });
    assert.deepEqual((await server.next(MessageType.COMMAND_RESPONSE)).payload, {
      invocationId: 'same-invocation', content: 'OK', ephemeral: true,
    });
    await server.next(MessageType.COMMAND_FINISH);
    assert.deepEqual((await server.next(MessageType.COMMAND_AUTOCOMPLETE_RESULT)).payload, { status: 'ok', choices: [] });
    await sdkBarrier(server);
  }
  for (const [serverId, settings] of expected) {
    const command = commands.get(serverId);
    const autocomplete = autocompletes.get(serverId);
    assert.deepEqual(command.settings, settings);
    assert.deepEqual(autocomplete.settings, settings);
    assertDeepFrozen(command.settings);
    assertDeepFrozen(autocomplete.settings);
    assert.notEqual(command.settings, autocomplete.settings);
    assert.notEqual(command.settings.server, bot.getServerSettings(serverId).values);
    assert.equal(Reflect.set(command, 'settings', {}), false);
    assert.equal(Reflect.set(autocomplete, 'settings', {}), false);
    assert.equal('userSettings' in command, false);
    assert.equal('user' in bot.getServerSettings(serverId), false);
    const response = responses.find((entry) => entry.context.serverId === serverId);
    assert.deepEqual(response, {
      event: { id: 'same-selector', channelId: 'same-channel', userId: 'same-human', value: serverId },
      context: { serverId, settings },
    });
  }
  assert.deepEqual(observers, responses);
  assert.notEqual(observers[0].event, responses[0].event);
  assert.notEqual(observers[0].context.settings.user.aliases, responses[0].context.settings.user.aliases);
  stop();
  first.send(MessageType.SELECTOR_RESPONDED, {
    id: 'same-selector', channelId: 'same-channel', userId: 'same-human', value: 'changed',
    settings: executionSettings(firstSnapshot, { tone: 'full' }),
  });
  await sdkBarrier(first);
  assert.equal(responses.length, 2);
  assert.equal(observers.length, 3);
  stopObserver();
  assert.equal(bot.listenerCount('selectorResponse'), 0);

  const reaction = once(bot, 'reactionAdded');
  first.send(MessageType.CHAT_REACTION_ADDED, {
    channelId: 'same-channel', messageId: 'message', emoji: '👍', userId: 'same-human', userNickname: 'Human',
  });
  assert.deepEqual((await reaction)[1], { serverId: 'first' });
  const message = once(bot, 'message');
  first.send(MessageType.CHAT_MESSAGE, { id: 'message', content: 'Unrelated chat' });
  assert.deepEqual((await message)[1], { serverId: 'first' });
  assert.deepEqual(bot.getServerSettings('second'), secondSnapshot);
  assert.deepEqual(errors, []);
});

test('settings contexts stay immutable through prompts, choices and sound download continuations without propagating preferences', { timeout: 10000 }, async (t) => {
  const server = await makeSettingsServer(t);
  const { bot, errors } = makeBot(t, server);
  bot.settings(settingsDefinition());
  const captured = [];
  let context;
  bot.command({
    name: 'wizard', description: 'Settings wizard', downloadsSound: true,
    handler: async (ctx) => {
      context = ctx;
      captured.push(ctx.settings);
      assert.throws(() => ctx.reply({ content: 'Not text', userSettings: ctx.settings.user }));
      assert.throws(() => ctx.prompt({ ...form, userSettings: ctx.settings.user }));
      assert.throws(() => ctx.downloadSound({ ...soundDownloadRequest, filePath: 'C:\\private\\local.mp3' }));
      assert.deepEqual(await ctx.prompt(form), { answer: 'Continue' });
      captured.push(ctx.settings);
      assert.equal(await ctx.choose({ title: 'Continue?', choices: [{ label: 'Yes', value: 'yes' }] }), 'yes');
      captured.push(ctx.settings);
      assert.deepEqual(await ctx.downloadSound(soundDownloadRequest), { status: 'downloaded' });
      captured.push(ctx.settings);
      ctx.reply('Done');
    },
  });
  bot.connect({ serverId: 'settings-server' });
  const registration = await server.next(MessageType.COMMAND_REGISTER);
  assert.equal(registration.payload.commands[0].downloadsSound, true);
  const snapshot = serverSettings();
  await hydrateSettings(server, snapshot);
  const settings = executionSettings(snapshot, { note: 'private invocation preference', aliases: ['private-alias'] });
  server.invoke('stable-settings', 'wizard', { settings, allowSoundDownload: true });
  const outbound = [];
  const prompt = await server.next(MessageType.COMMAND_PROMPT);
  outbound.push(prompt);
  assertDeepFrozen(context.settings);
  assert.equal(Reflect.set(context.settings.user.aliases, 0, 'mutated'), false);
  assert.equal(Reflect.set(context, 'settings', {}), false);
  for (const revision of [4, 5, 6]) {
    const updated = serverSettings({ limit: revision }, 2, revision);
    server.send(MessageType.BOT_SETTINGS_SNAPSHOT, detailedSettings(updated));
    await sdkBarrier(server);
    assert.deepEqual(bot.getServerSettings('settings-server'), updated);
    assert.deepEqual(context.settings, settings);
    if (revision === 4) {
      server.send(MessageType.COMMAND_SUBMITTED, {
        invocationId: 'stable-settings', interactionId: prompt.payload.interactionId, values: { answer: 'Ignored' },
        userSettings: { note: 'Must not refresh invocation preferences' },
      });
      await sdkBarrier(server);
      assert.equal(errors.length, 1);
      assert.equal(captured.length, 1);
      server.send(MessageType.COMMAND_SUBMITTED, {
        invocationId: 'stable-settings', interactionId: prompt.payload.interactionId, values: { answer: 'Continue' },
      });
      outbound.push(await server.next(MessageType.COMMAND_PROMPT));
    } else if (revision === 5) {
      server.send(MessageType.COMMAND_SUBMITTED, {
        invocationId: 'stable-settings', interactionId: outbound[1].payload.interactionId, values: { choice: 'yes' },
      });
      outbound.push(await server.next(MessageType.COMMAND_SOUND_DOWNLOAD));
    } else {
      server.send(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
        invocationId: 'stable-settings', downloadId: 'download', result: { status: 'downloaded' },
      }, outbound[2].requestId);
    }
  }
  outbound.push(await server.next(MessageType.COMMAND_RESPONSE));
  outbound.push(await server.next(MessageType.COMMAND_FINISH));
  assert.equal(outbound.at(-1).payload.failed, false);
  assert.equal(captured.length, 4);
  for (const value of captured) {
    assert.equal(value, captured[0]);
    assert.deepEqual(value, settings);
  }
  assert.equal(context.signal.aborted, true);
  for (const frame of outbound) {
    for (const field of ['settings', 'userSettings', 'filePath', 'downloadPath', 'localFileName']) {
      assert.equal(field in frame.payload, false);
    }
  }
  assert.equal(JSON.stringify(outbound).includes('private invocation preference'), false);
  assert.equal(JSON.stringify(outbound).includes('private-alias'), false);
  assert.equal(JSON.stringify(outbound).includes('C:\\\\private'), false);
  assert.equal(errors.length, 1);
});

test('settings reject unhydrated, missing, malformed and stale interaction contexts instead of supplying defaults', { timeout: 10000 }, async (t) => {
  const server = await makeSettingsServer(t);
  const { bot, errors } = makeBot(t, server);
  bot.settings(settingsDefinition());
  const calls = [];
  bot.command({
    name: 'search', description: 'Search', options: autocompleteOptions,
    handler: (ctx) => { calls.push(ctx.settings); },
    autocomplete: (ctx) => { calls.push(ctx.settings); return []; },
  });
  bot.onSelectorResponse((_event, context) => calls.push(context.settings));
  bot.connect({ serverId: 'settings-server' });
  await server.next(MessageType.COMMAND_REGISTER);
  const snapshot = serverSettings();
  const valid = executionSettings(snapshot);
  const sendAll = async (extra, id) => {
    server.invoke(`command-${id}`, 'search', { options: { sound: 'selected' }, ...extra });
    server.send(MessageType.COMMAND_AUTOCOMPLETE, { ...autocompleteRequest('query'), ...extra }, `autocomplete-${id}`);
    server.send(MessageType.SELECTOR_RESPONDED, {
      id: 'selector', channelId: 'channel', userId: 'user', value: 'yes', ...extra,
    });
    const result = await server.next(MessageType.COMMAND_AUTOCOMPLETE_RESULT);
    await sdkBarrier(server);
    return result.payload;
  };
  assert.deepEqual(await sendAll({ settings: valid }, 'unhydrated'), { status: 'failed', reason: 'invalid_response' });
  assert.equal(errors.length, 3);
  assert.equal(calls.length, 0);
  await hydrateSettings(server, snapshot);
  const invalid = [
    undefined, null, {},
    { ...valid, server: {} },
    { ...valid, user: { muted: false } },
    { ...valid, user: { ...valid.user, muted: 'false' } },
    { ...valid, user: { ...valid.user, tone: 'not-a-choice' } },
    { ...valid, user: { ...valid.user, aliases: ['same', 'SAME'] } },
    { ...valid, server: { ...valid.server, limit: 21 } },
    { ...valid, server: { ...valid.server, limit: 4 } },
    { ...valid, server: { ...valid.server, hostPath: 'C:\\private' } },
    { ...valid, user: { ...valid.user, localFileName: 'private.mp3' } },
    { ...valid, schemaRevision: 1 },
    { ...valid, schemaRevision: 3 },
    { ...valid, serverRevision: 2 },
    { ...valid, serverRevision: 4 },
    { ...valid, serverRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, server: [] },
    { ...valid, user: { ...valid.user, note: 'x'.repeat(LIMITS.MAX_BOT_SETTINGS_VALUES_BYTES + 1) } },
    { ...valid, userSettings: { note: 'raw preferences' } },
  ];
  for (const [index, settings] of invalid.entries()) {
    assert.deepEqual(await sendAll({ settings }, index), { status: 'failed', reason: 'invalid_response' });
    assert.equal(errors.length, 3 * (index + 2), `Invalid settings context ${index} must be reported for all three handlers.`);
    assert.equal(calls.length, 0);
    assert.deepEqual(bot.getServerSettings('settings-server'), snapshot);
  }
  const errorCount = errors.length;
  assert.deepEqual(await sendAll({
    settings: valid, userSettings: { downloadPath: 'C:\\private', localFileName: 'private.mp3' },
  }, 'raw-preferences'), { status: 'failed', reason: 'invalid_response' });
  assert.equal(errors.length, errorCount + 3);
  server.invoke('wrong-bot', 'search', { botId: 'another-bot', options: { sound: 'selected' }, settings: valid });
  await sdkBarrier(server);
  assert.equal(errors.length, errorCount + 4);
  assert.equal(calls.length, 0);

  const cleared = serverSettings({ labels: [], note: '' }, 2, 4);
  server.send(MessageType.BOT_SETTINGS_SNAPSHOT, detailedSettings(cleared));
  await sdkBarrier(server);
  const emptyOptional = executionSettings(cleared, { aliases: [], note: '' });
  assert.deepEqual(await sendAll({ settings: emptyOptional }, 'empty-optional'), { status: 'ok', choices: [] });
  assert.equal(calls.length, 3);
  for (const settings of calls) {
    assert.deepEqual(settings, emptyOptional, 'Explicit optional empty values must not turn back into defaults.');
    assertDeepFrozen(settings);
  }
  const omittedOptional = {
    schemaRevision: 2, serverRevision: 4, server: { enabled: true, limit: 2 }, user: { tone: 'brief', muted: false },
  };
  assert.deepEqual(await sendAll({ settings: omittedOptional }, 'omitted-optional'), { status: 'ok', choices: [] });
  for (const settings of calls.slice(3)) assert.deepEqual(settings, omittedOptional);
  assert.equal(errors.length, errorCount + 4);
});

test('settings clear on teardown and automatic reconnect while other servers retain their snapshots', { timeout: 10000 }, async (t) => {
  const first = await makeSettingsServer(t);
  const second = await makeSettingsServer(t);
  const { bot, errors } = makeBot(t, first, { autoReconnect: true });
  bot.settings(settingsDefinition());
  const hydrationAtConnect = [];
  bot.on('connected', ({ serverId }) => hydrationAtConnect.push(bot.getServerSettings(serverId)));
  bot.connect({ serverId: 'first' });
  bot.connect({ serverId: 'second', serverUrl: second.url });
  await Promise.all([first.next(MessageType.COMMAND_REGISTER), second.next(MessageType.COMMAND_REGISTER)]);
  const old = serverSettings({ limit: 8 }, 8, 8);
  const other = serverSettings({ limit: 9 }, 9, 9);
  await Promise.all([hydrateSettings(first, old, 0), hydrateSettings(second, other, 0)]);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const disconnected = once(bot, 'disconnected');
    first.disconnect();
    assert.deepEqual((await disconnected)[0], { serverId: 'first' });
    assert.equal(bot.getServerSettings('first'), undefined);
    assert.deepEqual(bot.getServerSettings('second'), other);
    assert.throws(() => bot.settings({}), /before connecting or serving/);
    t.mock.timers.tick(5000);
    const registration = await first.next(MessageType.COMMAND_REGISTER);
    assert.deepEqual(registration.payload.settings, settingsDefinition());
    assert.equal(bot.getServerSettings('first'), undefined);
    const fresh = serverSettings({ limit: 1 }, 1, 1);
    await hydrateSettings(first, fresh, 0);
    assert.deepEqual(bot.getServerSettings('first'), fresh, 'Reconnection must not retain an old revision watermark.');
    assert.deepEqual(bot.getServerSettings('second'), other);
    assert.deepEqual(hydrationAtConnect, [undefined, undefined, undefined]);
  } finally {
    t.mock.timers.reset();
  }
  bot.disconnect('first');
  assert.equal(bot.getServerSettings('first'), undefined);
  assert.deepEqual(bot.getServerSettings('second'), other);
  bot.disconnect();
  assert.equal(bot.getServerSettings('second'), undefined);
  assert.equal(bot.settings({}), bot);
  bot.connect({ serverId: 'first' });
  assert.deepEqual((await first.next(MessageType.COMMAND_REGISTER)).payload.settings, {});
  await hydrateSettings(first, { schemaRevision: 10, revision: 10, values: {} }, 0);
  await bot.close();
  assert.equal(bot.getServerSettings('first'), undefined);
  assert.deepEqual(errors, []);
});

test('settings-free bots remain compatible without acknowledgements or execution preferences', { timeout: 10000 }, async (t) => {
  for (const declaration of [undefined, {}]) {
    await t.test(declaration ? 'explicit empty settings' : 'no settings declaration', async (t) => {
      const server = await makeServer(t);
      const { bot, errors } = makeBot(t, server);
      if (declaration) bot.settings(declaration);
      const contexts = [];
      bot.command({
        name: 'search', description: 'Search', options: autocompleteOptions,
        handler: (ctx) => { contexts.push(ctx.settings); },
        autocomplete: (ctx) => { contexts.push(ctx.settings); return []; },
      });
      bot.onSelectorResponse((_event, context) => contexts.push(context.settings));
      bot.connect({ serverId: 'legacy' });
      const registration = await server.next(MessageType.COMMAND_REGISTER);
      assert.equal('settings' in registration.payload, declaration !== undefined);
      assert.equal(bot.getServerSettings('legacy'), undefined);
      for (const hydrated of [false, true]) {
        if (hydrated) await hydrateSettings(server, { schemaRevision: 7, revision: 8, values: {} });
        server.invoke(`legacy-${hydrated}`, 'search', { options: { sound: 'selected' } });
        server.send(MessageType.COMMAND_AUTOCOMPLETE, autocompleteRequest('legacy'), `legacy-${hydrated}`);
        server.send(MessageType.SELECTOR_RESPONDED, { id: 'selector', channelId: 'channel', userId: 'user', value: 'yes' });
        await server.next(MessageType.COMMAND_FINISH);
        assert.deepEqual((await server.next(MessageType.COMMAND_AUTOCOMPLETE_RESULT)).payload, { status: 'ok', choices: [] });
        await sdkBarrier(server);
        for (const context of contexts.slice(hydrated ? 3 : 0)) {
          assert.deepEqual(context, {
            schemaRevision: hydrated ? 7 : 0, serverRevision: hydrated ? 8 : 0, server: {}, user: {},
          });
          assertDeepFrozen(context);
        }
      }
      assert.equal(contexts.length, 6);
      assert.notEqual(contexts[0].user, contexts[1].user);
      assert.deepEqual(errors, []);
    });
  }
});

test('settings with only one declared scope do not fabricate values for the other scope', { timeout: 10000 }, async (t) => {
  for (const scope of ['server', 'user']) {
    await t.test(`${scope}-only settings`, async (t) => {
      const server = await makeSettingsServer(t);
      const { bot, errors } = makeBot(t, server);
      const declaration = { [scope]: settingsDefinition()[scope] };
      bot.settings(declaration);
      let context;
      bot.command({ name: 'scope', description: 'Scope', handler: (ctx) => { context = ctx.settings; } });
      bot.connect({ serverId: 'scope-server' });
      await server.next(MessageType.COMMAND_REGISTER);
      const snapshot = scope === 'server' ? serverSettings() : { schemaRevision: 2, revision: 3, values: {} };
      await hydrateSettings(server, snapshot);
      const settings = executionSettings(snapshot);
      if (scope === 'server') settings.user = {};
      server.invoke('scope', 'scope', { settings });
      await server.next(MessageType.COMMAND_FINISH);
      assert.deepEqual(context, settings);
      const updated = { ...snapshot, revision: 4 };
      server.send(MessageType.BOT_SETTINGS_SNAPSHOT, detailedSettings(updated, declaration));
      await sdkBarrier(server);
      assert.deepEqual(bot.getServerSettings('scope-server'), updated);
      const undeclaredScope = scope === 'server' ? 'user' : 'server';
      server.invoke('undeclared-scope', 'scope', {
        settings: { ...settings, serverRevision: 4, [undeclaredScope]: { note: 'Not declared' } },
      });
      assert.equal((await server.next(MessageType.COMMAND_FINISH)).payload.failed, true);
      assert.equal(errors.length, 1);
      assert.deepEqual(context, settings);
    });
  }
});
