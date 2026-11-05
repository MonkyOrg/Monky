// Builds the miniapps site of the web version (#858): the page a bot miniapp's
// frame loads, which receives the document from the app and writes it into
// itself, plus the Vercel configuration that serves it. Both come from the
// shared constants, so the app, the page and its headers cannot drift apart.
//
//   node scripts/buildMiniapps.mjs          -> dist-miniapps/ (deployed as is)
//   node scripts/buildMiniapps.mjs --serve  -> also serves it on MINIAPPS_DEV_URL
//
// MONKY_WEB_APP_ORIGINS (comma separated) adds origins allowed to embed it;
// --serve adds the web dev server.
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Ports of `npm run dev:web` and of the miniapps site it opens miniapps from. */
export const WEB_DEV_PORT = 5174;
export const MINIAPPS_DEV_URL = 'http://localhost:5175/';

/** Runs inside the miniapp frame before the document replaces the page. */
function loader(origins, messages) {
  const token = location.hash.slice(1);
  const host = window.parent;
  if (host === window || !/^[0-9a-f-]{36}$/.test(token)) return;
  const receive = (event) => {
    const data = event.data;
    if (event.source !== host || !origins.includes(event.origin) || !data || data.type !== messages.document ||
        data.token !== token || typeof data.html !== 'string') return;
    window.removeEventListener('message', receive);
    document.open();
    document.write(data.html);
    document.close();
  };
  window.addEventListener('message', receive);
  // After this page's own load, so the frame's next load is the miniapp's.
  window.addEventListener('load', () => host.postMessage({ type: messages.ready, token }, '*'), { once: true });
}

function buildMiniapps(serve) {
  const require = createRequire(import.meta.url);
  const { BOT_SCREEN_CSP, MINIAPP_LOADER_MESSAGES, MINIAPP_LOADER_PAGE, MONKY_WEB_APP_URL } = require('@monky/shared');
  const output = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist-miniapps');
  const publicDir = path.join(output, 'public');
  const appOrigins = [...new Set([
    new URL(MONKY_WEB_APP_URL).origin,
    ...(process.env.MONKY_WEB_APP_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean)
      .map((value) => new URL(value).origin),
    ...(serve ? [`http://localhost:${WEB_DEV_PORT}`] : []),
  ])];

  const page = '<!doctype html><html><head><meta charset="utf-8"><title>Monky</title></head><body>' +
    `<script>(${loader.toString()})(${JSON.stringify(appOrigins)},${JSON.stringify(MINIAPP_LOADER_MESSAGES)});</script></body></html>`;
  const headers = [
    { key: 'Content-Security-Policy', value: `${BOT_SCREEN_CSP}; frame-ancestors ${appOrigins.join(' ')}` },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'no-referrer' },
    { key: 'Cache-Control', value: 'no-store' },
    // Only the app frames this site; it is not a page to find or share.
    { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  ];

  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, MINIAPP_LOADER_PAGE), page);
  fs.writeFileSync(path.join(output, 'vercel.json'), `${JSON.stringify({
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: null,
    installCommand: '',
    buildCommand: '',
    outputDirectory: 'public',
    headers: [{ source: '/(.*)', headers }],
  }, null, 2)}\n`);
  console.log(`Miniapps site in ${output}, embeddable by ${appOrigins.join(', ')}`);

  if (!serve) return;
  http.createServer((request, response) => {
    if (new URL(request.url ?? '/', MINIAPPS_DEV_URL).pathname !== `/${MINIAPP_LOADER_PAGE}`) {
      response.writeHead(404).end();
      return;
    }
    for (const { key, value } of headers) response.setHeader(key, value);
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(page);
  }).listen(Number(new URL(MINIAPPS_DEV_URL).port), () => console.log(`Serving the miniapps site on ${MINIAPPS_DEV_URL}`));
}

// Importing this module (vite.config.ts reads the ports) builds nothing.
if (process.argv[1] === fileURLToPath(import.meta.url)) buildMiniapps(process.argv.includes('--serve'));
