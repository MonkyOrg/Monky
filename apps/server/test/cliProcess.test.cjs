const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { stripVTControlCharacters } = require('node:util');
const processHelpers = require('../dist/cli/process');
const pm2 = require('../dist/cli/pm2');
const prompts = require('../dist/cli/prompts');
const targets = require('../dist/cli/target');
const onlineUsers = require('../dist/cli/onlineUsers');
const registry = require('../dist/cli/registry');
const { destroyCommand } = require('../dist/cli/commands/destroy');
const { getCliLanguage, setCliLanguage, t: translate } = require('../dist/cli/i18n');

const isWindows = process.platform === 'win32';

// Every character cmd.exe would have reparsed: separators, quotes, escapes,
// redirections and a variable that exists in the child's environment.
const TRICKY_ARGS = [
  'data dir with spaces',
  'say "hi" and \'bye\'',
  '%MONKY_PROCESS_FIXTURE%',
  '100%',
  'a & echo injected',
  'a | more',
  'caret ^ and <angle> (parens)',
  '',
  'trailing backslash \\',
];

/** Prints the arguments it received as JSON, for a test to compare. */
const PRINTER = 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n';

/** The shim npm writes for a global command (cmd-shim 6), naming `relative` from its own folder. */
function npmShim(relative) {
  return [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relative}" %*`, '',
  ].join('\r\n');
}

/** The shim npm wrote before, which pnpm still writes: `node.exe` beside it, else `node` from PATH. */
function classicShim(relative, nodePath) {
  return [
    '@SETLOCAL',
    ...(nodePath ? ['@IF NOT DEFINED NODE_PATH (', `  @SET "NODE_PATH=${nodePath}"`, ') ELSE (',
      `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`, ')'] : []),
    '@IF EXIST "%~dp0\\node.exe" (', `  "%~dp0\\node.exe"  "%~dp0\\${relative}" %*`, ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%', `  node  "%~dp0\\${relative}" %*`, ')', '',
  ].join('\r\n');
}

/** What Volta writes for each command a package installs. */
const VOLTA_SHIM = '@echo off\nvolta run %~n0 %*\n';

function temporaryRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function writeFile(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const nodeProgram = (script) => ({ kind: 'program', command: process.execPath, args: [script] });

/** One folder for each way pm2 gets installed on Windows, each with the `pm2.cmd` its tool writes. */
function windowsLayouts(root) {
  const layouts = {};
  // npm keeps the package beside its shim, in the global prefix.
  layouts.npm = path.join(root, 'npm prefix');
  layouts.npmEntry = writeFile(path.join(layouts.npm, 'node_modules', 'pm2', 'bin', 'pm2'), PRINTER);
  writeFile(path.join(layouts.npm, 'pm2.cmd'), npmShim('node_modules\\pm2\\bin\\pm2'));
  // An npm shim naming a package elsewhere.
  layouts.npmElsewhere = path.join(root, 'npm lib & 100%');
  layouts.npmElsewhereEntry = writeFile(path.join(layouts.npmElsewhere, 'lib', 'node_modules', 'pm2', 'bin', 'pm2'), PRINTER);
  writeFile(path.join(layouts.npmElsewhere, 'pm2.cmd'), npmShim('lib\\node_modules\\pm2\\bin\\pm2'));
  // pnpm: the package in its global folder, with NODE_PATH set by the shim.
  layouts.pnpm = path.join(root, 'pnpm');
  layouts.pnpmEntry = writeFile(path.join(layouts.pnpm, 'global', '5', 'node_modules', 'pm2', 'bin', 'pm2'), PRINTER);
  writeFile(path.join(layouts.pnpm, 'pm2.cmd'),
    classicShim('global\\5\\node_modules\\pm2\\bin\\pm2', `${layouts.pnpm}\\global\\5\\.pnpm\\node_modules`));
  // pnpm writing the path of a fixed node.exe.
  layouts.pnpmNode = path.join(root, 'pnpm fixed node');
  layouts.pnpmNodeEntry = writeFile(path.join(layouts.pnpmNode, 'global', '5', 'node_modules', 'pm2', 'bin', 'pm2'), PRINTER);
  writeFile(path.join(layouts.pnpmNode, 'pm2.cmd'),
    `@SETLOCAL\r\n@"${path.join(root, 'nodejs', 'node.exe')}"  "%~dp0\\global\\5\\node_modules\\pm2\\bin\\pm2" %*\r\n`);
  // Yarn 1: its global bin calls the shim in Data\global\node_modules\.bin, which names the package.
  const yarn = path.join(root, 'Yarn');
  layouts.yarnEntry = writeFile(path.join(yarn, 'Data', 'global', 'node_modules', 'pm2', 'bin', 'pm2'), PRINTER);
  writeFile(path.join(yarn, 'Data', 'global', 'node_modules', '.bin', 'pm2.cmd'), classicShim('..\\pm2\\bin\\pm2'));
  layouts.yarn = path.join(yarn, 'bin');
  writeFile(path.join(layouts.yarn, 'pm2.cmd'), '@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\pm2.cmd"   %*\r\n');
  // A shim handing over to another through `cmd /C`.
  layouts.cmdChain = path.join(root, 'cmd chain');
  writeFile(path.join(layouts.cmdChain, 'pm2.cmd'), '@SETLOCAL\r\n@cmd /C "%~dp0\\..\\npm prefix\\pm2.cmd" %*\r\n');
  // Volta: `volta run pm2`, with volta.exe installed in another folder on PATH.
  layouts.voltaBin = path.join(root, 'Volta', 'bin');
  writeFile(path.join(layouts.voltaBin, 'pm2.cmd'), VOLTA_SHIM);
  layouts.voltaInstall = path.join(root, 'Program Files', 'Volta');
  layouts.voltaExe = writeFile(path.join(layouts.voltaInstall, 'volta.exe'));
  return layouts;
}

/** Resolves as Windows would, on any system, without the Node folder of the machine running the test. */
const resolveIn = (root) => (env, command = 'pm2') =>
  processHelpers.resolveExecutable(command, env, 'win32', path.join(root, 'no node here'));

test('Windows finds pm2 where cmd.exe would and runs the program behind each kind of shim, without a shell', (t) => {
  const root = temporaryRoot(t, 'monky-resolve-');
  const layouts = windowsLayouts(root);
  const resolve = resolveIn(root);
  const join = (...directories) => directories.join(path.delimiter);

  assert.deepEqual(resolve({ PATH: layouts.npm }), nodeProgram(layouts.npmEntry), 'npm: the package beside the shim');
  // A copied Windows environment keeps the variable's own spelling.
  assert.deepEqual(resolve({ Path: layouts.npm }), nodeProgram(layouts.npmEntry));
  assert.deepEqual(resolve({ PATH: layouts.npmElsewhere }), nodeProgram(layouts.npmElsewhereEntry), 'npm: the shim is read');
  assert.deepEqual(resolve({ PATH: layouts.pnpm }), nodeProgram(layouts.pnpmEntry), 'pnpm');
  assert.deepEqual(resolve({ PATH: layouts.pnpmNode }), nodeProgram(layouts.pnpmNodeEntry), 'pnpm with a fixed node.exe');
  assert.deepEqual(resolve({ PATH: layouts.yarn }), nodeProgram(layouts.yarnEntry), 'Yarn: the chained shim is followed');
  assert.deepEqual(resolve({ PATH: layouts.cmdChain }), nodeProgram(layouts.npmEntry), 'cmd /C naming another shim');
  assert.deepEqual(resolve({ PATH: join(layouts.voltaBin, layouts.voltaInstall) }),
    { kind: 'program', command: layouts.voltaExe, args: ['run', 'pm2'] }, 'Volta: through volta.exe');

  const executables = path.join(root, 'executables');
  const exe = writeFile(path.join(executables, 'pm2.exe'));
  assert.deepEqual(resolve({ PATH: executables }), { kind: 'program', command: exe, args: [] }, 'an executable runs as is');

  // PATH order decides, as in the operator's own shell.
  assert.equal(resolve({ PATH: join(layouts.voltaBin, layouts.voltaInstall, layouts.npm) }).command, layouts.voltaExe);
  assert.deepEqual(resolve({ PATH: join(layouts.npm, layouts.voltaBin, layouts.voltaInstall) }), nodeProgram(layouts.npmEntry));
  // So does PATHEXT, within one folder.
  const both = path.join(root, 'both');
  const bothExe = writeFile(path.join(both, 'pm2.exe'));
  const bothCmd = writeFile(path.join(both, 'pm2.cmd'), '@echo off\r\n"%~dp0\\launcher.exe" --wrapped %*\r\n');
  assert.deepEqual(resolve({ PATH: both }), { kind: 'program', command: bothExe, args: [] });
  assert.deepEqual(resolve({ PATH: both, PATHEXT: '.CMD;.EXE' }), { kind: 'script', script: bothCmd });

  // cmd.exe also searches the current directory, and relative PATH entries
  // resolve against it: a file left there must never run as pm2.
  const cwd = process.cwd();
  try {
    process.chdir(root);
    assert.equal(resolve({ PATH: 'npm prefix' }), null, 'a relative PATH entry');
    process.chdir(layouts.npm);
    assert.equal(resolve({ PATH: path.join(root, 'empty') }), null, 'the current directory');
  } finally {
    process.chdir(cwd);
  }

  assert.equal(resolve({ PATH: path.join(root, 'empty') }), null, 'nothing installed');
  assert.equal(processHelpers.commandInstalled('pm2', { PATH: join(layouts.voltaBin, layouts.voltaInstall) }, 'win32'), true);
  assert.deepEqual(processHelpers.resolveExecutable('pm2', { PATH: layouts.npm }, 'linux'),
    { kind: 'program', command: 'pm2', args: [] }, 'POSIX runs the command by name');
});

test('a script this CLI cannot read is still found, so it runs through cmd.exe instead of counting as a missing pm2', (t) => {
  const root = temporaryRoot(t, 'monky-scripts-');
  const layouts = windowsLayouts(root);
  const resolve = resolveIn(root);
  const unreadable = { 'Volta without volta.exe on PATH': layouts.voltaBin };
  const add = (name, folder, content, files = {}) => {
    const directory = path.join(root, folder);
    writeFile(path.join(directory, 'pm2.cmd'), content);
    for (const [file, text] of Object.entries(files)) writeFile(path.join(directory, file), text);
    unreadable[name] = directory;
  };
  add('a shim whose package is gone', 'gone', npmShim('lib\\node_modules\\pm2\\bin\\pm2'));
  add('a launcher built from other variables', 'variable', '@echo off\r\n"%NODE_EXE%" "%PM2_ENTRY%" %*\r\n');
  add('Node options that running the file directly would drop', 'options',
    '@node --inspect "%~dp0\\pm2.js" %*\r\n', { 'pm2.js': PRINTER });
  add('branches running different files', 'branches',
    '@IF EXIST x (\r\n  node "%~dp0\\a.js" %*\r\n) ELSE (\r\n  node "%~dp0\\b.js" %*\r\n)\r\n', { 'a.js': PRINTER, 'b.js': PRINTER });
  add('a shim calling itself', 'loop', '@"%~dp0\\pm2.cmd" %*\r\n');

  for (const [name, directory] of Object.entries(unreadable)) {
    assert.deepEqual(resolve({ PATH: directory }), { kind: 'script', script: path.join(directory, 'pm2.cmd') }, name);
    assert.equal(processHelpers.commandInstalled('pm2', { PATH: directory }, 'win32'), true, name);
  }
});

test('npm is the one running this CLI, else the one cmd.exe finds, else the one shipped with this Node', (t) => {
  const root = temporaryRoot(t, 'monky-npm-');
  const nodeDirectory = path.join(root, 'nodejs');
  const bundled = writeFile(path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  // Node's own npm.cmd is not a plain shim: it prefers an npm installed in the prefix.
  writeFile(path.join(nodeDirectory, 'npm.cmd'),
    '@ECHO OFF\r\nSETLOCAL\r\nSET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n');
  const resolve = (env, directory = nodeDirectory) => processHelpers.resolveExecutable('npm', env, 'win32', directory);

  assert.deepEqual(resolve({ PATH: nodeDirectory }), nodeProgram(bundled), 'npm.cmd beside npm-cli.js');
  assert.deepEqual(resolve({ PATH: '' }), nodeProgram(bundled), 'none on PATH: the npm of this Node');
  const volta = path.join(root, 'Volta');
  const voltaNpm = writeFile(path.join(volta, 'npm.exe'));
  assert.deepEqual(resolve({ PATH: [volta, nodeDirectory].join(path.delimiter) }),
    { kind: 'program', command: voltaNpm, args: [] }, 'an npm.exe first on PATH, as Volta installs it');
  const running = writeFile(path.join(root, 'running', 'npm-cli.js'));
  assert.deepEqual(resolve({ PATH: volta, npm_execpath: running }), nodeProgram(running), 'the npm running an npm script');
  const yarn = writeFile(path.join(root, 'yarn', 'bin', 'yarn.js'));
  assert.deepEqual(resolve({ PATH: nodeDirectory, npm_execpath: yarn }), nodeProgram(bundled),
    'Yarn 1 sets npm_execpath to itself, which is not npm');
  assert.equal(resolve({ PATH: '' }, path.join(root, 'no npm')), null);
});

/**
 * A fake `pm2` that prints the arguments it received as JSON, laid out as npm
 * installs it: the package and its shim on Windows, an executable script on
 * POSIX.
 */
function fakeToolPrefix(t) {
  const root = temporaryRoot(t, 'monky-process-');
  const prefix = path.join(root, 'global & npm %prefix%');
  const entry = writeFile(path.join(prefix, 'node_modules', 'pm2', 'bin', 'pm2'), PRINTER);
  writeFile(path.join(prefix, 'pm2.cmd'), npmShim('node_modules\\pm2\\bin\\pm2'));
  if (!isWindows) {
    fs.writeFileSync(path.join(prefix, 'pm2'), `#!${process.execPath}\n${PRINTER}`, { mode: 0o755 });
  }
  return { root, prefix, entry };
}

function childEnvironment(directories) {
  const env = { ...process.env, MONKY_PROCESS_FIXTURE: 'expanded-by-a-shell' };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') delete env[key];
  }
  env.PATH = directories.join(path.delimiter);
  return env;
}

test('arguments reach the tool exactly as given, with nothing reparsed by a shell', (t) => {
  const { root, prefix } = fakeToolPrefix(t);
  const cwd = path.join(root, 'work dir & 50%');
  fs.mkdirSync(cwd);
  const result = processHelpers.runSync('pm2', TRICKY_ARGS, { encoding: 'utf8', cwd, env: childEnvironment([prefix]) });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const received = JSON.parse(result.stdout);
  assert.deepEqual(received.args, TRICKY_ARGS);
  assert.equal(fs.realpathSync(received.cwd), fs.realpathSync(cwd));
});

test('streamed runs pass the same arguments, and a missing tool is reported as not installed', async (t) => {
  const { root, prefix } = fakeToolPrefix(t);
  const child = processHelpers.runAsync('pm2', TRICKY_ARGS, { env: childEnvironment([prefix]) });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(output).args, TRICKY_ARGS);

  const previousPath = Object.keys(process.env).filter((key) => key.toUpperCase() === 'PATH')
    .map((key) => [key, process.env[key]]);
  t.after(() => {
    for (const [key] of Object.entries(process.env).filter(([key]) => key.toUpperCase() === 'PATH')) delete process.env[key];
    for (const [key, value] of previousPath) process.env[key] = value;
  });
  for (const [key] of previousPath) delete process.env[key];
  process.env.PATH = root;
  assert.equal(processHelpers.commandSucceeds('pm2', ['--version']), false);
  assert.equal(processHelpers.commandInstalled('pm2'), false);
  assert.equal(processHelpers.runSync('pm2', ['--version']).error?.code, 'ENOENT');
  process.env.PATH = prefix;
  assert.equal(processHelpers.commandSucceeds('pm2', ['--version']), true);
  assert.equal(processHelpers.commandInstalled('pm2'), true);
});

