import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const { MonkyServer } = require('../apps/server/dist/server.js');
const { BotClient, MessageType, PROTOCOL_VERSION } = require('../packages/bot-sdk/dist/index.js');

function identity() {
  const pair = generateKeyPairSync('ed25519');
  return { publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('hex'), privateKey: pair.privateKey };
}

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

class Peer {
  messages = [];
  waiters = new Set();

  constructor(url) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      this.messages.push(message);
      if (message.type === MessageType.PING) {
        this.send(MessageType.PONG, { timestamp: Date.now() });
      }
      for (const waiter of [...this.waiters]) waiter(message);
    });
    this.ws.on('error', (error) => {
      for (const waiter of [...this.waiters]) waiter({ type: 'SOCKET_ERROR', error });
    });
  }

  send(type, payload, requestId) {
    this.ws.send(JSON.stringify({ type, payload, requestId }));
  }

  wait(predicate, description, timeoutMs = 5000) {
    const previous = this.messages.find(predicate);
    if (previous) return Promise.resolve(previous);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(onMessage);
        reject(new Error(`Timeout: ${description}`));
      }, timeoutMs);
      const onMessage = (message) => {
        if (message.type !== 'SOCKET_ERROR' && !predicate(message)) return;
        clearTimeout(timeout);
        this.waiters.delete(onMessage);
        if (message.type === 'SOCKET_ERROR') reject(message.error);
        else resolve(message);
      };
      this.waiters.add(onMessage);
    });
  }

  async request(type, payload, expectedError = false) {
    const requestId = randomUUID();
    const result = this.wait((message) => message.requestId === requestId, type);
    this.send(type, payload, requestId);
    const response = await result;
    assert.equal(response.type === MessageType.SERVER_ERROR, expectedError, JSON.stringify(response.payload));
    return response.payload;
  }

  async authenticate(nickname, keys = identity()) {
    await once(this.ws, 'open');
    const requestId = randomUUID();
    this.send(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION,
      publicKey: keys.publicKey, nickname, password: '', deviceId: randomUUID(),
    }, requestId);
    const challenge = await this.wait(
      (message) => message.type === MessageType.AUTH_CHALLENGE && message.requestId === requestId, 'auth challenge'
    );
    this.send(MessageType.AUTH_CHALLENGE_RESPONSE, {
      signature: sign(null, Buffer.from(challenge.payload.nonce, 'hex'), keys.privateKey).toString('hex'),
    }, requestId);
    const authenticated = await this.wait(
      (message) => message.type === MessageType.AUTH_SUCCESS && message.requestId === requestId, 'auth success'
    );
    return authenticated.payload;
  }

  prompt(invocationId, previousInteractionId) {
    return this.wait((message) => message.type === MessageType.COMMAND_PROMPT &&
      message.payload.invocationId === invocationId && message.payload.interactionId !== previousInteractionId, 'private prompt')
      .then((message) => message.payload);
  }

  finished(invocationId) {
    return this.wait((message) => message.type === MessageType.COMMAND_FINISHED &&
      message.payload.invocationId === invocationId, 'command completion');
  }
}

const dataDir = path.resolve(`.bot-e2e-data-${randomUUID()}`);
fs.mkdirSync(dataDir);
const peers = [];
let monky;
let bot;
let officialProcess;
let officialExited;

