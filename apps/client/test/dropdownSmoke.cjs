const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `dropdown-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_DROPDOWN_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_DROPDOWN_PROFILE);
  app.on('window-all-closed', () => {});
  let vite;
  let window;
  let timeout;
  const finish = async code => {
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
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'dropdown-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__dropdown__') return next();
            response.setHeader('Content-Type', 'text/html');
            const fonts = ['@fontsource/inter/400.css', '@fontsource/inter/600.css', 'material-symbols/outlined.css']
              .map(name => `<link rel="stylesheet" href="/@fs/${require.resolve(name).replaceAll('\\', '/')}">`).join('');
            response.end(`<!doctype html><html><head>${fonts}<link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css"></head><body></body></html>`);
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
      show: false, width: 1040, height: 800,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('Dropdown smoke timed out'); void finish(1); }, 60_000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__dropdown__`);
    const checks = await window.webContents.executeJavaScript(`(${runDropdownSmoke.toString()})()`, true);
    const evaluate = code => window.webContents.executeJavaScript(code, true);
    const wait = () => new Promise(resolve => setTimeout(resolve, 80));
    const assert = (condition, message) => { if (!condition) throw new Error(message); };

    // Real Chromium input catches OS-picker defaults that synthetic DOM events miss.
    const point = await evaluate(`(() => {
      const select = document.querySelector('#select-video-codec');
      select.dataset.inputs = select.dataset.changes = '0';
      select.addEventListener('input', () => select.dataset.inputs = String(Number(select.dataset.inputs) + 1));
      select.addEventListener('change', () => select.dataset.changes = String(Number(select.dataset.changes) + 1));
      select.scrollIntoView({block:'center'});
      const rect = select.getBoundingClientRect();
      return {x: Math.round(rect.left + 40), y: Math.round(rect.top + rect.height / 2)};
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await wait();
    assert(await evaluate(`document.querySelectorAll('.monky-select-popup:popover-open').length === 1`), 'Trusted pointer opens exactly one custom listbox');
    assert(await evaluate(`!CSS.supports('selector(:open)') || !document.querySelector('#select-video-codec').matches(':open')`), 'Native OS select picker is not open');
    const optionPoint = await evaluate(`(() => {
      const rect = document.querySelectorAll('.monky-select-option')[1].getBoundingClientRect();
      return {x: Math.round(rect.left + 30), y: Math.round(rect.top + rect.height / 2)};
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...optionPoint });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...optionPoint });
    await wait();
    assert(await evaluate(`(() => {
      const select = document.querySelector('#select-video-codec');
      return select.value === 'av1' && select.dataset.inputs === '1' && select.dataset.changes === '1' && document.activeElement === select;
    })()`), 'Trusted pointer commits exactly once and keeps focus on original select');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End' });
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait();
    assert(await evaluate(`document.querySelector('#select-video-codec').value === 'h264' && !document.querySelector('.monky-select-popup')`), 'Trusted keyboard selects without native picker');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait();
    assert(await evaluate(`!!document.querySelector('.monky-select-popup:popover-open') && (!CSS.supports('selector(:open)') || !document.querySelector('#select-video-codec').matches(':open'))`), 'Space opens only the custom listbox');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await wait();
    assert(await evaluate(`!document.querySelector('.monky-select-popup') && document.activeElement.id === 'select-video-codec'`), 'Trusted Escape closes and retains focus');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await wait();
    assert(await evaluate(`!document.querySelector('.monky-select-popup') && document.activeElement.id !== 'select-video-codec'`), 'Trusted Tab dismisses and advances focus');

    await evaluate(`document.querySelector('#select-video-codec').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}))`);
    await evaluate('document.fonts.ready.then(() => true)');
    await wait();
    const screenshot = path.join(clientRoot, 'dist-test', 'dropdown-smoke.png');
    fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
    await evaluate(`import('/core/SelectEnhancer.ts').then(({selectEnhancer}) => selectEnhancer.dispose())`);
    console.log(`Dropdown smoke: ${checks + 7} checks passed (Electron ${process.versions.electron}, Chromium ${process.versions.chrome})`);
    console.log(`Screenshot: ${screenshot}`);
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runDropdownSmoke() {
  const [{ selectEnhancer: service }, { QualityTab }, { AccountTab }, { LogsTab }, { VoiceVideoTab },
    { settingsStore: settings }, { webRtcManager: rtc }, language, devices] = await Promise.all([
    import('/core/SelectEnhancer.ts'), import('/views/settings/tabs/QualityTab.ts'),
    import('/views/settings/tabs/AccountTab.ts'), import('/views/settings/tabs/LogsTab.ts'),
    import('/views/settings/tabs/VoiceVideoTab.ts'), import('/stores/settingsStore.ts'),
    import('/core/WebRtcManager.ts'), import('/i18n/index.ts'), import('/core/AudioDeviceService.ts'),
  ]);
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const wait = () => new Promise(resolve => setTimeout(resolve, 30));
  const popup = () => document.querySelector('.monky-select-popup');
  const rows = () => Array.from(document.querySelectorAll('.monky-select-option'));
  const key = (select, key, modifiers = {}) => select.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }));
  const open = select => {
    select.scrollIntoView({ block: 'nearest' });
    select.focus();
    key(select, 'Enter');
    check(!!popup(), `Custom listbox opens for ${select.id}`);
  };
  const active = select => document.getElementById(select.getAttribute('aria-activedescendant'));
  const originals = {
    save: settings.save, preset: settings.qualityPreset, codec: settings.preferredVideoCodec,
    profile: { ...settings.customProfile }, microphone: settings.selectedMicrophoneId,
    setPreset: rtc.setQualityPreset, reapply: rtc.reapplyCodecPreferences,
  };
  let saves = 0;
  let applies = 0;
  settings.save = () => { saves++; };
  rtc.setQualityPreset = () => { applies++; };
  rtc.reapplyCodecPreferences = async () => {};
  settings.qualityPreset = 'NORMAL';
  language.setLanguage('en');
  service.init();
  service.init();
  const fixture = document.createElement('main');
  fixture.style.cssText = 'padding:28px;max-width:760px;width:100%;overflow:auto;max-height:100vh;flex-shrink:0';
  document.body.append(fixture);
  const quality = new QualityTab();
  fixture.innerHTML = quality.renderHtml();
  quality.attachEvents(fixture);
  const preset = fixture.querySelector('#select-preset');
  let inputs = 0;
  let changes = 0;
  preset.addEventListener('input', () => { inputs++; });
  preset.addEventListener('change', () => { changes++; });
  try {
    open(preset);
    check(popup().parentElement === document.body && popup().matches(':popover-open'), 'Body mounted top-layer popup escapes modal clipping');
    check(document.activeElement === preset && preset.getAttribute('aria-expanded') === 'true', 'Original control retains focus and expanded accessibility state');
    check(popup().getAttribute('role') === 'listbox' && !!popup().getAttribute('aria-label'), 'Listbox uses existing localized accessible label');
    check(rows().every(row => row.getAttribute('role') === 'option') && rows().filter(row => row.getAttribute('aria-selected') === 'true').length === 1, 'Options expose selection semantics');
    check(preset.getAttribute('aria-controls') === popup().id && !!active(preset), 'Combobox owns listbox and active descendant');
    key(preset, 'End');
    check(preset.value === 'NORMAL', 'Navigation previews without changing native value');
    key(preset, 'Enter');
    check(preset.value === 'CUSTOM' && settings.qualityPreset === 'CUSTOM', 'Existing quality handler updates native value and settings');
    check(inputs === 1 && changes === 1 && saves === 1 && applies === 1, 'Input/change and application handler fire exactly once after duplicate init');
    check(fixture.querySelector('#q-select-audioBitrate'), 'Existing CUSTOM handler renders dependent controls');
    check(!popup() && !preset.hasAttribute('aria-controls') && !preset.hasAttribute('aria-expanded'), 'Commit removes popup and temporary accessibility attributes');
    open(preset);
    rows().find(row => row.getAttribute('aria-selected') === 'true').click();
    check(changes === 1, 'Re-selecting unchanged option emits no change');
    open(preset);
    key(preset, 'Home');
    key(preset, 'Escape');
    check(preset.value === 'CUSTOM' && document.activeElement === preset, 'Escape cancels tentative choice and keeps focus');
    open(preset);
    key(preset, 'Tab');
    check(!popup() && preset.value === 'CUSTOM', 'Tab dismisses without committing tentative choice');

    const resolution = fixture.querySelector('#q-res-camera');
    resolution.value = resolution.options[0].value;
    check(!Object.hasOwn(resolution, 'value') && !Object.hasOwn(resolution, 'selectedIndex'), 'Native selection properties are never monkeypatched');
    open(resolution);
    check(rows().find(row => row.getAttribute('aria-selected') === 'true').textContent === resolution.selectedOptions[0].label, 'Direct value assignment is reflected at next open');
    key(resolution, 'Escape');

    const container = document.createElement('section');
    fixture.replaceChildren(container);
    for (const tab of [new AccountTab(), new LogsTab(), new VoiceVideoTab()]) {
      container.innerHTML = tab.renderHtml();
      for (const select of container.querySelectorAll('select')) {
        open(select);
        check(getComputedStyle(select).appearance === 'none' && getComputedStyle(select).backgroundImage !== 'none', `${select.id} uses themed native trigger`);
        check(rows().length === select.options.length, `${select.id} retains all existing options`);
        key(select, 'Escape');
      }
    }
    const mic = container.querySelector('#select-mic');
    settings.selectedMicrophoneId = 'usb';
    devices.populateAudioDeviceSelect(mic, 'input', [{ kind: 'audioinput', deviceId: 'usb', label: 'USB microphone' }]);
    open(mic);
    check(rows().some(row => row.textContent === 'USB microphone' && row.getAttribute('aria-selected') === 'true'), 'Real device population selected value is reflected');
    devices.populateAudioDeviceSelect(mic, 'input', [{ kind: 'audioinput', deviceId: 'usb', label: 'Renamed USB' }, { kind: 'audioinput', deviceId: 'new', label: 'New microphone' }]);
    await wait();
    check(rows().some(row => row.textContent === 'Renamed USB') && rows().some(row => row.textContent === 'New microphone'), 'Open device list observes replacement options and labels');
    devices.populateAudioDeviceSelect(mic, 'input', []);
    await wait();
    check(rows().some(row => row.getAttribute('aria-disabled') === 'true'), 'Disconnected selected device remains visibly disabled');
    key(mic, 'Escape');

    container.innerHTML = `<form><label for="edge">Devices</label>
      <select id="edge"><option value="a">Alpha</option><option value="b" disabled>Blocked</option>
      <optgroup label="Unavailable" disabled><option value="c">Charlie</option></optgroup>
      <optgroup label="Available"><option value="d">Delta</option><option value="e">Echo</option></optgroup>
      <option hidden value="h">Hidden</option><option style="display:none" value="i">Invisible</option>
      <option value="f">Foxtrot</option><option value="g">Golf</option></select><button type="button">Outside</button>
      <select id="multiple" multiple><option>A</option><option>B</option></select>
      <select id="sized" size="3"><option>A</option><option>B</option></select></form>`;
    const edge = container.querySelector('#edge');
    open(edge);
    check(rows().length === 7 && popup().querySelectorAll('[role="group"]').length === 2, 'Hidden options omitted and optgroups retain accessible groups');
    key(edge, 'ArrowDown');
    check(active(edge).textContent === 'Delta', 'Arrow navigation skips disabled option and disabled optgroup');
    key(edge, 'End');
    check(active(edge).textContent === 'Golf', 'End reaches final enabled option');
    key(edge, 'Home');
    check(active(edge).textContent === 'Alpha', 'Home reaches first enabled option');
    key(edge, 'e');
    check(active(edge).textContent === 'Echo', 'Typeahead locates visible enabled label');
    key(edge, 'Enter');
    check(edge.value === 'e', 'Typeahead commits through native selectedIndex');
    open(edge);
    key(edge, 'd');
    key(edge, 'e');
    check(active(edge).textContent === 'Delta', 'Multi-character typeahead keeps the matching label');
    key(edge, 'Escape');
    edge.add(new Option('Foam', 'foam'));
    open(edge);
    key(edge, 'f');
    check(active(edge).textContent === 'Foxtrot', 'Single-character typeahead starts after the current option');
    key(edge, 'f');
    check(active(edge).textContent === 'Foam', 'Repeated-character typeahead cycles matching options');
    key(edge, 'Escape');
    edge.options[edge.options.length - 1].remove();
    open(edge);
    rows().find(row => row.textContent === 'Blocked').click();
    check(!!popup() && edge.value === 'e', 'Clicking disabled choice neither commits nor dismisses');
    container.querySelector('button').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    check(!popup(), 'Outside pointer dismisses');
    open(edge);
    edge.disabled = true;
    await wait();
    check(!popup(), 'Disabling the active control closes popup');
    edge.disabled = false;
    const fieldset = document.createElement('fieldset');
    edge.replaceWith(fieldset);
    fieldset.append(edge);
    open(edge);
    fieldset.disabled = true;
    await wait();
    check(!popup(), 'Inherited fieldset disablement closes popup');
    fieldset.disabled = false;
    open(edge);
    container.hidden = true;
    await wait();
    check(!popup(), 'Hiding an ancestor closes popup');
    container.hidden = false;
    container.querySelector('label').click();
    check(!!popup(), 'Associated label activation opens the custom popup');
    window.dispatchEvent(new Event('blur'));
    check(!popup(), 'Window blur dismisses popup');
    for (const select of container.querySelectorAll('#multiple,#sized')) {
      const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
      select.dispatchEvent(event);
      check(!event.defaultPrevented && !popup(), 'Multiple/size listboxes retain native interactions');
    }
    open(edge);
    edge.value = 'g';
    edge.dispatchEvent(new Event('change', { bubbles: true }));
    check(rows().find(row => row.getAttribute('aria-selected') === 'true').textContent === 'Golf', 'External dispatched change refreshes selectedness');
    edge.form.reset();
    await wait();
    check(edge.value === 'a' && rows().find(row => row.getAttribute('aria-selected') === 'true').textContent === 'Alpha', 'Form reset reflects native default selection');
    edge.remove();
    await wait();
    check(!popup(), 'Unmounting active select tears down popup');
    container.append(edge);
    edge.replaceChildren(...Array.from({ length: 100 }, (_, i) => new Option(`Device ${String(i).padStart(3, '0')} ${'long label '.repeat(7)}`, String(i))));
    edge.style.cssText = 'position:fixed;right:4px;bottom:4px;width:210px';
    open(edge);
    const bounds = popup().getBoundingClientRect();
    check(bounds.top >= 0 && bounds.left >= 0 && bounds.bottom <= innerHeight && bounds.right <= innerWidth, 'Long list stays within bottom/right viewport edges');
    check(bounds.bottom <= edge.getBoundingClientRect().top && popup().scrollHeight > popup().clientHeight, 'Bottom-edge list opens upward with internal scrolling');
    key(edge, 'End');
    check(popup().scrollTop > 0 && active(edge).textContent.startsWith('Device 099'), 'Keyboard scroll keeps final option visible');
    key(edge, 'Escape');
    edge.style.cssText = 'position:fixed;left:4px;top:4px;width:210px';
    open(edge);
    check(popup().getBoundingClientRect().top >= edge.getBoundingClientRect().bottom, 'Top-edge list opens downwards');
    service.dispose();
    check(!popup() && !edge.hasAttribute('aria-activedescendant'), 'Dispose clears popup and accessibility state');
    const afterDispose = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    edge.dispatchEvent(afterDispose);
    check(!afterDispose.defaultPrevented && !popup(), 'Dispose removes delegated handlers');
    for (let index = 0; index < 5; index++) { service.init(); open(edge); service.dispose(); }
    check(!popup(), 'Repeated initialize/open/dispose leaves no popup behind');
    const menuClasses = [
      'server-dropdown-menu', 'floating-context-menu', 'user-context-menu', 'ctx-submenu',
      'settings-action-menu', 'settings-action-submenu',
      'command-dropup', 'bot-parameter-menu', 'emoji-picker',
    ];
    container.replaceChildren(...menuClasses.map(className => {
      const menu = document.createElement('div');
      menu.className = className;
      return menu;
    }));
    const menuStyles = Array.from(container.children).map(menu => getComputedStyle(menu));
    check(menuStyles.every(style => style.borderRadius === '12px' && style.boxShadow.includes('inset')), 'All existing menu surfaces share rounded themed shadows');
    const command = container.querySelector('.command-dropup');
    command.innerHTML = '<div class="command-picker"><div class="command-bot-rail"></div><div class="command-picker-scroll"></div></div>';
    const emoji = container.querySelector('.emoji-picker');
    emoji.innerHTML = '<div class="emoji-picker-grid"><button class="emoji-picker-item">🙂</button></div>';
    const measureLayouts = () => [command, command.firstElementChild, emoji, emoji.firstElementChild].map(element => {
      const style = getComputedStyle(element);
      return [style.display, style.position, style.gridTemplateColumns, style.overflow, style.width, style.height, style.padding];
    });
    const styledLayouts = JSON.stringify(measureLayouts());
    const dropdownStyles = document.querySelector('link[href="/styles/dropdowns.css"]');
    dropdownStyles.disabled = true;
    check(JSON.stringify(measureLayouts()) === styledLayouts, 'Command palette and emoji grid layouts are unchanged by dropdown styling');
    dropdownStyles.disabled = false;
    const hiddenModel = document.createElement('select');
    hiddenModel.hidden = true;
    hiddenModel.add(new Option('Internal model', 'internal'));
    container.append(hiddenModel);
    service.init();
    const hiddenKey = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    hiddenModel.dispatchEvent(hiddenKey);
    hiddenModel.click();
    check(!hiddenKey.defaultPrevented && !popup() && hiddenModel.hidden, 'Hidden native device models are never enhanced or exposed');
    service.dispose();
  } finally {
    service.dispose();
    settings.save = originals.save;
    settings.qualityPreset = originals.preset;
    settings.preferredVideoCodec = originals.codec;
    settings.customProfile = originals.profile;
    settings.selectedMicrophoneId = originals.microphone;
    rtc.setQualityPreset = originals.setPreset;
    rtc.reapplyCodecPreferences = originals.reapply;
  }
  // Keep a real settings fixture for trusted-input checks and the screenshot.
  fixture.innerHTML = quality.renderHtml();
  const codec = fixture.querySelector('#select-video-codec');
  codec.value = 'auto';
  fixture.insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-secondary">Next control</button>');
  service.init();
  return checks;
}
