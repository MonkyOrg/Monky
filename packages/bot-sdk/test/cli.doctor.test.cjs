const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const zlib = require('node:zlib');
const { once } = require('node:events');
const { test } = require('node:test');
const { WebSocketServer } = require('ws');

const { runBotCli } = require('../dist/cli');
const cliConfig = require('../dist/cli/config');
const consent = require('../dist/cli/consent');
const keys = require('../dist/cli/keys');
const pm2 = require('../dist/cli/pm2');
const readiness = require('../dist/cli/manifestReadiness');
const environment = require('../dist/cli/profileEnvironment');
const serverDiagnostic = require('../dist/cli/serverDiagnostic');
const reachability = require('../dist/reachability');
const updates = require('../dist/cli/commands/update');
const releases = require('../dist/cli/updateReleases');
const toolingProcess = require('../dist/tooling/process');
const { BotClient } = require('../dist');

const GAMES = {
  id: 'games',
  description: { 'pt-BR': 'Jogos multiplayer', en: 'Multiplayer games' },
  portEnv: 'FIXTURE_GAMES_PORT',
  defaultPort: 7781,
  publicUrlEnv: 'FIXTURE_GAMES_PUBLIC_URL',
  when: 'on-demand',
};
const API_KEY = { env: 'FIXTURE_API_KEY', description: { 'pt-BR': 'Chave da API', en: 'API key' }, required: true, secret: true };

function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function fixture(t, monkyBot = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '.monky-sdk-cli-doctor-'));
  const bot = path.join(root, 'bot');
  json(path.join(bot, 'package.json'), {
    name: '@example/sound-bot', version: '1.2.3', type: 'commonjs',
    monkyBot: {
      cliName: 'sound-bot', displayName: 'Sound Bot', entry: 'dist/index.js', modes: ['manual', 'marketplace'],
      requirements: { ports: [GAMES], settings: [API_KEY] }, ...monkyBot,
    },
  });
  fs.mkdirSync(path.join(bot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(bot, 'dist', 'index.js'), 'module.exports = {};');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { root, bot, state: path.join(root, 'state') };
}

