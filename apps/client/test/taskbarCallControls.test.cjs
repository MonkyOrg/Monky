'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const shared = require('@monky/shared');

const mainDir = path.resolve(__dirname, '..', 'src', 'main');
const DANGER = [0xf2, 0x3f, 0x43];
const ON_DARK = [0xff, 0xff, 0xff];
const ON_LIGHT = [0x1a, 0x1a, 0x1a];
const IN_CALL = {
  inCall: true, isMuted: false, isDeafened: false, isSpeaking: false,
  selfMuted: false, selfDeafened: false, micLock: null,
};
const REGISTRY = (value) =>
  `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\r\n    SystemUsesLightTheme    REG_DWORD    ${value}\r\n\r\n`;

/** Loads main-process sources with Electron and the registry under the test's control. */
function loadMain(name, overrides, cache) {
  const filename = path.join(mainDir, `${name}.ts`);
  if (cache.has(filename)) return cache.get(filename);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  // Same realm as the test, so deepEqual compares plain objects and arrays.
  const wrapper = vm.runInThisContext(`(function (module, exports, require) {${code}\n})`, { filename });
  wrapper(module, module.exports, (id) => {
    if (Object.hasOwn(overrides, id)) return overrides[id];
    if (id.startsWith('./')) return loadMain(id.slice(2), overrides, cache);
    if (id === '@monky/shared') return shared;
    assert.ok(['fs', 'path'].includes(id), `Unexpected dependency ${id}`);
    return require(id);
  });
  cache.set(filename, module.exports);
  return module.exports;
}

function fixture({ dark = true, scaleFactor = 1 } = {}) {
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColorsForSystemIntegratedUI: dark });
  const display = { scaleFactor };
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ ...display }) });
  const nativeImage = {
    createFromDataURL: (url) => ({
      resize: ({ width, height, quality }) => {
        assert.match(url, /^data:image\/png;base64,iVBOR/);
        assert.equal(quality, 'best');
        // A fully covered white mask, premultiplied like Skia's bitmaps.
        return { toBitmap: () => Buffer.alloc(width * height * 4, 255) };
      },
    }),
    createFromBitmap: (buffer, { width, height }) => {
      assert.equal(buffer.length, width * height * 4);
      return { buffer, width, height };
    },
  };
  const registry = { queries: [], reply: null };
  const execFile = (file, args, options, callback) => {
    registry.queries.push({ file, args, options });
    registry.reply = (stdout, error = null) => callback(error, stdout, '');
  };
  class Window extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.applied = [];
      this.sent = [];
      this.webContents = { send: (channel) => this.sent.push(channel) };
    }
    isDestroyed() { return this.destroyed; }
    setThumbarButtons(buttons) { this.applied.push(buttons); return true; }
  }
  const window = new Window();
  const cache = new Map();
  const overrides = { electron: { nativeImage, nativeTheme, screen }, child_process: { execFile } };
  const module = loadMain('taskbarCallControls', overrides, cache);
  const i18n = loadMain('i18n', overrides, cache);
  const controls = new module.TaskbarCallControls(window);
  const last = () => window.applied.at(-1);
  return { module, i18n, controls, window, nativeTheme, screen, display, registry, last };
}