try {
  const port = await freePort();
  monky = await MonkyServer.create({ port, dataDir, serverName: 'Bot interaction test', maxUsers: 5 });
  await monky.start();
  const url = `ws://127.0.0.1:${port}`;
  const ownerKeys = identity();
  let owner = new Peer(url);
  peers.push(owner);
  const auth = await owner.authenticate('Owner', ownerKeys);
  const bobKeys = identity();
  let bob = new Peer(url);
  peers.push(bob);
  const bobAuth = await bob.authenticate('Bob', bobKeys);
  let otherDevice = new Peer(url);
  peers.push(otherDevice);
  await otherDevice.authenticate('Owner', ownerKeys);
  const channelId = auth.server.channels.find((channel) => channel.type === 'TEXT')?.id;
  assert.ok(channelId);
  const created = await owner.request(MessageType.BOT_CREATE, { name: 'Before profile sync' });
  const botId = created.bot.id;
  const botKeys = identity();
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJfcAAAAASUVORK5CYII=';
  bot = new BotClient({
    serverUrl: url, token: created.token, publicKey: botKeys.publicKey, autoReconnect: false,
    name: 'Identity Bot', avatarBase64: avatar,
  });
  const sdkErrors = [];
  const contexts = new Map();
  bot.on('error', (error) => sdkErrors.push(error));
  bot.command({
    name: 'guided', description: 'Guided command',
    options: [
      { name: 'question', description: 'Question', type: 'string', required: true },
      { name: 'count', description: 'Count', type: 'integer', min: 2, max: 100 },
      { name: 'enabled', description: 'Enabled', type: 'boolean' },
      { name: 'member', description: 'Member', type: 'user' },
      { name: 'mode', description: 'Mode', type: 'string', choices: [{ label: 'First', value: 'first' }, { label: 'Second', value: 'second' }] },
    ],
    handler: async (ctx) => {
      contexts.set(ctx.invocationId, ctx);
      const values = await ctx.prompt({
        title: 'First step',
        fields: [
          { name: 'answer', label: 'Answer', type: 'text', required: true },
          { name: 'options', label: 'Options', type: 'string-list', minItems: 2, required: true },
          { name: 'count', label: 'Count', type: 'integer', min: 0 },
          { name: 'enabled', label: 'Enabled', type: 'boolean' },
        ],
      });
      if (!values) return;
      const confirmation = await ctx.prompt({
        title: 'Confirm',
        fields: [{
          name: 'visibility', label: 'Visibility', type: 'select', required: true,
          choices: [{ label: 'Only me', value: 'private' }, { label: 'Channel', value: 'channel' }],
        }],
      });
      if (!confirmation) return;
      const text = `${ctx.invokerNickname}: ${values.answer}`;
      if (confirmation.visibility === 'channel') ctx.publish(text);
      else ctx.reply(text);
    },
  });
  bot.command({ name: 'ping', description: 'Ping from the other bot', handler: (ctx) => ctx.reply('Identity bot ping') });
  bot.command({
    name: 'choose', description: 'Private option flow',
    handler: async (ctx) => {
      const choices = [{ label: 'First', value: 'first' }, { label: 'Second', value: 'second' }];
      const first = await ctx.choose({ title: 'Buttons', choices, presentation: 'buttons' });
      if (first === null) return;
      const second = await ctx.choose({ title: `After ${first}`, choices });
      if (second !== null) ctx.reply(`${first}:${second}`);
    },
  });
  bot.connect({ serverId: 'e2e' });
  await owner.wait((message) => message.type === MessageType.COMMANDS_LIST_RESPONSE &&
    message.payload.commands?.some((command) => command.botId === botId && command.name === 'guided'), 'command discovery');

  const invoke = (peer, question) => peer.request(MessageType.COMMAND_INVOKE, {
    botId, channelId, commandName: 'guided', options: { question, count: 20, enabled: false }, locale: 'en',
  });
  const aliceCall = await invoke(owner, 'A question with spaces');
  const bobCall = await invoke(bob, 'Another question with spaces');
  const aliceForm = await owner.prompt(aliceCall.invocationId);
  const bobForm = await bob.prompt(bobCall.invocationId);
  assert.equal(aliceForm.botName, 'Identity Bot');
  assert.equal(aliceForm.botId, botId);
  assert.match(aliceForm.botAvatarUrl, /avatars/);
  assert.deepEqual(contexts.get(aliceCall.invocationId).args, { question: 'A question with spaces', count: 20, enabled: false });
  assert.equal(contexts.get(aliceCall.invocationId).locale, 'en');

  await owner.request(MessageType.COMMAND_SUBMIT, {
    invocationId: bobCall.invocationId, interactionId: bobForm.interactionId,
    values: { answer: 'forged', options: ['A', 'B'] },
  }, true);
  await owner.request(MessageType.COMMAND_SUBMIT, {
    invocationId: aliceCall.invocationId, interactionId: aliceForm.interactionId,
    values: { answer: 'Invalid', options: ['Only one'] },
  }, true);

  for (const [peer, prompt, answer] of [[owner, aliceForm, 'Alice result'], [bob, bobForm, 'Bob result']]) {
    await peer.request(MessageType.COMMAND_SUBMIT, {
      invocationId: prompt.invocationId, interactionId: prompt.interactionId,
      values: { answer, options: ['First', 'Second'], count: 0, enabled: false },
    });
  }
  const aliceConfirm = await owner.prompt(aliceCall.invocationId, aliceForm.interactionId);
  const bobConfirm = await bob.prompt(bobCall.invocationId, bobForm.interactionId);
  await bob.request(MessageType.COMMAND_SUBMIT, {
    invocationId: bobCall.invocationId, interactionId: bobConfirm.interactionId, values: { visibility: 'private' },
  });
  await bob.finished(bobCall.invocationId);
  const privateReply = await bob.wait((message) => message.type === MessageType.COMMAND_RESPONSE &&
    message.payload.invocationId === bobCall.invocationId, 'Bob reply');
  assert.equal(privateReply.payload.content, 'Bob: Bob result');
  assert.equal(privateReply.payload.ephemeral, true);
  assert.equal(privateReply.payload.botName, 'Identity Bot');
  assert.equal(privateReply.payload.botId, botId);

  await owner.request(MessageType.COMMAND_SUBMIT, {
    invocationId: aliceCall.invocationId, interactionId: aliceConfirm.interactionId, values: { visibility: 'channel' },
  });
  const publicReplies = await Promise.all(peers.map((peer) => peer.wait((message) =>
    message.type === MessageType.COMMAND_RESPONSE && message.payload.invocationId === aliceCall.invocationId, 'public result')));
  assert.ok(publicReplies.every((message) => message.payload.content === 'Owner: Alice result' &&
    message.payload.ephemeral === false && message.payload.botId === botId));
  assert.equal(new Set(publicReplies.map((message) => message.payload.messageId)).size, 1);
  await owner.finished(aliceCall.invocationId);
  assert.equal(owner.messages.some((message) => message.type === MessageType.COMMAND_RESPONSE &&
    message.payload.invocationId === bobCall.invocationId), false);
  assert.equal(otherDevice.messages.some((message) =>
    message.type === MessageType.COMMAND_PROMPT ||
    (message.type === MessageType.COMMAND_RESPONSE && message.payload.ephemeral)), false);
  assert.equal(bob.messages.some((message) =>
    message.type === MessageType.COMMAND_PROMPT && message.payload.invocationId === aliceCall.invocationId), false);

  const cancelled = await invoke(owner, 'Cancel this');
  const cancelForm = await owner.prompt(cancelled.invocationId);
  await owner.request(MessageType.COMMAND_CANCEL, { invocationId: cancelled.invocationId });
  await owner.finished(cancelled.invocationId);
  await owner.request(MessageType.COMMAND_SUBMIT, {
    invocationId: cancelled.invocationId, interactionId: cancelForm.interactionId,
    values: { answer: 'Late', options: ['First', 'Second'] },
  }, true);
  assert.deepEqual(sdkErrors, []);
  console.log('Real Monky server + SDK: profile, typed arguments, private multi-turn forms, separate callers/devices, public result and cancellation passed.');

  const choiceCall = await owner.request(MessageType.COMMAND_INVOKE, {
    botId, channelId, commandName: 'choose', locale: 'en',
  });
  const buttons = await owner.prompt(choiceCall.invocationId);
  assert.equal(buttons.form.fields[0].presentation, 'buttons');
  await bob.request(MessageType.COMMAND_SUBMIT, {
    invocationId: choiceCall.invocationId, interactionId: buttons.interactionId, values: { choice: 'first' },
  }, true);
  await owner.request(MessageType.COMMAND_SUBMIT, {
    invocationId: choiceCall.invocationId, interactionId: buttons.interactionId, values: { choice: 'forged' },
  }, true);
  await owner.request(MessageType.COMMAND_SUBMIT, {
    invocationId: choiceCall.invocationId, interactionId: buttons.interactionId, values: { choice: 'second' },
  });
  const dropdown = await owner.prompt(choiceCall.invocationId, buttons.interactionId);
  assert.equal(dropdown.form.fields[0].presentation, 'dropdown');
  assert.equal(dropdown.form.title, 'After second');
  await owner.request(MessageType.COMMAND_SUBMIT, {
    invocationId: choiceCall.invocationId, interactionId: buttons.interactionId, values: { choice: 'first' },
  }, true);
  await owner.request(MessageType.COMMAND_SUBMIT, {
    invocationId: choiceCall.invocationId, interactionId: dropdown.interactionId, values: { choice: 'first' },
  });
  const chosen = await owner.wait((message) => message.type === MessageType.COMMAND_RESPONSE &&
    message.payload.invocationId === choiceCall.invocationId, 'private choice result');
  assert.equal(chosen.payload.content, 'second:first');
  assert.equal(bob.messages.some((message) => message.type === MessageType.COMMAND_PROMPT &&
    message.payload.invocationId === choiceCall.invocationId), false);
  await owner.finished(choiceCall.invocationId);
  assert.deepEqual(sdkErrors, []);

  const officialIndex = process.argv.indexOf('--official-bot');
  if (officialIndex !== -1) {
    const officialRoot = process.argv[officialIndex + 1];
    assert.ok(officialRoot, 'Pass the MonkyBot repository after --official-bot.');
    const officialEntry = path.join(path.resolve(officialRoot), 'dist', 'index.js');
    assert.ok(fs.statSync(officialEntry).isFile());
    const workingDir = path.join(dataDir, 'official-bot');
    fs.mkdirSync(workingDir);
    const marketplaceRestart = process.argv.includes('--marketplace-restart');
    const manifestPort = marketplaceRestart ? await freePort() : 0;
    const manifestUrl = `http://127.0.0.1:${manifestPort}/manifest`;
    const officialAccount = marketplaceRestart ? null : await owner.request(MessageType.BOT_CREATE, { name: 'Official before sync' });
    let officialId = officialAccount?.bot.id;
    let officialOutput = '';
    const startOfficial = async () => {
      officialOutput = '';
      const child = spawn(process.execPath, [officialEntry], {
        cwd: workingDir,
        env: {
          ...process.env, NODE_PATH: '',
          MONKY_SERVE: String(marketplaceRestart),
          MONKY_SERVE_PORT: String(manifestPort), MONKY_SERVE_HOST: '127.0.0.1', MONKY_SERVE_PUBLIC_HOST: '127.0.0.1',
          MONKY_SERVER_URL: officialAccount ? url : '', MONKY_BOT_TOKEN: officialAccount?.token ?? '',
          MONKY_BOT_NAME: 'MonkyBot',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      officialProcess = child;
      officialExited = once(child, 'close');
      child.stdout.on('data', (data) => { officialOutput = (officialOutput + data.toString()).slice(-10000); });
      child.stderr.on('data', (data) => { officialOutput = (officialOutput + data.toString()).slice(-10000); });
      if (marketplaceRestart) {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            child.off('exit', onExit);
          };
          const onData = () => {
            if (!officialOutput.includes(`Manifest: ${manifestUrl}`)) return;
            cleanup();
            resolve();
          };
          const onExit = () => {
            cleanup();
            reject(new Error(`Official bot exited before serving its manifest: ${officialOutput}`));
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Official bot manifest startup timed out: ${officialOutput}`));
          }, 5000);
          child.stdout.on('data', onData);
          child.once('exit', onExit);
        });
      }
    };
    await startOfficial();
    if (marketplaceRestart) {
      const installed = await owner.request(MessageType.BOT_INSTALL, { manifestUrl });
      officialId = installed.bot.id;
    }
    assert.ok(officialId);
    await owner.wait((message) => message.type === MessageType.COMMANDS_LIST_RESPONSE &&
      message.payload.commands?.some((command) => command.botId === officialId && command.name === 'enquete'), 'official command discovery');
    const registered = await owner.request(MessageType.COMMANDS_LIST, {});
    assert.equal(registered.commands.filter((command) => command.name === 'ping').length, 2,
      'The UI fixture must include the same command name belonging to two distinct bots.');
    const invokeOfficial = (peer, commandName, options = {}, targetChannelId = channelId) => peer.request(MessageType.COMMAND_INVOKE, {
      botId: officialId, channelId: targetChannelId, commandName, options, locale: 'en',
    });
    for (const [command, options] of [
      ['ping', {}], ['moeda', {}], ['ajuda', {}], ['dado', { lados: 20 }],
      ['8ball', { pergunta: 'Will a question with spaces work?' }],
    ]) {
      const invocation = await invokeOfficial(owner, command, options);
      const response = await owner.wait((message) => message.type === MessageType.COMMAND_RESPONSE &&
        message.payload.invocationId === invocation.invocationId, `official /${command}`);
      assert.equal(response.payload.botName, 'MonkyBot');
      assert.equal(response.payload.botId, officialId);
      assert.equal(response.payload.commandName, command);
      assert.equal(response.payload.invokerId, auth.currentUser.id);
      assert.equal(response.payload.invokerNickname, 'Owner');
      assert.equal(response.payload.options, undefined);
      assert.equal(response.payload.ephemeral, true);
      assert.match(response.payload.botAvatarUrl, /avatars/);
      assert.ok(response.payload.content.length > 0);
      if (command === 'dado') {
        assert.match(response.payload.content, /Rolling d20/);
        const rolled = response.payload.content.match(/\*\*(\d+)\*\*/);
        assert.ok(rolled && Number(rolled[1]) >= 1 && Number(rolled[1]) <= 20);
      }
      if (command === '8ball') assert.match(response.payload.content, /Will a question with spaces work\?/);
      await owner.finished(invocation.invocationId);
    }

    const eightballDefinition = registered.commands.find((command) => command.botId === officialId && command.name === '8ball');
    assert.equal(eightballDefinition.options.find((option) => option.name === 'pergunta').required, true);
    const missingQuestion = await owner.request(MessageType.COMMAND_INVOKE, {
      botId: officialId, channelId, commandName: '8ball', options: {}, locale: 'en',
    }, true);
    assert.equal(missingQuestion.code, 'BOT_INVALID_OPTIONS');

    const invalidPoll = await invokeOfficial(owner, 'enquete');
    const initialPollForm = await owner.prompt(invalidPoll.invocationId);
    const retainedInputs = { pergunta: 'Keep this draft', opcoes: ['First option', 'Second option'], unidade: 'days' };
    await owner.request(MessageType.COMMAND_SUBMIT, {
      invocationId: invalidPoll.invocationId, interactionId: initialPollForm.interactionId, values: retainedInputs,
    });
    const missingLimitRetry = await owner.prompt(invalidPoll.invocationId, initialPollForm.interactionId);
    const retryDefaults = Object.fromEntries(missingLimitRetry.form.fields.map((field) => [field.name, field.defaultValue]));
    assert.equal(retryDefaults.pergunta, retainedInputs.pergunta);
    assert.deepEqual(retryDefaults.opcoes, retainedInputs.opcoes);
    assert.equal(retryDefaults.unidade, 'days');
    await owner.request(MessageType.COMMAND_SUBMIT, {
      invocationId: invalidPoll.invocationId, interactionId: missingLimitRetry.interactionId,
      values: { ...retainedInputs, duracao: 31, max_voters: 2 },
    });
    const durationRetry = await owner.wait((message) => message.type === MessageType.COMMAND_PROMPT &&
      message.payload.invocationId === invalidPoll.invocationId &&
      ![initialPollForm.interactionId, missingLimitRetry.interactionId].includes(message.payload.interactionId),
    'retained overlong duration');
    const durationDefaults = Object.fromEntries(durationRetry.payload.form.fields.map((field) => [field.name, field.defaultValue]));
    assert.equal(durationDefaults.duracao, 31);
    assert.equal(durationDefaults.max_voters, 2);
    assert.equal(durationDefaults.pergunta, retainedInputs.pergunta);
    assert.deepEqual(durationDefaults.opcoes, retainedInputs.opcoes);
    await owner.request(MessageType.COMMAND_CANCEL, { invocationId: invalidPoll.invocationId });
    await owner.finished(invalidPoll.invocationId);
    const afterCancelledDraft = await owner.request(MessageType.SELECTOR_LIST, { channelId });
    assert.equal(afterCancelledDraft.selectors.some((selector) => selector.id === invalidPoll.invocationId), false);

    const createPoll = async (question, limits, targetChannelId = channelId, invoker = owner) => {
      const observer = invoker === bob ? owner : bob;
      const invocation = await invokeOfficial(invoker, 'enquete', {}, targetChannelId);
      const prompt = await invoker.prompt(invocation.invocationId);
      assert.equal(prompt.form.fields.find((field) => field.name === 'opcoes').type, 'string-list');
      assert.equal(prompt.form.fields.some((field) => field.name === 'visibilidade'), false);
      await invoker.request(MessageType.COMMAND_SUBMIT, {
        invocationId: invocation.invocationId, interactionId: prompt.interactionId,
        values: { pergunta: question, opcoes: ['Game A', 'Game B', 'Game C'], ...limits },
      });
      await invoker.finished(invocation.invocationId);
      assert.equal(invoker.messages.filter((message) => message.type === MessageType.COMMAND_PROMPT &&
        message.payload.invocationId === invocation.invocationId).length, 1, 'Poll creation must not ask for review or confirmation.');
      assert.equal(observer.messages.some((message) => message.type === MessageType.COMMAND_PROMPT &&
        message.payload.invocationId === invocation.invocationId), false, 'Poll setup stays private.');
      const selector = await observer.wait((message) => message.type === MessageType.SELECTOR_SNAPSHOT &&
        message.payload.id === invocation.invocationId, 'public poll buttons');
      assert.equal(selector.payload.presentation, 'buttons');
      assert.equal(selector.payload.allowChange, true);
      assert.equal(selector.payload.responder, 'any');
      assert.equal(selector.payload.responses, undefined, 'Human clients receive tallies, not other voter IDs.');
      return selector.payload;
    };
    const poll = await createPoll('Choose a game', { max_voters: 2 });
    const sharedPoll = await bob.wait((message) => message.type === MessageType.CHAT_MESSAGE &&
      message.payload.id === poll.messageId, 'persisted poll question');
    assert.equal(sharedPoll.payload.isBot, true);
    assert.equal(sharedPoll.payload.userNickname, 'MonkyBot');
    assert.equal(sharedPoll.payload.userId, officialId);
    assert.match(sharedPoll.payload.content, /Choose a game/);
    await owner.request(MessageType.SELECTOR_RESPOND, { id: poll.id, value: '1' });
    const changed = await otherDevice.request(MessageType.SELECTOR_RESPOND, { id: poll.id, value: '2' });
    assert.equal(changed.responseCount, 1, 'A second device changes the same human vote, not the voter count.');
    assert.equal(changed.closedAt, null);
    const closed = await bob.request(MessageType.SELECTOR_RESPOND, { id: poll.id, value: '1' });
    assert.equal(closed.responseCount, 2);
    assert.ok(closed.closedAt);
    assert.equal(closed.canRespond, false);
    await owner.request(MessageType.SELECTOR_RESPOND, { id: poll.id, value: '3' }, true);
    const final = await bob.wait((message) => message.type === MessageType.CHAT_MESSAGE &&
      message.payload.userId === officialId && /Poll closed.*Choose a game/s.test(message.payload.content), 'official final tally');
    assert.match(final.payload.content, /Game A — 1 \(50\.0%\)/);
    assert.match(final.payload.content, /Game B — 1 \(50\.0%\)/);
    assert.match(final.payload.content, /Game C — 0 \(0\.0%\)/);
    assert.match(final.payload.content, /Tie between options: 1, 2/);
    const history = await owner.request(MessageType.CHAT_LOAD_HISTORY, { channelId });
    assert.equal(history.messages.filter((message) => message.id === poll.messageId).length, 1);
    assert.equal(history.messages.filter((message) => message.id === final.payload.id).length, 1);
    const image = await fetch(`http://127.0.0.1:${port}${sharedPoll.payload.userAvatarUrl}`);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), fs.readFileSync(path.join(officialRoot, 'assets', 'monky-logo.png')));
    assert.doesNotMatch(officialOutput, /MODULE_NOT_FOUND|Fatal:|❌/);
    console.log('Official MonkyBot runtime: six commands, required 8ball, immediate public poll, vote changes, distinct voters, final tally and bundled logo passed.');
    if (marketplaceRestart) {
      const roles = await owner.request(MessageType.ROLE_CREATE, { name: 'Private poll readers', permissions: 0 });
      const privateRoleId = roles.roles.find((role) => role.name === 'Private poll readers')?.id;
      assert.ok(privateRoleId);
      await owner.request(MessageType.ROLE_ASSIGN, { userId: bobAuth.currentUser.id, roleId: privateRoleId });
      const privatePollChannel = await owner.request(MessageType.CHANNEL_CREATE, {
        name: 'private-poll-recovery', type: 'TEXT', isPrivate: true, allowedRoleIds: [privateRoleId],
      });
      const privateChannelId = privatePollChannel.channel.id;
      const recoveringPoll = await createPoll('Survive restarts', { max_voters: 2 }, privateChannelId, bob);
      await owner.request(MessageType.SELECTOR_RESPOND, { id: recoveringPoll.id, value: '2' });
      const expiringPoll = process.argv.includes('--poll-expiry')
        ? await createPoll('No voters while offline', { duracao: 1, unidade: 'minutes' }) : null;
      const accountsBefore = await owner.request(MessageType.BOT_LIST, {});
      const publicKey = fs.readFileSync(path.join(workingDir, '.keys', 'public.hex'), 'utf8');
      const beforeStop = owner.messages.length;
      officialProcess.kill();
      await officialExited;
      await owner.wait((message) => owner.messages.indexOf(message) >= beforeStop &&
        message.type === MessageType.COMMANDS_LIST_RESPONSE &&
        !message.payload.commands.some((command) => command.botId === officialId), 'offline bot commands removed');
      const offline = await owner.request(MessageType.BOT_LIST, {});
      assert.equal(offline.bots.find((entry) => entry.id === officialId).online, false);
      if (process.argv.includes('--server-restart')) {
        await monky.stop();
        monky = await MonkyServer.create({ port, dataDir, serverName: 'Bot interaction test', maxUsers: 5 });
        await monky.start();
        owner = new Peer(url);
        peers.push(owner);
        const reconnectedOwner = await owner.authenticate('Owner', ownerKeys);
        assert.equal(reconnectedOwner.currentUser.id, auth.currentUser.id);
        bob = new Peer(url);
        peers.push(bob);
        await bob.authenticate('Bob', bobKeys);
        otherDevice = new Peer(url);
        peers.push(otherDevice);
        await otherDevice.authenticate('Owner', ownerKeys);
        const connectedAgain = once(bot, 'connected');
        bot.connect();
        await connectedAgain;
      }
      const restoredSelectors = await owner.request(MessageType.SELECTOR_LIST, { channelId: recoveringPoll.channelId });
      const restoredPoll = restoredSelectors.selectors.find((selector) => selector.id === recoveringPoll.id);
      assert.equal(restoredPoll.ownResponse, '2');
      assert.equal(restoredPoll.responseCount, 1);
      assert.equal(restoredPoll.closedAt, null);
      if (expiringPoll) {
        console.log('Waiting for the real one-minute poll deadline with MonkyBot offline...');
        const expired = await owner.wait((message) => message.type === MessageType.SELECTOR_SNAPSHOT &&
          message.payload.id === expiringPoll.id && message.payload.closedAt !== null, 'server-owned poll expiry', 70000);
        assert.equal(expired.payload.responseCount, 0);
        assert.equal(expired.payload.canRespond, false);
        await bob.request(MessageType.SELECTOR_RESPOND, { id: expiringPoll.id, value: '1' }, true);
      }
      const beforeRestart = owner.messages.length;
      await startOfficial();
      await owner.wait((message) => owner.messages.indexOf(message) >= beforeRestart &&
        message.type === MessageType.COMMANDS_LIST_RESPONSE &&
        message.payload.commands.some((command) => command.botId === officialId && command.name === 'enquete'),
      'official marketplace reconnection after process restart');
      const recovered = await owner.request(MessageType.BOT_LIST, {});
      assert.equal(recovered.bots.length, accountsBefore.bots.length);
      assert.equal(recovered.bots.find((entry) => entry.id === officialId).online, true);
      assert.equal(fs.readFileSync(path.join(workingDir, '.keys', 'public.hex'), 'utf8'), publicKey);
      if (expiringPoll) {
        const noVotes = await owner.wait((message) => message.type === MessageType.CHAT_MESSAGE &&
          message.payload.userId === officialId && /Poll closed.*No voters while offline/s.test(message.payload.content),
        'recovered zero-vote poll result');
        assert.match(noVotes.payload.content, /Total votes: 0/);
        assert.match(noVotes.payload.content, /No votes were cast/);
      }
      await bob.request(MessageType.SELECTOR_RESPOND, { id: recoveringPoll.id, value: '2' });
      const recoveredResult = await owner.wait((message) => message.type === MessageType.CHAT_MESSAGE &&
        message.payload.userId === officialId && /Poll closed.*Survive restarts/s.test(message.payload.content),
      'restored distinct-voter poll result');
      assert.match(recoveredResult.payload.content, /Game B — 2 \(100\.0%\)/);
      assert.match(recoveredResult.payload.content, /Winning option: 2/);
      const recoveredHistory = await owner.request(MessageType.CHAT_LOAD_HISTORY, { channelId: recoveringPoll.channelId });
      assert.equal(recoveredHistory.messages.filter((message) => message.id === recoveredResult.payload.id).length, 1);
      const previousPublicHistory = await owner.request(MessageType.CHAT_LOAD_HISTORY, { channelId });
      assert.equal(previousPublicHistory.messages.filter((message) => message.id === final.payload.id).length, 1,
        'Restart recovery must not republish an already-finalized poll.');
      const afterRestart = await invokeOfficial(owner, 'dado', { lados: 20 });
      const reply = await owner.wait((message) => message.type === MessageType.COMMAND_RESPONSE &&
        message.payload.invocationId === afterRestart.invocationId, 'command after marketplace restart');
      assert.match(reply.payload.content, /Rolling d20/);
      await owner.finished(afterRestart.invocationId);
      assert.doesNotMatch(officialOutput, /MODULE_NOT_FOUND|Fatal:|❌/);
      console.log('Marketplace restart: identity, commands, private-channel invocation capability, durable votes and exactly-once poll results restored.');
    }
    if (process.argv.includes('--ui')) {
      const { exerciseBotUi, exerciseOfficialBotUi } = await import('./test-bot-ui.js');
      await exerciseBotUi(url, (ui) => exerciseOfficialBotUi(ui, {
        screenshotDir: process.env.MONKY_UI_ARTIFACTS,
        sendBackgroundMessage: () => owner.send(MessageType.CHAT_SEND, { channelId, content: 'A concurrent ordinary message' }),
        refreshRegistry: async () => {
          const unrelated = await owner.request(MessageType.BOT_CREATE, { name: 'Unrelated offline bot' });
          await owner.request(MessageType.BOT_UPDATE_PROFILE, { botId: unrelated.bot.id, name: 'Refreshed offline bot' });
        },
        verifySelfTarget: () => {
          const context = [...contexts.values()].find((candidate) => candidate.invokerNickname === 'UI Tester');
          assert.ok(context);
          assert.equal(context.args.member, context.invokerId);
          assert.equal(context.args.enabled, false);
          assert.equal(context.args.mode, 'second');
        },
      }));
    }
  }
} finally {
  if (officialProcess && officialProcess.exitCode === null) officialProcess.kill();
  if (officialExited) await officialExited;
  if (bot) await bot.close();
  for (const peer of peers) peer.ws.terminate();
  if (monky) await monky.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
