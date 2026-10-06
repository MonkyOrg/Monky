'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.resolve(__dirname, '..', 'runtime', 'nativeThumbnail.cjs');
const source = { kind: 'window', hwnd: 123, expectedProcessId: 456, expectedProcessCreationTime100ns: '789' };
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const children = [], commands = [];
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports) { ${fs.readFileSync(filename, 'utf8')}\n})`, { filename })(
    name => name === 'node:child_process' ? { spawn(file, args, options) {
      const child = new EventEmitter();
      child.pid = 100 + children.length;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kills = 0; child.kill = () => { child.kills++; return true; };
      child.finish = (code = 0) => { child.emit('close', code); };
      children.push(child); commands.push({ file, args, options });
      return child;
    } } : name.startsWith('./') ? require(`../runtime/${name.slice(2)}`) : require(name),
    module, module.exports);
  const capture = new module.exports.NativeThumbnailCapturer({
    kind: 'verified-native-thumbnail-host', executable: path.resolve(__dirname, 'owned-helper.exe'),
  });
  t.after(async () => {
    const closing = capture.close();
    for (const child of children) child.finish(1);
    await closing;
  });
  return { capture, children, commands };
}

test('native thumbnails pass exact source identity, use no shell, and wait for child exit after image delivery', async t => {
  const f = fixture(t);
  let completed = false;
  const job = f.capture.capture(source).then(value => { completed = true; return value; });
  assert.deepEqual(f.commands[0].args, ['--window', '123', '456', '789', '320', '180']);
  assert.equal(f.commands[0].options.shell, false);
  assert.equal(f.commands[0].options.windowsHide, true);
  f.children[0].stdout.write(image); await tick();
  assert.equal(completed, false);
  f.children[0].finish();
  assert.deepEqual(await job, image);
});

test('native thumbnails preserve physical monitor identity and reject unsafe dimensions or game hooks before spawning', async t => {
  const f = fixture(t), target = { kind: 'monitor', deviceId: String.raw`\\?\DISPLAY#SYNTHETIC#ONE`,
    deviceName: String.raw`\\.\DISPLAY2`, bounds: { x: -2560, y: -144, width: 2560, height: 1440 } };
  const job = f.capture.capture(target);
  assert.deepEqual(f.commands[0].args, ['--monitor', target.deviceId, target.deviceName, '-2560', '-144', '2560', '1440', '320', '180']);
  f.children[0].stdout.write(image); f.children[0].finish(); await job;
  assert.throws(() => f.capture.capture({ ...source, kind: 'game' }), /never a game hook/);
  assert.throws(() => f.capture.capture(source, { width: 641 }));
  assert.throws(() => f.capture.capture(source, { height: 0 }));
  assert.equal(f.children.length, 1);
});

test('preview concurrency stays bounded and cancellation retains slots until actual process close', async t => {
  const f = fixture(t), abort = new AbortController();
  const jobs = Array.from({ length: 6 }, (_, index) => f.capture.capture(source, index === 0 ? { signal: abort.signal } : {}));
  const first = assert.rejects(jobs[0], { name: 'AbortError' });
  assert.equal(f.children.length, 4);
  abort.abort(); await tick();
  assert.equal(f.children[0].kills, 1);
  assert.equal(f.children.length, 4);
  f.children[0].finish(1); await first; await tick();
  assert.equal(f.children.length, 5);
  for (let i = 1; i < 6; i++) {
    f.children[i].stdout.write(image); f.children[i].finish(); await tick();
  }
  await Promise.all(jobs.slice(1));
});

test('timeout discards output and does not claim retirement until child exit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const job = f.capture.capture(source);
  const rejected = assert.rejects(job, { code: 'ERR_DESKTOP_PREVIEW_TIMEOUT' });
  f.children[0].stdout.write(image);
  t.mock.timers.tick(5000);
  assert.equal(f.children[0].kills, 1);
  let closed = false;
  const closing = f.capture.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  f.children[0].finish(); await rejected; await closing;
});

test('native watchdog exit and malformed or oversized images cannot produce successful previews', async t => {
  const f = fixture(t);
  for (const [payload, exit, code] of [
    [image, 124, 'ERR_DESKTOP_PREVIEW_TIMEOUT'],
    [Buffer.from('not an image'), 0, 'ERR_DESKTOP_PREVIEW_OUTPUT'],
    [Buffer.alloc(1024 * 1024 + 1), 0, 'ERR_DESKTOP_PREVIEW_OUTPUT'],
  ]) {
    const job = f.capture.capture(source), rejected = assert.rejects(job, { code });
    const child = f.children.at(-1);
    child.stdout.write(payload); child.finish(exit); await rejected;
  }
});

test('failure diagnostics retain a bounded code but never stderr paths, titles or media data', async t => {
  const f = fixture(t), job = f.capture.capture(source);
  const rejected = assert.rejects(job, error => {
    assert.equal(error.code, 'ERR_DESKTOP_PREVIEW_SOURCE_CHANGED');
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  f.children[0].stderr.write('ERR_DESKTOP_PREVIEW_SOURCE_CHANGED PRIVATE_WINDOW_TITLE PRIVATE_PATH\n');
  f.children[0].finish(2); await rejected;
});

test('native preview HRESULTs remain observable without forwarding arbitrary stderr', async t => {
  const f = fixture(t), job = f.capture.capture(source);
  const rejected = assert.rejects(job, error => {
    assert.equal(error.code, 'ERR_DESKTOP_PREVIEW_NATIVE');
    assert.equal(error.hresult, 0x887a0005);
    return true;
  });
  f.children[0].stderr.write('ERR_DESKTOP_PREVIEW_NATIVE HRESULT=0x887A0005\n');
  f.children[0].finish(1); await rejected;
});

test('closing rejects queued previews without spawning and awaits every original active child', async t => {
  const f = fixture(t), jobs = Array.from({ length: 6 }, () => f.capture.capture(source));
  const rejected = jobs.map(job => assert.rejects(job, { name: 'AbortError' }));
  const closing = f.capture.close();
  assert.equal(f.children.length, 4);
  assert.ok(f.children.every(child => child.kills === 1));
  for (const child of f.children) child.finish(1);
  await Promise.all([...rejected, closing]);
  await assert.rejects(f.capture.capture(source), { name: 'AbortError' });
  assert.equal(f.children.length, 4);
});

test('native thumbnail pipe failures cannot crash Main or retire a live child early', async t => {
  const f = fixture(t);
  for (const name of ['stdout', 'stderr']) {
    let settled = false;
    const job = f.capture.capture(source);
    const rejected = assert.rejects(job, { code: 'ERR_DESKTOP_PREVIEW_PIPE' }).then(() => { settled = true; });
    const child = f.children.at(-1);
    assert.doesNotThrow(() => child[name].emit('error', new Error('PRIVATE_PIPE_DETAILS')));
    await tick();
    assert.equal(child.kills, 1);
    assert.equal(settled, false);
    assert.equal(f.capture.active.size, 1);
    child.finish(1);
    await rejected; await tick();
    assert.equal(f.capture.active.size, 0);
  }
});