test('on Windows the shims of npm, pnpm and Yarn run their package directly, with every argument as given',
  { skip: !isWindows && 'Windows only' }, (t) => {
    const root = temporaryRoot(t, 'monky-shims-');
    const layouts = windowsLayouts(root);
    for (const name of ['npmElsewhere', 'pnpm', 'pnpmNode', 'yarn', 'cmdChain']) {
      const result = processHelpers.runSync('pm2', TRICKY_ARGS, { encoding: 'utf8', env: childEnvironment([layouts[name]]) });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout).args, TRICKY_ARGS, name);
    }
  });

function useEnglish(t) {
  const previous = getCliLanguage();
  setCliLanguage('en');
  t.after(() => setCliLanguage(previous));
}

test('the cmd.exe command line quotes every argument and writes % as what cmd.exe expands back to %', (t) => {
  useEnglish(t);
  const script = 'C:\\tools & 100%\\pm2.cmd';
  assert.equal(processHelpers.scriptCommandLine(script, ['%PATH%', 'a & b', '^(x)', 'end \\', '']),
    '""C:\\tools & 100%%cd:~,%\\pm2.cmd" "%%cd:~,%PATH%%cd:~,%" "a & b" "^(x)" "end \\\\" """');
  for (const unsafe of ['say "hi"', 'line\nbreak', 'tab\tstop']) {
    assert.throws(() => processHelpers.scriptCommandLine(script, ['ok', unsafe]), {
      message: translate('process.unsafeScriptArgument', { script, argument: JSON.stringify(unsafe) }),
    });
  }
});

