import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
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

  wait(predicate, description) {
    const previous = this.messages.find(predicate);
    if (previous) return Promise.resolve(previous);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(onMessage);
        reject(new Error(`Timeout: ${description}`));
      }, 5000);
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-bot-e2e-'));
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
  const owner = new Peer(url);
  peers.push(owner);
  const auth = await owner.authenticate('Owner', ownerKeys);
  const bob = new Peer(url);
  peers.push(bob);
  await bob.authenticate('Bob');
  const otherDevice = new Peer(url);
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

  const officialIndex = process.argv.indexOf('--official-bot');
  if (officialIndex !== -1) {
    const officialRoot = process.argv[officialIndex + 1];
    assert.ok(officialRoot, 'Pass the MonkyBot repository after --official-bot.');
    const officialEntry = path.join(path.resolve(officialRoot), 'dist', 'index.js');
    assert.ok(fs.statSync(officialEntry).isFile());
    const workingDir = path.join(dataDir, 'official-bot');
    fs.mkdirSync(workingDir);
    const officialAccount = await owner.request(MessageType.BOT_CREATE, { name: 'Official before sync' });
    const officialId = officialAccount.bot.id;
    officialProcess = spawn(process.execPath, [officialEntry], {
      cwd: workingDir,
      env: {
        ...process.env, NODE_PATH: '',
        MONKY_SERVE: 'false', MONKY_SERVER_URL: url, MONKY_BOT_TOKEN: officialAccount.token, MONKY_BOT_NAME: 'MonkyBot',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let officialOutput = '';
    officialProcess.stdout.on('data', (data) => { officialOutput = (officialOutput + data.toString()).slice(-10000); });
    officialProcess.stderr.on('data', (data) => { officialOutput = (officialOutput + data.toString()).slice(-10000); });
    officialExited = once(officialProcess, 'exit');
    await owner.wait((message) => message.type === MessageType.COMMANDS_LIST_RESPONSE &&
      message.payload.commands?.some((command) => command.botId === officialId && command.name === 'enquete'), 'official command discovery');
    const registered = await owner.request(MessageType.COMMANDS_LIST, {});
    assert.equal(registered.commands.filter((command) => command.name === 'ping').length, 2,
      'The UI fixture must include the same command name belonging to two distinct bots.');
    const invokeOfficial = (peer, commandName, options = {}) => peer.request(MessageType.COMMAND_INVOKE, {
      botId: officialId, channelId, commandName, options, locale: 'en',
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

    const magicCall = await invokeOfficial(owner, '8ball');
    const magicForm = await owner.prompt(magicCall.invocationId);
    await owner.request(MessageType.COMMAND_SUBMIT, {
      invocationId: magicCall.invocationId, interactionId: magicForm.interactionId,
      values: { pergunta: 'Can I answer through a private form?' },
    });
    await owner.finished(magicCall.invocationId);

    const pollCall = await invokeOfficial(owner, 'enquete');
    const pollForm = await owner.prompt(pollCall.invocationId);
    assert.equal(pollForm.form.fields.find((field) => field.name === 'opcoes').type, 'string-list');
    await owner.request(MessageType.COMMAND_SUBMIT, {
      invocationId: pollCall.invocationId, interactionId: pollForm.interactionId,
      values: { pergunta: 'What shall we play?', opcoes: ['Game A', 'Game B'], visibilidade: 'private' },
    });
    const review = await owner.prompt(pollCall.invocationId, pollForm.interactionId);
    await owner.request(MessageType.COMMAND_SUBMIT, {
      invocationId: pollCall.invocationId, interactionId: review.interactionId, values: { acao: 'edit' },
    });
    const edit = await owner.wait((message) => message.type === MessageType.COMMAND_PROMPT &&
      message.payload.invocationId === pollCall.invocationId &&
      ![pollForm.interactionId, review.interactionId].includes(message.payload.interactionId), 'edit poll');
    assert.equal(edit.payload.form.fields.find((field) => field.name === 'pergunta').defaultValue, 'What shall we play?');
    assert.deepEqual(edit.payload.form.fields.find((field) => field.name === 'opcoes').defaultValue, ['Game A', 'Game B']);
    await owner.request(MessageType.COMMAND_SUBMIT, {
      invocationId: pollCall.invocationId, interactionId: edit.payload.interactionId,
      values: { pergunta: 'Choose a game', opcoes: ['Game A', 'Game B', 'Game C'], visibilidade: 'public' },
    });
    const confirm = await owner.wait((message) => message.type === MessageType.COMMAND_PROMPT &&
      message.payload.invocationId === pollCall.invocationId &&
      ![pollForm.interactionId, review.interactionId, edit.payload.interactionId].includes(message.payload.interactionId), 'confirm edited poll');
    await owner.request(MessageType.COMMAND_SUBMIT, {
      invocationId: pollCall.invocationId, interactionId: confirm.payload.interactionId, values: { acao: 'confirm' },
    });
    const sharedPoll = await bob.wait((message) => message.type === MessageType.COMMAND_RESPONSE &&
      message.payload.invocationId === pollCall.invocationId, 'official shared poll');
    assert.equal(sharedPoll.payload.ephemeral, false);
    assert.equal(sharedPoll.payload.botName, 'MonkyBot');
    assert.equal(sharedPoll.payload.commandName, 'enquete');
    assert.equal(sharedPoll.payload.invokerId, auth.currentUser.id);
    assert.equal(sharedPoll.payload.invokerNickname, 'Owner');
    assert.equal(sharedPoll.payload.options, undefined);
    assert.match(sharedPoll.payload.content, /Choose a game/);
    assert.match(sharedPoll.payload.content, /Game C/);
    await owner.finished(pollCall.invocationId);
    assert.equal(bob.messages.filter((message) => message.type === MessageType.COMMAND_RESPONSE &&
      message.payload.invocationId === pollCall.invocationId).length, 1, 'No private previews leaked.');
    const image = await fetch(`http://127.0.0.1:${port}${sharedPoll.payload.botAvatarUrl}`);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), fs.readFileSync(path.join(officialRoot, 'assets', 'monky-logo.png')));
    assert.doesNotMatch(officialOutput, /MODULE_NOT_FOUND|Fatal:|❌/);
    console.log('Official MonkyBot runtime: all six commands, typed parameters, 8ball form, poll edit/confirm/publish and exact bundled logo passed.');
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
