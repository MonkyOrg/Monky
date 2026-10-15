'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const clientRoot = path.resolve(__dirname, '..');
const filename = path.join(clientRoot, 'src', 'main', 'trayManager.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
const trayDir = path.join(clientRoot, 'build', 'tray');
const poses = ['idle', 'call', 'talk', 'mute', 'deaf'];
const tooltips = {
  idle: 'tray.tooltipIdle', call: 'tray.tooltipInCall', talk: 'tray.tooltipSpeaking',
  mute: 'tray.tooltipMuted', deaf: 'tray.tooltipDeafened',
};

function load(platform) {
  const loaded = [], trays = [], sent = [];
  class Tray {
    constructor(image) { this.images = [image]; this.tooltips = []; this.destroyed = false; trays.push(this); }
    on() {}
    setImage(image) { this.images.push(image); }
    setToolTip(text) { this.tooltips.push(text); }
    setContextMenu(menu) { this.menu = menu; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const electron = {
    Tray,
    Menu: { buildFromTemplate: template => ({ template }) },
    nativeImage: {
      createFromPath(file) { loaded.push(file); return { file, isEmpty: () => !fs.existsSync(file) }; },
    },
  };
  const module = { exports: {} };
  // The compiled file runs from dist-electron/main (package.json "main"), two levels below the client root.
  vm.runInThisContext(`(function(require, module, exports, __dirname, process) {\n${compiled}\n})`, { filename })(
    name => name === 'electron' ? electron : name === './i18n' ? { mt: key => key } : require(name),
    module, module.exports, path.join(clientRoot, 'dist-electron', 'main'), { ...process, platform },
  );
  const window = { isDestroyed: () => false, webContents: { send: channel => sent.push(channel) } };
  return { ...module.exports, window, loaded, trays, sent };
}

const states = [
  [{ inCall: false, isMuted: false, isDeafened: false, isSpeaking: false }, 'idle'],
  [{ inCall: false, isMuted: true, isDeafened: true, isSpeaking: true }, 'idle'],
  [{ inCall: true, isMuted: false, isDeafened: false, isSpeaking: false }, 'call'],
  [{ inCall: true, isMuted: false, isDeafened: false, isSpeaking: true }, 'talk'],
  [{ inCall: true, isMuted: true, isDeafened: false, isSpeaking: true }, 'mute'],
  [{ inCall: true, isMuted: true, isDeafened: true, isSpeaking: true }, 'deaf'],
  [{ inCall: true, isMuted: false, isDeafened: true, isSpeaking: false }, 'deaf'],
];

test('each voice state maps to one monkey pose, with deafened and muted winning over speaking', () => {
  const { trayPoseFor } = load(process.platform);
  for (const [status, pose] of states) assert.equal(trayPoseFor(status), pose, JSON.stringify(status));
});

for (const [platform, extension] of [['win32', '.ico'], ['darwin', '.png'], ['linux', '.png']]) {
  test(`${platform} tray loads every pose once from build/tray as ${extension} and swaps it per state`, () => {
    const tray = load(platform);
    const manager = new tray.TrayManager(tray.window, () => {});
    assert.deepEqual(tray.loaded, poses.map(pose => path.join(trayDir, `${pose}${extension}`)));
    for (const file of tray.loaded) assert.ok(fs.existsSync(file), `Missing tray icon ${file}`);
    const [icon] = tray.trays;
    assert.equal(icon.images[0].file, path.join(trayDir, `idle${extension}`), 'Out of a call the tray starts idle');
    for (const [status, pose] of states) {
      manager.updateVoiceStatus(status);
      assert.equal(icon.images.at(-1).file, path.join(trayDir, `${pose}${extension}`), JSON.stringify(status));
      assert.equal(icon.tooltips.at(-1), tooltips[pose]);
    }
    assert.equal(tray.loaded.length, poses.length, 'State changes reuse the preloaded images');
    manager.destroy();
  });
}

test('the in-call menu still toggles mute and deafen and reflects the current state', () => {
  const tray = load('darwin');
  const manager = new tray.TrayManager(tray.window, () => {});
  const labels = () => tray.trays[0].menu.template.filter(item => item.label).map(item => item.label);
  assert.deepEqual(labels(), ['tray.open', 'tray.quit']);
  manager.updateVoiceStatus({ inCall: true, isMuted: true, isDeafened: true, isSpeaking: false });
  assert.deepEqual(labels(), ['tray.open', 'tray.unmuteMic', 'tray.undeafen', 'tray.quit']);
  for (const item of tray.trays[0].menu.template.filter(entry => entry.label?.startsWith('tray.un'))) item.click();
  assert.deepEqual(tray.sent, ['tray:toggle-mute', 'tray:toggle-deafen']);
});

function pngInfo(buffer, name) {
  assert.ok(buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${name} is not a PNG`);
  assert.equal(buffer.toString('latin1', 12, 16), 'IHDR', `${name} has no IHDR`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colorType: buffer[25] };
}

test('tray assets have the menu-bar sizes, the Windows small-icon frames and a transparent background', () => {
  for (const pose of poses) {
    for (const [file, size] of [[`${pose}.png`, 18], [`${pose}@2x.png`, 36]]) {
      assert.deepEqual(pngInfo(fs.readFileSync(path.join(trayDir, file)), file), { width: size, height: size, colorType: 6 });
    }
    const ico = fs.readFileSync(path.join(trayDir, `${pose}.ico`));
    assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2)], [0, 1], `${pose}.ico is not an icon file`);
    const sizes = [];
    for (let index = 0; index < ico.readUInt16LE(4); index += 1) {
      const entry = 6 + 16 * index;
      const size = ico[entry] || 256;
      const frame = ico.subarray(ico.readUInt32LE(entry + 12), ico.readUInt32LE(entry + 12) + ico.readUInt32LE(entry + 8));
      assert.deepEqual(pngInfo(frame, `${pose}.ico@${size}`), { width: size, height: ico[entry + 1] || 256, colorType: 6 });
      sizes.push(size);
    }
    // SM_CXSMICON at 100%, 125%, 150%, 175%, 200%, 225%, 250%, 300% and 400% display scale.
    assert.deepEqual(sizes, [16, 20, 24, 28, 32, 36, 40, 48, 64], `${pose}.ico frames`);
  }
});

test('packaging ships build/tray although build is the electron-builder resources directory', () => {
  const { build } = JSON.parse(fs.readFileSync(path.join(clientRoot, 'package.json'), 'utf8'));
  assert.equal(build.directories.buildResources, 'build');
  assert.ok(build.files.includes('build/**/*'), 'build/**/* must stay in the packaged files');
  assert.ok(!build.files.some(pattern => pattern.startsWith('!build')), 'No pattern may exclude build/tray');
});
