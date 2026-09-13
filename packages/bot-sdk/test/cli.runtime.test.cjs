const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

const { runBotCli } = require('../dist/cli');
const cliConfig = require('../dist/cli/config');
const keys = require('../dist/cli/keys');
const lifecycle = require('../dist/cli/commands/lifecycle');
const pm2 = require('../dist/cli/pm2');
const ports = require('../dist/cli/ports');
const processHelpers = require('../dist/cli/process');

function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function fixture(t, extraMonkyBot = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-sdk-cli-runtime-'));
  const bot = path.join(root, 'bot');
  fs.mkdirSync(path.join(bot, 'dist'), { recursive: true });
  json(path.join(bot, 'package.json'), {
    name: '@example/sound-bot',
    version: '1.2.3',
    type: 'commonjs',
    monkyBot: {
      cliName: 'sound-bot',
      displayName: 'Sound Bot',
      entry: 'dist/index.js',
      modes: ['manual', 'marketplace'],
      ...extraMonkyBot,
    },
  });
  fs.writeFileSync(path.join(bot, 'dist', 'index.js'), 'module.exports = {};');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { root, bot, state: path.join(root, 'state') };
}

function withEnv(t, updates) {
  const previous = {};
  for (const [key, value] of Object.entries({ MONKY_SERVE_HOST: undefined, ...updates })) {
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
  return lines;
}

async function listenOnPort(t, port = 0, host = '0.0.0.0') {
  const server = net.createServer((socket) => socket.destroy());
  t.after(async () => {
    if (server.listening) await closeServer(server);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, exclusive: true }, resolve);
  });
  return { server, port: server.address().port };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function unusedPort(t) {
  const listener = await listenOnPort(t);
  await closeServer(listener.server);
  return listener.port;
}

function mockManagedProcess(t, context, onStop, status = 'online', env = {}, flatEnv = false) {
  const commands = [];
  t.mock.method(processHelpers, 'pm2Command', () => ({ command: 'fixture-pm2', args: [] }));
  t.mock.method(processHelpers, 'runCommand', (_command, args) => {
    commands.push([...args]);
    let stdout = '';
    if (args[0] === '--version') stdout = '7.0.4';
    else if (args[0] === 'jlist') {
      stdout = JSON.stringify([{ name: context.processName, pid: 123, pm2_env: { status, ...(flatEnv ? env : { env }) } }]);
    } else if (args[0] === 'stop') {
      assert.equal(args[1], context.processName);
      onStop();
      status = 'stopped';
    } else if (args[0] === 'startOrRestart') {
      status = 'online';
    } else if (args[0] !== 'save' && args[0] !== 'delete') {
      assert.fail(`Unexpected PM2 command: ${args.join(' ')}`);
    }
    return { status: 0, signal: null, stdout, stderr: '' };
  });
  return commands;
}

function interactiveAnswers(t, answers) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else delete process.stdin.isTTY;
  });
  const pending = [...answers];
  const questions = [];
  t.mock.method(readline, 'createInterface', (options) => {
    assert.equal(options.historySize, 0, 'The readline history must not retain the token.');
    const rl = new EventEmitter();
    rl.question = (question, callback) => {
      assert.ok(pending.length, `Unexpected prompt: ${question}`);
      questions.push(question);
      options.output.write(question);
      const answer = pending.shift();
      queueMicrotask(() => {
        if (answer === null) {
          rl.emit('close');
          return;
        }
        options.output.write(answer);
        callback(answer);
      });
    };
    rl.close = () => rl.emit('close');
    return rl;
  });
  t.after(() => assert.deepEqual(pending, [], 'All expected setup answers must be consumed.'));
  return questions;
}

test('runBotCli exposes the bot version instead of the SDK version', async (t) => {
  const f = fixture(t);
  const lines = captureLogs(t);
  await runBotCli(f.bot, ['--version']);
  assert.deepEqual(lines, ['sound-bot 1.2.3']);
});

test('non-interactive setup writes isolated config and refuses overwrite without --yes', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  await runBotCli(f.bot, [
    'setup',
    '--non-interactive',
    '--server-url', 'localhost:3000/socket',
    '--token-env', 'BOT_TOKEN',
    '--name', 'Fixture Bot',
  ]);

  const configFile = path.join(f.state, '.sound-bot', 'config.json');
  const saved = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(saved.mode, 'manual');
  assert.equal(saved.botName, 'Fixture Bot');
  assert.equal(saved.serverUrl, 'ws://localhost:3000/socket');
  assert.equal(saved.tokenEnv, 'BOT_TOKEN');
  assert.equal(saved.botDir, path.join(f.state, '.sound-bot'));

  await assert.rejects(
    runBotCli(f.bot, [
      'setup',
      '--non-interactive',
      '--server-url', 'ws://localhost:3000/socket',
      '--token-env', 'BOT_TOKEN',
    ]),
    /Re-run with --yes/
  );
});

test('interactive setup defaults to the recommended URL installation for fresh profiles', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const port = await unusedPort(t);
  const questions = interactiveAnswers(t, ['', '', String(port), 'bot.example.test', '']);
  const lines = captureLogs(t);
  await runBotCli(f.bot, ['setup']);
  const config = cliConfig.readConfig(cliConfig.createCliContext(f.bot));
  assert.equal(config.mode, 'marketplace');
  assert.equal(config.servePort, port);
  assert.equal(config.publicHost, 'bot.example.test');
  assert.equal(config.botName, 'Sound Bot');
  assert.equal(questions[0], 'Modo [1]: ');
  assert.equal(questions.some((question) => /Token do bot|URL do servidor/.test(question)), false);
  const output = lines.join('\n');
  assert.match(output, /1\. Instalação por URL — recomendado/);
  assert.match(output, /2\. Conexão manual por token — avançado/);
});

