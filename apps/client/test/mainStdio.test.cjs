'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { sourceLoader, client } = require('./crashRecoveryFixture.cjs');

function fixture() {
  const stdout = new EventEmitter(), stderr = new EventEmitter(), logs = [];
  const loader = sourceLoader(new Map(), { process: { stdout, stderr } });
  return { stdout, stderr, logs, guard: loader.main('mainStdio') };
}

test('console EPIPE before logger initialization is recorded once after initialization', () => {
  const f = fixture();
  const broken = Object.assign(new Error('private exception text'), { code: 'EPIPE' });
  for (let i = 0; i < 3; i++) f.stderr.emit('error', broken);
  f.stdout.emit('error', broken);
  f.guard.setMainStdioLogger({ write: entry => f.logs.push(entry) });
  assert.equal(f.logs.length, 2);
  assert.ok(f.logs.every(entry => entry.level === 'WARN' && entry.category === 'APP'));
  assert.doesNotMatch(JSON.stringify(f.logs), /private exception text/);
  f.stderr.emit('error', broken);
  assert.equal(f.logs.length, 2, 'Repeated errors cannot flood persistent logs');
});

test('stdio listeners never suppress other output errors or exceptions in diagnostic logging', () => {
  const f = fixture();
  const error = Object.assign(new Error('output failure'), { code: 'EIO' });
  assert.throws(() => f.stdout.emit('error', error), value => value === error);
  assert.throws(() => f.stderr.emit('error', new Error('unrelated')), /unrelated/);
  f.guard.setMainStdioLogger({ write() { throw new Error('diagnostic failure'); } });
  assert.throws(() => f.stderr.emit('error', Object.assign(new Error(), { code: 'EPIPE' })), /diagnostic failure/);
});

test('the actual release entry installs stdio protection before other Main imports', () => {
  const main = fs.readFileSync(path.join(client, 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /^import \{ setMainStdioLogger \} from '\.\/mainStdio';/);
  assert.match(main, /clientLogger = new ClientLogger\(\);\s+setMainStdioLogger\(clientLogger\);/);
  assert.doesNotMatch(fs.readFileSync(path.join(client, 'src', 'main', 'mainStdio.ts'), 'utf8'), /uncaughtException/);
});
