const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { getEventListeners } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  capture, captureBytes, bounded, cancellable, safeDiagnostic, errorDiagnostic,
  youtubeProviderCause, MediaError, terminate, checkMediaTool,
} = require('../../dist/localRuntime');
const { tools, signal, until } = require('./fixtures.cjs');

test('captures retain binary data and enforce combined output bounds, timeout and missing-tool errors', async () => {
  await assert.rejects(capture(path.join(__dirname, 'missing-tool.exe'), [], signal()), { code: 'tools' });
  const bytes = await captureBytes(process.execPath,
    ['-e', 'process.stdout.write(Buffer.from([0,255,128,195,40,10]))'], signal());
  assert.deepEqual(bytes, Buffer.from([0, 255, 128, 195, 40, 10]));
  await assert.rejects(capture(process.execPath,
    ['-e', "process.stderr.write('Provider denied public access');process.exitCode=1"], signal()),
  { code: 'unavailable', detail: 'Provider denied public access' });
  await assert.rejects(captureBytes(process.execPath,
    ['-e', 'process.stdout.write(Buffer.alloc(4096))'], signal(), 5000, 32),
  error => error.code === 'unavailable' && /exceeded 32 bytes/.test(error.detail));
  await assert.rejects(capture(process.execPath,
    ['-e', 'setInterval(()=>{},1000)'], signal(), 50), { code: 'timeout' });
});

test('strict audio capture notices stderr even beyond its retained prefix without changing ordinary captures', async () => {
  const args = ['-e', "process.stderr.write('Decode error token=synthetic-private');process.stdout.write('bytes')"];
  assert.equal((await captureBytes(process.execPath, args, signal())).toString(), 'bytes');
  await assert.rejects(captureBytes(process.execPath, args, signal(), 5000, 65536, { rejectStderr: true }), error => {
    assert.equal(error.code, 'unavailable');
    assert.match(error.detail, /Decode error/);
    assert.doesNotMatch(error.detail, /synthetic-private/);
    return true;
  });
  await assert.rejects(captureBytes(process.execPath,
    ['-e', "process.stderr.write(' '.repeat(8192));process.stderr.write('late decoder error')"],
    signal(), 5000, 65536, { rejectStderr: true }), error => error.code === 'unavailable' && !!error.detail);
});

test('diagnostics redact signed URLs, sessions, metadata and authentication guidance before bounding output', async () => {
  const detail = 'HTTP 403 https://rr1.googlevideo.com/videoplayback?signature=synthetic-private\n' +
    'Cookie: first=synthetic-private; session=synthetic-private\nAuthorization: Bearer synthetic-private\n' +
    'token=synthetic-private\n-----BEGIN PRIVATE KEY-----\nsynthetic-private\n-----END PRIVATE KEY-----\n';
  const sanitized = safeDiagnostic(detail + '{"title":"synthetic-private","url":"provider metadata"}');
  assert.match(sanitized, /HTTP 403/);
  assert.match(sanitized, /\[redacted JSON\]/);
  assert.match(sanitized, /\[redacted key\]/);
  assert.doesNotMatch(sanitized, /synthetic-private|googlevideo|"title"/);
  assert.ok(sanitized.length <= 1024);
  const inner = new MediaError('unavailable', detail);
  const outer = new Error('Operation failed', { cause: inner });
  inner.cause = outer;
  assert.match(errorDiagnostic(outer), /Operation failed.*unavailable.*HTTP 403/);
  assert.doesNotMatch(errorDiagnostic(outer), /synthetic-private|googlevideo/);
  assert.equal(errorDiagnostic(new MediaError('unsupported')), 'unsupported');
  await assert.rejects(capture(process.execPath, ['-e',
    `process.stdout.write(${JSON.stringify('{"title":"synthetic-private"}')});` +
    `process.stderr.write(${JSON.stringify(detail)});process.exitCode=1;`,
  ], signal()), error => error.code === 'unavailable' && /HTTP 403/.test(error.detail) && !/synthetic-private/.test(error.detail));

  const challenge = "ERROR: [youtube] abcdefghijk: Sign in to confirm you're not a bot. Use --cookies-from-browser fixture";
  assert.equal(youtubeProviderCause(new MediaError('unavailable', challenge)), 'YOUTUBE_BOT_CHALLENGE');
  assert.match(safeDiagnostic(challenge), /\[authentication guidance omitted\]/);
  assert.doesNotMatch(safeDiagnostic(challenge), /--cookies/);
  for (const error of [new Error(challenge), new MediaError('timeout', challenge),
    new MediaError('unavailable', 'HTTP 403'), new MediaError('unavailable', 'HTTP 429'),
    new MediaError('unavailable', challenge.replace('not a bot.', 'not a botnet.')),
    new MediaError('unavailable', JSON.stringify({ message: challenge }))]) {
    assert.equal(youtubeProviderCause(error), 'UNRESOLVED');
  }
});

