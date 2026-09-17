import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type {
  LocalConsentDecision, LocalExecutionSubject, LocalTaskFailureEvent, LocalTaskResult, LocalTaskSpec,
} from '@monky/shared';
import { LocalPermissions, localPermissionId } from '../src/main/localExecution/LocalPermissions';
import {
  LocalExecutionService, type LocalRuntimeTask, type LocalToolHost,
} from '../src/main/localExecution/service';
import { LocalExecutionError } from '../src/main/localExecution/errors';

const subject: LocalExecutionSubject = {
  connectionId: 'connection', serverOrigin: 'wss://example.test', serverId: 'server', serverName: 'Server',
  botId: 'bot', botName: 'Bot', botPublicKey: `302a300506032b6570032100${'ab'.repeat(32)}`,
};
const track = { id: 'jNQXAC9IVRw', title: 'Controlled fixture', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', duration: 19 };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function result(spec: LocalTaskSpec): LocalTaskResult {
  switch (spec.operation) {
    case 'youtube.search': return { operation: spec.operation, tracks: [track] };
    case 'youtube.resolve':
    case 'youtube.stream': return { operation: spec.operation, track };
    case 'youtube.preview': return { operation: spec.operation, mimeType: 'audio/ogg', audioBase64: 'T2dnUw==' };
  }
}

