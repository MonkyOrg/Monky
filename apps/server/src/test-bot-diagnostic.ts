import assert from 'node:assert/strict';
import { sign, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test, { type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import {
  BOT_REACHABILITY_PATH,
  MessageType,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  botReachabilityChallenge,
  createProtocolOffer,
} from '@monky/shared';
import { BotDiagnosticService, type BotDiagnosticOutcome } from './application/services/BotDiagnosticService';
import {
  isProbePortAllowed,
  isPublicUnicastAddress,
  normalizeIpAddress,
  probeBotReachability,
} from './infrastructure/network/ReachabilityProber';
import { RateLimiter } from './infrastructure/security/RateLimiter';
import { createApprovedBotFixture as createFixture, identity, record, records, text } from './testFixtures/bots';

type Responder = (request: http.IncomingMessage, response: http.ServerResponse) => void;

async function listen(t: TestContext, handler: Responder): Promise<number> {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

function signingResponder(privateKey: KeyObject, calls: string[] = []): Responder {
  return (request, response) => {
    calls.push(request.url ?? '');
    const url = new URL(request.url ?? '/', 'http://bot.invalid');
    if (url.pathname !== BOT_REACHABILITY_PATH) {
      response.writeHead(404);
      response.end();
      return;
    }
    const nonce = url.searchParams.get('nonce') ?? '';
    const signature = sign(null, Buffer.from(botReachabilityChallenge(nonce), 'utf8'), privateKey).toString('hex');
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ signature }));
  };
}

async function closedPort(): Promise<number> {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test('only public unicast addresses or the requester itself may be probed', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '[2001:4860:4860::8888]']) {
    assert.equal(isPublicUnicastAddress(address), true, address);
  }
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.4', '192.168.1.1', '192.0.2.10',
    '198.18.0.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'fe80::1',
    'fc00::1', 'fd12:3456::1', '2001:db8::1', '2002:7f00:1::1', '64:ff9b::7f00:1', 'ff02::1', 'localhost', 'not-an-ip',
  ]) {
    assert.equal(isPublicUnicastAddress(address), false, address);
  }
  assert.equal(normalizeIpAddress('::FFFF:203.0.113.9'), '203.0.113.9');
  for (const port of [80, 443, 1024, 7780, 65535]) assert.equal(isProbePortAllowed(port), true, String(port));
  for (const port of [0, 22, 25, 53, 110, 1023, 65536]) assert.equal(isProbePortAllowed(port), false, String(port));
});

test('a port is verified only by a fresh signature from the expected bot key', async (t) => {
  const bot = identity();
  const other = identity();
  const calls: string[] = [];
  const port = await listen(t, signingResponder(bot.privateKey, calls));
  const origin = `http://127.0.0.1:${port}`;
  assert.deepEqual(await probeBotReachability(origin, { requesterIp: '127.0.0.1', publicKeyHex: bot.publicKey }), { status: 'verified' });
  assert.deepEqual(await probeBotReachability(origin, { requesterIp: '::ffff:127.0.0.1', publicKeyHex: bot.publicKey }), { status: 'verified' });
  assert.deepEqual(await probeBotReachability(origin, { requesterIp: '127.0.0.1', publicKeyHex: other.publicKey }), { status: 'unverified' });
  assert.equal(new Set(calls).size, calls.length, 'every probe uses a new challenge');
  assert.ok(calls.every((call) => /^\/\.well-known\/monky-bot-reachability\?nonce=[0-9a-f]{64}$/.test(call)));

  const echo = await listen(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ signature: new URL(request.url ?? '/', 'http://x').searchParams.get('nonce')?.repeat(2) }));
  });
  const redirect = await listen(t, (_request, response) => {
    response.writeHead(302, { Location: origin + BOT_REACHABILITY_PATH });
    response.end();
  });
  const large = await listen(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(' '.repeat(4096));
  });
  for (const target of [echo, redirect, large, await closedPort()]) {
    assert.deepEqual(await probeBotReachability(`http://127.0.0.1:${target}`, {
      requesterIp: '127.0.0.1', publicKeyHex: bot.publicKey, timeoutMs: 1_000,
    }), { status: 'unverified' });
  }
});

