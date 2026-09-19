const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const shared = require('@monky/shared');
const { BotClient } = require('../dist');
const { addBotFeature, askBotFeature, featureProjectFiles, validateFeature, validateFeatures } = require('../dist/tooling/features');
const { featureRegistry } = require('../dist/tooling/featureTemplates');
const prompts = require('../dist/cli/prompts');
const { runSdkTools } = require('../dist/tools');
const bundle = require('../dist/tooling/bundle');
const toolingProcess = require('../dist/tooling/process');

function fixture(t) {
  const cwd = process.cwd();
  const root = fs.mkdtempSync(path.join(__dirname, '.sdk-authoring-'));
  const features = [{ kind: 'command', name: 'ping' }];
  const manifest = {
    name: 'authoring-fixture', version: '1.0.0',
    dependencies: { '@monky/bot-sdk': '*' },
    monkyBot: { entry: 'dist/index.js', files: ['dist'], cliName: 'authoring-fixture' },
    monkyBotDevelopment: { version: 1, features },
  };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const [file, source] of Object.entries(featureProjectFiles(features))) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  const previous = {};
  for (const [key, value] of Object.entries({
    MONKY_BOT_SDK_HOME: path.join(root, 'sdk-profile'), MONKY_BOT_CLI_HOME: path.join(root, 'bot-profiles'),
    MONKY_BOT_LOCALE: undefined, MONKY_LANG: undefined, LANG: undefined, LC_ALL: undefined,
    LC_MESSAGES: undefined, LANGUAGE: undefined, CI: undefined,
  })) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const output = [];
  t.mock.method(console, 'log', (...values) => output.push(values.join(' ')));
  t.after(() => {
    process.chdir(cwd);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { root, manifest, features, output };
}

function tty(t, enabled) {
  for (const stream of [process.stdin, process.stdout]) {
    const previous = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { configurable: true, value: enabled });
    t.after(() => previous ? Object.defineProperty(stream, 'isTTY', previous) : delete stream.isTTY);
  }
}

function choices(t, values) {
  const remaining = [...values], questions = [];
  t.mock.method(prompts, 'askCliChoice', async (locale, question, options) => {
    questions.push({ locale, question });
    assert.ok(remaining.length, `Unexpected question: ${question}`);
    const value = remaining.shift();
    if (value === null) throw new prompts.CliPromptCancelled();
    assert.ok(options.some(option => option.value === value), `Missing choice: ${value}`);
    return value;
  });
  t.after(() => assert.deepEqual(remaining, []));
  return questions;
}

function sources(root) {
  const result = {};
  for (const file of fs.readdirSync(root, { recursive: true })) {
    const absolute = path.join(root, file);
    if (fs.lstatSync(absolute).isFile()) result[file] = fs.readFileSync(absolute, 'utf8');
  }
  return result;
}

test('SDK configuration persists both language tags separately from bot profiles and overrides stay temporary', async t => {
  const f = fixture(t);
  tty(t, false);
  const preferences = path.join(process.env.MONKY_BOT_SDK_HOME, 'preferences.json');
  await runSdkTools(['config', 'language']);
  assert.equal(fs.existsSync(preferences), false);
  await runSdkTools(['config', 'language', 'en-US']);
  assert.deepEqual(JSON.parse(fs.readFileSync(preferences)), { locale: 'en' });
  f.output.length = 0;
  await runSdkTools(['--help']);
  assert.match(f.output.join('\n'), /Interactive assistant/);
  await runSdkTools(['--locale', 'pt-br', '--help']);
  assert.match(f.output.at(-1), /Assistente interativo/);
  assert.deepEqual(JSON.parse(fs.readFileSync(preferences)), { locale: 'en' });
  await assert.rejects(runSdkTools(['config', 'language', 'fr']), /config language/);
  assert.deepEqual(JSON.parse(fs.readFileSync(preferences)), { locale: 'en' });
  await runSdkTools(['config', 'language', 'pt-br']);
  assert.deepEqual(JSON.parse(fs.readFileSync(preferences)), { locale: 'pt-BR' });
  assert.equal(fs.existsSync(process.env.MONKY_BOT_CLI_HOME), false);
});

