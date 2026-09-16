import assert from 'node:assert/strict';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { LIMITS, LOCAL_EXECUTION_RUNTIME_LIMITS } from '@monky/shared';
import { MediaError, SourceRecoveryError, type AudioStream, type MusicSource } from '@monky/bot-sdk/dist/localRuntime';
import { LOCAL_TASK_CACHE_MAX_BYTES } from '../src/main/localExecution/LocalTools';
import { runLocalWorker, type WorkerImplementation } from '../src/main/localExecution/worker';
import { workerDeferred, type WorkerReply, type WorkerStart } from '../src/main/localExecution/workerProtocol';

const paths = { node: process.execPath, ytDlp: path.resolve('fixture-ytdlp'), ffmpeg: path.resolve('fixture-ffmpeg') };
const track = { id: 'abcdefghijk', title: 'Controlled fixture',
  url: 'https://www.youtube.com/watch?v=abcdefghijk', duration: 0.12, audioUrl: 'https://rr1.googlevideo.com/videoplayback' };
const frame = Uint8Array.of(0xf8, 0xff, 0xfe);
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 300 && !predicate(); index++) await tick();
  assert.ok(predicate(), 'Expected private worker state did not arrive.');
}

function fixture(
  t: TestContext, source: MusicSource, producerActive = (): boolean => true,
  probe: WorkerImplementation['probe'] = async () => 'v24.20.0',
) {
  let receive: (message: unknown) => void = () => { throw new Error('Missing receiver'); };
  let disconnect: () => void = () => { throw new Error('Missing disconnect handler'); };
  let removed = 0;
  let nativeCleanups = 0;
  const messages: WorkerReply[] = [];
  const runtime = runLocalWorker({
    send: async message => { messages.push(message); },
    receive: listener => { receive = listener; return () => { removed++; }; },
    disconnected: listener => { disconnect = listener; return () => { removed++; }; },
  }, {
    id: 'worker-fixture', source: () => source, probe,
    verify: async () => undefined, cleanupNative: async () => { nativeCleanups++; }, producerActive,
  });
  const outcome = runtime.closed.then(() => undefined, error => error);
  t.after(async () => {
    const stopped = runtime.stop();
    const expected = await outcome;
    if (expected === undefined) await stopped;
    else await assert.rejects(stopped, error => error === expected);
  });
  const start = (operation: 'youtube.stream' | 'youtube.resolve' | 'youtube.preview' | 'youtube.search' = 'youtube.stream'): void => {
    const base = { type: 'start' as const, id: 'worker-fixture', paths,
      directory: path.resolve('cache', 'task-00000000-0000-0000-0000-000000000000'),
      mode: 'task' as const };
    const input: WorkerStart = operation === 'youtube.search'
      ? { ...base, spec: { operation, query: 'controlled fixture' } }
      : { ...base, spec: { operation, url: track.url } };
    receive(input);
  };
  return {
    runtime, outcome, messages, start, receive: (message: unknown) => receive(message),
    disconnect: () => disconnect(), cleanup: () => ({ removed, nativeCleanups }),
    read: (requestId: number, count: number) => receive({ type: 'read', id: 'worker-fixture', requestId, count }),
    ack: (requestId: number, playedFrames: number) => receive({ type: 'ack', id: 'worker-fixture', requestId, playedFrames }),
    pause: (requestId: number, paused: boolean) => receive({ type: 'pause', id: 'worker-fixture', requestId, paused }),
  };
}

function source(open: MusicSource['open']): MusicSource {
  return {
    check: async () => undefined, search: async () => [track],
    resolve: async () => track, preview: async () => Uint8Array.from(Buffer.from('OggS')),
    open,
  };
}

