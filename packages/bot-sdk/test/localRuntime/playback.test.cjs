const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { getEventListeners } = require('node:events');
const { test } = require('node:test');
const {
  YouTubeSource, IncompleteAudioError, MAX_SOURCE_RECOVERIES,
} = require('../../dist/localRuntime');
const persistent = require('../../dist/localRuntime/persistent-http');
const { tools, signal, track, ogg, emit, decoder, consume, until } = require('./fixtures.cjs');

test('open preserves strict streaming arguments and returns complete Opus packets from the explicit decoder', async t => {
  const children = decoder(t, emit(ogg(6)));
  const abortSignal = signal();
  const source = new YouTubeSource(tools);
  const stream = await source.open(track(), abortSignal);
  assert.equal(stream.recoveryMode, undefined);
  const frames = await consume(stream);
  assert.deepEqual(frames, Array.from({ length: 6 }, () => Buffer.from([0xf8, 0xff, 0xfe])));
  assert.equal(children.length, 1);
  for (const [option, expected] of Object.entries({
    '-protocol_whitelist': 'https,tls,tcp,crypto', '-rw_timeout': '15000000', '-i': track().audioUrl,
    '-t': '3600', '-ac': '2', '-ar': '48000', '-c:a': 'libopus', '-frame_duration': '20', '-f': 'ogg',
  })) assert.equal(children[0].args[children[0].args.indexOf(option) + 1], expected);
  assert.ok(children[0].args.includes('-xerror'));
  assert.equal(children[0].args.some(value => /reconnect/.test(value)), false);
  assert.equal(getEventListeners(abortSignal, 'abort').length, 0);
  assert.equal(children[0].child.exitCode, 0);
});