test('SDK settings re-render in the new language and first-run cancellation does not create state', async t => {
  const f = fixture(t);
  tty(t, true);
  const questions = choices(t, ['language', 'en', 'back']);
  await runSdkTools(['config']);
  assert.deepEqual(questions.map(item => item.question), ['Configurações do SDK', 'Idioma / Language', 'SDK settings']);
  assert.equal(questions.at(-1).locale, 'en');
  fs.rmSync(process.env.MONKY_BOT_SDK_HOME, { recursive: true });
  questions.length = 0;
  t.mock.method(prompts, 'askCliChoice', async () => { throw new prompts.CliPromptCancelled(); });
  await runSdkTools(['menu']);
  assert.equal(fs.existsSync(process.env.MONKY_BOT_SDK_HOME), false);
  assert.match(f.output.at(-1), /cancelad/i);
});

test('SDK menu detects a project, offers authoring actions, and preserves the current working directory', async t => {
  const f = fixture(t);
  tty(t, true);
  await runSdkTools(['config', 'language', 'en']);
  const cwd = process.cwd();
  process.chdir(f.root);
  t.after(() => process.chdir(cwd));
  const questions = choices(t, ['add', 'command']);
  t.mock.method(prompts, 'askCliValue', async (_locale, _question, validate) => validate('hello'));
  let exited = false;
  const original = prompts.askCliChoice;
  t.mock.method(prompts, 'askCliChoice', async (locale, question, options, ...rest) => {
    if (fs.existsSync(path.join(f.root, 'src', 'commands', 'hello.ts'))) {
      assert.ok(options.some(option => option.value === 'compile'));
      assert.ok(options.some(option => option.value === 'cli'));
      assert.ok(options.some(option => option.value === 'doctor'));
      exited = true;
      return 'exit';
    }
    return original(locale, question, options, ...rest);
  });
  await runSdkTools([]);
  assert.equal(exited, true);
  assert.equal(process.cwd(), f.root);
  assert.equal(questions.length, 2);
});

