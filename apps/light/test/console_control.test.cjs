const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { nativeExecutable } = require('./native_test_paths.cjs');

function start(t, args = [], { inConsole = false } = {}) {
  const program = nativeExecutable('monky-light-console-test');
  // Inside a pseudoconsole the program reads and writes the console itself, and
  // "#close" or "#interrupt" on the host's stdin reach it as from a real window.
  const child = inConsole
    ? spawn(nativeExecutable('monky-light-console-host'), ['--console-stdio', program, ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const closed = once(child, 'close');
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  return { child, closed, output: () => ({ stdout, stderr }) };
}

async function ready(fixture) {
  const deadline = Date.now() + 5000;
  while (!fixture.output().stdout.includes('ready')) {
    assert.ok(Date.now() < deadline, `The console program never started: ${JSON.stringify(fixture.output())}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
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

test('closing the console holds the process while the core logs out, and main still ends it',
  { skip: process.platform !== 'win32', timeout: 15_000 }, async t => {
    const fixture = start(t, ['--slow-teardown'], { inConsole: true });
    await ready(fixture);
    const started = Date.now();
    fixture.child.stdin.write('#close\n');
    // 0xC000013A is Windows ending the process when the console handler returns:
    // before the teardown without the hold, or after it when main cannot finish.
    assert.deepEqual(await fixture.closed, [0, null], 'Windows ended the process instead of main');
    assert.ok(Date.now() - started < 3000, 'The process sat out the whole hold instead of exiting through main');
  });

test('Ctrl+C typed into the console stops the process without holding it',
  { skip: process.platform !== 'win32', timeout: 15_000 }, async t => {
    const fixture = start(t, ['--slow-teardown'], { inConsole: true });
    await ready(fixture);
    const started = Date.now();
    fixture.child.stdin.write('#interrupt\n');
    assert.deepEqual(await fixture.closed, [0, null]);
    assert.ok(Date.now() - started < 3000, 'Ctrl+C held the process as closing the console does');
  });

test('a console that stops working at once, as Windows 10 and Windows Server 2022 close it, ends the input',
  { skip: process.platform !== 'win32', timeout: 15_000 }, async t => {
    const fixture = start(t, [], { inConsole: true });
    await ready(fixture);
    fixture.child.stdin.write('#close-abruptly\n');
    // 2 is the program's error path: the read that failed with the console was
    // taken for a broken input rather than its end.
    assert.deepEqual(await fixture.closed, [0, null], 'Losing the console was reported as an input error');
  });
