import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { parseQaArguments, isolatedEnvironment, runQa, repoRoot, scenarios } from './qa.js';
import { startOwnedProcess } from './qa/process.js';

const require = createRequire(import.meta.url);
const shared = require('../packages/shared/dist/index.js');
const Module = require('node:module');
const mainFile = require.resolve('../apps/client/dist-electron/main/developmentQa.js');
const processes = path.join(repoRoot, 'scripts', 'qa', 'testProcess.cjs');
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const loadMain = ipcMain => {
  const original = Module._load;
  try {
    Module._load = function(id, ...args) { return id === 'electron' ? { ipcMain } : Reflect.apply(original, this, [id, ...args]); };
    delete require.cache[mainFile];
    return require(mainFile);
  } finally { Module._load = original; }
};
const baseConfig = () => ({
  runId: randomUUID(), scenario: 'connected', smoke: true, nickname: 'QA Tester',
  server: { host: '127.0.0.1', port: 54321, name: 'QA', password: 'only-an-isolated-test-password' },
});

test('QA scenarios validate explicit production, fixture and unprepared paths', () => {
  assert.deepEqual(scenarios, [...shared.DEVELOPMENT_QA_SCENARIOS]);
  assert.equal(parseQaArguments([]).scenario, 'connected');
  assert.equal(parseQaArguments(['voice']).bot, 'sdk-fixture');
  assert.equal(parseQaArguments(['voice-receive']).bot, 'sdk-fixture');
  assert.equal(parseQaArguments(['tool-consent', '--bot=fixture']).bot, 'sdk-fixture');
  const production = parseQaArguments(['music', '--bot-root', path.join(repoRoot, 'explicit-bot'), '--smoke']);
  assert.equal(production.bot, 'production');
  assert.equal(production.smoke, true);
  for (const args of [
    ['unknown'], ['home', 'login'], ['--approve-consent'], ['music'], ['music', '--bot=fixture'],
    ['home', '--bot=fixture'], ['login', '--bot=fixture'], ['bot-install'], ['tool-consent'],
    ['--bot-root'], ['--bot-root=relative'], ['--bot=fixture', '--bot=fixture'],
    ['--bot=fixture', `--bot-root=${repoRoot}`],
    ['voice-receive', `--bot-root=${repoRoot}`],
  ]) assert.throws(() => parseQaArguments(args), Error, args.join(' '));
  const valid = baseConfig();
  assert.equal(shared.developmentQaConfigSchema.safeParse(valid).success, true);
  for (const config of [
    { ...valid, server: { ...valid.server, host: '0.0.0.0' } },
    { ...valid, server: { ...valid.server, password: 'short' } },
    { ...valid, scenario: 'music', bot: { kind: 'sdk-fixture', manifestUrl: 'http://127.0.0.1:54322/manifest' } },
    { ...valid, scenario: 'voice' },
    { ...valid, scenario: 'voice-receive' },
    { ...valid, scenario: 'voice-receive', bot: { kind: 'production', manifestUrl: 'http://127.0.0.1:54322/manifest' } },
    { ...valid, bot: { kind: 'production', manifestUrl: 'https://external.invalid/manifest' } },
    { ...valid, bot: { kind: 'sdk-fixture', manifestUrl: 'http://secret@127.0.0.1:54322/manifest' } },
    { ...valid, bot: { kind: 'sdk-fixture', manifestUrl: 'http://127.0.0.1:54322/manifest?token=secret' } },
    { ...valid, token: 'must-not-be-accepted' },
  ]) assert.equal(shared.developmentQaConfigSchema.safeParse(config).success, false);
});

test('QA environment does not inherit installed profiles, credentials or Node flags', () => {
  const names = ['MONKY_QA_TEST_TOKEN', 'MONKY_HOME', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'];
  const original = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'must-not-be-inherited';
    const root = path.join(repoRoot, '.qa', 'test-environment');
    const env = isolatedEnvironment(root);
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMP', 'TEMP', 'TMPDIR', 'MONKY_HOME']) {
      assert.ok(env[name] === root || env[name].startsWith(root + path.sep), name);
    }
    assert.equal(env.MONKY_QA_TEST_TOKEN, undefined);
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
  } finally {
    for (const [name, value] of original) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test('macOS app retains system HOME for Keychain while all Monky data remains isolated', () => {
  const root = path.join(repoRoot, '.qa', 'keychain-environment');
  const env = isolatedEnvironment(root, {}, { useSystemKeychain: true, platform: 'darwin' });
  assert.equal(env.HOME, process.env.HOME || os.homedir());
  for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'XDG_DATA_HOME', 'TMP', 'TEMP', 'TMPDIR', 'MONKY_HOME']) {
    assert.ok(env[name] === root || env[name].startsWith(root + path.sep), name);
  }
  assert.equal(isolatedEnvironment(root, {}, { platform: 'darwin' }).HOME, root,
    'Node server/bot workers do not need the system Keychain.');
  for (const platform of ['win32', 'linux']) {
    assert.equal(isolatedEnvironment(root, {}, { useSystemKeychain: true, platform }).HOME, root);
  }
});