test('interactive setup opts into the advanced manual flow and saves a hidden token outside the package', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state, MONKY_BOT_TOKEN: undefined });
  const token = 'fixture-manual-token';
  const questions = interactiveAnswers(t, ['2', '', '192.0.2.15:3000', token, 'My Sound Bot']);
  const lines = captureLogs(t);
  const terminal = [];
  const write = t.mock.method(process.stdout, 'write', (chunk) => { terminal.push(String(chunk)); return true; });
  try {
    await runBotCli(f.bot, ['setup']);
  } finally {
    write.mock.restore();
  }
  assert.equal(questions[0], 'Modo [1]: ');
  assert.match(questions[1], /trabalho/);
  assert.match(questions[2], /URL do servidor/);
  assert.match(questions[3], /Token do bot/);
  assert.match(questions[4], /Nome do bot/);
  const context = cliConfig.createCliContext(f.bot);
  const config = cliConfig.readConfig(context);
  assert.equal(config.botToken, token);
  assert.equal(config.tokenEnv, undefined);
  assert.equal(config.serverUrl, 'ws://192.0.2.15:3000/');
  assert.equal(config.botName, 'My Sound Bot');
  assert.equal(config.botDir, context.homeDir);
  assert.equal(fs.existsSync(path.join(f.bot, 'config.json')), false);
  assert.match(lines.join('\n'), /Na seção Avançado, gere um vínculo\/token/);
  assert.doesNotMatch(lines.join('\n'), /Clique "Criar", dê um nome ao bot/);
  assert.equal(terminal.join('').includes(token), false);
  await runBotCli(f.bot, ['config']);
  assert.equal(lines.join('\n').includes(token), false);
  assert.equal(cliConfig.sanitizeConfig(config).botToken, '[redacted]');
  const runtime = require('../dist/cli/runner').createRuntimeEnvironment(config, 'public-key', {});
  assert.equal(runtime.values.MONKY_BOT_TOKEN, token);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(context.configFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(context.homeDir).mode & 0o777, 0o700);
  }
});

test('interactive marketplace setup retries invalid fields and never requests a manual token', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const port = await unusedPort(t);
  const questions = interactiveAnswers(t, ['3', '1', '', 'not-a-port', String(port), '', 'https://bot.example.test', 'bot.example.test', '']);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  captureLogs(t);
  await runBotCli(f.bot, ['setup']);
  const config = cliConfig.readConfig(cliConfig.createCliContext(f.bot));
  assert.equal(config.mode, 'marketplace');
  assert.equal(config.servePort, port);
  assert.equal(config.publicHost, 'bot.example.test');
  assert.equal(config.botName, 'Sound Bot');
  assert.equal(questions.some((question) => /Token do bot|URL do servidor/.test(question)), false);
  assert.match(questions.at(-1), /Nome do bot/);
  assert.equal(errors.length, 4);
  assert.equal('botToken' in config, false);
  assert.equal('tokenEnv' in config, false);
});

test('interactive manual setup retries an invalid URL and token instead of abandoning previous answers', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  interactiveAnswers(t, ['2', '', 'https://invalid.example.test', '[::1]:3000', '', 'saved-token', '']);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  captureLogs(t);
  await runBotCli(f.bot, ['setup']);
  const config = cliConfig.readConfig(cliConfig.createCliContext(f.bot));
  assert.equal(config.serverUrl, 'ws://[::1]:3000/');
  assert.equal(config.botToken, 'saved-token');
  assert.equal(errors.length, 2);
});

test('interactive reconfiguration preserves the existing token and data directory', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const existing = cliConfig.manualConfig(context, {
    botDir: path.join(f.state, 'existing-runtime'),
    botName: 'Existing Bot',
    botToken: 'existing-token',
    serverUrl: 'wss://existing.example.test',
  });
  cliConfig.writeConfig(context, existing);
  const questions = interactiveAnswers(t, ['s', '', '', '', '', '']);
  captureLogs(t);
  await runBotCli(f.bot, ['setup']);
  assert.equal(questions[1], 'Modo [2]: ');
  assert.deepEqual(cliConfig.readConfig(context), existing);
});

test('interactive reconfiguration preserves the existing URL installation choice and data directory', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const existing = cliConfig.marketplaceConfig(context, {
    botDir: path.join(f.state, 'existing-runtime'),
    botName: 'Existing Bot',
    servePort: await unusedPort(t),
    publicHost: 'bot.example.test',
  });
  cliConfig.writeConfig(context, existing);
  const questions = interactiveAnswers(t, ['s', '', '', '', '', '']);
  captureLogs(t);
  await runBotCli(f.bot, ['setup']);
  assert.equal(questions[1], 'Modo [1]: ');
  assert.deepEqual(cliConfig.readConfig(context), existing);
});

test('closing interactive setup leaves the previous configuration untouched', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const existing = cliConfig.manualConfig(context, { botToken: 'existing-token' });
  cliConfig.writeConfig(context, existing);
  interactiveAnswers(t, ['s', '', '', null]);
  captureLogs(t);
  await assert.rejects(runBotCli(f.bot, ['setup']), /Setup cancelado/);
  assert.deepEqual(cliConfig.readConfig(context), existing);
});

test('interactive setup skips the mode chooser for manual-only projects', async (t) => {
  const f = fixture(t, { modes: ['manual'] });
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const questions = interactiveAnswers(t, ['', '192.0.2.15:3000', 'saved-token', '']);
  captureLogs(t);
  await runBotCli(f.bot, ['setup']);
  const config = cliConfig.readConfig(cliConfig.createCliContext(f.bot));
  assert.equal(config.mode, 'manual');
  assert.equal(questions.some((question) => question.startsWith('Modo [')), false);
  assert.equal(config.serverUrl, 'ws://192.0.2.15:3000/');
  assert.equal(config.botToken, 'saved-token');
});

test('non-interactive marketplace setup preserves the data directory when replacing a manual profile', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const botDir = path.join(f.state, 'existing-bot');
  const port = await unusedPort(t);
  cliConfig.writeConfig(context, cliConfig.manualConfig(context, { botDir, botToken: 'old-token', botName: 'Existing Bot' }));
  await runBotCli(f.bot, ['setup', '--non-interactive', '--mode', 'marketplace',
    '--public-host', 'bot.example.test', '--serve-port', String(port), '--yes']);
  assert.deepEqual(cliConfig.readConfig(context), {
    mode: 'marketplace', botDir, botName: 'Existing Bot', publicHost: 'bot.example.test', servePort: port,
  });
});

