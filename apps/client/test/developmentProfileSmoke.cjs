const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

if (process.versions.electron) {
  const { app, BrowserWindow } = require('electron');
  const Module = require('node:module');
  const ts = require('typescript');
  const filename = path.resolve(__dirname, '../src/main/developmentProfile.ts');
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiled, filename);
  const root = process.env.MONKY_PROFILE_SMOKE_ROOT;
  const installed = process.env.MONKY_PROFILE_SMOKE_ROLE === 'installed';
  app.disableHardwareAcceleration();
  app.setName('Monky Profile Isolation Fixture');
  app.setPath('appData', root);
  app.setPath('userData', path.join(root, 'installed-profile'));
  const profile = loaded.exports.resolveDevelopmentProfile({
    isPackaged: installed,
    appPath: path.resolve(__dirname, '..'),
    appDataPath: root,
    explicitUserData: app.commandLine.getSwitchValue('user-data-dir'),
  });
  if (profile) {
    fs.mkdirSync(profile.userData, { recursive: true });
    fs.mkdirSync(profile.sessionData, { recursive: true });
    app.setPath('userData', profile.userData);
    app.setPath('sessionData', profile.sessionData);
    process.env.MONKY_HOME = profile.cliHome;
  }
  if (!app.requestSingleInstanceLock()) {
    process.send({ type: 'rejected' });
    app.quit();
  } else {
    process.on('message', (message) => {
      if (message?.type === 'stop') app.quit();
      if (message?.type === 'ping') process.send({ type: 'pong' });
    });
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
      await window.loadURL('about:blank');
      process.send({ type: 'ready', userData: app.getPath('userData'), pid: process.pid });
    }).catch((error) => {
      console.error(error);
      app.exit(1);
    });
  }
} else {
  const test = require('node:test');
  test('installed and development profiles coexist while duplicate profiles still focus their owner', {
    timeout: 120_000,
  }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-profile-lock-'));
    fs.mkdirSync(path.join(root, 'installed-profile'));
    const children = [];
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, 'exit');
        const deadline = setTimeout(() => child.kill(), 5000);
        if (child.connected) child.send({ type: 'stop' });
        else child.kill();
        await exited;
        clearTimeout(deadline);
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    function waitMessage(child, expected) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Electron did not report ${expected.join('/')}.\n${child.diagnostics}`)), 30_000);
        const message = (value) => {
          if (expected.includes(value?.type)) finish(null, value);
        };
        const exit = (code, signal) => finish(new Error(`Electron exited (${code}/${signal}).\n${child.diagnostics}`));
        const finish = (error, value) => {
          clearTimeout(timer);
          child.off('message', message);
          child.off('exit', exit);
          error ? reject(error) : resolve(value);
        };
        child.on('message', message);
        child.once('exit', exit);
      });
    }
    async function launch(role, explicitProfile) {
      const env = { ...process.env, MONKY_PROFILE_SMOKE_ROOT: root, MONKY_PROFILE_SMOKE_ROLE: role };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require('electron'), [
        __filename, ...(explicitProfile ? [`--user-data-dir=${explicitProfile}`] : []),
      ], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      child.diagnostics = '';
      const log = (chunk) => { child.diagnostics = (child.diagnostics + chunk.toString()).slice(-8000); };
      child.stdout.on('data', log);
      child.stderr.on('data', log);
      children.push(child);
      const state = await waitMessage(child, ['ready', 'rejected']);
      return { child, state };
    }
    const installed = await launch('installed');
    const development = await launch('development');
    const secondParticipant = await launch('development', path.join(root, 'participant-b'));
    assert.equal(installed.state.type, 'ready');
    assert.equal(development.state.type, 'ready');
    assert.equal(secondParticipant.state.type, 'ready');
    assert.equal(new Set([installed.state.userData, development.state.userData, secondParticipant.state.userData]).size, 3);
    assert.equal((await launch('development')).state.type, 'rejected', 'same checkout/profile retains its lock');
    for (const { child } of [installed, development, secondParticipant]) {
      const responsive = waitMessage(child, ['pong']);
      child.send({ type: 'ping' });
      await responsive;
    }
  });
}