test('Main QA configuration accepts only the supervised, matching isolated development profile', async () => {
  const { loadDevelopmentQa } = loadMain({});
  const config = baseConfig();
  const root = path.join(repoRoot, '.qa', 'runs', `${config.scenario}-${config.runId}`);
  const profile = path.join(root, 'client');
  const other = path.join(root, 'other-profile');
  const filename = path.join(root, 'launch.json');
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(other);
  const envelope = { ownerPid: process.pid, config };
  const options = { packaged: false, supervised: true, appPath: path.join(repoRoot, 'apps', 'client'), profile, configFile: filename, parentPid: process.pid };
  try {
    await fs.writeFile(filename, JSON.stringify(envelope));
    assert.deepEqual(loadDevelopmentQa(options), config);
    assert.equal(loadDevelopmentQa({ ...options, packaged: true, configFile: undefined }), null);
    for (const changes of [{ packaged: true }, { supervised: false }, { profile: '' }, { profile: other }, { parentPid: -1 }]) {
      assert.throws(() => loadDevelopmentQa({ ...options, ...changes }));
    }
    await fs.writeFile(filename, JSON.stringify({ ...envelope, config: { ...config, runId: randomUUID() } }));
    assert.throws(() => loadDevelopmentQa(options), /identity/);
    await fs.writeFile(filename, 'x'.repeat(16_385));
    assert.throws(() => loadDevelopmentQa(options), /outside/);
    await fs.writeFile(filename, '{');
    assert.throws(() => loadDevelopmentQa(options), SyntaxError);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('QA IPC rejects other frames/runs and unregisters every listener across window lifecycles', () => {
  const handlers = new Map();
  const { bindDevelopmentQa } = loadMain({
    handle(name, handler) { assert.ok(!handlers.has(name)); handlers.set(name, handler); },
    removeHandler(name) { handlers.delete(name); },
  });
  const config = baseConfig();
  const contents = new EventEmitter();
  contents.mainFrame = {};
  let destroyed = false;
  const window = {
    get webContents() { if (destroyed) throw new Error('Object has been destroyed'); return contents; },
    isDestroyed: () => destroyed,
    isVisible: () => true,
  };
  contents.isCrashed = () => false;
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const messages = [];
  const sent = Object.getOwnPropertyDescriptor(process, 'send');
  const connected = Object.getOwnPropertyDescriptor(process, 'connected');
  const listenerCount = process.listenerCount('message');
  let quit = 0;
  try {
    process.send = message => messages.push(message);
    process.connected = true;
    for (let index = 0; index < 3; index++) {
      const dispose = bindDevelopmentQa(window, config, () => quit++);
      const get = handlers.get(shared.DEVELOPMENT_QA_IPC.config);
      const report = handlers.get(shared.DEVELOPMENT_QA_IPC.report);
      const state = { runId: config.runId, scenario: config.scenario, phase: 'ready', connected: true };
      assert.equal(get(event), config);
      assert.equal(get({ ...event, senderFrame: {} }), null);
      assert.equal(report({ ...event, sender: {} }, state), false);
      assert.equal(report(event, { ...state, runId: randomUUID() }), false);
      assert.equal(report(event, { ...state, scenario: 'home' }), false);
      assert.equal(report(event, { ...state, unexpected: true }), false);
      assert.equal(report(event, { ...state, botPermissions: {
        requested: ['commands'], granted: ['commands', 'publish_voice'], revision: 1,
        reviewRequired: false, reviewedBy: 'fake-owner', reviewedAt: 1,
      } }), false);
      assert.equal(report(event, state), true);
      process.emit('message', { type: 'qa-stop', runId: randomUUID() });
      assert.equal(quit, index);
      process.emit('message', { type: 'qa-stop', runId: config.runId });
      assert.equal(quit, index + 1);
      destroyed = true;
      dispose();
      destroyed = false;
      assert.equal(handlers.size, 0);
      assert.equal(contents.listenerCount('render-process-gone'), 0);
      assert.equal(process.listenerCount('message'), listenerCount);
    }
    assert.equal(messages.length, 3);
  } finally {
    if (sent) Object.defineProperty(process, 'send', sent); else delete process.send;
    if (connected) Object.defineProperty(process, 'connected', connected); else delete process.connected;
  }
});

test('owned process readiness requires the actual event and responsive IPC', async () => {
  const runId = randomUUID();
  const child = startOwnedProcess(process.execPath, [processes, 'ready', runId], { cwd: repoRoot, env: isolatedEnvironment(repoRoot), runId, label: 'ready-test', timeoutMs: 1000 });
  try {
    assert.deepEqual(await child.ready, { actualEvent: true });
    assert.deepEqual(await child.call('qa-ping'), { alive: true });
  } finally { await child.stop(); }
  assert.equal(alive(child.child.pid), false);
});

test('missing readiness and premature exit fail without leaving a child', async () => {
  for (const mode of ['no-ready', 'exit']) {
    const runId = randomUUID();
    const child = startOwnedProcess(process.execPath, [processes, mode, runId], { cwd: repoRoot, env: isolatedEnvironment(repoRoot), runId, label: mode, timeoutMs: 250 });
    await assert.rejects(child.ready, mode === 'exit' ? /exited unexpectedly \(23\)/ : /readiness timed out/);
    if (mode === 'exit') await assert.rejects(child.stop(), /exited with 23/);
    else await child.stop();
    assert.equal(alive(child.child.pid), false);
  }
});

test('invalid readiness callbacks reject and still allow clean owned shutdown', async () => {
  const runId = randomUUID();
  const child = startOwnedProcess(process.execPath, [processes, 'ready', runId], {
    cwd: repoRoot, env: isolatedEnvironment(repoRoot), runId, label: 'invalid-report', timeoutMs: 1000,
    onMessage() { throw new Error('malformed readiness'); },
  });
  try { await assert.rejects(child.ready, /malformed readiness/); } finally { await child.stop(); }
});

test('unresponsive shutdown kills only the owned tree and reports forced cleanup', { timeout: 15_000 }, async () => {
  const runId = randomUUID();
  let descendant;
  const child = startOwnedProcess(process.execPath, [processes, 'tree', runId], {
    cwd: repoRoot, env: isolatedEnvironment(repoRoot), runId, label: 'tree-test', timeoutMs: 1000,
    onMessage(message) { if (message.type === 'qa-descendant') descendant = message.pid; },
  });
  await child.ready;
  assert.ok(alive(descendant));
  await assert.rejects(child.stop(), /forced process-tree cleanup/);
  assert.equal(alive(child.child.pid), false);
  assert.equal(alive(descendant), false);
  assert.ok(alive(process.pid));
});

test('unavailable production prerequisites fail rather than choosing a fixture', async () => {
  await assert.rejects(runQa({ scenario: 'music', smoke: true, bot: 'production', botRoot: null }), /explicit bot checkout/);
  await assert.rejects(runQa(parseQaArguments(['music', '--bot-root', path.join(repoRoot, '.qa', randomUUID()), '--smoke'])), /ENOENT/);
  await assert.rejects(runQa(parseQaArguments(['music', '--bot-root', repoRoot, '--smoke'])), /production @monky\/bot/);
});

test('production without its own capability declaration fails before command registration', { timeout: 30_000 }, async () => {
  const root = path.join(repoRoot, '.qa', `invalid-production-${randomUUID()}`);
  const commands = path.join(root, 'dist', 'commands');
  let ready = false;
  await fs.mkdir(commands, { recursive: true });
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: '@monky/bot', monky: { protocolVersion: shared.PROTOCOL_VERSION },
    }));
    await fs.writeFile(path.join(commands, 'index.js'),
      "exports.registerAllCommands = () => require('node:fs').writeFileSync(require('node:path').join(__dirname, 'registered'), 'must-not-run');");
    await assert.rejects(runQa(parseQaArguments(['connected', '--bot-root', root, '--smoke']), {
      onReady() { ready = true; },
    }), error => error instanceof AggregateError &&
      error.message.includes('must export its actual requestedCapabilities') &&
      error.errors.some(cause => cause.message.includes('must export its actual requestedCapabilities')));
    assert.equal(ready, false);
    await assert.rejects(fs.access(path.join(commands, 'registered')), /ENOENT/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('real prepared Electron scenarios authenticate, seed, install or deliberately stop before the tested step', { timeout: 180_000 }, async t => {
  const ids = new Set();
  const paths = new Set();
  for (const args of [
    ['home'], ['login'], ['connected'], ['server-settings'], ['connected', '--bot=fixture'],
    ['bot-install', '--bot=fixture'], ['tool-consent', '--bot=fixture'], ['voice'], ['voice-receive'],
  ]) {
    if (t.signal.aborted) break;
    await t.test(args.join(' '), async () => {
      let observed;
      const result = await runQa(parseQaArguments([...args, '--smoke']), {
        async onReady(state) {
          observed = state;
          assert.equal(state.windowVisible, false);
          assert.ok(state.pids.every(alive));
          assert.equal((await fs.stat(path.join(state.root, 'client', 'identity.json'))).isFile(), true);
          if (process.platform === 'darwin') {
            const identity = JSON.parse(await fs.readFile(path.join(state.root, 'client', 'identity.json'), 'utf8'));
            assert.equal(identity.storage, 'safeStorage', 'Prepared macOS identity must use the real unlocked test Keychain.');
          }
          assert.ok(state.root.startsWith(path.join(repoRoot, '.qa', 'runs') + path.sep));
          assert.equal(paths.has(state.root), false);
          paths.add(state.root);
          const unauthenticated = ['home', 'login'].includes(state.scenario);
          assert.equal(state.ready.connected, !unauthenticated);
          assert.equal(state.stats.members, unauthenticated ? 0 : 1);
          assert.equal(state.stats.messages, unauthenticated ? 0 : 1);
          if (state.ready.userId) { assert.equal(ids.has(state.ready.userId), false); ids.add(state.ready.userId); }
          if (state.scenario === 'bot-install') {
            assert.equal(state.ready.botId, undefined);
            assert.equal(state.ready.botPermissions, undefined);
          } else if (state.botKind) {
            assert.equal(state.botKind, 'sdk-fixture');
            assert.equal(state.ready.commandCount, state.scenario === 'voice-receive' ? 3 : 2);
            const expected = state.scenario === 'voice' ? ['commands', 'publish_voice', 'local_execution'] :
              state.scenario === 'voice-receive' ? ['commands', 'receive_voice', 'local_execution'] : ['commands', 'local_execution'];
            assert.deepEqual(state.ready.botPermissions.requested, expected);
            assert.deepEqual(state.ready.botPermissions.granted, expected);
            assert.equal(state.ready.botPermissions.reviewRequired, false);
            assert.equal(state.ready.botPermissions.reviewedBy, state.ready.userId);
            assert.ok(state.ready.botPermissions.revision > 0);
          }
          if (['voice', 'voice-receive'].includes(state.scenario)) { assert.ok(state.ready.peers > 0); assert.equal(state.ready.muted, true); }
          if (state.scenario === 'tool-consent') {
            assert.equal(state.ready.localConsentCount, 0);
            assert.equal(state.ready.localToolStatus, 'absent');
          }
        },
      });
      assert.equal(result, observed);
      assert.ok(result.pids.every(pid => !alive(pid)));
      await assert.rejects(fs.access(result.root), /ENOENT/);
    });
  }
});

test('failure after actual readiness cleans every real child and its private run directory', { timeout: 60_000 }, async () => {
  let observed;
  await assert.rejects(runQa(parseQaArguments(['connected', '--bot=fixture', '--smoke']), {
    onReady(state) { observed = state; throw new Error('deliberate post-ready failure'); },
  }), /deliberate post-ready failure/);
  assert.ok(observed.pids.every(pid => !alive(pid)));
  await assert.rejects(fs.access(observed.root), /ENOENT/);
});

test('an attached hidden QA startup handles interruption without orphaning the real app or server', { timeout: 60_000 }, async () => {
  const result = await runQa(parseQaArguments(['connected', '--smoke']), { onReady() { process.emit('SIGINT'); } });
  assert.ok(result.pids.every(pid => !alive(pid)));
  await assert.rejects(fs.access(result.root), /ENOENT/);
});

test('interactive QA is visible before readiness and still cleans up on interruption', { timeout: 60_000 }, async () => {
  const result = await runQa(parseQaArguments(['connected']), {
    onReady(state) {
      assert.equal(state.windowVisible, true);
      assert.equal(state.ready.connected, true);
      process.emit('SIGINT');
    },
  });
  assert.ok(result.pids.every(pid => !alive(pid)));
  await assert.rejects(fs.access(result.root), /ENOENT/);
});
