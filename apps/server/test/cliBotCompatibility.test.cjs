const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { formatBotCompatibilityWarnings } = require('../dist/cli/botCompatibility');
const { getCliLanguage, setCliLanguage, t: translate } = require('../dist/cli/i18n');
const lifecycle = require('../dist/cli/commands/serverLifecycle');
const preview = require('../dist/cli/onlineUsers');
const pm2 = require('../dist/cli/pm2');
const target = require('../dist/cli/target');
const context = require('../dist/cli/context');
const health = require('../dist/cli/health');

const server = { name: 'Fixture', dataDir: path.join(__dirname, 'unused-compatibility-fixture'), port: 31415 };
const online = { pid: 1234, pm2_env: { status: 'online' } };
const pending = { protocolVersion: 16, incompatibleBots: 2, uncheckedBots: 1 };
const compatible = { protocolVersion: 16, incompatibleBots: 0, uncheckedBots: 0 };
const withoutAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function isolate(t, language = 'en') {
  const previous = getCliLanguage();
  setCliLanguage(language);
  t.after(() => setCliLanguage(previous));
  const output = [];
  t.mock.method(console, 'log', (...values) => output.push(values.join(' ')));
  t.mock.method(console, 'error', (...values) => output.push(values.join(' ')));
  t.mock.method(pm2, 'findLegacyProcessFor', () => null);
  t.mock.method(pm2, 'requirePm2', () => true);
  return output;
}

test('bot warnings are localized and compatible, unchecked and unavailable states remain distinct', async (t) => {
  for (const language of ['en', 'pt-BR']) {
    await t.test(language, (t) => {
      isolate(t, language);
      assert.deepEqual(formatBotCompatibilityWarnings(compatible), []);
      const warnings = formatBotCompatibilityWarnings(pending).map(withoutAnsi);
      assert.deepEqual(warnings, [
        translate('botCompatibility.incompatible', { count: 2, protocol: 16 }),
        translate('botCompatibility.unchecked', { count: 1, protocol: 16 }),
      ]);
      assert.deepEqual(formatBotCompatibilityWarnings(null).map(withoutAnsi), [
        translate('botCompatibility.unavailable'),
      ]);
    });
  }
});

test('aggregate status and list show per-server warnings and never query stopped processes', async (t) => {
  for (const command of ['list', 'status']) {
    await t.test(command, async (t) => {
      const output = isolate(t);
      const stopped = { ...server, name: 'Stopped', dataDir: `${server.dataDir}-stopped`, port: 31416 };
      const servers = [server, stopped];
      t.mock.method(target, 'knownServers', () => servers);
      t.mock.method(pm2, 'findPm2Process', (name) =>
        name === pm2.getPm2ProcessName(server.dataDir) ? online : { pid: 0, pm2_env: { status: 'stopped' } });
      const probe = t.mock.method(preview, 'readLocalServerPreview', async (port) => {
        assert.equal(port, server.port);
        return { userCount: 0, voiceUserCount: 0, botCompatibility: pending };
      });
      if (command === 'list') await lifecycle.listServersCommand();
      else await lifecycle.statusServerCommand({ dataDirSpecified: false });
      assert.equal(probe.mock.callCount(), 1);
      const text = withoutAnsi(output.join('\n'));
      assert.match(text, /Fixture[\s\S]*2 bot\(s\)[\s\S]*1 bot\(s\)[\s\S]*Stopped/);
      assert.ok(!text.includes(translate('botCompatibility.unavailable')));
    });
  }
});

test('watch refreshes and clears warnings, skips overlapping probes and surfaces refresh failures', async (t) => {
  const output = isolate(t);
  const frames = [];
  const signalHandlers = new Map();
  let tick;
  let summary = pending;
  let status = online;
  let releaseProbe;
  let delayed = false;
  let fail = false;
  const timer = {};
  t.mock.method(target, 'resolveTargetServer', async () => server);
  t.mock.method(pm2, 'findPm2Process', () => status);
  t.mock.method(context, 'withContext', async (_dir, action) => action({
    serverRepo: { getServer: async () => ({ turnEnabled: false }) },
  }));
  t.mock.method(health, 'diagnoseServerHealth', async () => []);
  const probe = t.mock.method(preview, 'readLocalServerPreview', async () => {
    if (fail) throw new Error('fixture preview failure');
    if (delayed) await new Promise((resolve) => { releaseProbe = resolve; });
    return { userCount: 0, voiceUserCount: 0, botCompatibility: summary };
  });
  t.mock.method(process.stdout, 'write', (chunk) => { frames.push(String(chunk)); return true; });
  const originalOn = process.on;
  t.mock.method(process, 'on', function (event, handler) {
    if (event === 'SIGINT' || event === 'SIGTERM') { signalHandlers.set(event, handler); return this; }
    return originalOn.call(this, event, handler);
  });
  t.mock.method(global, 'setInterval', (callback, interval) => {
    assert.equal(interval, 2000);
    tick = callback;
    return timer;
  });
  const clear = t.mock.method(global, 'clearInterval', (value) => assert.equal(value, timer));
  t.mock.method(process, 'exit', (code) => { assert.equal(code, 0); });

  await lifecycle.statusServerCommand({ dataDir: server.dataDir, dataDirSpecified: true }, ['--watch']);
  assert.equal(typeof tick, 'function');
  assert.match(frames.at(-1), /2 bot\(s\)/);
  summary = compatible;
  await tick();
  assert.ok(!frames.at(-1).includes('bot(s)'));
  summary = null;
  await tick();
  assert.ok(frames.at(-1).includes(translate('botCompatibility.unavailable')));
  delayed = true;
  const first = tick();
  const calls = probe.mock.callCount();
  await tick();
  assert.equal(probe.mock.callCount(), calls);
  releaseProbe();
  await first;
  delayed = false;
  fail = true;
  await tick();
  assert.ok(output.some((line) => line.includes('fixture preview failure')));
  fail = false;
  status = { pid: 0, pm2_env: { status: 'stopped' } };
  const stoppedCalls = probe.mock.callCount();
  await tick();
  assert.equal(probe.mock.callCount(), stoppedCalls);
  assert.ok(!frames.at(-1).includes(translate('botCompatibility.unavailable')));
  signalHandlers.get('SIGINT')();
  assert.equal(clear.mock.callCount(), 1);
  assert.ok(frames.includes('\x1b[?25h'));
});