/** Every pixel of the fake mask is opaque, so any one shows the tint. */
const colorOf = (button) => {
  const [blue, green, red, alpha] = button.icon.buffer;
  assert.equal(alpha, 255);
  return [red, green, blue];
};
/** Lets the registry answer travel through its promise. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('shows nothing outside a call and mute, deafen and hang up during one', () => {
  const { controls, window, last } = fixture();
  controls.update({ ...IN_CALL, inCall: false });
  assert.equal(window.applied.length, 0, 'A window starts without buttons, so there is nothing to clear');

  controls.update(IN_CALL);
  assert.equal(window.applied.length, 1);
  assert.deepEqual(last().map((button) => button.tooltip), ['Mutar Microfone', 'Mutar Áudio (Ensurdecer)', 'Sair da Chamada']);
  // Electron rejects the whole toolbar over unknown flags, 'enabled' included.
  assert.deepEqual(last().map((button) => button.flags), [[], [], []]);
  assert.deepEqual(last().map(colorOf), [ON_DARK, ON_DARK, DANGER]);
  assert.deepEqual(last().map((button) => button.icon.width), [16, 16, 16]);

  controls.update({ ...IN_CALL, inCall: false });
  assert.deepEqual(last(), [], 'Leaving the call removes the buttons');
});

test('mirrors the footer controls, including a microphone the person cannot open', () => {
  const { module, controls, last } = fixture();
  const glyphs = (status) => module.describeCallButtons(status).map((button) => button.glyph);
  assert.deepEqual(glyphs(IN_CALL), ['mic', 'headphones', 'call_end']);
  assert.deepEqual(glyphs({ ...IN_CALL, selfMuted: true }), ['mic_off', 'headphones', 'call_end']);
  // Deafening silences the microphone too, as in the footer.
  assert.deepEqual(glyphs({ ...IN_CALL, selfMuted: true, selfDeafened: true }), ['mic_off', 'headset_off', 'call_end']);
  assert.deepEqual(glyphs({ ...IN_CALL, selfDeafened: true }), ['mic_off', 'headset_off', 'call_end']);
  assert.deepEqual(module.describeCallButtons({ ...IN_CALL, inCall: false }), []);

  controls.update({ ...IN_CALL, selfMuted: true, isMuted: true });
  assert.deepEqual(last().map((button) => button.tooltip).slice(0, 2), ['Desmutar Microfone', 'Mutar Áudio (Ensurdecer)']);
  assert.deepEqual(last().map(colorOf), [DANGER, ON_DARK, DANGER]);

  controls.update({ ...IN_CALL, selfMuted: true, selfDeafened: true, isMuted: true, isDeafened: true });
  assert.deepEqual(last().map((button) => button.tooltip).slice(0, 2), ['Desmutar Microfone', 'Desmutar Áudio (Ouvir)']);
  assert.deepEqual(last().map(colorOf), [DANGER, DANGER, DANGER]);

  controls.update({ ...IN_CALL, micLock: 'permission', isMuted: true });
  assert.equal(last()[0].tooltip, 'Sem permissão para falar neste canal');
  assert.deepEqual(last().map((button) => button.flags), [['disabled'], [], []]);

  // The AFK channel locks the microphone the same way, with its own reason.
  controls.update({ ...IN_CALL, micLock: 'afk', isMuted: true });
  assert.equal(last()[0].tooltip, 'Mutado no canal AFK');
  assert.deepEqual(last().map((button) => button.flags), [['disabled'], [], []]);
});

test('clicks forward the tray commands to the renderer that owns the call', () => {
  const { controls, window, last } = fixture();
  controls.update(IN_CALL);
  for (const button of last()) button.click();
  assert.deepEqual(window.sent, ['tray:toggle-mute', 'tray:toggle-deafen', 'tray:leave-call']);

  window.destroyed = true;
  last()[2].click();
  assert.equal(window.sent.length, 3, 'A destroyed window is never addressed');
});

test('redraws only when a button changes, not as people speak or moderation changes', () => {
  const { controls, window } = fixture();
  controls.update(IN_CALL);
  controls.update({ ...IN_CALL, isSpeaking: true });
  controls.update({ ...IN_CALL, isSpeaking: false });
  // A moderator mute changes the tray icon; the button keeps the person's own toggle, like the footer.
  controls.update({ ...IN_CALL, isMuted: true });
  assert.equal(window.applied.length, 1);
  controls.update({ ...IN_CALL, selfMuted: true, isMuted: true });
  assert.equal(window.applied.length, 2);
});

test('draws icons at the small-icon size of the primary display', () => {
  const { controls, screen, display, window, last } = fixture({ scaleFactor: 1.25 });
  controls.update(IN_CALL);
  assert.deepEqual(last().map((button) => button.icon.width), [20, 20, 20]);

  screen.emit('display-metrics-changed', {}, {}, ['scaleFactor']);
  assert.equal(window.applied.length, 1, 'Unrelated display changes keep the buttons');
  display.scaleFactor = 1.5;
  screen.emit('display-metrics-changed', {}, {}, ['scaleFactor']);
  assert.deepEqual(last().map((button) => button.icon.width), [24, 24, 24]);
});

test('follows the taskbar theme, read from the registry until Windows reports a change', async () => {
  const { controls, nativeTheme, registry, last } = fixture({ dark: true });
  assert.equal(registry.queries.length, 1);
  assert.equal(registry.queries[0].file, 'reg');
  assert.deepEqual(registry.queries[0].args,
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'SystemUsesLightTheme']);
  assert.equal(registry.queries[0].options.windowsHide, true);
  controls.update(IN_CALL);
  assert.deepEqual(colorOf(last()[0]), ON_DARK);

  // Electron answered with the apps' theme; the taskbar itself is light.
  registry.reply(REGISTRY('0x1'));
  await settle();
  assert.deepEqual(last().map(colorOf), [ON_LIGHT, ON_LIGHT, DANGER]);

  nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = true;
  nativeTheme.emit('updated');
  assert.deepEqual(colorOf(last()[0]), ON_DARK);
});

test('a theme change reported during the registry read wins over the read', async () => {
  const { controls, nativeTheme, registry, window, last } = fixture({ dark: true });
  controls.update(IN_CALL);
  nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = false;
  nativeTheme.emit('updated');
  assert.deepEqual(colorOf(last()[0]), ON_LIGHT);
  registry.reply(REGISTRY('0x0'));
  await settle();
  assert.equal(window.applied.length, 2, 'The older registry answer is dropped');
  assert.deepEqual(colorOf(last()[0]), ON_LIGHT);

  const failed = fixture({ dark: true });
  failed.controls.update(IN_CALL);
  failed.registry.reply('', new Error('reg.exe is blocked'));
  await settle();
  assert.equal(failed.window.applied.length, 1, 'An unreadable registry keeps the current colours');
});

test('switching the language rewrites the tooltips', () => {
  const { controls, i18n, last } = fixture();
  controls.update(IN_CALL);
  i18n.setMainLanguage('en');
  controls.refresh();
  assert.deepEqual(last().map((button) => button.tooltip), ['Mute Microphone', 'Mute Audio (Deafen)', 'Leave Call']);
  controls.update({ ...IN_CALL, micLock: 'permission' });
  assert.equal(last()[0].tooltip, 'You don\'t have permission to speak in this channel');
  controls.update({ ...IN_CALL, micLock: 'afk' });
  assert.equal(last()[0].tooltip, 'Muted in the AFK channel');
});

test('dispose clears the buttons and stops listening', () => {
  const { controls, nativeTheme, screen, window, last } = fixture();
  controls.update(IN_CALL);
  controls.dispose();
  assert.deepEqual(last(), []);
  assert.equal(nativeTheme.listenerCount('updated'), 0);
  assert.equal(screen.listenerCount('display-metrics-changed'), 0);
  const count = window.applied.length;
  controls.update(IN_CALL);
  controls.dispose();
  assert.equal(window.applied.length, count);

  const closed = fixture();
  closed.controls.update(IN_CALL);
  closed.window.destroyed = true;
  closed.window.emit('closed');
  assert.equal(closed.window.applied.length, 1, 'A destroyed window is never addressed');
  assert.equal(closed.nativeTheme.listenerCount('updated'), 0);
  assert.equal(closed.screen.listenerCount('display-metrics-changed'), 0);
});

test('tints a white mask into premultiplied BGRA', () => {
  const { module } = fixture();
  const mask = Buffer.from([255, 255, 255, 255, 128, 128, 128, 128, 0, 0, 0, 0]);
  assert.deepEqual([...module.tintMask(mask, DANGER)], [
    0x43, 0x3f, 0xf2, 255,
    Math.round(0x43 * 128 / 255), Math.round(0x3f * 128 / 255), Math.round(0xf2 * 128 / 255), 128,
    0, 0, 0, 0,
  ]);
});

test('the main process only accepts a complete voice status', () => {
  assert.deepEqual(shared.trayVoiceStatusSchema.parse(IN_CALL), IN_CALL);
  assert.equal(shared.trayVoiceStatusSchema.parse({ ...IN_CALL, micLock: 'afk' }).micLock, 'afk');
  const { micLock: _micLock, ...missing } = IN_CALL;
  assert.throws(() => shared.trayVoiceStatusSchema.parse(missing));
  assert.throws(() => shared.trayVoiceStatusSchema.parse({ ...IN_CALL, micLock: 'server' }));
  assert.throws(() => shared.trayVoiceStatusSchema.parse({ ...IN_CALL, inCall: 'yes' }));
  assert.throws(() => shared.trayVoiceStatusSchema.parse({ ...IN_CALL, extra: true }));
});