async function fixture(t: TestContext, runtimeResult?: (spec: LocalTaskSpec) => Promise<LocalTaskResult>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monky-local-service-'));
  const permissions = new LocalPermissions(path.join(root, 'permissions.json'));
  let preparations = 0;
  let prompts = 0;
  let supported = true;
  let decision: LocalConsentDecision = 'always';
  let removed: string | null = null;
  let cacheCleared = 0;
  const failures: LocalTaskFailureEvent[] = [];
  const logs: unknown[] = [];
  const runtimes: Array<LocalRuntimeTask & {
    closeCount: number; eof: boolean; playedFrames: number; paused: boolean;
    fail(error: unknown): void; completeNative(): void;
  }> = [];
  const tools: LocalToolHost = {
    initialize: async () => undefined,
    snapshot: async () => ({ supported, tools: [], toolsBytes: 0, cacheBytes: 0 }),
    prepare: async (signal) => {
      signal.throwIfAborted();
      preparations++;
      return { node: 'managed-node', ytDlp: 'managed-yt-dlp', ffmpeg: 'managed-ffmpeg' };
    },
    remove: async (tool) => {
      assert.ok(runtimes.every((runtime) => runtime.closeCount > 0), 'Workers must stop before tool removal.');
      removed = tool;
    },
    clearCache: async () => {
      assert.ok(runtimes.every((runtime) => runtime.closeCount > 0), 'Workers must stop before cache cleanup.');
      cacheCleared++;
    },
    dispose: async () => undefined,
  };
  const service = new LocalExecutionService({
    owner: 1, tools, permissions,
    dialogs: {
      consent: async (_bot, _capability, signal, prepareTools) => {
        prompts++;
        if (decision !== 'deny') await prepareTools(signal);
        return decision;
      },
      enable: async (_bot, _capability, signal, prepareTools) => { await prepareTools(signal); return true; },
      removeTool: async (_tool, _count, signal, perform) => { await perform(signal); return true; },
      clearCache: async (_count, signal, perform) => { await perform(signal); return true; },
    },
    createRuntime: async ({ spec, signal }) => {
      signal.throwIfAborted();
      const closed = deferred<void>();
      const runtime: typeof runtimes[number] = {
        result: runtimeResult ? runtimeResult(spec) : Promise.resolve(result(spec)),
        closed: closed.promise, closeCount: 0, eof: false, playedFrames: 0, paused: false,
        fail: closed.reject,
        completeNative: closed.resolve,
        readFrames: async (count) => ({
          frames: Array.from({ length: count }, () => Uint8Array.of(0xf8, 0xff, 0xfe)), done: runtime.eof,
        }),
        acknowledgeFrames: async (count) => { runtime.playedFrames = count; },
        setPaused: async (paused) => { runtime.paused = paused; },
        close: async () => { runtime.closeCount++; closed.resolve(); },
      };
      runtimes.push(runtime);
      return runtime;
    },
    changed: () => undefined,
    failed: (failure) => failures.push(failure),
    logError: (_message, error) => logs.push(error),
  });
  t.after(async () => {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  await service.setConnection({ connectionId: subject.connectionId, connected: true, voiceChannelId: 'voice' });
  return {
    service, permissions, tools, failures, logs, runtimes,
    counts: () => ({ preparations, prompts, removed, cacheCleared }),
    setSupported: (value: boolean) => { supported = value; },
    setDecision: (value: LocalConsentDecision) => { decision = value; },
  };
}

async function prepare(service: LocalExecutionService, requestId = 'prepare'): Promise<string> {
  const prepared = await service.prepare({ requestId, subject, capability: 'youtube-audio' });
  assert.equal(prepared.status, 'prepared');
  if (prepared.status !== 'prepared') throw new Error('Expected a prepared capability');
  return prepared.permit;
}

test('an initial storage error does not permanently reject later service inventory reads', async (t) => {
  const f = await fixture(t);
  let inaccessible = true;
  let initializations = 0;
  const service = new LocalExecutionService({
    owner: 2, permissions: f.permissions,
    tools: { ...f.tools, initialize: async () => {
      initializations++;
      if (inaccessible) throw new LocalExecutionError('storage_failed');
    } },
    dialogs: {
      consent: async () => assert.fail('Reading inventory must not ask for permission'),
      enable: async () => assert.fail('Reading inventory must not enable a capability'),
      removeTool: async () => assert.fail('Reading inventory must not remove a tool'),
      clearCache: async () => assert.fail('Reading inventory must not clear cache'),
    },
    createRuntime: async () => assert.fail('Reading inventory must not start a worker'),
    changed: () => undefined, failed: () => undefined, logError: () => undefined,
  });
  t.after(() => service.dispose());
  await assert.rejects(service.snapshot(), { reason: 'storage_failed' });
  inaccessible = false;
  assert.equal((await service.snapshot()).toolsBytes, 0);
  assert.equal(initializations, 2);
  await service.snapshot();
  assert.equal(initializations, 2, 'a successful initialization remains shared');
});

test('permanent consent is reused after reconnect while tools are revalidated and other servers still require consent', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.prepare({ requestId: 'initial-grant', subject, capability: 'youtube-audio' })).status, 'prepared');
  assert.deepEqual(f.counts(), { preparations: 1, prompts: 1, removed: null, cacheCleared: 0 });
  await f.service.setConnection({ connectionId: subject.connectionId, connected: false, voiceChannelId: null });
  const reconnected = { ...subject, connectionId: 'new-connection' };
  await f.service.setConnection({ connectionId: reconnected.connectionId, connected: true, voiceChannelId: 'voice' });
  assert.equal((await f.service.prepare({ requestId: 'silent-reconnect', subject: reconnected, capability: 'youtube-audio' })).status, 'prepared');
  assert.equal(f.counts().prompts, 1, 'Persistent consent does not reopen a dialog');
  assert.equal(f.counts().preparations, 2, 'The existing tools are still checked before use');
  const other = { ...subject, connectionId: 'other-connection', serverId: 'other-server', serverOrigin: 'wss://other.example.test' };
  await f.service.setConnection({ connectionId: other.connectionId, connected: true, voiceChannelId: 'voice' });
  assert.equal((await f.service.prepare({ requestId: 'another-server', subject: other, capability: 'youtube-audio' })).status, 'prepared');
  assert.equal(f.counts().prompts, 2, 'Tool availability does not authorize another server');
  assert.equal(f.counts().preparations, 3);
});

test('until-disconnect consent is not silently promoted to a permanent grant', async t => {
  const f = await fixture(t);
  f.setDecision('connection');
  assert.equal((await f.service.prepare({ requestId: 'temporary-grant', subject, capability: 'youtube-audio' })).status, 'prepared');
  await f.service.setConnection({ connectionId: subject.connectionId, connected: false, voiceChannelId: null });
  const next = { ...subject, connectionId: 'next-temporary-connection' };
  await f.service.setConnection({ connectionId: next.connectionId, connected: true, voiceChannelId: 'voice' });
  assert.equal((await f.service.prepare({ requestId: 'renew-temporary', subject: next, capability: 'youtube-audio' })).status, 'prepared');
  assert.equal(f.counts().prompts, 2);
  assert.equal((await f.permissions.list())[0].decision, 'connection');
});