test('all five generated features compile, register with real SDK validation, and use real interaction contracts', async t => {
  const f = fixture(t);
  tty(t, false);
  const inputs = [
    ['command', 'hello'], ['form', 'signup', '--field', 'name:text', '--field', 'age:integer',
      '--field', 'notify:boolean', '--field', 'tags:string-list', '--field', 'role:select:Reader,Writer'],
    ['selector', 'pick', '--private', '--choice', 'A', '--choice', 'B'],
    ['selector', 'poll', '--public', '--choice', 'A', '--choice', 'B'],
    ['settings'], ['screen', 'panel'],
  ];
  const originalPing = fs.readFileSync(path.join(f.root, 'src', 'commands', 'ping.ts'), 'utf8');
  for (const args of inputs) addBotFeature(f.root, await askBotFeature(args, 'en'));
  assert.equal(fs.readFileSync(path.join(f.root, 'src', 'commands', 'ping.ts'), 'utf8'), originalPing);
  fs.writeFileSync(path.join(f.root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: true, skipLibCheck: true, rootDir: 'src', outDir: 'dist' },
    include: ['src/**/*.ts'],
  }));
  const compilation = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', f.root, '--pretty', 'false'],
    { encoding: 'utf8', timeout: 60_000, shell: false, windowsHide: true });
  assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
  const registry = require(path.join(f.root, 'dist', 'bot.generated.js'));
  assert.deepEqual(registry.requestedCapabilities, ['commands', 'send_messages', 'selectors', 'miniapps']);
  assert.ok(!registry.requestedCapabilities.includes('publish_voice'));
  const bot = new BotClient({ name: 'Fixture Bot', publicKey: 'fixture-public-key', requestedCapabilities: registry.requestedCapabilities });
  const registered = [], settings = [];
  const commandMethod = bot.command.bind(bot), settingsMethod = bot.settings.bind(bot);
  bot.command = definition => { registered.push(definition); return commandMethod(definition); };
  bot.settings = definition => { settings.push(definition); return settingsMethod(definition); };
  registry.registerFeatures(bot);
  assert.deepEqual(registered.map(command => command.name), ['ping', 'hello', 'signup', 'pick', 'poll', 'panel']);
  assert.equal(settings.length, 1);
  assert.equal(shared.botSettingsDefinitionSchema.safeParse(settings[0]).success, true);
  const replies = [], forms = [], privateSelections = [], publicSelections = [], screens = [];
  const controller = new AbortController();
  const context = {
    locale: 'en', signal: controller.signal,
    reply: value => replies.push(value),
    prompt: async value => { forms.push(value); return { name: 'Alice', age: 18, notify: true, tags: ['hello'] }; },
    choose: async value => { privateSelections.push(value); return 'option1'; },
    createSelector: async value => publicSelections.push(value),
    createScreen: async value => screens.push(value),
  };
  for (const command of registered) await command.handler(context);
  assert.equal(forms.length, 1);
  assert.equal(shared.botFormSchema.safeParse(forms[0]).success, true);
  assert.equal(privateSelections.length, 1);
  assert.equal(publicSelections.length, 1);
  assert.equal(publicSelections[0].responder, 'any');
  assert.ok(publicSelections[0].expiresAt > Date.now());
  assert.ok(publicSelections[0].expiresAt <= Date.now() + 300_000);
  assert.equal(publicSelections[0].maxResponders, 50);
  assert.equal(registered.find(command => command.name === 'panel').voiceRequirement, 'joined');
  assert.equal(screens.length, 1);
  assert.ok(replies.every(reply => typeof reply.localizations.en === 'string' && typeof reply.localizations['pt-BR'] === 'string'));
  const script = /<script>([\s\S]*?)<\/script>/.exec(screens[0].html)[1];
  for (const locale of ['en', 'pt-BR']) {
    const elements = { title: {}, message: {} };
    vm.runInNewContext(script, {
      document: { getElementById: id => elements[id] },
      window: { monkyScreen: { viewer: { locale }, onState: callback => callback(screens[0].state) } },
    });
    assert.equal(elements.title.textContent, locale === 'en' ? 'Shared panel' : 'Painel compartilhado');
    assert.match(elements.message.textContent, /panel$/);
  }
  const before = replies.length;
  await registered.find(command => command.name === 'signup').handler({ ...context, prompt: async () => null });
  await registered.find(command => command.name === 'pick').handler({ ...context, choose: async () => null });
  controller.abort();
  for (const command of registered) await command.handler(context);
  assert.equal(replies.length, before);
  await bot.close();
});

test('generator rejects collisions, unknown metadata, edited registry, missing modules and unsafe names without writes', t => {
  const f = fixture(t);
  const before = sources(f.root);
  for (const name of ['../escape', 'a/b', 'a\\b', 'UPPER', 'constructor', 'nul', 'com1', 'a'.repeat(33)]) {
    assert.throws(() => addBotFeature(f.root, { kind: 'command', name }));
  }
  assert.throws(() => addBotFeature(f.root, { kind: 'command', name: 'ping' }), /unique/);
  assert.deepEqual(sources(f.root), before);
  addBotFeature(f.root, { kind: 'settings', name: 'settings' });
  const withSettings = sources(f.root);
  assert.throws(() => addBotFeature(f.root, { kind: 'settings', name: 'other' }), /one settings/);
  assert.deepEqual(sources(f.root), withSettings);
  const registry = path.join(f.root, 'src', 'bot.generated.ts');
  fs.appendFileSync(registry, '\n// custom change\n');
  const edited = sources(f.root);
  assert.throws(() => addBotFeature(f.root, { kind: 'command', name: 'other' }), /edited outside/);
  assert.deepEqual(sources(f.root), edited);
  fs.writeFileSync(registry, featureRegistry([{ kind: 'command', name: 'ping' }, { kind: 'settings', name: 'settings' }]));
  fs.unlinkSync(path.join(f.root, 'src', 'commands', 'ping.ts'));
  assert.throws(() => addBotFeature(f.root, { kind: 'command', name: 'other' }), /missing/);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, 'package.json')));
  delete manifest.monkyBotDevelopment;
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify(manifest));
  assert.throws(() => addBotFeature(f.root, { kind: 'command', name: 'other' }), /managed registry/);
});

