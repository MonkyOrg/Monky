/**
 * Gera as imagens de prévia (Open Graph) do site a partir de `template.html`.
 *
 * Rode `node docs-site/og/gerar.mjs` depois de mudar o modelo e commite os
 * JPEGs de `docs-site/public/og/` junto. Elas são estáticas de propósito: o
 * build do site não depende de navegador, e a mesma imagem serve a todas as
 * páginas de uma seção (`.vitepress/config.ts` escolhe qual).
 *
 * Usa o Chrome ou o Edge instalado, pelo protocolo DevTools, porque só ele
 * entrega JPEG — o `--screenshot` da linha de comando salva PNG, e os apps de
 * mensagem descartam imagens grandes. Aponte `CHROME_BIN` para outro binário
 * se o seu não estiver num caminho conhecido. Precisa de `npm ci` antes: as
 * fontes vêm de `node_modules`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '..', 'public', 'og');
const template = pathToFileURL(join(here, 'template.html')).href;
const variants = ['home', 'download', 'guias', 'bots'];
const languages = ['pt', 'en'];
const width = 1200;
const height = 630;

function findBrowser() {
  const candidates = [
    process.env.CHROME_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = candidates.find(candidate => candidate && existsSync(candidate));
  if (!found) throw new Error('Chrome/Edge não encontrado. Defina CHROME_BIN com o caminho do executável.');
  return found;
}

function launch(binary, profile) {
  const child = spawn(binary, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolvePort, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`O navegador não abriu a porta de depuração:\n${log}`)), 15_000);
    child.stderr.on('data', chunk => {
      log += chunk;
      const match = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(log);
      if (match) {
        clearTimeout(timer);
        resolvePort({ child, port: Number(match[1]) });
      }
    });
    child.once('exit', code => reject(new Error(`O navegador saiu com o código ${code}:\n${log}`)));
  });
}

function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`${message.error.message} (${request.method})`));
      else request.resolve(message.result);
    } else {
      listeners.get(message.method)?.(message.params);
    }
  });
  const send = (method, params = {}) => new Promise((resolveSend, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolveSend, reject, method });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const once = method => new Promise(resolveOnce => listeners.set(method, resolveOnce));
  return new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', () => resolveOpen({ send, once, close: () => socket.close() }));
    socket.addEventListener('error', () => reject(new Error(`Falha ao conectar em ${url}`)));
  });
}

async function render(page, variant, language) {
  const loaded = page.once('Page.loadEventFired');
  await page.send('Page.navigate', { url: `${template}?variant=${variant}&lang=${language}` });
  await loaded;
  // O load não espera as fontes: sem isto os ícones saem como o nome em texto.
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
    expression: `document.fonts.ready.then(() => Promise.all([...document.images].map(image => image.decode())))
      .then(() => [...document.fonts].filter(font => font.status !== 'loaded').map(font => font.family))`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error(`O modelo falhou em ${variant}/${language}: ${exceptionDetails.text}`);
  if (result.value.length) throw new Error(`Fontes não carregadas: ${result.value.join(', ')}. Rode npm ci.`);
  const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  return Buffer.from(data, 'base64');
}

const profile = mkdtempSync(join(tmpdir(), 'monky-og-'));
const { child, port } = await launch(findBrowser(), profile);
try {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  const page = await connect(target.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  mkdirSync(output, { recursive: true });
  for (const variant of variants) {
    for (const language of languages) {
      const file = join(output, `${variant}-${language}.jpg`);
      const image = await render(page, variant, language);
      writeFileSync(file, image);
      console.log(`${file} (${Math.round(image.length / 1024)} KB)`);
    }
  }
  page.close();
} finally {
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  child.kill();
  await exited;
  // No Windows o perfil fica travado por um instante depois que o processo sai.
  rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