test('a manifest port probe releases the free port before returning', async (t) => {
  withEnv(t, {});
  const port = await unusedPort(t);
  await ports.assertManifestPortAvailable(port, 'sound-bot');
  const listener = await listenOnPort(t, port);
  assert.equal(listener.server.listening, true);
});

test('the bind host honors explicit environment overrides and retains an existing managed host', (t) => {
  withEnv(t, {});
  assert.equal(ports.getManifestBindHost(), '0.0.0.0');
  assert.equal(ports.getManifestBindHost({ MONKY_SERVE_HOST: '127.0.0.1' }), '127.0.0.1');
  assert.equal(ports.getManifestBindHost({ env: { MONKY_SERVE_HOST: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(ports.getManifestBindHost({
    MONKY_SERVE_HOST: '::1', env: { MONKY_SERVE_HOST: '127.0.0.1' },
  }), '::1');
  process.env.MONKY_SERVE_HOST = '::1';
  assert.equal(ports.getManifestBindHost({ MONKY_SERVE_HOST: '127.0.0.1' }), '::1');
  process.env.MONKY_SERVE_HOST = '';
  assert.equal(ports.getManifestBindHost({ MONKY_SERVE_HOST: '127.0.0.1' }), '0.0.0.0');
  delete process.env.MONKY_SERVE_HOST;
  assert.throws(() => ports.getManifestBindHost({ MONKY_SERVE_HOST: 123 }), /hostname or IP/);
});

test('the probe and background launch check configured and flat PM2 IPv6 bind addresses', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  let occupied;
  try {
    occupied = await listenOnPort(t, 0, '::1');
  } catch (error) {
    if (['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(error.code)) {
      t.skip('IPv6 loopback is unavailable on this host.');
      return;
    }
    throw error;
  }
  process.env.MONKY_SERVE_HOST = '::1';
  await assert.rejects(ports.assertManifestPortAvailable(occupied.port, 'sound-bot'), /em uso por um bot ou outro/);
  process.env.MONKY_SERVE_HOST = '127.0.0.1';
  await ports.assertManifestPortAvailable(occupied.port, 'sound-bot');

  delete process.env.MONKY_SERVE_HOST;
  const context = cliConfig.createCliContext(f.bot);
  cliConfig.writeConfig(context, cliConfig.marketplaceConfig(context, { servePort: occupied.port }));
  const commands = mockManagedProcess(t, context, () => assert.fail('the managed bot is stopped'),
    'stopped', { MONKY_SERVE_HOST: '::1' }, true);
  const lines = captureLogs(t);
  for (const command of ['start', 'restart']) {
    await assert.rejects(runBotCli(f.bot, [command]), /em uso por um bot ou outro/);
  }
  assert.equal(commands.some((args) => ['startOrRestart', 'stop', 'save'].includes(args[0])), false);
  assert.doesNotMatch(lines.join('\n'), /iniciado|reiniciado|Manifest:/);
  assert.equal(occupied.server.listening, true);
});

test('interactive setup retries an occupied port without changing or stopping its owner', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const occupied = await listenOnPort(t);
  const available = await unusedPort(t);
  const questions = interactiveAnswers(t, ['', '', String(occupied.port), String(available), 'bot.example.test', '']);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.mock.method(pm2, 'findProcess', () => assert.fail('setup must not inspect or stop PM2'));
  captureLogs(t);

  await runBotCli(f.bot, ['setup']);

  assert.equal(cliConfig.readConfig(cliConfig.createCliContext(f.bot)).servePort, available);
  assert.equal(questions.filter((question) => question.startsWith('Porta do manifest')).length, 2);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes(`A porta ${occupied.port}`));
  assert.match(errors[0], /em uso por um bot ou outro/);
  assert.match(errors[0], /sound-bot stop/);
  assert.equal(occupied.server.listening, true);
});

test('an occupied port prevents non-interactive setup from creating or overwriting config', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const occupied = await listenOnPort(t);
  const args = ['setup', '--non-interactive', '--mode', 'marketplace',
    '--public-host', 'bot.example.test', '--serve-port', String(occupied.port), '--yes'];
  const lines = captureLogs(t);
  await assert.rejects(runBotCli(f.bot, args), /em uso por um bot ou outro/);
  assert.equal(fs.existsSync(context.configFile), false);

  const existing = cliConfig.manualConfig(context, { botToken: 'preserved-token' });
  cliConfig.writeConfig(context, existing);
  const before = fs.readFileSync(context.configFile);
  await assert.rejects(runBotCli(f.bot, args), /em uso por um bot ou outro/);
  assert.deepEqual(fs.readFileSync(context.configFile), before);
  assert.equal(fs.existsSync(path.join(existing.botDir, '.keys')), false);
  assert.doesNotMatch(lines.join('\n'), /salva/);
  assert.equal(occupied.server.listening, true);
});

test('existing config never proves ownership of an occupied port and cancellation preserves the profile', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const occupied = await listenOnPort(t);
  const existing = cliConfig.marketplaceConfig(context, { servePort: occupied.port });
  cliConfig.writeConfig(context, existing);
  const identity = keys.loadOrCreateBotKeys(existing.botDir);
  const before = fs.readFileSync(context.configFile);
  interactiveAnswers(t, ['s', '', '', '', null]);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  captureLogs(t);

  await assert.rejects(runBotCli(f.bot, ['setup']), /Setup cancelado/);

  assert.match(errors.join('\n'), /sound-bot stop/);
  assert.deepEqual(fs.readFileSync(context.configFile), before);
  assert.deepEqual(keys.loadOrCreateBotKeys(existing.botDir), identity);
  assert.equal(occupied.server.listening, true);
});

