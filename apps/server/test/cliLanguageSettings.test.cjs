const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const cli = path.resolve(__dirname, '..', 'dist', 'cli.js');

function profile(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-cli-language-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, MONKY_HOME: home, MONKY_LANG: '', CI: 'true', NODE_OPTIONS: '' },
    });
    assert.ifError(result.error);
    return result;
  };
  return { home, run };
}

test('CLI settings change pt-BR/en-US without a server or identity and preserve other global settings', t => {
  const { home, run } = profile(t);
  const file = path.join(home, 'cli-config.json');
  fs.writeFileSync(file, JSON.stringify({ language: 'pt-BR', existingSetting: { retain: true } }));
  for (const [input, language] of [['en-US', 'en'], ['pt-br', 'pt-BR']]) {
    const result = run('config', 'language', input, '--lang', input);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(input === 'en-US' ? 'en-US' : 'pt-BR'));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { language, existingSetting: { retain: true } });
    assert.deepEqual(fs.readdirSync(home), ['cli-config.json']);
  }
  const before = fs.readFileSync(file, 'utf8');
  const invalid = run('config', 'language', 'fr', '--lang', 'en-US');
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /config language/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('language queries do not create state and a saved language is reused in a fresh invocation', t => {
  const { home } = profile(t);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', timeout: 15_000,
    env: Object.fromEntries(Object.entries({ ...process.env, MONKY_HOME: home, CI: 'true', NODE_OPTIONS: '' })
      .filter(([key]) => key !== 'MONKY_LANG')),
  });
  const query = run('config', 'language', '--lang', 'en-US');
  assert.ifError(query.error);
  assert.equal(query.status, 0, query.stderr);
  assert.match(query.stdout, /CLI language: en-US/);
  assert.deepEqual(fs.readdirSync(home), []);
  const update = run('config', 'language', 'pt-BR');
  assert.equal(update.status, 0, update.stderr);
  const reopened = run('config', 'language');
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.match(reopened.stdout, /Idioma do CLI: pt-BR/);
  assert.deepEqual(fs.readdirSync(home), ['cli-config.json']);
});