test('generator rolls back a failed manifest replacement and leaves no partial module, registry, lock or pending files', t => {
  const f = fixture(t), before = sources(f.root), rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(f.root, 'package.json')) throw new Error('fixture manifest write denied');
    return rename(from, to);
  });
  assert.throws(() => addBotFeature(f.root, { kind: 'screen', name: 'panel' }), /manifest write denied/);
  assert.deepEqual(sources(f.root), before);
  assert.equal(fs.existsSync(path.join(f.root, 'src', 'screens')), false);
});

test('generator rejects symlinked directories and concurrent locks without touching outside files', t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'preserve');
  fs.symlinkSync(outside, path.join(f.root, 'src', 'screens'), 'junction');
  assert.throws(() => addBotFeature(f.root, { kind: 'screen', name: 'panel' }), /links/);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
  fs.writeFileSync(path.join(f.root, '.monky-sdk-add.lock'), 'another-operation');
  assert.throws(() => addBotFeature(f.root, { kind: 'command', name: 'hello' }), /operation already/);
  assert.equal(fs.readFileSync(path.join(f.root, '.monky-sdk-add.lock'), 'utf8'), 'another-operation');
});

test('feature arguments validate schemas, names, duplicates, unknown options and limits before generation', async t => {
  fixture(t);
  tty(t, false);
  for (const args of [
    ['nope'], ['command'], ['command', 'hi', 'extra'], ['command', 'hi', '--field', 'name:text'],
    ['form', 'hi', '--field', 'name:number'], ['form', 'hi', '--field', 'name:text', '--field', 'name:text'],
    ['selector', 'hi', '--public', '--private'], ['selector', 'hi', '--choice'], ['command', 'hi', '--wat'],
  ]) await assert.rejects(askBotFeature(args, 'en'));
  assert.throws(() => validateFeature({ kind: 'selector', name: 'hi', public: true, choices: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }));
  assert.throws(() => validateFeatures(Array.from({ length: 51 }, (_, index) => ({ kind: 'command', name: `c${index}` }))));
  assert.throws(() => validateFeature({ kind: 'command', name: 'hi', unsupported: true }));
  const form = await askBotFeature(['form', 'signup'], 'en');
  assert.equal(form.fields[0].type, 'text');
});

test('global SDK uses the project-local tool without updating dependencies or forwarding SDK language to bot settings', async t => {
  const f = fixture(t);
  tty(t, false);
  const sdk = path.join(f.root, 'node_modules', '@monky', 'bot-sdk');
  fs.mkdirSync(path.join(sdk, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), '{"name":"@monky/bot-sdk","version":"0.1.0"}');
  const capture = path.join(f.root, 'arguments.json');
  fs.writeFileSync(path.join(sdk, 'dist', 'tools.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`);
  const manifestBefore = fs.readFileSync(path.join(f.root, 'package.json'), 'utf8');
  await runSdkTools(['config', 'language', 'en-US']);
  await runSdkTools(['doctor', '--root', f.root]);
  assert.deepEqual(JSON.parse(fs.readFileSync(capture)), { args: ['doctor', '--locale', 'en'], cwd: f.root });
  const cwd = process.cwd();
  process.chdir(f.root);
  try {
    await runSdkTools(['cli', '--help']);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture)).args, ['cli', '--help']);
    await runSdkTools(['cli', '--locale', 'pt-BR', '--help']);
    assert.deepEqual(JSON.parse(fs.readFileSync(capture)).args, ['cli', '--help', '--locale', 'pt-BR']);
  } finally { process.chdir(cwd); }
  assert.equal(fs.readFileSync(path.join(f.root, 'package.json'), 'utf8'), manifestBefore);
});