test('unsupported targets and denied consent cannot install or start tools', async (t) => {
  const f = await fixture(t);
  f.setSupported(false);
  assert.deepEqual(await f.service.prepare({ requestId: 'unsupported', subject, capability: 'youtube-audio' }),
    { status: 'failed', reason: 'unsupported_platform' });
  assert.equal(f.counts().prompts, 0);
  f.setSupported(true);
  f.setDecision('deny');
  assert.deepEqual(await f.service.prepare({ requestId: 'denied', subject, capability: 'youtube-audio' }),
    { status: 'failed', reason: 'permission_denied' });
  assert.equal(f.counts().preparations, 0);
  assert.equal(f.runtimes.length, 0);
  assert.equal((await f.service.snapshot()).tasks.length, 0);
});

test('prepared permits are opaque, reused for the same binding and cannot accept caller-provided programs', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  assert.match(permit, /^[a-f0-9]{64}$/);
  assert.equal(await prepare(f.service, 'again'), permit);
  assert.equal(f.counts().prompts, 1);
  assert.deepEqual(await f.service.startTask({
    requestId: 'bad', permit, spec: { operation: 'youtube.search', query: 'fixture', executable: 'other-program' },
  }), { status: 'failed', reason: 'invalid_request' });
  assert.equal(f.runtimes.length, 0);
  const response = await f.service.startTask({
    requestId: 'search', permit, spec: { operation: 'youtube.search', query: 'fixture' },
  });
  assert.equal(response.status, 'started');
  assert.equal(f.runtimes.length, 1);
  assert.equal(f.runtimes[0].closeCount, 1);
  assert.equal((await f.service.snapshot()).tasks.length, 0);
});

test('approval does not save permission or release a permit until dialog-owned preparation succeeds', async (t) => {
  const f = await fixture(t);
  const started = deferred<void>();
  const release = deferred<void>();
  f.tools.prepare = async (signal) => {
    started.resolve();
    await release.promise;
    signal.throwIfAborted();
    return { node: 'node', ytDlp: 'yt-dlp', ffmpeg: 'ffmpeg' };
  };
  let settled = false;
  const pending = f.service.prepare({ requestId: 'dialog-installing', subject, capability: 'youtube-audio' });
  void pending.then(() => { settled = true; });
  await started.promise;
  assert.equal(settled, false);
  assert.deepEqual(await f.permissions.list(), []);
  assert.equal((await f.service.snapshot()).tasks[0]?.phase, 'installing');
  release.resolve();
  assert.equal((await pending).status, 'prepared');
  assert.equal((await f.permissions.list())[0]?.decision, 'always');
});

test('failed installation after approval leaves no permission or preparation permit', async (t) => {
  const f = await fixture(t);
  f.tools.prepare = async () => { throw new LocalExecutionError('storage_failed'); };
  assert.deepEqual(await f.service.prepare({ requestId: 'dialog-failed', subject, capability: 'youtube-audio' }),
    { status: 'failed', reason: 'storage_failed' });
  assert.deepEqual(await f.permissions.list(), []);
  assert.equal((await f.service.snapshot()).tasks.length, 0);
});

test('startup preserves typed source failure without publishing native diagnostic text', async (t) => {
  const f = await fixture(t, async () => {
    throw new LocalExecutionError('provider_unavailable', {
      sourceFailure: { code: 'unavailable' }, cause: new Error('Private native diagnostic'),
    });
  });
  const permit = await prepare(f.service);
  assert.deepEqual(await f.service.startTask({
    requestId: 'source-failure', permit, spec: { operation: 'youtube.resolve', url: track.url },
  }), { status: 'failed', reason: 'provider_unavailable', sourceFailure: { code: 'unavailable' } });
  assert.equal(f.runtimes[0].closeCount, 1);
  assert.equal(f.failures.length, 0, 'A task that never started streaming must not emit a stream failure');
});

