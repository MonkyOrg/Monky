const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { runBotCli } = require('../dist/cli');
const { createCliContext } = require('../dist/cli/config');
const { readSavedCliLocale, shouldPromptCliLocale } = require('../dist/cli/locale');
const prompts = require('../dist/cli/prompts');
const { runSdkTools } = require('../dist/tools');

function fixture(t, env = {}) {
  const root = fs.mkdtempSync(path.join(__dirname, '.monky-sdk-locale-'));
  const bot = path.join(root, 'bot');
  const home = path.join(root, 'profiles');
  fs.mkdirSync(bot);
  fs.writeFileSync(path.join(bot, 'package.json'), JSON.stringify({
    name: '@example/locale-bot', version: '1.2.3',
    monkyBot: { cliName: 'locale-bot', displayName: 'Locale Bot', modes: ['manual'] },
  }));
  const previous = {};
  for (const [key, value] of Object.entries({
    MONKY_BOT_CLI_HOME: home, MONKY_BOT_LOCALE: undefined, MONKY_LANG: undefined, CI: undefined,
    LC_ALL: undefined, LC_MESSAGES: undefined, LANG: undefined, LANGUAGE: undefined, ...env,
  })) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, bot, home, profile: path.join(home, '.locale-bot'), output };
}

function tty(t, input, output) {
  for (const [stream, value] of [[process.stdin, input], [process.stdout, output]]) {
    const previous = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(stream, 'isTTY', previous);
      else delete stream.isTTY;
    });
  }
}

function answers(t, values) {
  const pending = [...values];
  const questions = [];
  t.mock.method(prompts, 'askCliChoice', async (_locale, question, choices, initial) => {
    assert.ok(pending.length, `Unexpected menu: ${question}`);
    questions.push(question);
    const value = pending.shift();
    if (value === null) throw new prompts.CliPromptCancelled();
    const selected = choices.find(choice => choice.value === (value || initial)) ?? (!value ? choices[0] : undefined);
    assert.ok(selected, `Invalid scripted choice ${value}`);
    return selected.value;
  });
  t.mock.method(readline, 'createInterface', (options) => {
    assert.equal(options.historySize, 0);
    const rl = new EventEmitter();
    rl.question = (question, callback) => {
      assert.ok(pending.length, `Unexpected prompt: ${question}`);
      questions.push(question);
      const answer = pending.shift();
      queueMicrotask(() => answer === null ? rl.emit('close') : callback(answer));
    };
    rl.close = () => rl.emit('close');
    return rl;
  });
  t.after(() => assert.deepEqual(pending, []));
  return questions;
}

test('the first real interactive access saves the language and subsequent access does not prompt', async (t) => {
  const f = fixture(t);
  tty(t, true, true);
  const questions = answers(t, ['en', 'exit', 'exit']);
  await runBotCli(f.bot, []);
  assert.equal(questions.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.profile, 'preferences.json'), 'utf8')), { locale: 'en' });
  assert.equal(fs.existsSync(path.join(f.profile, 'config.json')), false);
  assert.deepEqual(questions, ['Idioma / Language', 'Locale Bot']);
  f.output.length = 0;
  await runBotCli(f.bot, []);
  assert.equal(questions.length, 3);
  assert.equal(questions[2], 'Locale Bot');
  assert.equal(readSavedCliLocale(f.profile), 'en');
});

test('version/help and non-TTY scripts never ask or create a language preference', async (t) => {
  const f = fixture(t);
  tty(t, true, true);
  t.mock.method(readline, 'createInterface', () => assert.fail('must not prompt'));
  await runBotCli(f.bot, ['--version']);
  assert.deepEqual(f.output, ['locale-bot 1.2.3']);
  await runBotCli(f.bot, ['--help', '--locale', 'en-US']);
  assert.match(f.output.join('\n'), /GLOBAL OPTIONS/);
  assert.equal(fs.existsSync(f.home), false);
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  await runBotCli(f.bot, []);
  await runBotCli(f.bot, ['language']);
  await runBotCli(f.bot, ['setup', '--non-interactive', '--server-url', 'localhost:3000', '--locale', 'en']);
  assert.equal(fs.existsSync(path.join(f.profile, 'preferences.json')), false);
  assert.match(f.output.join('\n'), /Configuration saved/);
  assert.equal(fs.existsSync(path.join(f.profile, '.keys')), false);
});