test('worker strips internal audio URLs from metadata and closes one-shot jobs', async t => {
  for (const operation of ['youtube.search', 'youtube.resolve', 'youtube.preview'] as const) {
    const f = fixture(t, source(async () => { throw new Error('Metadata must not open playback'); }));
    f.start(operation);
    await f.runtime.closed;
    const result = f.messages.find(message => message.type === 'result');
    assert.ok(result && result.type === 'result');
    assert.doesNotMatch(JSON.stringify(result), /audioUrl|googlevideo|videoplayback/);
    assert.equal(f.messages.at(-1)?.type, 'closed');
    assert.deepEqual(f.cleanup(), { removed: 2, nativeCleanups: 2 });
  }
});

test('metadata source failures retain their canonical codes through worker shutdown', async t => {
  for (const [operation, code, reason] of [
    ['youtube.search', 'input', 'invalid_request'],
    ['youtube.resolve', 'unsupported', 'invalid_request'],
    ['youtube.preview', 'tools', 'tools_missing'],
  ] as const) {
    const fail = async (): Promise<never> => {
      throw new MediaError(code, 'https://rr1.googlevideo.com/videoplayback?signature=private');
    };
    const f = fixture(t, {
      check: fail, search: fail, resolve: fail, preview: fail, open: fail,
    });
    f.start(operation);
    await assert.rejects(f.runtime.closed, { reason, sourceFailure: { code } });
    const failure = f.messages.find(message => message.type === 'failure');
    assert.ok(failure && failure.type === 'failure');
    assert.deepEqual(failure.sourceFailure, { code });
    assert.doesNotMatch(JSON.stringify(failure), /googlevideo|signature|private/);
    assert.equal(f.messages.at(-1)?.type, 'closed');
    assert.equal(f.cleanup().removed, 2);
  }
});

test('probe failures retain their actual SDK code without adding source diagnostics', async t => {
  const f = fixture(t, source(async () => { throw new Error('A probe must not open media'); }),
    () => true, async () => { throw new MediaError('runtime', 'Controlled unsupported Node runtime'); });
  f.receive({ type: 'start', id: 'worker-fixture', paths, mode: 'probe', tool: 'node',
    directory: path.resolve('cache', 'task-00000000-0000-0000-0000-000000000000') });
  await assert.rejects(f.runtime.closed, { reason: 'tools_missing', sourceFailure: { code: 'runtime' } });
  const failure = f.messages.find(message => message.type === 'failure');
  assert.ok(failure && failure.type === 'failure');
  assert.deepEqual(failure.sourceFailure, { code: 'runtime' });
});

test('private probes map fixed tool IDs and return bounded actual versions', async t => {
  for (const [tool, sdkTool, version] of [
    ['node', 'node', 'v24.20.0'], ['yt-dlp', 'ytDlp', '2026.06.16'], ['ffmpeg', 'ffmpeg', '8.0.1'],
  ] as const) {
    const f = fixture(t, source(async () => { throw new Error('A probe must not open playback'); }),
      () => true, async (receivedTool, receivedPaths, signal) => {
        assert.equal(receivedTool, sdkTool);
        assert.deepEqual(receivedPaths, paths);
        signal.throwIfAborted();
        return version;
      });
    f.receive({ type: 'start', id: 'worker-fixture', paths, mode: 'probe', tool,
      directory: path.resolve('cache', 'task-00000000-0000-0000-0000-000000000000') });
    await f.runtime.closed;
    assert.deepEqual(f.messages, [
      { type: 'ready', id: 'worker-fixture' }, { type: 'version', id: 'worker-fixture', version },
      { type: 'closed', id: 'worker-fixture' },
    ]);
  }
});

test('worker rejects playback controls for metadata and probe jobs instead of acknowledging no-ops', async t => {
  for (const mode of ['task', 'probe'] as const) {
    for (const control of ['pause', 'ack', 'read'] as const) {
      let pending = false;
      const untilAborted = (signal: AbortSignal): Promise<never> => {
        pending = true;
        signal.throwIfAborted();
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      };
      const f = fixture(t, {
        ...source(async () => { throw new Error('A metadata task must not open playback'); }),
        resolve: (_url, signal) => untilAborted(signal),
      }, () => true, (_tool, _paths, signal) => untilAborted(signal));
      if (mode === 'task') f.start('youtube.resolve');
      else f.receive({ type: 'start', id: 'worker-fixture', paths, mode: 'probe', tool: 'node',
        directory: path.resolve('cache', 'task-00000000-0000-0000-0000-000000000000') });
      await until(() => pending);
      if (control === 'pause') f.pause(1, true);
      else if (control === 'ack') f.ack(1, 0);
      else f.read(1, 1);
      await assert.rejects(f.runtime.closed, { reason: 'invalid_request' });
      assert.equal(f.messages.some(message => message.type === 'accepted' || message.type === 'frames'), false);
      assert.equal(f.cleanup().removed, 2);
    }
  }
});