function withEnv(t, updates) {
  const previous = {};
  for (const [key, value] of Object.entries({
    MONKY_SERVE_HOST: undefined, MONKY_BOT_LOCALE: 'pt-BR', MONKY_HOST_CONSENT: undefined,
    FIXTURE_API_KEY: undefined, FIXTURE_GAMES_PORT: undefined, FIXTURE_GAMES_PUBLIC_URL: undefined, ...updates,
  })) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function captureLogs(t) {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
  return lines;
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

test('consent is required for new profiles, bound to the declared access and directory, and inherited by older profiles', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const lines = captureLogs(t);
  await runBotCli(f.bot, ['setup', '--non-interactive', '--mode', 'manual', '--server-url', 'localhost:3000', '--token-env', 'BOT_TOKEN']);
  const context = cliConfig.createCliContext(f.bot);
  const fingerprint = consent.hostConsentFingerprint(context.project.definition);
  assert.match(fingerprint, /^[0-9a-f]{12}$/);
  assert.equal(consent.readHostConsent(context.homeDir).state, 'pending');
  assert.match(lines.join('\n'), new RegExp(`MONKY_HOST_CONSENT=${fingerprint}`));
  assert.match(lines.join('\n'), /games: TCP 7781/);
  t.mock.method(pm2, 'ensurePm2ForStart', () => assert.fail('a start without consent must not reach PM2'));
  await assert.rejects(runBotCli(f.bot, ['start']), /ainda não foi confirmado/);
  await assert.rejects(runBotCli(f.bot, ['consent', '--accept', '000000000000']), /não corresponde/);
  process.env.MONKY_HOST_CONSENT = '000000000000';
  assert.throws(() => consent.assertHostConsent(context.homeDir, cliConfig.readConfig(context).botDir, context.project.definition, 'sound-bot'),
    /MONKY_HOST_CONSENT=/);
  process.env.MONKY_HOST_CONSENT = fingerprint;
  assert.equal(consent.assertHostConsent(context.homeDir, cliConfig.readConfig(context).botDir, context.project.definition, 'sound-bot').state,
    'environment');
  delete process.env.MONKY_HOST_CONSENT;
  await runBotCli(f.bot, ['consent', '--accept', fingerprint]);
  const config = cliConfig.readConfig(context);
  assert.equal(consent.hostConsentStatus(context.homeDir, config.botDir, fingerprint).state, 'accepted');
  assert.equal(consent.hostConsentStatus(context.homeDir, path.join(f.root, 'elsewhere'), fingerprint).state, 'other-directory');
  const changed = { ...context.project.definition, requirements: { ...context.project.definition.requirements, ports: [] } };
  assert.equal(consent.hostConsentStatus(context.homeDir, config.botDir, consent.hostConsentFingerprint(changed)).state, 'outdated');
  await runBotCli(f.bot, ['consent', '--revoke']);
  assert.equal(consent.readHostConsent(context.homeDir).state, 'pending');

  fs.rmSync(path.join(context.homeDir, consent.HOST_CONSENT_FILE));
  const legacy = consent.assertHostConsent(context.homeDir, config.botDir, context.project.definition, 'sound-bot');
  assert.equal(legacy.state, 'legacy');
  assert.equal(consent.readHostConsent(context.homeDir).state, 'inherited', 'a pre-consent profile keeps running');
  assert.match(consent.hostAccessNotice('en', 'Sound Bot', config.botDir, context.project.definition, context.pm2Home),
    /does not create a sandbox[\s\S]*games: TCP 7781[\s\S]*FIXTURE_API_KEY \(secret\)/);
});

test('fingerprints follow the normalized declaration so packaged candidates compare equal', (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot, { MONKY_BOT_CLI_HOME: f.state });
  const raw = JSON.parse(fs.readFileSync(path.join(f.bot, 'package.json'), 'utf8')).monkyBot;
  assert.equal(consent.candidateHostConsent(raw).fingerprint, consent.hostConsentFingerprint(context.project.definition));
  const unknown = consent.candidateHostConsent({ ...raw, requirements: { ports: [{ ...GAMES, future: true }] } });
  assert.equal(unknown.definition, undefined);
  assert.notEqual(unknown.fingerprint, consent.hostConsentFingerprint(context.project.definition));
  assert.equal(consent.candidateHostConsent({ cliName: 'x' }).fingerprint,
    consent.hostConsentFingerprint({ modes: ['manual'] }));
});

