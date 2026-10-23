import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HostedServerCleanupError, HostedServerConflictError, HostedServerLifecycle,
  type HostedServerEntry, type HostedServerRuntime, type HostedServerTarget,
} from '../src/main/hostedServerLifecycle';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

class SyntheticServer implements HostedServerRuntime {
  public starts = 0;
  public stops = 0;
  public onStart: () => Promise<void> = async () => {};
  public onStop: () => Promise<void> = async () => {};

  public async start(): Promise<void> { this.starts++; await this.onStart(); }
  public async stop(): Promise<void> { this.stops++; await this.onStop(); }
}

const targetA = { port: 3000, serverId: 'a' };
const targetB = { port: 3001, serverId: 'b' };
type HostedServerStatus = { servers: HostedServerEntry[] };
const stopped: HostedServerStatus = { servers: [] };
const running = (...servers: HostedServerEntry[]): HostedServerStatus => ({ servers });
const runningA = running({ port: 3000, serverId: 'a' });
const runningB = running({ port: 3001, serverId: 'b' });

function fixture(create: (options: HostedServerTarget) => Promise<SyntheticServer>) {
  const statuses: HostedServerStatus[] = [];
  const lifecycle: HostedServerLifecycle<SyntheticServer, HostedServerTarget> = new HostedServerLifecycle(
    create, () => statuses.push(lifecycle.getStatus()),
  );
  return { lifecycle, statuses };
}

test('different servers on different ports start one after the other and run side by side', async () => {
  const gate = deferred();
  const first = new SyntheticServer();
  const second = new SyntheticServer();
  first.onStart = () => gate.promise;
  const created: HostedServerTarget[] = [];
  const { lifecycle, statuses } = fixture(async (options) => { created.push(options); return options.port === 3000 ? first : second; });
  const startA = lifecycle.start(targetA);
  const startB = lifecycle.start(targetB);
  await flush();
  assert.deepEqual(lifecycle.getStatus(), stopped);
  assert.deepEqual(created, [targetA], 'the second start waits for the first to settle');
  gate.resolve();
  await Promise.all([startA, startB]);
  assert.deepEqual(created, [targetA, targetB]);
  assert.deepEqual(statuses, [runningA, running({ port: 3000, serverId: 'a' }, { port: 3001, serverId: 'b' })]);
  assert.equal(first.stops + second.stops, 0);
  assert.equal(lifecycle.getServer(3000), first);
  assert.equal(lifecycle.getServer(3001), second);
});

test('a different server on a busy port never replaces or implicitly stops the winner', async () => {
  const gate = deferred();
  const server = new SyntheticServer();
  server.onStart = () => gate.promise;
  const created: HostedServerTarget[] = [];
  const { lifecycle, statuses } = fixture(async (options) => { created.push(options); return server; });
  const first = lifecycle.start(targetA);
  const rejected = assert.rejects(lifecycle.start({ port: 3000, serverId: 'b' }), (error) => {
    assert.ok(error instanceof HostedServerConflictError);
    assert.equal(error.reason, 'port');
    assert.equal(error.port, 3000);
    return true;
  });
  await flush();
  assert.equal(server.starts, 1);
  gate.resolve();
  await first;
  await rejected;
  assert.deepEqual(created, [targetA]);
  assert.deepEqual(statuses, [runningA]);
  assert.equal(server.stops, 0);
});