test('setup rechecks the port before saving after the remaining interactive prompts', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const port = await unusedPort(t);
  const existing = cliConfig.manualConfig(context, { botToken: 'preserved-token' });
  cliConfig.writeConfig(context, existing);
  const before = fs.readFileSync(context.configFile);
  const probe = ports.assertManifestPortAvailable;
  let calls = 0;
  let listener;
  t.mock.method(ports, 'assertManifestPortAvailable', async (...args) => {
    if (++calls === 2) listener = await listenOnPort(t, port);
    await probe(...args);
  });
  interactiveAnswers(t, ['s', '1', '', String(port), 'bot.example.test', '']);
  const lines = captureLogs(t);

  await assert.rejects(runBotCli(f.bot, ['setup']), /em uso por um bot ou outro/);

  assert.equal(calls, 2);
  assert.equal(listener.server.listening, true);
  assert.deepEqual(fs.readFileSync(context.configFile), before);
  assert.doesNotMatch(lines.join('\n'), /salva!/);
});

for (const cancelOnProbe of [1, 2]) {
  test(`closing setup during port probe ${cancelOnProbe} cannot hang or overwrite config`, async (t) => {
    const f = fixture(t);
    withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
    const context = cliConfig.createCliContext(f.bot);
    const port = await unusedPort(t);
    const existing = cliConfig.manualConfig(context, { botToken: 'preserved-token' });
    cliConfig.writeConfig(context, existing);
    const before = fs.readFileSync(context.configFile);
    const probe = ports.assertManifestPortAvailable;
    let calls = 0;
    t.mock.method(ports, 'assertManifestPortAvailable', async (...args) => {
      if (++calls === cancelOnProbe) {
        readline.createInterface.mock.calls[0].result.emit('close');
      }
      await probe(...args);
    });
    interactiveAnswers(t, ['s', '1', '', String(port),
      ...(cancelOnProbe === 2 ? ['bot.example.test', ''] : [])]);
    const lines = captureLogs(t);

    await assert.rejects(runBotCli(f.bot, ['setup']), /Setup cancelado/);

    assert.equal(calls, cancelOnProbe);
    assert.deepEqual(fs.readFileSync(context.configFile), before);
    assert.doesNotMatch(lines.join('\n'), /salva!/);
  });
}

test('port permission and unexpected bind errors are not reported as availability or bot collisions', async (t) => {
  for (const code of ['EACCES', 'EADDRNOTAVAIL']) {
    const server = new EventEmitter();
    server.listen = () => {
      queueMicrotask(() => server.emit('error', Object.assign(new Error(`${code}: fixture bind error`), { code })));
    };
    const create = t.mock.method(net, 'createServer', () => server);
    try {
      await assert.rejects(ports.assertManifestPortAvailable(7780, 'sound-bot'), (error) => {
        assert.ok(error.message.includes('porta 7780'));
        assert.ok(error.message.includes(code));
        assert.doesNotMatch(error.message, /em uso por um bot/);
        return true;
      });
      assert.equal(server.listenerCount('error'), 0);
    } finally {
      create.mock.restore();
    }
  }
});

test('non-interactive setup rejects unsupported modes and missing or mixed mode-specific options', async (t) => {
  const f = fixture(t, { modes: ['manual'] });
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  for (const [args, error] of [
    [['--mode', 'marketplace', '--public-host', 'bot.example.test'], /does not support/],
    [['--mode', 'marketplace'], /requires --public-host/],
    [['--mode', 'marketplace', '--public-host', 'bot.example.test', '--token-env', 'TOKEN'], /require --mode manual/],
    [['--server-url', 'localhost:3000', '--serve-port', '7780'], /require --mode marketplace/],
    [['--mode', 'unknown'], /must be manual or marketplace/],
  ]) {
    await assert.rejects(runBotCli(f.bot, ['setup', '--non-interactive', ...args]), error);
  }
  assert.equal(fs.existsSync(cliConfig.createCliContext(f.bot).configFile), false);
});

test('manual credentials survive reference config aliases and switching to environment tokens removes the saved secret', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  cliConfig.writeConfig(context, cliConfig.manualConfig(context, { botToken: 'first-token' }));
  const lines = captureLogs(t);
  for (const args of [
    ['serverUrl', 'localhost:3001'],
    ['botName', 'Renamed Bot'],
    ['mode', 'manual'],
  ]) {
    await runBotCli(f.bot, ['config', 'set', ...args]);
    assert.equal(cliConfig.readConfig(context).botToken, 'first-token');
  }
  await runBotCli(f.bot, ['config', 'set', 'tokenEnv', 'OTHER_TOKEN']);
  assert.equal(cliConfig.readConfig(context).botToken, undefined);
  assert.equal(cliConfig.readConfig(context).tokenEnv, 'OTHER_TOKEN');
  await runBotCli(f.bot, ['config', 'set', 'botToken', 'second-token']);
  assert.equal(cliConfig.readConfig(context).tokenEnv, undefined);
  assert.equal(cliConfig.readConfig(context).botToken, 'second-token');
  assert.doesNotMatch(lines.join('\n'), /first-token|second-token/);
  assert.throws(() => cliConfig.validateConfig({
    ...cliConfig.readConfig(context), tokenEnv: 'OTHER_TOKEN',
  }), /either botToken or tokenEnv/);
});

