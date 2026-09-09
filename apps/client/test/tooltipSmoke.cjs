const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

module.exports = { runTooltipSmoke };

if (require.main === module || process.argv[1] === __filename) {
  const clientRoot = path.resolve(__dirname, '..');
  if (!process.versions.electron) {
    const profile = path.join(clientRoot, 'dist-test', `tooltip-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_TOOLTIP_TEST_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], {
      cwd: clientRoot, env, stdio: 'inherit',
    });
    const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    child.once('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
    child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
  } else {
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', process.env.MONKY_TOOLTIP_TEST_PROFILE);
    let vite;
    let window;
    let timeout;
    const finish = async (code) => {
      clearTimeout(timeout);
      if (window && !window.isDestroyed()) window.destroy();
      if (vite) await vite.close();
      app.exit(code);
    };
    app.whenReady().then(async () => {
      const { createServer } = await import('vite');
      vite = await createServer({
        configFile: path.join(clientRoot, 'vite.config.ts'),
        logLevel: 'error',
        optimizeDeps: { noDiscovery: true, entries: [] },
        server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
        plugins: [{
          name: 'tooltip-fixture',
          configureServer(server) {
            server.middlewares.use((request, response, next) => {
              if (request.url !== '/__tooltips__') return next();
              response.setHeader('Content-Type', 'text/html');
              response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body></body></html>');
            });
          },
        }],
      });
      const httpServer = vite.httpServer;
      if (!httpServer) throw new Error('Missing Vite HTTP server');
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => { httpServer.removeListener('error', reject); resolve(); });
      });
      const address = httpServer.address();
      if (!address || typeof address === 'string') throw new Error('Missing Vite listener');
      window = new BrowserWindow({
        show: false, width: 640, height: 440,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      timeout = setTimeout(() => { console.error('Tooltip smoke timed out'); void finish(1); }, 45_000);
      await window.loadURL(`http://127.0.0.1:${address.port}/__tooltips__`);
      const checks = await window.webContents.executeJavaScript(`(${runTooltipSmoke.toString()})()`, true);
      console.log(`Tooltip smoke: ${checks} checks passed`);
      await window.webContents.executeJavaScript(`(${renderTooltipPreview.toString()})()`, true);
      window.showInactive();
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Exercise Chromium's real pointer dispatch over a disabled button, not just DOM events.
      window.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 });
      window.webContents.sendInputEvent({ type: 'mouseMove', x: 315, y: 238 });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const nativeHover = await window.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('#tooltip-preview-button');
        const tip = document.querySelector('.monky-tooltip');
        return !tip.hidden && tip.textContent === button.title && button.getAttribute('title') === '';
      })()`);
      if (!nativeHover) throw new Error('Real Electron pointer hover on disabled button did not show/suppress tooltip');
      const image = await window.webContents.capturePage();
      const filename = path.join(clientRoot, 'dist-test', 'tooltip-preview.png');
      fs.writeFileSync(filename, image.toPNG());
      console.log(`Real disabled hover passed; screenshot: ${filename}`);
      await window.webContents.executeJavaScript('window.disposeTooltipPreview()', true);
      await finish(0);
    }).catch(async (error) => { console.error(error); await finish(1); });
  }
}

async function renderTooltipPreview() {
  const { initTooltips } = await import('/core/TooltipService.ts');
  await import('/styles/fonts.css');
  document.body.innerHTML = `<main style="padding:36px;font-family:var(--font-main)">
    <h2 style="font-size:20px;margin-bottom:12px">Tooltips · Monky</h2>
    <p style="font-size:13px;color:var(--text-secondary)">Compactos, rápidos e acessíveis</p>
    <div style="position:absolute;left:140px;top:195px;width:340px;padding:20px;background:var(--bg-panel);border:1px solid var(--border-color);border-radius:12px">
      <span style="font-size:13px;margin-right:20px">Sala de voz</span>
      <button id="tooltip-preview-button" disabled title="Microfone desativado pelo servidor" style="position:fixed;left:290px;top:216px;width:48px;height:44px;background:var(--bg-tertiary);border:0;border-radius:8px;color:var(--text-primary)">
        <span class="material-symbols-outlined">mic_off</span>
      </button>
    </div>
  </main>`;
  const dispose = initTooltips();
  window.disposeTooltipPreview = () => { dispose(); delete window.disposeTooltipPreview; };
  await document.fonts.ready;
}

async function runTooltipSmoke() {
  const { initTooltips, disposeTooltips } = await import('/core/TooltipService.ts');
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;left:90px;top:100px;width:400px;height:150px';
  root.innerHTML = `<div id="tip-parent" title="Parent">
    <button id="tip-button" title="Microphone" aria-describedby="existing-description"><span id="tip-icon">mic</span></button>
    <button id="tip-disabled" title="Unavailable" disabled>Disabled</button>
    <span id="tip-empty" title=""><i>Empty barrier</i></span>
    <svg id="tip-svg" title="SVG label" width="24" height="24"><circle cx="12" cy="12" r="10"></circle></svg>
    <span id="tip-data" data-tooltip="Custom source">Data</span>
  </div><span id="existing-description">Existing accessible description</span>`;
  document.body.append(root);
  const button = root.querySelector('#tip-button');
  const icon = root.querySelector('#tip-icon');
  const parent = root.querySelector('#tip-parent');
  const tip = () => document.querySelector('.monky-tooltip');
  const over = (element) => element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  const out = (element, relatedTarget = null) => element.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget }));
  const dispose = initTooltips();
  try {
    await wait(250);
    check(initTooltips() === dispose && document.querySelectorAll('.monky-tooltip').length === 1, 'Initialization must be idempotent');
    const started = performance.now();
    over(icon);
    check(tip().hidden && button.getAttribute('title') === '' && parent.getAttribute('title') === '', 'Hover must suppress native titles immediately, including ancestors');
    check(button.title === 'Microphone' && parent.title === 'Parent', '.title reads must keep semantic source during hover');
    await wait(70);
    check(tip().hidden, 'Hover should not appear before intent delay');
    while (tip().hidden && performance.now() - started < 350) await wait(10);
    const elapsed = performance.now() - started;
    check(!tip().hidden && elapsed >= 130 && elapsed < 350, `Hover must appear near 150ms (actual ${elapsed.toFixed(0)}ms): ${tip().outerHTML}; button=${button.outerHTML}; rect=${JSON.stringify(button.getBoundingClientRect())}`);
    check(tip().textContent === 'Microphone', 'Nearest nested title should win');
    check(tip().getAttribute('role') === 'tooltip' && button.getAttribute('aria-describedby').split(' ').includes(tip().id), 'Tooltip must be accessibly described');
    check(button.getAttribute('aria-describedby').includes('existing-description'), 'Existing descriptions must survive');
    button.title = '<img src=x onerror="window.tooltipInjected=true"> & "plain text"';
    check(tip().textContent === button.title && !tip().querySelector('img') && !window.tooltipInjected, 'Tooltip labels must be text-only, never HTML');
    button.setAttribute('title', 'Attribute update');
    await wait();
    check(tip().textContent === 'Attribute update' && button.title === 'Attribute update' && button.getAttribute('title') === '', 'Dynamic setAttribute must update and stay suppressed');
    button.setAttribute('title', 'Immediate read');
    check(button.title === 'Immediate read' && button.getAttribute('title') === '', 'Synchronous .title read after setAttribute must not leak native title');
    await wait();
    check(tip().textContent === 'Immediate read', 'Immediate read must not consume the UI update');
    button.setAttribute('title', '');
    await wait();
    check(tip().hidden && button.title === '', 'Explicit empty title must clear tooltip');
    button.title = 'Restored dynamically';
    await wait(180);
    check(!tip().hidden && tip().textContent === button.title, 'Dynamic title should revive hovered tooltip');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check(tip().hidden && button.getAttribute('title') === '', 'Escape must dismiss without re-enabling native duplicate');
    button.title = 'No resurrection';
    await wait(180);
    check(tip().hidden, 'Mutations after Escape must not resurrect a dismissed tooltip');
    out(icon);
    check(button.getAttribute('title') === 'No resurrection' && parent.getAttribute('title') === 'Parent', 'Pointer exit must restore native source attributes');
    check(button.getAttribute('aria-describedby') === 'existing-description', 'Dismissal must remove only its own description');
    over(icon);
    await wait(40);
    out(icon);
    await wait(180);
    check(tip().hidden, 'Leaving during delay must cancel tooltip');
    const disabled = root.querySelector('#tip-disabled');
    over(disabled);
    await wait(180);
    check(!tip().hidden && tip().textContent === 'Unavailable', 'Disabled controls must have delegated tooltips');
    out(disabled, icon);
    over(icon);
    await wait(180);
    check(tip().textContent === button.title, 'Transitions between nested siblings must switch labels');
    out(icon);
    over(root.querySelector('#tip-empty i'));
    await wait(180);
    check(tip().hidden, 'Empty title must block ancestor inheritance');
    out(root.querySelector('#tip-empty i'));
    const svg = root.querySelector('#tip-svg');
    over(svg.querySelector('circle'));
    await wait(180);
    check(tip().textContent === 'SVG label' && svg.getAttribute('title') === '', 'SVG title attributes must work through nested shapes');
    out(svg);
    const data = root.querySelector('#tip-data');
    over(data);
    await wait(180);
    check(tip().textContent === 'Custom source', 'Explicit data-tooltip source must be supported');
    data.dataset.tooltip = 'Updated custom source';
    await wait();
    check(tip().textContent === 'Updated custom source', 'data-tooltip updates must refresh');
    out(data);
    const ping = document.createElement('div');
    ping.className = 'stage-ping-badge good';
    ping.tabIndex = 0;
    ping.dataset.tooltipSource = 'tooltip-ping-source';
    ping.innerHTML = '<span class="ping-dot"></span><span>42 ms</span><div id="tooltip-ping-source" hidden><b>Latency:</b> 42 ms<br><b>Quality:</b> Excellent<br><span>Direct connection</span></div>';
    root.append(ping);
    over(ping.querySelector('.ping-dot'));
    await wait(180);
    check(!tip().hidden && tip().textContent === 'Latency: 42 ms\nQuality: Excellent\nDirect connection', 'Legacy latency tooltip must share global timing, appearance, and preserve readable line breaks');
    check(!tip().querySelector('b, br') && !ping.querySelector('.ping-tooltip'), 'Migrated rich source must render text-only without the old CSS tooltip');
    const pingSource = ping.querySelector('#tooltip-ping-source');
    check(getComputedStyle(pingSource).display === 'none', 'Tooltip source must remain hidden, not duplicate on hover');
    pingSource.innerHTML = '<b>SFU latency:</b> 58 ms<br>Centralized connection';
    await wait();
    check(tip().textContent === 'SFU latency: 58 ms\nCentralized connection', 'Existing periodic ping innerHTML updates must refresh active tooltip');
    pingSource.firstElementChild.firstChild.data = 'Updated latency:';
    await wait();
    check(tip().textContent.startsWith('Updated latency:'), 'Character-data updates must refresh referenced sources');
    pingSource.id = 'tooltip-ping-moved';
    await wait();
    check(tip().hidden, 'Renaming a referenced source must hide stale content');
    ping.dataset.tooltipSource = 'tooltip-ping-moved';
    await wait(180);
    check(!tip().hidden && tip().textContent.startsWith('Updated latency:'), 'Changing source reference must resolve the new label');
    out(ping);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    ping.focus();
    if (!document.hasFocus()) ping.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    check(!tip().hidden && ping.getAttribute('aria-describedby').includes(tip().id), 'Latency badge must expose its tooltip immediately to keyboard users');
    ping.blur();
    if (!document.hasFocus()) ping.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    ping.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    button.focus();
    // Hidden windows have an activeElement but no OS focus/focusin dispatch.
    if (!document.hasFocus()) button.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    check(!tip().hidden && tip().textContent === button.title, `Keyboard focus must show immediately, without mouse delay: active=${document.activeElement?.id}; ${tip().outerHTML}`);
    button.removeAttribute('title');
    await wait();
    check(button.title === '', 'Removing active title must preserve absence');
    button.blur();
    if (!document.hasFocus()) button.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    check(!button.hasAttribute('title'), 'Removed title must not be restored after focus leaves');
    button.title = 'Scroll tooltip';
    over(icon);
    await wait(180);
    root.dispatchEvent(new Event('scroll'));
    check(tip().hidden, 'Scrolling a nested viewport must dismiss stale positioning');
    out(icon);
    over(icon);
    await wait(180);
    root.hidden = true;
    await wait();
    check(tip().hidden, 'Hiding an ancestor must dismiss the tooltip');
    root.hidden = false;
    out(icon);
    const menu = document.createElement('div');
    menu.style.cssText = 'position:fixed;right:0;top:0;overflow:hidden;width:28px;height:28px';
    menu.innerHTML = '<button role="menuitem" title="A longer menu command near the viewport edge" style="width:28px;height:28px">…</button>';
    document.body.append(menu);
    const menuItem = menu.firstElementChild;
    over(menuItem);
    await wait(180);
    const rect = tip().getBoundingClientRect();
    check(!tip().hidden && tip().dataset.placement === 'bottom', 'Top-edge menu tooltip must flip below');
    check(rect.left >= 7 && rect.right <= innerWidth - 7 && rect.top >= 7 && rect.bottom <= innerHeight - 7, 'Tooltip must stay within viewport, not clipped by overflow parent');
    menuItem.title = 'Very long tooltip '.repeat(300);
    await wait();
    check(tip().getBoundingClientRect().bottom <= innerHeight - 7, 'Very long text must remain bounded');
    menu.remove();
    await wait();
    check(tip().hidden && menuItem.getAttribute('title') === menuItem.title, 'Unmounted menus must hide and restore titles');
    over(icon);
    await wait(180);
    window.dispatchEvent(new Event('resize'));
    check(tip().hidden, 'Resize must dismiss positioning');
    out(icon);
    over(icon);
    await wait(180);
    window.dispatchEvent(new Event('blur'));
    check(tip().hidden && button.getAttribute('title') === button.title, 'Window blur must release active titles');
    over(icon);
    button.setAttribute('title', 'Pending title at disposal');
    disposeTooltips();
    check(!tip() && button.getAttribute('title') === 'Pending title at disposal', 'Disposal must flush pending title mutations and remove tooltip');
    check(!Object.hasOwn(button, 'title'), 'Disposal must restore native property descriptor');
    over(icon);
    await wait(180);
    check(!tip(), 'Disposed listeners and timers must not recreate tooltip');
    initTooltips();
    check(document.querySelectorAll('.monky-tooltip').length === 1, 'Reinitialization after disposal must work');
    disposeTooltips();
    return checks;
  } finally {
    disposeTooltips();
    root.remove();
    delete window.tooltipInjected;
  }
}
