const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const { formatBotCompatibilityWarnings, printBotCompatibilityWarning } = require('../dist/cli/botCompatibility');
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

test('startup compatibility waits for a refused connection to become a responding server', async (t) => {
  const output = isolate(t, 'pt-BR');
  const endpoint = http.createServer((request, response) => {
    assert.equal(request.url, '/preview');
    response.end(JSON.stringify({ userCount: 0, voiceUserCount: 0, botCompatibility: pending }));
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  const port = endpoint.address().port;
  await new Promise((resolve, reject) => endpoint.close((error) => error ? reject(error) : resolve()));
  t.after(() => new Promise((resolve, reject) => endpoint.close((error) => error ? reject(error) : resolve())));
  const readPreview = preview.readLocalServerPreview;
  let attempts = 0;
  t.mock.method(preview, 'readLocalServerPreview', async (...args) => {
    const result = await readPreview(...args);
    if (++attempts === 1) {
      assert.equal(result, null, 'the first post-PM2 connection is refused');
      endpoint.listen(port, '127.0.0.1');
      await once(endpoint, 'listening');
    }
    return result;
  });

  await printBotCompatibilityWarning(port, { waitForStartup: true });

  assert.equal(attempts, 2);
  assert.deepEqual(output.map(withoutAnsi), formatBotCompatibilityWarnings(pending).map(withoutAnsi));
});

test('startup compatibility retries an HTTP failure without inventing bot incompatibilities', async (t) => {
  const output = isolate(t);
  let requests = 0;
  const endpoint = http.createServer((_request, response) => {
    if (++requests === 1) {
      response.writeHead(503);
      response.end();
    } else {
      response.end(JSON.stringify({ userCount: 0, voiceUserCount: 0, botCompatibility: compatible }));
    }
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  t.after(() => new Promise((resolve, reject) => endpoint.close((error) => error ? reject(error) : resolve())));

  await printBotCompatibilityWarning(endpoint.address().port, { waitForStartup: true });

  assert.equal(requests, 2);
  assert.deepEqual(output, []);
});

test('startup compatibility has a ten-second total budget including requests and retry delays', async (t) => {
  for (const responseTime of [0, 1500]) {
    await t.test(`failed probes take ${responseTime}ms`, async (t) => {
      const output = isolate(t);
      let elapsed = 0;
      t.mock.method(performance, 'now', () => elapsed);
      t.mock.method(global, 'setTimeout', (callback, delay) => {
        assert.ok(delay > 0 && delay <= 250);
        elapsed += delay;
        queueMicrotask(callback);
      });
      const probe = t.mock.method(preview, 'readLocalServerPreview', async (_port, timeout = 1500) => {
        assert.ok(elapsed < 10_000, 'no new request may start after the deadline');
        assert.ok(timeout > 0 && timeout <= Math.min(1500, 10_000 - elapsed));
        elapsed += Math.min(responseTime, timeout);
        return null;
      });

      await printBotCompatibilityWarning(server.port, { waitForStartup: true });

      assert.equal(elapsed, 10_000);
      assert.equal(probe.mock.callCount(), responseTime === 0 ? 40 : 6);
      assert.deepEqual(output.map(withoutAnsi), [translate('botCompatibility.unavailable')]);
    });
  }
});

test('ready servers with missing or invalid compatibility data are not retried or reported compatible', async (t) => {
  const output = isolate(t);
  let payload = { userCount: 0, voiceUserCount: 0 };
  let requests = 0;
  const endpoint = http.createServer((_request, response) => {
    requests++;
    response.end(JSON.stringify(payload));
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  t.after(() => new Promise((resolve, reject) => endpoint.close((error) => error ? reject(error) : resolve())));
  await printBotCompatibilityWarning(endpoint.address().port, { waitForStartup: true });
  payload = { ...payload, botCompatibility: { ...pending, incompatibleBots: -1 } };
  await printBotCompatibilityWarning(endpoint.address().port, { waitForStartup: true });
  assert.equal(requests, 2);
  assert.deepEqual(output.map(withoutAnsi), Array(2).fill(translate('botCompatibility.unavailable')));
});

test('ordinary compatibility queries keep their one-shot behavior', async (t) => {
  const output = isolate(t);
  const probe = t.mock.method(preview, 'readLocalServerPreview', async () => null);
  await printBotCompatibilityWarning(server.port);
  assert.equal(probe.mock.callCount(), 1);
  assert.deepEqual(output.map(withoutAnsi), [translate('botCompatibility.unavailable')]);
});

test('preview deadline also bounds a response that keeps sending data without finishing', async (t) => {
  let finishedBody = false;
  const endpoint = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"userCount":0');
    let chunks = 0;
    const timer = setInterval(() => {
      response.write(' ');
      if (++chunks === 30) {
        finishedBody = true;
        response.end('}');
        clearInterval(timer);
      }
    }, 20);
    response.on('close', () => clearInterval(timer));
  });
  endpoint.listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  t.after(() => new Promise((resolve, reject) => endpoint.close((error) => error ? reject(error) : resolve())));

  assert.equal(await preview.readLocalServerPreview(endpoint.address().port, 100), null);
  assert.equal(finishedBody, false, 'activity must not extend the total request deadline');
});

test('preview failures settle as unavailable and release their connections', async (t) => {
  const cases = [
    ['invalid JSON', (_request, response) => response.end('{')],
    ['non-object JSON', (_request, response) => response.end('null')],
    ['oversized body', (_request, response) => response.write(' '.repeat(64_001))],
    ['aborted body', (_request, response) => {
      response.writeHead(200, { 'Content-Length': '1000' });
      response.write('{');
      setImmediate(() => response.destroy());
    }],
    ['no response', () => {}],
  ];
  for (const [name, handler] of cases) {
    await t.test(name, async (t) => {
      const endpoint = http.createServer(handler);
      endpoint.listen(0, '127.0.0.1');
      await once(endpoint, 'listening');
      t.after(() => new Promise((resolve, reject) => endpoint.close((error) => error ? reject(error) : resolve())));
      assert.equal(await preview.readLocalServerPreview(endpoint.address().port, 100), null);
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
  const contexts = t.mock.method(context, 'withContext', async (_dir, action) => action({
    serverRepo: { getLifecycleSettings: async () => ({ name: 'Fixture', turnEnabled: false }) },
  }));
  const diagnoses = t.mock.method(health, 'diagnoseServerHealth', async () => []);
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
  assert.ok(contexts.mock.callCount() > 0);
  for (const call of contexts.mock.calls) {
    assert.equal(call.arguments[2], false);
    assert.deepEqual(call.arguments[3], { readOnly: true });
  }
  assert.ok(diagnoses.mock.callCount() > 0);
  for (const call of diagnoses.mock.calls) {
    assert.equal(call.arguments[2], pm2.getServerEntryPath());
  }
});
