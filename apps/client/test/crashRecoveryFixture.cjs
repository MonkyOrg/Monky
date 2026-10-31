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

function sourceFor(specifier, from) {
  const base = path.resolve(path.dirname(from), specifier.replace(/\.js$/u, ''));
  const found = [`${base}.ts`, path.join(base, 'index.ts')].find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error(`Cannot resolve ${specifier} from ${from}`);
  return found;
}

/**
 * Isolated compilation: never overwrites dist or a peer's build artifacts. Starts from the recovery
 * entry points and follows every relative and @monky/shared require of the emitted code, so a new
 * import in any of them is compiled too instead of failing at load. The preloads are bundled by the smoke.
 */
function compileRecovery(root) {
  const sharedIndex = path.join(sharedSource, 'index.ts');
  const targetFor = source => path.join(root, source.startsWith(sharedSource)
    ? path.join('shared', path.relative(sharedSource, source)) : path.relative(path.join(client, 'src'), source))
    .replace(/\.ts$/u, '.js');
  const pending = [
    ...['crashRecovery', 'crashDiagnostics', 'crashRecoveryPage', 'i18n', 'windowPreferences']
      .map(name => path.join(client, 'src', 'main', `${name}.ts`)),
    sharedIndex,
  ];
  const compiled = new Set();
  while (pending.length) {
    const source = pending.pop();
    if (compiled.has(source)) continue;
    compiled.add(source);
    const target = targetFor(source);
    const output = transpile(source).replace(/require\("([^"]+)"\)/gu, (call, specifier) => {
      if (specifier === '@monky/shared') {
        pending.push(sharedIndex);
        const relative = path.relative(path.dirname(target), targetFor(sharedIndex)).replaceAll('\\', '/');
        return `require(${JSON.stringify(relative.startsWith('.') ? relative : `./${relative}`)})`;
      }
      if (specifier.startsWith('.')) pending.push(sourceFor(specifier, source));
      return call;
    });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, output);
  }
  return transpile(path.join(client, 'src', 'renderer', 'utils', 'fatalBootstrap.ts'));
}

module.exports = { sourceLoader, compileRecovery, client };