test('same-id duplicate starts await readiness and create exactly one instance', async () => {
  const gate = deferred();
  const server = new SyntheticServer();
  server.onStart = () => gate.promise;
  let creations = 0;
  const { lifecycle, statuses } = fixture(async () => { creations++; return server; });
  let completed = 0;
  const first = lifecycle.start(targetA).then(() => { completed++; });
  const second = lifecycle.start({ ...targetA }).then(() => { completed++; });
  await flush();
  assert.equal(completed, 0);
  assert.equal(creations, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(completed, 2);
  assert.equal(server.starts, 1);
  assert.equal(server.stops, 0);
  assert.equal(statuses.length, 1);
});

test('reuse requires the same port and actual data identity, including the legacy directory', async () => {
  const cases: { running: HostedServerTarget; requested: HostedServerTarget; reuse: boolean }[] = [
    { running: targetA, requested: { port: 3000, serverId: 'b' }, reuse: false },
    { running: targetA, requested: { port: 3001, serverId: 'a' }, reuse: false },
    { running: targetA, requested: { port: 3000 }, reuse: false },
    { running: { port: 3000 }, requested: targetA, reuse: false },
    { running: { port: 3000 }, requested: { port: 3000 }, reuse: true },
    { running: targetA, requested: { ...targetA }, reuse: true },
  ];
  for (const entry of cases) {
    const server = new SyntheticServer();
    let creations = 0;
    const { lifecycle } = fixture(async () => { creations++; return server; });
    await lifecycle.start(entry.running);
    const before = lifecycle.getStatus();
    if (entry.reuse) await lifecycle.start(entry.requested);
    else await assert.rejects(lifecycle.start(entry.requested), HostedServerConflictError);
    assert.deepEqual(lifecycle.getStatus(), before);
    assert.equal(creations, 1);
    assert.equal(server.starts, 1);
    assert.equal(server.stops, 0);
  }
});

test('queued starts snapshot their identity rather than following later caller mutations', async () => {
  const target = { ...targetA };
  const server = new SyntheticServer();
  const created: HostedServerTarget[] = [];
  const { lifecycle } = fixture(async (options) => { created.push(options); return server; });
  const pending = lifecycle.start(target);
  target.port = 9000;
  target.serverId = 'changed';
  await pending;
  assert.deepEqual(created, [targetA]);
  assert.deepEqual(lifecycle.getStatus(), runningA);
});

test('stop during pending creation waits for start and shutdown before a later start can run', async () => {
  // The later start reuses the port, so it truly depends on the stop finishing.
  const targetB = { port: 3000, serverId: 'b' };
  const created = deferred<SyntheticServer>();
  const startGate = deferred();
  const stopGate = deferred();
  const firstServer = new SyntheticServer();
  const secondServer = new SyntheticServer();
  firstServer.onStart = () => startGate.promise;
  firstServer.onStop = () => stopGate.promise;
  const calls: string[] = [];
  const { lifecycle, statuses } = fixture(async (options) => {
    calls.push(options.serverId ?? 'legacy');
    return options.serverId === 'a' ? created.promise : secondServer;
  });
  const first = lifecycle.start(targetA);
  const stop = lifecycle.stop(3000);
  const second = lifecycle.start(targetB);
  await flush();
  assert.deepEqual(calls, ['a']);
  assert.equal(firstServer.stops, 0);
  assert.deepEqual(lifecycle.getStatus(), stopped);
  created.resolve(firstServer);
  await flush();
  assert.equal(firstServer.starts, 1);
  assert.equal(firstServer.stops, 0);
  startGate.resolve();
  await first;
  await flush();
  assert.equal(firstServer.stops, 1);
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(lifecycle.getStatus(), runningA);
  stopGate.resolve();
  await stop;
  await second;
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(statuses, [runningA, stopped, running({ port: 3000, serverId: 'b' })]);
});

test('creation rejection leaves the queue usable for a successful retry', async () => {
  const failure = new Error('Synthetic creation failure');
  const server = new SyntheticServer();
  let creations = 0;
  const { lifecycle, statuses } = fixture(async () => {
    if (++creations === 1) throw failure;
    return server;
  });
  await assert.rejects(lifecycle.start(targetA), error => error === failure);
  assert.deepEqual(lifecycle.getStatus(), stopped);
  assert.equal(lifecycle.getServer(3000), null);
  assert.equal(statuses.length, 0);
  await lifecycle.start(targetA);
  assert.equal(creations, 2);
  assert.equal(server.starts, 1);
  assert.equal(server.stops, 0);
});

test('a failed start awaits cleanup before releasing the slot to another host', async () => {
  const failure = new Error('Synthetic start failure');
  const cleanup = deferred();
  const broken = new SyntheticServer();
  const replacement = new SyntheticServer();
  broken.onStart = async () => { throw failure; };
  broken.onStop = () => cleanup.promise;
  const created: HostedServerTarget[] = [];
  const { lifecycle, statuses } = fixture(async (options) => {
    created.push(options);
    return options.serverId === 'a' ? broken : replacement;
  });
  const rejected = assert.rejects(lifecycle.start(targetA), error => error === failure);
  const next = lifecycle.start(targetB);
  await flush();
  assert.equal(broken.stops, 1);
  assert.deepEqual(created, [targetA]);
  assert.equal(statuses.length, 0);
  cleanup.resolve();
  await rejected;
  await next;
  assert.deepEqual(created, [targetA, targetB]);
  assert.equal(replacement.starts, 1);
  assert.equal(replacement.stops, 0);
});

test('failed stop preserves ownership, rejects unhealthy reuse and permits an explicit stop retry', async () => {
  const failure = new Error('Synthetic stop failure');
  const server = new SyntheticServer();
  server.onStop = async () => { throw failure; };
  const { lifecycle, statuses } = fixture(async () => server);
  await lifecycle.start(targetA);
  const before = lifecycle.getStatus();
  await assert.rejects(lifecycle.stop(3000), error => error === failure);
  assert.equal(lifecycle.getServer(3000), server);
  assert.deepEqual(lifecycle.getStatus(), before);
  assert.equal(statuses.length, 1);
  await assert.rejects(lifecycle.start({ port: 3000, serverId: 'b' }), HostedServerConflictError);
  await assert.rejects(lifecycle.start(targetA), HostedServerConflictError);
  await assert.rejects(lifecycle.start({ port: 3009, serverId: 'a' }), HostedServerConflictError,
    'its data folder stays owned until the stop succeeds');
  assert.equal(server.stops, 1);
  server.onStop = async () => {};
  await lifecycle.stop(3000);
  assert.equal(server.stops, 2);
  assert.equal(lifecycle.getServer(3000), null);
  assert.deepEqual(lifecycle.getStatus(), stopped);
  await lifecycle.start(targetB);
  assert.equal(server.starts, 2);
});

test('duplicate concurrent stops share the lifecycle queue without stopping an instance twice', async () => {
  const gate = deferred();
  const server = new SyntheticServer();
  server.onStop = () => gate.promise;
  const { lifecycle, statuses } = fixture(async () => server);
  await lifecycle.start(targetA);
  const first = lifecycle.stop(3000);
  const second = lifecycle.stop(3000);
  await flush();
  assert.equal(server.stops, 1);
  assert.equal(lifecycle.getStatus().servers.length, 1);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(server.stops, 1);
  assert.deepEqual(statuses.at(-1), stopped);
});

test('failed startup cleanup retains the candidate until explicit shutdown succeeds', async () => {
  const startError = new Error('Synthetic start failure');
  const stopError = new Error('Synthetic cleanup failure');
  const server = new SyntheticServer();
  server.onStart = async () => { throw startError; };
  server.onStop = async () => { throw stopError; };
  const { lifecycle, statuses } = fixture(async () => server);
  await assert.rejects(lifecycle.start(targetA), error => {
    assert.ok(error instanceof HostedServerCleanupError);
    assert.equal(error.startError, startError);
    assert.equal(error.stopError, stopError);
    return true;
  });
  assert.equal(lifecycle.getServer(3000), server);
  assert.deepEqual(statuses, [runningA]);
  await assert.rejects(lifecycle.start(targetA), HostedServerConflictError);
  await assert.rejects(lifecycle.start({ port: 3000, serverId: 'b' }), HostedServerConflictError);
  server.onStop = async () => {};
  await lifecycle.stop(3000);
  assert.deepEqual(lifecycle.getStatus(), stopped);
  server.onStart = async () => {};
  await lifecycle.start(targetB);
  assert.equal(server.starts, 2);
});