test('declared variables are saved privately, validated, and the environment always wins', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state, FIXTURE_FROM_SHELL: 'shell-secret-value' });
  const lines = captureLogs(t);
  const context = cliConfig.createCliContext(f.bot);
  await assert.rejects(runBotCli(f.bot, ['config', 'env', 'set', 'FIXTURE_API_KEY', 'visible-secret']), /segredo/);
  await assert.rejects(runBotCli(f.bot, ['config', 'env', 'set', 'UNDECLARED', 'value']), /não é uma variável declarada/);
  await assert.rejects(runBotCli(f.bot, ['config', 'env', 'set', 'FIXTURE_GAMES_PORT', '70000']), /entre 1 e 65535/);
  await assert.rejects(runBotCli(f.bot, ['config', 'env', 'set', 'FIXTURE_GAMES_PUBLIC_URL', 'https://games.example.test/play']), /sem credenciais, caminho/);
  await runBotCli(f.bot, ['config', 'env', 'set', 'FIXTURE_API_KEY', '--from-env', 'FIXTURE_FROM_SHELL']);
  await runBotCli(f.bot, ['config', 'env', 'set', 'FIXTURE_GAMES_PUBLIC_URL', 'https://Games.Example.test/']);
  const saved = environment.readProfileEnvironment(context.homeDir);
  assert.deepEqual(saved, { FIXTURE_API_KEY: 'shell-secret-value', FIXTURE_GAMES_PUBLIC_URL: 'https://games.example.test' });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(environment.profileEnvironmentFile(context.homeDir)).mode & 0o777, 0o600);
  }
  await runBotCli(f.bot, ['config', 'env']);
  assert.equal(lines.join('\n').includes('shell-secret-value'), false, 'secrets are never printed');

  const requirements = context.project.definition.requirements;
  assert.deepEqual(environment.profileRuntimeValues(requirements, saved, {}), saved);
  assert.deepEqual(environment.profileRuntimeValues(requirements, saved, { FIXTURE_API_KEY: 'from-service' }),
    { FIXTURE_GAMES_PUBLIC_URL: 'https://games.example.test' });
  const resolved = environment.resolveDeclaredVariables(requirements, saved, { FIXTURE_API_KEY: 'from-service' });
  const apiKey = resolved.find((entry) => entry.variable.name === 'FIXTURE_API_KEY');
  assert.equal(apiKey.source, 'environment');
  assert.equal(apiKey.overridesProfile, true);
  assert.equal(resolved.find((entry) => entry.variable.name === 'FIXTURE_GAMES_PORT').source, 'default');

  const restart = environment.updateRestartEnvironment(requirements,
    { FIXTURE_API_KEY: 'stale-updater-copy', FIXTURE_GAMES_PORT: '9999', PATH: 'kept' },
    { FIXTURE_API_KEY: 'running-value', UNRELATED_SECRET: 'never-copied' });
  assert.deepEqual(restart, { FIXTURE_API_KEY: 'running-value', PATH: 'kept' });

  await runBotCli(f.bot, ['config', 'env', 'unset', 'FIXTURE_API_KEY']);
  assert.deepEqual(environment.readProfileEnvironment(context.homeDir), { FIXTURE_GAMES_PUBLIC_URL: 'https://games.example.test' });
});

test('the runner injects saved variables only where the environment is silent and registers the probe identity', async (t) => {
  const f = fixture(t);
  withEnv(t, {
    MONKY_BOT_CLI_HOME: f.state, OUTPUT_FILE: path.join(f.root, 'runner.json'), FIXTURE_GAMES_PORT: '7799',
    MONKY_BOT_PUBLIC_KEY: undefined, MONKY_BOT_NAME: undefined, MONKY_SERVER_URL: undefined, MONKY_BOT_TOKEN: undefined,
  });
  const context = cliConfig.createCliContext(f.bot);
  const botDir = path.join(context.homeDir, 'runtime');
  cliConfig.writeConfig(context, cliConfig.manualConfig(context, { botDir, serverUrl: 'ws://runner.example.test', botToken: 'token' }));
  environment.writeProfileEnvironment(context.homeDir, { FIXTURE_API_KEY: 'saved-key', FIXTURE_GAMES_PORT: '7000' });
  const identity = keys.loadOrCreateBotKeys(botDir);
  consent.writeHostConsent(context.homeDir, 'accepted', consent.hostConsentFingerprint(context.project.definition), botDir);
  const entry = path.join(f.bot, 'dist', 'index.js');
  fs.writeFileSync(entry, `
const { runtimeBotIdentity } = require(${JSON.stringify(require.resolve('../dist/reachability'))});
require('node:fs').writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({
  key: process.env.FIXTURE_API_KEY, port: process.env.FIXTURE_GAMES_PORT, identity: runtimeBotIdentity()?.publicKeyHex,
}));`);
  const cwd = process.cwd();
  try {
    await require('../dist/cli/runner').runConfiguredBot({
      ...process.env, MONKY_BOT_CLI_CONFIG_FILE: context.configFile, MONKY_BOT_CLI_ENTRY: entry, MONKY_BOT_CLI_PACKAGE_ROOT: f.bot,
    });
  } finally {
    process.chdir(cwd);
    reachability.setRuntimeBotIdentity(undefined);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.OUTPUT_FILE, 'utf8')),
    { key: 'saved-key', port: '7799', identity: identity.publicKeyHex.toLowerCase() });

  consent.writeHostConsent(context.homeDir, 'pending', consent.hostConsentFingerprint(context.project.definition), botDir);
  await assert.rejects(require('../dist/cli/runner').runConfiguredBot({
    ...process.env, MONKY_BOT_CLI_CONFIG_FILE: context.configFile, MONKY_BOT_CLI_ENTRY: entry, MONKY_BOT_CLI_PACKAGE_ROOT: f.bot,
  }), /consent/i);
});

