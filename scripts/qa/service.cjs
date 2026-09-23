const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { generateKeyPairSync } = require('node:crypto');

const repo = path.resolve(__dirname, '..', '..');
const config = JSON.parse(process.env.MONKY_QA_SERVICE);
assert.ok(process.send && path.isAbsolute(config.root) && ['server', 'bot'].includes(config.role));
assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(path.join(config.root, config.role)));
const shared = require(path.join(repo, 'packages', 'shared', 'dist', 'index.js'));
let service, stopping, starting;

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startServer() {
  const { MonkyServer } = require(path.join(repo, 'apps', 'server', 'dist', 'server.js'));
  const port = await freePort();
  const server = await MonkyServer.create({
    port, dataDir: process.cwd(), password: config.password, serverName: `Monky QA ${config.scenario}`,
    voiceMode: 'p2p', initialTextChannel: 'qa-chat', initialVoiceChannel: 'QA Voice',
  });
  try {
    // Same instance-scoped network seam as the existing real-server E2E actor:
    // no auth/database methods are replaced and no normal server defaults change.
    assert.ok(server.httpServer instanceof http.Server);
    const listen = server.httpServer.listen;
    server.httpServer.listen = function(requestedPort, host, ...args) {
      assert.equal(requestedPort, port);
      assert.equal(host, '0.0.0.0');
      return Reflect.apply(listen, this, [port, '127.0.0.1', ...args]);
    };
    server.lanBroadcaster.start = async () => {};
    await server.start();
    assert.equal(server.httpServer.address().address, '127.0.0.1');
    return {
      ready: { port, name: `Monky QA ${config.scenario}`, protocol: shared.PROTOCOL_VERSION },
      snapshot: () => server.getStats(),
      close: () => server.stop(),
    };
  } catch (error) { await server.stop(); throw error; }
}

