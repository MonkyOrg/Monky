import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeFailure } from './infrastructure/lifecycle/ServerResourceScope';
import { Logger } from './infrastructure/logger/Logger';
import { formatLogMeta, LOG_ENTRY_MAX_LENGTH } from './infrastructure/logger/logFormat';
import { ServerLogScope } from './infrastructure/logger/ServerLogScope';

test('a warning keeps the error it reports, with its stack, cause and aggregated errors', (t) => {
  t.mock.method(console, 'warn', () => {});
  Logger.clearBuffer();
  const reason = new Error('Disk full', { cause: new Error('ENOSPC on the data directory') });
  Logger.warn('ATTACHMENT', 'Startup reconciliation failed', reason);
  Logger.warn('NETWORK', 'Failed to send LAN discovery broadcast.',
    new AggregateError([new Error('First interface down'), new Error('Second interface down')], 'Every broadcast failed'));
  const [single, aggregate] = Logger.getRecent().map((entry) => entry.message);
  assert.notEqual(single, 'Startup reconciliation failed | {}', 'an Error used to be written as {}');
  assert.match(single, /^Startup reconciliation failed \| Error: Disk full\n\s+at /);
  assert.match(single, /ENOSPC on the data directory/);
  assert.match(aggregate, /Every broadcast failed/);
  assert.match(aggregate, /First interface down/);
  assert.match(aggregate, /Second interface down/);
  Logger.clearBuffer();
});

test('metadata JSON cannot represent is still logged, and the log call never throws', (t) => {
  t.mock.method(console, 'log', () => {});
  const circular: Record<string, unknown> = { name: 'loop' };
  circular.self = circular;
  assert.equal(formatLogMeta({ code: 7, reason: 'busy' }), '{"code":7,"reason":"busy"}');
  assert.equal(formatLogMeta('line\nbreak'), '"line\\nbreak"', 'text stays escaped: it cannot forge a second line');
  assert.match(formatLogMeta({ size: 12n }), /"size":"12n"/);
  assert.match(formatLogMeta({ failure: new Error('Nested failure') }), /Nested failure/);
  assert.match(formatLogMeta(circular), /loop/);
  assert.doesNotThrow(() => Logger.info('INFO', 'Circular metadata', circular));
  assert.doesNotThrow(() => Logger.info('INFO', 'BigInt metadata', 1n));
});

test('an oversized entry is cut, in the console and in every buffer, and remote viewers get only the fixed message', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  Logger.clearBuffer();
  const scope = new ServerLogScope();
  Logger.withScope(scope, () => Logger.warn('ATTACHMENT', 'Startup reconciliation failed', new Error('x'.repeat(1_000_000))));
  const [local] = scope.recentLocal();
  const [buffered] = Logger.getRecent();
  for (const message of [local.message, buffered.message]) {
    assert.ok(message.length <= LOG_ENTRY_MAX_LENGTH, `kept ${message.length} characters`);
    assert.match(message, /^Startup reconciliation failed \| Error: x+/);
    assert.match(message, / … \[\d+ characters truncated\]$/);
  }
  const line = String(warn.mock.calls[0].arguments[0]);
  assert.ok(line.length < LOG_ENTRY_MAX_LENGTH + 100, 'the console line is bounded too');
  assert.deepEqual(scope.read().entries.map((entry) => entry.message), ['Startup reconciliation failed']);
  Logger.clearBuffer();
});

test('a failure is named in one line, whatever was thrown', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(describeFailure(new Error('Port in use')), 'Port in use');
  assert.equal(describeFailure('Plain reason'), 'Plain reason');
  assert.equal(describeFailure({ code: 'EADDRINUSE' }), '{"code":"EADDRINUSE"}', 'not "[object Object]"');
  assert.doesNotThrow(() => describeFailure(circular));
  assert.doesNotThrow(() => describeFailure(Object.create(null)));
});