test('the SDK manifest server proves its identity and custom listeners can forward the challenge', async (t) => {
  const f = fixture(t);
  const pair = keys.loadOrCreateBotKeys(path.join(f.root, 'identity'));
  const other = keys.loadOrCreateBotKeys(path.join(f.root, 'other'));
  reachability.setRuntimeBotIdentity(reachability.createReachabilityIdentity(pair.publicKeyHex, pair.privateKeyPem));
  t.after(() => reachability.setRuntimeBotIdentity(undefined));
  assert.throws(() => reachability.createReachabilityIdentity(other.publicKeyHex, pair.privateKeyPem), /does not match/);

  const client = new BotClient({ publicKey: pair.publicKeyHex, requestedCapabilities: [] });
  t.after(() => client.close());
  const server = await client.serve({ name: 'Sound Bot', port: 0, host: '127.0.0.1', publicHost: 'bot.example.test' });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  assert.equal(await reachability.probeReachability(origin, pair.publicKeyHex), 'verified');
  assert.equal(await reachability.probeReachability(origin, other.publicKeyHex), 'unverified');
  const manifest = await fetch(`${origin}/manifest`);
  assert.equal(manifest.headers.get('x-monky-bot-public-key'), pair.publicKeyHex.toLowerCase());
  assert.equal((await fetch(`${origin}/.well-known/monky-bot-reachability?nonce=bad`)).status, 400);

  const custom = http.createServer((request, response) => {
    if (reachability.handleReachabilityProbe(request, response)) return;
    response.writeHead(204);
    response.end();
  });
  custom.listen(0, '127.0.0.1');
  await once(custom, 'listening');
  t.after(() => closeServer(custom));
  assert.equal(await reachability.probeReachability(`http://127.0.0.1:${custom.address().port}`, pair.publicKeyHex), 'verified');
  assert.equal((await fetch(`http://127.0.0.1:${custom.address().port}/other`)).status, 204);
  reachability.setRuntimeBotIdentity(undefined);
  assert.equal(await reachability.probeReachability(`http://127.0.0.1:${custom.address().port}`, pair.publicKeyHex), 'unverified');
});

test('readiness accepts only a valid manifest served by this bot for the configured address', async (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot, { MONKY_BOT_CLI_HOME: f.state });
  const pair = keys.loadOrCreateBotKeys(path.join(f.root, 'identity'));
  let behavior = 'valid';
  const server = http.createServer((_request, response) => {
    const port = server.address().port;
    const headers = { 'Content-Type': 'application/json', 'X-Monky-Bot-Public-Key': behavior === 'other-key' ? 'ab'.repeat(44) : pair.publicKeyHex };
    response.writeHead(200, headers);
    response.end(JSON.stringify({
      requestedCapabilities: [], name: behavior === 'renamed' ? 'Other Name' : 'Sound Bot',
      registrationUrl: `http://${behavior === 'wrong-host' ? 'other.example.test' : 'bot.example.test'}:${port}/register`,
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => closeServer(server));
  const config = cliConfig.marketplaceConfig(context, { botName: 'Sound Bot', servePort: server.address().port, publicHost: 'bot.example.test' });
  assert.deepEqual(await readiness.verifyManifest(config, pair.publicKeyHex, '0.0.0.0', 'en'),
    { url: `http://bot.example.test:${config.servePort}/manifest`, nameMatches: true });
  behavior = 'renamed';
  assert.equal((await readiness.verifyManifest(config, pair.publicKeyHex, '0.0.0.0', 'en')).nameMatches, false);
  behavior = 'other-key';
  await assert.rejects(readiness.verifyManifest(config, pair.publicKeyHex, '0.0.0.0', 'en'), /another bot identity/);
  behavior = 'wrong-host';
  await assert.rejects(readiness.verifyManifest(config, pair.publicKeyHex, '0.0.0.0', 'en'), /registration URL/);
  const closed = cliConfig.marketplaceConfig(context, { servePort: await freePort(), publicHost: 'bot.example.test' });
  await assert.rejects(readiness.waitForManifest(closed, pair.publicKeyHex, '0.0.0.0', 'en', 'sound-bot', 400), /did not become ready/);
});

async function fakeMonkyServer(t, respond) {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const requests = [];
  wss.on('connection', (socket) => socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    requests.push(message);
    socket.send(JSON.stringify(respond(message)));
  }));
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await closeServer(httpServer);
  });
  return { url: `ws://127.0.0.1:${httpServer.address().port}`, requests };
}

