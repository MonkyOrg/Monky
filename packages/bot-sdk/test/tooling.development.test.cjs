const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { PROTOCOL_VERSION, MIN_BOT_PROTOCOL } = require('@monky/shared');
const { createBotProject, validateProjectName } = require('../dist/tooling/create');
const { inspectBotProject } = require('../dist/tooling/doctor');
const toolingProcess = require('../dist/tooling/process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(__dirname, '.sdk-development-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return root;
}

test('create rejects unsafe names and existing destinations without overwriting a single file', t => {
  for (const name of ['', 'x', 'UPPER', '../escape', 'has space', 'a/b', 'a\\b', 'nul', 'com1', 'a'.repeat(65)]) {
    assert.throws(() => validateProjectName(name));
  }
  for (const name of ['my-bot', 'bot_01', 'qa-ping']) assert.equal(validateProjectName(name), name);
  const root = fixture(t);
  const target = path.join(root, 'existing');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'Do not overwrite');
  assert.throws(() => createBotProject({ directory: target, name: 'my-bot', displayName: 'My Bot', install: false }), /already exists/);
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'Do not overwrite');
  assert.deepEqual(fs.readdirSync(target), ['keep.txt']);
  const missing = path.join(root, 'new-project');
  assert.throws(() => createBotProject({ directory: missing, name: '../bad', displayName: 'My Bot', install: false }));
  assert.equal(fs.existsSync(missing), false);
});

test('doctor checks declared SDK protocol, entry and real TypeScript without changing project build metadata', t => {
  const root = fixture(t);
  t.mock.method(toolingProcess, 'runNpm', args => {
    assert.deepEqual(args, ['--version']);
    return '10.9.0\n';
  });
  const manifest = { name: 'doctor-fixture', version: '1.0.0', dependencies: { '@monky/bot-sdk': '*' },
    monkyBot: { cliName: 'doctor-fixture', entry: 'dist/index.js', modes: ['manual'] } };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'throw new Error("doctor must not execute the bot");');
  const sdk = path.join(root, 'node_modules', '@monky', 'bot-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@monky/bot-sdk', main: 'index.cjs' }));
  const sdkFile = path.join(sdk, 'index.cjs');
  fs.writeFileSync(sdkFile, `exports.PROTOCOL_VERSION = ${PROTOCOL_VERSION};`);
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, skipLibCheck: true, incremental: true, tsBuildInfoFile: './owned.tsbuildinfo' },
    files: ['index.ts'],
  }));
  fs.writeFileSync(path.join(root, 'index.ts'), 'export const greeting: string = "Pong";');
  fs.writeFileSync(path.join(root, 'owned.tsbuildinfo'), 'existing metadata must remain unchanged');
  const before = fs.readdirSync(root).sort();
  assert.ok(inspectBotProject(root).every(check => check.ok));
  assert.equal(fs.readFileSync(path.join(root, 'owned.tsbuildinfo'), 'utf8'), 'existing metadata must remain unchanged');
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.equal(fs.existsSync(path.join(root, '.keys')), false);
  require(sdkFile).PROTOCOL_VERSION = PROTOCOL_VERSION - 1;
  assert.equal(inspectBotProject(root).find(check => check.name === '@monky/bot-sdk').ok, true);
  require(sdkFile).PROTOCOL_VERSION = 24;
  assert.equal(inspectBotProject(root).find(check => check.name === '@monky/bot-sdk').ok, true);
  require(sdkFile).PROTOCOL_VERSION = MIN_BOT_PROTOCOL - 1;
  assert.equal(inspectBotProject(root).find(check => check.name === '@monky/bot-sdk').ok, false);
  require(sdkFile).PROTOCOL_VERSION = PROTOCOL_VERSION;
  fs.writeFileSync(path.join(root, 'index.ts'), 'export const greeting: string = 42;');
  assert.equal(inspectBotProject(root).find(check => check.name === 'TypeScript').ok, false);
  fs.rmSync(path.join(root, 'dist', 'index.js'));
  assert.equal(inspectBotProject(root).find(check => check.name === 'entry').ok, false);
  delete manifest.dependencies;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  assert.equal(inspectBotProject(root).find(check => check.name === '@monky/bot-sdk').ok, false);
});
