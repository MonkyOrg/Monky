const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  test('message search supports keyboard scoping, multi-filters, pagination and revocation cleanup', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `search-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_SEARCH_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
    } finally { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.on('window-all-closed', () => {});
  app.setPath('userData', process.env.MONKY_SEARCH_PROFILE);
  let vite, browser, timeout;
  const finish = async code => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    const fonts = ['material-symbols/outlined.css', '@fontsource/inter/400.css', '@fontsource/inter/600.css']
      .map(id => `<link rel="stylesheet" href="/@fs/${require.resolve(id).replaceAll('\\', '/')}">`).join('');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false },
      plugins: [{
        name: 'search-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__search__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end(`<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css">${fonts}</head><body><main class="main-center-column" style="height:900px"><header id="header" class="server-tools"></header></main></body></html>`);
          });
        },
      }],
    });
    const http = vite.httpServer;
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    browser = new BrowserWindow({
      show: false, width: 1100, height: 1000,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('Message search DOM timed out'); void finish(1); }, 90000);
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`http://127.0.0.1:${http.address().port}/__search__`);
      await browser.webContents.executeJavaScript(`window.searchRegression = (${regression.toString()})(${JSON.stringify(language)}); void 0`);
      for (;;) {
        const step = await browser.webContents.executeJavaScript('window.searchRegression.next()', true);
        if (step.done) { console.log(`Message search DOM (${language}): ${step.value} checks passed`); break; }
        if (step.value === 'search-calendar') {
          const point = await browser.webContents.executeJavaScript(`(() => {
            const input = document.querySelector('.message-search-modal [name=start]');
            input.scrollIntoView({ block: 'center' });
            const box = input.getBoundingClientRect();
            return { x: Math.round(box.right - 18), y: Math.round(box.top + box.height / 2) };
          })()`);
          browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
          browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
          await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        }
        if (step.value === 'search-media-hover') {
          const point = await browser.webContents.executeJavaScript(`(() => {
            const file = document.querySelector('.message-search-result-file');
            const box = file.getBoundingClientRect();
            return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
          })()`);
          browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        }
        if (step.value === 'search-audio-volume') {
          const point = await browser.webContents.executeJavaScript(`(() => {
            const button = document.querySelector('.message-search-result-audio-player [data-action="mute"]');
            const box = button.getBoundingClientRect();
            return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
          })()`);
          browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
          await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        }
        if (process.env.MONKY_COMMUNITY_SCREENSHOTS) {
          await browser.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
          fs.writeFileSync(path.join(process.env.MONKY_COMMUNITY_SCREENSHOTS, `727-${language}-${step.value}.png`),
            (await browser.webContents.capturePage()).toPNG());
        }
      }
    }
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function* regression(language) {
  const { MessageSearch } = await import('/views/MessageSearch.ts');
  const { dateTimeControls } = await import('/core/DateTimeControls.ts');
  const { highlightMessageJump } = await import('/utils/messageJumpHighlight.ts');
  dateTimeControls.init();
  const { setLanguage } = await import('/i18n/index.ts');
  setLanguage(language);
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  let canRead = true;
  let current = true;
  let channelId = 'one';
  let invalidator;
  let watches = 0;
  let expanded = false;
  let calls = [];
  let pending;
  let delay = false;
  const navigation = [];
  const channels = [{ id: 'one', name: 'general', type: 'TEXT' }, { id: 'two', name: 'other', type: 'TEXT' },
    { id: 'voice', name: 'voice', type: 'VOICE' }, { id: 'forum', name: 'forum', type: 'FORUM' }];
  const message = id => ({ id, channelId: 'one', userId: 'alice', userNickname: '<img src=x onerror=alert(1)>',
    content: '<script>window.leaked=true</script> **hello** https://google.com\n```ts\nconst safe = true;\n```',
    createdAt: 1000, isSystem: false, attachments: [
      { id: 'image', messageId: id, kind: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        originalName: 'qa.png', mimeType: 'image/png', sizeBytes: 40, createdAt: 1000 },
      { id: 'video', messageId: id, kind: 'video', url: 'data:video/webm;base64,GkXfo0AgQoaBAULygQRC84EIQoKEd2VibQ==',
        originalName: 'qa.webm', mimeType: 'video/webm', sizeBytes: 28, createdAt: 1000 },
      { id: 'audio', messageId: id, kind: 'file', url: 'data:audio/wav;base64,UklGRg==',
        originalName: 'qa.wav', mimeType: 'audio/wav', sizeBytes: 4, createdAt: 1000 },
      { id: 'file', messageId: id, kind: 'file', url: 'data:text/plain;base64,UUE=',
        originalName: 'qa.txt', mimeType: 'application/octet-stream', sizeBytes: 2, createdAt: 1000 },
    ] });
  const view = new MessageSearch(document.querySelector('#header'), document.querySelector('main'), {
    channels: () => channels,
    users: () => [{ id: 'alice', nickname: 'Alice' }, { id: 'bob', nickname: 'Bob' }, { id: 'robot', nickname: 'Robot', isBot: true }],
    currentChannelId: () => channelId,
    canRead: () => canRead,
    isCurrent: () => current,
    search: (payload, signal) => {
      calls.push({ payload, signal });
      if (delay) return new Promise(resolve => { pending = resolve; });
      const id = payload.cursor === 'page-three' ? 'third' : payload.cursor === 'page-two' ? 'second' : 'first';
      const nextCursor = payload.cursor === 'page-two' ? 'page-three' : payload.cursor ? undefined : 'page-two';
      return Promise.resolve({ messages: [message(id)], total: 60, nextCursor });
    },
    navigate: (...args) => navigation.push(args),
    setExpanded: value => { expanded = value; },
    watch: invalidate => { watches++; invalidator = invalidate; return () => { watches--; }; },
  });
  const keyboard = key => {
    const event = new KeyboardEvent('keydown', { key, ctrlKey: key === 'f', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event;
  };
  const submit = async () => {
    if (!document.querySelector('.message-search-modal')) panel().querySelector('[data-search-advanced]').click();
    document.querySelector('.message-search-modal form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
  };
  const panel = () => document.querySelector('.message-search-panel:not(.is-suggestions)');
  const suggestions = () => document.querySelector('.message-search-panel.is-suggestions');
  const form = () => document.querySelector('.message-search-modal');
  check(watches === 1, 'watches installed');
  const jumpRow = document.createElement('div');
  jumpRow.className = 'chat-message-row';
  document.body.append(jumpRow);
  const firstHighlight = highlightMessageJump(jumpRow);
  const repeatedHighlight = highlightMessageJump(jumpRow);
  check(firstHighlight?.playState === 'idle' && repeatedHighlight
    && repeatedHighlight.effect.getComputedTiming().duration >= 900
    && jumpRow.querySelectorAll(':scope > .chat-message-jump-highlight').length === 1
    && getComputedStyle(jumpRow.querySelector('.chat-message-jump-highlight')).borderLeftWidth === '3px'
    && getComputedStyle(jumpRow.querySelector('.chat-message-jump-highlight')).left === '-8px',
  'Message jump highlight is visible, repeatable, spaced and uses the shared motion timing');
  repeatedHighlight.cancel();
  await flush();
  check(!jumpRow.querySelector('.chat-message-jump-highlight'), 'Cancelling a jump highlight cleans up its overlay');
  jumpRow.remove();
  check(keyboard('f').defaultPrevented, 'Ctrl+F intercepted in text channel');
  check(expanded, 'Opening search requests the members sidebar to collapse');
  check(!suggestions().hidden && document.activeElement.name === 'query', 'search focused');
  check(panel().hidden && !suggestions().querySelector('form'),
    'Header search opens quick filters independently from the results surface');
  const paletteProbe = document.createElement('span');
  paletteProbe.style.backgroundColor = 'var(--bg-input)';
  document.body.append(paletteProbe);
  const inputSurface = getComputedStyle(paletteProbe).backgroundColor;
  check(getComputedStyle(document.querySelector('.message-search-bar')).backgroundColor === inputSurface
    && parseFloat(getComputedStyle(document.querySelector('.message-search-launch')).fontSize) <= 11,
  'Header search uses the compact app input palette and typography');
  paletteProbe.remove();
  yield 'search-quick';
  const initialChipCount = document.querySelectorAll('.message-search-bar-chip').length;
  document.querySelector('.message-search-launch').value = '';
  document.querySelector('.message-search-launch').dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Backspace', bubbles: true, cancelable: true,
  }));
  await flush();
  check(initialChipCount === 1 && !document.querySelector('.message-search-bar-chip'),
  'Backspace on an empty composer removes the complete nearest filter token');
  document.querySelector('.message-search-launch').click();
  check(!suggestions().querySelector('.btn-primary')
    && suggestions().querySelector('[data-search-advanced].message-search-suggestion .material-symbols-outlined')?.textContent === 'manage_search',
  'Quick filters omit the redundant search button and render advanced search as an icon row');
  suggestions().querySelector('[data-quick-filter=contains]').click();
  check(!document.querySelector('.message-search-modal')
    && suggestions().querySelectorAll('[data-quick-value]').length === 5
    && suggestions().querySelectorAll('[data-quick-value] .material-symbols-outlined').length === 5
    && suggestions().querySelector('h2').textContent === (language === 'en' ? 'Message contains' : 'A mensagem contém'),
  'Contains opens its five icon options in the quick dropdown instead of the advanced modal');
  suggestions().querySelector('[data-quick-value=image]').click();
  await flush();
  check(calls.at(-1).payload.contains[0] === 'image'
    && document.querySelector('.message-search-bar-chip[data-selection=contains][data-value=image]'),
  'Choosing quick content applies the search and creates a removable chip');
  document.querySelector('.message-search-bar-chip[data-selection=contains]').click();
  await flush();
  document.querySelector('.message-search-launch').click();
  suggestions().querySelector('[data-quick-filter=authorType]').click();
  check(!document.querySelector('.message-search-modal')
    && suggestions().querySelectorAll('[data-quick-value]').length === 3
    && suggestions().querySelector('h2').textContent === (language === 'en' ? 'Author type' : 'Tipo de autor'),
  'Author type opens Any, Human and Bot in the quick dropdown');
  suggestions().querySelector('[data-quick-value=bot]').click();
  await flush();
  check(calls.at(-1).payload.authorType === 'bot'
    && document.querySelector('.message-search-bar-chip[data-selection=authorType][data-value=bot]'),
  'Choosing a quick author type applies the search and creates a removable chip');
  document.querySelector('.message-search-bar-chip[data-selection=authorType]').click();
  await flush();
  document.querySelector('.message-search-launch').click();
  suggestions().querySelector('[data-quick-filter=channelIds]').click();
  check(suggestions().querySelector('h2').textContent === (language === 'en' ? 'In channel' : 'No canal'),
    'Channel quick filter uses a contextual singular heading');
  suggestions().querySelector('[data-quick-value=one]').click();
  await flush();
  document.querySelector('.message-search-launch').click();
  const authorPrefix = language === 'en' ? 'from:' : 'de:';
  document.querySelector('.message-search-launch').value = `report ${authorPrefix}`;
  document.querySelector('.message-search-launch').dispatchEvent(new Event('input', { bubbles: true }));
  check(document.querySelector('.message-search-launch').value === ''
    && document.querySelector('[data-active-filter=authorIds] .message-search-bar-chip-label').textContent === authorPrefix
    && suggestions().querySelectorAll('[data-quick-value]').length === 3
    && suggestions().querySelector('h2').textContent === (language === 'en' ? 'From user' : 'Do usuário'),
  'Typing a localized filter prefix immediately turns it into an active chip and opens its dropdown');
  document.querySelector('.message-search-launch').value = 'bob';
  document.querySelector('.message-search-launch').dispatchEvent(new Event('input', { bubbles: true }));
  check(suggestions().querySelectorAll('[data-quick-value]').length === 1
    && suggestions().querySelector('[data-quick-value=bob]'),
  'Text beside the active filter chip narrows its options');
  suggestions().querySelector('[data-quick-value=bob]').click();
  await flush();
  check(calls.at(-1).payload.query === 'report' && calls.at(-1).payload.authorIds[0] === 'bob',
    'Automatic prefix selection preserves the preceding message query');
  document.querySelector('.message-search-bar-chip[data-selection=authorIds]').click();
  document.querySelector('.message-search-launch').value = '';
  await flush();
  document.querySelector('.message-search-launch').click();
  suggestions().querySelector('[data-quick-filter=mentionsUserIds]').click();
  check(suggestions().querySelector('h2').textContent === (language === 'en' ? 'Mentions user' : 'Menciona o usuário'),
    'Mention quick filter uses a contextual singular heading');
  document.querySelector('[data-active-filter=mentionsUserIds]').click();
  suggestions().querySelector('[data-search-advanced]').click();
  const today = new Date();
  const todayValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const localizedToday = new Intl.DateTimeFormat(language, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))).replaceAll('.', '');
  const initialDates = [...form().querySelectorAll('[data-date-picker]:not([hidden])')];
  check(initialDates.length === 1 && initialDates.every(input => input.type === 'text'
    && input.dataset.dateValue === todayValue && input.value === localizedToday
    && getComputedStyle(input).backgroundImage.includes('svg')),
  'The single visible search date starts on today, uses localized text and keeps the calendar icon');
  check(getComputedStyle(form().querySelector('.message-search-combobox-field')).backgroundColor
    === inputSurface,
  'Searchable dropdown fields reuse the standard app input surface');
  form().querySelector('[name=date]').value = 'range';
  form().querySelector('[name=date]').dispatchEvent(new Event('change', { bubbles: true }));
  form().querySelector('[name=start]').click();
  await flush();
  check(form().querySelector('[name=date]').value === 'range'
    && !!document.querySelector('.calendar-popup:not([data-ui-closing])'),
  'Direct date mode selector opens the range calendar without shortcut buttons');
  check(!form().textContent.includes(language === 'en' ? 'On date…' : 'Na data…')
    && !form().textContent.includes(language === 'en' ? 'Between…' : 'Entre…'),
  'Advanced filters no longer duplicate date modes as shortcut buttons');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  form().querySelector('.message-search-actions button:nth-last-child(2)').click();
  await flush();
  suggestions().querySelector('[data-quick-filter=authorIds]').click();
  check(suggestions().querySelectorAll('[data-quick-value]').length === 3
    && document.activeElement.value === ''
    && document.querySelector('[data-active-filter=authorIds] .message-search-bar-chip-label').textContent === authorPrefix,
  'Author shortcut shows members and represents its localized prefix as a chip');
  yield 'search-users';
  suggestions().querySelector('[data-quick-value=alice]').click();
  await flush();
  check((suggestions().hidden || suggestions().hasAttribute('data-ui-closing'))
    && !panel().hidden && calls.at(-1).payload.authorIds[0] === 'alice',
    'Choosing a member immediately closes suggestions and starts showing results');
  check(document.querySelector('.message-search-bar-chip-label').textContent === (language === 'en' ? 'from: Alice' : 'de: Alice')
    && document.querySelector('.message-search-launch').getBoundingClientRect().width >= 80,
  'Selected filter stays fully readable inside the composer while text input remains available');
  document.querySelector('.message-search-launch').click();
  document.querySelector('.message-search-launch').value = 'o';
  document.querySelector('.message-search-launch').dispatchEvent(new Event('input', { bubbles: true }));
  check(!!suggestions().querySelector('[data-search-query]')
    && suggestions().querySelectorAll('[data-context-selection=authorIds]').length === 2
    && suggestions().querySelectorAll('[data-context-selection=channelIds]').length === 2
    && suggestions().querySelectorAll('[data-context-selection=mentionsUserIds]').length === 1,
  'Typing after chips shows a search action and matching options grouped by author, channel and mention');
  const contextualSearch = suggestions().querySelector('[data-search-query]');
  check(!!contextualSearch, 'Contextual search action remains available after voice channel suggestions');
  contextualSearch.click();
  await flush();
  check(calls.at(-1).payload.query === 'o', 'Contextual search action submits the typed message text with existing chips');
  document.querySelector('.message-search-launch').click();
  const contextualAuthor = suggestions().querySelector('[data-context-selection=authorIds][data-value=bob]');
  check(!!contextualAuthor, 'Contextual author suggestion remains available after searching');
  contextualAuthor.click();
  await flush();
  check(calls.at(-1).payload.query === '' && calls.at(-1).payload.authorIds.includes('bob')
    && document.querySelector('.message-search-bar-chip[data-value=bob]'),
  'Choosing a contextual suggestion consumes the typed fragment and turns the option into a chip');
  const contextualAuthorChip = document.querySelector('.message-search-bar-chip[data-value=bob]');
  check(!!contextualAuthorChip, 'Contextual author chip remains removable');
  contextualAuthorChip.click();
  await flush();
  document.querySelector('.message-search-launch').click();
  const authorQuickFilter = suggestions().querySelector('[data-quick-filter=authorIds]');
  check(!!authorQuickFilter, 'Author quick filter remains available after contextual selection');
  authorQuickFilter.click();
  const selectedSuggestion = suggestions().querySelector('[data-quick-value=alice]');
  check(selectedSuggestion.getAttribute('aria-pressed') === 'true', 'Quick selections retain their state');
  const selectedProbe = document.createElement('span');
  selectedProbe.style.cssText = 'background:var(--bg-card-hover);color:var(--text-primary)';
  document.body.append(selectedProbe);
  check(getComputedStyle(selectedSuggestion).backgroundColor === getComputedStyle(selectedProbe).backgroundColor
    && getComputedStyle(selectedSuggestion).color === getComputedStyle(selectedProbe).color,
  'Selected suggestions use the app row highlight without changing their text to accent blue');
  selectedProbe.remove();
  suggestions().querySelector('[data-quick-value=alice]').click();
  await flush();
  document.querySelector('.message-search-launch').click();
  const advancedSearch = suggestions().querySelector('[data-search-advanced]');
  check(!!advancedSearch, 'Advanced search remains available after removing contextual filters');
  advancedSearch.click();
  check(form().getBoundingClientRect().width <= 480, 'Advanced filters use the narrow reference modal');
  check(form().querySelector('.message-search-status').textContent === '',
    'Advanced filters do not show a loose ready instruction above their actions');
  yield 'search-advanced';
  check(form().querySelector('[data-selection=channelIds] [aria-selected=true]').textContent.includes('general'), 'current channel scoped');
  check(form().textContent.includes('voice') && !form().textContent.includes('forum'),
    'voice chats are searchable while forum containers remain excluded');
  check(!form().querySelector('input[type=checkbox],input[type=radio]'), 'no native checkbox or radio controls');
  const authors = form().querySelector('[data-selection=authorIds]');
  const authorToggle = authors.querySelector('.message-search-combobox-toggle');
  check(getComputedStyle(authorToggle).cursor === 'pointer',
    'Advanced dropdown toggle advertises its clickable state with the pointer cursor');
  authors.querySelector('input').focus();
  authors.querySelector('input').click();
  check(!authors.querySelector('[role=listbox]').hidden,
    'Clicking the editable input opens the dropdown for typing and filtering');
  authorToggle.click();
  check(authors.querySelector('[role=listbox]').hidden && authorToggle.getAttribute('aria-expanded') === 'false',
    'Dropdown button closes the advanced filter list without changing the input');
  authorToggle.click();
  check(!authors.querySelector('[role=listbox]').hidden && document.activeElement === authors.querySelector('input'),
    'Dropdown button opens the list and returns focus to the searchable input');
  authors.querySelector('input').value = 'bob';
  authors.querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
  check(authors.querySelectorAll('.message-search-combobox-option').length === 1
    && authors.querySelector('.message-search-combobox-option').textContent.includes('Bob'),
  'Typing in the standard field opens and filters its dropdown');
  authors.querySelector('input').value = '';
  authors.querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
  const firstAuthor = authors.querySelectorAll('.message-search-combobox-option')[0];
  const optionPointerDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
  firstAuthor.dispatchEvent(optionPointerDown);
  check(optionPointerDown.defaultPrevented, 'Combobox options preserve input focus through pointerdown so click can select');
  firstAuthor.click();
  check(!authors.querySelector('[role=listbox]').hidden,
    'Selecting a combobox option keeps the advanced dropdown open');
  check(authors.querySelectorAll('.message-search-combobox-option')[0].getAttribute('aria-selected') === 'true',
    'Selecting a combobox option updates its selected state');
  check(authors.querySelector('.message-search-combobox-chip')?.dataset.value === firstAuthor.dataset.value
    && !!authors.querySelector('.message-search-combobox-chip')?.textContent.trim(),
    'Selecting a combobox option creates a chip in the field');
  authors.querySelectorAll('.message-search-combobox-option')[1].click();
  check(authors.querySelectorAll('.message-search-combobox-chip').length === 2
    && authors.querySelector('input').value === '',
  'Multiple advanced selections remain separate chips beside the editable input');
  const removableAuthor = authors.querySelector('.message-search-combobox-chip');
  const removableId = removableAuthor.dataset.value;
  removableAuthor.click();
  check(authors.querySelector(`.message-search-combobox-option[data-value="${removableId}"]`).getAttribute('aria-selected') === 'false'
    && authors.querySelectorAll('.message-search-combobox-chip').length === 1,
  'Clicking a selected chip removes the whole value and updates its option state');
  authors.querySelector(`.message-search-combobox-option[data-value="${removableId}"]`).click();
  const channelChoices = form().querySelector('[data-selection=channelIds]');
  channelChoices.querySelectorAll('.message-search-combobox-option')[1].click();
  const mentions = form().querySelector('[data-selection=mentionsUserIds]');
  mentions.querySelectorAll('.message-search-combobox-option')[0].click();
  const content = form().querySelector('[data-selection=contains]');
  content.querySelector('input').focus();
  check(content.querySelectorAll('.message-search-combobox-option .material-symbols-outlined').length === 5,
    'Content dropdown uses an icon for every searchable option');
  content.querySelector('[data-value=image]').click();
  form().querySelector('[name=query]').value = 'hello';
  form().querySelector('[name=authorType]').value = 'human';
  form().querySelector('[name=date]').value = 'range';
  form().querySelector('[name=date]').dispatchEvent(new Event('change'));
  await Promise.allSettled(form().closest('.modal-backdrop').getAnimations({ subtree: true }).map(animation => animation.finished));
  yield 'search-calendar';
  const calendar = document.querySelector('.date-time-popup:not([data-ui-closing])');
  check(calendar?.querySelectorAll('[role=gridcell]').length === 42, 'Advanced search shares the themed calendar with event scheduling');
  const calendarValues = [...calendar.querySelectorAll('[role=gridcell][data-value]:not([disabled])')]
    .map(cell => cell.dataset.value).sort();
  const rangeStart = calendarValues[0];
  const rangeEnd = calendarValues.find(value => Date.parse(`${value}T00:00:00Z`) === Date.parse(`${rangeStart}T00:00:00Z`) + 86_400_000);
  check(!!rangeStart && !!rangeEnd, 'The calendar exposes two consecutive dates for a range');
  calendar.querySelector(`[data-value="${rangeStart}"]`).click();
  check(!!document.querySelector('.date-time-popup:not([data-ui-closing])')
    && !!document.querySelector('.calendar-range-status')?.textContent,
    'First range click keeps the themed calendar open for the endpoint');
  document.querySelector(`.date-time-popup:not([data-ui-closing]) [data-value="${rangeEnd}"]`).click();
  check(form().querySelector('[name=start]').dataset.dateValue === rangeStart
    && form().querySelector('[name=end]').dataset.dateValue === rangeEnd
    && form().querySelector('[name=start]').value.includes('–')
    && form().querySelectorAll('[data-date-picker]:not([hidden])').length === 1
    && document.activeElement.name === 'start',
    'One range field presents both localized dates while preserving ordered canonical values');
  await submit();
  const sent = calls.at(-1).payload;
  check(sent.query === 'hello' && sent.authorIds.length === 2 && sent.channelIds.length === 2, 'multiple user and channel filters');
  check(sent.mentionsUserIds[0] === 'alice' && sent.contains[0] === 'image' && sent.authorType === 'human', 'contains, mentions and author type');
  check(sent.before === Date.parse(`${rangeEnd}T00:00:00Z`) + 86_400_000
    && sent.after === Date.parse(`${rangeStart}T00:00:00Z`) - 1,
  'inclusive UTC date range');
  check(panel().querySelectorAll('.message-search-result').length === 1, 'first result shown');
  check(panel().querySelector('.message-search-result-count').textContent === (language === 'en' ? '60 results' : '60 resultados'),
    'Result header displays the authorized total, not only the current page');
  const toolbarButtons = [...panel().querySelectorAll('.message-search-toolbar-button')];
  check(toolbarButtons.length === 2
    && toolbarButtons.every(button => button.querySelector('.material-symbols-outlined'))
    && toolbarButtons[0].getBoundingClientRect().height === toolbarButtons[1].getBoundingClientRect().height,
  'Filter and sort use matching toolbar buttons with icons');
  const sortButton = panel().querySelector('.message-search-sort');
  sortButton.click();
  const sortMenu = panel().querySelector('.message-search-sort-menu');
  check(!sortMenu.hidden && sortButton.getAttribute('aria-expanded') === 'true'
    && sortMenu.querySelectorAll('[role=menuitemradio]').length === 2
    && sortMenu.querySelector('[data-value=newest]').getAttribute('aria-checked') === 'true',
  'Sort button opens the themed two-option menu with the current choice marked');
  sortMenu.querySelector('[data-value=oldest]').click();
  await flush();
  check(calls.at(-1).payload.sort === 'oldest'
    && panel().querySelector('.message-search-sort-menu [data-value=oldest]').getAttribute('aria-checked') === 'true',
  'Choosing oldest updates the server-side ordering and selected menu state');
  sortButton.click();
  panel().querySelector('.message-search-sort-menu [data-value=newest]').click();
  await flush();
  check(calls.at(-1).payload.sort === 'newest', 'Sort menu can restore newest ordering');
  check([...panel().querySelectorAll('.message-search-page')].map(button => button.textContent).join(',') === '1,2,3'
    && panel().querySelector('.message-search-page[aria-current=page]').textContent === '1',
  'Pagination renders numbered pages and highlights the current page');
  const pageNavigation = [...panel().querySelectorAll('.message-search-page-nav')];
  check(pageNavigation.length === 2 && pageNavigation.every(button =>
    button.childElementCount === 1 && button.firstElementChild.classList.contains('material-symbols-outlined')
      && button.getAttribute('aria-label') && button.title
      && button.getBoundingClientRect().width === button.getBoundingClientRect().height),
  'Previous and next use compact accessible icon buttons instead of long asymmetric labels');
  check(getComputedStyle(panel()).overflow === 'hidden'
    && getComputedStyle(panel().querySelector('.message-search-results')).overflowY === 'auto'
    && getComputedStyle(panel().querySelector('.message-search-pagination')).flexShrink === '0',
  'Only search results scroll while numbered pagination remains fixed at the panel bottom');
  const resultSurfaceProbe = document.createElement('span');
  resultSurfaceProbe.style.backgroundColor = 'var(--bg-card)';
  document.body.append(resultSurfaceProbe);
  check(getComputedStyle(panel().querySelector('.message-search-result')).backgroundColor
    === getComputedStyle(resultSurfaceProbe).backgroundColor,
  'Search results use the app card surface instead of a detached light background');
  resultSurfaceProbe.remove();
  check(!panel().querySelector('script') && panel().querySelectorAll('img').length === 1
    && panel().querySelector('img').closest('.message-search-result-image') && !window.leaked,
  'Untrusted content stays escaped while a trusted attachment image can render');
  check(panel().querySelector('.message-search-result .chat-message-text strong')?.textContent === 'hello'
    && panel().querySelector('.message-search-result .md-code code')?.textContent.includes('const safe = true;'),
  'Search results use the same safe Markdown renderer as chat messages');
  const firstResult = panel().querySelector('.message-search-result');
  check(getComputedStyle(firstResult).cursor === 'pointer' && getComputedStyle(firstResult).userSelect === 'none'
    && getComputedStyle(firstResult.querySelector('.message-search-result-content strong')).userSelect === 'none'
    && getComputedStyle(firstResult.querySelector('.message-search-result-content strong')).cursor === 'pointer'
    && firstResult.querySelector('.message-search-result-jump').textContent
      === (language === 'en' ? 'Jump to message' : 'Ir para a mensagem'),
  'Result rows and rendered message descendants keep the navigation cursor and cannot be text-selected');
  const resultVideo = firstResult.querySelector('.message-search-result-video');
  const resultAudio = firstResult.querySelector('.message-search-result-audio');
  check(!!firstResult.querySelector('a[data-external-link="https://google.com"]')
    && !!firstResult.querySelector('.message-search-result-image img')
    && !resultVideo?.controls
    && !!resultVideo?.closest('.chat-video-player')?.querySelector('.chat-video-controls')
    && !resultAudio?.controls
    && !!resultAudio?.closest('.chat-audio-player')?.querySelector('.chat-audio-controls')
    && firstResult.querySelector('.message-search-result-file.chat-attachment-file')?.textContent.includes('qa.txt')
    && !firstResult.querySelector('.message-search-result-file')?.hasAttribute('title'),
  'Video and audio use the shared custom players while files reuse the standard attachment surface');
  yield 'search-media-hover';
  const cardProbe = document.createElement('span');
  cardProbe.style.backgroundColor = 'var(--bg-card)';
  document.body.append(cardProbe);
  check(getComputedStyle(firstResult).backgroundColor === getComputedStyle(cardProbe).backgroundColor
    && parseFloat(getComputedStyle(firstResult.querySelector('.message-search-result-jump')).opacity) === 0,
  'Hovering a downloadable file does not activate the outer navigation hover or jump label');
  cardProbe.remove();
  check(getComputedStyle(firstResult.querySelector('.message-search-result-audio-player .chat-video-volume-popup')).display === 'flex',
    'Audio volume control stays visible without requiring a precise hover');
  yield 'search-audio-volume';
  const audioPlayer = firstResult.querySelector('.message-search-result-audio-player');
  const audioVolumePopup = audioPlayer.querySelector('.chat-video-volume-popup');
  const audioVolume = audioPlayer.querySelector('.chat-video-volume');
  const audioSeek = audioPlayer.querySelector('.chat-video-seek');
  const audioSeekTrack = audioPlayer.querySelector('.chat-video-progress-shell > .chat-media-track');
  const audioPopupBox = audioVolumePopup.getBoundingClientRect();
  const audioPlayerBox = audioPlayer.getBoundingClientRect();
  check(getComputedStyle(audioVolumePopup).display === 'flex'
    && getComputedStyle(audioVolume).writingMode === 'horizontal-tb'
    && audioPopupBox.width > audioPopupBox.height
    && audioPopupBox.left >= audioPlayerBox.left && audioPopupBox.right <= audioPlayerBox.right
    && audioVolumePopup.previousElementSibling?.matches('[data-action="mute"]')
    && parseFloat(getComputedStyle(audioVolume).height) >= 20
    && parseFloat(getComputedStyle(audioPlayer.querySelector('[data-action="play"]')).width) >= 34
    && getComputedStyle(audioSeek).opacity === '0'
    && parseFloat(getComputedStyle(audioSeekTrack).height) <= 3.1
    && getComputedStyle(audioSeekTrack).backgroundImage.includes('linear-gradient'),
  'Media ranges keep thin tracks with accessible targets and visible unclipped audio volume');
  const link = firstResult.querySelector('a');
  link.addEventListener('click', event => event.preventDefault(), { once: true });
  link.click();
  check(navigation.length === 0, 'Clicking an interactive link does not jump to the message');
  const resultScroller = panel().querySelector('.message-search-results');
  const paginationTop = panel().querySelector('.message-search-pagination').getBoundingClientRect().top;
  const overflowResults = Array.from({ length: 24 }, () => resultScroller.firstElementChild.cloneNode(true));
  resultScroller.append(...overflowResults);
  resultScroller.scrollTop = resultScroller.scrollHeight;
  check(getComputedStyle(resultScroller.firstElementChild).flexShrink === '0'
    && resultScroller.scrollHeight > resultScroller.clientHeight
    && resultScroller.scrollTop > 0
    && panel().querySelector('.message-search-pagination').getBoundingClientRect().top === paginationTop,
  'A full page keeps card height, scrolls inside the result list and leaves pagination fixed');
  overflowResults.forEach(result => result.remove());
  resultScroller.scrollTop = 0;
  panel().querySelector('.message-search-result').click();
  check(navigation[0].join(',') === 'one,first', 'result jumps to exact channel and message');
  panel().querySelector('.message-search-pagination button:last-child').click();
  await flush();
  check(calls.at(-1).payload.cursor === 'page-two' && panel().querySelector('.message-search-result').dataset.messageId === 'second',
    'Cursor pagination opens the numbered second page');
  check(panel().querySelector('.message-search-page[aria-current=page]').textContent === '2',
    'Numbered pagination highlights page two');
  panel().querySelector('.message-search-pagination button:last-child').click();
  await flush();
  check(calls.at(-1).payload.cursor === 'page-three'
    && panel().querySelector('.message-search-result').dataset.messageId === 'third'
    && panel().querySelector('.message-search-pagination button:last-child').disabled
    && panel().querySelector('.message-search-page[aria-current=page]').textContent === '3',
  'Cursor pagination opens a third page and disables next at the end');
  panel().querySelector('.message-search-pagination button:first-child').click();
  await flush();
  check(calls.at(-1).payload.cursor === 'page-two'
    && panel().querySelector('.message-search-result').dataset.messageId === 'second',
  'Previous returns from the third to the second page with its stored cursor');
  panel().querySelector('.message-search-pagination button:first-child').click();
  await flush();
  check(calls.at(-1).payload.cursor === undefined
    && panel().querySelector('.message-search-result').dataset.messageId === 'first',
  'Previous returns to the first page and re-queries live permissions');
  panel().querySelector('.message-search-page[data-page="2"]').click();
  await flush();
  check(calls.at(-1).payload.cursor === 'page-three'
    && panel().querySelector('.message-search-result').dataset.messageId === 'third',
  'Clicking a known page number jumps directly to that cursor');
  panel().querySelector('.message-search-page[data-page="0"]').click();
  await flush();
  check(calls.at(-1).payload.cursor === undefined
    && panel().querySelector('.message-search-result').dataset.messageId === 'first',
  'Clicking page one returns directly to the first result page');
  delay = true;
  await submit();
  const stale = pending;
  canRead = false;
  invalidator();
  check(calls.at(-1).signal.aborted && panel().hidden && !panel().textContent, 'revocation aborts and clears retained DOM');
  stale({ messages: [message('stale')], total: 1 });
  await flush();
  check(panel().hidden && !panel().querySelector('.message-search-result'), 'late reply cannot restore revoked results');
  check(!keyboard('f').defaultPrevented, 'revoked Ctrl+F is not captured');
  canRead = true;
  invalidator();
  channelId = 'voice';
  check(keyboard('f').defaultPrevented, 'voice chat Ctrl+F opens message search');
  keyboard('Escape');
  channelId = 'one';
  keyboard('f');
  keyboard('Escape');
  check(!expanded && (panel().hidden || panel().hasAttribute('data-ui-closing'))
    && document.activeElement.classList.contains('message-search-launch'),
  'Escape closes, restores focus and restores the members sidebar');
  await Promise.allSettled(panel().getAnimations().map(animation => animation.finished));
  check(panel().hidden && !panel().textContent, 'Visual exit finishes by hiding and clearing the search panel');
  const outside = document.createElement('button');
  outside.textContent = 'Outside search';
  document.body.append(outside);
  outside.focus();
  outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  check(document.activeElement === outside, 'A closed search never steals focus from subsequent clicks');
  outside.remove();
  current = false;
  check(!keyboard('f').defaultPrevented, 'inactive session keyboard ignored');
  view.destroy();
  dateTimeControls.dispose();
  check(watches === 0 && !document.querySelector('.message-search-panel,.message-search-launch'), 'destroy unsubscribes and removes DOM');
  current = true;
  check(!keyboard('f').defaultPrevented, 'destroy removes keyboard listener');
  return checks;
}