test('invalid recovery options, duration and audio endpoint cannot start a decoder', async t => {
  const spawn = t.mock.method(childProcess, 'spawn', () => assert.fail('No invalid request may spawn.'));
  const source = new YouTubeSource(tools);
  for (const options of [null, {}, false, { onRecovery: true }, { mode: 'other' },
    { mode: 'persistent', progress: 'decoded' }, { mode: 'persistent', onRecovery() {} }]) {
    await assert.rejects(source.open(track(), signal(), options), { code: 'input' });
  }
  for (const duration of [0, -1, 3601, Infinity]) {
    await assert.rejects(source.open(track(duration), signal()), { code: 'unsupported' });
  }
  await assert.rejects(source.open({ ...track(), audioUrl: 'http://localhost/private' }, signal()), { code: 'unavailable' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.open(track(), controller.signal), { code: 'cancelled' });
  assert.equal(spawn.mock.callCount(), 0);
});

test('clean process exit and valid Ogg cannot hide missing track duration or a missing EOS', async t => {
  decoder(t, (_args, index) => emit(index === 2 ? ogg(6, false) : ogg(150)));
  const source = new YouTubeSource(tools);
  assert.equal((await consume(await source.open(track(3.2), signal()))).length, 150);
  await assert.rejects(consume(await source.open(track(5), signal())), error =>
    error instanceof IncompleteAudioError && error.expectedDurationMs === 5000 && error.emittedDurationMs === 3000);
  await assert.rejects(consume(await source.open(track(), signal())), error =>
    error.code === 'unavailable' && /Ogg/.test(error.detail));
});

for (const diagnostic of [
  'Decode error https://rr1.googlevideo.com/videoplayback?signature=synthetic-private',
  ' '.repeat(8192) + 'late decoder error',
]) {
  test('error-level decoder output remains terminal even with complete audio and exit zero', async t => {
    decoder(t, `process.stderr.write(${JSON.stringify(diagnostic)});${emit(ogg())}`);
    await assert.rejects(consume(await new YouTubeSource(tools).open(track(), signal())), error => {
      assert.equal(error.code, 'unavailable');
      assert.ok(error.detail);
      assert.doesNotMatch(error.detail, /synthetic-private|https:\/\//);
      return true;
    });
  });
}

test('decoder stderr overflow remains bounded and terminates its owned process', { timeout: 10000 }, async t => {
  const children = decoder(t, "setInterval(()=>process.stderr.write('x'.repeat(16384)),5)");
  await assert.rejects(consume(await new YouTubeSource(tools).open(track(), signal())), error => {
    assert.equal(error.code, 'unavailable');
    assert.match(error.detail, /excessive error output/);
    assert.ok(error.detail.length <= 1024);
    return true;
  });
  assert.ok(children[0].child.exitCode !== null || children[0].child.signalCode !== null);
});

test('closing a stream invalidates already parsed packets without aborting its caller signal', async t => {
  decoder(t, emit(ogg()) + 'setInterval(()=>{},1000);');
  const abortSignal = signal();
  const stream = await new YouTubeSource(tools).open(track(), abortSignal);
  const iterator = stream.frames[Symbol.asyncIterator]();
  t.after(() => stream.close());
  assert.equal((await iterator.next()).done, false);
  const closing = stream.close();
  assert.equal(stream.close(), closing);
  await closing;
  assert.equal(abortSignal.aborted, false);
  await assert.rejects(iterator.next(), { code: 'cancelled' });
  assert.equal(getEventListeners(abortSignal, 'abort').length, 0);
});

test('cancellation closes an unconsumed source process and clears its lifetime timer', { timeout: 10000 }, async t => {
  const originalTimeout = global.setTimeout;
  const originalClear = global.clearTimeout;
  const lifetimes = [];
  const cleared = new Set();
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) => {
    const timer = originalTimeout(callback, ms, ...args);
    if (ms === 2 * 60 * 60 * 1000) lifetimes.push(timer);
    return timer;
  });
  t.mock.method(global, 'clearTimeout', timer => { cleared.add(timer); return originalClear(timer); });
  const children = decoder(t, 'setInterval(()=>{},1000);');
  const controller = new AbortController();
  const stream = await new YouTubeSource(tools).open(track(), controller.signal);
  t.after(() => stream.close());
  controller.abort();
  await until(() => children[0].child.exitCode !== null || children[0].child.signalCode !== null);
  assert.equal(lifetimes.length, 1);
  assert.ok(cleared.has(lifetimes[0]));
  await assert.rejects(stream.frames[Symbol.asyncIterator]().next(), { code: 'cancelled' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancelling a preview does not retain its inclusion signal or interrupt an existing playback', async t => {
  const children = decoder(t, emit(ogg()) + 'setInterval(()=>{},1000);');
  const previewController = new AbortController();
  const playbackController = new AbortController();
  const source = new YouTubeSource(tools, {
    capture: async (executable, args) => {
      if (executable === tools.node) return 'v22.0.0';
      if (executable === tools.ffmpeg) return args.includes('-version') ? 'ffmpeg version 8.0.1' : ' A....D libopus';
      if (args.includes('--version')) return '2026.08.19';
      return JSON.stringify({ ...track(), url: track().audioUrl });
    },
    captureBytes: async (_executable, _args, abortSignal) => {
      assert.equal(abortSignal, previewController.signal);
      previewController.abort();
      return ogg(6);
    },
  });
  const stream = await source.open(track(), playbackController.signal);
  t.after(() => stream.close());
  const iterator = stream.frames[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).done, false);
  await assert.rejects(source.preview(track().url, previewController.signal), { code: 'cancelled' });
  assert.equal(playbackController.signal.aborted, false);
  assert.equal(children[0].child.exitCode, null);
  assert.equal((await iterator.next()).done, false);
  await stream.close();
  await iterator.return();
});

test('opt-in reconnect reports retries but only declares recovery after complete validated EOF', async t => {
  decoder(t, `
    process.stderr.write('[http @ 1] [error] Stream ends prematurely\\n[http @ 1] [warning] Will reconnect at 100 in 1 second(s)\\n');
    ${emit(ogg())}
  `);
  const notices = [];
  const stream = await new YouTubeSource(tools).open(track(), signal(), {
    onRecovery: (notice, abortSignal) => { assert.equal(abortSignal.aborted, false); notices.push(notice); },
  });
  assert.equal((await consume(stream)).length, 6);
  assert.deepEqual(notices.map(notice => notice.type), ['retrying', 'recovered']);
  assert.equal(notices[0].byteOffset, 100);
  assert.equal(notices[0].maxAttempts, MAX_SOURCE_RECOVERIES);
  assert.equal(notices[1].emittedDurationMs, 120);
  assert.doesNotMatch(JSON.stringify(notices), /googlevideo|https?:/);
});

for (const [diagnostic, detail] of [
  ['[http @ 1] [warning] Will reconnect using an unknown format\n', /Unsupported HTTP source recovery diagnostic/],
  ['[http @ 1] [warning] Will reconnect at 100 in 3 second(s)\n', /Invalid HTTP source recovery diagnostic/],
  ['[http @ 1] [warning] Will reconnect at 100 in 0 second(s)\n'.repeat(3), /exceeded 2 resume attempts/],
  ['[http @ 1] [warning] Will reconnect at 100 in 0 second(s)\n[decoder @ 1] [error] Decode failed\n', /Decode failed/],
]) {
  test('opt-in recovery cannot conceal unsupported retries, exhausted bounds or separate decoder errors', async t => {
    decoder(t, `process.stderr.write(${JSON.stringify(diagnostic)});${emit(ogg())}`);
    const notices = [];
    await assert.rejects(consume(await new YouTubeSource(tools).open(track(), signal(), {
      onRecovery: notice => { notices.push(notice); },
    })), error => error.code === 'unavailable' && detail.test(error.detail));
    assert.equal(notices.some(notice => notice.type === 'recovered'), false);
  });
}

test('restart from byte zero after emitted audio is refused rather than duplicating playback', async t => {
  decoder(t, emit(ogg()) + `
    setTimeout(()=>process.stderr.write('[http @ 1] [warning] Will reconnect at 0 in 0 second(s)\\n'),100);
    setInterval(()=>{},1000);
  `);
  let frames = 0;
  const notices = [];
  await assert.rejects(consume(await new YouTubeSource(tools).open(track(), signal(), {
    onRecovery: notice => { notices.push(notice); },
  }), () => { frames++; }), error => error.code === 'unavailable' && /Refusing to restart/.test(error.detail));
  assert.equal(frames, 6);
  assert.deepEqual(notices, []);
});

test('retry notices arrive during stalls and explicit close cancels delivery without a command abort', async t => {
  decoder(t, `
    process.stderr.write('[http @ 1] [warning] Will reconnect at 100 in 1 second(s)\\n');
    setInterval(()=>{},1000);
  `);
  let noticeSignal;
  const abortSignal = signal();
  const stream = await new YouTubeSource(tools).open(track(), abortSignal, {
    onRecovery: (_notice, receivedSignal) => { noticeSignal = receivedSignal; return stream.close(); },
  });
  await assert.rejects(consume(stream), { code: 'cancelled' });
  assert.equal(abortSignal.aborted, false);
  assert.equal(noticeSignal.aborted, true);
});

test('failed and stuck notice callbacks remain explicit and cannot leave the decoder running', async t => {
  const originalTimeout = global.setTimeout;
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) =>
    originalTimeout(callback, ms === 5000 ? 30 : ms, ...args));
  const children = decoder(t, `
    process.stderr.write('[http @ 1] [warning] Will reconnect at 100 in 1 second(s)\\n');
    setInterval(()=>{},1000);
  `);
  for (const onRecovery of [
    () => { throw new Error('Observer failed token=synthetic-private'); },
    () => new Promise(() => {}),
  ]) {
    await assert.rejects(consume(await new YouTubeSource(tools).open(track(), signal(), { onRecovery })), error => {
      assert.equal(error.code, 'unavailable');
      assert.match(error.detail, /Could not report source recovery/);
      assert.doesNotMatch(error.detail, /synthetic-private/);
      return true;
    });
  }
  assert.ok(children.every(({ child }) => child.exitCode !== null || child.signalCode !== null));
});