test('the CLI accepts bare server addresses without accepting credentials or non-WebSocket protocols', () => {
  for (const [input, expected] of [
    ['192.0.2.15:3000', 'ws://192.0.2.15:3000/'],
    ['localhost:3000/socket', 'ws://localhost:3000/socket'],
    ['[::1]:3000', 'ws://[::1]:3000/'],
    ['wss://bot.example.test/socket', 'wss://bot.example.test/socket'],
  ]) assert.equal(cliConfig.validateServerUrl(input), expected);
  for (const input of ['https://bot.example.test', 'ws://user:secret@bot.example.test',
    'bot.example.test/#fragment', 'host with spaces', 'localhost:99999', 'ws:/localhost', '//localhost']) {
    assert.throws(() => cliConfig.validateServerUrl(input), /valid ws:\/\//);
  }
});

test('marketplace runtime exposes a persistent registration file and clears manual credentials', (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot, { MONKY_BOT_CLI_HOME: f.state });
  const config = cliConfig.marketplaceConfig(context, { publicHost: 'bot.example.test', servePort: 7781 });
  const plan = require('../dist/cli/runner').createRuntimeEnvironment(config, 'public-key', {
    MONKY_SERVER_URL: 'ws://stale.example.test', MONKY_BOT_TOKEN: 'stale-token',
  });
  assert.equal(plan.values.MONKY_SERVE, 'true');
  assert.equal(plan.values.MONKY_SERVE_PORT, '7781');
  assert.equal(plan.values.MONKY_BOT_REGISTRATION_FILE, path.join(config.botDir, '.keys', 'registrations.json'));
  assert.ok(plan.clear.includes('MONKY_SERVER_URL'));
  assert.ok(plan.clear.includes('MONKY_BOT_TOKEN'));
  const manual = require('../dist/cli/runner').createRuntimeEnvironment(
    cliConfig.manualConfig(context, { botToken: 'manual-token' }), 'public-key', {});
  assert.ok(manual.clear.includes('MONKY_BOT_REGISTRATION_FILE'));
  assert.ok(manual.clear.includes('MONKY_SERVE_HOST'));
});

test('saving a manual token fails before writing when POSIX private directory permissions cannot be applied', (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot, { MONKY_BOT_CLI_HOME: f.state });
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  const denied = new Error('Permission denied');
  denied.code = 'EACCES';
  t.mock.method(fs, 'chmodSync', () => { throw denied; });
  assert.throws(() => cliConfig.writeConfig(context, cliConfig.manualConfig(context, {
    botToken: 'must-not-be-written',
  })), /Permission denied/);
  assert.equal(fs.existsSync(context.configFile), false);
});

test('config set switches modes and clears mode-specific fields', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  await runBotCli(f.bot, [
    'setup',
    '--non-interactive',
    '--server-url', 'ws://localhost:3000',
    '--token-env', 'BOT_TOKEN',
    '--yes',
  ]);

  const port = await unusedPort(t);
  await runBotCli(f.bot, ['config', 'set', 'serve-port', String(port)]);
  await runBotCli(f.bot, ['config', 'set', 'public-host', 'bot.example.test']);
  let current = cliConfig.readConfig(cliConfig.createCliContext(f.bot));
  assert.equal(current.mode, 'marketplace');
  assert.equal(current.servePort, port);
  assert.equal(current.publicHost, 'bot.example.test');
  assert.equal('serverUrl' in current, false);
  assert.equal('tokenEnv' in current, false);

  await runBotCli(f.bot, ['config', 'set', 'server-url', 'wss://monky.example.test']);
  await runBotCli(f.bot, ['config', 'set', 'token-env', 'OTHER_TOKEN']);
  current = cliConfig.readConfig(cliConfig.createCliContext(f.bot));
  assert.equal(current.mode, 'manual');
  assert.equal(current.serverUrl, 'wss://monky.example.test/');
  assert.equal(current.tokenEnv, 'OTHER_TOKEN');
  assert.equal('servePort' in current, false);
  assert.equal('publicHost' in current, false);
});

test('config set rejects occupied ports before saving, including manual-to-marketplace changes', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const occupied = await listenOnPort(t);
  const lines = captureLogs(t);
  for (const existing of [
    cliConfig.manualConfig(context, { botToken: 'preserved-token' }),
    cliConfig.marketplaceConfig(context, { servePort: await unusedPort(t) }),
  ]) {
    cliConfig.writeConfig(context, existing);
    const before = fs.readFileSync(context.configFile);
    for (const key of ['servePort', 'serve-port']) {
      await assert.rejects(runBotCli(f.bot, ['config', 'set', key, String(occupied.port)]), /em uso por um bot ou outro/);
      assert.deepEqual(fs.readFileSync(context.configFile), before);
    }
  }
  assert.doesNotMatch(lines.join('\n'), /atualizada/);
  assert.equal(occupied.server.listening, true);
});

test('config mode and host changes also check the default port when enabling marketplace', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const existing = cliConfig.manualConfig(context, { botToken: 'preserved-token' });
  cliConfig.writeConfig(context, existing);
  const probe = t.mock.method(ports, 'assertManifestPortAvailable', async () => {
    throw new Error('fixture occupied default port');
  });
  for (const args of [['mode', 'marketplace'], ['publicHost', 'bot.example.test']]) {
    await assert.rejects(runBotCli(f.bot, ['config', 'set', ...args]), /occupied default port/);
    assert.deepEqual(cliConfig.readConfig(context), existing);
  }
  assert.equal(probe.mock.callCount(), 2);
  assert.deepEqual(probe.mock.calls[0].arguments, [7780, context.cliName]);
});

test('unrelated config changes do not mistake the running bot for a port collision', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const occupied = await listenOnPort(t);
  cliConfig.writeConfig(context, cliConfig.marketplaceConfig(context, { servePort: occupied.port }));
  t.mock.method(ports, 'assertManifestPortAvailable', () => assert.fail('the listening port did not change'));
  captureLogs(t);
  await runBotCli(f.bot, ['config', 'set', 'botName', 'Renamed Bot']);
  await runBotCli(f.bot, ['config', 'set', 'publicHost', 'bot.example.test']);
  assert.equal(cliConfig.readConfig(context).botName, 'Renamed Bot');
  assert.equal(cliConfig.readConfig(context).servePort, occupied.port);
  assert.equal(occupied.server.listening, true);
});

