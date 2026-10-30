const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const shared = require('@monky/shared');

const preloadRoot = path.resolve(__dirname, '..', 'src', 'preload');

function transpile(filename) {
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: filename,
  }).outputText;
}

/**
 * Runs the real main-window preload, with the local modules it imports, against
 * fake Electron and Node APIs. Records every package it requires (local modules
 * are part of the preload) and every message it sends to Main.
 */
function loadPreload() {
  const requested = [];
  const rendererCalls = [];
  const marks = [];
  const invoked = [];
  const sent = [];
  let api = null;
  const screenRenderer = {
    createNativeScreenPresentation() {
      rendererCalls.push('presentation');
      return { attach: async () => {}, attachPreview: async () => {}, stop: async () => {}, sample: async () => null, close: async () => {} };
    },
    registerNativeAudioPortReceiver() {
      rendererCalls.push('audio');
      return { getStats: () => ({}), dispose: async () => {} };
    },
  };
  const modules = new Map([
    ['electron', {
      contextBridge: { exposeInMainWorld: (key, value) => { if (key === 'api') api = value; } },
      ipcRenderer: {
        invoke: async (channel, ...args) => { invoked.push([channel, ...args]); return null; },
        send: (channel, ...args) => { sent.push([channel, ...args]); },
        on() {},
        removeListener() {},
      },
      sharedTexture: {},
    }],
    ['node:fs', { readFileSync: () => 'registerProcessor("fixture", class {});' }],
    ['@monky/shared', shared],
    ['@monky/screen-share/renderer', screenRenderer],
  ]);
  const local = new Map();
  const load = (filename) => {
    if (local.has(filename)) return local.get(filename).exports;
    const module = { exports: {} };
    local.set(filename, module);
    function fakeRequire(request) {
      if (request.startsWith('.')) return load(path.resolve(path.dirname(filename), `${request}.ts`));
      requested.push(request);
      if (modules.has(request)) return modules.get(request);
      throw new Error(`The preload required an unexpected module: ${request}`);
    }
    fakeRequire.resolve = request => {
      assert.equal(request, '@monky/screen-share/runtime/nativePcmPlayout.worklet.js');
      return path.join('C:\\', 'fixture', 'nativePcmPlayout.worklet.js');
    };
    vm.runInNewContext(transpile(filename), {
      module, exports: module.exports, require: fakeRequire, console, Blob,
      process: { argv: [], platform: 'win32' },
      window: { localStorage: { getItem: () => null }, addEventListener() {} },
      navigator: { userActivation: { isActive: false } },
      document: {},
      performance: { mark: name => marks.push(name) },
      URL: { createObjectURL: () => 'blob:fixture-worklet', revokeObjectURL() {} },
    }, { filename });
    return module.exports;
  };
  load(path.join(preloadRoot, 'preload.ts'));
  return { api, requested, rendererCalls, marks, invoked, sent };
}

module.exports = { loadPreload };
