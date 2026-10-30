const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const test = require('node:test');
const { stripVTControlCharacters } = require('node:util');
const prompts = require('../dist/cli/prompts');
const { getCliLanguage, setCliLanguage, t: translate } = require('../dist/cli/i18n');

function useLanguage(t) {
  const previous = getCliLanguage();
  setCliLanguage('en');
  t.after(() => setCliLanguage(previous));
}

function replaceStdin(t, value) {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  assert.ok(original);
  Object.defineProperty(process, 'stdin', { configurable: true, value });
  t.after(() => Object.defineProperty(process, 'stdin', original));
}

function captureStdout(t, { tty } = {}) {
  const written = [];
  t.mock.method(process.stdout, 'write', (chunk) => {
    written.push(String(chunk));
    return true;
  });
  if (tty !== undefined) {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: tty });
    t.after(() => {
      if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
      else delete process.stdout.isTTY;
    });
  }
  return written;
}

function fakeTerminal(t, { wasRaw = false, wasFlowing = false } = {}) {
  const rawChanges = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: wasRaw,
    setRawMode(raw) {
      this.isRaw = raw;
      rawChanges.push(raw);
      return this;
    },
  });
  if (wasFlowing) input.resume();
  else input.pause();
  replaceStdin(t, input);
  t.after(() => input.destroy());
  return { input, rawChanges };
}

test('redirected answers that arrive in one chunk reach consecutive questions, and EOF cancels', async (t) => {
  useLanguage(t);
  const written = captureStdout(t);
  replaceStdin(t, Readable.from(['first\nsecond\n']));
  assert.equal(await prompts.ask('First question'), 'first');
  assert.equal(await prompts.ask('Second question', 'default'), 'second');
  await assert.rejects(prompts.ask('Third question'), { message: translate('prompt.cancelled') });
  await assert.rejects(prompts.confirm('Still there?'), prompts.PromptCancelledError);
  assert.ok(written.join('').includes('Second question (default): '));
});

test('a redirected password is read as one line without echo handling', async (t) => {
  useLanguage(t);
  captureStdout(t);
  replaceStdin(t, Readable.from(['  spaced secret  \nnext\n']));
  assert.equal(await prompts.promptPassword('Password: '), '  spaced secret  ');
  assert.equal(await prompts.ask('After'), 'next');
});

for (const { name, keys, expected } of [
  { name: 'arrows insert at the cursor instead of storing escape sequences', keys: 'abc\u001b[Dd\r', expected: 'abdc' },
  { name: 'Home and Delete edit the line', keys: 'x\u001b[Hy\u001b[3~\r', expected: 'y' },
  { name: 'Backspace removes the previous character', keys: 'ab\u007fc\r', expected: 'ac' },
  { name: 'Ctrl+U clears what was typed', keys: 'wrong\u0015right\r', expected: 'right' },
]) {
  test(`password on a terminal: ${name}, without echo`, async (t) => {
    useLanguage(t);
    const written = captureStdout(t);
    const terminal = fakeTerminal(t);
    const answer = prompts.promptPassword('Password: ');
    terminal.input.write(keys);
    assert.equal(await answer, expected);
    const shown = stripVTControlCharacters(written.join(''));
    assert.ok(shown.startsWith('Password: '));
    assert.doesNotMatch(shown.slice('Password: '.length), /[a-z]/, 'Nothing typed is echoed');
    assert.equal(terminal.rawChanges[terminal.rawChanges.length - 1], false, 'The cooked mode it had is restored');
    assert.equal(terminal.input.readableFlowing, false);
  });
}

for (const outcome of ['ctrl-c', 'ctrl-d', 'eof']) {
  test(`password on a terminal cancels on ${outcome} and restores the terminal`, async (t) => {
    useLanguage(t);
    captureStdout(t);
    const terminal = fakeTerminal(t, { wasRaw: true, wasFlowing: true });
    const answer = prompts.promptPassword('Password: ');
    const rejected = assert.rejects(answer, prompts.PromptCancelledError);
    if (outcome === 'ctrl-c') terminal.input.write('\u0003');
    else if (outcome === 'ctrl-d') terminal.input.write('\u0004');
    else terminal.input.end();
    await rejected;
    assert.equal(terminal.rawChanges[terminal.rawChanges.length - 1], true, 'The raw mode it had is restored');
    if (outcome !== 'eof') assert.equal(terminal.input.readableFlowing, true);
  });
}