test('pause and monotonic absolute ACKs remain responsive while a pull is blocked', async t => {
  const gate = workerDeferred<void>();
  let blocked = false, closed = 0, advanced = 0;
  const pauses: boolean[] = [];
  const f = fixture(t, source(async (_track, signal, options): Promise<AudioStream> => {
    assert.deepEqual(options, { mode: 'persistent', progress: 'playback' });
    return {
      recoveryMode: 'persistent',
      frames: (async function* () {
        yield frame; yield frame;
        blocked = true;
        await gate.promise;
        signal.throwIfAborted();
        yield frame;
      })(),
      markFrameAdvanced: () => { advanced++; },
      setPaused: paused => { pauses.push(paused); },
      close: async () => { closed++; gate.resolve(undefined); },
    };
  }));
  f.start();
  await until(() => f.messages.some(message => message.type === 'result'));
  f.read(1, 2);
  await until(() => f.messages.some(message => message.type === 'frames'));
  assert.equal(advanced, 0, 'Generating, reading and sending packets are not playback.');
  f.read(2, 1);
  await until(() => blocked);
  f.pause(3, true);
  f.ack(4, 1);
  f.ack(5, 1);
  f.ack(6, 2);
  await until(() => f.messages.filter(message => message.type === 'accepted').length === 4);
  assert.equal(advanced, 2);
  assert.deepEqual(pauses, [false, true]);
  await f.runtime.stop();
  assert.ok(closed > 0);
  assert.equal(f.messages.filter(message => message.type === 'frames').length, 1, 'A cancelled pending pull must not publish frames.');
  assert.equal(f.cleanup().removed, 2);
});

test('worker preserves final frames with done and defers terminal-read ACKs until EOF is known', async t => {
  const ending = workerDeferred<void>();
  let internalClosed = false, advancing = 0;
  const f = fixture(t, source(async () => ({
    recoveryMode: 'persistent',
    frames: (async function* () {
      yield frame; yield frame; yield frame;
      internalClosed = true;
      await ending.promise;
    })(),
    markFrameAdvanced: () => { assert.equal(internalClosed, false); advancing++; },
    setPaused: () => undefined,
    close: async () => { internalClosed = true; ending.resolve(undefined); },
  })), () => !internalClosed);
  f.start();
  await until(() => f.messages.some(message => message.type === 'result'));
  f.read(1, 2);
  await until(() => f.messages.some(message => message.type === 'frames'));
  f.read(2, 8);
  await until(() => internalClosed);
  f.ack(3, 2);
  await until(() => f.messages.some(message => message.type === 'accepted'));
  assert.equal(advancing, 0, 'The SDK source is already closing; a terminal-read ACK must not call it.');
  ending.resolve(undefined);
  await f.runtime.closed;
  const batches = f.messages.filter(message => message.type === 'frames');
  assert.deepEqual(batches.map(message => ({ length: message.frames.length, done: message.done })),
    [{ length: 2, done: false }, { length: 1, done: true }]);
  assert.equal(advancing, 0);
});

