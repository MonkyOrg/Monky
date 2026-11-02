const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const childProcess = require('node:child_process');
const { createHash } = require('node:crypto');
const { app, BrowserWindow, ipcMain, session: electronSession } = require('electron');
const {
  APP_SHUTDOWN_IPC, BOT_STORAGE_CHANGED, CRASH_RECOVERY_IPC, LOCAL_EXECUTION_IPC, SERVER_INVITE_IPC,
} = require('@monky/shared');
const { exercisePreload } = require(path.join(__dirname, '..', 'preloadFixture.cjs'));
const clientRoot = path.resolve(__dirname, '..', '..');
const distMain = path.join(clientRoot, 'dist-electron', 'main');
const mainRoot = path.join(distMain, 'localExecution');

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
let handlers;
let appLevel;
let unbindBotStorage = () => {};
let unbindBotScreens = () => {};
let unbindDevelopmentQa = () => {};
let manager;
let shuttingDown = false;
let rendererInitialized = false;
const paths = {
  node: config.node, ffmpeg: config.ffmpeg, ytDlp: path.join(config.profile, 'unused-extractor.exe'),
};
const workerEntry = path.join(mainRoot, 'worker.js');
const nativeSpawn = childProcess.spawn;

app.setPath('userData', config.profile);
// Main modules are loaded only now: some read userData while they register their channels.
const { LocalTools } = require(path.join(mainRoot, 'LocalTools.js'));
const { LocalPermissions } = require(path.join(mainRoot, 'LocalPermissions.js'));
const { LocalExecutionService } = require(path.join(mainRoot, 'service.js'));
const { createLocalRuntimeTask } = require(path.join(mainRoot, 'workerClient.js'));
const localExecutionModule = require(path.join(mainRoot, 'createService.js'));
const { setupIpcHandlers } = require(path.join(distMain, 'ipcHandlers.js'));
const { IpcRegistry, sendEvent, windowContents } = require(path.join(distMain, 'ipc', 'registry.js'));
const { isolatedWebPreferences } = require(path.join(distMain, 'windowPreferences.js'));
const { globalInputHook } = require(path.join(distMain, 'globalInputHookProcess.js'));
const { BotDeviceStorage } = require(path.join(distMain, 'botStorage', 'BotDeviceStorage.js'));
const { bindBotDeviceStorage } = require(path.join(distMain, 'botStorage', 'ipc.js'));
const { bindBotScreenDocuments } = require(path.join(distMain, 'botScreenDocuments.js'));
const { ServerInviteInbox } = require(path.join(distMain, 'serverInvites.js'));
const { bindDevelopmentQa } = require(path.join(distMain, 'developmentQa.js'));
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

// Main answers the renderer through the real IPC registry (setupIpcHandlers); only its dependencies
// are fakes. The shortcut hook would observe this computer's keyboard, so it answers without a worker.
for (const method of ['setActionHotkeys', 'setSoundboardHotkeys', 'setPttConfig', 'setShortcutCapture',
  'startCapture', 'stopCapture']) globalInputHook[method] = async () => true;
globalInputHook.init = () => {};
globalInputHook.destroy = () => {};
const unavailable = name => async () => { throw new Error(`${name} is unavailable in the isolated E2E.`); };
// Hosting a server from this client is out of scope; the renderer only reads that none is hosted.
const serverManager = {
  getStatus: () => ({ servers: [] }), getLogs: () => [], clearLogs: () => {}, getStats: () => null,
  startServer: unavailable('Hosting a server'), stopServer: unavailable('Hosting a server'),
  deleteServerData: unavailable('Hosting a server'), getUpdateInventory: unavailable('The update inventory'),
};
const clientLogger = {
  write: entry => { if (entry.level === 'ERROR') emit({ event: 'renderer.clientError', message: entry.message }); },
};
/**
 * Channels main.ts registers itself, outside setupIpcHandlers, with the same behavior a healthy
 * window sees: no pending invitation, crash recovery idle, shutdown acknowledged and no prepared QA.
 */
function registerAppLevelChannels() {
  appLevel = new IpcRegistry(ipcMain, { main: () => windowContents(window), overlay: () => null });
  const invites = new ServerInviteInbox();
  appLevel.handle(SERVER_INVITE_IPC.take, 'main', () => invites.take());
  appLevel.handle(APP_SHUTDOWN_IPC.acknowledge, 'main', () => undefined);
  appLevel.handle(CRASH_RECOVERY_IPC.ready, 'main', () => true);
  appLevel.handle(CRASH_RECOVERY_IPC.bootstrapFailed, 'main', (_event, failure) => {
    emit({ event: 'renderer.bootstrapFailed', phase: failure?.phase });
    return false;
  });
  const isOwner = contents => contents === window.webContents;
  const storage = new BotDeviceStorage(path.join(config.profile, 'bot-storage'),
    scopeId => sendEvent(windowContents(window), BOT_STORAGE_CHANGED, scopeId));
  unbindBotScreens = bindBotScreenDocuments(isOwner, storage);
  unbindBotStorage = bindBotDeviceStorage(isOwner, storage);
  // Outside prepared QA, main.ts binds these with no configuration: they answer null and false.
  unbindDevelopmentQa = bindDevelopmentQa(window, null, () => emit({ event: 'main.quitRequested' }));
}