test('Ctrl+C and Ctrl+D on a terminal question cancel instead of leaving the command hanging', async (t) => {
  useLanguage(t);
  captureStdout(t, { tty: true });
  for (const key of ['\u0003', '\u0004']) {
    const terminal = fakeTerminal(t);
    const answer = prompts.ask('Question');
    const rejected = assert.rejects(answer, prompts.PromptCancelledError);
    terminal.input.write(key);
    await rejected;
  }
});

test('multi-choice restores raw/flow state and releases its listeners on selection, cancellation, EOF and errors', async (t) => {
  useLanguage(t);
  captureStdout(t);
  for (const outcome of ['select', 'escape', 'ctrl-c', 'ctrl-d', 'end', 'close', 'error']) {
    const wasRaw = outcome === 'select';
    const wasFlowing = outcome === 'close';
    const rawChanges = [];
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: wasRaw,
      setRawMode(raw) { this.isRaw = raw; rawChanges.push(raw); return this; },
    });
    if (wasFlowing) input.resume(); else input.pause();
    const original = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { configurable: true, value: input });
    try {
      const pending = prompts.askMultiChoiceArrows('Pick', ['A', 'B', 'C']);
      if (outcome === 'select') {
        for (const key of [' ', '\u001b[B', ' ', '\r']) input.emit('data', key);
        assert.deepEqual(await pending, ['A', 'B']);
      } else {
        const rejected = assert.rejects(pending, outcome === 'error' ? /fixture input error/ : prompts.PromptCancelledError);
        if (outcome === 'escape') input.emit('data', '\u001b');
        else if (outcome === 'ctrl-c') input.emit('data', '\u0003');
        else if (outcome === 'ctrl-d') input.emit('data', '\u0004');
        else if (outcome === 'error') input.emit('error', new Error('fixture input error'));
        else input.emit(outcome);
        await rejected;
      }
      assert.deepEqual(rawChanges, [true, wasRaw], outcome);
      assert.equal(input.readableFlowing, wasFlowing, outcome);
      for (const event of ['keypress', 'end', 'close', 'error']) assert.equal(input.listenerCount(event), 0, `${outcome}: ${event}`);
      // Node's keypress decoder lets go of the stream on its next chunk once no prompt listens.
      input.emit('data', 'x');
      assert.equal(input.listenerCount('data'), 0, `${outcome}: data`);
    } finally {
      Object.defineProperty(process, 'stdin', original);
      input.destroy();
    }
  }
});

for (const { name, chunks, choices, expected } of [
  { name: 'arrows held down arrive in one read', chunks: ['\u001b[B\u001b[B\r'], choices: ['A', 'B', 'C'], expected: 'C' },
  { name: 'an arrow split across two reads moves instead of cancelling', chunks: ['\u001b', '[B', '\r'], choices: ['A', 'B'], expected: 'B' },
  { name: 'two digits typed together pick the two-digit entry', chunks: ['12'], choices: Array.from({ length: 12 }, (_, i) => `Option ${i + 1}`), expected: 'Option 12' },
]) {
  test(`arrow choice decodes keys one by one over SSH: ${name}`, { timeout: 5000 }, async (t) => {
    useLanguage(t);
    captureStdout(t);
    const terminal = fakeTerminal(t);
    const answer = prompts.askChoiceArrows('Pick', choices);
    for (const chunk of chunks) terminal.input.emit('data', chunk);
    assert.equal(await answer, expected);
    assert.deepEqual(terminal.rawChanges, [true, false]);
  });
}

test('multi-choice reads a space, an arrow and Enter that arrive in one read', { timeout: 5000 }, async (t) => {
  useLanguage(t);
  captureStdout(t);
  const terminal = fakeTerminal(t);
  const answer = prompts.askMultiChoiceArrows('Pick', ['A', 'B', 'C']);
  terminal.input.emit('data', ' \u001b[B\u001b[B \r');
  assert.deepEqual(await answer, ['A', 'C']);
});

test('the built CLI exits with an error, not success, when a redirected confirmation gets no answer', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-cli-eof-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const dataDir = path.join(root, 'server data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'server.db'), 'kept');
  // Port 1 refuses at once, so the online-users probe never waits.
  fs.writeFileSync(path.join(dataDir, 'monky.json'), JSON.stringify({ port: 1 }));
  const env = { ...process.env, MONKY_HOME: path.join(root, 'cli profile') };
  delete env.MONKY_LANG;
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/cli.js'), '--lang', 'en-US', '--data', dataDir, 'destroy'], {
    cwd: root, input: '', encoding: 'utf8', timeout: 20_000, env,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Operation cancelled\./);
  assert.equal(fs.readFileSync(path.join(dataDir, 'server.db'), 'utf8'), 'kept');
});
