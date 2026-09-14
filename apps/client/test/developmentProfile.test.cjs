const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../src/main/developmentProfile.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(compiled, sourcePath);
const { resolveDevelopmentProfile } = loaded.exports;

const options = {
  isPackaged: false,
  appPath: path.resolve('checkout-one', 'apps', 'client'),
  appDataPath: path.resolve('isolated-app-data'),
};

test('packaged Monky keeps its installed profile and single-instance identity', () => {
  assert.equal(resolveDevelopmentProfile({ ...options, isPackaged: true }), null);
  assert.equal(resolveDevelopmentProfile({
    ...options, isPackaged: true, explicitUserData: path.resolve('custom-installed-profile'),
  }), null);
});

test('development profiles are stable per checkout and never use installed Monky data', () => {
  const first = resolveDevelopmentProfile(options);
  assert.deepEqual(first, resolveDevelopmentProfile(options));
  assert.equal(path.dirname(first.userData), path.join(options.appDataPath, 'Monky-development'));
  assert.equal(first.sessionData, first.userData);
  assert.equal(first.cliHome, path.join(first.userData, 'cli'));
  assert.notEqual(first.appUserModelId, 'com.monky.app');
  const second = resolveDevelopmentProfile({
    ...options, appPath: path.resolve('checkout-two', 'apps', 'client'),
  });
  assert.notEqual(first.userData, second.userData);
  assert.notEqual(first.appUserModelId, second.appUserModelId);
});

test('explicit QA profiles stay independent and keep their Chromium and CLI data together', () => {
  const first = resolveDevelopmentProfile({ ...options, explicitUserData: path.resolve('qa', 'first') });
  const second = resolveDevelopmentProfile({ ...options, explicitUserData: path.resolve('qa', 'second') });
  assert.equal(first.userData, path.resolve('qa', 'first'));
  assert.notEqual(first.userData, second.userData);
  assert.notEqual(first.sessionData, second.sessionData);
  assert.notEqual(first.cliHome, second.cliHome);
});

test('profile selection precedes service construction and the real single-instance lock', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../src/main/main.ts'), 'utf8');
  const selection = main.indexOf("app.setPath('userData', developmentProfile.userData)");
  assert.ok(selection >= 0);
  assert.ok(selection < main.indexOf('new ServerManager()'));
  assert.ok(selection < main.indexOf('app.requestSingleInstanceLock()'));
  assert.match(main, /app\.setPath\('sessionData', developmentProfile\.sessionData\)/);
  assert.match(main, /process\.env\.MONKY_HOME = developmentProfile\.cliHome/);
});