async function startBot() {
  const production = typeof config.botRoot === 'string';
  const fromBot = production ? createRequire(path.join(config.botRoot, 'package.json')) : require;
  const sdk = production ? fromBot('@monky/bot-sdk') : require(path.join(repo, 'packages', 'bot-sdk', 'dist', 'index.js'));
  assert.equal(sdk.PROTOCOL_VERSION, shared.PROTOCOL_VERSION, 'The production bot SDK must match this checkout protocol.');
  const definition = production ? fromBot(path.join(config.botRoot, 'dist', 'commands', 'index.js')) : undefined;
  if (production) {
    assert.equal(typeof definition.registerAllCommands, 'function', 'The checkout must export the real MonkyBot registerAllCommands.');
    assert.ok(shared.botCapabilitiesSchema.safeParse(definition.requestedCapabilities).success,
      'Production MonkyBot must export its actual requestedCapabilities alongside registerAllCommands; QA never invents a production declaration.');
  }
  const requestedCapabilities = shared.botCapabilitiesSchema.parse(production ? definition.requestedCapabilities :
    ['commands', 'local_execution', ...(config.scenario === 'voice' ? ['publish_voice'] :
      config.scenario === 'voice-receive' ? ['receive_voice'] : [])]);
  const key = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
  const bot = new sdk.BotClient({
    requestedCapabilities,
    publicKey: key, name: production ? 'MonkyBot QA production' : 'SDK QA fixture',
    registrationFile: path.join(process.cwd(), 'registrations.json'),
  });
  let disposeCommands, voice, voiceReader;
  let receivedPackets = 0;
  const connected = new Set();
  const close = async () => {
    try { if (disposeCommands) await disposeCommands(); }
    finally { await bot.close(); await voiceReader; }
  };
  const receive = connection => {
    receivedPackets = 0;
    voiceReader = (async () => {
      for await (const packet of connection.receiveAudio()) {
        assert.equal(packet.channelId, connection.channelId);
        assert.ok(packet.sessionId && packet.userId && packet.opus.length);
        receivedPackets++;
      }
    })().catch(error => { console.error('[QA voice receiver]', error); throw error; });
    void voiceReader.catch(() => {});
  };
  const approvedPermissions = async serverId => {
    const deadline = Date.now() + 20_000;
    while (!stopping && Date.now() < deadline) {
      const id = serverId ?? [...connected][0];
      const permissions = id && connected.has(id) ? bot.getPermissions(id) : undefined;
      if (permissions && !permissions.reviewRequired && permissions.reviewedBy &&
          permissions.granted.length === requestedCapabilities.length &&
          requestedCapabilities.every(capability => permissions.granted.includes(capability))) return permissions;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('The SDK did not observe the real server-approved bot capabilities on an authenticated connection.');
  };
  try {
    if (production) {
      disposeCommands = definition.registerAllCommands(bot);
    } else {
      bot.command({
        name: 'qa-ping', description: 'SDK QA fixture only; not production music.',
        handler: context => context.reply('SDK QA fixture: authenticated command completed.'),
      });
      bot.command({
        name: 'qa-local-consent', description: 'SDK fixture for the real local consent and tool setup dialog.',
        localCapabilities: ['youtube-audio'],
        handler: context => context.reply('SDK consent fixture only; no music provider is simulated.'),
      });
      if (config.scenario === 'voice-receive') bot.command({
        name: 'qa-listen', description: 'Toggle the SDK fixture microphone reception.',
        localizations: { 'pt-BR': { description: 'Alternar a escuta da fixture SDK.' } },
        voiceRequirement: 'same-bot-channel',
        handler: async context => {
          const current = bot.getVoiceConnection(context.serverId);
          if (current) {
            await current.setDeafened(current.isReceivingAudio);
            voice = current;
          } else {
            const channelId = await context.getVoiceChannel();
            if (!channelId) throw new Error('Join the isolated QA voice room first.');
            voice = await bot.joinVoice(context.serverId, channelId, {
              receiveAudio: true, invocationId: context.invocationId,
            });
            receive(voice);
          }
          context.reply(context.locale === 'en'
            ? `Listening: ${voice.isReceivingAudio ? 'on' : 'off'}. Packets received: ${receivedPackets}. No recording.`
            : `Escuta: ${voice.isReceivingAudio ? 'ligada' : 'desligada'}. Pacotes recebidos: ${receivedPackets}. Sem gravação.`);
        },
      });
    }
    bot.on('connected', info => connected.add(info.serverId));
    bot.on('disconnected', info => connected.delete(info.serverId));
    bot.on('error', error => {
      // Command errors may be the test target. Auth/catalog/voice readiness is checked separately.
      console.error('[QA bot]', error.message);
    });
    const server = await bot.serve({
      name: production ? 'MonkyBot QA production' : 'SDK QA fixture',
      description: production ? 'Explicit production checkout; isolated QA state.' : 'Labeled SDK fixture, not MonkyBot music.',
      port: 0, host: '127.0.0.1', publicHost: '127.0.0.1',
    });
    assert.equal(server.address().address, '127.0.0.1');
    return {
      ready: { manifestUrl: `http://127.0.0.1:${server.address().port}/manifest`, kind: production ? 'production' : 'sdk-fixture' },
      async snapshot() {
        const permissions = config.scenario === 'bot-install' ? null : await approvedPermissions();
        return { connected: [...connected], permissions, voice: !!voice && !voice.isClosed,
          humanPeers: voice?.humanParticipantCount ?? 0, receiving: voice?.isReceivingAudio ?? false, receivedPackets };
      },
      async joinVoice(value) {
        assert.ok(value && typeof value.serverId === 'string' && typeof value.channelId === 'string');
        await approvedPermissions(value.serverId);
        assert.ok(connected.has(value.serverId), 'The bot has not authenticated with this QA server.');
        voice = await bot.joinVoice(value.serverId, value.channelId, config.scenario === 'voice-receive' ? { receiveAudio: true } : {});
        assert.ok(!voice.isClosed && voice.humanParticipantCount > 0);
        if (config.scenario === 'voice-receive') receive(voice);
        else if (!production) await voice.writeOpus(Uint8Array.from([0xf8, 0xff, 0xfe]));
        return { joined: true };
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}

const stop = () => stopping ??= (async () => {
  await starting?.catch(() => {});
  if (service) await service.close();
  process.send?.({ type: 'qa-closed' });
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
process.once('disconnect', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
process.on('message', message => {
  if (!message || message.runId !== config.runId) return;
  if (message.type === 'qa-stop') { void stop(); return; }
  void (async () => {
    let value;
    if (message.type === 'qa-ping') value = { alive: !!service && !stopping };
    else if (message.type === 'qa-snapshot' && service) value = await service.snapshot();
    else if (message.type === 'qa-join-voice' && service?.joinVoice) value = await service.joinVoice(message.value);
    else throw new Error('Unsupported QA service request.');
    process.send?.({ type: 'qa-response', id: message.id, value });
  })().catch(error => process.send?.({ type: 'qa-response', id: message.id, error: error.message }));
});
starting = (async () => {
  service = await (config.role === 'server' ? startServer() : startBot());
  if (stopping) return;
  process.send?.({ type: 'qa-service-ready', value: service.ready });
})().catch(async error => {
  process.send?.({ type: 'qa-failed', error: error.message });
  if (service) await service.close();
  process.exit(1);
});