test('create wizard connects initial features, pins a vendored SDK and generates all project files without hand-written configuration', async t => {
  const f = fixture(t);
  tty(t, true);
  const target = path.join(f.root, 'generated-bot');
  t.mock.method(bundle, 'bundleDependencies', (_root, stage) => {
    fs.mkdirSync(path.join(stage, 'node_modules', '@monky', 'bot-sdk'), { recursive: true });
  });
  t.mock.method(toolingProcess, 'runNpm', args => {
    assert.equal(args[0], 'pack');
    const vendor = args[args.indexOf('--pack-destination') + 1];
    fs.writeFileSync(path.join(vendor, 'monky-bot-sdk-fixture.tgz'), 'package fixture; real packaging is covered separately');
    return '';
  });
  choices(t, ['add', 'form', 'select', 'no', 'done', 'no']);
  const input = ['signup', 'role', 'Reader,Writer'];
  t.mock.method(prompts, 'askCliValue', async (_locale, _question, validate) => {
    assert.ok(input.length);
    return validate(input.shift());
  });
  await runSdkTools(['create', target, '--name', 'generated-bot', '--display-name', 'Generated Bot', '--locale', 'en-US']);
  assert.deepEqual(input, []);
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@monky/bot-sdk'], 'file:vendor/monky-bot-sdk-fixture.tgz');
  assert.equal(manifest.monkyBotDevelopment.version, 1);
  assert.deepEqual(manifest.monkyBotDevelopment.features.map(feature => feature.name), ['ping', 'signup']);
  assert.equal(manifest.monkyBotDevelopment.features[1].fields[0].type, 'select');
  for (const file of ['tsconfig.json', 'README.md', '.gitignore', 'src/index.ts', 'src/bot.generated.ts',
    'src/commands/ping.ts', 'src/forms/signup.ts']) assert.ok(fs.statSync(path.join(target, file)).isFile(), file);
  assert.match(fs.readFileSync(path.join(target, 'src', 'index.ts'), 'utf8'), /registerFeatures\(bot\)/);
  assert.match(fs.readFileSync(path.join(target, 'src', 'index.ts'), 'utf8'), /requestedCapabilities/);
  assert.match(fs.readFileSync(path.join(target, 'src', 'bot.generated.ts'), 'utf8'), /forms\/signup\.js/);
  assert.equal(fs.existsSync(path.join(target, 'node_modules')), false);
});

test('cancelling create after collecting project details leaves no partial directory', async t => {
  const f = fixture(t), target = path.join(f.root, 'cancelled-bot');
  tty(t, true);
  choices(t, [null]);
  await runSdkTools(['create', target, '--name', 'cancelled-bot', '--display-name', 'Cancelled Bot', '--locale', 'en-US']);
  assert.equal(fs.existsSync(target), false);
  assert.match(f.output.at(-1), /cancelled/);
});

test('form wizard stops at the real ten-field limit without offering an ignored eleventh field', async t => {
  fixture(t);
  tty(t, true);
  let names = 0, types = 0, more = 0;
  t.mock.method(prompts, 'askCliValue', async (_locale, _question, validate) => validate(`field${++names}`));
  t.mock.method(prompts, 'askCliChoice', async (_locale, question) => {
    if (question === 'Field type') { types++; return 'text'; }
    assert.equal(question, 'Add another field?');
    more++;
    return 'yes';
  });
  const feature = await askBotFeature(['form', 'profile'], 'en');
  assert.equal(feature.fields.length, 10);
  assert.equal(names, 10);
  assert.equal(types, 10);
  assert.equal(more, 9);
});