test('server diagnostics distinguish results, old servers and rate limits without opening a bot session', async (t) => {
  const result = { serverProtocolVersion: 37, protocol: { version: 37, minimumVersion: 24, features: [] }, credential: 'valid', reachability: [] };
  const modern = await fakeMonkyServer(t, (message) => ({ type: 'BOT_DIAGNOSTIC_RESULT', requestId: message.requestId, payload: result }));
  const request = { protocolVersion: 37, botToken: 'token', publicKey: 'ab'.repeat(44), targets: [] };
  assert.deepEqual(await serverDiagnostic.requestServerDiagnostic(modern.url, request), { kind: 'result', result });
  assert.equal(modern.requests[0].type, 'BOT_DIAGNOSTIC');
  const old = await fakeMonkyServer(t, (message) => ({
    type: 'SERVER_ERROR', requestId: message.requestId, payload: { code: 'BAD_REQUEST', message: 'Mensagem malformada', requestId: message.requestId },
  }));
  assert.deepEqual(await serverDiagnostic.requestServerDiagnostic(old.url, request), { kind: 'unsupported' });
  const limited = await fakeMonkyServer(t, (message) => ({
    type: 'SERVER_ERROR', requestId: message.requestId, payload: { code: 'AUTH_RATE_LIMITED', message: 'x' },
  }));
  assert.deepEqual(await serverDiagnostic.requestServerDiagnostic(limited.url, request), { kind: 'rate-limited' });
  assert.equal((await serverDiagnostic.requestServerDiagnostic(`ws://127.0.0.1:${await freePort()}`, request, 3000)).kind, 'error');
});