test('on Windows a script this CLI cannot read runs through cmd.exe with every argument escaped, or is refused',
  { skip: !isWindows && 'Windows only' }, (t) => {
    useEnglish(t);
    const root = temporaryRoot(t, 'monky-batch-');
    const directory = path.join(root, 'dir with & and 100% (x) ^ !bang!');
    const printer = writeFile(path.join(root, 'printer.js'), PRINTER);
    const script = writeFile(path.join(directory, 'pm2.cmd'),
      `@echo off\r\nset "NODE_EXE=${process.execPath}"\r\nset "PRINTER=${printer}"\r\n"%NODE_EXE%" "%PRINTER%" %*\r\n`);
    const env = childEnvironment([directory]);
    assert.deepEqual(processHelpers.resolveExecutable('pm2', env), { kind: 'script', script });
    const args = [
      ...TRICKY_ARGS.filter((arg) => !arg.includes('"')), '%%', '%cd:~,%', 'a && b || c', '!MONKY_PROCESS_FIXTURE!',
      'semi;colon,comma=eq', 'unicode ção 日本', '^^', '%~dp0', '%1', '%*', '%PATH:~0,3%', 'two trailing \\\\',
    ];
    const result = processHelpers.runSync('pm2', args, { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).args, args);
    for (const unsafe of ['say "hi"', 'line\nbreak']) {
      assert.throws(() => processHelpers.runSync('pm2', [unsafe], { env }), {
        message: translate('process.unsafeScriptArgument', { script, argument: JSON.stringify(unsafe) }),
      });
    }
  });

