const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const client = path.resolve(__dirname, '..');
const sharedSource = path.resolve(client, '..', '..', 'packages', 'shared', 'src');
const compilerOptions = {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
};

function transpile(filename) {
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions, fileName: filename }).outputText;
}

function sourceLoader(overrides = new Map(), globals = {}) {
  const cache = new Map();
  const load = (filename) => {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const dependencies = (id) => {
      if (overrides.has(id)) return overrides.get(id);
      if (id === '@monky/shared') {
        return { ...load(path.join(sharedSource, 'ipc.ts')), ...load(path.join(sharedSource, 'bugReport.ts')) };
      }
      if (id.startsWith('.')) return load(path.resolve(path.dirname(filename), `${id.replace(/\.js$/, '')}.ts`));
      return require(id);
    };
    vm.runInNewContext(transpile(filename), {
      module, exports: module.exports, require: dependencies, __filename: filename, __dirname: path.dirname(filename),
      Buffer, URL, console, process, Error, TypeError, RangeError, setTimeout, clearTimeout, ...globals,
    }, { filename });
    return module.exports;
  };
  return {
    main: (name) => load(path.join(client, 'src', 'main', `${name}.ts`)),
    renderer: (name) => load(path.join(client, 'src', 'renderer', 'utils', `${name}.ts`)),
    shared: (name) => load(path.join(sharedSource, `${name}.ts`)),
  };
}

/** Isolated compilation: never overwrites dist or a peer's build artifacts. */
function compileRecovery(root) {
  const files = [
    ...['crashRecovery', 'crashDiagnostics', 'crashRecoveryPage', 'i18n'].map(name =>
      [path.join(client, 'src', 'main', `${name}.ts`), path.join('main', `${name}.js`)]),
    ...['crashRecoveryPreload', 'preload'].map(name =>
      [path.join(client, 'src', 'preload', `${name}.ts`), path.join('preload', `${name}.js`)]),
    ...['ipc', 'bugReport'].map(name => [path.join(sharedSource, `${name}.ts`), path.join('shared', `${name}.js`)]),
  ];
  for (const [source, relative] of files) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, transpile(source).replaceAll('require("@monky/shared")', 'require("../shared")'));
  }
  fs.writeFileSync(path.join(root, 'shared', 'index.js'), "Object.assign(exports, require('./ipc'), require('./bugReport'));\n");
  return transpile(path.join(client, 'src', 'renderer', 'utils', 'fatalBootstrap.ts'));
}

module.exports = { sourceLoader, compileRecovery, client };