test('the SDK launcher forwards bot CLI help instead of swallowing it as SDK help', async t => {
  const f = fixture(t);
  tty(t, false, false);
  t.mock.method(process, 'cwd', () => f.bot);
  await runSdkTools(['cli', '--help', '--locale', 'en']);
  assert.match(f.output.join('\n'), /locale-bot.*runtime CLI/);
  assert.match(f.output.join('\n'), /NON-INTERACTIVE SETUP/);
  assert.doesNotMatch(f.output.join('\n'), /create scaffolds/);
  assert.equal(fs.existsSync(f.home), false);
});

test('explicit language changes persist aliases; --locale stays invocation-local', async (t) => {
  const f = fixture(t);
  tty(t, false, false);
  t.mock.method(readline, 'createInterface', () => assert.fail('must not prompt'));
  await runBotCli(f.bot, ['language', 'en-US']);
  assert.equal(readSavedCliLocale(f.profile), 'en');
  await runBotCli(f.bot, ['--locale=pt-BR', '--help']);
  assert.match(f.output.join('\n'), /OPÇÕES GLOBAIS/);
  assert.equal(readSavedCliLocale(f.profile), 'en');
  await runBotCli(f.bot, ['language', 'pt-BR']);
  assert.equal(readSavedCliLocale(f.profile), 'pt-BR');
  await assert.rejects(runBotCli(f.bot, ['language', 'PRIVATE_INVALID_LOCALE']), /language pt-BR/);
  await assert.rejects(runBotCli(f.bot, ['--locale', 'PRIVATE_INVALID_LOCALE', '--help']), (error) =>
    !error.message.includes('PRIVATE_INVALID_LOCALE'));
  assert.equal(readSavedCliLocale(f.profile), 'pt-BR');
});

test('configuration language works without setup and never reads or rewrites bot credentials', async t => {
  const f = fixture(t);
  tty(t, false, false);
  fs.mkdirSync(f.profile, { recursive: true });
  const config = path.join(f.profile, 'config.json');
  fs.writeFileSync(config, '{leave-existing-config-alone');
  await runBotCli(f.bot, ['config', 'language', 'en-US']);
  assert.equal(readSavedCliLocale(f.profile), 'en');
  assert.match(f.output.join('\n'), /Language: en-US/);
  await runBotCli(f.bot, ['config', 'language', 'pt-br']);
  assert.equal(readSavedCliLocale(f.profile), 'pt-BR');
  await assert.rejects(runBotCli(f.bot, ['config', 'language', 'invalid']), /config language/);
  assert.equal(readSavedCliLocale(f.profile), 'pt-BR');
  assert.equal(fs.readFileSync(config, 'utf8'), '{leave-existing-config-alone');
  assert.deepEqual(fs.readdirSync(f.profile).sort(), ['config.json', 'preferences.json']);
});

test('configuration language changes the live menus and persists after reopening', async t => {
  const f = fixture(t);
  tty(t, false, false);
  await runBotCli(f.bot, ['config', 'language', 'en-US']);
  tty(t, true, true);
  const questions = answers(t, ['config', 'language', 'pt-BR', 'back', 'exit']);
  await runBotCli(f.bot, []);
  assert.deepEqual(questions, ['Locale Bot', 'Configuration', 'Idioma / Language', 'Configuração', 'Locale Bot']);
  assert.equal(readSavedCliLocale(f.profile), 'pt-BR');
  assert.equal(createCliContext(f.bot).locale, 'pt-BR');
  assert.equal(fs.existsSync(path.join(f.profile, 'config.json')), false);
});

