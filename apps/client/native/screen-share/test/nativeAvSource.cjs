'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const profile = process.argv.find(value => value.startsWith('--profile='))?.slice('--profile='.length);
assert.ok(profile && path.isAbsolute(profile) && typeof process.send === 'function');
app.setPath('userData', profile); app.setPath('sessionData', profile);
app.setName('MonkyOwnedAvSource');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
let window;
app.on('window-all-closed', () => {});
process.on('disconnect', () => app.exit(0));

app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 800, height: 600, useContentSize: true, frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadFile(path.join(__dirname, 'nativeCaptureSmoke.html'), { hash: 'source' });
  window.setTitle(`Monky owned AV source ${process.pid}`);
  await window.webContents.executeJavaScript(`globalThis.ownedAvTone = {
    context: null, nodes: [],
    async start() {
      if (this.context) throw new Error('The owned test tone is already active.');
      const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      this.context = context;
      const merger = context.createChannelMerger(2);
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 440;
      this.nodes.push(merger, oscillator);
      for (const channel of [0, 1]) {
        const gain = context.createGain();
        gain.gain.value = channel === 0 ? 0.01 : -0.01;
        oscillator.connect(gain); gain.connect(merger, 0, channel);
        this.nodes.push(gain);
      }
      oscillator.start();
      merger.connect(context.destination);
      await context.resume();
    },
    async stop() {
      for (const node of this.nodes) {
        if (node instanceof OscillatorNode) node.stop();
        node.disconnect();
      }
      this.nodes.length = 0;
      await this.context?.close(); this.context = null;
    }
  }; true`);
  process.send({ type: 'ready', pid: process.pid, hwnd: Number(window.getNativeWindowHandle().readBigUInt64LE()) });
}).catch(error => { console.error(error); app.exit(1); });

process.on('message', message => {
  const run = async () => {
    assert.equal(typeof message.id, 'string');
    assert.ok(['tone-start', 'tone-stop', 'close-source'].includes(message.command));
    assert.ok(window && !window.isDestroyed());
    if (message.command === 'tone-start') await window.webContents.executeJavaScript('ownedAvTone.start()');
    else {
      await window.webContents.executeJavaScript('ownedAvTone.stop()');
      if (message.command === 'close-source') window.destroy();
    }
    process.send({ type: 'result', id: message.id, ok: true });
  };
  void run().catch(error => process.send({ type: 'result', id: message.id, ok: false, error: error.stack ?? String(error) }));
});
