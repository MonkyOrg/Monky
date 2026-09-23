const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { LocalExecutionError, LocalExecutionRpcError, ProtocolErrorCode } = require('../dist/index.js');

test('local admission failures expose bounded typed causes without inventing admitted task events', () => {
  const disconnected = new LocalExecutionRpcError(ProtocolErrorCode.BOT_INTERACTION_EXPIRED, 'requester_disconnected');
  assert.equal(disconnected.cancellationCause, 'requester_disconnected');
  assert.equal(disconnected.reason, undefined);
  assert.equal('event' in disconnected, false);
  const denied = new LocalExecutionRpcError(ProtocolErrorCode.PERMISSION_DENIED, 'permission_denied');
  assert.equal(denied.reason, 'permission_denied');
  assert.equal(denied.cancellationCause, undefined);
  const ordinary = new LocalExecutionRpcError(ProtocolErrorCode.BAD_REQUEST, 'A human-readable server error.');
  assert.equal(ordinary.reason, undefined);
  assert.equal(ordinary.cancellationCause, undefined);
});

test('local execution adapters type-check against the actual public SDK declarations', () => {
  execFileSync(process.execPath, [
    require.resolve('typescript/bin/tsc'),
    '--noEmit', '--strict', '--target', 'ES2020', '--module', 'commonjs',
    '--moduleResolution', 'node', '--esModuleInterop', '--skipLibCheck',
    path.join(__dirname, '..', 'type-tests', 'local-execution.ts'),
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
});

test('local execution errors preserve the exact requester departure cause without retaining mutable input', () => {
  const event = { state: 'cancelled', taskId: 'task', cause: 'requester_left_voice' };
  const error = new LocalExecutionError(event);
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'LocalExecutionError');
  assert.deepEqual(error.event, event);
  assert.notEqual(error.event, event);
  assert.equal(Object.isFrozen(error.event), true);
  event.cause = 'requested';
  assert.equal(error.event.cause, 'requester_left_voice');
  assert.equal(Reflect.set(error.event, 'cause', 'requested'), false);
});

test('local execution errors retain bounded recovery failure details separately from cancellation', () => {
  const event = {
    state: 'failed', taskId: 'task', reason: 'provider_unavailable',
    sourceFailure: { code: 'recovery_failed', attempts: 5 },
  };
  const error = new LocalExecutionError(event);
  assert.deepEqual(error.event, event);
  assert.equal(Object.isFrozen(error.event.sourceFailure), true);
  event.sourceFailure.attempts = 1;
  assert.equal(error.event.sourceFailure.attempts, 5);
  assert.match(error.message, /provider_unavailable/);
});

test('local execution errors reject nonterminal, malformed and cancellation-shaped failure events', () => {
  for (const event of [
    { state: 'ready', taskId: 'task', mediaGeneration: 1 },
    { state: 'completed', taskId: 'task' },
    { state: 'cancelled', taskId: 'task', cause: 'invented' },
    { state: 'failed', taskId: 'task', reason: 'permission_revoked' },
    { state: 'failed', taskId: 'task', reason: 'provider_unavailable', sourceFailure: { code: 'recovery_failed', attempts: 101 } },
    { state: 'failed', taskId: 'task', reason: 'worker_failed', stderr: 'private executable details' },
  ]) assert.throws(() => new LocalExecutionError(event));
});