/** Every channel the real preload can invoke must have a handler here, or the renderer meets "No handler registered". */
async function assertPreloadChannelsAnswered(registered) {
  const { channels } = await exercisePreload();
  const missing = [...channels].filter(channel => !registered.has(channel)).sort();
  assert.deepEqual(missing, [], `The local execution E2E actor does not answer ${missing.length} IPC channel(s) ` +
    `the preload calls: ${missing.join(', ')}. Register them through setupIpcHandlers (src/main/ipcHandlers.ts) ` +
    'so this actor mounts them too, or, for a channel main.ts registers itself, add it to registerAppLevelChannels.');
}
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
    if (handlers) await handlers.dispose();
    else if (manager) await manager.dispose();
  } catch (error) { errors.push(error); }
  // Exit notifications and Windows process teardown arrive asynchronously: confirm within a bound, never sooner.
  const settledBy = Date.now() + 5000;
  const leftovers = () => workers.size || caches.size || [...nativeIds].some(alive);
  while (leftovers() && Date.now() < settledBy) await new Promise(resolve => setTimeout(resolve, 50));
  if (workers.size) errors.push(new Error(`${workers.size} private workers are still live.`));
  for (const pid of nativeIds) if (alive(pid)) errors.push(new Error(`Native fixture process ${pid} is still live.`));
  if (caches.size) errors.push(new Error(`${caches.size} native cache leases remain owned.`));
  childProcess.spawn = nativeSpawn;
  unbindBotScreens();
  unbindBotStorage();
  unbindDevelopmentQa();
  appLevel?.dispose();
  // Closing the window disposes its IPC registry, as in the app.
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
    // The same isolated preferences and bundled preload as the application window.
    webPreferences: isolatedWebPreferences('preload', { offscreen: true, backgroundThrottling: false }),
  });
  window.webContents.on('console-message', (_event, level, message) => {
    if (message.startsWith('LOCAL_E2E ')) emit(JSON.parse(message.slice('LOCAL_E2E '.length)));
    else if (level >= 2) emit({ event: 'renderer.log', level, message });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    emit({ event: 'renderer.gone', reason: details.reason });
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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
    supported: () => manager.supported(),
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
  const registered = new Set();
  const observed = new Map([
    [LOCAL_EXECUTION_IPC.prepare, 'prepare'], [LOCAL_EXECUTION_IPC.startTask, 'start'],
    [LOCAL_EXECUTION_IPC.readFrames, 'read'], [LOCAL_EXECUTION_IPC.acknowledgeFrames, 'played'],
    [LOCAL_EXECUTION_IPC.setPaused, 'pause'],
  ]);
  ipcMain.handle = (channel, handler) => {
    registered.add(channel);
    const operation = observed.get(channel);
    if (!operation) return handle(channel, handler);
    return handle(channel, async (event, input, ...rest) => {
      emit({
        event: `ipc.${operation}.begin`, playedFrames: input?.playedFrames,
        privateTags: privateTags(input?.subject?.connectionId, input?.permit),
      });
      const result = await handler(event, input, ...rest);
      emit({
        event: `ipc.${operation}.end`, status: result?.status, reason: result?.reason,
        done: result?.done, frames: result?.frames?.length, playedFrames: input?.playedFrames,
        privateTags: privateTags(result?.permit, result?.taskId),
      });
      return result;
    });
  };
  // setupIpcHandlers builds local execution through this export; the fixture service replaces it
  // for the call, so no real tool is ever installed or downloaded.
  const createService = localExecutionModule.createLocalExecutionService;
  let fixtureService = false;
  localExecutionModule.createLocalExecutionService = (owner, _userData, notifications, onTools) => {
    assert.equal(owner, window, 'Local execution belongs to the actor window.');
    fixtureService = true;
    onTools?.(manager);
    return new LocalExecutionService({
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
    });
  };
  try {
    registerAppLevelChannels();
    handlers = setupIpcHandlers(window, serverManager, undefined, {
      clientLogger, quitApplication: () => emit({ event: 'main.quitRequested' }),
    });
  } finally {
    ipcMain.handle = handle;
    localExecutionModule.createLocalExecutionService = createService;
  }
  assert.ok(fixtureService, 'setupIpcHandlers no longer builds local execution through createLocalExecutionService; ' +
    'update this actor so the authored E2E keeps its fixture tools.');
  await assertPreloadChannelsAnswered(registered);
  await handlers.service.initialize();
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
        state: await handlers.service.snapshot(), logs,
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
