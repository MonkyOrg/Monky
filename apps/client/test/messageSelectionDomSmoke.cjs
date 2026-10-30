const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dispatchKey } = require('./fixtures/nativeKeyboard.cjs');

const clientRoot = path.resolve(__dirname, '..');
const output = path.join(clientRoot, 'dist-test');

if (!process.versions.electron) {
  const profile = path.join(output, `message-selection-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_SELECTION_PROFILE: profile, MONKY_HOME: path.join(profile, 'monky-home') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, Menu, nativeImage } = require('electron');
  app.setPath('userData', process.env.MONKY_SELECTION_PROFILE);
  app.on('window-all-closed', () => {});
  let vite;
  let window;
  let timeout;
  let finishing = false;
  const finish = async code => {
    if (finishing) return;
    finishing = true;
    clearTimeout(timeout);
    const teardownTimeout = setTimeout(() => { console.error('Message selection teardown timed out'); app.exit(1); }, 10_000);
    if (window && !window.isDestroyed()) {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
      window.destroy();
    }
    if (vite) await vite.close();
    clearTimeout(teardownTimeout);
    app.exit(code);
  };
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // A real decodable image, so media rows lay out and the lightbox could open if a click leaked through.
    const pixels = Buffer.alloc(64 * 48 * 4, 0x80);
    const media = nativeImage.createFromBitmap(pixels, { width: 64, height: 48, scaleFactor: 1 }).toPNG();
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      cacheDir: path.join(process.env.MONKY_SELECTION_PROFILE, 'vite-cache'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'message-selection-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url?.startsWith('/attachments/')) {
              response.setHeader('Content-Type', 'image/png');
              response.end(media);
              return;
            }
            if (request.url !== '/__message_selection_smoke__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"><link rel="stylesheet" href="/styles/dropdowns.css"><link rel="stylesheet" href="/styles/footerControls.css"><link rel="stylesheet" href="/styles/messageEditing.css"><link rel="stylesheet" href="/styles/community.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    const server = vite.httpServer;
    if (!server) throw new Error('Missing selection fixture HTTP server');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing selection fixture address');
    window = new BrowserWindow({
      show: false, width: 1100, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: !['data:', 'blob:'].includes(url.protocol) && url.hostname !== '127.0.0.1' });
    });
    timeout = setTimeout(() => { console.error('Message selection smoke timed out'); void finish(1); }, 120_000);
    await window.loadURL(`http://127.0.0.1:${address.port}/__message_selection_smoke__`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    window.webContents.focus();
    const checks = await runSmoke(window);
    console.log(`Message selection DOM smoke: ${checks} checks passed (native pointer drag with edge scroll, keyboard, bar actions, carousel downloads)`);
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runSmoke(window) {
  const evaluate = source => window.webContents.executeJavaScript(source, true);
  const fixture = async source => {
    const result = await evaluate(`(async () => {
      try { return {value:await eval(${JSON.stringify(`window.messageSelectionFixture.${source}`)})}; }
      catch(error) { return {error:error.stack ?? String(error)}; }
    })()`);
    if (result.error) throw new Error(result.error);
    return result.value;
  };
  const mouse = params => window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', params);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  let checks = 0;
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    checks++;
  };
  const until = async (source, message, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await fixture(source);
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`${message} (waited for ${source})`);
      await wait(20);
    }
  };
  const state = () => fixture('state()');
  const point = selector => fixture(`point(${JSON.stringify(selector)})`);
  const click = async (target, button = 'left') => {
    const at = typeof target === 'string' ? await point(target) : target;
    const pressed = button === 'left' ? 1 : 2;
    await mouse({ type: 'mouseMoved', ...at });
    await mouse({ type: 'mousePressed', ...at, button, buttons: pressed, clickCount: 1 });
    await mouse({ type: 'mouseReleased', ...at, button, buttons: 0, clickCount: 1 });
    await fixture('settle()');
  };
  const row = id => `[data-message-id="${id}"].chat-message-row`;
  const key = async (name, code, virtualKey, text) => {
    window.webContents.focus();
    await dispatchKey(window, name, code, virtualKey, 0, text);
    await fixture('settle()');
  };
  const escape = () => key('Escape', 'Escape', 27);
  const enterSelection = async id => {
    await fixture('clearTextSelection()');
    await click(`${row(id)} .chat-message-text`, 'right');
    const item = await until('menuItemPoint("Select messages")', 'The message context menu offers "Select messages"');
    await click(item);
    await until('state().then(value => value.active && !value.menuOpen)', 'Selection mode starts from the context menu');
  };
  const selectedIds = async () => (await state()).selected;
  const action = async name => (await state()).actions.find(entry => entry.id === name);
  const sameIds = (actual, expected) => actual.join() === expected.join();
  const barRemoved = async label => {
    await until('state().then(value => value.barElements === 0)', `The action bar leaves the DOM after ${label}`);
    checks++;
  };

  await evaluate(`(${installFixture.toString()})()`);
  try {
    await fixture('prepare()');

    // Forwarded badge.
    let value = await state();
    check(value.forwardedBadge === 'Forwarded from #general · Elsewhere',
      `A forwarded message names its source above the content: ${JSON.stringify(value.forwardedBadge)}`);
    check(value.forwardedBadgeCount === 1, 'Only the forwarded message carries the forwarded badge');

    // Carousel downloads, before selecting anything.
    check(value.carouselSlides === 2, `Two images in one message share a carousel: ${value.carouselSlides}`);
    await fixture('clickCarouselDownload(0)');
    let dialog = await until('dialogState()', 'Downloading a carousel slide asks which files to save');
    check(sameIds(dialog.choices, ['current', 'folder', 'zip']) && dialog.pressed === 'current',
      `The download dialog offers the current file, a folder or a ZIP, preselecting the current one: ${JSON.stringify(dialog)}`);
    await fixture('chooseAndConfirm("zip")');
    await until('state().then(value => value.batchDownloads.length === 1 && !value.dialogOpen)', 'Confirming the ZIP choice saves the batch');
    value = await state();
    const [zip] = value.batchDownloads;
    check(zip.mode === 'zip' && sameIds(zip.files.map(file => file.fileName), ['gallery-1.png', 'gallery-2.png'])
      && zip.files.every(file => file.url.endsWith(`/attachments/${file.fileName}`)) && zip.archiveName.includes('chat')
      && value.singleDownloads.length === 0,
    `The ZIP choice sends both carousel files to window.api.downloadFiles: ${JSON.stringify(value)}`);
    await fixture('clickCarouselDownload(1)');
    dialog = await until('dialogState()', 'The dialog opens again for the second slide');
    await fixture('chooseAndConfirm("current")');
    await until('state().then(value => value.singleDownloads.length === 1 && !value.dialogOpen)', 'Confirming "Only this one" saves one file');
    value = await state();
    check(value.singleDownloads[0].fileName === 'gallery-2.png' && value.batchDownloads.length === 1,
      `"Only this one" downloads exactly the slide that was clicked through window.api.downloadFile: ${JSON.stringify(value.singleDownloads)}`);
    await fixture('clickCarouselDownload(0)');
    await until('dialogState()', 'The dialog opens for a folder download');
    await fixture('chooseAndConfirm("folder")');
    await until('state().then(value => value.batchDownloads.length === 2 && !value.dialogOpen)', 'Confirming the folder choice saves the batch');
    check((await state()).batchDownloads[1].mode === 'folder', 'The folder choice keeps the files separate');
    await fixture('openGalleryLightbox()');
    await until('state().then(value => value.lightboxOpen)', 'A carousel image opens the media viewer outside selection mode');
    await fixture('clickLightboxDownload()');
    dialog = await until('dialogState()', 'The viewer download button also offers the whole carousel');
    check(sameIds(dialog.choices, ['current', 'folder', 'zip']), 'The viewer offers the same three choices');
    await fixture('chooseAndConfirm("zip")');
    await until('state().then(value => value.batchDownloads.length === 3 && !value.dialogOpen)', 'The viewer ZIP choice saves the batch');
    check((await state()).batchDownloads[2].files.length === 2, 'The viewer batch holds both carousel files');
    await fixture('closeLightbox()');
    await until('state().then(value => !value.lightboxOpen)', 'The viewer closes');
    await fixture('resetCalls()');

    // Entering from the context menu, toggling with clicks, and Escape.
    value = await state();
    check(!value.active && value.composerVisible && !value.bar, 'The composer is shown while not selecting');
    // Reading the end of the conversation: every row gains room, yet the last message stays in view.
    const endInView = id => evaluate(`(() => {
      const feed = document.querySelector('#chat-messages-feed').getBoundingClientRect();
      const box = document.querySelector('.chat-message-row[data-message-id="${id}"]').getBoundingClientRect();
      return box.top < feed.bottom && box.bottom <= feed.bottom + 1;
    })()`);
    await evaluate(`(() => { const feed = document.querySelector('#chat-messages-feed'); feed.scrollTop = feed.scrollHeight; })()`);
    await fixture('settle()');
    check(await endInView('gallery'), 'The last message is in view before selecting');
    await enterSelection('gallery');
    await wait(700);
    check(await endInView('gallery'), 'Selecting the last message keeps it in view while every row gains room');
    await escape();
    await barRemoved('leaving a selection started at the end');
    await wait(700);
    check(await endInView('gallery'), 'Leaving the selection keeps the end of the conversation in view');
    await enterSelection('m59');
    value = await state();
    check(value.feedRole === 'listbox' && value.multiselectable === 'true' && value.optionRows === value.rows,
      `Selection mode exposes the feed as a multi-select listbox of options: ${JSON.stringify(value)}`);
    check(sameIds(value.selected, ['m59']) && value.ariaSelected.join() === 'm59',
      'The message whose menu started the selection is selected, with aria-selected');
    check(value.bar && value.hostActive && !value.composerVisible, 'The action bar replaces the composer');
    check(value.count === '1 selected', `The bar counts the selection: ${value.count}`);
    check(sameIds(value.actions.map(entry => entry.id), ['reply', 'forward', 'copy', 'download', 'delete']),
      'The bar offers reply, forward, copy, download and delete in order');
    await click(row('m58'));
    value = await state();
    check(sameIds(value.selected, ['m58', 'm59']) && value.count === '2 selected', 'A click on another row adds it');
    await click(row('m59'));
    value = await state();
    check(sameIds(value.selected, ['m58']) && value.count === '1 selected', 'A second click on a selected row removes it');

    await click(`${row('link')} a.md-link`);
    await click(`${row('photo')} img.chat-attachment-image`);
    value = await state();
    check(sameIds(value.selected, ['m58', 'link', 'photo']), 'Real clicks on a link or an image select their messages');
    check(value.openExternal.length === 0 && !value.lightboxOpen, 'Neither the link nor the media viewer opens while selecting');
    await fixture('syntheticInnerClicks()');
    value = await state();
    check(value.openExternal.length === 0 && !value.lightboxOpen && sameIds(value.selected, ['m58', 'link', 'photo']),
      'Clicks dispatched straight on the link and image are swallowed without changing the selection');
    await click(`${row('m57')} .chat-message-text`, 'right');
    check(!(await state()).menuOpen, 'Right-clicking a message while selecting does not open its menu');

    await fixture('focusRow("m56")');
    await key(' ', 'Space', 32, ' ');
    check((await selectedIds()).includes('m56'), 'Space on a focused row selects it');
    await key('Enter', 'Enter', 13, '\r');
    check(!(await selectedIds()).includes('m56'), 'Enter on a focused selected row deselects it');

    await escape();
    value = await state();
    check(!value.active && !value.feedRole && !value.multiselectable && value.optionRows === 0 && value.ariaSelected.length === 0
      && value.selectedClassRows === 0, `Escape leaves selection mode and clears row roles and classes: ${JSON.stringify(value)}`);
    check(!value.bar && !value.hostActive && value.composerVisible, 'Escape restores the composer');
    await barRemoved('Escape');

    // Drag selection, from a scrolled-to-top feed.
    await enterSelection('m59');
    await click(row('m59'));
    value = await state();
    check(value.selected.length === 0 && value.count === 'Click messages, or hold and drag to select several'
      && value.actions.every(entry => entry.disabled && entry.title === 'Select at least one message.'),
    `With nothing selected the bar shows a hint and disables every action: ${JSON.stringify(value.actions)}`);
    await fixture('scrollFeedTop()');
    const m1 = await point(row('m1'));
    const m4 = await point(row('m4'));
    await mouse({ type: 'mouseMoved', ...m1 });
    await mouse({ type: 'mousePressed', ...m1, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 6; step++) {
      await mouse({ type: 'mouseMoved', x: m1.x, y: m1.y + (m4.y - m1.y) * step / 6, button: 'left', buttons: 1 });
    }
    await fixture('settle()');
    value = await state();
    check(value.dragging && sameIds(value.selected, ['m1', 'm2', 'm3', 'm4']),
      `Dragging across rows selects the contiguous range while showing the drag state: ${JSON.stringify(value.selected)}`);
    await mouse({ type: 'mouseReleased', ...m4, button: 'left', buttons: 0, clickCount: 1 });
    await fixture('settle()');
    value = await state();
    check(!value.dragging && sameIds(value.selected, ['m1', 'm2', 'm3', 'm4']), 'Releasing keeps the range and ends the drag');

    const m2 = await point(row('m2'));
    const m3 = await point(row('m3'));
    await mouse({ type: 'mouseMoved', ...m2 });
    await mouse({ type: 'mousePressed', ...m2, button: 'left', buttons: 1, clickCount: 1 });
    await mouse({ type: 'mouseMoved', x: m2.x, y: (m2.y + m3.y) / 2, button: 'left', buttons: 1 });
    await mouse({ type: 'mouseMoved', ...m3, button: 'left', buttons: 1 });
    await mouse({ type: 'mouseReleased', ...m3, button: 'left', buttons: 0, clickCount: 1 });
    await fixture('settle()');
    check(sameIds(await selectedIds(), ['m1', 'm4']), 'A drag that starts on a selected row deselects the range');

    const m6 = await point(row('m6'));
    await mouse({ type: 'mouseMoved', ...m6 });
    await mouse({ type: 'mousePressed', ...m6, button: 'left', buttons: 1, clickCount: 1 });
    await wait(400);
    value = await state();
    check(value.dragging && value.selected.includes('m6'), 'Holding the button on a row starts a drag selection without moving');
    await mouse({ type: 'mouseReleased', ...m6, button: 'left', buttons: 0, clickCount: 1 });
    await fixture('settle()');
    value = await state();
    check(!value.dragging && sameIds(value.selected, ['m1', 'm4', 'm6']), 'Releasing a held drag does not toggle the row back');

    await fixture('clearSelectionState()');
    const feed = await fixture('feedRect()');
    const m8 = await point(row('m8'));
    const lastVisible = await fixture('lastVisibleIndex()');
    await mouse({ type: 'mouseMoved', ...m8 });
    await mouse({ type: 'mousePressed', ...m8, button: 'left', buttons: 1, clickCount: 1 });
    await mouse({ type: 'mouseMoved', x: m8.x, y: m8.y + 20, button: 'left', buttons: 1 });
    await mouse({ type: 'mouseMoved', x: m8.x, y: feed.bottom - 4, button: 'left', buttons: 1 });
    const startScroll = (await state()).scrollTop;
    await fixture('frames(8)');
    const midway = await state();
    await fixture('frames(8)');
    const later = await state();
    await mouse({ type: 'mouseMoved', x: m8.x, y: (feed.top + feed.bottom) / 2, button: 'left', buttons: 1 });
    await fixture('settle()');
    const parked = (await state()).scrollTop;
    await fixture('frames(4)');
    const stopped = (await state()).scrollTop;
    await mouse({ type: 'mouseReleased', x: m8.x, y: (feed.top + feed.bottom) / 2, button: 'left', buttons: 0, clickCount: 1 });
    await fixture('settle()');
    check(midway.scrollTop > startScroll && later.scrollTop > midway.scrollTop,
      `Holding the pointer near the bottom edge scrolls the feed over animation frames: ${startScroll} -> ${midway.scrollTop} -> ${later.scrollTop}`);
    check(parked === stopped, `Moving back into the middle stops the edge scroll: ${parked} -> ${stopped}`);
    const rangeEnd = Math.max(...later.selected.map(id => Number(id.slice(1))));
    check(later.selected[0] === 'm8' && rangeEnd > lastVisible
      && sameIds(later.selected, Array.from({ length: rangeEnd - 7 }, (_, index) => `m${index + 8}`)),
    `The drag selection extends contiguously past the rows that were visible before scrolling (last visible m${lastVisible}): ${later.selected.join()}`);
    await escape();
    await barRemoved('the drag scenarios');

    // Bar availability: delete (another user's message, no MANAGE_SERVER), download (no files), forward (sticker).
    await enterSelection('own-text');
    let entry = await action('delete');
    check(!entry.disabled && !(await action('forward')).disabled && !(await action('copy')).disabled && !(await action('reply')).disabled,
      'Every action applicable to your own text message is enabled');
    entry = await action('download');
    check(entry.disabled && entry.title === 'The selected messages have no files.', `Download is unavailable without files: ${JSON.stringify(entry)}`);
    await click(row('other-text'));
    entry = await action('delete');
    check(entry.disabled && entry.title === 'You can only delete your own messages.',
      `Delete is unavailable with someone else's message and no MANAGE_SERVER: ${JSON.stringify(entry)}`);
    const beforeDisabled = (await state()).requests.length;
    await click('.message-selection-bar [data-selection-action="delete"]');
    check((await state()).requests.length === beforeDisabled && !(await state()).dialogOpen, 'A disabled action does nothing when clicked');
    await click(row('other-text'));
    await click(row('sticker'));
    entry = await action('forward');
    check(entry.disabled && entry.title === 'Polls, stickers and bot responses cannot be forwarded.',
      `Forward is unavailable for a sticker: ${JSON.stringify({ entry, selected: await selectedIds() })}`);
    await click(row('sticker'));
    await click(row('photo'));
    check(!(await action('download')).disabled && !(await action('forward')).disabled, 'A message with an image can be downloaded and forwarded');

    // Forward opens its picker above the selection; Escape closes only the picker.
    await click('.message-selection-bar [data-selection-action="forward"]');
    value = await until('state().then(value => value.forwardDestinations.length ? value : null)', 'Forward opens the destination picker');
    check(sameIds(value.forwardDestinations, ['other', 'third']) && value.active,
      `The picker lists the server's other channels, never the one the messages are in: ${value.forwardDestinations}`);
    const layout = await evaluate(`(() => {
      const input = document.querySelector('.forward-modal .forward-search .input-field');
      const field = input.getBoundingClientRect();
      const icon = document.querySelector('.forward-modal .forward-search > .material-symbols-outlined').getBoundingClientRect();
      const item = document.querySelector('.forward-modal .forward-destination');
      const box = item.getBoundingClientRect();
      const visual = item.querySelector('.forward-destination-icon').getBoundingClientRect();
      const row = document.querySelector('.chat-message-row.is-selected');
      const avatar = row.querySelector('.chat-author-avatar').getBoundingClientRect();
      return {
        iconInside: icon.left >= field.left && icon.right <= field.right && icon.top >= field.top && icon.bottom <= field.bottom,
        textAfterIcon: field.left + parseFloat(getComputedStyle(input).paddingLeft) >= icon.right,
        itemInset: visual.left - box.left, itemRadius: parseFloat(getComputedStyle(item).borderTopLeftRadius),
        rowInset: avatar.left - row.getBoundingClientRect().left, rowRadius: parseFloat(getComputedStyle(row).borderTopLeftRadius),
      };
    })()`);
    check(layout.iconInside && layout.textAfterIcon, `The search icon sits inside the field, before its text: ${JSON.stringify(layout)}`);
    check(layout.itemInset >= 10 && layout.itemRadius >= 6, `Destinations have inner spacing and rounded corners: ${JSON.stringify(layout)}`);
    check(layout.rowInset >= 40 && layout.rowRadius >= 6, `A selected message keeps room around its content: ${JSON.stringify(layout)}`);
    // Several destinations: each card toggles, and the button counts them.
    const destination = id => `.modal-backdrop:not([data-ui-closing]) .forward-modal .forward-destination[data-forward-key="channel:${id}"]`;
    value = await state();
    check(value.forwardConfirmDisabled === true && value.forwardPressed.length === 0, 'Nothing is forwarded before a destination is picked');
    await click(destination('other'));
    await click(destination('third'));
    value = await state();
    check(sameIds(value.forwardPressed, ['other', 'third']) && value.forwardConfirm === 'Forward to 2' && !value.forwardConfirmDisabled,
      `Picking two destinations selects both and counts them: ${JSON.stringify([value.forwardPressed, value.forwardConfirm])}`);
    await click(destination('other'));
    value = await state();
    check(sameIds(value.forwardPressed, ['third']) && value.forwardConfirm === 'Forward', 'Clicking a picked destination again unpicks it');
    await escape();
    await until('state().then(value => !value.forwardDestinations.length)', 'Escape closes the forward picker');
    value = await state();
    check(value.active && sameIds(value.selected, ['own-text', 'photo']), 'Closing the picker keeps the selection');
    // Forwarding one text message to two channels sends it to each, in the order they were picked.
    await click(row('photo'));
    await fixture('enableForward()');
    for (const deadline = Date.now() + 3000; await evaluate(`!!document.querySelector('.forward-modal')`);) {
      if (Date.now() > deadline) throw new Error('The closed forward picker never left the page');
      await wait(20);
    }
    await click('.message-selection-bar [data-selection-action="forward"]');
    await until('state().then(value => value.forwardDestinations.length ? value : null)', 'Forward reopens the picker');
    await click(destination('other'));
    await click(destination('third'));
    // The server refuses the first send as too fast: the forward waits and sends it again instead of failing.
    await fixture('refuseNextSend()');
    await click('.modal-backdrop:not([data-ui-closing]) .forward-modal [data-forward-confirm]');
    value = await until('state().then(value => value.forwards.length === 2 && !value.active && !value.forwardDestinations.length ? value : null)',
      'Forwarding to two destinations sends twice and leaves selection mode', 15000).catch(async (error) => {
      const snapshot = await state();
      throw new Error(`${error.message}\n${JSON.stringify({ forwards: snapshot.forwards, active: snapshot.active,
        destinations: snapshot.forwardDestinations, pressed: snapshot.forwardPressed, toast: await evaluate(
          `[...document.querySelectorAll('.copy-toast, [role="alert"], [role="status"]')].map(node => node.textContent.trim()).filter(Boolean)`) })}`);
    });
    check(sameIds(value.forwards.map(entry => entry.channelId), ['other', 'third'])
      && value.forwards.every(entry => entry.content === 'My own words' && entry.forward?.sourceMessageId === 'own-text')
      && new Set(value.forwards.map(entry => entry.clientMessageId)).size === 2,
    `Each destination receives its own copy marked as forwarded from the original: ${JSON.stringify(value.forwards)}`);
    check(value.refusals.length === 1 && value.refusals[0].clientMessageId === value.forwards[0].clientMessageId,
      'A send refused as too fast is retried with the same message id, so it is delivered once');
    await barRemoved('forwarding to several destinations');
    // The success toast sits over the bar's corner; real clicks must wait until it is gone.
    for (const deadline = Date.now() + 6000; await evaluate(`!!document.querySelector('.chat-copy-toast')`);) {
      if (Date.now() > deadline) throw new Error('The forward confirmation toast did not go away');
      await wait(50);
    }
    await fixture('resetFeatures()');
    await enterSelection('own-text');
    await click(row('photo'));
    await escape();
    await barRemoved('closing the picker and leaving');

    // Copy combines both messages under their headings.
    await enterSelection('own-text');
    await click(row('other-text'));
    await click('.message-selection-bar [data-selection-action="copy"]');
    await until('state().then(value => value.writes.length === 1 && !value.active)', 'Copy writes once and leaves selection mode');
    const copied = (await state()).writes[0];
    const ownHeading = copied.text.indexOf('Author — ');
    const otherHeading = copied.text.indexOf('Other — ');
    check(copied.kind === 'formatted' && ownHeading >= 0 && otherHeading > ownHeading
      && copied.text.includes('My own words') && copied.text.includes('Their words')
      && copied.html.includes('<strong>Author — ') && copied.html.includes('<strong>Other — '),
    `Copy writes both messages under "Nickname — time" headings in conversation order: ${JSON.stringify(copied)}`);
    await barRemoved('copying');

    // Reply with chat-blocks adds a quote per message.
    await fixture('enableBlocks()');
    await enterSelection('own-text');
    await click(row('other-text'));
    await click('.message-selection-bar [data-selection-action="reply"]');
    await until('state().then(value => !value.active)', 'Reply leaves selection mode');
    value = await state();
    check(sameIds(value.replyBlocks, ['own-text', 'other-text']) && value.composerVisible,
      `Reply adds one quote block per selected message to the composer: ${JSON.stringify(value.replyBlocks)}`);
    await barRemoved('replying');

    // Delete asks once and sends one request per message.
    await fixture('prepare()');
    await enterSelection('own-text');
    await click(row('link'));
    await click('.message-selection-bar [data-selection-action="delete"]');
    await until('state().then(value => value.dialogOpen)', 'Delete asks for confirmation');
    check((await fixture('dialogState()')).title === 'Delete 2 messages', 'The confirmation counts the messages');
    await fixture('confirmDialog()');
    await until('state().then(value => !value.active && value.requests.length === 2)', 'Delete sends the requests and leaves selection mode');
    value = await state();
    check(sameIds(value.requests.map(request => request.payload.messageId), ['own-text', 'link'])
      && value.requests.every(request => request.payload.channelId === 'chat'),
    `Each selected message gets its own delete request: ${JSON.stringify(value.requests)}`);
    check(value.deletedRows.includes('own-text') && value.deletedRows.includes('link'), 'The deleted messages re-render as deleted');
    await barRemoved('deleting');

    // Switching channels while selecting re-renders the chat without a leftover bar.
    await enterSelection('other-text');
    await fixture('switchChannel("other")');
    value = await state();
    check(!value.active && value.barElements === 0 && !value.hostActive && value.composerVisible,
      `Switching channels ends the selection and restores the composer: ${JSON.stringify({ active: value.active, bars: value.barElements })}`);
    await fixture('switchChannel("chat")');

    // Leaving the view while selecting releases the document listener.
    await enterSelection('other-text');
    const destroyed = await fixture('destroyWhileSelecting()');
    check(destroyed === true, `Destroying the chat while selecting removes the bar and the Escape listener: ${destroyed}`);
    await barRemoved('destroying the chat');
  } finally {
    await evaluate('window.messageSelectionFixture?.teardown()');
  }
  return checks;
}

