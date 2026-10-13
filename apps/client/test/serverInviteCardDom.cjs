const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  test('chat invitation cards name the server locally and open the join review', { timeout: 120000 }, async (t) => {
    const parent = path.join(clientRoot, 'dist-test');
    fs.mkdirSync(parent, { recursive: true });
    const profile = fs.mkdtempSync(path.join(parent, 'invite-card-'));
    const env = { ...process.env, MONKY_INVITE_CARD_PROFILE: profile, MONKY_HOME: path.join(profile, 'cli') };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const log = chunk => { output = (output + chunk.toString()).slice(-18000); };
    child.stdout.on('data', log);
    child.stderr.on('data', log);
    const deadline = setTimeout(() => child.kill(), 105000);
    t.after(async () => {
      clearTimeout(deadline);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    for (const line of output.split(/\r?\n/).filter(line => line.startsWith('Invite cards'))) t.diagnostic(line);
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const { createServerInviteAppLink, createServerInviteLink } = require('@monky/shared');
  app.disableHardwareAcceleration();
  app.setPath('userData', process.env.MONKY_INVITE_CARD_PROFILE);
  app.setPath('sessionData', process.env.MONKY_INVITE_CARD_PROFILE);
  app.on('window-all-closed', () => {});
  let vite;
  let browser;
  let deadline;
  const finish = async code => {
    clearTimeout(deadline);
    if (browser && !browser.isDestroyed()) browser.destroy();
    await vite?.close();
    app.exit(code);
  };
  const server = { v: 1, host: 'invite-card.test', port: 4321, name: '<img src=x data-injected> Sala & "teste"', password: 'fixture-only-password' };
  const event = { v: 1, host: '192.0.2.10', port: 3000, name: 'Agenda', eventId: 'event-123' };
  const unnamed = { v: 1, host: '[2001:db8::2]', port: 3000 };
  const fixture = {
    server,
    event,
    unnamed,
    pt: createServerInviteLink(server),
    en: createServerInviteLink(server, 'en'),
    legacy: createServerInviteLink(event).replace('/Monky/convite/', '/Monky/'),
    unnamedLink: createServerInviteLink(unnamed),
    native: createServerInviteAppLink(server),
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'invite-card-fixture',
        configureServer(viteServer) {
          viteServer.middlewares.use((request, response, next) => {
            if (request.url !== '/__invite_card__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    const http = vite.httpServer;
    if (!http) throw new Error('Missing fixture HTTP server');
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    browser = new BrowserWindow({
      show: false, width: 1050, height: 850, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    deadline = setTimeout(() => { console.error('Invite cards smoke timed out'); void finish(1); }, 90000);
    const run = source => browser.webContents.executeJavaScript(source, true);
    const waitFor = async (expression, message) => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (await run(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(message);
    };
    const press = keyCode => {
      browser.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      // Native buttons activate on the character event, as with a real keyboard.
      if (keyCode === 'Return') browser.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
      browser.webContents.sendInputEvent({ type: 'keyUp', keyCode });
    };
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`http://127.0.0.1:${address.port}/__invite_card__`);
      const checks = await run(`(${runInviteCardSmoke.toString()})(${JSON.stringify(language)}, ${JSON.stringify(fixture)})`);
      // Trusted keyboard: the native button is activated by Enter.
      await run(`document.querySelector('[data-message-id="mine"] .chat-invite-card-join').focus()`);
      press('Return');
      await waitFor(`!!document.querySelector('#join-invite-form [data-invite-host]')`, 'Enter on the card button opens the join review');
      assert.equal(await run(`document.querySelector('#join-invite-form [data-invite-host]').textContent`), server.host);
      assert.equal(await run(`document.querySelector('#invite-join-password').value`), server.password, 'the invitation password reaches only the review field');
      press('Escape');
      await waitFor(`!document.querySelector('#join-invite-form')`, 'Escape closes the review');
      assert.equal(await run(`document.activeElement?.classList.contains('chat-invite-card-join')`), true, 'focus returns to the card button');
      // Trusted pointer on the received event invitation.
      const point = await run(`(() => {
        const rect = document.querySelectorAll('[data-message-id="received"] .chat-invite-card-join')[0].getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await waitFor(`document.querySelector('#join-invite-form [data-invite-host]')?.textContent === ${JSON.stringify(event.host)}`, 'pointer on the card button opens the event invitation');
      await run(`document.querySelector('#join-invite-form [data-invite-cancel]').click()`);
      await waitFor(`!document.querySelector('#join-invite-form')`, 'cancel closes the review');
      console.log(`Invite cards (${language}): ${checks} DOM checks, keyboard and pointer passed`);
    }
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runInviteCardSmoke(language, fixture) {
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  const [{ setLanguage, t }, cards, { renderMarkdown }, { linkPreviewService }] = await Promise.all([
    import('/i18n/index.ts'), import('/views/ServerInviteCard.ts'), import('/utils/markdown.ts'),
    import('/core/LinkPreviewService.ts'),
  ]);
  setLanguage(language);
  const fetched = [];
  window.api = { fetchLinkPreview: async url => { fetched.push(url); return null; } };
  const row = (id, user, markdown, extra = '') => `
    <div class="chat-message-row" data-user-id="${user}" data-message-id="${id}">
      <div class="chat-message-body">
        <div class="chat-message-text">${extra}${renderMarkdown(markdown)}</div>
        <div class="chat-link-previews"></div>
      </div>
    </div>`;
  const quote = `<span class="chat-quote-preview">${renderMarkdown(fixture.pt, { interactive: false })}</span>`;
  document.querySelector('#app').innerHTML = `<div id="feed">
    ${row('mine', 'me', `Entra aí: ${fixture.pt} e ${fixture.en} ou https://example.org/page`)}
    ${row('received', 'friend', `${fixture.legacy} ${fixture.unnamedLink} [evento](${fixture.legacy})`)}
    ${row('ignored', 'friend', '```\n' + fixture.pt + '\n```\nhttps://example.org/#~Aw https://monkyorg.github.io/Monky/convite/#~invalid ' + fixture.native)}
    ${row('quoted', 'friend', 'respondendo', quote)}
  </div>`;
  const feed = document.querySelector('#feed');
  const isSent = element => element.dataset.userId === 'me';
  cards.mountServerInviteCards(feed, isSent);
  cards.mountServerInviteCards(feed, isSent);
  const cardsOf = id => [...document.querySelectorAll(`[data-message-id="${id}"] .chat-invite-card`)];

  const mine = cardsOf('mine');
  check(mine.length === 1, 'PT and EN links of the same invitation make one card, even after mounting twice');
  check(document.querySelectorAll('[data-message-id="mine"] .chat-invite-cards').length === 1, 'remounting replaces instead of stacking');
  check(document.querySelector('[data-message-id="mine"] .chat-message-text').nextElementSibling?.classList.contains('chat-invite-cards'),
    'the card sits right below the message text');
  const card = mine[0];
  check(card.querySelector('.chat-invite-card-heading').textContent === t('invite.cardSent'), 'own message says the invitation was sent');
  check(card.querySelector('.chat-invite-card-name').textContent === fixture.server.name, 'the server name comes from the link');
  check(!card.querySelector('[data-injected]'), 'the name chosen by the sender is text, never markup');
  check(card.querySelector('.chat-invite-card-address').textContent === `${fixture.server.host}:${fixture.server.port}`,
    'the address stays visible next to the sender-chosen name');
  check(card.querySelector('.chat-invite-card-icon').textContent === 'I', 'the icon uses the first letter, skipping symbols');
  check(!card.innerText.includes(fixture.server.password) && !card.outerHTML.includes(fixture.server.password),
    'the password never appears in the card');
  check(card.getAttribute('role') === 'group' && card.getAttribute('aria-label').includes(fixture.server.name), 'the card is announced with its server');
  const join = card.querySelector('.chat-invite-card-join');
  check(join.tagName === 'BUTTON' && join.type === 'button' && join.textContent === t('invite.cardJoin'), 'a native button joins');
  check(join.getAttribute('aria-label') === t('invite.cardJoinLabel', { name: fixture.server.name }), 'the button names the server for assistive technology');
  check(getComputedStyle(join).backgroundColor !== 'rgba(0, 0, 0, 0)', 'the join button uses the app button style');

  const received = cardsOf('received');
  check(received.length === 2, 'distinct invitations each get a card; a repeated one does not');
  check(received[0].querySelector('.chat-invite-card-heading').textContent === t('invite.cardEventReceived'), 'older home links still decode, as events');
  check(received[0].querySelector('.chat-invite-card-name').textContent === 'Agenda', 'event invitations name their server');
  check(received[1].querySelector('.chat-invite-card-heading').textContent === t('invite.cardReceived'), 'received invitations say so');
  check(received[1].querySelector('.chat-invite-card-name').textContent === fixture.unnamed.host, 'an unnamed invitation shows its host');
  check(received[1].querySelector('.chat-invite-card-icon').textContent === '2', 'an IPv6 host still gets a readable icon');
  check(cardsOf('ignored').length === 0, 'code blocks, other sites, invalid tokens and plain native text make no card');
  check(cardsOf('quoted').length === 0, 'a quoted invitation keeps its card on the original message only');

  // An invalid link legitimately falls back to the generic page preview, so only valid rows are checked here.
  linkPreviewService.initializePreviews(document.querySelector('[data-message-id="mine"]'));
  linkPreviewService.initializePreviews(document.querySelector('[data-message-id="received"]'));
  await flush();
  check(fetched.length === 1 && fetched[0] === 'https://example.org/page', 'invitations never fetch the generic docs page preview');

  check(cards.openServerInviteLink('https://example.org/page') === false, 'other links keep opening in the browser');
  check(cards.serverInviteFromLink(fixture.en)?.host === fixture.server.host, 'English links decode');
  const compose = document.createElement('div');
  compose.innerHTML = cards.renderComposeServerInvite(fixture.event);
  check(compose.querySelector('.compose-link-preview-site').textContent === t('invite.cardComposeEvent'), 'the composer labels the invitation before it is sent');
  check(compose.querySelector('.compose-link-preview-title').textContent === 'Agenda', 'the composer names the server');
  check(cards.openServerInviteLink(fixture.pt) === true, 'clicking the invitation link itself opens the review');
  await flush();
  check(document.querySelector('#join-invite-form [data-invite-host]')?.textContent === fixture.server.host, 'the review shows the address');
  document.querySelector('#join-invite-form [data-invite-cancel]').click();
  for (let attempt = 0; attempt < 100 && document.querySelector('#join-invite-form'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  check(!document.querySelector('#join-invite-form'), 'cancelling closes the review');
  return checks;
}
