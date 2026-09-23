const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const childProcess = require('node:child_process');
const { createHash, generateKeyPairSync, randomUUID, sign } = require('node:crypto');
const { app, BrowserWindow, ipcMain, session: electronSession } = require('electron');
const { AUDIO_PREVIEW_IPC, LOCAL_EXECUTION_IPC, SHORTCUT_IPC } = require('@monky/shared');
const clientRoot = path.resolve(__dirname, '..', '..');
const mainRoot = path.join(clientRoot, 'dist-electron', 'main', 'localExecution');
const { LocalTools } = require(path.join(mainRoot, 'LocalTools.js'));
const { LocalPermissions } = require(path.join(mainRoot, 'LocalPermissions.js'));
const { LocalExecutionService } = require(path.join(mainRoot, 'service.js'));
const { setupLocalExecutionIpc } = require(path.join(mainRoot, 'ipc.js'));
const { createLocalRuntimeTask } = require(path.join(mainRoot, 'workerClient.js'));
const { AudioPreviews } = require(path.join(mainRoot, '..', 'audioPreviews.js'));
const audioPreviews = new AudioPreviews();

assert.ok(process.send, 'This isolated Electron helper requires its test-owned IPC parent.');
const config = JSON.parse(process.env.MONKY_LOCAL_E2E_CONFIG);
for (const value of [config.profile, config.node, config.ffmpeg]) assert.ok(path.isAbsolute(value));
assert.ok(['executor', 'listener'].includes(config.role));
assert.equal(typeof config.allowLocalExecution, 'boolean');
const emit = row => process.send({ type: 'event', row: { at: Date.now(), role: config.role, ...row } });
const privateTags = (...values) => values.filter(value => typeof value === 'string')
  .map(value => createHash('sha256').update(value).digest('hex'));
const logs = [];
const workers = new Set();
const nativeIds = new Set();
const caches = new Set();
let spawnedWorkers = 0;
let disposed = false;
let window;
let localIpc;
let manager;
let shuttingDown = false;
let rendererInitialized = false;
const paths = {
  node: config.node, ffmpeg: config.ffmpeg, ytDlp: path.join(config.profile, 'unused-extractor.exe'),
};
const workerEntry = path.join(mainRoot, 'worker.js');
const nativeSpawn = childProcess.spawn;

app.setPath('userData', config.profile);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('mute-audio');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
app.on('window-all-closed', () => {});

childProcess.spawn = (command, args, options) => {
  if (command !== paths.node) return nativeSpawn(command, args, options);
  assert.deepEqual(args, [workerEntry], 'No replacement worker or alternate entrypoint is permitted.');
  assert.ok(caches.has(options.cwd), 'Native startup requires an actual allocated LocalTools lease.');
  assert.notEqual(command, process.execPath, 'The worker must run explicit Node, not Electron.');
  const child = nativeSpawn(command, ['--require', path.join(__dirname, 'authoredWorker.cjs'), ...args], options);
  workers.add(child);
  spawnedWorkers++;
  child.once('close', () => {
    workers.delete(child);
    emit({ event: 'worker.closed', pid: child.pid });
  });
  emit({ event: 'worker.spawn', pid: child.pid });
  return child;
};