async function installFixture() {
  const [{ ChatView }, { sessionManager }, language, { stickerToken }, { ProtocolRequestError }] = await Promise.all([
    import('/views/ChatView.ts'), import('/core/SessionManager.ts'), import('/i18n/index.ts'), import('/utils/stickers.ts'),
    import('/core/NetworkClient.ts'),
  ]);
  const root = document.getElementById('app');
  root.style.cssText = 'height:100vh;width:100%;display:flex;flex-direction:column;';
  const me = { id: 'selection-author', clientId: 'selection-device', nickname: 'Author', status: 'ONLINE', joinedAt: 1 };
  const other = { id: 'selection-other', clientId: 'selection-other-device', nickname: 'Other', status: 'ONLINE', joinedAt: 1 };
  // Everything except MANAGE_SERVER (1 << 1) and ADMINISTRATOR (1 << 11), which would allow deleting anyone's messages.
  const permissions = 2147483647 & ~(1 << 1) & ~(1 << 11);
  sessionManager.install();
  const session = sessionManager.create('message-selection-local', 49217, me.nickname);
  const details = () => ({
    id: 'selection-server', name: 'Selection fixture', createdAt: 1, maxUsers: 10, voiceStates: {}, allowMessageEdit: true,
    channels: ['chat', 'other', 'third'].map((id, position) => ({
      id, name: id, serverId: 'selection-server', type: 'TEXT', position, createdAt: 1,
      isPrivate: false, allowedRoleIds: [], botCommandsEnabled: true,
    })),
    members: [me, other], knownMembers: [me, other], roles: [], userRoles: [], myPermissions: permissions, ownerId: 'someone-else',
  });
  session.serverStore.setServerDetails(details(), me);
  const requests = [];
  const forwards = [];
  const refusals = [];
  let refuseNextSend = false;
  session.client.getStatus = () => 'CONNECTED';
  session.client.getCurrentServerUrl = () => session.key;
  // The fixture page stands in for the connected server that serves `/attachments/`.
  session.client.getHttpBaseUrl = () => location.origin;
  session.client.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
  session.client.send = () => {};
  session.client.sendRequest = (type, payload) => {
    if (payload?.clientMessageId && refuseNextSend) {
      // What the server answers when messages and upload tokens exceed the per-user allowance.
      refuseNextSend = false;
      refusals.push(structuredClone(payload));
      return Promise.reject(new ProtocolRequestError('Too fast', 'RATE_LIMITED'));
    }
    if (payload?.clientMessageId) {
      forwards.push(structuredClone(payload));
      return Promise.resolve({
        id: payload.clientMessageId, channelId: payload.channelId, userId: me.id, userNickname: me.nickname,
        content: payload.content, createdAt: Date.now(), isSystem: false,
        ...(payload.forward ? { forwarded: { source: payload.forward.sourceMessageId ? '#chat' : null, createdAt: null } } : {}),
      });
    }
    if (payload?.messageId) {
      requests.push({ type, payload });
      const original = session.chatStore.getMessages(payload.channelId).find(message => message.id === payload.messageId);
      return Promise.resolve({ message: { ...original, content: '', attachments: [], deletedAt: Date.now() } });
    }
    return Promise.resolve({ selectors: [] });
  };
  sessionManager.activate(session.key);

  const openExternal = [];
  const singleDownloads = [];
  const batchDownloads = [];
  const previousApi = window.api;
  window.api = {
    openExternal: url => { openExternal.push(url); },
    downloadFile: async (url, fileName) => { singleDownloads.push({ url, fileName }); return { success: true }; },
    downloadFiles: async request => {
      batchDownloads.push(structuredClone(request));
      return { status: 'saved', saved: request.files.length };
    },
  };
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const writes = [];
  // Real ClipboardItem encoding with a controlled sink, never the user's OS clipboard.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: async items => {
        const item = items[0];
        writes.push({ kind: 'formatted', types: item.types,
          text: await (await item.getType('text/plain')).text(), html: await (await item.getType('text/html')).text() });
      },
      writeText: async text => { writes.push({ kind: 'plain', text }); },
    },
  });

  let view;
  const find = selector => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Missing selection fixture element: ${selector}`);
    return element;
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  const feed = () => find('#chat-messages-feed');
  const media = name => `/attachments/${name}`;
  const image = (messageId, name) => ({ id: `${messageId}-${name.replace(/[^A-Za-z0-9-]/g, '')}`, messageId, kind: 'image', url: media(name), originalName: name,
    mimeType: 'image/png', sizeBytes: 100, createdAt: 1 });
  const openDialog = () => document.querySelector('.modal-backdrop:not([data-ui-closing]) .dialog-card');

  const prepare = async () => {
    view?.destroy();
    window.getSelection().removeAllRanges();
    root.innerHTML = '';
    language.setLanguage('en');
    session.serverStore.setServerDetails(details(), me);
    session.chatStore.clear();
    const base = Date.UTC(2026, 9, 16, 12);
    const message = (id, author, index, extra = {}) => ({
      id, channelId: 'chat', userId: author.id, userNickname: author.nickname, createdAt: base + index * 60_000, isSystem: false,
      content: '', ...extra,
    });
    const filler = Array.from({ length: 60 }, (_, index) =>
      message(`m${index}`, index % 2 ? other : me, index, { content: `Filler message number ${index}` }));
    session.chatStore.setHistory('chat', [
      ...filler,
      message('own-text', me, 60, { content: 'My own words' }),
      message('other-text', other, 61, { content: 'Their words' }),
      message('link', me, 62, { content: 'Read [Monky docs](https://example.invalid/docs) now' }),
      message('photo', me, 63, { content: 'A photo', attachments: [image('photo', 'photo.png')] }),
      message('sticker', me, 64, { content: stickerToken('sticker-stickerpng'), attachments: [image('sticker', 'sticker.png')] }),
      message('forwarded', other, 65, { content: 'Passed along', forwarded: { source: '#general · Elsewhere', createdAt: base } }),
      message('gallery', me, 66, { content: 'Two pictures', attachments: [image('gallery', 'gallery-1.png'), image('gallery', 'gallery-2.png')] }),
    ]);
    session.chatStore.setHistory('other', []);
    writes.length = 0;
    requests.length = 0;
    openExternal.length = 0;
    singleDownloads.length = 0;
    batchDownloads.length = 0;
    view = new ChatView(root);
    view.setChannel('chat');
    await document.fonts.ready;
    await Promise.all([...root.querySelectorAll('img.chat-attachment-image')].map(img => img.decode().catch(() => {})));
    await settle();
  };

  const rowIds = selector => [...feed().querySelectorAll(selector)].map(row => row.dataset.messageId);

  window.messageSelectionFixture = {
    prepare, settle,
    clearTextSelection() { window.getSelection().removeAllRanges(); },
    async point(selector) {
      const element = find(selector);
      const container = feed();
      const bounds = container.getBoundingClientRect();
      const current = element.getBoundingClientRect();
      if (container.contains(element) && (current.top < bounds.top || current.bottom > bounds.bottom)) {
        // Test positioning only; the chat itself never jumps like this.
        container.scrollTop += current.top - bounds.top - (bounds.height - current.height) / 2;
      }
      await settle();
      const rect = element.getBoundingClientRect();
      return { x: rect.x + Math.min(rect.width / 2, 120), y: rect.y + rect.height / 2 };
    },
    async menuItemPoint(label) {
      const item = [...document.querySelectorAll('.floating-context-menu:not([data-ui-closing]) [role="menuitem"]')]
        .find(entry => entry.textContent.includes(label));
      if (!item) return null;
      await settle();
      const rect = item.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    },
    focusRow(id) { find(`[data-message-id="${id}"].chat-message-row`).focus({ preventScroll: true }); },
    scrollFeedTop() { feed().scrollTop = 0; return settle(); },
    feedRect() { return feed().getBoundingClientRect().toJSON(); },
    lastVisibleIndex() {
      const bottom = feed().getBoundingClientRect().bottom;
      return Math.max(...[...feed().querySelectorAll('.chat-message-row[data-message-id^="m"]')]
        .filter(row => row.getBoundingClientRect().top < bottom).map(row => Number(row.dataset.messageId.slice(1))));
    },
    async frames(count) {
      for (let index = 0; index < count; index++) await new Promise(resolve => requestAnimationFrame(resolve));
    },
    clearSelectionState() {
      for (const id of rowIds('.chat-message-row.is-selected')) {
        // Plain keyboard toggles keep the reset independent of where the rows are.
        const row = find(`[data-message-id="${id}"].chat-message-row`);
        row.focus({ preventScroll: true });
        row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
      }
      return settle();
    },
    syntheticInnerClicks() {
      find('[data-message-id="link"] a.md-link').click();
      find('[data-message-id="photo"] img.chat-attachment-image').click();
      find('[data-message-id="photo"] img.chat-attachment-image').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return settle();
    },
    async clickCarouselDownload(index) {
      find(`[data-message-id="gallery"] .chat-attachment-carousel .chat-attachment-carousel-slide:nth-child(${index + 1}) .chat-attachment-download`).click();
      await settle();
    },
    dialogState() {
      const card = openDialog();
      if (!card) return null;
      const choices = [...card.querySelectorAll('[data-dialog-choice]')];
      return {
        title: card.querySelector('.modal-title > span:not(.material-symbols-outlined)')?.textContent.trim(),
        choices: choices.map(choice => choice.dataset.dialogChoice),
        pressed: choices.find(choice => choice.getAttribute('aria-pressed') === 'true')?.dataset.dialogChoice,
      };
    },
    async chooseAndConfirm(choice) {
      find(`.modal-backdrop:not([data-ui-closing]) [data-dialog-choice="${choice}"]`).click();
      find('.modal-backdrop:not([data-ui-closing]) [data-action="confirm"]').click();
      await settle();
    },
    async confirmDialog() {
      find('.modal-backdrop:not([data-ui-closing]) [data-action="confirm"]').click();
      await settle();
    },
    async openGalleryLightbox() {
      find('[data-message-id="gallery"] .chat-attachment-carousel img.chat-attachment-image').click();
      await settle();
    },
    async clickLightboxDownload() {
      find('.attachment-lightbox:not([data-ui-closing]) .lightbox-download').click();
      await settle();
    },
    async closeLightbox() {
      find('.attachment-lightbox:not([data-ui-closing]) .lightbox-close').click();
      await settle();
    },
    resetCalls() {
      openExternal.length = 0;
      singleDownloads.length = 0;
      batchDownloads.length = 0;
    },
    enableBlocks() {
      session.serverStore.serverDetails.protocol = { version: 25, minimumVersion: 24, features: ['chat-blocks', 'message-length-setting'] };
    },
    enableForward() {
      session.serverStore.serverDetails.protocol = { version: 40, minimumVersion: 35, features: ['chat-blocks', 'chat-delivery', 'message-forward'] };
    },
    resetFeatures() {
      delete session.serverStore.serverDetails.protocol;
    },
    refuseNextSend() {
      refuseNextSend = true;
    },
    async switchChannel(id) {
      view.setChannel(id);
      await settle();
    },
    async destroyWhileSelecting() {
      const container = feed();
      view.destroy();
      await settle();
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(escape);
      const result = { prevented: escape.defaultPrevented, bar: !!document.querySelector('.message-selection-bar:not([data-ui-closing])'),
        selecting: container.classList.contains('is-selecting-messages') };
      view = null;
      return !result.prevented && !result.bar && !result.selecting ? true : JSON.stringify(result);
    },
    async state() {
      const list = document.querySelector('#chat-messages-feed');
      const host = document.querySelector('.chat-input-container');
      const bar = document.querySelector('.message-selection-bar:not([data-ui-closing])');
      const composer = document.querySelector('#chat-message-input');
      return {
        active: !!list?.classList.contains('is-selecting-messages'),
        dragging: !!list?.classList.contains('is-drag-selecting'),
        feedRole: list?.getAttribute('role') ?? null,
        multiselectable: list?.getAttribute('aria-multiselectable') ?? null,
        scrollTop: list?.scrollTop ?? 0,
        rows: list ? list.querySelectorAll('.chat-message-row[data-message-id]').length : 0,
        optionRows: list ? list.querySelectorAll('.chat-message-row[role="option"]').length : 0,
        selected: list ? rowIds('.chat-message-row.is-selected') : [],
        selectedClassRows: list ? list.querySelectorAll('.chat-message-row.is-selected').length : 0,
        ariaSelected: list ? rowIds('.chat-message-row[aria-selected="true"]') : [],
        bar: !!bar && host?.contains(bar),
        barElements: document.querySelectorAll('.message-selection-bar').length,
        hostActive: !!host?.classList.contains('message-selection-host--active'),
        composerVisible: !!composer && composer.getClientRects().length > 0,
        count: bar?.querySelector('.message-selection-count')?.textContent ?? null,
        actions: [...(bar?.querySelectorAll('[data-selection-action]') ?? [])].map(button => ({
          id: button.dataset.selectionAction, disabled: button.getAttribute('aria-disabled') === 'true', title: button.title,
        })),
        menuOpen: !!document.querySelector('.floating-context-menu:not([data-ui-closing])'),
        dialogOpen: !!openDialog(),
        lightboxOpen: !!document.querySelector('.attachment-lightbox:not([data-ui-closing])'),
        forwardDestinations: [...document.querySelectorAll('.forward-modal .forward-destination:not([data-ui-closing])')]
          .filter(button => !button.closest('[data-ui-closing]'))
          .map(button => button.dataset.forwardKey.replace(/^channel:/, '')),
        forwardPressed: [...document.querySelectorAll('.forward-modal .forward-destination[aria-pressed="true"]')]
          .filter(button => !button.closest('[data-ui-closing]'))
          .map(button => button.dataset.forwardKey.replace(/^channel:/, '')),
        forwardConfirm: document.querySelector('.forward-modal:not([data-ui-closing]) [data-forward-confirm]')?.textContent.trim() ?? null,
        forwardConfirmDisabled: document.querySelector('.forward-modal:not([data-ui-closing]) [data-forward-confirm]')?.disabled ?? null,
        forwards: structuredClone(forwards),
        refusals: structuredClone(refusals),
        forwardedBadge: list?.querySelector('[data-message-id="forwarded"] .chat-forwarded > span:not(.material-symbols-outlined)')
          ?.textContent.trim() ?? null,
        forwardedBadgeCount: list ? list.querySelectorAll('.chat-forwarded').length : 0,
        carouselSlides: list ? list.querySelectorAll('[data-message-id="gallery"] .chat-attachment-carousel-slide').length : 0,
        replyBlocks: session.chatStore.getBlockDraft('chat').filter(block => block.type === 'reply').map(block => block.messageId),
        deletedRows: list ? session.chatStore.getMessages('chat').filter(message => message.deletedAt).map(message => message.id) : [],
        openExternal: [...openExternal], singleDownloads: [...singleDownloads], batchDownloads: [...batchDownloads],
        writes: [...writes], requests: [...requests],
      };
    },
    teardown() {
      view?.destroy();
      if (previousClipboard) Object.defineProperty(navigator, 'clipboard', previousClipboard);
      else delete navigator.clipboard;
      window.api = previousApi;
    },
  };
}