test('an already cancelled capture starts no child and releases its cancellation listeners', async t => {
  const spawn = t.mock.method(childProcess, 'spawn', () => assert.fail('No process should start.'));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(capture(process.execPath, [], controller.signal), { code: 'cancelled' });
  assert.equal(spawn.mock.callCount(), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancelling an extractor terminates its JavaScript child and waits for owned cleanup', { timeout: 10000 }, async t => {
  const directory = fs.mkdtempSync(path.join(__dirname, '.process-cleanup-'));
  const file = path.join(directory, 'pid');
  const controller = new AbortController();
  let childPid;
  const running = () => {
    if (!childPid) return false;
    try { process.kill(childPid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  t.after(() => {
    controller.abort();
    if (running()) process.kill(childPid, 'SIGKILL');
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const script = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(file)}, String(child.pid));
    setInterval(()=>{},1000);
  `;
  const pending = capture(process.execPath, ['-e', script], controller.signal, 5000);
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  await until(() => fs.existsSync(file) && fs.statSync(file).size > 0);
  childPid = Number(fs.readFileSync(file, 'utf8'));
  assert.ok(Number.isSafeInteger(childPid) && childPid > 0);
  assert.ok(running());
  controller.abort();
  await rejected;
  await until(() => !running());
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('capture pool bounds concurrency and a cancelled or timed-out waiter cannot start later', { timeout: 10000 }, async t => {
  const nativeSpawn = childProcess.spawn;
  const children = [];
  t.mock.method(childProcess, 'spawn', (...args) => {
    const child = nativeSpawn(...args);
    if (args[0] === process.execPath) children.push(child);
    return child;
  });
  const controllers = Array.from({ length: 6 }, () => new AbortController());
  const active = controllers.slice(0, 4).map(controller =>
    capture(process.execPath, ['-e', 'setInterval(()=>{},1000)'], controller.signal, 60000)
      .catch(error => error));
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(children.length, 4);
    const cancelled = capture(process.execPath, ['-e', 'process.exit(0)'], controllers[4].signal);
    const cancelledResult = assert.rejects(cancelled, { code: 'cancelled' });
    controllers[4].abort();
    await cancelledResult;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const waiting = capture(process.execPath, ['-e', 'process.exit(0)'], controllers[5].signal);
    const rejected = assert.rejects(waiting, error => error.code === 'timeout' &&
      /Waiting for a media process slot exceeded 30000 ms/.test(error.detail));
    t.mock.timers.tick(30000);
    await rejected;
    assert.equal(children.length, 4);
  } finally {
    t.mock.timers.reset();
    controllers.forEach(controller => controller.abort());
    const failures = await Promise.all(active);
    assert.deepEqual(failures.map(error => error.code), ['cancelled', 'cancelled', 'cancelled', 'cancelled']);
    for (const child of children) await terminate(child);
  }
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  assert.equal(await capture(process.execPath, ['-e', "process.stdout.write('released')"], signal()), 'released');
});

for (const stage of ['-version', '-encoders']) {
  test(`cancelling the native FFmpeg ${stage} probe settles only after child cleanup`, { timeout: 10000 }, async t => {
    const nativeSpawn = childProcess.spawn;
    const children = [];
    const closed = new Set();
    const controller = new AbortController();
    t.mock.method(childProcess, 'spawn', (...args) => {
      const child = nativeSpawn(...args);
      if (args[0] === process.execPath) {
        children.push(child);
        child.once('close', () => closed.add(child));
      }
      return child;
    });
    const pending = checkMediaTool('ffmpeg', tools, controller.signal,
      (executable, args, receivedSignal, timeout, limit) => {
        assert.equal(executable, tools.ffmpeg);
        assert.equal(receivedSignal, controller.signal);
        const script = args.includes(stage) ? 'setInterval(()=>{},1000)'
          : "process.stdout.write('ffmpeg version 8.0.1')";
        return capture(process.execPath, ['-e', script], receivedSignal, timeout, limit);
      });
    const rejected = assert.rejects(pending, { code: 'cancelled' });
    t.after(async () => {
      controller.abort();
      for (const child of children) await terminate(child);
      await rejected;
    });
    await until(() => children.length === (stage === '-version' ? 1 : 2));
    controller.abort();
    await rejected;
    assert.equal(closed.size, children.length);
    assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('bounded and cancellable waits consume rejected inputs, preserve falsy failures and remove listeners', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cancellable(Promise.reject(new Error('Retired read')), controller.signal), { code: 'cancelled' });
  for (const failure of [undefined, null, false, 0, '']) {
    const abortSignal = signal();
    const result = await bounded(Promise.reject(failure), abortSignal, 100)
      .then(() => ({ ok: true }), error => ({ ok: false, error }));
    assert.deepEqual(result, { ok: false, error: failure });
    assert.equal(getEventListeners(abortSignal, 'abort').length, 0);
  }
  const abortSignal = signal();
  await assert.rejects(bounded(new Promise(() => {}), abortSignal, 10), { code: 'timeout' });
  assert.equal(getEventListeners(abortSignal, 'abort').length, 0);
});