const legacy = Object.freeze({
  identity: 'identity:get', clientId: 'identity:get-client-id', sign: 'identity:sign-challenge',
  language: 'app:set-language', inServer: 'window:set-in-server', fitHome: 'window:fit-home-content',
  hostStatus: 'server-host:status', clientLog: 'client-log:write',
});
const keys = generateKeyPairSync('ed25519');
const identity = {
  clientId: randomUUID(), publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('hex'),
};
const owns = event => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
const register = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
  assert.ok(owns(event), 'Only the real owner frame can call this helper.');
  return handler(...args);
});
const run = (action, args = []) => {
  assert.ok(['identity', 'createBot', 'approveBot', 'join', 'invoke', 'sample', 'chat', 'mute', 'enablePermission',
    'leave', 'privateReady', 'privateClosed', 'failures', 'cleanup'].includes(action));
  assert.ok(window && !window.isDestroyed() && !window.webContents.isCrashed());
  return window.webContents.executeJavaScript(
    `window.localE2e[${JSON.stringify(action)}](...${JSON.stringify(args)})`, true,
  );
};
const logError = (message, error) => {
  const row = { message, reason: error?.reason, error: error instanceof Error ? error.message : String(error) };
  logs.push(row);
  emit({ event: 'main.error', ...row });
};
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
const shutdown = async () => {
  if (disposed) return;
  const errors = [];
  if (rendererInitialized && window && !window.isDestroyed() && !window.webContents.isCrashed()) {
    try { await run('cleanup'); } catch (error) { errors.push(error); }
  }
  try {
    if (localIpc) await localIpc.dispose();
    else if (manager) await manager.dispose();
  } catch (error) { errors.push(error); }
  if (workers.size) errors.push(new Error(`${workers.size} private workers are still live.`));
  for (const pid of nativeIds) if (alive(pid)) errors.push(new Error(`Native fixture process ${pid} is still live.`));
  if (caches.size) errors.push(new Error(`${caches.size} native cache leases remain owned.`));
  childProcess.spawn = nativeSpawn;
  if (window && !window.isDestroyed()) audioPreviews.cancelOwner(window.webContents.id);
  if (window && !window.isDestroyed()) window.destroy();
  if (errors.length) throw new AggregateError(errors, 'Isolated actor cleanup was not confirmed.');
  disposed = true;
  emit({ event: 'cleanup.confirmed' });
};

