const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `camera-effects-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_CAMERA_EFFECTS_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_CAMERA_EFFECTS_PROFILE);
  app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
  app.on('window-all-closed', () => {});
  let vite, window, timeout;
  let blockModel = false;
  const externalRequests = [];
  const modelRequests = [];
  const deniedModelRequests = [];
  const finish = async code => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const packaged = process.argv.includes('--packaged');
    const { createServer, build } = await import('vite');
    const config = {
      configFile: path.join(clientRoot, 'vite.config.ts'),
      root: clientRoot,
      base: './',
      logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      worker: { format: 'es' },
      optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] },
    };
    let fixture;
    let packagedModel = null;
    if (packaged) {
      const output = path.join(app.getPath('userData'), 'offline-build');
      await build({
        ...config,
        build: {
          outDir: output, emptyOutDir: true, target: 'esnext',
          rollupOptions: { input: path.join(clientRoot, 'test', 'fixtures', 'cameraEffects.html') },
        },
      });
      fixture = path.join(output, 'test', 'fixtures', 'cameraEffects.html');
      const assets = path.join(output, 'assets');
      const assetNames = fs.readdirSync(assets);
      const modelName = assetNames.find(name => name.endsWith('.tflite'));
      if (!modelName || !assetNames.some(name => name.endsWith('.wasm'))) {
        throw new Error('Offline fixture must include real local model and WASM files');
      }
      packagedModel = path.join(assets, modelName);
      const sourceInfo = JSON.parse(fs.readFileSync(
        path.join(clientRoot, 'src', 'renderer', 'assets', 'camera-effects', 'SOURCES.json'), 'utf8'));
      const hash = createHash('sha256').update(fs.readFileSync(packagedModel)).digest('hex');
      if (hash !== sourceInfo.model.sha256) throw new Error('Packaged model differs from the pinned licensed asset');
      console.log('CAMERA TEST offline assets ' + JSON.stringify({
        model: modelName, sha256: hash,
        wasm: assetNames.filter(name => name.endsWith('.wasm')),
        worker: assetNames.filter(name => name.startsWith('cameraEffects.worker-')),
        loader: assetNames.filter(name => name.startsWith('vision_wasm_module_internal-') && name.endsWith('.js')),
      }));
    } else {
      vite = await createServer({
        ...config,
        server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
        plugins: [{
          name: 'camera-effect-model-fault',
          configureServer(server) {
            server.middlewares.use((request, response, next) => {
              const url = new URL(request.url, 'http://127.0.0.1');
              if (!url.pathname.endsWith('.tflite') || url.searchParams.has('url')) return next();
              modelRequests.push(url.href);
              response.setHeader('Cache-Control', 'no-store');
              if (!blockModel) return next();
              deniedModelRequests.push(url.href);
              response.statusCode = 404;
              response.end('Camera smoke fixture: local model unavailable');
            });
          },
        }],
      });
      const http = vite.httpServer;
      if (!http) throw new Error('Missing Vite server');
      await new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
      });
      fixture = `http://127.0.0.1:${http.address().port}/test/fixtures/cameraEffects.html`;
    }
    window = new BrowserWindow({
      show: false, width: 1000, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.setAudioMuted(true);
    window.webContents.on('console-message', (_event, _level, message) => {
      if (message.startsWith('CAMERA TEST') || process.argv.includes('--camera-trace')) {
        console.log(`[camera ${packaged ? 'offline' : 'dev'}] ${message}`);
      }
    });
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const local = url.protocol === 'file:' || url.protocol === 'blob:' || url.protocol === 'data:'
        || url.hostname === '127.0.0.1' || url.hostname === 'localhost';
      if (!local) externalRequests.push(details.url);
      callback({ cancel: !local });
    });
    timeout = setTimeout(() => { console.error('Camera effects smoke timed out'); void finish(1); }, 150000);
    if (packaged) await window.loadFile(fixture);
    else await window.loadURL(fixture);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const timer = setInterval(() => {
        if (window.cameraEffectsFixture) { clearInterval(timer); resolve(); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Camera fixture import failed')); }
      }, 30);
    })`);
    const ownershipOnly = process.argv.includes('--ownership-only');
    const chromaOnly = process.argv.includes('--chroma-only');
    const transitionsOnly = process.argv.includes('--transitions-only');
    const fpsOnly = process.argv.includes('--fps-only') || process.argv.includes('--quality-only');
    const keyColorsOnly = process.argv.includes('--key-colors-only');
    const selectedPhases = [
      ...(ownershipOnly ? ['ownership'] : []), ...(keyColorsOnly ? ['key-colors'] : []),
      ...(fpsOnly ? ['quality'] : []), ...(transitionsOnly ? ['transitions'] : []), ...(chromaOnly ? ['chroma'] : []),
    ];
    const phases = selectedPhases.length ? selectedPhases
      : ['ownership', 'key-colors', 'quality', 'transitions', 'missing-model', 'normal', 'recovery'];
    let checks = 0;
    for (const phase of phases) {
      blockModel = phase === 'missing-model';
      console.log(`CAMERA TEST ${packaged ? 'offline' : 'dev'} phase ${phase}`);
      if (blockModel) await window.webContents.session.clearCache();
      if (blockModel && packagedModel) fs.renameSync(packagedModel, `${packagedModel}.smoke-missing`);
      try {
        checks += await window.webContents.executeJavaScript(`(${runCameraEffectsSmoke.toString()})('${phase}')`, true);
      } finally {
        if (blockModel && packagedModel) fs.renameSync(`${packagedModel}.smoke-missing`, packagedModel);
      }
    }
    if (!selectedPhases.length && !packaged && (!modelRequests.length || !deniedModelRequests.length)) {
      throw new Error('The real local model must be requested and its missing-file failure exercised');
    }
    if (externalRequests.length) throw new Error(`Unexpected external requests: ${externalRequests.join(', ')}`);
    console.log(`Camera effects ${phases.join(' + ')} (${packaged ? 'packaged offline' : 'dev'}) smoke: ${checks} checks passed; no external requests`);
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runCameraEffectsSmoke(phase) {
  const { videoService: service, cameraEffectsStore: store, CameraEffectsStore, CameraEffectsControl,
    settingsStore: settings, appEvents, t, CameraEffectError } = window.cameraEffectsFixture;
  let checks = 0;
  const check = (condition, message, details) => {
    if (!condition) throw new Error(details ? `${message}: ${JSON.stringify(details())}` : message);
    checks++;
  };
  const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (probe, message, timeout = 12000, details) => {
    const end = performance.now() + timeout;
    while (performance.now() < end) {
      const result = await probe();
      if (result) return result;
      await tick(40);
    }
    throw new Error(details ? `${message}: ${JSON.stringify(details())}` : message);
  };
  const rejected = async (action, message) => {
    let error;
    try { await action(); } catch (reason) { error = reason; }
    check(error instanceof Error, message);
    return error;
  };
  const original = {
    gum: navigator.mediaDevices.getUserMedia,
    Worker: window.Worker,
    createElement: document.createElement,
    camera: settings.selectedCameraId,
    profile: settings.customProfile,
    requestFrame: HTMLVideoElement.prototype.requestVideoFrameCallback,
    cancelFrame: HTMLVideoElement.prototype.cancelVideoFrameCallback,
    storeUpdate: store.update,
    bitmap: window.createImageBitmap,
    visibility: Object.getOwnPropertyDescriptor(document, 'visibilityState'),
  };
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  const workers = new Set();
  const videos = [];
  const callbacks = new Map();
  const captures = [];
  const requests = [];
  const failures = [];
  let pendingCapture = null;
  let captureMode = 'normal';
  let control = null;
  let transitionLease = null;
  let releaseSnapshot = null;
  let peerA = null;
  let peerB = null;
  let sender = null;
  let replaceChain = Promise.resolve();
  window.Worker = class extends original.Worker {
    constructor(...args) { super(...args); workers.add(this); }
    terminate() { workers.delete(this); super.terminate(); }
  };
  document.createElement = function (name, options) {
    const element = original.createElement.call(this, name, options);
    if (String(name).toLowerCase() === 'video') videos.push(element);
    return element;
  };
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
    const video = this;
    let ids = callbacks.get(video);
    if (!ids) { ids = new Set(); callbacks.set(video, ids); }
    const id = original.requestFrame.call(video, (now, metadata) => { ids.delete(id); callback(now, metadata); });
    ids.add(id);
    return id;
  };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = function (id) {
    callbacks.get(this)?.delete(id);
    original.cancelFrame.call(this, id);
  };
  const source = document.createElement('canvas');
  source.width = 320;
  source.height = 180;
  const sourceContext = source.getContext('2d');
  let physicalColor = '#00ff00';
  let foregroundColor = '#e01010';
  const drawSource = () => {
    sourceContext.fillStyle = physicalColor;
    sourceContext.fillRect(0, 0, source.width, source.height);
    sourceContext.fillStyle = foregroundColor;
    sourceContext.fillRect(source.width * 0.375, source.height * 2 / 9, source.width / 4, source.height * 11 / 18);
    for (let x = 0; x < 64; x += 8) {
      sourceContext.fillStyle = x % 16 ? '#ffffff' : '#000000';
      sourceContext.fillRect(x * source.width / 320, 0, source.width / 40, source.height * 4 / 9);
    }
  };
  drawSource();
  const sourceStream = source.captureStream(30);
  const sourceTimer = setInterval(drawSource, 33);
  const capture = () => {
    const stream = sourceStream.clone();
    captures.push(stream);
    return stream;
  };
  navigator.mediaDevices.getUserMedia = async constraints => {
    requests.push(constraints);
    if (captureMode === 'denied') throw new DOMException('Fixture permission denied', 'NotAllowedError');
    if (captureMode === 'pending') return new Promise(resolve => { pendingCapture = resolve; });
    if (captureMode === 'constraints') {
      captureMode = 'normal';
      throw new DOMException('Fixture exact resolution unavailable', 'OverconstrainedError');
    }
    return capture();
  };
  const offError = appEvents.on('camera.effects_error', error => failures.push(error));
  const offReplace = appEvents.on('local.camera_replaced', ({ stream }) => {
    if (sender) replaceChain = replaceChain.then(() => sender.replaceTrack(stream.getVideoTracks()[0]));
  });
  const offStop = appEvents.on('local.camera_stopped', () => {
    if (sender) replaceChain = replaceChain.then(() => sender.replaceTrack(null));
  });
  const container = document.createElement('div');
  document.body.append(container);
  const sampleVideo = document.createElement('video');
  sampleVideo.muted = true;
  sampleVideo.playsInline = true;
  document.body.append(sampleVideo);
  const sampleCanvas = document.createElement('canvas');
  const sampleContext = sampleCanvas.getContext('2d', { willReadFrequently: true });
  async function watch(stream, video = sampleVideo) {
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      await video.play();
    }
    await until(() => video.readyState >= 2 && video.videoWidth, 'No actual video frames reached the preview');
  }
  function pixel(x, y, video = sampleVideo) {
    sampleCanvas.width = video.videoWidth;
    sampleCanvas.height = video.videoHeight;
    sampleContext.drawImage(video, 0, 0);
    return [...sampleContext.getImageData(Math.floor(video.videoWidth * x), Math.floor(video.videoHeight * y), 1, 1).data];
  }
  function near(pixel, rgb, tolerance = 18) {
    return rgb.every((channel, index) => Math.abs(pixel[index] - channel) <= tolerance);
  }
  function frameDiagnostics(x, y, video = sampleVideo) {
    const state = service.getCameraState();
    const processor = service.cameraProcessor;
    const canvas = processor?.canvas;
    const presented = video.readyState >= 2 && video.videoWidth && video.videoHeight ? pixel(x, y, video) : null;
    const processed = canvas && processor.context
      ? [...processor.context.getImageData(Math.floor(canvas.width * x), Math.floor(canvas.height * y), 1, 1).data]
      : null;
    return {
      phase, mode: store.snapshot.settings.mode, status: state.status, publishing: state.publishing,
      error: state.error?.code, failures: failures.map(error => error.code),
      preview: {
        readyState: video.readyState, paused: video.paused, currentTime: video.currentTime,
        width: video.videoWidth, height: video.videoHeight, presented,
        totalFrames: video.getVideoPlaybackQuality().totalVideoFrames,
        matchesReadyStream: video.srcObject === state.stream,
      },
      processor: processor ? {
        active: processor.active, revision: processor.revision, inFlight: processor.inFlightRevision,
        targetFps: processor.targetFps, width: canvas?.width, height: canvas?.height, processed,
      } : null,
    };
  }
  async function expectVideoPixel(x, y, accepts, message, video = sampleVideo, timeout = 12000) {
    const details = () => frameDiagnostics(x, y, video);
    const observed = await until(() => {
      if (service.getCameraState().status === 'error') {
        throw new Error(`${message}: ${JSON.stringify(details())}`);
      }
      if (video.paused || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
      const actual = pixel(x, y, video);
      return accepts(actual) ? actual : false;
    }, message, timeout, details);
    check(accepts(observed), message, details);
    return observed;
  }
  async function backgroundImage(name = 'chosen <b>background</b>.png') {
    const canvas = new OffscreenCanvas(160, 90);
    const context = canvas.getContext('2d');
    context.fillStyle = '#de20aa';
    context.fillRect(0, 0, 160, 90);
    return new File([await canvas.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' });
  }
  const allCapturedTracksStopped = () => captures.every(stream => stream.getTracks().every(track => track.readyState === 'ended'));
  try {
    service.stopCamera();
    settings.selectedCameraId = 'camera-fixture-a';
    service.setQualityPreset('NORMAL');
    await service.setCameraEffects({
      mode: 'off', limitQuality: false, backgroundColor: '#1122dd', backgroundSource: 'color',
      keyColor: '#00ff00', keyTolerance: 25, keySoftness: 10, spillReduction: 50,
    });
    if (phase === 'key-colors') {
      await service.setCameraEffects({ mode: 'chroma', keyColor: physicalColor, keyTolerance: 25 });
      transitionLease = await service.acquireCameraPreview();
      const stream = await service.startCamera();
      const track = stream.getVideoTracks()[0];
      check(transitionLease.stream === stream && requests.length === 1,
        'Physical color fixture shares one camera between call and preview');
      const changeKey = async keyColor => {
        physicalColor = keyColor;
        foregroundColor = keyColor === '#ff0000' ? '#00ffff' : '#e01010';
        drawSource();
        const update = service.setCameraEffects({ keyColor });
        check(!track.enabled && service.getCameraState().status === 'starting',
          'Changing physical color gates previous output before asynchronous work');
        try {
          await update;
        } catch (error) {
          console.log('CAMERA TEST physical-color rejection ' + JSON.stringify({
            keyColor, code: error.code, cameraStatus: service.getCameraState().status,
            captureStopped: allCapturedTracksStopped(), publishing: service.getCameraState().publishing,
            rendererResponding: document.body.isConnected,
          }));
          throw error;
        }
        await watch(stream);
        await expectVideoPixel(0.9, 0.85, actual => near(actual, [17, 34, 221]),
          `Actual worker removes physical ${keyColor} onto the chosen opaque replacement`);
        await expectVideoPixel(0.5, 0.5, actual => near(actual, keyColor === '#ff0000' ? [0, 255, 255] : [224, 16, 16]),
          `Physical ${keyColor} preserves the different foreground color`);
        check(service.getCameraStream() === stream && track.readyState === 'live' && track.enabled
          && requests.length === 1 && captures[0].active && service.getCameraState().publishing,
        `Physical ${keyColor} keeps the renderer, sole capture, preview and published track alive`);
        const restored = await new CameraEffectsStore().load();
        check(restored.settings.keyColor === keyColor && restored.settings.mode === 'chroma',
          `Physical ${keyColor} survives actual persistent-store reloading`);
      };
      for (let repeat = 0; repeat < 2; repeat++) {
        for (const key of ['#00ff00', '#0000ff', '#ff0000', '#ff00ff', '#ffffff', '#000000', '#808080', '#808182', '#7f8081', '#7f817f', '#010102', '#000005', '#010503', '#fefefd']) {
          await changeKey(key);
        }
      }
      physicalColor = '#808080';
      foregroundColor = '#e01010';
      drawSource();
      const rapid = await Promise.allSettled(['#ffffff', '#000000', '#7f8081', physicalColor]
        .map(keyColor => service.setCameraEffects({ keyColor })));
      check(rapid.every(result => result.status === 'fulfilled' || result.reason?.name === 'AbortError'),
        'Rapid full-range color changes only complete or explicitly cancel superseded revisions');
      await watch(stream);
      await expectVideoPixel(0.9, 0.85, actual => store.snapshot.settings.keyColor === physicalColor && near(actual, [17, 34, 221]),
        'The last rapid key choice owns persistence and genuine processed pixels');
      await service.setCameraBackgroundImage(await backgroundImage('neutral-key-transition.png'));
      let delayedFirstBlur = false;
      for (const mode of ['blur', 'color', 'image', 'chroma', 'blur', 'chroma']) {
        const delayPreview = mode === 'blur' && !delayedFirstBlur;
        if (delayPreview) {
          delayedFirstBlur = true;
          sampleVideo.pause();
        }
        await service.setCameraEffects({ mode, backgroundSource: 'color', blurRadius: 24 });
        // Producer readiness and native video presentation are different clocks.
        // Hold only the fixture preview past the former 180 ms sleep.
        const resumed = delayPreview ? tick(600).then(() => sampleVideo.play()) : Promise.resolve();
        try {
          if (delayPreview) {
            const observation = frameDiagnostics(0.07, 0.2);
            const processed = observation.processor?.processed;
            check(observation.status === 'ready' && observation.preview.paused
              && processed && processed[0] > 15 && processed[0] < 240,
            'The real model produces a ready blur independently of delayed preview presentation', () => observation);
            const timeoutMessage = 'Fixture preview remains deliberately paused';
            const failure = await rejected(() => expectVideoPixel(
              0.07, 0.2, actual => actual[0] > 15 && actual[0] < 240,
              timeoutMessage, sampleVideo, 100,
            ), 'Stalled presentation rejects instead of accepting producer readiness');
            const detail = JSON.parse(failure.message.slice(timeoutMessage.length + 2));
            check(detail.status === 'ready' && detail.preview.paused
              && Array.isArray(detail.preview.presented) && Array.isArray(detail.processor.processed),
            'A presentation timeout exposes both preview and processed pixels with live state');
          }
          await watch(stream);
          check(service.getCameraStream() === stream && track.readyState === 'live' && requests.length === 1,
            `Neutral-key ${mode} transitions reuse the model/capture and stable output track`);
          if (mode === 'blur') {
            await expectVideoPixel(0.07, 0.2, actual => actual[0] > 15 && actual[0] < 240,
              'A neutral physical key coexists with real model blur');
          } else {
            await expectVideoPixel(0.9, 0.85, actual => near(actual, mode === 'image' ? [222, 32, 170] : [17, 34, 221]),
              `Actual ${mode} pixels remain correct after changing neutral physical keys`);
          }
        } finally {
          await resumed;
        }
      }
      check(failures.length === 0, 'Valid RGB choices and real model transitions produce no camera shutdown/error');
      transitionLease.release();
      transitionLease = null;
      check(service.getCameraStream() === stream && track.readyState === 'live' && captures[0].active,
        'Closing the color preview releases only its lease, preserving the active call');
      const error = await rejected(() => service.setCameraEffects({ keyColor: '#not-rgb' }),
        'A genuinely malformed physical color still rejects explicitly');
      await until(() => workers.size === 0, 'Malformed key failure must dispose its worker');
      check(error.code === 'settings' && allCapturedTracksStopped() && !service.getCameraStream(),
        'Malformed keys fail closed without unprocessed output or a renderer/process crash');
      check(store.snapshot.settings.keyColor === physicalColor && store.snapshot.settings.mode === 'chroma',
        'A failed malformed choice does not overwrite the previous valid privacy settings');
      return checks;
    }
    if (phase === 'missing-model') {
      await service.setCameraEffects({ mode: 'blur' });
      const error = await rejected(() => service.startCamera(), 'Missing local model must reject camera startup');
      check(error.code === 'model', `Missing model should be an explicit model error, got ${error.code}`);
      check(store.snapshot.settings.mode === 'blur', 'Model failure must preserve the enabled privacy choice');
      check(service.getCameraStream() === null && allCapturedTracksStopped(), 'Missing assets never expose an unprocessed camera');
      await until(() => workers.size === 0, 'Failed model worker was not terminated');
      check(failures.some(failure => failure.code === 'model'), 'Missing assets produce actionable UI notification');
      await service.setCameraEffects({ mode: 'chroma' });
      transitionLease = await service.acquireCameraPreview();
      await watch(transitionLease.stream);
      await expectVideoPixel(0.9, 0.85, actual => near(actual, [17, 34, 221]),
        'Physical chroma works with the genuinely missing segmentation model');
      const failedTransition = await rejected(() => service.setCameraEffects({ mode: 'blur' }),
        'A chroma-to-AI transition with a missing model must reject explicitly');
      await until(() => workers.size === 0, 'Failed model transition worker was not terminated');
      check(failedTransition.code === 'model' && !service.getCameraState().stream && allCapturedTracksStopped(),
        'A genuine transition load failure closes raw/output tracks instead of falling back to the camera');
      check(store.snapshot.settings.mode === 'blur', 'Failed transition preserves the requested privacy effect');
      return checks;
    }
    if (phase === 'recovery') {
      await service.setCameraEffects({ mode: 'color', backgroundColor: '#1122dd' });
      const stream = await service.startCamera();
      await watch(stream);
      await expectVideoPixel(0.9, 0.85, actual => near(actual, [17, 34, 221]),
        'Model recovery renders real local segmentation frames');
      service.stopCamera();
      await until(() => workers.size === 0, 'Recovered worker was not terminated');
      check(allCapturedTracksStopped(), 'Recovery does not retain camera captures');
      return checks;
    }
    if (phase === 'quality') {
      const record = async (value) => {
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open('monky-camera-effects', 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise((resolve, reject) => {
            const transaction = database.transaction('preferences', value === undefined ? 'readonly' : 'readwrite');
            const preferences = transaction.objectStore('preferences');
            const request = value === undefined ? preferences.get('current') : preferences.put(value, 'current');
            let result;
            request.onsuccess = () => { result = request.result; };
            transaction.oncomplete = () => resolve(result);
            transaction.onabort = () => reject(transaction.error);
            transaction.onerror = () => reject(transaction.error);
          });
        } finally {
          database.close();
        }
      };
      await service.setCameraBackgroundImage(await backgroundImage('legacy-private-fixture.png'));
      await service.setCameraEffects({ mode: 'chroma', backgroundSource: 'image', blurRadius: 28, keyTolerance: 31 });
      const saved = store.snapshot;
      const { limitQuality, ...legacy } = saved.settings;
      for (const maxFps of [5, 15, 24]) {
        await record({ version: 1, settings: { ...legacy, maxFps }, image: saved.image });
        const migrated = await new CameraEffectsStore().load();
        check(migrated.settings.limitQuality === false && !('maxFps' in migrated.settings)
          && !('limitFpsTo30' in migrated.settings),
        `Legacy ${maxFps} FPS migrates to full profile quality, not a hidden limit`);
        check(migrated.settings.mode === 'chroma' && migrated.settings.backgroundSource === 'image'
          && migrated.settings.keyTolerance === 31 && migrated.settings.blurRadius === 28
          && migrated.image.id === saved.image.id && migrated.image.blob.size === saved.image.blob.size,
        'Legacy FPS migration preserves privacy settings and the actual saved image Blob');
      }
      for (const limitFpsTo30 of [false, true]) {
        await record({ version: 1, settings: { ...legacy, keyColor: '#808080', limitFpsTo30 }, image: saved.image });
        const migrated = await new CameraEffectsStore().load();
        check(migrated.settings.limitQuality === limitFpsTo30 && !('limitFpsTo30' in migrated.settings),
          `Legacy FPS-only ${limitFpsTo30} migrates to the same combined quality-limit choice`);
        check(migrated.settings.keyColor === '#808080' && migrated.settings.keyTolerance === 31
          && migrated.settings.mode === 'chroma' && migrated.settings.backgroundSource === 'image'
          && migrated.image.id === saved.image.id && migrated.image.blob.size === saved.image.blob.size,
        'Boolean migration preserves neutral physical key, privacy settings and saved image');
      }
      const migratedStore = new CameraEffectsStore();
      await migratedStore.load();
      await migratedStore.update({ limitQuality: true });
      const canonical = await record();
      check(canonical.settings.limitQuality === true && !('maxFps' in canonical.settings) && !('limitFpsTo30' in canonical.settings)
        && canonical.image.id === saved.image.id, 'Next atomic write persists the new cap without legacy fields or image loss');
      for (const policy of [{ maxFps: 0 }, { limitFpsTo30: 'true' }, { limitQuality: null }, {}]) {
        await record({ version: 1, settings: { ...legacy, ...policy }, image: saved.image });
        const invalidStore = new CameraEffectsStore();
        const invalid = await rejected(() => invalidStore.load(), 'Invalid or missing quality policy must not become an Off preference');
        check(invalid.code === 'settings' && !invalidStore.isLoaded && requests.length === 0,
          'Corrupt legacy/canonical data stays an explicit error and never starts hardware');
      }
      await service.setCameraEffects({ mode: 'chroma', backgroundSource: 'color', limitQuality: false });
      source.width = 1920;
      source.height = 1080;
      drawSource();
      settings.customProfile = { ...settings.customProfile, cameraWidth: 1920, cameraHeight: 1080, cameraFps: 60 };
      service.setQualityPreset('CUSTOM');
      transitionLease = await service.acquireCameraPreview();
      const stream = transitionLease.stream;
      const processor = service.cameraProcessor;
      await watch(stream);
      const expectSize = async (width, height, message) => {
        try {
          await until(() => {
            const actual = stream.getVideoTracks()[0].getSettings();
            return sampleVideo.videoWidth === width && sampleVideo.videoHeight === height
              && processor.canvas.width === width && processor.canvas.height === height
              && actual.width === width && actual.height === height;
          }, message);
        } catch (error) {
          const dimensions = track => {
            const value = track.getSettings();
            return { width: value.width, height: value.height, frameRate: value.frameRate };
          };
          console.log('CAMERA TEST quality-size failure ' + JSON.stringify({
            requested: { width, height }, input: [source.width, source.height],
            source: dimensions(sourceStream.getVideoTracks()[0]), raw: dimensions(captures[0].getVideoTracks()[0]),
            processorInput: [processor.video?.videoWidth, processor.video?.videoHeight],
            output: [processor.canvas?.width, processor.canvas?.height], preview: [sampleVideo.videoWidth, sampleVideo.videoHeight],
            limitQuality: processor.limitQuality,
          }));
          throw error;
        }
        check(stream.getVideoTracks()[0].getSettings().width === width
          && stream.getVideoTracks()[0].getSettings().height === height, message);
      };
      check(processor.targetFps === 60 && store.snapshot.settings.limitQuality === false,
        'Real processor follows a 60 FPS profile by default instead of the old 15/24 ceiling');
      check(requests[0].video.width.exact === 1920 && requests[0].video.height.exact === 1080
        && requests[0].video.frameRate.exact === 60, 'Capture requests the selected full-resolution/FPS profile');
      await expectSize(1920, 1080, 'Uncapped genuine output retains the selected 1080p resolution');
      await expectVideoPixel(0.9, 0.85, actual => near(actual, [17, 34, 221]),
        'Profile-rate processing still exposes only the keyed composite');
      await service.setCameraEffects({ limitQuality: true });
      check(processor.targetFps === 30 && service.getCameraState().stream === stream,
        'Combined quality cap changes the real scheduler without replacing its processed track');
      await expectSize(1280, 720, 'The enabled quality switch caps actual 1080p frames at 720p');
      settings.customProfile = { ...settings.customProfile, cameraWidth: 800, cameraHeight: 600, cameraFps: 20 };
      await service.applyQualityPreset('CUSTOM');
      check(processor.targetFps === 20, 'An enabled cap never raises a lower selected profile FPS');
      await expectSize(800, 450, 'A lower non-widescreen profile bounds resolution while preserving source aspect ratio');
      await service.setCameraEffects({ limitQuality: false });
      check(processor.targetFps === 20, 'Disabling the cap preserves a lower profile target');
      await expectSize(800, 450, 'Disabling the cap never raises a lower selected resolution');
      settings.customProfile = { ...settings.customProfile, cameraWidth: 1920, cameraHeight: 1080, cameraFps: 60 };
      await service.applyQualityPreset('CUSTOM');
      check(processor.targetFps === 60 && requests.length === 1 && service.getCameraState().stream === stream,
        'Live profile changes update effect FPS without another capture or sender track');
      await expectSize(1920, 1080, 'A live profile increase restores uncapped full resolution on the same track');
      const published = await service.startCamera();
      check(published === stream && requests.length === 1, 'Full-resolution preview promotes to the same active call capture');
      for (const enabled of [true, false, true, false]) {
        const changing = service.setCameraEffects({ limitQuality: enabled });
        check(!stream.getVideoTracks()[0].enabled, 'Quality-limit changes synchronously gate old frames');
        await changing;
        await expectSize(enabled ? 1280 : 1920, enabled ? 720 : 1080,
          'Repeated quality-switch changes resize the stable published track');
        check(processor.targetFps === (enabled ? 30 : 60) && service.getCameraStream() === stream,
          'Published resolution and FPS limits change together without replacing the stream');
      }
      source.width = 640;
      source.height = 360;
      drawSource();
      await expectSize(640, 360, 'Uncapped output never upscales a lower-resolution actual source');
      await service.setCameraEffects({ limitQuality: true });
      await expectSize(640, 360, 'The enabled cap also never upscales a lower-resolution source');
      source.width = 1920;
      source.height = 1080;
      drawSource();
      await service.setCameraEffects({ limitQuality: false });
      settings.customProfile = { ...settings.customProfile, cameraWidth: 3840, cameraHeight: 2160 };
      await service.applyQualityPreset('CUSTOM');
      await expectSize(1920, 1080, 'A selected 4K profile remains bounded by actual 1080p input, not an invented larger frame');
      settings.customProfile = { ...settings.customProfile, cameraWidth: 1920, cameraHeight: 1080 };
      await service.applyQualityPreset('CUSTOM');
      for (const mode of ['color', 'image', 'blur', 'chroma']) {
        await service.setCameraEffects({ mode, backgroundSource: 'color', blurRadius: 24 });
        await expectSize(1920, 1080, `Actual ${mode} processing preserves full 1080p without the quality limit`);
        if (mode === 'blur') {
          await expectVideoPixel(0.07, 0.2, actual => actual[0] > 15 && actual[0] < 240,
            'Real AI blur processes the full-resolution input');
        } else {
          const replacement = mode === 'image' ? [222, 32, 170] : [17, 34, 221];
          await expectVideoPixel(0.9, 0.85, actual => near(actual, replacement),
            `Full-resolution ${mode} contains the genuine processed replacement`);
        }
        await service.setCameraEffects({ limitQuality: true });
        await expectSize(1280, 720, `Actual ${mode} processing honors the same 720p limit`);
        check(processor.targetFps === 30, `Actual ${mode} processing also honors the 30 FPS limit`);
        await service.setCameraEffects({ limitQuality: false });
        await expectSize(1920, 1080, `Removing the quality limit restores full-resolution ${mode} output`);
      }
      const rapidQuality = await Promise.allSettled([true, false, true, false]
        .map(limitQuality => service.setCameraEffects({ limitQuality })));
      check(rapidQuality.every(result => result.status === 'fulfilled' || result.reason?.name === 'AbortError'),
        'Rapid quality-limit changes safely cancel superseded configurations');
      await expectSize(1920, 1080, 'The last rapid quality choice owns actual full-resolution output');
      check(processor.targetFps === 60 && !store.snapshot.settings.limitQuality
        && service.getCameraStream() === stream && requests.length === 1,
      'Rapid combined-limit changes preserve selected FPS, publication identity and single capture');

      const Processor = processor.constructor;
      for (const [profileFps, sourceFps, cap, expected] of [
        [60, 60, false, 60], [60, 120, true, 30], [20, 60, true, 20], [24, 120, false, 24], [120, 240, false, 120],
        [60, 12, false, 12], [60, 12, true, 12],
      ]) {
        const profile = { ...service.getProfile(), cameraFps: profileFps };
        const simulation = new Processor(sourceStream, profile, error => { throw error; });
        const input = document.createElement('video');
        let callback = null;
        let callbackId = 0;
        let timestamp = 0;
        let mediaTime = 0;
        const captured = [];
        Object.defineProperty(input, 'currentTime', { configurable: true, get: () => mediaTime });
        input.requestVideoFrameCallback = next => { callback = next; return ++callbackId; };
        input.cancelVideoFrameCallback = () => { callback = null; };
        simulation.video = input;
        simulation.active = true;
        simulation.limitQuality = cap;
        simulation.setProfile(profile);
        simulation.captureFrame = async (revision, now) => {
          captured.push(now);
          simulation.completeFrame(revision);
        };
        try {
          simulation.scheduleFrame();
          for (let frame = 0; frame < sourceFps * 5; frame++) {
            timestamp = frame * 1000 / sourceFps + (frame % 2 ? -0.1 : 0.1);
            mediaTime = frame / sourceFps;
            const next = callback;
            callback = null;
            if (!next) throw new Error('Frame cadence stopped scheduling');
            next(timestamp, {});
          }
          const steady = captured.filter(now => now >= 1000).length / 4;
          check(Math.abs(steady - expected) <= 1,
            `Scheduler tracks ${expected} FPS with source callback jitter; actual ${steady}`);
          check(simulation.inFlightRevision === null, 'Clock-driven scheduler clears its sole in-flight slot');
          // A final real source frame may still be waiting for its cap deadline.
          timestamp += 1000 / expected;
          const drain = callback;
          callback = null;
          if (!drain) throw new Error('Missing callback for the final source frame');
          drain(timestamp, {});
          const beforeStall = captured.length;
          for (let frame = 0; frame < sourceFps; frame++) {
            timestamp += 1000 / sourceFps;
            const next = callback;
            callback = null;
            if (!next) throw new Error('Stalled camera stopped polling for a new frame');
            next(timestamp, {});
          }
          check(captured.length === beforeStall,
            'A higher profile target never fabricates duplicate frames while the camera has no new image');
          let finishFrame;
          simulation.captureFrame = (revision, now) => {
            captured.push(now);
            return new Promise(resolve => {
              finishFrame = () => { simulation.completeFrame(revision); resolve(); };
            });
          };
          timestamp += 1000 / expected;
          mediaTime += 1 / sourceFps;
          const next = callback;
          callback = null;
          if (!next) throw new Error('Missing frame callback before backpressure test');
          next(timestamp, {});
          simulation.scheduleFrame();
          check(simulation.inFlightRevision !== null && !callback && captured.length === beforeStall + 1,
            'Slow processing retains one in-flight frame instead of duplicating input or queuing extra bitmaps');
          finishFrame();
          check(simulation.inFlightRevision === null && callback,
            'Releasing backpressure resumes cadence without another capture source');
        } finally {
          simulation.stop();
        }
      }
      await service.setCameraEffects({ mode: 'off', limitQuality: true });
      const raw = service.getCameraStream();
      await watch(raw);
      check(!service.cameraProcessor && store.snapshot.settings.limitQuality === true
        && sampleVideo.videoWidth === 1920 && sampleVideo.videoHeight === 1080,
      'Off keeps full-resolution raw/profile behavior despite a saved combined limit');
      check(captures[0].getVideoTracks()[0].getConstraints().frameRate.max === 60
        && raw.getVideoTracks()[0].getSettings().frameRate === captures[0].getVideoTracks()[0].getSettings().frameRate
        && requests.length === 1,
        'Off preserves ordinary profile FPS without another capture');
      transitionLease.release();
      transitionLease = null;
      check(raw.active && captures[0].active, 'Closing a quality preview preserves the active call');
      service.stopCamera();
      await until(() => workers.size === 0, 'Quality and migration fixture leaked a worker');
      check(allCapturedTracksStopped(), 'Quality changes and migration preserve complete capture teardown');
      return checks;
    }
    if (phase === 'transitions') {
      await service.setCameraBackgroundImage(await backgroundImage('transition-fixture.png'));
      await service.setCameraEffects({ mode: 'chroma', backgroundSource: 'color', limitQuality: false });
      transitionLease = await service.acquireCameraPreview();
      await watch(transitionLease.stream);
      await expectVideoPixel(0.9, 0.85, actual => near(actual, [17, 34, 221]),
        'A chroma-first preview begins with the actual keyed replacement');
      check(service.getCameraStream() === null && requests.length === 1, 'Transition fixture starts with one nonpublishing preview lease');
      let previous = 'chroma';
      let processedTrack = transitionLease.stream.getVideoTracks()[0];
      const inspectTransition = async mode => {
        const output = service.getCameraState().stream;
        check(output?.active && service.getCameraState().status === 'ready', `${previous} -> ${mode} produces a ready live stream`);
        await watch(output);
        if (mode === 'off') {
          await expectVideoPixel(0.9, 0.85, actual => near(actual, [0, 255, 0]),
            'Only explicit Off exposes the original green input');
        } else if (mode === 'image') {
          await expectVideoPixel(0.9, 0.85, actual => near(actual, [222, 32, 170]),
            'Recreated real segmentation composites the saved local image');
        } else if (mode === 'blur') {
          await expectVideoPixel(0.07, 0.2, actual => actual[0] > 15 && actual[0] < 240,
            'Recreated real segmentation blurs the synthetic background stripes');
        } else {
          await expectVideoPixel(0.9, 0.85, actual => near(actual, [17, 34, 221]),
            'AI and physical chroma both replace the background, never raw fallback');
        }
        if (mode !== 'off' && previous !== 'off') {
          check(output.getVideoTracks()[0] === processedTrack, 'Model recreation retains the same processed outgoing track');
        }
        processedTrack = output.getVideoTracks()[0];
        check(requests.length === 1 && service.getCameraStream() === null, 'Repeated transitions neither recapture hardware nor publish the preview');
        previous = mode;
      };
      const transition = async mode => {
        console.log(`CAMERA TEST real model transition ${previous} -> ${mode}`);
        await service.setCameraEffects({ mode, backgroundSource: 'color', blurRadius: 24 });
        await inspectTransition(mode);
      };
      const configurationEntered = () => {
        const processor = service.cameraProcessor;
        if (!processor) throw new Error('Missing active effect processor');
        const update = processor.update;
        let entered;
        const ready = new Promise(resolve => { entered = resolve; });
        processor.update = function (snapshot) {
          processor.update = update;
          const result = update.call(this, snapshot);
          entered();
          return result;
        };
        return ready;
      };
      const observed = promise => promise.then(value => ({ value }), error => ({ error }));
      for (const mode of ['blur', 'chroma', 'color', 'chroma', 'image', 'chroma', 'blur', 'chroma', 'color', 'chroma', 'image', 'off', 'chroma', 'blur', 'off']) {
        await transition(mode);
      }
      for (const mode of ['color', 'image', 'blur']) {
        await transition('off');
        await until(() => workers.size === 0, 'Off must dispose the previous segmenter worker');
        await transition('chroma');
        await transition(mode);
      }
      for (const mode of ['color', 'image', 'blur', 'chroma', 'off']) {
        await transition('off');
        await until(() => workers.size === 0, 'Cold-load race requires a fresh worker');
        await transition('chroma');
        const entered = configurationEntered();
        const obsolete = observed(service.setCameraEffects({ mode: 'blur' }));
        await entered;
        check(service.getCameraState().status === 'starting' && !processedTrack.enabled,
          'Initial real model loading synchronously gates the previous processed output');
        const latest = service.setCameraEffects({ mode, backgroundSource: 'color' });
        check((await obsolete).error?.name === 'AbortError', 'A superseded model load is cancelled, not reported as a current model error');
        await latest;
        await inspectTransition(mode);
        check(failures.length === 0, 'Rapid initial-load switching produces no false privacy/model failure');
      }
      await transition('chroma');
      await transition('blur');
      let capturedSnapshot = false;
      window.createImageBitmap = async (source, ...options) => {
        if (source instanceof HTMLVideoElement && !capturedSnapshot) {
          capturedSnapshot = true;
          await new Promise(resolve => { releaseSnapshot = resolve; });
        }
        return await original.bitmap.call(window, source, ...options);
      };
      await until(() => releaseSnapshot, 'Snapshot race must hold a genuine camera frame');
      const processor = service.cameraProcessor;
      const heldRevision = processor.inFlightRevision;
      const next = service.setCameraEffects({ mode: 'color' });
      await until(() => processor.active && processor.revision !== heldRevision,
        'Latest configuration must become ready while the obsolete bitmap remains pending');
      check(!processedTrack.enabled, 'No old or unprocessed frame escapes during a held snapshot');
      releaseSnapshot();
      releaseSnapshot = null;
      await next;
      window.createImageBitmap = original.bitmap;
      await inspectTransition('color');
      check(processor.inFlightRevision === null || processor.inFlightRevision === processor.revision,
        'An obsolete snapshot cannot leave the bounded frame slot stuck on an old revision');

      await transition('off');
      await until(() => workers.size === 0, 'Disposal race requires a fresh model context');
      await transition('chroma');
      const entered = configurationEntered();
      const cancelled = observed(service.setCameraEffects({ mode: 'blur' }));
      await entered;
      service.stopCamera();
      check((await cancelled).error?.name === 'AbortError', 'Stopping during real model initialization cancels the owning request');
      await until(() => workers.size === 0, 'Stopping during model initialization must terminate every worker');
      check(allCapturedTracksStopped() && !service.getCameraState().stream, 'Model-initialization disposal leaves no camera or canvas track');
      transitionLease.release();
      transitionLease = await service.acquireCameraPreview();
      await watch(transitionLease.stream);
      await expectVideoPixel(0.07, 0.2, actual => actual[0] > 15 && actual[0] < 240,
        'A fresh worker recovers the same requested real AI effect after initialization was cancelled');
      check(service.getCameraStream() === null && requests.length === 2 && failures.length === 0,
        'Recovery opens exactly one new preview capture with no publication or false failure');
      transitionLease.release();
      transitionLease = null;
      await until(() => workers.size === 0, 'Repeated model transitions leaked a worker');
      check(allCapturedTracksStopped() && !service.getCameraState().stream, 'Transition preview teardown closes every raw and processed track');
      return checks;
    }

    console.log('CAMERA TEST shared capture and physical chroma');
    control = new CameraEffectsControl();
    container.hidden = true;
    container.innerHTML = control.renderHtml();
    control.attachEvents(container);
    control.activate();
    await tick(80);
    check(requests.length === 0, 'Hidden pre-rendered controls must not open a camera, even when activated');
    check(!container.querySelector('input[type=checkbox], input[type=radio]'), 'Effects use accessible cards, not native radios');
    check(container.querySelectorAll('[data-camera-mode]').length === 5, 'Off and all four effects are visible');
    container.hidden = false;
    await until(() => service.getCameraState().status === 'ready', 'Preview capture failed');
    const preview = container.querySelector('#camera-effects-preview');
    await until(() => preview.srcObject, 'Settings preview was not attached');
    const originalOutput = preview.srcObject;
    const previewBounds = container.querySelector('[data-camera-preview-frame]').getBoundingClientRect();
    check(container.querySelector('[data-camera-preview-toggle]').getAttribute('aria-checked') === 'true',
      'Showing camera controls enables their local preview by default');
    check(previewBounds.height > 100 && previewBounds.top < container.querySelector('[data-camera-mode]').getBoundingClientRect().top,
      'The preview rectangle and visibility switch appear above the effects');
    check(service.getCameraStream() === null, 'A settings-only preview is not published');
    const callStream = await service.startCamera();
    check(callStream === originalOutput && requests.length === 1, 'Joining a call promotes the preview without a second capture');
    control.stopPreview();
    check(callStream.getVideoTracks()[0].readyState === 'live' && captures[0].active, 'Closing preview preserves an active call');
    check(container.querySelector('[data-camera-preview-placeholder]').textContent === t('cameraEffects.previewOff')
      && container.querySelector('[data-camera-preview-frame]').getBoundingClientRect().height === previewBounds.height,
    'Hiding preview retains its layout with a localized placeholder');
    if (phase === 'ownership') {
      console.log('CAMERA TEST ownership, cancellation and pre-processing privacy failures');
      settings.customProfile = { ...settings.customProfile, cameraWidth: 160, cameraHeight: 90, cameraFps: 20 };
      await service.applyQualityPreset('CUSTOM');
      check(callStream.getVideoTracks()[0].getConstraints().frameRate.max === 20,
        'Off quality changes update the outgoing raw clone constraints');
      check(captures[0].getVideoTracks()[0].getConstraints().frameRate.max === 20,
        'Off quality changes update the original hardware track constraints');
      service.setQualityPreset('NORMAL');
      service.stopCamera();
      check(allCapturedTracksStopped(), 'Stopping camera releases original capture and outgoing clone');
      captureMode = 'pending';
      const requestCount = requests.length;
      const first = service.startCamera().then(() => null, error => error);
      await until(() => pendingCapture, 'Pending capture did not start');
      service.stopCamera();
      captureMode = 'normal';
      const second = service.startCamera();
      check(requests.length === requestCount + 1, 'Restart does not overlap a pending hardware request');
      pendingCapture(capture());
      pendingCapture = null;
      check((await first)?.name === 'AbortError', 'Stopped startup cannot join a later camera session');
      await second;
      check(requests.length === requestCount + 2, 'Restart opens hardware only after the obsolete capture closes');
      service.stopCamera();
      captureMode = 'pending';
      const abort = new AbortController();
      const previewStart = service.acquireCameraPreview(abort.signal).then(() => null, error => error);
      await until(() => pendingCapture, 'Pending preview did not start');
      abort.abort();
      pendingCapture(capture());
      pendingCapture = null;
      check((await previewStart)?.name === 'AbortError' && allCapturedTracksStopped(),
        'Closing settings during camera permission/capture releases late tracks');
      captureMode = 'normal';
      const beforeLeases = requests.length;
      const [leaseA, leaseB] = await Promise.all([service.acquireCameraPreview(), service.acquireCameraPreview()]);
      check(leaseA.stream === leaseB.stream && requests.length === beforeLeases + 1, 'Concurrent previews share one hardware capture');
      leaseA.release();
      check(leaseB.stream.active, 'Releasing one lease preserves the other preview');
      leaseB.release();
      check(allCapturedTracksStopped(), 'Releasing the final preview stops all camera tracks');
      await service.startCamera();
      const beforeDevices = requests.length;
      const deviceA = service.setCameraDevice('superseded-camera').then(() => null, error => error);
      const deviceB = service.setCameraDevice('final-camera');
      check((await deviceA)?.name === 'AbortError', 'Superseded device switch is cancelled');
      await deviceB;
      check(requests.length === beforeDevices + 1 && requests.at(-1).video.deviceId.exact === 'final-camera',
        'Rapid device switching opens only the latest requested camera');
      const badColor = await rejected(() => service.setCameraEffects({ mode: 'chroma', keyColor: '#00000' }),
        'Malformed physical key must reject instead of sending raw video');
      check(badColor.code === 'settings' && allCapturedTracksStopped(), 'Invalid effect settings stop the original camera');
      const countBeforeBlocked = requests.length;
      const blocked = await rejected(() => service.startCamera(), 'Failed enable requires conscious Off selection');
      check(blocked.code === 'privacyBlocked' && requests.length === countBeforeBlocked,
        'Retry cannot reveal raw video when the enabled choice could not be saved');
      await service.setCameraEffects({ mode: 'off' });
      await service.startCamera();
      check(service.getCameraStream()?.active, 'Explicit Off selection allows the normal camera again');
      store.update = async () => { throw new CameraEffectError('storage'); };
      const quota = await rejected(() => service.setCameraEffects({ mode: 'blur' }), 'Storage failure must reject');
      check(quota.code === 'storage' && allCapturedTracksStopped(), 'Storage quota failure closes the unprocessed output');
      store.update = original.storeUpdate;
      const blockedAfterQuota = await rejected(() => service.startCamera(), 'Storage failure must not silently preserve Off');
      check(blockedAfterQuota.code === 'privacyBlocked', 'Unsaved privacy intent remains blocked until explicit action');
      const obsoleteOff = service.setCameraEffects({ mode: 'off' }).then(() => null, error => error);
      const invalidLatest = service.setCameraEffects({ mode: 'chroma', keyColor: '#ffffff00' }).then(() => null, error => error);
      check((await obsoleteOff)?.name === 'AbortError', 'An older Off choice is superseded by a newer effect choice');
      check((await invalidLatest)?.code === 'settings', 'Latest invalid effect choice reports its own failure');
      const stillBlocked = await rejected(() => service.startCamera(), 'An obsolete Off save must not clear privacy intent');
      check(stillBlocked.code === 'privacyBlocked', 'Rapid Off-to-effect races require a new conscious Off choice after failure');
      await service.setCameraEffects({ mode: 'off' });
      captureMode = 'denied';
      const beforeDenied = requests.length;
      const denial = await rejected(() => service.startCamera(), 'Permission denial must reject');
      check(denial.code === 'permission' && requests.length === beforeDenied + 1,
        'Camera denial does not cause redundant capture or another-device fallback');
      captureMode = 'constraints';
      const beforeFallback = requests.length;
      await service.startCamera();
      check(requests.length === beforeFallback + 2
        && requests.at(-1).video.deviceId.exact === requests.at(-2).video.deviceId.exact,
        'Exact-to-ideal quality fallback stays on the selected camera');
      captures.at(-1).getVideoTracks()[0].dispatchEvent(new Event('ended'));
      check(allCapturedTracksStopped() && !service.getCameraStream(), 'External device removal tears down outgoing clones');
      await service.startCamera();
      check(container.querySelector('#camera-effects-status').textContent === '',
        'Successful camera recovery clears stale settings errors');
      for (const [selector, attribute] of [
        ['[data-camera-mode="blur"]', 'data-camera-mode'],
        ['[data-camera-background="color"]', 'data-camera-background'],
      ]) {
        const card = container.querySelector(selector);
        const value = card?.getAttribute(attribute);
        if (!card || !value) throw new Error('Missing effect selection fixture');
        card.setAttribute(attribute, 'invalid-control');
        card.click();
        await until(() => !service.getCameraStream()
          && container.querySelector('#camera-effects-status').textContent === t('cameraEffects.errorSettings'),
        'Invalid control value was not reported explicitly');
        check(allCapturedTracksStopped(), 'Invalid effect control fails closed without silently ignoring the choice');
        card.setAttribute(attribute, value);
        await service.startCamera();
      }
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      check(allCapturedTracksStopped() && !service.getCameraStream(), 'Page close releases all camera ownership');
      check(workers.size === 0, 'Off never loads a processing worker');
      return checks;
    }
    const enabling = service.setCameraEffects({ mode: 'chroma' });
    check(callStream.getVideoTracks()[0].readyState === 'ended', 'Enabling a privacy effect immediately blocks the old raw output');
    await enabling;
    let output = service.getCameraStream();
    check(output && output !== captures[0] && output !== callStream, 'Enabled effects return a processed outgoing stream');
    check(requests.length === 1, 'Enabling effects reuses the same hardware capture');
    await watch(output);
    await expectVideoPixel(0.9, 0.85, actual => near(actual, [17, 34, 221]),
      'Physical green screen is replaced with the selected solid color');
    await expectVideoPixel(0.5, 0.5, actual => near(actual, [224, 16, 16]), 'Physical chroma preserves non-green foreground');
    check(pixel(0.9, 0.85)[3] === 255, 'Transmitted canvas video is composited opaque');
    container.querySelector('[data-camera-preview-toggle]').click();
    await until(() => preview.srcObject === output, 'Settings preview does not match the outgoing processed stream');
    check(requests.length === 1, 'Call preview does not create duplicate hardware capture');

    console.log('CAMERA TEST actual loopback transmission');
    peerA = new RTCPeerConnection({ iceServers: [] });
    peerB = new RTCPeerConnection({ iceServers: [] });
    peerA.onicecandidate = event => { if (event.candidate) void peerB.addIceCandidate(event.candidate); };
    peerB.onicecandidate = event => { if (event.candidate) void peerA.addIceCandidate(event.candidate); };
    let remote = null;
    peerB.ontrack = event => { remote = event.streams[0]; };
    sender = peerA.addTrack(output.getVideoTracks()[0], output);
    await peerA.setLocalDescription(await peerA.createOffer());
    await peerB.setRemoteDescription(peerA.localDescription);
    await peerB.setLocalDescription(await peerB.createAnswer());
    await peerA.setRemoteDescription(peerB.localDescription);
    await until(() => remote, 'Loopback peer did not receive the processed camera');
    const remoteVideo = document.createElement('video');
    remoteVideo.muted = true;
    remoteVideo.playsInline = true;
    document.body.append(remoteVideo);
    await watch(remote, remoteVideo);
    await expectVideoPixel(0.9, 0.85, actual => near(actual, [17, 34, 221], 35),
      'Actual WebRTC receiver sees the keyed composite, not the raw camera', remoteVideo);

    console.log(`CAMERA TEST persistent image and ${phase === 'chroma' ? 'physical chroma settings' : 'all AI effects'}`);
    const image = await backgroundImage();
    const stableTrack = output.getVideoTracks()[0];
    const tuning = service.setCameraEffects({ keyTolerance: 27 });
    check(service.getCameraState().status === 'starting' && service.getCameraStream() === output
      && stableTrack.readyState === 'live' && !stableTrack.enabled,
    'Same-track tuning suspends preview readiness, not the validity of an in-flight publication');
    await tuning;
    await service.setCameraBackgroundImage(image);
    await service.setCameraEffects({ backgroundSource: 'image', limitQuality: false });
    check(service.getCameraStream().getVideoTracks()[0] === stableTrack, 'Effect/image changes preserve the processed sender track');
    await watch(service.getCameraStream());
    await expectVideoPixel(0.9, 0.85, actual => near(actual, [222, 32, 170]),
      'Physical chroma can composite onto a chosen image');
    const reloaded = await new CameraEffectsStore().load();
    check(reloaded.image?.name === image.name && reloaded.settings.mode === 'chroma', 'Image and effect choices survive reloading the persistent store');
    check(reloaded.image.blob.size > 0 && reloaded.image.blob.size <= 2 * 1024 * 1024, 'Saved image is bounded');
    check(container.querySelector('#camera-effects-image-name').textContent === image.name
      && !container.querySelector('#camera-effects-image-name b'), 'Custom image names are rendered as text, never HTML');
    if (phase !== 'chroma') {
      await service.setCameraEffects({ mode: 'color', backgroundColor: '#1122dd' });
      await watch(service.getCameraStream());
      await expectVideoPixel(0.9, 0.85, actual => near(actual, [17, 34, 221]),
        'Real local person segmentation replaces the background with a color');
      await service.setCameraEffects({ mode: 'image' });
      await watch(service.getCameraStream());
      await expectVideoPixel(0.9, 0.85, actual => near(actual, [222, 32, 170]),
        'Real local person segmentation replaces the background with the saved image');
      await service.setCameraEffects({ mode: 'blur', blurRadius: 24 });
      await watch(service.getCameraStream());
      await expectVideoPixel(0.07, 0.2, actual => actual[0] > 15 && actual[0] < 240, 'Blur changes sharp background stripes');
    }
    check(requests.length === 1 && service.getCameraStream().getVideoTracks()[0] === stableTrack,
      `${phase === 'chroma' ? 'Physical chroma settings' : 'All four effects'} share capture and reuse one outgoing canvas track`);

    console.log('CAMERA TEST quality, device switching and runtime failures');
    settings.customProfile = { ...settings.customProfile, cameraWidth: 160, cameraHeight: 90, cameraFps: 12 };
    await service.applyQualityPreset('CUSTOM');
    await until(async () => { await watch(service.getCameraStream()); return sampleVideo.videoWidth === 160 && sampleVideo.videoHeight === 90; },
      'Quality changes did not update effect output bounds');
    check(requests.length === 1, 'Quality changes do not reopen hardware');
    await service.setCameraEffects({ mode: 'chroma', backgroundSource: 'color' });
    let frames = 0;
    let frameId;
    const countFrame = () => { frames++; frameId = sampleVideo.requestVideoFrameCallback(countFrame); };
    frameId = sampleVideo.requestVideoFrameCallback(countFrame);
    await tick(1200);
    sampleVideo.cancelVideoFrameCallback(frameId);
    check(frames > 0 && frames <= 16, `Frame rate remains bounded, got ${frames} frames in 1.2 s`);
    const previousRaw = captures[0];
    await service.setCameraDevice('camera-fixture-b');
    output = service.getCameraStream();
    await replaceChain;
    await watch(output);
    await watch(remote, remoteVideo);
    check(requests.length === 2 && previousRaw.getTracks().every(track => track.readyState === 'ended'),
      'Device switch stops the old capture before opening the new one');
    check(requests[1].video.deviceId.exact === 'camera-fixture-b', 'Device selection applies to the actual capture');
    check(sender.track === output.getVideoTracks()[0] && preview.srcObject === output,
      'Replacement hook updates transport and preview: ' + JSON.stringify({
        sender: sender.track?.id, output: output.getVideoTracks()[0].id,
        preview: preview.srcObject?.id, expectedStream: output.id, state: service.getCameraState().status,
      }));
    await expectVideoPixel(0.9, 0.85, actual => near(actual, [17, 34, 221], 35),
      'Replacement continues transmitting the processed video', remoteVideo);
    const worker = [...workers][0];
    worker.dispatchEvent(new ErrorEvent('error', { message: 'Fixture worker failure', cancelable: true }));
    await until(() => workers.size === 0 && service.getCameraState().status === 'error', 'Runtime failure did not terminate processing');
    await replaceChain;
    check(service.getCameraStream() === null && allCapturedTracksStopped() && sender.track === null,
      'A runtime effect failure stops raw capture and outgoing sender, with no unprocessed fallback');
    check(store.snapshot.settings.mode === 'chroma', 'Failure does not silently switch saved effects Off');
    check(container.querySelector('#camera-effects-status').textContent === t('cameraEffects.errorProcessing'),
      'Processing failure has explicit localized feedback');
    peerA.close();
    peerB.close();
    peerA = peerB = sender = null;

    console.log('CAMERA TEST cancellation, privacy and teardown races');
    await service.setCameraEffects({ mode: 'off' });
    captureMode = 'pending';
    const requestCount = requests.length;
    const first = service.startCamera().then(() => null, error => error);
    await until(() => pendingCapture, 'Pending capture did not start');
    service.stopCamera();
    captureMode = 'normal';
    const second = service.startCamera();
    check(requests.length === requestCount + 1, 'A second start waits for the pending hardware request instead of overlapping it');
    pendingCapture(capture());
    pendingCapture = null;
    check((await first)?.name === 'AbortError', 'A stopped camera startup rejects as cancelled');
    await second;
    check(requests.length === requestCount + 2, 'Replacement opens once the obsolete pending capture is closed');
    service.stopCamera();
    await service.setCameraEffects({ mode: 'chroma' });
    captureMode = 'denied';
    const deniedStart = requests.length;
    const denial = await rejected(() => service.startCamera(), 'Permission denial must reject startup');
    check(denial.code === 'permission' && requests.length === deniedStart + 1, 'Permission denial is explicit and does not retry other cameras');
    check(store.snapshot.settings.mode === 'chroma' && !service.getCameraStream(), 'Denied enabled effect cannot expose raw video');
    captureMode = 'constraints';
    await service.setCameraEffects({ mode: 'off' });
    const beforeFallback = requests.length;
    await service.startCamera();
    check(requests.length === beforeFallback + 2, 'Exact resolution may fall back to ideal constraints');
    check(requests.at(-1).video.deviceId.exact === requests.at(-2).video.deviceId.exact,
      'Resolution fallback stays on the explicitly selected camera');
    service.stopCamera();
    await service.setCameraEffects({ mode: 'image' });
    await service.removeCameraBackgroundImage();
    check(store.snapshot.settings.mode === 'color' && !store.snapshot.image, 'Removing an active image explicitly chooses a safe solid replacement');
    await service.setCameraEffects({ mode: 'image' });
    const beforeMissingImage = requests.length;
    const missingImage = await rejected(() => service.startCamera(), 'Image effect without an image must fail closed');
    check(missingImage.code === 'imageMissing' && requests.length === beforeMissingImage, 'Missing image is rejected before hardware capture');
    await service.setCameraEffects({ mode: 'chroma' });
    await service.startCamera();
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    await until(() => workers.size === 0, 'Page close did not terminate effect workers');
    check(allCapturedTracksStopped() && service.getCameraStream() === null, 'Page close tears down all hardware and output tracks');
    check([...callbacks.values()].every(ids => ids.size === 0), 'No requestVideoFrameCallback loops remain after stop');
    check(videos.filter(video => ![sampleVideo, remoteVideo].includes(video)).every(video => !video.srcObject),
      'Hidden processing video elements release their camera streams');
    control.cleanup();
    control = null;
    return checks;
  } finally {
    releaseSnapshot?.();
    transitionLease?.release();
    control?.cleanup();
    service.stopCamera();
    await replaceChain;
    sender = null;
    peerA?.close();
    peerB?.close();
    offError();
    offReplace();
    offStop();
    await until(() => workers.size === 0, 'Camera worker leaked at fixture cleanup');
    clearInterval(sourceTimer);
    sourceStream.getTracks().forEach(track => track.stop());
    for (const stream of captures) stream.getTracks().forEach(track => track.stop());
    for (const video of videos) {
      video.pause();
      video.srcObject = null;
      video.remove();
    }
    container.remove();
    navigator.mediaDevices.getUserMedia = original.gum;
    window.createImageBitmap = original.bitmap;
    if (original.visibility) Object.defineProperty(document, 'visibilityState', original.visibility);
    else Reflect.deleteProperty(document, 'visibilityState');
    store.update = original.storeUpdate;
    window.Worker = original.Worker;
    document.createElement = original.createElement;
    HTMLVideoElement.prototype.requestVideoFrameCallback = original.requestFrame;
    HTMLVideoElement.prototype.cancelVideoFrameCallback = original.cancelFrame;
    settings.selectedCameraId = original.camera;
    settings.customProfile = original.profile;
    service.setQualityPreset(settings.qualityPreset);
  }
}