test('targets outside the policy are never dialed', async (t) => {
  const bot = identity();
  const calls: string[] = [];
  const port = await listen(t, signingResponder(bot.privateKey, calls));
  const options = { requesterIp: '203.0.113.9', publicKeyHex: bot.publicKey };
  assert.deepEqual(await probeBotReachability(`http://127.0.0.1:${port}`, options), { status: 'skipped', reason: 'address_not_allowed' });
  assert.deepEqual(await probeBotReachability('http://127.0.0.1:22', { ...options, requesterIp: '127.0.0.1' }),
    { status: 'skipped', reason: 'port_not_allowed' });
  assert.deepEqual(await probeBotReachability(`http://bot.example.test:${port}`, {
    ...options, lookup: async () => ['10.0.0.5', '169.254.169.254'],
  }), { status: 'skipped', reason: 'address_not_allowed' });
  assert.deepEqual(await probeBotReachability('http://user:pass@bot.example.test:7780', options),
    { status: 'skipped', reason: 'address_not_allowed' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await probeBotReachability(`http://bot.example.test:${port}`, {
    requesterIp: '127.0.0.1', publicKeyHex: bot.publicKey, lookup: async () => ['127.0.0.1'],
  }), { status: 'verified' });
  assert.equal(calls.length, 1, 'a resolved name is dialed through the pinned address');
});

function fakeBots(state: 'valid' | 'pending_binding' | 'invalid' | 'key_mismatch' = 'valid') {
  return {
    inspectCredential: async () => state === 'valid' || state === 'pending_binding'
      ? { state, botId: 'bot-1', verifyKey: 'ab'.repeat(44) } : { state },
    serverName: async () => 'Fixture server',
  };
}

const request = (targets: { id: string; origin: string }[] = [{ id: 'manifest', origin: 'http://203.0.113.9:7780' }]) => ({
  protocolVersion: PROTOCOL_VERSION, protocolOffer: createProtocolOffer('bot'), botToken: 'token', publicKey: 'ab'.repeat(44), targets,
});

test('diagnostic answers arrive in a fixed window and never reveal why a probe failed', async (t) => {
  const limiter = new RateLimiter();
  t.after(() => limiter.dispose());
  const service = new BotDiagnosticService(fakeBots(), limiter, {
    responseWindowMs: 300,
    probe: async (origin) => origin.endsWith(':7780') ? { status: 'verified' } : { status: 'unverified' },
  });
  const started = Date.now();
  const outcome = await service.diagnose(request([
    { id: 'manifest', origin: 'http://203.0.113.9:7780' }, { id: 'games', origin: 'http://203.0.113.9:7781' },
  ]), '198.51.100.1');
  assert.ok(Date.now() - started >= 290, 'fast failures wait for the same window as slow probes');
  assert.equal(outcome.kind, 'result');
  assert.ok(outcome.kind === 'result');
  assert.equal(outcome.result.credential, 'valid');
  assert.equal(outcome.result.serverName, 'Fixture server');
  assert.deepEqual(outcome.result.protocol?.version, PROTOCOL_VERSION);
  assert.deepEqual(outcome.result.reachability, [{ id: 'manifest', status: 'verified' }, { id: 'games', status: 'unverified' }]);
  assert.deepEqual((await service.diagnose({ ...request(), targets: 'all' }, '198.51.100.1')).kind, 'invalid');
});

test('invalid credentials never probe and spend the shared authentication quota', async (t) => {
  const limiter = new RateLimiter();
  t.after(() => limiter.dispose());
  let probes = 0;
  const service = new BotDiagnosticService(fakeBots('invalid'), limiter, {
    responseWindowMs: 0, probe: async () => { probes++; return { status: 'verified' }; },
  });
  const first = await service.diagnose(request(), '198.51.100.2');
  assert.ok(first.kind === 'result');
  assert.deepEqual(first.result.reachability, [{ id: 'manifest', status: 'skipped', reason: 'credential' }]);
  assert.equal(first.result.serverName, undefined, 'an invalid token learns nothing about the server');
  let outcome: BotDiagnosticOutcome = first;
  for (let attempt = 0; attempt < 20 && outcome.kind !== 'rate_limited'; attempt++) {
    outcome = await service.diagnose(request(), '198.51.100.2');
  }
  assert.equal(outcome.kind, 'rate_limited');
  assert.equal(probes, 0);
});

test('each bot is rate limited and the server bounds concurrent probing', async (t) => {
  const limiter = new RateLimiter();
  t.after(() => limiter.dispose());
  const limited = new BotDiagnosticService(fakeBots(), limiter, {
    responseWindowMs: 0, perMinute: 1, probe: async () => ({ status: 'verified' }),
  });
  assert.deepEqual((await limited.diagnose(request(), '198.51.100.3')).kind, 'result');
  const second = await limited.diagnose(request(), '198.51.100.3');
  assert.ok(second.kind === 'result');
  assert.deepEqual(second.result.reachability, [{ id: 'manifest', status: 'skipped', reason: 'rate_limited' }]);
  const noTargets = await limited.diagnose(request([]), '198.51.100.3');
  assert.ok(noTargets.kind === 'result', 'credential checks without targets are not throttled by the probe limit');

  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const busyLimiter = new RateLimiter();
  t.after(() => busyLimiter.dispose());
  const busy = new BotDiagnosticService(fakeBots(), busyLimiter, {
    responseWindowMs: 0, maxConcurrent: 1, perMinute: 10, probe: async () => { await blocked; return { status: 'verified' }; },
  });
  const pending = busy.diagnose(request(), '198.51.100.4');
  await new Promise((resolve) => setImmediate(resolve));
  const rejected = await busy.diagnose(request(), '198.51.100.5');
  assert.ok(rejected.kind === 'result');
  assert.deepEqual(rejected.result.reachability, [{ id: 'manifest', status: 'skipped', reason: 'busy' }]);
  release();
  assert.equal((await pending).kind, 'result');
});

test('the pre-auth diagnostic checks the link without binding a key or replacing the running bot', { timeout: 30000 }, async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const owner = await fixture.human('Owner');
  const created = await fixture.botService.create(owner.id);
  assert.ok(created.success);
  const keys = identity();
  const diagnose = async (token: string, publicKey: string, targets: { id: string; origin: string }[] = []) => {
    // A dedicated socket with a longer wait than Peer: probes answer after the fixed response window.
    const socket = new WebSocket(fixture.url);
    await once(socket, 'open');
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for the diagnostic.')), 15_000);
      socket.on('message', (data) => {
        const message = record(JSON.parse(data.toString()));
        if (message.requestId !== 'diagnostic') return;
        clearTimeout(timer);
        resolve(message);
      });
    });
    socket.send(JSON.stringify({ type: MessageType.BOT_DIAGNOSTIC, requestId: 'diagnostic', payload: {
      protocolVersion: PROTOCOL_VERSION, protocolOffer: createProtocolOffer('bot'), botToken: token, publicKey, targets,
    } }));
    try {
      const message = await response;
      return { type: message.type, payload: record(message.payload) };
    } finally {
      socket.terminate();
    }
  };

  const pending = await diagnose(created.token, keys.publicKey);
  assert.equal(pending.type, MessageType.BOT_DIAGNOSTIC_RESULT);
  assert.equal(pending.payload.credential, 'pending_binding');
  assert.equal(pending.payload.serverName, 'Bot tests');
  assert.equal((await fixture.botRepo.findById(created.bot.id))?.boundPublicKey, null, 'diagnostics never bind TOFU');

  const running = await fixture.bot(created.token, keys);
  const port = await listen(t, signingResponder(keys.privateKey));
  const valid = await diagnose(created.token, keys.publicKey, [{ id: 'manifest', origin: `http://127.0.0.1:${port}` }]);
  assert.equal(valid.payload.credential, 'valid');
  assert.equal(record(valid.payload.protocol).version, PROTOCOL_VERSION);
  assert.deepEqual(records(valid.payload.reachability), [{ id: 'manifest', status: 'verified' }]);
  assert.equal(running.peer.ws.readyState, WebSocket.OPEN, 'the running bot session survives');
  await running.peer.barrier();

  assert.equal((await diagnose(created.token, identity().publicKey)).payload.credential, 'key_mismatch');
  assert.equal(text((await diagnose('not-a-real-token', keys.publicKey)).payload.credential), 'invalid');

  const authenticated = await running.peer.request(MessageType.BOT_DIAGNOSTIC, {
    protocolVersion: PROTOCOL_VERSION, botToken: created.token, publicKey: keys.publicKey, targets: [],
  });
  assert.equal(authenticated.type, MessageType.SERVER_ERROR);
  assert.equal(authenticated.payload.code, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal(running.peer.ws.readyState, WebSocket.OPEN);
});
