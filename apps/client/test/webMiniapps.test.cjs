const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { MINIAPP_LOADER_MESSAGES } = require('@monky/shared');

const TOKEN = '3dfbff6f-6556-49cb-be32-1a6699d242a1';
const APP = 'https://monkyweb.vercel.app';

/** The miniapps page as a browser runs it: its loader, a parent app and the network calls a miniapp makes. */
async function miniappPage() {
  const { loader } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'buildMiniapps.mjs')).href);
  const posted = [];
  const calls = [];
  class Native {
    constructor(url) { calls.push(`${this.constructor.name} ${url}`); }
  }
  class WebSocket extends Native {}
  class EventSource extends Native {}
  class XMLHttpRequest { open(method, url) { calls.push(`XMLHttpRequest ${method} ${url}`); } }
  const parent = { postMessage: (message, target) => posted.push({ message, target }) };
  const window = {
    parent, WebSocket, EventSource, XMLHttpRequest,
    location: { hash: `#${TOKEN}`, href: `https://monky-miniapps.vercel.app/frame.html#${TOKEN}` },
    fetch: (input) => { calls.push(`fetch ${input}`); return Promise.resolve('response'); },
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const context = vm.createContext({ window, location: window.location, XMLHttpRequest, Request: class {}, URL });
  vm.runInContext(`(${loader.toString()})(${JSON.stringify([APP])}, ${JSON.stringify(MINIAPP_LOADER_MESSAGES)})`, context);
  // Messages come from the page's own realm: compare their content.
  const insecure = () => JSON.parse(JSON.stringify(posted.filter(({ message }) => message.type === MINIAPP_LOADER_MESSAGES.insecure)));
  return { window, calls, insecure };
}

test('a web miniapp reaching a plain http/ws service tells the app which one, once (#858)', async () => {
  const page = await miniappPage();
  assert.equal(await page.window.fetch('http://203.0.113.9:7780/rom'), 'response', 'the call itself goes on unchanged');
  await page.window.fetch('http://203.0.113.9:7780/again');
  new page.window.WebSocket('ws://203.0.113.9:7781/play');
  new page.window.XMLHttpRequest().open('GET', 'http://198.51.100.4/state');
  assert.deepEqual(page.insecure().map(({ message }) => message),
    ['http://203.0.113.9:7780', 'ws://203.0.113.9:7781', 'http://198.51.100.4'].map(origin =>
      ({ type: MINIAPP_LOADER_MESSAGES.insecure, token: TOKEN, origin })));
  assert.deepEqual(page.calls, ['fetch http://203.0.113.9:7780/rom', 'fetch http://203.0.113.9:7780/again',
    'WebSocket ws://203.0.113.9:7781/play', 'XMLHttpRequest GET http://198.51.100.4/state']);
});

test('secure services and the user\'s own machine are never reported (#858)', async () => {
  const page = await miniappPage();
  await page.window.fetch('https://games.example.com/rom');
  new page.window.WebSocket('wss://games.example.com/play');
  new page.window.EventSource('/events');
  await page.window.fetch('http://localhost:8080/rom');
  new page.window.WebSocket('ws://127.0.0.1:7781');
  assert.deepEqual(page.insecure(), []);
  assert.equal(page.calls.length, 5);
});