test('runner loads keys, preserves cwd isolation and maps manual-mode environment variables', async (t) => {
  const f = fixture(t);
  withEnv(t, {
    OUTPUT_FILE: path.join(f.root, 'runner-output.json'),
    MONKY_BOT_PUBLIC_KEY: undefined,
    MONKY_BOT_NAME: undefined,
    MONKY_SERVER_URL: undefined,
    MONKY_BOT_TOKEN: undefined,
    MONKY_SERVE: 'true',
    MONKY_SERVE_PORT: '1234',
    MONKY_SERVE_PUBLIC_HOST: 'stale.example.test',
  });
  const originalCwd = process.cwd();
  const context = cliConfig.createCliContext(f.bot, { ...process.env, MONKY_BOT_CLI_HOME: f.state });
  const botDir = path.join(f.state, '.sound-bot', 'runtime');
  cliConfig.writeConfig(context, cliConfig.manualConfig(context, {
    botName: 'Runner Bot',
    botDir,
    serverUrl: 'ws://runner.example.test',
    tokenEnv: 'BOT_TOKEN',
  }));
  keys.loadOrCreateBotKeys(botDir);

  const output = process.env.OUTPUT_FILE;
  const entry = path.join(f.bot, 'dist', 'runner-target.cjs');
  fs.writeFileSync(entry, `
require('node:fs').writeFileSync(process.env.OUTPUT_FILE, JSON.stringify({
  cwd: process.cwd(),
  name: process.env.MONKY_BOT_NAME,
  serverUrl: process.env.MONKY_SERVER_URL,
  token: process.env.MONKY_BOT_TOKEN,
  publicKey: process.env.MONKY_BOT_PUBLIC_KEY,
  serve: process.env.MONKY_SERVE || null
}));
`);

  const runner = require('../dist/cli/runner');
  try {
    await runner.runConfiguredBot({
      ...process.env,
      BOT_TOKEN: 'secret-token',
      OUTPUT_FILE: output,
      MONKY_BOT_CLI_CONFIG_FILE: context.configFile,
      MONKY_BOT_CLI_ENTRY: entry,
    });
  } finally {
    process.chdir(originalCwd);
  }

  const snapshot = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(snapshot.cwd, botDir);
  assert.equal(snapshot.name, 'Runner Bot');
  assert.equal(snapshot.serverUrl, 'ws://runner.example.test/');
  assert.equal(snapshot.token, 'secret-token');
  assert.equal(snapshot.serve, null);
  assert.match(snapshot.publicKey, /^[0-9a-f]{88}$/i);
});

test('incomplete key directories fail explicitly instead of silently rotating identity', (t) => {
  const f = fixture(t);
  const botDir = path.join(f.root, 'broken-runtime');
  fs.mkdirSync(path.join(botDir, '.keys'), { recursive: true });
  fs.writeFileSync(path.join(botDir, '.keys', 'public.hex'), 'abcd');
  assert.throws(() => keys.loadOrCreateBotKeys(botDir), /incomplete or corrupted/i);
});

test('foreground start uses the SDK runner and never touches pm2', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state, BOT_TOKEN: 'foreground-secret' });
  const context = cliConfig.createCliContext(f.bot);
  cliConfig.writeConfig(context, cliConfig.manualConfig(context, {
    botName: 'Foreground Bot',
    botDir: path.join(f.state, '.sound-bot', 'foreground'),
    serverUrl: 'ws://foreground.example.test',
    tokenEnv: 'BOT_TOKEN',
  }));

  const child = new EventEmitter();
  child.kill = () => true;
  process.nextTick(() => child.emit('exit', 0, null));
  const spawn = t.mock.method(processHelpers, 'spawnCommand', () => child);
  const ensurePm2 = t.mock.method(pm2, 'ensurePm2ForStart', () => {
    throw new Error('pm2 should not be used in foreground mode');
  });

  await lifecycle.startCommand(context, ['--foreground']);
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(ensurePm2.mock.callCount(), 0);
  assert.deepEqual(spawn.mock.calls[0].arguments.slice(0, 2), [process.execPath, [context.runnerScript]]);
});

test('bot ecosystem uses isolated runner metadata and never embeds token values', (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state, BOT_TOKEN: 'actual-secret' });
  const context = cliConfig.createCliContext(f.bot);
  const entry = path.join(f.bot, 'dist', 'index.js');
  const ecosystemFile = pm2.writeBotEcosystem(context, entry);
  assert.equal(path.basename(ecosystemFile), 'ecosystem.bot.config.cjs');
  const content = fs.readFileSync(ecosystemFile, 'utf8');
  assert.doesNotMatch(content, /actual-secret/);
  const { apps } = require(ecosystemFile);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, context.processName);
  assert.equal(apps[0].script, context.runnerScript);
  assert.equal(apps[0].interpreter, process.execPath);
  assert.equal(apps[0].cwd, context.homeDir);
  assert.deepEqual(apps[0].env, {
    MONKY_BOT_CLI_CONFIG_FILE: context.configFile,
    MONKY_BOT_CLI_ENTRY: entry,
  });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(ecosystemFile).mode & 0o777, 0o600);
  }
});

test('updater ecosystem uses a PM2-recognized CommonJS filename and retains its invocation', (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot, { MONKY_BOT_CLI_HOME: f.state });
  const ecosystemFile = pm2.writeUpdaterEcosystem(context, '03:45', true);
  assert.equal(path.basename(ecosystemFile), 'ecosystem.updater.config.cjs');
  assert.notEqual(ecosystemFile, context.botEcosystemFile);
  const { apps } = require(ecosystemFile);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, context.updaterProcessName);
  assert.equal(apps[0].script, context.updaterScript);
  assert.equal(apps[0].interpreter, process.execPath);
  assert.equal(apps[0].cwd, context.homeDir);
  assert.deepEqual(apps[0].env, {
    MONKY_BOT_CLI_PACKAGE_ROOT: context.packageRoot,
    MONKY_BOT_CLI_UPDATE_CWD: context.cliInvocation.cwd,
    MONKY_BOT_CLI_UPDATE_ARGS: JSON.stringify([...context.cliInvocation.args, 'update', '--yes']),
    MONKY_BOT_CLI_SCHEDULE: '03:45',
    MONKY_BOT_CLI_INCLUDE_BETA: 'true',
  });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(ecosystemFile).mode & 0o777, 0o600);
  }
});

