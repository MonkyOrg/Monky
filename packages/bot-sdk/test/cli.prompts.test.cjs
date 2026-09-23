const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { askCliChoice, askCliText, CliPromptCancelled } = require('../dist/cli/prompts');

function terminal() {
  const input = new PassThrough();
  const chunks = [];
  const output = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk.toString()); done(); } });
  input.isTTY = output.isTTY = true;
  input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  input.pause();
  return { input, output, text: () => chunks.join('') };
}

test('arrow menus use real key decoding, wrap and restore terminal state without leaked listeners', async () => {
  const io = terminal();
  const choices = Array.from({ length: 12 }, (_, index) => ({ value: String(index), label: `Option ${index}` }));
  for (let run = 0; run < 25; run++) {
    const before = io.input.listenerCount('keypress');
    const result = askCliChoice('en', 'Choose', choices, '0', io);
    io.input.write('\x1b[A');
    io.input.write('\r');
    assert.equal(await result, '11');
    assert.equal(io.input.isRaw, false);
    assert.equal(io.input.isPaused(), true);
    assert.equal(io.input.listenerCount('keypress'), before);
    for (const event of ['end', 'close', 'error']) assert.equal(io.input.listenerCount(event), 0);
  }
  assert.match(io.text(), /arrow keys and Enter/);
  io.input.destroy();
  io.output.end();
});

for (const cancel of ['\x1b', '\x03', 'end']) test(`choice cancellation releases the terminal (${JSON.stringify(cancel)})`, async () => {
  const io = terminal();
  const result = askCliChoice('pt-BR', 'Menu', [{ value: 'a', label: 'A' }], undefined, io);
  const rejected = assert.rejects(result, CliPromptCancelled);
  if (cancel === 'end') io.input.end();
  else io.input.write(cancel);
  await rejected;
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.listenerCount('keypress'), 0);
  io.input.destroy();
  io.output.end();
});

test('hidden input never prints the value, including pasted PATs and backspace', async () => {
  const io = terminal();
  const token = 'github_pat_synthetic_fixture_1234567890';
  const result = askCliText('en', 'GitHub token', { secret: true }, io);
  io.input.write(token + 'x\x7f\r');
  assert.equal(await result, token);
  assert.match(io.text(), /GitHub token/);
  assert.equal(io.text().includes(token), false);
  assert.equal(io.text().includes('synthetic'), false);
  assert.equal(io.input.isRaw, false);
  assert.equal(io.output.listenerCount('resize'), 0);
  io.input.destroy();
  io.output.end();
});

test('an initially idle terminal is paused on menu exit instead of keeping the CLI alive', async () => {
  const io = terminal();
  io.input.destroy();
  io.input = new PassThrough();
  io.input.isTTY = true;
  io.input.setRawMode = raw => { io.input.isRaw = raw; };
  assert.equal(io.input.readableFlowing, null);
  assert.equal(io.input.isPaused(), false);
  const result = askCliChoice('en', 'Menu', [{ value: 'exit', label: 'Exit' }], undefined, io);
  io.input.write('\r');
  assert.equal(await result, 'exit');
  assert.equal(io.input.readableFlowing, false);
  assert.equal(io.input.listenerCount('keypress'), 0);
  io.input.destroy();
  io.output.end();
});

test('text cancellation and non-TTY input cannot hang or claim a selection', async () => {
  const io = terminal();
  const result = askCliText('en', 'Secret', { secret: true }, io);
  const rejected = assert.rejects(result, CliPromptCancelled);
  io.input.write('unsaved-synthetic-value\x03');
  await rejected;
  assert.equal(io.text().includes('unsaved'), false);
  assert.equal(io.input.isRaw, false);
  io.input.isTTY = false;
  assert.throws(() => askCliChoice('en', 'Menu', [{ value: 'a', label: 'A' }], undefined, io), /interactive terminal/);
  await assert.rejects(askCliText('en', 'Value', {}, io), /interactive terminal/);
  io.input.destroy();
  io.output.end();
});