for (const surface of ['read', 'closed'] as const) {
  test(`${surface} preserves recovery exhaustion in the task failure event`, async (t) => {
    const f = await fixture(t);
    const permit = await prepare(f.service);
    const started = await f.service.startTask({
      requestId: 'stream-failure', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
    });
    assert.equal(started.status, 'started');
    if (started.status !== 'started') throw new Error('Expected a stream');
    const sourceFailure = { code: 'recovery_failed', attempts: 5 } as const;
    const failure = new LocalExecutionError('provider_unavailable', { sourceFailure });
    if (surface === 'read') {
      f.runtimes[0].readFrames = async () => { throw failure; };
      assert.deepEqual(await f.service.readFrames({ taskId: started.taskId, count: 1 }),
        { status: 'failed', reason: 'provider_unavailable', sourceFailure });
    } else {
      f.runtimes[0].fail(failure);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(f.failures, [{ taskId: started.taskId, reason: 'provider_unavailable', sourceFailure }]);
    assert.equal(f.runtimes[0].closeCount, 1);
    assert.equal((await f.service.snapshot()).tasks.length, 0);
  });
}

test('explicit cancellation wins over a late native recovery failure', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  const started = await f.service.startTask({
    requestId: 'cancel-stream', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
  });
  assert.equal(started.status, 'started');
  if (started.status !== 'started') throw new Error('Expected a stream');
  const read = deferred<{ frames: Uint8Array[]; done: boolean }>();
  const reading = deferred<void>();
  f.runtimes[0].readFrames = () => { reading.resolve(); return read.promise; };
  const result = f.service.readFrames({ taskId: started.taskId, count: 1 });
  await reading.promise;
  await f.service.cancelTask(started.taskId);
  read.reject(new LocalExecutionError('provider_unavailable', {
    sourceFailure: { code: 'recovery_failed', attempts: 5 },
  }));
  assert.deepEqual(await result, { status: 'cancelled' });
  assert.deepEqual(f.failures, [{ taskId: started.taskId, reason: 'cancelled' }]);
});

test('cancellation is remembered even when it arrives before a delayed preparation request', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.cancelRequest({ requestId: 'cancelled-before-start' }), { status: 'completed' });
  assert.deepEqual(await f.service.prepare({
    requestId: 'cancelled-before-start', subject, capability: 'youtube-audio',
  }), { status: 'cancelled' });
  assert.equal(f.counts().prompts, 0);
  assert.equal(f.counts().preparations, 0);
});

test('streaming requires the exact live voice context and supports pause and rejoin', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  const spec = { operation: 'youtube.stream', url: track.url };
  assert.deepEqual(await f.service.startTask({ requestId: 'no-room', permit, spec }),
    { status: 'failed', reason: 'invalid_request' });
  assert.deepEqual(await f.service.startTask({ requestId: 'wrong-room', permit, spec, voiceChannelId: 'other' }),
    { status: 'failed', reason: 'executor_unavailable' });
  assert.equal(f.runtimes.length, 0);
  const started = await f.service.startTask({ requestId: 'play', permit, spec, voiceChannelId: 'voice' });
  assert.equal(started.status, 'started');
  if (started.status !== 'started') throw new Error('Stream did not start');
  assert.equal((await f.service.snapshot()).tasks[0]?.phase, 'streaming');
  const batch = await f.service.readFrames({ taskId: started.taskId, count: 2 });
  assert.equal(batch.status, 'frames');
  assert.deepEqual(await f.service.setPaused({ taskId: started.taskId, paused: true }), { status: 'completed' });
  assert.equal(f.runtimes[0].paused, true);
  assert.deepEqual(await f.service.readFrames({ taskId: started.taskId, count: 1 }), { status: 'failed', reason: 'busy' });
  await f.service.setPaused({ taskId: started.taskId, paused: false });
  assert.equal(f.runtimes[0].paused, false);
  await f.service.setConnection({ connectionId: subject.connectionId, connected: true, voiceChannelId: null });
  assert.equal(f.runtimes[0].closeCount, 1);
  assert.deepEqual(f.failures, [{ taskId: started.taskId, reason: 'executor_unavailable' }]);
  assert.equal((await f.service.snapshot()).tasks.length, 0);
  await f.service.setConnection({ connectionId: subject.connectionId, connected: true, voiceChannelId: 'voice' });
  const rejoined = await f.service.startTask({ requestId: 'future-item', permit, spec, voiceChannelId: 'voice' });
  assert.equal(rejoined.status, 'started', 'Leaving voice stops active work without deleting every future binding.');
});