test('doctor reports missing settings, foreign listeners and external results, and exits with failure', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state, BOT_TOKEN: 'fixture-token' });
  const context = cliConfig.createCliContext(f.bot);
  const foreign = net.createServer((socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nno'));
  foreign.listen(0, '0.0.0.0');
  await once(foreign, 'listening');
  const foreignPort = foreign.address().port;
  t.after(() => closeServer(foreign));
  const botDir = path.join(context.homeDir, 'runtime');
  cliConfig.writeConfig(context, cliConfig.manualConfig(context, { botDir, serverUrl: 'ws://monky.example.test', tokenEnv: 'BOT_TOKEN' }));
  consent.writeHostConsent(context.homeDir, 'accepted', consent.hostConsentFingerprint(context.project.definition), botDir);
  environment.writeProfileEnvironment(context.homeDir, {
    FIXTURE_GAMES_PORT: String(foreignPort), FIXTURE_GAMES_PUBLIC_URL: `http://127.0.0.1:${foreignPort}`,
  });
  t.mock.method(pm2, 'listProcesses', () => []);
  t.mock.method(pm2, 'findDefaultPm2Process', () => true);
  const diagnostic = t.mock.method(serverDiagnostic, 'requestServerDiagnostic', async () => assert.fail('--local never connects'));
  const lines = captureLogs(t);
  await assert.rejects(runBotCli(f.bot, ['doctor', '--local']), /impedem o bot de operar/);
  const output = lines.join('\n');
  assert.match(output, /FIXTURE_API_KEY é obrigatória e não está definida/);
  assert.match(output, /em uso por outro processo/);
  assert.match(output, /PM2 padrão/);
  assert.match(output, /--local: nenhuma conexão/);
  assert.equal(diagnostic.mock.callCount(), 0);
  assert.equal(output.includes('fixture-token'), false);

  await closeServer(foreign);
  environment.writeProfileEnvironment(context.homeDir, {
    FIXTURE_API_KEY: 'saved', FIXTURE_GAMES_PORT: String(foreignPort),
    FIXTURE_GAMES_PUBLIC_URL: `http://127.0.0.1:${foreignPort}`,
  });
  t.mock.method(pm2, 'findDefaultPm2Process', () => false);
  diagnostic.mock.mockImplementation(async (url, request) => {
    assert.equal(url, 'ws://monky.example.test/');
    assert.equal(request.botToken, 'fixture-token');
    assert.deepEqual(request.targets.map((target) => target.id), ['games']);
    assert.equal(await reachability.probeReachability(request.targets[0].origin, request.publicKey), 'verified',
      'the doctor serves the challenge on a free on-demand port during the test');
    return { kind: 'result', result: {
      serverProtocolVersion: 37, protocol: { version: 37, minimumVersion: 24, features: [] }, credential: 'valid',
      serverName: 'Fixture server', reachability: [{ id: 'games', status: 'unverified' }],
    } };
  });
  lines.length = 0;
  await assert.rejects(runBotCli(f.bot, ['doctor']), /impedem o bot de operar/);
  const remote = lines.join('\n');
  assert.match(remote, /Fixture server: token válido/);
  assert.match(remote, /não conseguiu acessar/);
  assert.match(remote, /a partir da rede de Fixture server/);
  assert.equal(diagnostic.mock.callCount(), 1);
  await assert.doesNotReject(new Promise((resolve, reject) => {
    const check = net.createServer();
    check.once('error', reject);
    check.listen(foreignPort, '0.0.0.0', () => check.close(resolve));
  }), 'the temporary responder releases the port');

  diagnostic.mock.mockImplementation(async (_url, request) => ({ kind: 'result', result: {
    serverProtocolVersion: 37, protocol: { version: 37, minimumVersion: 24, features: [] }, credential: 'valid',
    reachability: request.targets.map(({ id }) => ({ id, status: 'verified' })),
  } }));
  lines.length = 0;
  await runBotCli(f.bot, ['doctor']);
  assert.match(lines.join('\n'), /acessível de fora/);
  assert.match(lines.join('\n'), /Pronto para operar/);
});