test('deferred ACKs advance exactly once if a pending terminal-looking pull actually returns more audio', async t => {
  const gate = workerDeferred<void>();
  let blocked = false, active = true, advances = 0;
  const f = fixture(t, source(async () => ({
    recoveryMode: 'persistent',
    frames: (async function* () { yield frame; active = false; blocked = true; await gate.promise; yield frame; })(),
    markFrameAdvanced: () => { advances++; }, setPaused: () => undefined,
    close: async () => { gate.resolve(undefined); },
  })), () => active);
  f.start();
  await until(() => f.messages.some(message => message.type === 'result'));
  f.read(1, 1);
  await until(() => f.messages.some(message => message.type === 'frames'));
  f.read(2, 1);
  await until(() => blocked);
  f.ack(3, 1);
  await tick();
  assert.equal(advances, 0);
  gate.resolve(undefined);
  await until(() => f.messages.filter(message => message.type === 'frames').length === 2);
  await tick();
  assert.equal(advances, 1);
  await f.runtime.stop();
});

for (const value of [-1, 2]) {
  test(`invalid playback ACK ${value} cannot advance source recovery`, async t => {
    let advances = 0;
    const f = fixture(t, source(async () => ({
      recoveryMode: 'persistent', frames: (async function* () { yield frame; yield frame; })(),
      markFrameAdvanced: () => { advances++; }, setPaused: () => undefined, close: async () => undefined,
    })));
    f.start();
    await until(() => f.messages.some(message => message.type === 'result'));
    f.read(1, 1);
    await until(() => f.messages.some(message => message.type === 'frames'));
    f.ack(2, value);
    await assert.rejects(f.runtime.closed, { reason: 'invalid_request' });
    assert.equal(advances, 0);
  });
}

test('a backward absolute ACK is rejected after valid advancement', async t => {
  let advances = 0;
  const f = fixture(t, source(async () => ({
    recoveryMode: 'persistent', frames: (async function* () { yield frame; yield frame; })(),
    markFrameAdvanced: () => { advances++; }, setPaused: () => undefined, close: async () => undefined,
  })));
  f.start();
  await until(() => f.messages.some(message => message.type === 'result'));
  f.read(1, 1);
  await until(() => f.messages.some(message => message.type === 'frames'));
  f.ack(2, 1);
  f.ack(3, 0);
  await assert.rejects(f.runtime.closed, { reason: 'invalid_request' });
  assert.equal(advances, 1);
});

test('stop during pending open closes a late stream before signalling closed', async t => {
  const opening = workerDeferred<AudioStream>();
  let requested = false, closed = 0;
  const f = fixture(t, source(async () => { requested = true; return opening.promise; }));
  f.start();
  await until(() => requested);
  const closing = f.runtime.stop();
  assert.equal(f.messages.some(message => message.type === 'closed'), false);
  opening.resolve({
    recoveryMode: 'persistent', frames: (async function* () { yield frame; })(),
    markFrameAdvanced: () => undefined, setPaused: () => undefined, close: async () => { closed++; },
  });
  await closing;
  assert.equal(closed, 1);
  assert.equal(f.messages.some(message => message.type === 'result'), false);
});