test('Windows pm2 executes its Node entry without passing arguments through a command shell', (t) => {
  const f = fixture(t);
  const prefix = path.join(f.root, 'node tools & fixtures');
  const entry = path.join(prefix, 'node_modules', 'pm2', 'bin', 'pm2');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const executable = processHelpers.pm2Command({ PATH: prefix }, 'win32');
  assert.deepEqual(executable, { command: process.execPath, args: [entry] });
  const args = ['--lines', '1 & echo should-not-run', '%MONKY_FAKE_VAR%'];
  const result = processHelpers.runCommand(executable.command, [...executable.args, ...args]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('PM2 restarts refresh the service environment and followed logs have no automatic deadline', (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot, { MONKY_BOT_CLI_HOME: f.state });
  t.mock.method(processHelpers, 'pm2Command', () => ({ command: 'test-pm2', args: ['entry'] }));
  const command = t.mock.method(processHelpers, 'runCommand', () => ({
    status: 0, signal: null, stdout: '', stderr: '',
  }));
  pm2.startOrRestart(context, context.botEcosystemFile);
  pm2.streamLogs(context, 100, true);
  pm2.streamLogs(context, 20, false);
  assert.deepEqual(command.mock.calls[0].arguments[1], [
    'entry', 'startOrRestart', context.botEcosystemFile, '--update-env',
  ]);
  assert.equal(command.mock.calls[1].arguments[2].timeout, 0);
  assert.equal(command.mock.calls[2].arguments[2].timeout, 120000);
  assert.ok(command.mock.calls[2].arguments[1].includes('--nostream'));
});

test('an installed but failing PM2 is not mistaken for a missing dependency', (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot, { MONKY_BOT_CLI_HOME: f.state });
  t.mock.method(processHelpers, 'pm2Command', () => ({ command: 'test-pm2', args: [] }));
  t.mock.method(processHelpers, 'runCommand', () => ({
    status: 1, signal: null, stdout: '', stderr: 'Permission denied',
  }));
  assert.throws(() => pm2.isPm2Available(context), /pm2 --version failed.*\nPermission denied/);
});

test('start and restart reject a missing token before consulting or installing PM2', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state, BOT_TOKEN: undefined });
  const context = cliConfig.createCliContext(f.bot);
  cliConfig.writeConfig(context, cliConfig.manualConfig(context, { tokenEnv: 'BOT_TOKEN' }));
  const ensure = t.mock.method(pm2, 'ensurePm2ForStart', () => assert.fail('must not install PM2'));
  const requirePm2 = t.mock.method(pm2, 'requirePm2', () => assert.fail('must not invoke PM2'));
  await assert.rejects(lifecycle.startCommand(context, []), /Missing required environment variable BOT_TOKEN/);
  await assert.rejects(lifecycle.restartCommand(context, []), /Missing required environment variable BOT_TOKEN/);
  assert.equal(ensure.mock.callCount(), 0);
  assert.equal(requirePm2.mock.callCount(), 0);
});

test('marketplace start rejects an occupied port before launching PM2, foreground or creating keys', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const occupied = await listenOnPort(t);
  const config = cliConfig.marketplaceConfig(context, { servePort: occupied.port });
  cliConfig.writeConfig(context, config);
  t.mock.method(pm2, 'findProcess', () => null);
  t.mock.method(pm2, 'ensurePm2ForStart', () => assert.fail('must not install or start PM2'));
  t.mock.method(pm2, 'startOrRestart', () => assert.fail('must not launch the bot'));
  t.mock.method(processHelpers, 'spawnCommand', () => assert.fail('must not spawn foreground'));
  const lines = captureLogs(t);

  for (const args of [[], ['--foreground']]) {
    await assert.rejects(runBotCli(f.bot, ['start', ...args]), /em uso por um bot ou outro/);
  }

  assert.equal(fs.existsSync(path.join(config.botDir, '.keys')), false);
  assert.equal(fs.existsSync(context.botEcosystemFile), false);
  assert.doesNotMatch(lines.join('\n'), /iniciado|Manifest:/);
  assert.equal(occupied.server.listening, true);
});

for (const foreground of [false, true]) {
  test(`marketplace start with a free port succeeds in ${foreground ? 'foreground' : 'background'}`, async (t) => {
    const f = fixture(t);
    withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
    const context = cliConfig.createCliContext(f.bot);
    const port = await unusedPort(t);
    const config = cliConfig.marketplaceConfig(context, { servePort: port, publicHost: 'bot.example.test' });
    cliConfig.writeConfig(context, config);
    t.mock.method(pm2, 'findProcess', () => null);
    const ensured = t.mock.method(pm2, 'ensurePm2ForStart', () => {});
    const started = t.mock.method(pm2, 'startOrRestart', () => {});
    const saved = t.mock.method(pm2, 'saveProcessList', () => {});
    const child = new EventEmitter();
    child.kill = () => true;
    const spawned = t.mock.method(processHelpers, 'spawnCommand', () => {
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    });
    const lines = captureLogs(t);

    await runBotCli(f.bot, ['start', ...(foreground ? ['--foreground'] : [])]);

    assert.equal(spawned.mock.callCount(), foreground ? 1 : 0);
    assert.equal(ensured.mock.callCount(), foreground ? 0 : 1);
    assert.equal(started.mock.callCount(), foreground ? 0 : 1);
    assert.equal(saved.mock.callCount(), foreground ? 0 : 1);
    if (!foreground) {
      assert.ok(lines.includes(`Manifest: http://bot.example.test:${port}/manifest`));
      assert.deepEqual(started.mock.calls[0].arguments, [context, context.botEcosystemFile]);
    }
    const listener = await listenOnPort(t, port);
    assert.equal(listener.server.listening, true, 'The CLI probe must not hold the runtime port.');
  });
}

