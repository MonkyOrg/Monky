'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const client = path.resolve(__dirname, '..');
const artifacts = path.join(client, 'dist-test', 'main-stdio-smoke');

async function child() {
  const guarded = process.argv.includes('--guarded');
  const { app, BrowserWindow, screen, ipcMain } = require('electron');
  const profile = path.join(artifacts, guarded ? 'guarded-profile' : 'baseline-profile');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  const log = path.join(profile, 'stdio.jsonl');
  fs.writeFileSync(log, '');
  // Test-only observer prevents Electron's default dialog in the negative case.
  process.on('uncaughtException', error => {
    process.send({ fatal: error.code ?? error.name }, () => app.exit(81));
  });
  if (guarded) require(path.join(client, 'dist-electron', 'main', 'mainStdio.js'))
    .setMainStdioLogger({ write: entry => fs.appendFileSync(log, JSON.stringify(entry) + '\n') });
  const placement = require('./fixtures/testDisplay.cjs').installTestDisplay({ app, BrowserWindow, screen });
  await app.whenReady();
  const options = { show: false, width: 320, height: 240, webPreferences: {
    preload: path.join(client, 'dist-electron', 'preload', 'preload.js'),
    nodeIntegration: false, contextIsolation: true, sandbox: false, offscreen: true,
  } };
  const window = placement ? placement.createWindow(options) : new BrowserWindow(options);
  ipcMain.handle('overlay:layout-cards', () => { throw new Error('Owned rejected IPC fixture'); });
  ipcMain.handle('overlay:get-config', () => ({ responsive: true }));
  await window.loadURL('data:text/html,<title>Owned stdio fixture</title>');
  process.once('message', async message => {
    if (!message.run) return;
    try {
      let rejections = 0;
      for (let wave = 0; wave < 2; wave++) {
        rejections += await window.webContents.executeJavaScript(`(async () => {
          let rejected = 0;
          for (let i = 0; i < 3; i++) {
            try { await window.api.layoutOverlayCards({}); }
            catch { rejected++; }
          }
          return rejected;
        })()`);
        console.log('Owned stdout after reader disconnected');
        await delay(150);
      }
      const healthy = await window.webContents.executeJavaScript('window.api.getOverlayConfig()');
      process.send({ completed: true, rejections, healthy: healthy.responsive }, () => {
        placement?.dispose();
        window.destroy();
        app.exit(0);
      });
    } catch (error) {
      process.send({ failure: error.message }, () => app.exit(1));
    }
  });
  process.send({ ready: true });
}

async function run(guarded) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const processChild = spawn(require('electron'), [__filename, ...(guarded ? ['--guarded'] : [])], {
    cwd: client, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages = [];
  let output = '', timer;
  try {
    const exit = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Stdio fixture timed out: ${output}`)), 60000);
      processChild.once('error', reject);
      processChild.once('exit', (code, signal) => resolve({ code, signal }));
      for (const stream of [processChild.stdout, processChild.stderr]) stream.on('data', chunk => {
        output = (output + chunk.toString()).slice(-16000);
      });
      processChild.on('message', message => {
        messages.push(message);
        if (message.ready) {
          processChild.stdout.destroy();
          processChild.stderr.destroy();
          processChild.send({ run: true });
        }
      });
    });
    if (guarded) {
      assert.equal(exit.code, 0, JSON.stringify({ exit, messages, output }));
      assert.deepEqual(messages.at(-1), { completed: true, rejections: 6, healthy: true });
      const entries = fs.readFileSync(path.join(artifacts, 'guarded-profile', 'stdio.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(entries.length, 2);
      for (const output of ['stdout', 'stderr']) assert.ok(entries.some(entry => entry.message.includes(output)));
    } else {
      assert.equal(exit.code, 81, JSON.stringify({ exit, messages, output }));
      assert.ok(messages.some(message => message.fatal === 'EPIPE'), 'The unguarded Electron path must reproduce EPIPE');
    }
    return { guarded, exit: exit.code, messages };
  } finally {
    clearTimeout(timer);
    if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill();
  }
}

if (process.versions.electron) {
  child().catch(error => { process.send?.({ failure: error.message }); require('electron').app.exit(1); });
} else {
  (async () => {
    const results = [await run(false), await run(true)];
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(results, null, 2));
    console.log('Real Electron pipes: baseline EPIPE reproduced; guarded stdout/stderr remain alive; IPC still rejects failures; diagnostics saved.');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