test('disconnect invalidates a permit even when the same connection ID is subsequently reused', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  await f.service.setConnection({ connectionId: subject.connectionId, connected: false, voiceChannelId: null });
  await f.service.setConnection({ connectionId: subject.connectionId, connected: true, voiceChannelId: 'voice' });
  assert.deepEqual(await f.service.startTask({
    requestId: 'stale', permit, spec: { operation: 'youtube.resolve', url: track.url },
  }), { status: 'failed', reason: 'permission_denied' });
  assert.equal(f.runtimes.length, 0);
});

test('tool removal stops workers and revokes rights before files can be deleted or reinstalled', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  const started = await f.service.startTask({
    requestId: 'play', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
  });
  assert.equal(started.status, 'started');
  assert.deepEqual(await f.service.removeTool('ffmpeg'), { status: 'completed' });
  assert.equal(f.counts().removed, 'ffmpeg');
  assert.equal(f.runtimes[0].closeCount, 1);
  assert.equal((await f.permissions.list())[0]?.decision, 'deny');
  const before = f.counts().preparations;
  const next = await f.service.prepare({ requestId: 'after-removal', subject, capability: 'youtube-audio' });
  assert.equal(next.status, 'failed');
  assert.equal(f.counts().preparations, before);
});

test('cache clearing stops workers but preserves separately managed permission and tools', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  await f.service.startTask({
    requestId: 'play', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
  });
  assert.deepEqual(await f.service.clearCache(), { status: 'completed' });
  assert.equal(f.counts().cacheCleared, 1);
  assert.equal(f.counts().removed, null);
  assert.equal((await f.permissions.list())[0]?.decision, 'always');
  assert.equal(await f.permissions.assertAllowed(1, subject, 'youtube-audio'), localPermissionId(subject, 'youtube-audio'));
});

test('native EOF releases resources but retains final frames and their playback lease', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  const started = await f.service.startTask({
    requestId: 'play', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
  });
  if (started.status !== 'started') throw new Error('Stream did not start');
  f.runtimes[0].eof = true;
  const batch = await f.service.readFrames({ taskId: started.taskId, count: 2 });
  assert.equal(batch.status, 'frames');
  if (batch.status !== 'frames') throw new Error('Expected final frames');
  assert.equal(batch.frames.length, 2);
  assert.equal(batch.done, true);
  assert.deepEqual(f.failures, []);
  assert.equal(f.runtimes[0].closeCount, 1);
  assert.equal((await f.service.snapshot()).tasks.length, 1);
  assert.deepEqual(await f.service.acknowledgeFrames({ taskId: started.taskId, playedFrames: 2 }),
    { status: 'completed' });
  assert.equal(f.runtimes[0].playedFrames, 2);
  assert.equal(f.runtimes[0].closeCount, 1, 'Final playback must not close the native worker twice');
  assert.equal((await f.service.snapshot()).tasks.length, 0);
});

test('worker closure before its final read response does not erase the playback lease', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  const started = await f.service.startTask({
    requestId: 'early-native-close', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
  });
  assert.equal(started.status, 'started');
  if (started.status !== 'started') throw new Error('Expected a stream');
  f.runtimes[0].completeNative();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await f.service.snapshot()).tasks.length, 1);
  f.runtimes[0].eof = true;
  const batch = await f.service.readFrames({ taskId: started.taskId, count: 2 });
  assert.equal(batch.status, 'frames');
  assert.deepEqual(await f.service.acknowledgeFrames({ taskId: started.taskId, playedFrames: 2 }),
    { status: 'completed' });
  assert.equal((await f.service.snapshot()).tasks.length, 0);
  assert.deepEqual(f.failures, []);
});

