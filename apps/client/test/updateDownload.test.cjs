const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const ts = require('typescript');

function fixture(respond, redirect) {
  const filename = path.resolve(__dirname, '../src/main/updateDownload.ts');
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  const requests = [];
  vm.runInNewContext(code, {
    module, exports: module.exports, URL, Buffer, Error,
    require(id) {
      if (id !== 'node:https') return require(id);
      return { get(url, options, callback) {
        requests.push(String(url));
        const request = new EventEmitter();
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = { 'content-length': '10' };
        const abort = () => {
          response.destroy(options.signal.reason);
          request.emit('error', options.signal.reason);
        };
        options.signal.addEventListener('abort', abort, { once: true });
        response.on('close', () => options.signal.removeEventListener('abort', abort));
        queueMicrotask(() => {
          if (redirect && requests.length === 1) {
            response.statusCode = 302;
            response.headers = { location: redirect };
          }
          callback(response);
          respond(response, requests.length);
        });
        return request;
      } };
    },
  }, { filename });
  return { downloadToFile: module.exports.downloadToFile, requests };
}

test('cancelled macOS transfer closes the stream, removes the partial file and can be retried', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-update-download-'));
  const destination = path.join(root, 'update.dmg');
  let response;
  const f = fixture(value => { response = value; value.write('12345'); });
  const controller = new AbortController();
  try {
    const pending = f.downloadToFile('https://github.com/update.dmg', destination, controller.signal, () => {});
    while (!fs.existsSync(`${destination}.part`)) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, /abort/i);
    assert.equal(response.destroyed, true);
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(`${destination}.part`), false);
    const retry = fixture(value => value.end('1234567890'));
    await retry.downloadToFile('https://github.com/update.dmg', destination, new AbortController().signal, () => {});
    assert.equal(fs.readFileSync(destination, 'utf8'), '1234567890');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('redirecting to an untrusted host never sends the second request or publishes a file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-update-download-'));
  const f = fixture(response => response.end(), 'https://attacker.invalid/update.dmg');
  const destination = path.join(root, 'update.dmg');
  try {
    await assert.rejects(f.downloadToFile('https://github.com/update.dmg', destination,
      new AbortController().signal, () => {}), /Untrusted/);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interrupted downloads never publish an incomplete installer or retain their partial file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-update-download-'));
  const f = fixture(response => {
    response.write('12345');
    setImmediate(() => response.destroy(new Error('Transfer interrupted')));
  });
  try {
    await assert.rejects(f.downloadToFile('https://github.com/update.dmg', path.join(root, 'update.dmg'),
      new AbortController().signal, () => {}), /interrupted/);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
