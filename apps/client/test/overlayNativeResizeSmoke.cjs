'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const client = path.resolve(__dirname, '..');
const artifacts = path.join(client, 'dist-test', 'overlay-native-resize');

if (!process.versions.electron) {
  if (process.platform !== 'win32') { console.log('Native WM_SIZING fixture requires Windows.'); return; }
  fs.mkdirSync(artifacts, { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(path.join(artifacts, 'electron.log'), 'w');
  const child = spawn(require('electron'), [__filename], { env, cwd: client, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 180000);
  child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
  child.on('exit', code => {
    clearTimeout(timer);
    console.log(fs.readFileSync(path.join(artifacts, 'electron.log'), 'utf8'));
    process.exitCode = code ?? 1;
  });
} else {
  const { app, BrowserWindow, screen, ipcMain } = require('electron');
  app.setPath('userData', path.join(artifacts, 'profile'));
  const placement = require('./fixtures/testDisplay.cjs').installTestDisplay({ app, BrowserWindow, screen });
  assert.ok(placement, 'Native resizing requires the explicit test monitor.');
  if (process.env.MONKY_TEST_SCREEN_AUDIO_BINARY) {
    require('@monky/screen-audio').setWindowResizeAspect = require(process.env.MONKY_TEST_SCREEN_AUDIO_BINARY).setWindowResizeAspect;
  }
  const { OverlayManager } = require(path.join(client, 'dist-electron', 'main', 'overlayManager.js'));
  let owner, manager, exitCode = 0, lastLayout, resizing = false, boundsWrites = 0, layoutRequests = 0, observedBounds = [];
  const evidence = [];
  const evaluate = (window, code) => window.webContents.executeJavaScript(code);
  const until = async (fn, label) => {
    for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(50); }
    throw new Error(`Timed out: ${label}`);
  };
  app.whenReady().then(async () => {
    owner = placement.createWindow({ show: false, width: 700, height: 500 });
    const area = screen.getDisplayMatching(owner.getBounds()).workArea;
    placement.dispose();
    manager = new OverlayManager(owner);
    for (const channel of ['overlay:send-signal', 'ptt:set-config', 'app:set-language', 'client-log:write', 'soundboard:register-shortcuts'])
      ipcMain.handle(channel, () => {});
    ipcMain.handle('soundboard:default-folder', () => app.getPath('userData'));
    ipcMain.handle('soundboard:list-sounds', () => []);
    ipcMain.handle('overlay:layout-cards', (event, layout) => {
      if (resizing) layoutRequests++;
      lastLayout = layout;
      return manager.layoutCards(event.sender.id, layout);
    });
    const config = { mode: 'cameras-only', layout: 'horizontal', position: 'custom', cardOpacity: 0.85,
      focusActiveSpeaker: false, preserveAspectRatio: true, cardSize: { width: 148, height: 83.25 },
      bounds: { x: area.x + 400, y: area.y + 150, width: 638, height: 142 } };
    manager.open(config);
    const window = BrowserWindow.getAllWindows().find(w => w !== owner);
    const setBounds = window.setBounds.bind(window);
    window.setBounds = (...args) => { if (resizing) boundsWrites++; return setBounds(...args); };
    window.prependListener('will-resize', () => { resizing = true; });
    window.on('resize', () => { if (resizing) observedBounds.push(window.getBounds()); });
    window.on('resized', () => { resizing = false; });
    await until(() => !window.webContents.isLoading(), 'overlay load');
    await until(() => evaluate(window, "!!document.querySelector('.overlay-stage-root')"), 'overlay ready');
    const people = Array.from({ length: 4 }, (_, i) => ({
      sessionId: `owned-${i}`, userId: `owned-${i}`, displayName: `Owned ${i}`, screenShareIds: [],
      isCameraOn: true, videoSlotIndex: i, isSpeaking: false, isMuted: true, isDeafened: true,
    }));
    const handle = window.getNativeWindowHandle().readBigUInt64LE().toString();
    for (const variant of [
      { minimalistMode: false, layout: 'horizontal' }, { minimalistMode: false, layout: 'vertical' }, { minimalistMode: false, layout: 'grid' },
      { minimalistMode: true, layout: 'horizontal' }, { minimalistMode: true, layout: 'vertical' }, { minimalistMode: true, layout: 'grid' },
    ]) {
      const mode = `${variant.minimalistMode ? 'minimalist-' : ''}${variant.layout}`;
      manager.setConfig({ ...variant, cardSize: config.cardSize, minimalistCardSize: { width: 240, height: 36 } });
      manager.sendSyncState({ config: manager.getConfig(), channelName: 'Owned native resize', participants: people });
      await delay(500);
      await evaluate(window, `(() => {
        for (const video of document.querySelectorAll('video')) {
          if (video.srcObject) continue;
          const canvas=document.createElement('canvas'); canvas.width=320; canvas.height=180;
          const ctx=canvas.getContext('2d');
          const draw=()=>{ ctx.fillStyle='#287b54';ctx.fillRect(0,0,320,180);
            ctx.fillStyle='#80d5a0';ctx.fillRect(260,Math.floor(performance.now()/12)%160,20,20);
            requestAnimationFrame(draw); };
          draw(); video.srcObject=canvas.captureStream(30); video.play();
        }
        if (!window.__resizeTraceInstalled) {
          window.__resizeTraceInstalled=true;
          const sample=(postLayout=false)=> {
            const root=document.querySelector('.overlay-stage-root');
            if(root.classList.contains('is-resizing')){
              const grid=root.querySelector('.overlay-cards-container');
              const nodes=[...grid.querySelectorAll('.overlay-card:not(.leaving), .overlay-mini-item')];
              const rects=nodes.map(n=>n.getBoundingClientRect());
              const toolbar=root.querySelector('.overlay-stage-topbar');
              (postLayout ? window.__resizeLayouts : window.__resizeFrames).push({
                width:innerWidth,height:innerHeight,
                blankX:grid.clientWidth-(Math.max(...rects.map(r=>r.right))-Math.min(...rects.map(r=>r.left))),
                blankY:grid.clientHeight-(Math.max(...rects.map(r=>r.bottom))-Math.min(...rects.map(r=>r.top))),
                opacity:getComputedStyle(toolbar.firstElementChild).opacity,
                background:getComputedStyle(toolbar).backgroundColor,
                stable:nodes.every((n,i)=>n===window.__resizeNodes[i])
                  && [...grid.querySelectorAll('video')].every((v,i)=>v===window.__resizeVideos[i] && v.readyState>=2 && !v.paused),
              });
            }
          };
          const tick=()=>{sample();requestAnimationFrame(tick);};requestAnimationFrame(tick);
          new ResizeObserver(()=>sample(true)).observe(document.querySelector('.overlay-stage-root'));
        }
      })()`);
      await delay(200);
      for (const edge of [1, 2, 3, 4, 5, 6, 7, 8]) {
        // Start each independent native gesture at the center of the verified display.
        const before = window.getBounds();
        window.setBounds({ ...before, x: area.x + 500, y: area.y + 300 });
        const delta = edge % 2 ? 1 : -1;
        const b = window.getBounds(), width = b.width + ([3, 6].includes(edge) ? 0 : 120 * delta),
          height = b.height + ([1, 2].includes(edge) ? 0 : Math.max(4, Math.round(Math.min(60, 120 / lastLayout.resizeAspect.ratio))) * delta);
        boundsWrites = 0; layoutRequests = 0; observedBounds = [];
        await evaluate(window, `window.__resizeFrames=[]; window.__resizeLayouts=[];
          window.__resizeNodes=[...document.querySelectorAll('.overlay-card:not(.leaving), .overlay-mini-item')];
          window.__resizeVideos=[...document.querySelectorAll('video')];`);
        const left = [1, 4, 7].includes(edge) ? b.x + b.width - width : b.x;
        const top = [3, 4, 5].includes(edge) ? b.y + b.height - height : b.y;
        const physical = screen.dipToScreenRect(window, { x: left, y: top, width, height });
        const physicalArea = screen.dipToScreenRect(window, area);
        let pendingCapture, capturing = false;
        const painted = [];
        const capture = () => {
          if (!resizing || capturing || painted.length >= 6) return;
          capturing = true;
          pendingCapture = window.webContents.capturePage().then(image => {
            const size = image.getSize(), pixels = image.toBitmap();
            const offset = (60 * size.width + 30) * 4;
            painted.push({ green: pixels[offset + 1], alpha: pixels[offset + 3], size });
            fs.writeFileSync(path.join(artifacts, `${mode}-${edge}-${painted.length}.png`), image.toPNG());
          }).finally(() => { capturing = false; });
        };
        const captureTimer = setInterval(capture, 120);
        let result;
        try {
          result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
          path.join(__dirname, 'fixtures', 'resizeWindow.ps1'), '-Handle', handle, '-Edge', String(edge),
          '-Left', String(physical.x), '-Top', String(physical.y), '-Width', String(physical.width), '-Height', String(physical.height),
          '-AreaLeft', String(physicalArea.x), '-AreaTop', String(physicalArea.y),
          '-AreaWidth', String(physicalArea.width), '-AreaHeight', String(physicalArea.height),
          '-Steps', '40'], { timeout: 15000, windowsHide: true });
        } finally { clearInterval(captureTimer); await pendingCapture; }
        const native = JSON.parse(result.stdout);
        const raw = screen.screenToDipRect(window, native);
        const { ratio, extraSize } = lastLayout.resizeAspect;
        assert.ok(Math.abs((raw.width - extraSize.width) / ratio - (raw.height - extraSize.height)) <= 2,
          `Native ${mode}/${edge} violates aspect: ${JSON.stringify({ raw, ratio, extraSize })}`);
        await delay(450);
        const frames = await evaluate(window, 'window.__resizeFrames');
        const layouts = await evaluate(window, 'window.__resizeLayouts');
        fs.writeFileSync(path.join(artifacts, 'last-gesture.json'), JSON.stringify({ mode, edge, frames, layouts, painted, boundsWrites, layoutRequests, native }, null, 2));
        {
          assert.ok(frames.length >= 10, `${mode}/${edge}: must measure frames DURING resizing`);
          assert.equal(boundsWrites, 0, 'No programmatic bounds changes during the native gesture');
          assert.equal(layoutRequests, 0, 'No per-frame layout IPC/persistence while dragging');
          assert.ok(frames.every(f => f.stable), 'Keep playing video elements and participant cards mounted');
          assert.ok(frames.every(f => f.opacity === '1'), 'Toolbar stays visible throughout resizing');
          assert.equal(new Set(frames.map(f => f.background)).size, 1, 'Toolbar background must not oscillate');
          // rAF precedes ResizeObserver; inspect layout after the production observer has fitted cards.
          const settled = layouts;
          const distinctSizes = new Set(native.trace.map(r => `${r.width}:${r.height}`)).size;
          assert.ok(settled.length >= Math.max(1, Math.min(10, distinctSizes - 1)),
            'Measure card layout throughout the native gesture, including minimum-size clamping');
          const maxBlankX = 1.1, maxBlankY = 1.1;
          assert.ok(settled.every(f => Math.abs(f.blankX) <= maxBlankX && Math.abs(f.blankY) <= maxBlankY),
            `${mode}/${edge}: intermediate blank areas: ${JSON.stringify(settled.filter(f => Math.abs(f.blankX) > maxBlankX || Math.abs(f.blankY) > maxBlankY))}`);
          assert.ok(painted.length >= 3 && painted.every(p => p.alpha > 150 && (variant.minimalistMode || p.green > 50)),
            `Captured video pixels disappear: ${JSON.stringify(painted)}`);
          for (let i = 1; i < native.trace.length; i++) {
            assert.ok((native.trace[i].width - native.trace[i - 1].width) * delta >= 0
              && (native.trace[i].height - native.trace[i - 1].height) * delta >= 0, 'Native geometry never jumps backwards');
          }
          const applied = native.trace.map(rect => screen.screenToDipRect(window, rect));
          assert.ok(observedBounds.every(observed => applied.some(expected =>
            observed.x === expected.x && observed.y === expected.y
            && observed.width === expected.width && observed.height === expected.height)),
          'The OS must never apply an intermediate rectangle outside the actual native sizing results');
          for (const rect of applied) {
            assert.equal([1, 4, 7].includes(edge) ? rect.x + rect.width : rect.x,
              [1, 4, 7].includes(edge) ? b.x + b.width : b.x, 'Keep the opposite horizontal anchor');
            assert.equal([1, 3, 4, 5].includes(edge) ? rect.y + rect.height : rect.y,
              [1, 3, 4, 5].includes(edge) ? b.y + b.height : b.y, 'Keep the opposite vertical anchor');
          }
        }
        const measured = await evaluate(window, `(() => {
          const grid=document.querySelector('.overlay-cards-container');
          const rects=Array.from(grid.querySelectorAll('.overlay-card:not(.leaving), .overlay-mini-item'),e=>e.getBoundingClientRect());
          return { width:grid.clientWidth, height:grid.clientHeight,
            usedWidth:Math.max(...rects.map(r=>r.right))-Math.min(...rects.map(r=>r.left)),
            usedHeight:Math.max(...rects.map(r=>r.bottom))-Math.min(...rects.map(r=>r.top)),
            cards:rects.map(r=>({width:r.width,height:r.height})) };
        })()`);
        assert.ok(Math.abs(measured.width - measured.usedWidth) <= 3 && Math.abs(measured.height - measured.usedHeight) <= 3,
          `Blank area after ${mode}/${edge}: ${JSON.stringify(measured)}`);
        evidence.push({ mode, edge, raw, measured, frames, layouts, painted, boundsWrites, layoutRequests, observedBounds, native: native.trace });
      }
    }
    for (const minimalistMode of [false, true]) {
      const key = minimalistMode ? 'minimalistCardSize' : 'cardSize';
      manager.setConfig({ minimalistMode, layout: 'grid', preserveAspectRatio: false, [key]: { width: 300, height: 100 } });
      await delay(450);
      const before = window.getBounds();
      manager.setConfig({ preserveAspectRatio: true });
      await delay(450);
      const corrected = window.getBounds(), expectedHeight = minimalistMode ? 45 : 168.75;
      assert.equal(corrected.x, before.x);
      assert.equal(corrected.y, before.y);
      assert.deepEqual(manager.getConfig()[key], { width: 300, height: expectedHeight });
      assert.equal(corrected.width, 634);
      assert.equal(corrected.height, Math.ceil(expectedHeight * 2 + 64), 'Enabling preservation must immediately wrap corrected cards');
      manager.resetBounds();
      await delay(450);
      const reset = window.getBounds();
      assert.equal(reset.x, before.x);
      assert.equal(reset.y, before.y);
      assert.deepEqual(manager.getConfig()[key], { width: 240, height: minimalistMode ? 36 : 135 });
      assert.equal(reset.width, 514);
      assert.equal(reset.height, minimalistMode ? 136 : 334);
    }
    manager.setConfig({ preserveAspectRatio: false });
    const b = window.getBounds(), width = b.width + 80, height = b.height + 80;
    const physical = screen.dipToScreenRect(window, { ...b, width, height }), physicalArea = screen.dipToScreenRect(window, area);
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, 'fixtures', 'resizeWindow.ps1'), '-Handle', handle, '-Edge', '8',
      '-Left', String(physical.x), '-Top', String(physical.y), '-Width', String(physical.width), '-Height', String(physical.height),
      '-AreaLeft', String(physicalArea.x), '-AreaTop', String(physicalArea.y),
      '-AreaWidth', String(physicalArea.width), '-AreaHeight', String(physicalArea.height)], { timeout: 15000, windowsHide: true });
    const free = screen.screenToDipRect(window, JSON.parse(result.stdout));
    assert.equal(free.width, width);
    assert.equal(free.height, height);
    await delay(500);
    const constrain = require('@monky/screen-audio').setWindowResizeAspect;
    const ownedHandle = owner.getNativeWindowHandle();
    for (const args of [
      [Buffer.alloc(1), 1, 0, 0], [Buffer.alloc(ownedHandle.length), 1, 0, 0],
      [ownedHandle, NaN, 0, 0], [ownedHandle, -1, 0, 0], [ownedHandle, 1, -1, 0],
    ]) assert.throws(() => constrain(...args), /owned|Invalid/i);
    for (let i = 0; i < 20; i++) {
      const owned = new BrowserWindow({ show: false, x: area.x + 100, y: area.y + 100, width: 300, height: 200 });
      const handle = owned.getNativeWindowHandle(), before = owned.getBounds();
      for (const ratio of [16 / 9, 0, 4 / 9, 16 / 9]) {
        constrain(handle, ratio, 28, 58);
        assert.deepEqual(owned.getBounds(), before, 'Installing/updating/removing a constraint cannot resize the window');
      }
      owned.destroy();
      assert.throws(() => constrain(handle, 1, 0, 0), /owned/i, 'A destroyed HWND must be rejected');
    }
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({ success: true, evidence, free }, null, 2));
    console.log('48 continuous native edge/corner gestures (1920 steps), regular and minimalist: <=1.1px intermediate gaps, stable toolbar/cards and anchors, no resize feedback; 20 native cleanup cycles; free sizing preserved.');
  }).catch(error => { console.error(error); exitCode = 1; }).finally(() => {
    manager?.close();
    owner?.destroy();
    app.exit(exitCode);
  });
}