test('all 25 outstanding frames remain acknowledgeable and pausable after native EOF', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  const started = await f.service.startTask({
    requestId: 'full-window', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
  });
  assert.equal(started.status, 'started');
  if (started.status !== 'started') throw new Error('Expected a stream');
  for (const count of [8, 8, 8, 1]) {
    f.runtimes[0].eof = count === 1;
    const batch = await f.service.readFrames({ taskId: started.taskId, count });
    assert.equal(batch.status, 'frames');
  }
  assert.equal(f.runtimes[0].closeCount, 1);
  assert.equal(f.runtimes[0].playedFrames, 0);
  assert.deepEqual(await f.service.readFrames({ taskId: started.taskId, count: 1 }),
    { status: 'frames', frames: [], done: true });
  assert.deepEqual(await f.service.setPaused({ taskId: started.taskId, paused: true }), { status: 'completed' });
  assert.equal((await f.service.snapshot()).tasks[0]?.phase, 'paused');
  assert.deepEqual(await f.service.setPaused({ taskId: started.taskId, paused: false }), { status: 'completed' });
  assert.deepEqual(await f.service.acknowledgeFrames({ taskId: started.taskId, playedFrames: 26 }),
    { status: 'failed', reason: 'invalid_request' });
  assert.deepEqual(await f.service.acknowledgeFrames({ taskId: started.taskId, playedFrames: 24 }), { status: 'completed' });
  assert.equal((await f.service.snapshot()).tasks.length, 1);
  assert.deepEqual(await f.service.acknowledgeFrames({ taskId: started.taskId, playedFrames: 25 }), { status: 'completed' });
  assert.equal(f.runtimes[0].playedFrames, 25);
  assert.equal((await f.service.snapshot()).tasks.length, 0);
  assert.deepEqual(f.failures, []);
});

test('EOF cannot finalize a playback acknowledgment that is still unconfirmed', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  const started = await f.service.startTask({
    requestId: 'pending-checkpoint', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
  });
  assert.equal(started.status, 'started');
  if (started.status !== 'started') throw new Error('Expected a stream');
  await f.service.readFrames({ taskId: started.taskId, count: 1 });
  const checkpoint = deferred<void>();
  const entered = deferred<void>();
  f.runtimes[0].acknowledgeFrames = () => { entered.resolve(); return checkpoint.promise; };
  const acknowledgment = f.service.acknowledgeFrames({ taskId: started.taskId, playedFrames: 1 });
  await entered.promise;
  f.runtimes[0].readFrames = async () => ({ frames: [], done: true });
  assert.deepEqual(await f.service.readFrames({ taskId: started.taskId, count: 1 }),
    { status: 'frames', frames: [], done: true });
  assert.equal((await f.service.snapshot()).tasks.length, 1);
  checkpoint.resolve();
  assert.deepEqual(await acknowledgment, { status: 'completed' });
  assert.equal((await f.service.snapshot()).tasks.length, 0);
});

for (const action of ['cancel', 'revoke', 'leave'] as const) {
  test(`${action} stops the remaining remote tail after native EOF, including while paused`, async (t) => {
    const f = await fixture(t);
    const permit = await prepare(f.service);
    const started = await f.service.startTask({
      requestId: 'tail-control', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
    });
    assert.equal(started.status, 'started');
    if (started.status !== 'started') throw new Error('Expected a stream');
    f.runtimes[0].eof = true;
    await f.service.readFrames({ taskId: started.taskId, count: 2 });
    await f.service.setPaused({ taskId: started.taskId, paused: true });
    const outcome = action === 'cancel' ? await f.service.cancelTask(started.taskId)
      : action === 'revoke' ? await f.service.setPermission({
        permissionId: localPermissionId(subject, 'youtube-audio'), enabled: false,
      }) : await f.service.setConnection({ connectionId: subject.connectionId, connected: true, voiceChannelId: null });
    assert.deepEqual(outcome, { status: 'completed' });
    assert.deepEqual(f.failures, [{
      taskId: started.taskId,
      reason: action === 'cancel' ? 'cancelled' : action === 'revoke' ? 'permission_revoked' : 'executor_unavailable',
    }]);
    assert.equal((await f.service.snapshot()).tasks.length, 0);
    assert.equal(f.runtimes[0].closeCount, 1);
  });
}