function createTarball(file, pkg) {
  const content = Buffer.from(JSON.stringify(pkg));
  const header = Buffer.alloc(512, 0);
  header.write('package/package.json', 0, 'utf8');
  header.write('0000777\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(' ', 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512), Buffer.alloc(1024)])));
}

test('unattended updates skip a release that changes the declared access and keep the running bot', async (t) => {
  const root = fs.mkdtempSync(path.join(__dirname, '.monky-sdk-cli-consent-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const globalRoot = path.join(root, 'global', 'node_modules');
  const bot = path.join(globalRoot, '@example', 'sound-bot');
  const declaration = { cliName: 'sound-bot', displayName: 'Sound Bot', entry: 'dist/index.js', modes: ['manual'] };
  json(path.join(bot, 'package.json'), {
    name: '@example/sound-bot', version: '1.2.3', type: 'commonjs',
    monkyBot: { ...declaration, updateSource: { type: 'file', path: '../update.tgz' } },
  });
  fs.mkdirSync(path.join(bot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(bot, 'dist', 'index.js'), 'module.exports = {};');
  withEnv(t, { MONKY_BOT_CLI_HOME: path.join(root, 'state') });
  const context = cliConfig.createCliContext(bot);
  const config = cliConfig.manualConfig(context, { botDir: path.join(root, 'runtime'), botToken: 'token' });
  cliConfig.writeConfig(context, config);
  consent.writeHostConsent(context.homeDir, 'accepted', consent.hostConsentFingerprint(context.project.definition), config.botDir);
  const candidate = { ...declaration, requirements: { ports: [GAMES] } };
  createTarball(path.join(globalRoot, '@example', 'update.tgz'), { name: '@example/sound-bot', version: '1.2.4', monkyBot: candidate });
  const installs = [];
  t.mock.method(toolingProcess, 'runNpm', (args) => {
    if (args[0] === 'root') return globalRoot;
    installs.push(args);
    const pkg = JSON.parse(fs.readFileSync(path.join(bot, 'package.json'), 'utf8'));
    json(path.join(bot, 'package.json'), { ...pkg, version: '1.2.4', monkyBot: { ...pkg.monkyBot, requirements: candidate.requirements } });
    return '';
  });
  t.mock.method(pm2, 'findProcess', () => null);
  const lines = captureLogs(t);
  await updates.updateCommand(context, ['--yes']);
  assert.equal(installs.length, 0);
  assert.match(lines.join('\n'), /não foi instalada; o bot atual continua rodando/);

  process.env.MONKY_HOST_CONSENT = consent.candidateHostConsent(candidate).fingerprint;
  await updates.updateCommand(context, ['--yes']);
  assert.equal(installs.length, 1, 'an explicit approval of the new access lets automation install');
  assert.equal(releases.readPackageManifestFromTarball(path.join(globalRoot, '@example', 'update.tgz')).monkyBot.requirements.ports[0].id, 'games');
});

test('profiles written by a former standalone CLI are read with defaults and inherit consent', async (t) => {
  const f = fixture(t, { requirements: undefined });
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const botDir = path.join(f.root, 'legacy-runtime');
  json(context.configFile, { mode: 'marketplace', botDir, hostConsent: { version: 1, botDir } });
  const config = cliConfig.readConfig(context);
  assert.deepEqual(config, { mode: 'marketplace', botName: 'Sound Bot', botDir, servePort: 7780, publicHost: 'localhost' });
  json(context.configFile, { mode: 'manual', botDir, serverUrl: 'ws://legacy.example.test', botToken: 'legacy-token' });
  assert.equal(cliConfig.readConfig(context).botToken, 'legacy-token');
  json(context.configFile, { mode: 'manual', botDir, serverUrl: 'ws://legacy.example.test' });
  assert.equal(cliConfig.readConfig(context).tokenEnv, 'MONKY_BOT_TOKEN');
  json(context.configFile, { mode: 'manual', botDir, serverUrl: 'ws://legacy.example.test', unknownField: true });
  assert.throws(() => cliConfig.readConfig(context), /Unknown|desconhecida/);
  assert.equal(consent.hostConsentStatus(context.homeDir, botDir, consent.hostConsentFingerprint(context.project.definition)).state, 'legacy');
});

test('requirements lists what to open and configure even before setup', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const lines = captureLogs(t);
  await runBotCli(f.bot, ['requirements']);
  const output = lines.join('\n');
  assert.match(output, /manifest: TCP 7780 \(liberar no firewall\/roteador; sempre\)/);
  assert.match(output, /games: TCP 7781 \(liberar no firewall\/roteador; sob demanda\)/);
  assert.match(output, /FIXTURE_GAMES_PUBLIC_URL/);
  assert.match(output, /FIXTURE_API_KEY \[obrigatória\]: FALTANDO/);
  assert.match(output, /sound-bot doctor/);

  const view = require('../dist/cli/requirementsView');
  const context = cliConfig.createCliContext(f.bot);
  const ports = view.effectivePorts(context, cliConfig.marketplaceConfig(context, { servePort: 80, publicHost: 'Bot.Example.test' }), {});
  assert.deepEqual(ports.map((port) => port.publicOrigin), ['http://bot.example.test', 'http://bot.example.test:7781'],
    'origins are canonical, as the server validates them');
});