test('starting an already managed bot is idempotent even while its port is occupied', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const occupied = await listenOnPort(t);
  cliConfig.writeConfig(context, cliConfig.marketplaceConfig(context, { servePort: occupied.port }));
  t.mock.method(pm2, 'findProcess', () => ({ pid: 123, pm2_env: { status: 'online' } }));
  t.mock.method(pm2, 'ensurePm2ForStart', () => assert.fail('must not launch a second instance'));
  t.mock.method(pm2, 'startOrRestart', () => assert.fail('must not restart'));
  const lines = captureLogs(t);
  await runBotCli(f.bot, ['start']);
  assert.match(lines.join('\n'), /rodando/);
  assert.doesNotMatch(lines.join('\n'), /Manifest:/);
  assert.equal(occupied.server.listening, true);
});

test('marketplace restart stops only its managed process before probing and keeps its keys', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const own = await listenOnPort(t);
  const config = cliConfig.marketplaceConfig(context, { servePort: own.port });
  cliConfig.writeConfig(context, config);
  const identity = keys.loadOrCreateBotKeys(config.botDir);
  const commands = mockManagedProcess(t, context, () => own.server.close());
  const lines = captureLogs(t);

  await runBotCli(f.bot, ['restart']);

  const operations = commands.map((args) => args[0]);
  assert.ok(operations.indexOf('stop') < operations.indexOf('startOrRestart'));
  assert.equal(operations.filter((command) => command === 'stop').length, 1);
  assert.equal(operations.filter((command) => command === 'startOrRestart').length, 1);
  assert.ok(operations.includes('save'));
  assert.match(lines.join('\n'), /reiniciado/);
  assert.deepEqual(keys.loadOrCreateBotKeys(config.botDir), identity);
});

test('fresh restart of a stopped marketplace bot checks the free port and recreates only its process', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const config = cliConfig.marketplaceConfig(context, { servePort: await unusedPort(t) });
  cliConfig.writeConfig(context, config);
  const identity = keys.loadOrCreateBotKeys(config.botDir);
  const commands = mockManagedProcess(t, context, () => assert.fail('the bot is already stopped'), 'stopped');
  captureLogs(t);

  await runBotCli(f.bot, ['restart', '--fresh']);

  assert.equal(commands.some((args) => args[0] === 'stop'), false);
  assert.deepEqual(commands.find((args) => args[0] === 'delete'), ['delete', context.processName]);
  assert.ok(commands.some((args) => args[0] === 'startOrRestart'));
  assert.deepEqual(keys.loadOrCreateBotKeys(config.botDir), identity);
});

test('restart never treats a foreign listener as its own, even after stopping the managed process', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  const own = await listenOnPort(t);
  const other = await listenOnPort(t);
  const config = cliConfig.marketplaceConfig(context, { servePort: other.port });
  cliConfig.writeConfig(context, config);
  const before = fs.readFileSync(context.configFile);
  const commands = mockManagedProcess(t, context, () => own.server.close());
  const lines = captureLogs(t);

  await assert.rejects(runBotCli(f.bot, ['restart', '--fresh']), /em uso por um bot ou outro/);

  assert.equal(own.server.listening, false);
  assert.equal(other.server.listening, true);
  assert.equal(commands.some((args) => ['startOrRestart', 'save', 'delete'].includes(args[0])), false);
  assert.deepEqual(fs.readFileSync(context.configFile), before);
  assert.doesNotMatch(lines.join('\n'), /reiniciado/);
});

test('restart stops on a managed-process stop error instead of claiming a port conflict or success', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state });
  const context = cliConfig.createCliContext(f.bot);
  cliConfig.writeConfig(context, cliConfig.marketplaceConfig(context, { servePort: await unusedPort(t) }));
  mockManagedProcess(t, context, () => { throw new Error('fixture PM2 stop failure'); });
  const lines = captureLogs(t);
  await assert.rejects(runBotCli(f.bot, ['restart']), /fixture PM2 stop failure/);
  assert.doesNotMatch(lines.join('\n'), /reiniciado/);
});

test('foreground crashes are reported as failures rather than successful exits', async (t) => {
  const f = fixture(t);
  withEnv(t, { MONKY_BOT_CLI_HOME: f.state, BOT_TOKEN: 'fixture-token' });
  const context = cliConfig.createCliContext(f.bot);
  cliConfig.writeConfig(context, cliConfig.manualConfig(context, { tokenEnv: 'BOT_TOKEN' }));
  const child = new EventEmitter();
  child.kill = () => true;
  t.mock.method(processHelpers, 'spawnCommand', () => {
    queueMicrotask(() => child.emit('exit', null, 'SIGSEGV'));
    return child;
  });
  await assert.rejects(lifecycle.startCommand(context, ['--foreground']), /terminated unexpectedly.*SIGSEGV/);
});

test('CLI configuration follows nickname limits and accepts IPv6 without accepting host ports', (t) => {
  const f = fixture(t);
  const context = cliConfig.createCliContext(f.bot, { MONKY_BOT_CLI_HOME: f.state });
  assert.throws(() => cliConfig.validateBotName('x'), /at least 2/);
  assert.throws(() => cliConfig.validateBotName('x'.repeat(33)), /at most 32/);
  assert.equal(cliConfig.validateBotName('x'.repeat(32)), 'x'.repeat(32));
  const longLabel = { ...context, displayName: 'x'.repeat(31) + '\uD83D\uDE03' };
  assert.equal(cliConfig.manualConfig(longLabel).botName, 'x'.repeat(31));
  assert.equal(cliConfig.manualConfig({ ...context, displayName: 'x' }).botName, 'x Bot');
  for (const host of ['localhost', 'bot.example.test', '127.0.0.1', '2001:db8::1', '[2001:db8::1]']) {
    assert.equal(cliConfig.validatePublicHost(host), host);
  }
  for (const host of ['bot.example.test:7780', '[::1]:7780', 'https://bot.example.test', '[127.0.0.1]', 'bot/path']) {
    assert.throws(() => cliConfig.validatePublicHost(host), /without a scheme or port/);
  }
});