const ready = app.whenReady().then(async () => {
  electronSession.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol);
    callback({ cancel: network && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) });
  });
  window = new BrowserWindow({
    show: false, width: 1200, height: 850,
    webPreferences: {
      offscreen: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      sandbox: false, webSecurity: true, backgroundThrottling: false,
      preload: path.join(clientRoot, 'dist-electron', 'preload', 'preload.js'),
    },
  });
  window.webContents.on('console-message', (_event, level, message) => {
    if (message.startsWith('LOCAL_E2E ')) emit(JSON.parse(message.slice('LOCAL_E2E '.length)));
    else if (level >= 2) emit({ event: 'renderer.log', level, message });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    emit({ event: 'renderer.gone', reason: details.reason });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  register(legacy.identity, () => identity);
  register(legacy.clientId, () => identity.clientId);
  register(legacy.sign, nonce => {
    assert.match(nonce, /^[0-9a-f]{64}$/i);
    return sign(null, Buffer.from(nonce, 'hex'), keys.privateKey).toString('hex');
  });
  register(legacy.language, () => undefined);
  register(legacy.inServer, () => undefined);
  register(legacy.fitHome, () => undefined);
  register(legacy.hostStatus, () => ({ isRunning: false, port: null, serverId: null }));
  register(legacy.clientLog, entry => {
    if (entry.level === 'ERROR') emit({ event: 'renderer.clientError', message: entry.message });
  });
  // Fake microphone devices are local to this Chromium process. No global PTT hook is installed.
  register(SHORTCUT_IPC.setPttConfig, () => true);
  register(AUDIO_PREVIEW_IPC.load, input => audioPreviews.load(window.webContents.id, input));
  register(AUDIO_PREVIEW_IPC.cancel, input => audioPreviews.cancel(window.webContents.id, input));

  manager = new LocalTools({
    root: path.join(config.profile, 'local-tools'),
    probe: async () => { throw new Error('The authored E2E must never install or download provider tools.'); },
  });
  const allocate = manager.allocateTaskCache.bind(manager);
  manager.allocateTaskCache = async () => {
    const directory = await allocate();
    caches.add(directory);
    emit({ event: 'cache.allocated' });
    return directory;
  };
  const remove = manager.removeTaskCache.bind(manager);
  manager.removeTaskCache = async directory => {
    try {
      const ids = JSON.parse(await fs.readFile(path.join(directory, 'native-ids.json'), 'utf8'));
      assert.ok(Array.isArray(ids) && ids.every(id => Number.isSafeInteger(id) && id > 0));
      for (const id of ids) nativeIds.add(id);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await remove(directory);
    caches.delete(directory);
    emit({ event: 'cache.released' });
  };
  const toolHost = {
    initialize: () => manager.initialize(),
    snapshot: () => manager.snapshot(),
    prepare: async signal => {
      signal.throwIfAborted();
      assert.equal(config.allowLocalExecution, true, 'This actor must not execute a local capability.');
      for (const filename of [paths.node, paths.ffmpeg]) assert.ok((await fs.stat(filename)).isFile());
      emit({ event: 'tools.fixturePrepared' });
      return paths;
    },
    remove: tool => manager.remove(tool),
    clearCache: () => manager.clearCache(),
    dispose: () => manager.dispose(),
  };
  const handle = ipcMain.handle.bind(ipcMain);
  const observed = new Map([
    [LOCAL_EXECUTION_IPC.prepare, 'prepare'], [LOCAL_EXECUTION_IPC.startTask, 'start'],
    [LOCAL_EXECUTION_IPC.readFrames, 'read'], [LOCAL_EXECUTION_IPC.acknowledgeFrames, 'played'],
    [LOCAL_EXECUTION_IPC.setPaused, 'pause'],
  ]);
  ipcMain.handle = (channel, handler) => handle(channel, async (event, input) => {
    const operation = observed.get(channel);
    if (operation) emit({
      event: `ipc.${operation}.begin`, playedFrames: input?.playedFrames,
      privateTags: privateTags(input?.subject?.connectionId, input?.permit),
    });
    const result = await handler(event, input);
    if (operation) emit({
      event: `ipc.${operation}.end`, status: result?.status, reason: result?.reason,
      done: result?.done, frames: result?.frames?.length, playedFrames: input?.playedFrames,
      privateTags: privateTags(result?.permit, result?.taskId),
    });
    return result;
  });
  try {
    localIpc = setupLocalExecutionIpc(window, notifications => new LocalExecutionService({
      owner: window.webContents.id, tools: toolHost,
      permissions: new LocalPermissions(path.join(config.profile, 'local-permissions.json'), notifications.changed),
      dialogs: {
        consent: async () => { emit({ event: 'consent.denied' }); return 'deny'; },
        enable: async (_bot, _capability, signal, prepareTools) => {
          emit({ event: 'consent.enabled' });
          await prepareTools(signal);
          return true;
        },
        removeTool: async () => true,
        clearCache: async () => true,
      },
      createRuntime: async input => {
        if (input.spec.operation === 'youtube.stream') {
          assert.equal(await run('privateReady'), true, 'Real PC/channel opening must precede native startup.');
        }
        emit({ event: 'native.start', operation: input.spec.operation, privateTags: privateTags(input.id) });
        const task = await createLocalRuntimeTask(input, manager, logError);
        task.closed.then(
          () => emit({ event: 'native.closed', operation: input.spec.operation }),
          error => emit({ event: 'native.failed', reason: error.reason }),
        );
        return task;
      },
      ...notifications, logError,
    }));
  } finally {
    ipcMain.handle = handle;
  }
  await localIpc.service.initialize();
  await window.loadURL(config.rendererUrl);
  const result = await window.webContents.executeJavaScript(
    `import('/__local_execution_e2e_renderer__.mjs').then(module => module.startRenderer(${JSON.stringify({
      port: config.port, nickname: config.role === 'executor' ? 'Local executor' : 'Actual listener',
    })}))`, true,
  );
  rendererInitialized = true;
  process.send({ type: 'ready', value: result });
});
ready.catch(async error => {
  process.send({ type: 'startupFailed', error: error.stack ?? error.message });
  try { await shutdown(); }
  catch (cleanupError) { process.send({ type: 'cleanupFailed', error: cleanupError.message }); }
  app.exit(1);
});

process.on('message', message => {
  const respond = async () => {
    await ready;
    if (message.action === 'shutdown') {
      shuttingDown = true;
      await shutdown();
      return { clean: true, spawnedWorkers };
    }
    if (message.action === 'status') {
      return {
        spawnedWorkers, workers: workers.size, caches: caches.size,
        nativeAlive: [...nativeIds].filter(alive),
        state: await localIpc.service.snapshot(), logs,
        privateClosed: await run('privateClosed'), failures: await run('failures'),
      };
    }
    return run(message.action, message.args);
  };
  respond().then(value => {
    process.send({ type: 'response', id: message.id, value }, () => {
      if (shuttingDown) app.exit(0);
    });
  }, error => process.send({ type: 'response', id: message.id, error: error.stack ?? error.message }));
});
