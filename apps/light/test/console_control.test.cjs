const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { nativeExecutable } = require('./native_test_paths.cjs');

function start(t, args = []) {
  const child = spawn(nativeExecutable('monky-light-console-test'), args, { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const closed = once(child, 'close');
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  return { child, closed, output: () => ({ stdout, stderr }) };
}

test('native console accepts fragmented UTF-8 lines, CRLF and an unterminated final command', { timeout: 5000 }, async t => {
  const fixture = start(t);
  const input = Buffer.from('one\r\ntw\u00f6\nthree');
  fixture.child.stdin.write(input.subarray(0, 4));
  fixture.child.stdin.write(input.subarray(4, 8));
  fixture.child.stdin.end(input.subarray(8));
  assert.deepEqual(await fixture.closed, [0, null]);
  assert.equal(fixture.output().stdout.replace(/\r\n/g, '\n'), 'ready\nline:one\nline:tw\u00f6\nline:three\n');
  assert.equal(fixture.output().stderr, '');
});

test('native console teardown cancels a pending read while the controller keeps stdin open', { timeout: 5000 }, async t => {
  const fixture = start(t, ['--stop-with-open-input']);
  assert.deepEqual(await fixture.closed, [0, null]);
  assert.equal(fixture.output().stderr, '');
});

test('native console rejects unbounded commands and still releases its threads', { timeout: 5000 }, async t => {
  const fixture = start(t);
  fixture.child.stdin.end('x'.repeat(65537));
  assert.deepEqual(await fixture.closed, [2, null]);
  assert.match(fixture.output().stderr, /exceeded 64 KiB/);
});

test('native console quit does not wait for the controller to close stdin', { timeout: 5000 }, async t => {
  const fixture = start(t);
  fixture.child.stdin.write('quit\n');
  assert.deepEqual(await fixture.closed, [0, null]);
  assert.equal(fixture.output().stderr, '');
});