function captureOutput(t) {
  const lines = [];
  t.mock.method(console, 'log', (...values) => lines.push(stripVTControlCharacters(values.map(String).join(' '))));
  return lines;
}

test('a PM2 found but failing is told apart from a missing one, and only a missing one gets installed', (t) => {
  useEnglish(t);
  const output = captureOutput(t);
  let succeeds = false;
  let installed = true;
  t.mock.method(processHelpers, 'commandSucceeds', (command, args) => {
    assert.deepEqual([command, ...args], ['pm2', '--version']);
    return succeeds;
  });
  t.mock.method(processHelpers, 'commandInstalled', () => installed);
  const commands = [];
  t.mock.method(processHelpers, 'runSync', (command, args) => {
    commands.push([command, ...args].join(' '));
    return { status: 0, stdout: '', stderr: '' };
  });
  const stop = translate('action.stop');

  assert.equal(pm2.pm2Availability(), 'failing');
  assert.equal(pm2.isPm2Available(), false);
  assert.throws(() => pm2.ensurePm2(), {
    message: `${translate('pm2.failing', { action: translate('action.start') })} ${translate('pm2.failingHint')}`,
  });
  assert.equal(pm2.requirePm2(stop), false);
  assert.deepEqual(output, [translate('pm2.failing', { action: stop }), translate('pm2.failingHint')]);
  assert.deepEqual(commands, [], 'nothing is installed over a PM2 that is there');

  installed = false;
  output.length = 0;
  assert.equal(pm2.pm2Availability(), 'missing');
  assert.equal(pm2.requirePm2(stop), false);
  assert.deepEqual(output, [translate('pm2.notInstalled', { action: stop }), translate('pm2.installHint')]);
  pm2.ensurePm2();
  assert.deepEqual(commands, ['npm install -g pm2']);

  succeeds = true;
  assert.equal(pm2.pm2Availability(), 'available');
  assert.equal(pm2.requirePm2(stop), true);
});