test('cancelled or failed language changes preserve the saved choice and active context', async t => {
  const f = fixture(t);
  tty(t, false, false);
  await runBotCli(f.bot, ['config', 'language', 'en-US']);
  tty(t, true, true);
  answers(t, [null]);
  await runBotCli(f.bot, ['config', 'language']);
  assert.equal(readSavedCliLocale(f.profile), 'en');
  const context = createCliContext(f.bot);
  t.mock.method(fs, 'renameSync', () => { throw new Error('Simulated denied write'); });
  const { languageCommand } = require('../dist/cli/locale');
  await assert.rejects(languageCommand(context, ['pt-BR']), /Could not save the language/);
  assert.equal(context.locale, 'en');
  assert.equal(readSavedCliLocale(f.profile), 'en');
  assert.deepEqual(fs.readdirSync(f.profile), ['preferences.json']);
});

test('cancelled first-run language selection leaves no partial state', async (t) => {
  const f = fixture(t);
  tty(t, true, true);
  answers(t, [null]);
  await runBotCli(f.bot, []);
  assert.match(f.output.join('\n'), /cancelada/);
  assert.equal(fs.existsSync(f.home), false);
});

test('a language query under CI does not open a picker even when both streams are TTYs', async (t) => {
  const f = fixture(t, { CI: 'true' });
  tty(t, true, true);
  t.mock.method(readline, 'createInterface', () => assert.fail('CI must not prompt'));
  await runBotCli(f.bot, ['language']);
  assert.deepEqual(f.output, ['Idioma: pt-BR']);
  assert.equal(fs.existsSync(f.home), false);
});

test('automation flags, CI, redirected output and explicit environment language bypass first-run selection', (t) => {
  const f = fixture(t);
  tty(t, true, true);
  for (const args of [['setup', '--non-interactive'], ['update', '--yes'], ['update', '--check'], ['--version'],
    ['config', 'update-token', '--from-env', 'GH_TOKEN'], ['config', 'update-token', '--status']]) {
    assert.equal(shouldPromptCliLocale(f.profile, args), false);
  }
  assert.equal(shouldPromptCliLocale(f.profile, ['start'], undefined, { CI: 'true' }), false);
  assert.equal(shouldPromptCliLocale(f.profile, ['start'], undefined, { MONKY_BOT_LOCALE: 'en-US' }), false);
  assert.equal(shouldPromptCliLocale(f.profile, ['start'], undefined, { MONKY_LANG: 'en_US.UTF-8' }), false);
  assert.equal(createCliContext(f.bot, { MONKY_BOT_CLI_HOME: f.home, MONKY_BOT_LOCALE: 'en-US' }).locale, 'en');
  assert.equal(createCliContext(f.bot, { MONKY_BOT_CLI_HOME: f.home, LANG: 'en_US.UTF-8' }).locale, 'en');
  assert.equal(createCliContext(f.bot, { MONKY_BOT_CLI_HOME: f.home, MONKY_LANG: 'en-GB' }).locale, 'en');
  assert.equal(createCliContext(f.bot, { MONKY_BOT_CLI_HOME: f.home, LANGUAGE: 'fr:pt_PT.UTF-8:en' }).locale, 'pt-BR');
  assert.equal(createCliContext(f.bot, {
    MONKY_BOT_CLI_HOME: f.home, MONKY_LANG: 'en', MONKY_BOT_LOCALE: 'pt_PT@euro',
  }).locale, 'pt-BR');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  assert.equal(shouldPromptCliLocale(f.profile, ['start']), false);
});

test('explicit menus are refused in CI and command help stays noninteractive', async t => {
  const f = fixture(t, { CI: 'true' });
  tty(t, true, true);
  t.mock.method(prompts, 'askCliChoice', () => assert.fail('CI must not open a menu'));
  await assert.rejects(runBotCli(f.bot, ['menu']), /fora de CI/);
  await runBotCli(f.bot, ['setup', '--help', '--locale', 'en']);
  assert.match(f.output.join('\n'), /NON-INTERACTIVE SETUP/);
  assert.equal(fs.existsSync(f.home), false);
});

