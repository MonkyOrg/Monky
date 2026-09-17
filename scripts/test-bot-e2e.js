import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const { MonkyServer } = require('../apps/server/dist/server.js');
const { BotClient, BOT_CAPABILITIES, LIMITS, MessageType, PROTOCOL_VERSION } = require('../packages/bot-sdk/dist/index.js');

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
  voicePeers = new Map();
  voiceQueue = Promise.resolve();
  voiceEnabled = false;
  voiceChannelId = null;
  voiceError = null;

  constructor(url) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === MessageType.PING) {
        this.send(MessageType.PONG, { timestamp: Date.now() });
      }
      this.deliver(message);
      if (this.voiceEnabled && [MessageType.VOICE_USER_JOINED, MessageType.VOICE_USER_LEFT, MessageType.RTC_SIGNAL].includes(message.type)) {
        this.voiceQueue = this.voiceQueue.then(() => this.handleVoice(message)).catch((error) => {
          this.voiceError = error;
          this.deliver({ type: 'SOCKET_ERROR', error });
        });
      }
    });
    this.ws.on('error', (error) => {
      for (const waiter of [...this.waiters]) waiter({ type: 'SOCKET_ERROR', error });
    });
  }

  deliver(message) {
    this.messages.push(message);
    for (const waiter of [...this.waiters]) waiter(message);
  }

  async voicePeer(sessionId, initiate = false) {
    if (this.voicePeers.has(sessionId)) return this.voicePeers.get(sessionId);
    const { RTCPeerConnection } = require('werift');
    const { opusCodec } = require('../packages/bot-sdk/dist/voice/OpusPeer');
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', codecs: { audio: [opusCodec()] } });
    this.voicePeers.set(sessionId, pc);
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.onIceCandidate.subscribe((candidate) => {
      if (candidate && this.voiceEnabled && this.voicePeers.get(sessionId) === pc && this.ws.readyState === WebSocket.OPEN) {
        this.send(MessageType.RTC_SIGNAL, { fromSessionId: this.sessionId, targetSessionId: sessionId,
          signalType: 'candidate', candidate: candidate.toJSON() });
      }
    });
    pc.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((packet) => {
      this.deliver({ type: 'VOICE_PACKET', payload: { sessionId, bytes: Buffer.from(packet.payload) } });
    }));
    if (initiate) {
      await pc.setLocalDescription(await pc.createOffer());
      if (this.voiceEnabled) {
        this.send(MessageType.RTC_SIGNAL, {
          fromSessionId: this.sessionId, targetSessionId: sessionId, signalType: 'offer', sdp: { type: 'offer', sdp: pc.localDescription.sdp },
        });
      }
    }
    return pc;
  }

  async handleVoice(message) {
    if (!this.voiceEnabled) return;
    if (message.type === MessageType.VOICE_USER_LEFT) {
      if (message.payload.channelId !== this.voiceChannelId) return;
      if (message.payload.sessionId === this.sessionId) {
        this.voiceChannelId = null;
        await Promise.all([...this.voicePeers.values()].map((pc) => pc.close()));
        this.voicePeers.clear();
      } else {
        const pc = this.voicePeers.get(message.payload.sessionId);
        this.voicePeers.delete(message.payload.sessionId);
        if (pc) await pc.close();
      }
      return;
    }
    if (message.type === MessageType.VOICE_USER_JOINED) {
      const joining = message.payload.sessionId === this.sessionId;
      if (joining) this.voiceChannelId = message.payload.channelId;
      if (message.payload.channelId !== this.voiceChannelId) return;
      const sessions = [...(message.payload.participants ?? []).map((member) => member.voiceState.sessionId), message.payload.sessionId];
      for (const sessionId of sessions) {
        if (sessionId.startsWith('bot:')) await this.voicePeer(sessionId, joining);
      }
      return;
    }
    const signal = message.payload;
    if (!this.voiceChannelId || !signal.fromSessionId.startsWith('bot:') || signal.targetSessionId !== this.sessionId) return;
    const pc = await this.voicePeer(signal.fromSessionId);
    if (signal.signalType === 'candidate' && signal.candidate) {
      await pc.addIceCandidate({
        candidate: signal.candidate.candidate, sdpMid: signal.candidate.sdpMid ?? undefined,
        sdpMLineIndex: signal.candidate.sdpMLineIndex ?? undefined,
      });
    } else if (signal.signalType === 'answer') {
      await pc.setRemoteDescription(signal.sdp);
    } else if (signal.signalType === 'offer') {
      await pc.setRemoteDescription(signal.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      if (this.voiceEnabled) {
        this.send(MessageType.RTC_SIGNAL, {
          fromSessionId: this.sessionId, targetSessionId: signal.fromSessionId, signalType: 'answer', sdp: { type: 'answer', sdp: pc.localDescription.sdp },
        });
      }
    }
  }

  async closeVoice() {
    this.voiceEnabled = false;
    this.voiceChannelId = null;
    await this.voiceQueue;
    await Promise.all([...this.voicePeers.values()].map((pc) => pc.close()));
    this.voicePeers.clear();
  }

  async receiveOpus(connection, description) {
    const previous = new Set(this.messages);
    const opus = Uint8Array.from([0xf8, 0xff, 0xfe]);
    let activity;
    let sending = true;
    const stream = (async () => {
      while (sending) {
        await connection.writeOpus(opus);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    try {
      const packet = await Promise.race([
        this.wait((message) => message.type === 'VOICE_PACKET' && !previous.has(message), description),
        stream,
      ]);
      assert.deepEqual(packet.payload.bytes, Buffer.from(opus));
      activity = await this.wait((message) => message.type === MessageType.VOICE_STATE_CHANGED &&
        !previous.has(message) && message.payload.voiceState.sessionId === packet.payload.sessionId &&
        message.payload.voiceState.isSpeaking === true, `${description}: speaking activity`);
    } finally {
      sending = false;
      await stream;
    }
    await this.wait((message) => message.type === MessageType.VOICE_STATE_CHANGED &&
      this.messages.indexOf(message) > this.messages.indexOf(activity) &&
      message.payload.voiceState.sessionId === activity.payload.voiceState.sessionId &&
      message.payload.voiceState.isSpeaking === false, `${description}: idle activity cleared`);
  }

  send(type, payload, requestId) {
    this.ws.send(JSON.stringify({ type, payload, requestId }));
  }

  wait(predicate, description, timeoutMs = 5000) {
    if (this.voiceError) return Promise.reject(this.voiceError);
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

  async request(type, payload, expectedError = false, timeoutMs = 5000) {
    const requestId = randomUUID();
    const result = this.wait((message) => message.requestId === requestId, type, timeoutMs);
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
    this.sessionId = authenticated.payload.currentUser.sessionId;
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

async function installReviewedBot(owner, manifestUrl) {
  const preview = await owner.request(MessageType.BOT_INSTALL_PREVIEW, { manifestUrl });
  return owner.request(MessageType.BOT_INSTALL, {
    previewId: preview.previewId, grantedCapabilities: preview.manifest.requestedCapabilities,
  });
}

try {
  const port = await freePort();
  monky = await MonkyServer.create({ port, dataDir, serverName: 'Bot interaction test', maxUsers: 6 });
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
  const otherDeviceAuth = await otherDevice.authenticate('Owner', ownerKeys);
  const channelId = auth.server.channels.find((channel) => channel.type === 'TEXT')?.id;
  assert.ok(channelId);
  const created = await owner.request(MessageType.BOT_CREATE, {});
  assert.equal(created.bot.profilePending, true);
  const botId = created.bot.id;
  const botKeys = identity();
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJfcAAAAASUVORK5CYII=';
  bot = new BotClient({
    requestedCapabilities: [...BOT_CAPABILITIES],
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
    name: 'voice-context',
    description: 'Authenticated voice context',
    handler: (ctx) => ctx.reply(JSON.stringify({
      sessionId: ctx.invokerSessionId,
      voiceChannelId: ctx.invokerVoiceChannelId,
    })),
  });
  bot.command({
    name: 'voice-live-context',
    description: 'Revalidate voice after an interaction',
    handler: async (ctx) => {
      const choice = await ctx.choose({ title: 'Continue', choices: [{ label: 'Continue', value: 'yes' }] });
      if (choice === null) return;
      ctx.reply(JSON.stringify({
        snapshot: ctx.invokerVoiceChannelId,
        current: await ctx.getVoiceChannel(),
      }));
    },
  });
  bot.command({
    name: 'voice-private-join',
    description: 'Join the current room using the actual command invocation',
    handler: async (ctx) => {
      const room = await ctx.getVoiceChannel();
      assert.ok(room, 'The private-join fixture requires its caller in voice.');
      const connection = await bot.joinVoice(ctx.serverId, room, { invocationId: ctx.invocationId });
      ctx.reply(connection.channelId);
    },
  });
  bot.command({
    name: 'screen-fixture',
    description: 'A shared screen that outlives its command',
    voiceRequirement: 'joined',
    handler: async (ctx) => {
      await ctx.createScreen({
        id: ctx.invocationId, title: 'Shared counter', html: '<p>Counter fixture</p>', state: { count: 0 },
      });
    },
  });
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
  const soundChoiceId = `opaque:${'x'.repeat(500)}`;
  const soundContexts = new Map();
  const previewContexts = [];
  let waitForPreviewCancellation = false;
  const previewBytes = Buffer.alloc(48);
  previewBytes.write('RIFF'); previewBytes.writeUInt32LE(40, 4); previewBytes.write('WAVEfmt ', 8);
  previewBytes.writeUInt32LE(16, 16); previewBytes.writeUInt16LE(1, 20); previewBytes.writeUInt16LE(1, 22);
  previewBytes.writeUInt32LE(8000, 24); previewBytes.writeUInt32LE(16000, 28); previewBytes.writeUInt16LE(2, 32);
  previewBytes.writeUInt16LE(16, 34); previewBytes.write('data', 36); previewBytes.writeUInt32LE(4, 40);
  bot.command({
    name: 'sound', description: 'Local sound download', downloadsSound: true,
    options: [{ name: 'audio', description: 'Audio', type: 'string', required: true, autocomplete: true }],
    autocomplete: (ctx) => {
      assert.equal(ctx.optionName, 'audio');
      assert.equal(ctx.locale, 'en');
      assert.deepEqual(ctx.args, {});
      if (ctx.query === 'paged fixture') {
        assert.equal(ctx.cursor, ctx.page === 0 ? undefined : `batch:${ctx.page}`);
        return {
          choices: Array.from({ length: 20 }, (_, index) => ({
            label: `Paged sound ${ctx.page * 20 + index}`, value: `paged:${ctx.page * 20 + index}`,
            audio: { resourceId: `authored-page-${ctx.page}`, fileName: 'authored.wav', durationMs: 1 },
          })),
          hasMore: ctx.page < 2, ...(ctx.page < 2 ? { nextCursor: `batch:${ctx.page + 1}` } : {}),
        };
      }
      return [{ label: `Sound ${ctx.query}`, value: soundChoiceId,
        audio: { resourceId: 'authored-clip', fileName: 'authored.wav', durationMs: 1 } }];
    },
    audioPreview: async (ctx) => {
      previewContexts.push(ctx);
      bot.emit('fixturePreviewStarted', ctx);
      if (waitForPreviewCancellation) {
        await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }));
        ctx.signal.throwIfAborted();
      }
      return { bytes: previewBytes, mimeType: 'audio/wav' };
    },
    handler: async (ctx) => {
      soundContexts.set(ctx.invocationId, ctx);
      assert.equal(ctx.args.audio, soundChoiceId);
      const result = await ctx.downloadSound({
        url: 'https://example.com/fixture.wav', fileName: 'fixture.wav', title: 'Fixture sound',
      });
      if (result !== null) ctx.reply(`download:${result.status}`);
    },
  });
  const declared = once(bot, 'permissionsChanged');
  bot.connect({ serverId: 'e2e' });
  const [permissions] = await declared;
  assert.deepEqual(permissions.granted, [], 'A manual token cannot approve its own declaration.');
  const reviewedDisconnect = once(bot, 'disconnected');
  await owner.request(MessageType.BOT_PERMISSIONS_UPDATE, {
    botId, expectedRevision: permissions.revision, granted: permissions.requested,
  });
  await reviewedDisconnect;
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

  const outsideScreen = await owner.request(MessageType.COMMAND_INVOKE, {
    botId, channelId, commandName: 'screen-fixture', locale: 'en',
  }, true);
  assert.equal(outsideScreen.code, 'BOT_VOICE_REQUIRED');
  const screenRoom = (await owner.request(MessageType.CHANNEL_CREATE, {
    name: 'shared-screen-stage', type: 'VOICE',
  })).channel.id;
  await owner.request(MessageType.VOICE_JOIN, { channelId: screenRoom });
  await bob.request(MessageType.VOICE_JOIN, { channelId: screenRoom });
  const screenCall = await owner.request(MessageType.COMMAND_INVOKE, {
    botId, channelId, commandName: 'screen-fixture', locale: 'en',
  });
  await owner.finished(screenCall.invocationId);
  const publicScreen = await bob.wait((message) => message.type === MessageType.BOT_SCREEN_SNAPSHOT &&
    message.payload.id === screenCall.invocationId, 'shared screen after its command completed');
  assert.deepEqual(publicScreen.payload.state, { count: 0 });
  assert.equal(publicScreen.payload.channelId, screenRoom);
  assert.equal((await bot.listScreens('e2e', screenRoom))[0].id, screenCall.invocationId);
  assert.equal(otherDevice.messages.some((message) => message.type === MessageType.BOT_SCREEN_SNAPSHOT &&
    message.payload.id === screenCall.invocationId), false, 'Another device outside voice cannot receive a miniapp.');
  const actionReceived = once(bot, 'screenAction', { signal: AbortSignal.timeout(5000) });
  const screenAction = {
    id: screenCall.invocationId, instanceId: publicScreen.payload.instanceId,
    action: 'increment', payload: { userId: auth.currentUser.id },
    revision: 0, actionId: randomUUID(),
  };
  await bob.request(MessageType.BOT_SCREEN_ACTION, screenAction);
  const [screenEvent] = await actionReceived;
  assert.equal(screenEvent.serverId, 'e2e');
  assert.equal(screenEvent.userId, bobAuth.currentUser.id, 'Action data cannot spoof the authenticated actor.');
  assert.equal(screenEvent.userNickname, 'Bob');
  await bob.request(MessageType.BOT_SCREEN_ACTION, { ...screenAction, userId: auth.currentUser.id }, true);
  const screenUpdates = await Promise.allSettled([
    bot.updateScreen('e2e', publicScreen.payload, { state: { count: 1 }, expectedRevision: 0 }),
    bot.updateScreen('e2e', publicScreen.payload, { state: { count: 2 }, expectedRevision: 0 }),
  ]);
  assert.equal(screenUpdates.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(screenUpdates.filter((result) => result.status === 'rejected').length, 1);
  await otherDevice.request(MessageType.BOT_SCREEN_LIST, { channelId: screenRoom }, true);
  await otherDevice.request(MessageType.VOICE_JOIN, { channelId: screenRoom });
  const currentScreens = await otherDevice.request(MessageType.BOT_SCREEN_LIST, { channelId: screenRoom });
  assert.equal(currentScreens.screens[0].revision, 1);
  assert.deepEqual(currentScreens.screens[0].state, { count: 1 });
  const staleScreenAction = await bob.request(MessageType.BOT_SCREEN_ACTION, {
    ...screenAction, actionId: randomUUID(),
  }, true);
  assert.equal(staleScreenAction.code, 'BOT_SCREEN_CONFLICT');
  const screenRemoved = once(bot, 'screenRemoved', { signal: AbortSignal.timeout(5000) });
  await bot.closeScreen('e2e', publicScreen.payload);
  assert.deepEqual((await screenRemoved)[0], {
    serverId: 'e2e', id: screenCall.invocationId, instanceId: publicScreen.payload.instanceId,
    channelId: screenRoom, reason: 'closed',
  });
  await bob.wait((message) => message.type === MessageType.BOT_SCREEN_REMOVED &&
    message.payload.id === screenCall.invocationId, 'screen close delivered to other viewers');
  await owner.request(MessageType.CHANNEL_DELETE, { channelId: screenRoom });

  const privateScreens = (await owner.request(MessageType.CHANNEL_CREATE, {
    name: 'private-screens', type: 'VOICE', isPrivate: true, allowedRoleIds: [],
  })).channel.id;
  await owner.request(MessageType.VOICE_JOIN, { channelId: privateScreens });
  const privateCall = await owner.request(MessageType.COMMAND_INVOKE, {
    botId, channelId, commandName: 'screen-fixture', locale: 'en',
  });
  await owner.finished(privateCall.invocationId);
  const privateList = await owner.request(MessageType.BOT_SCREEN_LIST, { channelId: privateScreens });
  assert.equal(privateList.screens[0].id, privateCall.invocationId);
  await bob.request(MessageType.BOT_SCREEN_LIST, { channelId: privateScreens }, true);
  assert.equal(bob.messages.some((message) => message.type === MessageType.BOT_SCREEN_SNAPSHOT &&
    message.payload.id === privateCall.invocationId), false);
  const privateRemoved = once(bot, 'screenRemoved', { signal: AbortSignal.timeout(5000) });
  await owner.request(MessageType.CHANNEL_DELETE, { channelId: privateScreens });
  assert.equal((await privateRemoved)[0].id, privateCall.invocationId);
  assert.deepEqual(sdkErrors, []);

  const firstRoom = (await owner.request(MessageType.CHANNEL_CREATE, { name: 'music-one', type: 'VOICE' })).channel.id;
  const secondRoom = (await owner.request(MessageType.CHANNEL_CREATE, { name: 'music-two', type: 'VOICE' })).channel.id;
  await owner.request(MessageType.VOICE_JOIN, { channelId: firstRoom });
  await otherDevice.request(MessageType.VOICE_JOIN, { channelId: secondRoom });
  let ownerVoiceChannelId = firstRoom;
  try {
    for (const [peer, sessionId, voiceChannelId] of [
      [owner, auth.currentUser.sessionId, firstRoom],
      [otherDevice, otherDeviceAuth.currentUser.sessionId, secondRoom],
      [bob, bobAuth.currentUser.sessionId, null],
    ]) {
      const invocation = await peer.request(MessageType.COMMAND_INVOKE, {
        botId, channelId, commandName: 'voice-context', locale: 'en',
      });
      const response = await peer.wait((message) => message.type === MessageType.COMMAND_RESPONSE &&
        message.payload.invocationId === invocation.invocationId, 'authenticated caller voice room');
      assert.deepEqual(JSON.parse(response.payload.content), { sessionId, voiceChannelId },
        'The voice room must belong to the calling connection, not another device of that user.');
      await peer.finished(invocation.invocationId);
    }
    await bob.request(MessageType.COMMAND_INVOKE, {
      botId, channelId, commandName: 'voice-context', locale: 'en',
      invokerVoiceChannelId: firstRoom, invokerSessionId: auth.currentUser.sessionId,
    }, true);
    const delayed = await owner.request(MessageType.COMMAND_INVOKE, {
      botId, channelId, commandName: 'voice-live-context', locale: 'en',
    });
    const confirmation = await owner.prompt(delayed.invocationId);
    await owner.request(MessageType.VOICE_JOIN, { channelId: secondRoom });
    ownerVoiceChannelId = secondRoom;
    await owner.request(MessageType.COMMAND_SUBMIT, {
      invocationId: delayed.invocationId,
      interactionId: confirmation.interactionId,
      values: { [confirmation.form.fields[0].name]: 'yes' },
    });
    const revalidated = await owner.wait((message) => message.type === MessageType.COMMAND_RESPONSE &&
      message.payload.invocationId === delayed.invocationId, 'current voice room after moving during a prompt');
    assert.deepEqual(JSON.parse(revalidated.payload.content), { snapshot: firstRoom, current: secondRoom });
    await owner.finished(delayed.invocationId);
  } finally {
    await owner.request(MessageType.VOICE_LEAVE, { channelId: ownerVoiceChannelId });
    await otherDevice.request(MessageType.VOICE_LEAVE, { channelId: secondRoom });
    await owner.request(MessageType.CHANNEL_DELETE, { channelId: firstRoom });
    await owner.request(MessageType.CHANNEL_DELETE, { channelId: secondRoom });
  }

  const privateVoiceRoom = (await owner.request(MessageType.CHANNEL_CREATE, {
    name: 'private-music', type: 'VOICE', isPrivate: true, allowedRoleIds: [],
  })).channel.id;
  const privateDestination = (await owner.request(MessageType.CHANNEL_CREATE, {
    name: 'private-destination', type: 'VOICE', isPrivate: true, allowedRoleIds: [],
  })).channel.id;
  try {
    owner.voiceEnabled = true;
    otherDevice.voiceEnabled = true;
    await owner.request(MessageType.VOICE_JOIN, { channelId: privateVoiceRoom });
    const privateJoin = await owner.request(MessageType.COMMAND_INVOKE, {
      botId, channelId, commandName: 'voice-private-join', locale: 'en',
    });
    const joined = await owner.wait((message) => message.payload?.invocationId === privateJoin.invocationId &&
      [MessageType.COMMAND_RESPONSE, MessageType.COMMAND_FINISHED].includes(message.type), 'invocation-authorized private voice', 15000);
    assert.equal(joined.type, MessageType.COMMAND_RESPONSE, sdkErrors.map((error) => error.message).join('; '));
    assert.equal(joined.payload.content, privateVoiceRoom);
    await owner.finished(privateJoin.invocationId);
    const privateConnection = bot.getVoiceConnection('e2e');
    assert.ok(privateConnection);
    assert.equal(privateConnection.isClosed, false, 'Ending a command must not end its voice admission.');
    const botArrival = await owner.wait((message) => message.type === MessageType.VOICE_USER_JOINED &&
      message.payload.channelId === privateVoiceRoom && message.payload.userId === botId, 'initial bot voice flags');
    assert.equal(botArrival.payload.voiceState.isMuted, false);
    assert.equal(botArrival.payload.voiceState.isDeafened, false,
      'Lacking audio reception is not a user-selected deafen state.');
    const waitForHumans = async (count) => {
      const signal = AbortSignal.timeout(5000);
      while (privateConnection.humanParticipantCount !== count) {
        assert.equal(privateConnection.isClosed, false, 'Authorized remaining listeners keep the room active.');
        await once(bot, 'voiceParticipantsChanged', { signal });
      }
    };
    await waitForHumans(1);
    await owner.receiveOpus(privateConnection, 'private voice Opus delivery');
    await otherDevice.request(MessageType.VOICE_JOIN, { channelId: privateVoiceRoom });
    await waitForHumans(2);
    await owner.request(MessageType.VOICE_JOIN, { channelId: privateDestination });
    await waitForHumans(1);
    assert.equal(privateConnection.isClosed, false);
    await otherDevice.receiveOpus(privateConnection, 'Opus after the original caller moves to a hidden room');
    assert.equal(bob.messages.some((message) => message.type === MessageType.VOICE_USER_JOINED &&
      message.payload.channelId === privateVoiceRoom && message.payload.userId === botId), false,
    'Voice admission must not reveal a private room to unauthorized people.');
    assert.equal(bob.messages.some((message) => message.type === MessageType.VOICE_STATE_CHANGED &&
      message.payload.voiceState.channelId === privateVoiceRoom), false,
    'Speaking activity must preserve the private voice audience.');
  } finally {
    await bot.leaveVoice('e2e');
    await owner.closeVoice();
    await otherDevice.closeVoice();
    await owner.request(MessageType.CHANNEL_DELETE, { channelId: privateVoiceRoom });
    await owner.request(MessageType.CHANNEL_DELETE, { channelId: privateDestination });
  }
  assert.deepEqual(sdkErrors, []);
  console.log('Real private voice: normal mute flags, Opus activity/idle, scoped admission, remaining listener and visibility isolation passed.');

  const autocompleteId = randomUUID();
  owner.send(MessageType.COMMAND_AUTOCOMPLETE, {
    botId, channelId, commandName: 'sound', optionName: 'audio', query: 'fixture', locale: 'en',
  }, autocompleteId);
  const suggestions = (await owner.wait(message => message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT &&
    message.requestId === autocompleteId, 'lazy autocomplete choices')).payload;
  assert.equal(suggestions.status, 'ok');
  assert.equal(suggestions.choices[0].value, soundChoiceId);
  assert.equal(previewContexts.length, 0, 'Search metadata cannot invoke a lazy audio provider');
  const previewInput = {
    botId, channelId, commandName: 'sound', optionName: 'audio', autocompleteRequestId: autocompleteId,
    resourceId: suggestions.choices[0].audio.resourceId,
  };
  assert.notEqual(previewInput.resourceId, 'authored-clip');
  for (const peer of [otherDevice, bob]) await peer.request(MessageType.COMMAND_AUDIO_PREVIEW, previewInput, true);
  await owner.request(MessageType.COMMAND_AUDIO_PREVIEW, { ...previewInput, resourceId: 'authored-clip' }, true);
  const preview = await owner.request(MessageType.COMMAND_AUDIO_PREVIEW, previewInput);
  assert.deepEqual(preview, { status: 'ok', audioBase64: previewBytes.toString('base64'), mimeType: 'audio/wav' });
  assert.equal(previewContexts.length, 1);
  assert.equal(previewContexts[0].resourceId, 'authored-clip');
  assert.equal(previewContexts[0].serverId, 'e2e');
  assert.equal(previewContexts[0].signal.aborted, true);
  assert.equal(soundContexts.size, 0, 'Previewing cannot invoke commands or change the queue');
  const { AudioPreviews } = require('../apps/client/dist-electron/main/audioPreviews.js');
  const nativePreview = await new AudioPreviews().load(1, {
    requestId: randomUUID(), audioBase64: preview.audioBase64, mimeType: preview.mimeType, fileName: 'authored.wav',
  });
  assert.equal(nativePreview.status, 'ready');
  assert.deepEqual(Buffer.from(nativePreview.data), previewBytes);
  assert.equal(otherDevice.messages.some(message => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT), false);
  assert.equal(bob.messages.some(message => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT), false);
  waitForPreviewCancellation = true;
  const started = once(bot, 'fixturePreviewStarted');
  const previewId = randomUUID();
  owner.send(MessageType.COMMAND_AUDIO_PREVIEW, previewInput, previewId);
  const [pendingPreview] = await started;
  const aborted = new Promise(resolve => pendingPreview.signal.addEventListener('abort', resolve, { once: true }));
  owner.send(MessageType.COMMAND_AUDIO_PREVIEW_CANCEL, { requestId: previewId });
  await aborted;
  await owner.request(MessageType.PING, {});
  assert.equal(owner.messages.some(message => message.type === MessageType.COMMAND_AUDIO_PREVIEW_RESULT && message.requestId === previewId), false);
  owner.send(MessageType.COMMAND_AUTOCOMPLETE_CANCEL, { requestId: autocompleteId });
  await owner.wait(message => message.type === MessageType.COMMAND_AUTOCOMPLETE_CANCEL &&
    message.payload.requestId === autocompleteId, 'lazy choice invalidation');
  await owner.request(MessageType.COMMAND_AUDIO_PREVIEW, previewInput, true);
  assert.equal(previewContexts.length, 2);
  console.log('Lazy audio preview E2E: explicit generation, opaque authorization, caller/device privacy, native byte validation and AbortSignal cancellation passed.');
  waitForPreviewCancellation = false;
  const pagedRequests = [];
  const pagedChoices = [];
  for (let page = 0; page < 3; page++) {
    await new Promise(resolve => setTimeout(resolve, LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS));
    const requestId = randomUUID();
    owner.send(MessageType.COMMAND_AUTOCOMPLETE, {
      botId, channelId, commandName: 'sound', optionName: 'audio', query: 'paged fixture', locale: 'en',
      ...(page > 0 ? { page, cursor: `batch:${page}` } : {}),
    }, requestId);
    const result = (await owner.wait(message => message.type === MessageType.COMMAND_AUTOCOMPLETE_RESULT &&
      message.requestId === requestId, `autocomplete page ${page}`)).payload;
    assert.equal(result.status, 'ok');
    assert.equal(result.choices.length, 20);
    assert.equal(result.hasMore, page < 2);
    assert.equal(result.nextCursor, page < 2 ? `batch:${page + 1}` : undefined);
    pagedRequests.push(requestId);
    pagedChoices.push(...result.choices);
  }
  assert.equal(new Set(pagedChoices.map(choice => choice.value)).size, 60);
  for (const page of [0, 1, 2]) {
    const input = {
      botId, channelId, commandName: 'sound', optionName: 'audio',
      autocompleteRequestId: pagedRequests[page], resourceId: pagedChoices[page * 20].audio.resourceId,
    };
    await otherDevice.request(MessageType.COMMAND_AUDIO_PREVIEW, input, true);
    await owner.request(MessageType.COMMAND_AUDIO_PREVIEW, {
      ...input, autocompleteRequestId: pagedRequests[(page + 1) % pagedRequests.length],
    }, true);
    const result = await owner.request(MessageType.COMMAND_AUDIO_PREVIEW, input);
    assert.equal(result.status, 'ok');
    assert.equal(result.audioBase64, previewBytes.toString('base64'));
    assert.equal(previewContexts.at(-1).resourceId, `authored-page-${page}`);
  }
  for (const requestId of pagedRequests) owner.send(MessageType.COMMAND_AUTOCOMPLETE_CANCEL, { requestId });
  await owner.request(MessageType.PING, {});
  assert.equal(soundContexts.size, 0);
  assert.deepEqual(sdkErrors, []);
  console.log('Paginated autocomplete E2E: 60 results, source cursors, old-page previews, per-page authorization and legacy array compatibility passed.');
  assert.equal(owner.messages.some((message) => message.type === MessageType.COMMAND_SOUND_DOWNLOAD), false);
  const soundInput = {
    botId, channelId, commandName: 'sound', options: { audio: soundChoiceId }, locale: 'en',
  };
  await owner.request(MessageType.COMMAND_INVOKE, soundInput, true);
  const soundCall = await owner.request(MessageType.COMMAND_INVOKE, { ...soundInput, allowSoundDownload: true });
  const download = await owner.wait((message) => message.type === MessageType.COMMAND_SOUND_DOWNLOAD &&
    message.payload.invocationId === soundCall.invocationId, 'authorized local sound download');
  assert.equal(download.payload.botId, botId);
  assert.equal(download.payload.botName, 'Identity Bot');
  assert.equal(download.payload.commandName, 'sound');
  assert.equal(download.payload.invokerId, auth.currentUser.id);
  assert.equal(download.payload.invokerNickname, 'Owner');
  assert.equal(download.payload.channelId, channelId);
  assert.equal(download.payload.fileName, 'fixture.wav');
  assert.equal(download.payload.folderPath, undefined);
  assert.equal(owner.messages.some((message) => message.type === MessageType.COMMAND_FINISHED &&
    message.payload.invocationId === soundCall.invocationId), false, 'SDK must await the local download result.');
  for (const peer of [bob, otherDevice]) {
    assert.equal(peer.messages.some((message) => message.type === MessageType.COMMAND_SOUND_DOWNLOAD), false);
    await peer.request(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
      invocationId: soundCall.invocationId, downloadId: download.payload.downloadId, result: { status: 'downloaded' },
    }, true);
  }
  const downloadResult = {
    invocationId: soundCall.invocationId, downloadId: download.payload.downloadId, result: { status: 'downloaded' },
  };
  await owner.request(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, downloadResult);
  const downloaded = await owner.wait((message) => message.type === MessageType.COMMAND_RESPONSE &&
    message.payload.invocationId === soundCall.invocationId, 'download completion');
  assert.equal(downloaded.payload.content, 'download:downloaded');
  assert.equal(downloaded.payload.ephemeral, true);
  await owner.finished(soundCall.invocationId);
  await owner.request(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, downloadResult, true);
  assert.equal(bob.messages.some((message) => message.type === MessageType.COMMAND_RESPONSE &&
    message.payload.invocationId === soundCall.invocationId), false);
  assert.equal(otherDevice.messages.some((message) => message.type === MessageType.COMMAND_RESPONSE &&
    message.payload.invocationId === soundCall.invocationId), false);

  const cancelledSound = await owner.request(MessageType.COMMAND_INVOKE, { ...soundInput, allowSoundDownload: true });
  const pendingSound = await owner.wait((message) => message.type === MessageType.COMMAND_SOUND_DOWNLOAD &&
    message.payload.invocationId === cancelledSound.invocationId, 'pending sound to cancel');
  await owner.request(MessageType.COMMAND_CANCEL, { invocationId: cancelledSound.invocationId });
  await owner.wait((message) => message.type === MessageType.COMMAND_SOUND_DOWNLOAD_CANCEL &&
    message.payload.downloadId === pendingSound.payload.downloadId, 'native download cancellation');
  await owner.finished(cancelledSound.invocationId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(soundContexts.get(cancelledSound.invocationId).signal.aborted, true);
  await owner.request(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
    invocationId: cancelledSound.invocationId, downloadId: pendingSound.payload.downloadId, result: { status: 'downloaded' },
  }, true);
  assert.deepEqual(sdkErrors, []);
  console.log('Real autocomplete and local-download protocol: opaque choice, explicit consent, caller/device isolation, awaited result, replay rejection and cancellation passed.');

  const soundBotIndex = process.argv.indexOf('--sound-bot');
  const soundBotCliIndex = process.argv.indexOf('--sound-bot-cli');
  if (soundBotIndex !== -1 || soundBotCliIndex !== -1) {
    assert.ok(soundBotIndex === -1 || soundBotCliIndex === -1, 'Choose the direct executable or generated CLI, not both.');
    const useCli = soundBotCliIndex !== -1;
    const soundBotArgument = process.argv[(useCli ? soundBotCliIndex : soundBotIndex) + 1];
    assert.ok(soundBotArgument, 'Pass the sound bot directory after --sound-bot or --sound-bot-cli.');
    const soundBotRoot = path.resolve(soundBotArgument);
    const entry = path.join(soundBotRoot, 'dist', 'index.js');
    assert.ok(fs.statSync(entry).isFile(), 'Build the sound bot before running its integration check.');
    const account = await owner.request(MessageType.BOT_CREATE, {});
    const workingDir = path.join(dataDir, 'sound-bot');
    fs.mkdirSync(workingDir);
    const env = {
      ...process.env, NODE_PATH: '', NODE_OPTIONS: '',
      MONKY_SERVER_URL: url, MONKY_BOT_TOKEN: account.token, MONKY_BOT_PUBLIC_KEY: identity().publicKey,
      MONKY_SERVE: 'false',
      MONKY_BOT_NAME: 'Private sound bot', MONKY_BOT_CLI_HOME: path.join(workingDir, 'profiles'),
    };
    let args = [entry];
    let launcher;
    if (useCli) {
      const pkg = JSON.parse(fs.readFileSync(path.join(soundBotRoot, 'package.json'), 'utf8'));
      launcher = path.join(soundBotRoot, pkg.bin[pkg.monkyBot.cliName]);
      const setup = spawnSync(process.execPath, [launcher, 'setup', '--non-interactive',
        '--server-url', url, '--token-env', 'MONKY_BOT_TOKEN', '--bot-dir', workingDir], {
        cwd: workingDir, env, encoding: 'utf8', timeout: 15000,
      });
      if (setup.error) throw setup.error;
      assert.equal(setup.status, 0, setup.stderr);
      const stopBridge = path.join(workingDir, 'cli-stop-bridge.cjs');
      fs.writeFileSync(stopBridge, `
process.on('message', (message) => {
  if (message !== 'monky-e2e-stop') return;
  process.emit('SIGTERM');
  if (process.connected) process.disconnect();
});
`);
      args = ['--no-global-search-paths', '--require', stopBridge, launcher, 'start', '--foreground', '--locale', 'en'];
    }
    const startSoundBot = () => {
      const child = spawn(process.execPath, args, {
        cwd: workingDir, env, stdio: useCli ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
      });
      const runtime = { child, exited: new Promise((resolve) => child.once('close', resolve)), output: '' };
      const capture = (chunk) => { runtime.output = (runtime.output + chunk.toString()).slice(-10000); };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      child.on('error', (error) => capture(error.message));
      return runtime;
    };
    const stopSoundBot = async (runtime) => {
      if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
        if (useCli && runtime.child.connected) {
          await new Promise((resolve, reject) => runtime.child.send('monky-e2e-stop', (error) => error ? reject(error) : resolve()));
        } else {
          runtime.child.kill();
        }
      }
      await runtime.exited;
      if (useCli) assert.equal(runtime.child.exitCode, 0, runtime.output);
    };
    const waitForSoundBot = async (runtime, previous = new Set(), botId = account.bot.id) => Promise.race([
      owner.wait((message) => !previous.has(message) && message.type === MessageType.COMMANDS_LIST_RESPONSE &&
        message.payload.commands?.some((command) => command.botId === botId &&
          command.name === 'query' && command.downloadsSound), 'sound bot command discovery', 15000),
      runtime.exited.then(() => { throw new Error(`Sound bot exited before discovery: ${runtime.output}`); }),
    ]);
    const waitForSoundManifest = async (runtime, manifestUrl) => {
      let timer;
      let onData;
      try {
        await Promise.race([
          new Promise((resolve, reject) => {
            onData = () => {
              if (runtime.output.includes(`Manifest: ${manifestUrl}`)) resolve();
            };
            timer = setTimeout(() => reject(new Error(`Sound bot manifest startup timed out: ${runtime.output}`)), 10000);
            runtime.child.stdout.on('data', onData);
            onData();
          }),
          runtime.exited.then(() => { throw new Error(`Sound bot exited before manifest startup: ${runtime.output}`); }),
        ]);
      } finally {
        clearTimeout(timer);
        runtime.child.stdout.off('data', onData);
      }
      const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200, runtime.output);
      const manifest = await response.json();
      assert.ok(manifest.commands.some((command) => command.name === 'query'));
      return manifest;
    };
    let runtime = startSoundBot();
    try {
      await waitForSoundBot(runtime);
      await new Promise((resolve) => setTimeout(resolve, LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS));
      const found = await owner.request(MessageType.COMMAND_AUTOCOMPLETE, {
        botId: account.bot.id, channelId, commandName: 'query', optionName: 'audio', query: 'brasil', locale: 'pt-BR',
      }, false, 20000);
      assert.equal(found.status, 'ok', runtime.output);
      assert.ok(found.choices.length > 0 && found.choices.length <= LIMITS.MAX_BOT_AUTOCOMPLETE_CHOICES);
      let selection = found.choices[0];
      if (found.hasMore) {
        await new Promise(resolve => setTimeout(resolve, LIMITS.BOT_AUTOCOMPLETE_THROTTLE_MS));
        const next = await owner.request(MessageType.COMMAND_AUTOCOMPLETE, {
          botId: account.bot.id, channelId, commandName: 'query', optionName: 'audio', query: 'brasil', locale: 'pt-BR',
          page: 1, ...(found.nextCursor !== undefined ? { cursor: found.nextCursor } : {}),
        }, false, 20000);
        assert.equal(next.status, 'ok', runtime.output);
        assert.ok(next.choices.length > 0 && next.choices.length <= LIMITS.MAX_BOT_AUTOCOMPLETE_CHOICES);
        assert.ok(new Set([...found.choices, ...next.choices].map(choice => choice.value)).size > found.choices.length);
        selection = next.choices.at(-1);
      }
      const invocation = await owner.request(MessageType.COMMAND_INVOKE, {
        botId: account.bot.id, channelId, commandName: 'query',
        options: { audio: selection.value }, locale: 'pt-BR', allowSoundDownload: true,
      });
      const request = await owner.wait((message) => message.type === MessageType.COMMAND_SOUND_DOWNLOAD &&
        message.payload.invocationId === invocation.invocationId, 'sound bot resolved metadata', 20000);
      assert.equal(request.payload.botId, account.bot.id);
      assert.equal(new URL(request.payload.url).protocol, 'https:');
      assert.ok(request.payload.fileName.length <= 128);
      assert.ok(request.payload.title.length > 0);
      assert.equal(otherDevice.messages.some((message) => message.type === MessageType.COMMAND_SOUND_DOWNLOAD &&
        message.payload.invocationId === invocation.invocationId), false);
      // This optional live-source check resolves metadata only; no third-party audio body is requested.
      await owner.request(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
        invocationId: invocation.invocationId, downloadId: request.payload.downloadId, result: { status: 'cancelled' },
      });
      await owner.finished(invocation.invocationId);
      assert.doesNotMatch(runtime.output, /MODULE_NOT_FOUND|Missing MONKY_/);
      assert.equal(runtime.output.includes(account.token), false, 'The runtime must not print its token.');
      if (useCli) {
        const publicKeyFile = path.join(workingDir, '.keys', 'public.hex');
        const publicKey = fs.readFileSync(publicKeyFile, 'utf8');
        await stopSoundBot(runtime);
        const previous = new Set(owner.messages);
        runtime = startSoundBot();
        await waitForSoundBot(runtime, previous);
        assert.equal(fs.readFileSync(publicKeyFile, 'utf8'), publicKey);
        console.log('Generated CLI foreground start, clean shutdown and restart preserve the bot identity.');

        await stopSoundBot(runtime);
        const manifestPort = await freePort();
        const manifestUrl = `http://127.0.0.1:${manifestPort}/manifest`;
        const setup = spawnSync(process.execPath, [launcher, 'setup', '--non-interactive',
          '--mode', 'marketplace', '--serve-port', String(manifestPort),
          '--public-host', '127.0.0.1', '--yes'], {
          cwd: workingDir, env, encoding: 'utf8', timeout: 15000,
        });
        if (setup.error) throw setup.error;
        assert.equal(setup.status, 0, setup.stderr);
        env.MONKY_SERVE_HOST = '127.0.0.1';
        runtime = startSoundBot();
        await waitForSoundManifest(runtime, manifestUrl);
        const beforeInstall = new Set(owner.messages);
        const installed = await installReviewedBot(owner, manifestUrl);
        await waitForSoundBot(runtime, beforeInstall, installed.bot.id);
        const registrationsFile = path.join(workingDir, '.keys', 'registrations.json');
        const registrations = JSON.parse(fs.readFileSync(registrationsFile, 'utf8'));
        assert.equal(registrations.publicKey, publicKey.trim());
        assert.equal(registrations.registrations.length, 1);
        for (const registration of registrations.registrations) {
          assert.equal(runtime.output.includes(registration.token), false, 'The runtime must not print a registration token.');
        }
        await stopSoundBot(runtime);
        const beforeRestart = new Set(owner.messages);
        runtime = startSoundBot();
        await waitForSoundManifest(runtime, manifestUrl);
        await waitForSoundBot(runtime, beforeRestart, installed.bot.id);
        assert.equal(fs.readFileSync(publicKeyFile, 'utf8'), publicKey);
        assert.deepEqual(JSON.parse(fs.readFileSync(registrationsFile, 'utf8')), registrations);
        assert.match(runtime.output, /Saved registrations: 1/);
        console.log('Generated CLI marketplace manifest installation and restart preserve authenticated registrations and identity.');
      }
      console.log('External sound bot runtime: packaged SDK, authentication, live search, selection and caller-only download request passed; no audio body requested.');
    } finally {
      await stopSoundBot(runtime);
    }
  }

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
    const officialAccount = marketplaceRestart ? null : await owner.request(MessageType.BOT_CREATE, {});
    let officialId = officialAccount?.bot.id;
    let officialOutput = '';
    const startOfficial = async () => {
      officialOutput = '';
      const child = spawn(process.execPath, ['--require', require.resolve('./fixtures/official-bot-music.cjs'), officialEntry], {
        cwd: workingDir,
        env: {
          ...process.env, NODE_PATH: '',
          MONKY_SERVE: String(marketplaceRestart),
          MONKY_SERVE_PORT: String(manifestPort), MONKY_SERVE_HOST: '127.0.0.1', MONKY_SERVE_PUBLIC_HOST: '127.0.0.1',
          MONKY_SERVER_URL: officialAccount ? url : '', MONKY_BOT_TOKEN: officialAccount?.token ?? '',
          MONKY_BOT_NAME: 'MonkyBot', MONKY_MUSIC_GRACE_SECONDS: '60',
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
      const installed = await installReviewedBot(owner, manifestUrl);
      officialId = installed.bot.id;
    }
    assert.ok(officialId);
    await owner.wait((message) => message.type === MessageType.COMMANDS_LIST_RESPONSE &&
      message.payload.commands?.some((command) => command.botId === officialId && command.name === 'enquete'), 'official command discovery');
    const registered = await owner.request(MessageType.COMMANDS_LIST, {});
    assert.deepEqual(
      registered.commands.filter((command) => command.botId === officialId).map((command) => command.name).sort(),
      [
        'ping', 'dado', 'moeda', '8ball', 'enquete', 'ajuda',
        'play', 'queue', 'pause', 'resume', 'skip', 'stop',
        'leave', 'nowplaying', 'remove', 'clear', 'jogo-da-velha',
      ].sort(),
      'The official bot must register utility, music, and programmable multiplayer commands.',
    );
    assert.equal(registered.commands.filter((command) => command.botId === officialId).length, 17);
    const initialMusicSettings = await owner.request(MessageType.BOT_SETTINGS_GET, { botId: officialId });
    assert.equal(initialMusicSettings.server.values.music_idle_seconds, 60);
    assert.equal(initialMusicSettings.definition.server.fields[0].name, 'music_idle_seconds');
    assert.equal(initialMusicSettings.definition.localizations['pt-BR'].server.fields.music_idle_seconds.label,
      'Tempo de inatividade (segundos)');
    const savedMusicSettings = await owner.request(MessageType.BOT_SETTINGS_UPDATE, {
      botId: officialId,
      schemaRevision: initialMusicSettings.bot.schemaRevision,
      expectedRevision: initialMusicSettings.bot.revision,
      patch: { music_idle_seconds: 2 },
    });
    assert.equal(savedMusicSettings.server.values.music_idle_seconds, 2);
    const playCommand = registered.commands.find((command) => command.botId === officialId && command.name === 'play');
    assert.ok(playCommand?.options?.some((option) => option.type === 'string' && option.autocomplete),
      'The official /play must use live autocomplete instead of a separate music /query command.');
    for (const name of ['play', 'queue', 'nowplaying', 'pause', 'resume', 'skip', 'stop', 'leave', 'remove', 'clear']) {
      assert.equal(registered.commands.find((command) => command.botId === officialId && command.name === name).voiceRequirement,
        'same-bot-channel');
    }
    assert.equal(registered.commands.find((command) => command.botId === officialId && command.name === 'jogo-da-velha').voiceRequirement,
      'joined');
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

    const musicRoom = (await owner.request(MessageType.CHANNEL_CREATE, { name: 'official-music', type: 'VOICE' })).channel.id;
    owner.voiceEnabled = true;
    await owner.request(MessageType.VOICE_JOIN, { channelId: musicRoom });
    const musicStart = owner.messages.length;
    for (const query of [
      'https://www.youtube.com/watch?v=e2eSilent00', 'https://www.youtube.com/watch?v=e2eFailure0',
      'https://www.youtube.com/watch?v=e2eRecover0',
      'https://www.youtube.com/watch?v=e2eSilent00',
    ]) {
      const invocation = await invokeOfficial(owner, 'play', { busca: query });
      const response = await owner.wait(message => message.type === MessageType.COMMAND_RESPONSE &&
        message.payload.invocationId === invocation.invocationId, 'official music accepted');
      assert.match(response.payload.content, /Added to queue/);
      await owner.finished(invocation.invocationId);
    }
    await owner.wait(message => owner.messages.indexOf(message) >= musicStart && message.type === 'VOICE_PACKET' &&
      message.payload.sessionId === `bot:${officialId}`, 'official bot sends real RTP');
    const completedMusic = await owner.wait(message => owner.messages.indexOf(message) >= musicStart &&
      message.type === MessageType.CHAT_MESSAGE && message.payload.userId === officialId &&
      /Queue finished/.test(message.payload.content), 'official queue completion in persistent chat', 15000);
    assert.equal(owner.messages.slice(musicStart).filter(message => message.type === MessageType.CHAT_MESSAGE &&
      message.payload.userId === officialId &&
      /Playback stopped|Skipping failed track|bot encountered an error/.test(message.payload.content)).length, 0,
    'A failed track followed by viable playback must not publish a fatal-looking shared error.');
    const exhaustedRecoveries = owner.messages.slice(musicStart).filter(message => message.type === MessageType.CHAT_MESSAGE &&
      message.payload.userId === officialId && /Could not resume.*after 5 consecutive attempts/.test(message.payload.content));
    assert.equal(exhaustedRecoveries.length, 1, 'Exhausted recovery must be announced once even when the next track plays.');
    assert.match(exhaustedRecoveries[0].payload.content, /track was removed from the queue/);
    assert.doesNotMatch(exhaustedRecoveries[0].payload.content, /googlevideo|byteOffset|secret|token/);
    const terminalInvocation = await invokeOfficial(owner, 'play', { busca: 'https://www.youtube.com/watch?v=e2eFailure0' });
    const terminalAccepted = await owner.wait(message => message.type === MessageType.COMMAND_RESPONSE &&
      message.payload.invocationId === terminalInvocation.invocationId, 'official terminal music accepted');
    assert.match(terminalAccepted.payload.content, /Added to queue/);
    await owner.finished(terminalInvocation.invocationId);
    const failedMusic = await owner.wait(message => owner.messages.indexOf(message) >= musicStart &&
      message.type === MessageType.CHAT_MESSAGE && message.payload.userId === officialId &&
      /Playback stopped/.test(message.payload.content), 'true playback stop in persistent chat');
    assert.match(failedMusic.payload.content, /Controlled mid-track failure/);
    assert.doesNotMatch(failedMusic.payload.content, /private\.example|secret|token/);
    const stoppedAt = Date.now();
    const musicHistory = await owner.request(MessageType.CHAT_LOAD_HISTORY, { channelId });
    assert.equal(musicHistory.messages.filter(message => message.id === failedMusic.payload.id).length, 1);
    assert.equal(musicHistory.messages.filter(message => message.id === completedMusic.payload.id).length, 1);
    assert.equal(musicHistory.messages.filter(message => message.id === exhaustedRecoveries[0].payload.id).length, 1);
    const recoveryText = /Trying to resume|finished after recovering|Tentando retomar|recuperar a conex/i;
    assert.equal(owner.messages.slice(musicStart).filter(message => message.type === MessageType.CHAT_MESSAGE &&
      message.payload.userId === officialId && recoveryText.test(message.payload.content)).length, 0,
    'Source interruptions and recovery must stay silent in the real chat path.');
    assert.equal(musicHistory.messages.filter(message => message.userId === officialId &&
      recoveryText.test(message.content)).length, 0, 'Recovery notices must not be persisted.');
    await owner.wait(message => owner.messages.indexOf(message) >= musicStart &&
      message.type === MessageType.VOICE_USER_LEFT && message.payload.sessionId === `bot:${officialId}`,
    'official bot leaves after the configured idle period');
    assert.ok(Date.now() - stoppedAt >= 1800, 'The stopping error must precede the configured idle departure.');
    assert.equal(owner.messages.slice(musicStart).filter(message => message.type === MessageType.CHAT_MESSAGE &&
      message.payload.userId === officialId && /Queue finished/.test(message.payload.content)).length, 1);
    assert.equal(owner.messages.slice(musicStart).filter(message => message.type === MessageType.CHAT_MESSAGE &&
      message.payload.userId === officialId && /Playback stopped/.test(message.payload.content)).length, 1);
    await owner.request(MessageType.VOICE_LEAVE, { channelId: musicRoom });
    await owner.closeVoice();
    console.log('Official music: real RTP, silent resumptions, one exhausted-recovery notice while continuing, stopping errors and persisted chat passed.');

    const spectator = new Peer(url);
    peers.push(spectator);
    const spectatorAuth = await spectator.authenticate('Spectator');
    const publicMusicSettings = await spectator.request(MessageType.BOT_SETTINGS_GET, { botId: officialId });
    assert.equal(publicMusicSettings.server, undefined);
    assert.equal(publicMusicSettings.definition.server, undefined);
    assert.equal(publicMusicSettings.definition.localizations?.['pt-BR']?.server, undefined);
    const gameRoom = (await owner.request(MessageType.CHANNEL_CREATE, {
      name: 'shared-game', type: 'VOICE',
    })).channel.id;
    const outsideGame = await spectator.request(MessageType.COMMAND_INVOKE, {
      botId: officialId, channelId, commandName: 'jogo-da-velha', options: {}, locale: 'en',
    }, true);
    assert.equal(outsideGame.code, 'BOT_VOICE_REQUIRED');
    for (const peer of [owner, bob, otherDevice, spectator]) await peer.request(MessageType.VOICE_JOIN, { channelId: gameRoom });
    const gameInvocation = await invokeOfficial(owner, 'jogo-da-velha');
    await owner.finished(gameInvocation.invocationId);
    const gameRevision = (peer, revision) => peer.wait((message) =>
      message.type === MessageType.BOT_SCREEN_SNAPSHOT && message.payload.id === gameInvocation.invocationId &&
      message.payload.revision === revision, `official game revision ${revision}`).then((message) => message.payload);
    const actInGame = (peer, action, payload, revision) => peer.request(MessageType.BOT_SCREEN_ACTION, {
      id: gameInvocation.invocationId, instanceId: initialGame.instanceId, action, payload, revision, actionId: randomUUID(),
    });
    const initialGame = await gameRevision(spectator, 0);
    assert.equal(initialGame.channelId, gameRoom);
    assert.deepEqual(initialGame.state.board, Array.from({ length: 9 }, () => null));
    assert.equal(initialGame.state.players[0].id, auth.currentUser.id);
    await actInGame(bob, 'join', { userId: auth.currentUser.id, userNickname: 'Forged' }, 0);
    const joinedGame = await gameRevision(owner, 1);
    assert.deepEqual(joinedGame.state.players.map((player) => player.id), [auth.currentUser.id, bobAuth.currentUser.id]);
    assert.equal(joinedGame.state.players[1].nickname, 'Bob');
    assert.equal(joinedGame.state.players.some((player) => player.id === spectatorAuth.currentUser.id), false);
    await actInGame(spectator, 'move', { position: 8, userId: auth.currentUser.id }, 1);
    await actInGame(bob, 'move', { position: 7 }, 1);
    await actInGame(otherDevice, 'move', { position: 0 }, 1);
    const firstMove = await gameRevision(spectator, 2);
    assert.deepEqual(firstMove.state.board, ['X', null, null, null, null, null, null, null, null],
      'Spectators and out-of-turn players cannot move; the real player may use another device.');
    let finalGame = firstMove;
    for (const [peer, position, revision, mark] of [
      [bob, 3, 2, 'O'], [owner, 1, 3, 'X'], [bob, 4, 4, 'O'], [owner, 2, 5, 'X'],
    ]) {
      await actInGame(peer, 'move', { position }, revision);
      finalGame = await gameRevision(spectator, revision + 1);
      assert.equal(finalGame.state.board[position], mark);
    }
    assert.equal(finalGame.state.winner, 'X');
    assert.deepEqual((await gameRevision(bob, 6)).state, finalGame.state);
    const deniedEnd = await bob.request(MessageType.BOT_SCREEN_END, {
      id: finalGame.id, instanceId: finalGame.instanceId,
    }, true);
    assert.equal(deniedEnd.code, 'PERMISSION_DENIED', 'Being a player does not grant permission to end someone else\'s miniapp.');
    for (const [endingPeer, endingUserId] of [[bob, bobAuth.currentUser.id], [owner, auth.currentUser.id]]) {
      const created = await invokeOfficial(bob, 'jogo-da-velha');
      await bob.finished(created.invocationId);
      const snapshot = await owner.wait((message) => message.type === MessageType.BOT_SCREEN_SNAPSHOT &&
        message.payload.id === created.invocationId, 'non-administrator creator miniapp');
      assert.equal(snapshot.payload.creatorUserId, bobAuth.currentUser.id);
      const ref = { id: snapshot.payload.id, instanceId: snapshot.payload.instanceId };
      const ended = await endingPeer.request(MessageType.BOT_SCREEN_END, ref);
      assert.deepEqual(ended, {
        ...ref, channelId: gameRoom, reason: 'ended', endedByUserId: endingUserId,
      });
      for (const peer of [owner, bob, spectator]) {
        await peer.wait((message) => message.type === MessageType.BOT_SCREEN_REMOVED &&
          message.payload.id === ref.id && message.payload.instanceId === ref.instanceId &&
          message.payload.reason === 'ended', 'creator/admin END delivered to every viewer');
      }
      const remaining = await owner.request(MessageType.BOT_SCREEN_LIST, { channelId: gameRoom });
      assert.equal(remaining.screens.some((screen) => screen.id === ref.id), false);
      assert.equal(remaining.screens.some((screen) => screen.instanceId === finalGame.instanceId), true,
        'Ending another miniapp must preserve the original game.');
    }
    await owner.request(MessageType.CHANNEL_DELETE, { channelId: gameRoom });
    for (const peer of [owner, bob, spectator]) {
      await peer.wait((message) => message.type === MessageType.BOT_SCREEN_REMOVED &&
        message.payload.id === gameInvocation.invocationId, 'official game removed after channel deletion');
    }
    spectator.ws.close();
    await once(spectator.ws, 'close');
    console.log('Official multiplayer game: authenticated players, spectator isolation, turns, synchronized win, creator/admin END and channel cleanup passed.');

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
    console.log('Official MonkyBot runtime: complete command catalog, required 8ball, immediate public poll, vote changes, distinct voters, final tally and bundled logo passed.');
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
      assert.equal((await owner.request(MessageType.BOT_SETTINGS_GET, { botId: officialId }))
        .server.values.music_idle_seconds, 2, 'Music settings survive official bot and server restarts.');
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
          const unrelated = await owner.request(MessageType.BOT_CREATE, {});
          const publisher = new BotClient({
            requestedCapabilities: [],
            serverUrl: url, token: unrelated.token, publicKey: identity().publicKey,
            name: 'Refreshed offline bot', autoReconnect: false,
          });
          const errors = [];
          publisher.on('error', (error) => errors.push(error));
          try {
            const connected = once(publisher, 'connected');
            publisher.connect();
            await connected;
          } finally {
            await publisher.close();
          }
          assert.deepEqual(errors, []);
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
  for (const peer of peers) {
    await peer.closeVoice();
    peer.ws.terminate();
  }
  if (monky) await monky.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