/** Runs `monky destroy` on a registered server, answering DESTROY and then each confirmation in turn. */
async function runDestroy(t, availability, answers) {
  useEnglish(t);
  const root = temporaryRoot(t, 'monky-destroy-');
  const previousHome = process.env.MONKY_HOME;
  process.env.MONKY_HOME = path.join(root, 'cli profile');
  t.after(() => {
    if (previousHome === undefined) delete process.env.MONKY_HOME;
    else process.env.MONKY_HOME = previousHome;
  });
  const dataDir = path.join(root, 'server data');
  writeFile(path.join(dataDir, 'server.db'), 'kept');
  const server = registry.registerServer(dataDir, { name: 'Fixture', port: 1 });
  const output = captureOutput(t);
  const pm2Commands = [];
  const questions = [];
  t.mock.method(targets, 'resolveTargetServer', async () => server);
  t.mock.method(onlineUsers, 'countOnlineUsers', async () => null);
  t.mock.method(pm2, 'pm2Availability', () => availability);
  t.mock.method(pm2, 'findLegacyProcessFor', () => null);
  t.mock.method(processHelpers, 'runSync', (command, args) => {
    assert.equal(command, 'pm2', 'only PM2 runs');
    pm2Commands.push(args.join(' '));
    return { status: 0, stdout: '', stderr: '' };
  });
  t.mock.method(prompts, 'ask', async () => 'DESTROY');
  t.mock.method(prompts, 'confirm', async (question) => {
    questions.push(question);
    assert.ok(answers.length, `unexpected confirmation: ${question}`);
    return answers.shift();
  });
  await destroyCommand({ args: ['destroy'], dataDir, dataDirSpecified: true });
  const registered = JSON.parse(fs.readFileSync(registry.getRegistryPath(), 'utf8')).servers
    .some((entry) => entry.id === server.id);
  return {
    dataDir, output, pm2Commands, questions, registered,
    processes: [pm2.getPm2ProcessName(dataDir), pm2.getUpdaterProcessName(dataDir)],
  };
}

test('destroy keeps the data while the PM2 processes of the server may be left behind, unless the operator accepts', async (t) => {
  for (const availability of ['missing', 'failing']) {
    await t.test(`PM2 ${availability}, declined`, async (subtest) => {
      const result = await runDestroy(subtest, availability, [true, false]);
      const warning = availability === 'missing' ? 'destroy.pm2Missing' : 'destroy.pm2Failing';
      assert.ok(result.output.includes(translate(warning, { processes: result.processes.join(', ') })),
        'the processes that may be left behind are named');
      assert.deepEqual(result.questions, [translate('destroy.doubleConfirm'), translate('destroy.deleteWithoutPm2')]);
      assert.equal(fs.readFileSync(path.join(result.dataDir, 'server.db'), 'utf8'), 'kept');
      assert.equal(result.registered, true);
      assert.deepEqual(result.pm2Commands, []);
    });
  }
  await t.test('PM2 missing, accepted', async (subtest) => {
    const result = await runDestroy(subtest, 'missing', [true, true]);
    assert.equal(fs.existsSync(result.dataDir), false);
    assert.equal(result.registered, false);
    assert.deepEqual(result.pm2Commands, []);
  });
});

test('destroy removes the PM2 processes of the server, with no extra question, when PM2 runs', async (t) => {
  const result = await runDestroy(t, 'available', [true]);
  assert.deepEqual(result.questions, [translate('destroy.doubleConfirm')]);
  assert.deepEqual(result.pm2Commands, [...result.processes.map((name) => `delete ${name}`), 'save']);
  assert.equal(fs.existsSync(result.dataDir), false);
  assert.equal(result.registered, false);
});
