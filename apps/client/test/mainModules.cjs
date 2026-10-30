'use strict';

// Loads modules of src/main for tests, without Electron: each local import is compiled from TypeScript
// and the packages a test names are replaced by its fakes.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const mainRoot = path.resolve(__dirname, '..', 'src', 'main');
/** Globals a test may replace in every loaded module, e.g. a modeled `process.platform` or timers. */
const GLOBALS = ['console', 'process', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'];
const compiled = new Map();

/** The CommonJS function of one TypeScript file, compiled once per test process. */
function compile(filename) {
  let run = compiled.get(filename);
  if (!run) {
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      fileName: filename,
    }).outputText;
    run = vm.runInThisContext(
      `(function(exports, require, module, __filename, __dirname, ${GLOBALS.join(', ')}) { ${output}\n})`, { filename });
    compiled.set(filename, run);
  }
  return run;
}

function resolveLocal(from, request) {
  const base = path.resolve(path.dirname(from), request);
  const filename = [`${base}.ts`, path.join(base, 'index.ts')].find(candidate => fs.existsSync(candidate));
  if (!filename) throw new Error(`Cannot resolve '${request}' from ${path.relative(mainRoot, from)}`);
  return filename;
}

/**
 * Loads `entry` (a path under src/main, without extension) and the local modules it imports, so a test
 * exercises the real code across files. Packages listed in `packages` ('electron', 'node:fs/promises'...)
 * and local modules listed in `local` (keyed by their path under src/main, without extension) are
 * replaced; everything else comes from Node. `globals` replaces `console`, `process` or the timers in
 * every loaded module. Each call creates fresh module instances.
 */
function loadMain(entry, { packages = {}, local = {}, globals = {} } = {}) {
  for (const name of Object.keys(globals)) {
    if (!GLOBALS.includes(name)) throw new Error(`loadMain cannot replace the global '${name}'.`);
  }
  const scope = GLOBALS.map(name => Object.hasOwn(globals, name) ? globals[name] : globalThis[name]);
  const modules = new Map();
  const load = (filename) => {
    const loaded = modules.get(filename);
    if (loaded) return loaded.exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const requireFrom = (request) => {
      if (request.startsWith('.')) {
        const target = resolveLocal(filename, request);
        const key = path.relative(mainRoot, target).replace(/\\/g, '/').replace(/(?:\/index)?\.ts$/, '');
        return Object.hasOwn(local, key) ? local[key] : load(target);
      }
      return Object.hasOwn(packages, request) ? packages[request] : require(request);
    };
    compile(filename)(module.exports, requireFrom, module, filename, path.dirname(filename), ...scope);
    return module.exports;
  };
  return load(path.join(mainRoot, `${entry}.ts`));
}

/** Electron's ipcMain as far as handlers go, refusing a second handler for a channel as Electron does. */
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, listener) {
      if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
      handlers.set(channel, listener);
    },
    removeHandler(channel) { handlers.delete(channel); },
  };
}

module.exports = { loadMain, fakeIpcMain, mainRoot };