test('parent disconnect aborts pending provider work and waits for it to release', async t => {
  let aborted = false;
  const f = fixture(t, {
    ...source(async () => { throw new Error('Not reached'); }),
    resolve: (_url, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  });
  f.start('youtube.resolve');
  await until(() => f.messages.some(message => message.type === 'ready'));
  await tick();
  f.disconnect();
  await assert.rejects(f.runtime.closed, { reason: 'executor_unavailable' });
  assert.equal(aborted, true);
});

test('worker streams beyond the cache budget without retaining historical frame replies', { timeout: 30000 }, async t => {
  const packet = Buffer.alloc(LOCAL_EXECUTION_RUNTIME_LIMITS.frameBytes);
  packet[0] = 0xf8;
  const frameCount = Math.ceil(LOCAL_TASK_CACHE_MAX_BYTES / packet.length) + 8;
  const f = fixture(t, {
    ...source(async () => ({
      recoveryMode: 'persistent',
      frames: (async function* () { for (let index = 0; index < frameCount; index++) yield packet; })(),
      markFrameAdvanced: () => undefined, setPaused: () => undefined, close: async () => undefined,
    })),
    resolve: async () => ({ ...track, duration: frameCount * 0.02 }),
  });
  f.start();
  await until(() => f.messages.some(message => message.type === 'result'));
  let sequence = 0, bytes = 0, delivered = 0, done = false;
  while (!done) {
    f.messages.length = 0;
    f.read(++sequence, LOCAL_EXECUTION_RUNTIME_LIMITS.frameBatch);
    await until(() => f.messages.some(message => message.type === 'frames' || message.type === 'failure'));
    const batch = f.messages.find(message => message.type === 'frames');
    assert.ok(batch && batch.type === 'frames');
    assert.ok(batch.frames.length <= LOCAL_EXECUTION_RUNTIME_LIMITS.frameBatch);
    bytes += batch.frames.reduce((total, frame) => total + Buffer.byteLength(frame, 'base64'), 0);
    delivered += batch.frames.length;
    done = batch.done;
    if (!done) {
      f.ack(++sequence, delivered);
      await until(() => f.messages.some(message => message.type === 'accepted' && message.requestId === sequence));
    }
  }
  await f.runtime.closed;
  assert.equal(delivered, frameCount);
  assert.ok(bytes > LOCAL_TASK_CACHE_MAX_BYTES);
});

test('preview retains its finite output limit independently of streaming duration', async t => {
  const f = fixture(t, {
    ...source(async () => { throw new Error('Preview must not open a stream'); }),
    preview: async () => new Uint8Array(LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES + 1),
  });
  f.start('youtube.preview');
  await assert.rejects(f.runtime.closed, { reason: 'worker_failed' });
  assert.equal(f.messages.some(message => message.type === 'result'), false);
});

test('provider recovery failure aborts a pull, reports a redacted failure, and closes its source', async t => {
  let closed = false;
  const f = fixture(t, source(async () => ({
    recoveryMode: 'persistent',
    frames: (async function* () {
      yield frame;
      throw new MediaError('recovery_failed', 'https://rr1.googlevideo.com/videoplayback?signature=private');
    })(),
    markFrameAdvanced: () => undefined, setPaused: () => undefined,
    close: async () => { closed = true; },
  })));
  f.start();
  await until(() => f.messages.some(message => message.type === 'result'));
  f.read(1, 8);
  await assert.rejects(f.runtime.closed, { reason: 'provider_unavailable' });
  assert.equal(closed, true);
  const failure = f.messages.find(message => message.type === 'failure');
  assert.ok(failure && failure.type === 'failure');
  assert.doesNotMatch(failure.detail, /googlevideo|signature|private/);
  assert.equal(f.messages.at(-1)?.type, 'closed');
});

test('actual SDK recovery error identity is retained as typed private failure data', async t => {
  const f = fixture(t, source(async () => ({
    recoveryMode: 'persistent',
    frames: (async function* () { yield frame; throw new SourceRecoveryError(9); })(),
    markFrameAdvanced: () => undefined, setPaused: () => undefined, close: async () => undefined,
  })));
  f.start();
  await until(() => f.messages.some(message => message.type === 'result'));
  f.read(1, 8);
  await assert.rejects(f.runtime.closed, { reason: 'provider_unavailable',
    sourceFailure: { code: 'recovery_failed', attempts: 9 } });
  const failure = f.messages.find(message => message.type === 'failure');
  assert.ok(failure && failure.type === 'failure');
  assert.deepEqual(failure.sourceFailure, { code: 'recovery_failed', attempts: 9 });
});

test('cleanup failure is explicit rather than a successful worker closure', async t => {
  const f = fixture(t, source(async () => ({
    recoveryMode: 'persistent', frames: (async function* () { yield frame; })(),
    markFrameAdvanced: () => undefined, setPaused: () => undefined,
    close: async () => { throw new Error('Controlled cleanup failure'); },
  })));
  f.start();
  await until(() => f.messages.some(message => message.type === 'result'));
  await assert.rejects(f.runtime.stop(), { reason: 'worker_failed' });
  assert.ok(f.messages.some(message => message.type === 'failure'));
  assert.equal(f.cleanup().removed, 2);
});
