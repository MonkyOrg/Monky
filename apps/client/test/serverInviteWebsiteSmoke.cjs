const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const clientRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(clientRoot, '..', '..');

if (!process.versions.electron) {
  test('invitation website provides localized app/download/copy fallbacks without transmitting the payload', {
    timeout: 120_000,
  }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `invite-website-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_INVITE_WEBSITE_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = (command, args) => new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('exit', code => {
        if (code !== 0) reject(new Error(output || `Command exited with ${code}`));
        else resolve(output);
      });
    });
    try {
      await run(process.execPath, [path.join(repoRoot, 'node_modules', 'vitepress', 'bin', 'vitepress.js'),
        'build', path.join(repoRoot, 'docs-site')]);
      console.log(await run(require('electron'), [__filename]));
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const { app, BrowserWindow } = require('electron');
  const { createServerInviteLink, parseServerInviteLink } = require('@monky/shared');
  app.setPath('userData', process.env.MONKY_INVITE_WEBSITE_PROFILE);
  app.on('window-all-closed', () => {});
  const dist = path.join(repoRoot, 'docs-site', '.vitepress', 'dist');
  const requests = [];
  const attempts = [];
  let window, server, timer;
  const finish = async code => {
    clearTimeout(timer);
    if (window && !window.isDestroyed()) window.destroy();
    await new Promise(resolve => server ? server.close(resolve) : resolve());
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timer = setTimeout(() => { console.error('Invitation website smoke timed out'); void finish(1); }, 50_000);
    server = http.createServer((request, response) => {
      requests.push(request.url);
      const pathname = new URL(request.url, 'http://localhost').pathname;
      let file = path.resolve(dist, `.${decodeURIComponent(pathname.replace(/^\/Monky/, ''))}`);
      if ((file === dist || file.startsWith(dist + path.sep)) && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        file = path.join(file, 'index.html');
      }
      if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        response.writeHead(404).end();
        return;
      }
      const contentType = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
        '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
      }[path.extname(file)] ?? 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(file).pipe(response);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    window = new BrowserWindow({
      show: false, useContentSize: true, width: 800, height: 800,
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false },
    });
    window.webContents.setAudioMuted(true);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('monky:')) {
        event.preventDefault();
        attempts.push(url);
      }
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    // Intercept only inside this disposable Electron session, never the OS association.
    window.webContents.session.protocol.handle('monky', request => {
      attempts.push(request.url);
      return new Response(null, { status: 204 });
    });
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !details.url.startsWith(origin + '/') && !details.url.startsWith('monky:') });
    });
    const read = source => window.webContents.executeJavaScript(source, true);
    const wait = predicate => read(`(async () => {
      for (let i = 0; i < 150; i++) {
        if (${predicate}) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Invitation page did not reach the expected state');
    })()`);
    const invite = { v: 1, host: 'invite-fixture.test', port: 4321, name: '\ufeffSala <em> & teste', password: '\ufefffixture-only-password' };
    const link = createServerInviteLink(invite);
    for (const language of ['pt-BR', 'en']) {
      const prefix = language === 'en' ? '/Monky/en/' : '/Monky/';
      await window.loadURL(`${origin}${prefix}${new URL(link).hash}`).catch(error => {
        if (error.code !== 'ERR_ABORTED' || !error.url?.startsWith('monky:')) throw error;
      });
      await wait(`document.querySelector('.invite-actions button')`);
      assert.ok(window.webContents.getURL().startsWith(origin + prefix), 'blocked native handoff leaves the web fallback visible');
      const page = await read(`({
        host: document.querySelector('[data-invite-host]').textContent,
        port: document.querySelector('[data-invite-port]').textContent,
        text: document.querySelector('.server-invite').innerText,
        app: document.querySelector('.invite-primary').href,
        download: document.querySelector('.invite-actions a:last-child').getAttribute('href'),
        injected: !!document.querySelector('.server-invite em'),
      })`);
      assert.equal(page.host, invite.host);
      assert.equal(page.port, String(invite.port));
      assert.deepEqual(parseServerInviteLink(page.app), { ok: true, invite });
      assert.ok(page.app.startsWith('monky://#~'), 'the complete invitation reaches the minimal native URI');
      assert.equal(await read(`!!document.querySelector('.VPHero')`), false, 'the invitation is the landing view, not hidden below the home hero');
      assert.equal(page.download, `${prefix}download.html`);
      assert.equal((await fetch(origin + page.download)).status, 200, 'download fallback points to a real page');
      assert.equal(page.injected, false);
      assert.equal(page.text.includes(invite.password), false, 'the credential is not visible page text');
      assert.match(page.text, language === 'en' ? /Open in Monky/ : /Abrir no Monky/);
      const beforeManual = attempts.length;
      await read(`document.querySelector('.invite-primary').click();`);
      const manualDeadline = Date.now() + 3000;
      while (attempts.length === beforeManual && Date.now() < manualDeadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(attempts.length > beforeManual, 'the manual Open in Monky button dispatches the native URI');
      assert.deepEqual(parseServerInviteLink(attempts.at(-1)), { ok: true, invite });
      await read(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async value => { window.inviteCopied = value; },
      } }); document.querySelector('.invite-actions button').click();`);
      await wait(`window.inviteCopied`);
      assert.deepEqual(parseServerInviteLink(await read('window.inviteCopied')), { ok: true, invite });
      await wait(`document.querySelector('.server-invite [role="status"]')`);
      await read(`navigator.clipboard.writeText = async () => { throw new Error('Fixture clipboard denial'); };
        document.querySelector('.invite-actions button').click();`);
      await wait(`document.querySelector('.server-invite [role="status"]').textContent.includes(${JSON.stringify(language === 'en' ? 'Could not copy' : 'Não foi possível copiar')})`);
      await read(`window.location.hash = '~invalid-invitation';`);
      await wait(`document.querySelector('.server-invite [role="alert"]')`);
      assert.equal(await read(`!!document.querySelector('.invite-actions')`), false, 'malformed links never enable an app action');
      const beforeHome = attempts.length;
      await read(`window.location.hash = '';`);
      await wait(`document.querySelector('.VPHero') && !document.querySelector('.server-invite')`);
      await read(`window.location.hash = 'ordinary-home-anchor';`);
      assert.equal(await read(`!!document.querySelector('.server-invite')`), false, 'normal home anchors are not treated as invitations');
      assert.equal(attempts.length, beforeHome, 'returning to the homepage does not relaunch a stale invitation');
      await read(`window.location.hash = ${JSON.stringify(new URL(link).hash)};`);
      await wait(`document.querySelector('.invite-actions button')`);
      await read(`document.querySelector('.invite-actions a:last-child').click();`);
      await wait(`!document.querySelector('.server-invite') && location.pathname === ${JSON.stringify(prefix + 'download.html')}`);
      await read(`(() => {
        const anchor = document.createElement('a');
        anchor.href = ${JSON.stringify(origin + prefix + new URL(link).hash)};
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      })();`);
      await wait(`document.querySelector('.invite-actions button')`);
    }
    assert.ok(attempts.length >= 2, 'each valid page attempts to open the app before offering manual fallback');
    const handoffs = attempts.map(url => parseServerInviteLink(url)).filter(result => result.ok);
    assert.ok(handoffs.length >= 2, 'native handoff retains the fragment rather than only a scheme without connection data');
    for (const result of handoffs) assert.deepEqual(result.invite, invite, 'native handoff preserves every field');
    assert.ok(requests.every(url => !url.includes('#') && !url.includes(invite.password) && !url.includes(new URL(link).hash.slice(1))),
      'no HTTP request contains the invitation or its password');
    console.log('Invitation website: PT/EN, native handoff, real download targets, clipboard, validation and fragment privacy passed.');
    await finish(0);
  }).catch(async error => {
    console.error('Invitation website smoke failed', error);
    await finish(1);
  });
}