test('buffering never marks playback progress and played acknowledgements are bounded and monotonic', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  const started = await f.service.startTask({
    requestId: 'play', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
  });
  if (started.status !== 'started') throw new Error('Stream did not start');
  await f.service.readFrames({ taskId: started.taskId, count: 2 });
  assert.equal(f.runtimes[0].playedFrames, 0);
  assert.deepEqual(await f.service.acknowledgeFrames({ taskId: started.taskId, playedFrames: 3 }),
    { status: 'failed', reason: 'invalid_request' });
  assert.deepEqual(await f.service.acknowledgeFrames({ taskId: started.taskId, playedFrames: 2 }), { status: 'completed' });
  assert.equal(f.runtimes[0].playedFrames, 2);
  assert.deepEqual(await f.service.acknowledgeFrames({ taskId: started.taskId, playedFrames: 1 }),
    { status: 'failed', reason: 'invalid_request' });
  assert.deepEqual(await f.service.acknowledgeFrames({ taskId: started.taskId, playedFrames: 2 }), { status: 'completed' });
  assert.equal(f.runtimes[0].playedFrames, 2);
});

test('small late timer ticks do not reset the media clock and slow down the generated audio', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  const started = await f.service.startTask({
    requestId: 'play', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
  });
  if (started.status !== 'started') throw new Error('Stream did not start');
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  await f.service.readFrames({ taskId: started.taskId, count: 1 });
  now = 1031;
  await f.service.readFrames({ taskId: started.taskId, count: 1 });
  now = 1041;
  let completed = false;
  const third = f.service.readFrames({ taskId: started.taskId, count: 1 }).then((value) => {
    completed = true;
    return value;
  });
  for (let index = 0; index < 40; index++) await Promise.resolve();
  assert.equal(completed, true, 'The third frame is due at1040, not1051 after rebasing the previous late tick.');
  assert.equal((await third).status, 'frames');
});

test('owner reload cancels work and preparation permits without erasing persistent configuration', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  await f.service.startTask({
    requestId: 'play', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
  });
  await f.service.cancelOwner();
  assert.equal(f.runtimes[0].closeCount, 1);
  assert.equal((await f.permissions.list())[0]?.decision, 'always');
  assert.deepEqual(await f.service.prepare({ requestId: 'stale', subject, capability: 'youtube-audio' }),
    { status: 'failed', reason: 'executor_unavailable' });
});

test('an explicit permission revocation stops a stream without waiting for the next frame read', async (t) => {
  const f = await fixture(t);
  const permit = await prepare(f.service);
  const started = await f.service.startTask({
    requestId: 'play', permit, spec: { operation: 'youtube.stream', url: track.url }, voiceChannelId: 'voice',
  });
  if (started.status !== 'started') throw new Error('Stream did not start');
  assert.deepEqual(await f.service.setPermission({
    permissionId: localPermissionId(subject, 'youtube-audio'), enabled: false,
  }), { status: 'completed' });
  assert.deepEqual(f.failures, [{ taskId: started.taskId, reason: 'permission_revoked' }]);
  assert.equal(f.runtimes[0].closeCount, 1);
});

test('an interrupted settings approval cannot recreate removed tools', async (t) => {
  const { permissions } = await fixture(t);
  await permissions.authorize(1, subject, 'youtube-audio', new AbortController().signal, async () => 'always');
  const started = deferred<void>();
  const answer = deferred<boolean>();
  let installed = false;
  const enabling = permissions.enable(localPermissionId(subject, 'youtube-audio'), new AbortController().signal,
    async (_bot, _capability, signal) => {
      started.resolve();
      await answer.promise;
      signal.throwIfAborted();
      installed = true;
      return true;
    });
  const rejected = assert.rejects(enabling, (error: unknown) =>
    error instanceof LocalExecutionError && error.reason === 'permission_revoked');
  await started.promise;
  await permissions.revokeCapability('youtube-audio');
  answer.resolve(true);
  await rejected;
  assert.equal(installed, false);
});