test('malformed saved preferences cannot break --version or alter the runtime configuration', async (t) => {
  const f = fixture(t);
  tty(t, false, false);
  fs.mkdirSync(f.profile, { recursive: true });
  const file = path.join(f.profile, 'preferences.json');
  fs.writeFileSync(file, '{broken');
  await runBotCli(f.bot, ['--version']);
  assert.deepEqual(f.output, ['locale-bot 1.2.3']);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('common validation failures follow the selected language without echoing invalid input', async (t) => {
  const f = fixture(t);
  tty(t, false, false);
  for (const [locale, message] of [['en', /valid ws:\/\/ or wss:\/\//], ['pt-BR', /URL ws:\/\/ ou wss:\/\/ válida/]]) {
    await assert.rejects(runBotCli(f.bot, ['--locale', locale, 'setup', '--non-interactive', '--server-url',
      'https://DO_NOT_ECHO_INVALID_INPUT.example.test']), (error) => {
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /DO_NOT_ECHO_INVALID_INPUT/);
      return true;
    });
    await assert.rejects(runBotCli(f.bot, ['--locale', locale, 'status', 'DO_NOT_ECHO_INVALID_INPUT']), (error) => {
      assert.match(error.message, locale === 'en' ? /Unknown status option/ : /Opção de status desconhecida/);
      assert.doesNotMatch(error.message, /DO_NOT_ECHO_INVALID_INPUT/);
      return true;
    });
  }
  assert.equal(fs.existsSync(f.home), false);
});

test('interactive setup retries validation in English without persisting an invocation-only locale', async (t) => {
  const f = fixture(t);
  tty(t, true, true);
  const questions = answers(t, ['', 'https://INVALID_INPUT.example.test', '', 'fixture-token', '']);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  await runBotCli(f.bot, ['--locale', 'en', 'setup']);
  assert.equal(questions.filter((question) => question.includes('Server URL')).length, 2);
  assert.match(errors.join('\n'), /valid ws:\/\/ or wss:\/\//);
  assert.doesNotMatch(errors.join('\n'), /INVALID_INPUT|fixture-token/);
  assert.equal(fs.existsSync(path.join(f.profile, 'preferences.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.profile, 'config.json'), 'utf8')).botToken, 'fixture-token');
});

test('version and explicit process choices bypass unreadable saved preferences', async (t) => {
  const f = fixture(t, { MONKY_BOT_LOCALE: 'INVALID_PRIVATE_VALUE' });
  tty(t, true, true);
  t.mock.method(readline, 'createInterface', () => assert.fail('must not prompt'));
  const file = path.join(f.profile, 'preferences.json');
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (target, ...args) => {
    assert.notEqual(target, file, 'The explicit process choice must not read preferences');
    return stat(target, ...args);
  });
  await runBotCli(f.bot, ['--version']);
  assert.deepEqual(f.output, ['locale-bot 1.2.3']);
  await runBotCli(f.bot, ['--locale', 'en-US', '--help']);
  assert.match(f.output.join('\n'), /USAGE/);
  delete process.env.MONKY_BOT_LOCALE;
  process.env.MONKY_LANG = 'en_GB.UTF-8';
  const chooser = t.mock.method(prompts, 'askCliChoice', async (locale, _question, choices) => {
    assert.equal(locale, 'en');
    assert.ok(choices.some(choice => choice.value === 'exit'));
    return 'exit';
  });
  await runBotCli(f.bot, []);
  assert.equal(chooser.mock.callCount(), 1);
  assert.equal(fs.existsSync(f.home), false);
});

test('the arrow menu nests update source and hidden GitHub credentials inside configuration', async t => {
  const f = fixture(t);
  tty(t, true, true);
  const token = 'github_pat_synthetic_menu_fixture_123456789';
  const questions = answers(t, [
    'config', 'updates', 'source', 'github', 'https://github.com/example/private-fixture',
    'locale-bot-{version}.tgz', 'paste', token, 'back', 'back', 'exit',
  ]);
  await runBotCli(f.bot, ['--locale', 'en']);
  assert.ok(questions.includes('Configuration'));
  assert.ok(questions.includes('Configuration > Updates'));
  assert.ok(questions.some(question => question.includes('hidden input')));
  assert.equal(questions.some(question => question.includes('Variable name')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.profile, 'update-source.json'))).releases.url,
    'https://github.com/example/private-fixture/releases');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.profile, 'update-credentials.json'))).token, token);
  assert.equal(fs.existsSync(path.join(f.profile, 'config.json')), false, 'Update configuration does not reset or invent a bot connection');
  assert.match(f.output.join('\n'), /https:\/\/github.com\/settings\/personal-access-tokens\/new/);
  assert.equal(f.output.join('\n').includes(token), false);
});