for (const [deadline, detail] of [[30000, /Decoded audio stalled/], [2 * 60 * 60 * 1000, /two-hour lifetime/]]) {
  test(`the ${deadline} ms decoder watchdog remains explicit and closes its process`, async t => {
    const originalTimeout = global.setTimeout;
    let expire;
    t.mock.method(global, 'setTimeout', (callback, ms, ...args) => {
      if (ms === deadline) expire = callback;
      return originalTimeout(callback, ms, ...args);
    });
    decoder(t, 'setInterval(()=>{},1000);');
    const stream = await new YouTubeSource(tools).open(track(), signal());
    const rejection = assert.rejects(consume(stream), error => error.code === 'timeout' && detail.test(error.detail));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof expire, 'function');
    expire();
    await rejection;
  });
}

test('persistent recovery advances only acknowledged playback, while keeping the legacy decoded mode', async t => {
  decoder(t, emit(ogg()));
  for (const progress of ['playback', undefined]) {
    let advanced = 0, closed = 0;
    const pauses = [];
    t.mock.method(persistent, 'createPersistentInput', async () => ({
      url: 'http://127.0.0.1:1/unused-by-script', failure: undefined,
      waitingForData: () => true,
      markAudioProgress: () => { advanced++; },
      setPaused: value => pauses.push(value),
      close: async () => { closed++; },
    }));
    const abortSignal = signal();
    const stream = await new YouTubeSource(tools).open(track(), abortSignal, { mode: 'persistent', progress });
    assert.equal(stream.recoveryMode, 'persistent');
    stream.setPaused(true);
    stream.setPaused(false);
    await consume(stream, (_frame, count) => {
      assert.equal(advanced, progress === 'playback' ? count - 1 : count);
      if (progress === 'playback') stream.markFrameAdvanced();
    });
    assert.equal(advanced, 6);
    assert.equal(closed, 1);
    assert.deepEqual(pauses, [true, false]);
    assert.throws(() => stream.markFrameAdvanced(), { code: 'cancelled' });
    assert.equal(getEventListeners(abortSignal, 'abort').length, 0);
  }
});

test('persistent watchdog ticks keep one read subscription and fail only when input is no longer waiting', async t => {
  decoder(t, 'setInterval(()=>{},1000);');
  let waiting = true, watchdog;
  const originalInterval = global.setInterval;
  t.mock.method(global, 'setInterval', (callback, ms, ...args) => {
    if (ms === 30000) watchdog = callback;
    return originalInterval(callback, ms, ...args);
  });
  t.mock.method(persistent, 'createPersistentInput', async () => ({
    url: 'http://127.0.0.1:1/unused-by-script', failure: undefined,
    waitingForData: () => waiting, markAudioProgress() {}, setPaused() {}, close: async () => {},
  }));
  const abortSignal = signal();
  const stream = await new YouTubeSource(tools).open(track(), abortSignal, { mode: 'persistent', progress: 'playback' });
  const rejection = assert.rejects(consume(stream), { code: 'timeout' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof watchdog, 'function');
  const listeners = getEventListeners(abortSignal, 'abort').length;
  for (let i = 0; i < 100; i++) watchdog();
  assert.equal(getEventListeners(abortSignal, 'abort').length, listeners);
  waiting = false;
  watchdog();
  await rejection;
  assert.equal(getEventListeners(abortSignal, 'abort').length, 0);
});