test('malformed preferences are reported without blocking read-only help or noninteractive setup', async (t) => {
  const f = fixture(t, { LANG: 'en_US.UTF-8' });
  tty(t, true, true);
  fs.mkdirSync(f.profile, { recursive: true });
  const file = path.join(f.profile, 'preferences.json');
  const contents = '{DO_NOT_ECHO_PRIVATE_CONTENT';
  fs.writeFileSync(file, contents);
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  t.mock.method(readline, 'createInterface', () => assert.fail('must not prompt'));
  await runBotCli(f.bot, ['--help']);
  assert.match(f.output.join('\n'), /USAGE/);
  await runBotCli(f.bot, ['setup', '--non-interactive', '--server-url', 'localhost:3000']);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('\n'), /Warning:.*invalid JSON/);
  assert.doesNotMatch(warnings.join('\n'), /DO_NOT_ECHO_PRIVATE_CONTENT/);
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
  assert.equal(fs.existsSync(path.join(f.profile, 'config.json')), true);
  assert.equal(fs.existsSync(path.join(f.profile, '.keys')), false);
});

test('interactive access never silently replaces invalid preferences but an explicit language can repair them', async (t) => {
  const f = fixture(t, { LANG: 'en' });
  tty(t, true, true);
  fs.mkdirSync(f.profile, { recursive: true });
  const file = path.join(f.profile, 'preferences.json');
  const contents = '{broken';
  fs.writeFileSync(file, contents);
  t.mock.method(readline, 'createInterface', () => assert.fail('must not prompt over an invalid preference'));
  await assert.rejects(runBotCli(f.bot, []), /invalid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
  await runBotCli(f.bot, ['language', 'en_US.UTF-8']);
  assert.equal(readSavedCliLocale(f.profile), 'en');
  assert.deepEqual(fs.readdirSync(f.profile), ['preferences.json']);
});

test('failed atomic language writes preserve the previous preference and remove temporary files', async (t) => {
  const f = fixture(t);
  tty(t, false, false);
  await runBotCli(f.bot, ['language', 'en']);
  const file = path.join(f.profile, 'preferences.json');
  const previous = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('DO_NOT_ECHO_PRIVATE_RENAME_ERROR'), { code: 'EACCES' });
  });
  await assert.rejects(runBotCli(f.bot, ['language', 'pt-BR']), (error) => {
    assert.match(error.message, /preferência anterior foi preservada/);
    assert.doesNotMatch(error.message, /DO_NOT_ECHO_PRIVATE_RENAME_ERROR/);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  assert.deepEqual(fs.readdirSync(f.profile), ['preferences.json']);
});

test('saved preferences reject invalid shapes and oversized files without echoing contents', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.profile, { recursive: true });
  const file = path.join(f.profile, 'preferences.json');
  for (const input of ['[]', 'null', '"DO_NOT_ECHO"', '{"locale":"DO_NOT_ECHO"}', ' '.repeat(1025)]) {
    fs.writeFileSync(file, input);
    assert.throws(() => readSavedCliLocale(f.profile), (error) => {
      assert.match(error.message, /CLI language preference/);
      assert.doesNotMatch(error.message, /DO_NOT_ECHO/);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), input);
  }
});
