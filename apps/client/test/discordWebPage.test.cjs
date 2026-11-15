'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadMain } = require('./mainModules.cjs');

const { LAYERS_PROBE, settleLayers } = loadMain('discordWebPage', { packages: { electron: {} } });

const tooltip = { kind: 'tooltip', x: 80, y: 120, width: 60, height: 32, radius: 4, shown: true };
const menu = { kind: 'menu', x: 80, y: 200, width: 180, height: 240, radius: 8, shown: true };
const layers = (popups, modal = null) => ({ popups, modal, servers: null });
const held = popup => ({ ...popup, shown: false });

test('a menu or tooltip is drawn whole only after it stays in the same place, and is known meanwhile', () => {
  let state = settleLayers([], layers([tooltip]), 1000);
  // Left out, it would count as no popup: Monky would keep it in its clean picture and show it twice.
  assert.deepEqual(state.layers.popups, [held(tooltip)], 'a popup that just appeared is known but not drawn yet');
  assert.equal(state.wait, 80);
  state = settleLayers(state.seen, layers([tooltip]), 1050);
  assert.deepEqual(state.layers.popups, [held(tooltip)]);
  assert.equal(state.wait, 30, 'the next check comes when it settles');
  state = settleLayers(state.seen, layers([tooltip]), 1080);
  assert.deepEqual(state.layers.popups, [tooltip]);
  assert.equal(state.wait, null);
  // The tooltip of the next server moves it: it waits again.
  const moved = { ...tooltip, y: 168 };
  state = settleLayers(state.seen, layers([moved]), 1090);
  assert.deepEqual(state.layers.popups, [held(moved)]);
  state = settleLayers(state.seen, layers([{ ...moved, height: 48 }]), 1170);
  assert.deepEqual(state.layers.popups, [held({ ...moved, height: 48 })], 'a popup that changed size waits again');
});

test('a fading popup is handed on without holding the next check', () => {
  const fading = held(tooltip);
  const state = settleLayers([], layers([fading]), 0);
  assert.deepEqual(state.layers.popups, [fading]);
  assert.equal(state.wait, null);
});

test('each popup settles on its own and a Discord window is never held back', () => {
  let state = settleLayers([], layers([menu], { left: 0 }), 0);
  assert.deepEqual(state.layers.modal, { left: 0 });
  state = settleLayers(state.seen, layers([menu, tooltip], { left: 0 }), 100);
  assert.deepEqual(state.layers.popups, [menu, held(tooltip)], 'a settled menu stays while a new tooltip settles');
  assert.equal(state.wait, 80);
  state = settleLayers(state.seen, layers([]), 120);
  assert.deepEqual(state, { seen: [], layers: layers([]), wait: null });
});

const node = (styles, parent = null, extra = {}) => ({
  styles, parentElement: parent, children: [], closest: () => null,
  contains(other) { for (let at = other; at; at = at.parentElement) if (at === this) return true; return false; },
  ...extra,
});
const probe = (elements, tree = null, corner = [], scrim = null) => vm.runInNewContext(LAYERS_PROBE, {
  document: {
    querySelectorAll: selector => elements.filter(element => selector.split(',').some(part => {
      const [, role] = /^\s*\[role="(\w+)"\]\s*$/.exec(part) ?? [];
      return role === element.getAttribute('role');
    })),
    querySelector: selector => (selector === '[data-list-id="guildsnav"]' ? tree : null),
    elementsFromPoint: () => corner,
    elementFromPoint: () => scrim,
  },
  innerHeight: 1018,
  innerWidth: 2560,
  getComputedStyle: element => ({ visibility: 'visible', borderTopLeftRadius: '0px', overflowY: 'visible', ...element.styles }),
});

test('the probe reports fading menus and tooltips as not shown and skips invisible ones', () => {
  const popup = (role, styles, parent, box = { left: 10, top: 20, width: 50, height: 30 }) => node(styles, parent, {
    getAttribute: () => role, getBoundingClientRect: () => box,
  });
  const elements = [
    popup('tooltip', { opacity: '1' }, node({ opacity: '0.97' })),
    popup('tooltip', { opacity: '1' }, node({ opacity: '0.5' })),
    popup('tooltip', { opacity: '0' }, null),
    popup('menu', { opacity: '1', visibility: 'hidden' }, null),
    popup('menu', { opacity: '1' }, null, { left: 0, top: 0, width: 0, height: 0 }),
    popup('menu', { opacity: '1', borderTopLeftRadius: '8px' }, null),
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(probe(elements))), {
    popups: [
      { kind: 'tooltip', x: 10, y: 20, width: 50, height: 30, radius: 0, shown: true },
      { kind: 'tooltip', x: 10, y: 20, width: 50, height: 30, radius: 0, shown: false },
      { kind: 'menu', x: 10, y: 20, width: 50, height: 30, radius: 8, shown: true },
    ],
    modal: null,
    servers: null,
  });
});

test('the probe reports Discord\'s popouts, like a profile card, as menus, but not its modal windows or whole screens', () => {
  const dialog = (box, modal = false) => node({ opacity: '1', borderTopLeftRadius: '8px' }, null, {
    getAttribute: name => (name === 'role' ? 'dialog' : name === 'aria-modal' && modal ? 'true' : null),
    getBoundingClientRect: () => box,
  });
  const card = dialog({ left: 8, top: 48, width: 300, height: 534 }, true);
  const screen = dialog({ left: 0, top: 0, width: 2560, height: 1018 });
  const page = { left: 0, top: 0, width: 2560, height: 1018 };
  // The account card is marked aria-modal too, but the box it lays over the page to catch clicks is clear.
  const trap = node({ backgroundColor: 'rgba(0, 0, 0, 0)' }, null, { getBoundingClientRect: () => page });
  const shown = probe([card, screen], null, [], trap);
  assert.deepEqual(JSON.parse(JSON.stringify(shown.popups)),
    [{ kind: 'menu', x: 8, y: 48, width: 300, height: 534, radius: 8, shown: true }]);
  assert.equal(shown.modal, null);
  // A modal window dims the page behind its card.
  const scrim = node({ backgroundColor: 'oklab(0 0 0 / 0.72)' }, null, { getBoundingClientRect: () => page });
  const dimmed = probe([dialog({ left: 600, top: 200, width: 440, height: 600 }, true), screen], null, [], scrim);
  assert.deepEqual(dimmed.popups.length, 0);
  assert.deepEqual({ ...dimmed.modal }, { left: 600 }, 'it tells where the window starts');
  // A modal window filling the page needs no dimming to count as one.
  assert.deepEqual({ ...probe([dialog(page, true), dialog({ left: 600, top: 200, width: 440, height: 600 }, true)], null, [], trap).modal }, { left: 0 },
    'one filling the page starts at its left edge, whatever lies over it');
});

test('the probe reads where Discord\'s server list is and how far it has scrolled', () => {
  const scroller = node({ overflowY: 'scroll' }, null, {
    clientHeight: 1252, scrollTop: 21, scrollHeight: 1273,
    getBoundingClientRect: () => ({ left: 0, top: 32, width: 72, height: 1252 }),
  });
  const tree = node({}, null, { children: [node({}), scroller] });
  assert.deepEqual(JSON.parse(JSON.stringify(probe([], tree))).servers,
    { top: 32, height: 1252, scrollTop: 21, scrollHeight: 1273, panel: null });
});

test('the probe measures Discord\'s user panel, which grows in a call, from the box that covers the list\'s bottom', () => {
  const box = (left, top, width, height) => () => ({ left, top, width, height, right: left + width, bottom: top + height });
  const sidebar = node({}, null, { getBoundingClientRect: box(0, 32, 375, 986) });
  const tree = node({}, sidebar, { getBoundingClientRect: box(0, 32, 72, 986) });
  const scroller = node({ overflowY: 'scroll' }, tree, {
    clientHeight: 986, scrollTop: 0, scrollHeight: 1400, getBoundingClientRect: box(0, 32, 72, 986),
  });
  tree.children = [scroller];
  const panel = node({}, sidebar, { getBoundingClientRect: box(8, 858, 359, 152) });
  const voice = node({}, panel, { getBoundingClientRect: box(8, 858, 359, 94) });
  const tooltip = node({}, null, { closest: () => tooltip, getBoundingClientRect: box(30, 980, 80, 30) });
  assert.equal(probe([], tree, [tooltip, voice, panel, sidebar]).servers.panel, 160);
  // A box as tall as the page at that corner is not a panel.
  const layer = node({}, null, { getBoundingClientRect: box(0, 0, 2560, 1018) });
  assert.equal(probe([], tree, [layer]).servers.panel, null);
});
/** A debugger's on, gathering into handlers one function per event that calls every listener in turn. */
function listenInto(handlers) {
  return (name, handler) => {
    const earlier = handlers[name];
    handlers[name] = earlier ? (...args) => { earlier(...args); handler(...args); } : handler;
  };
}

/**
 * Opens a Discord page on fake Electron pieces: `debuggerApi` stands for DevTools, `inputs` gathers what the page itself
 * receives, `seen` what the page set up (its window's options, its handlers and its session's permission handler).
 */
function openPage(debuggerApi, { zoom = 1, inputs = [], events = {}, seen = {}, url = 'https://discord.com/channels/@me', run = async () => undefined, dialog = {} } = {}) {
  const noop = () => undefined;
  seen.on = {};
  seen.once = {};
  const contents = {
    debugger: debuggerApi,
    executeJavaScriptInIsolatedWorld: run,
    isDestroyed: () => false, on: (name, handler) => { seen.on[name] = handler; }, once: (name, handler) => { seen.once[name] = handler; },
    removeListener: (name, handler) => { if (seen.once[name] === handler) delete seen.once[name]; },
    reloadIgnoringCache: () => { seen.reloads = (seen.reloads ?? 0) + 1; }, setFrameRate: noop,
    setWindowOpenHandler: noop, loadURL: async () => undefined, getURL: () => url,
    getZoomFactor: () => zoom, setZoomFactor: noop, isPainting: () => false, startPainting: noop, stopPainting: noop, invalidate: noop,
    sendInputEvent: event => inputs.push(event),
  };
  class BrowserWindow {
    constructor(options) { seen.options = options; this.webContents = contents; }
    isDestroyed() { return false; }
    once() {}
    destroy() {}
    getContentSize() { return [100, 100]; }
    setContentSize() {}
  }
  const discordSession = new Proxy({ setPermissionRequestHandler: handler => { seen.permission = handler; } }, {
    get: (target, name) => target[name] ?? noop,
  });
  const session = { fromPartition: () => discordSession };
  const app = { getName: () => 'Monky', userAgentFallback: 'Mozilla/5.0 Chrome/1 Electron/1 Monky/1' };
  const { DiscordWebPage } = loadMain('discordWebPage', {
    packages: { electron: { app, BrowserWindow, session, dialog, screen: { getDisplayMatching: () => ({ scaleFactor: 1 }) }, shell: {} } },
  });
  const owner = { isDestroyed: () => false, getBounds: () => ({}), webContents: { getZoomFactor: () => zoom } };
  seen.owner = owner;
  const page = new DiscordWebPage(owner, events);
  page.open();
  return page;
}

test('the page shows its text cursor only while Monky\'s keyboard is on it and it is on screen', () => {
  const sent = [];
  const handlers = {};
  let attached = false;
  const page = openPage({
    isAttached: () => attached,
    attach: () => { attached = true; },
    on: listenInto(handlers),
    sendCommand: async (method, params) => { sent.push(`${method}:${params.enabled}`); },
  });
  page.layout(100, 100, true);
  assert.deepEqual(sent, [], 'a page Monky shows but does not type into stays unfocused, so Discord keeps notifying');
  page.focus(true);
  page.focus(true);
  assert.deepEqual(sent, ['Emulation.setFocusEmulationEnabled:true']);
  page.layout(100, 100, false);
  page.layout(100, 100, true);
  page.focus(false);
  assert.deepEqual(sent.slice(1), ['Emulation.setFocusEmulationEnabled:false', 'Emulation.setFocusEmulationEnabled:true',
    'Emulation.setFocusEmulationEnabled:false']);
  // Someone else detached the debugger (DevTools): the next focus attaches it again.
  page.focus(true);
  attached = false;
  handlers.detach();
  page.focus(false);
  page.focus(true);
  assert.equal(attached, true);
  assert.deepEqual(sent.slice(4), ['Emulation.setFocusEmulationEnabled:true', 'Emulation.setFocusEmulationEnabled:true']);
});

test('a click on a frame from another site, like Discord\'s captcha, reaches that frame at its own point', async () => {
  const handlers = {};
  const dispatched = [];
  const commands = [];
  const inputs = [];
  let autoAttach = null;
  // The captcha's frame sits at (100, 200) on the page, 300 by 80 CSS pixels.
  const inFrame = ({ x, y }) => x >= 100 && x < 400 && y >= 200 && y < 280;
  const page = openPage({
    isAttached: () => false,
    attach: () => undefined,
    on: listenInto(handlers),
    sendCommand: async (method, params, session) => {
      commands.push(method);
      if (method === 'Target.setAutoAttach') {
        autoAttach = params;
        handlers.message({}, 'Target.attachedToTarget', { sessionId: 'captcha', targetInfo: { targetId: 'F1', type: 'iframe' } });
        handlers.message({}, 'Target.attachedToTarget', { sessionId: 'worker', targetInfo: { targetId: 'W1', type: 'worker' } });
      }
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: inFrame(params) ? 7 : 3 };
      if (method === 'DOM.getFrameOwner') return { backendNodeId: params.frameId === 'F1' ? 7 : 9 };
      if (method === 'DOM.getBoxModel') return { model: { content: [100, 200, 400, 200, 400, 280, 100, 280] } };
      if (method === 'Input.dispatchMouseEvent') dispatched.push({ session, ...params });
      return {};
    },
  }, { zoom: 1.25, inputs });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const mouse = (type, x, y, extra = {}) => page.input({ action: 'mouse', type, x, y, modifiers: [], ...extra });
  page.layout(800, 600, true);
  mouse('move', 10, 10);
  await settle();
  // DevTools follows frames only: a worker it attached crashed Electron when Discord restarted it.
  assert.deepEqual(autoAttach.filter, [{ type: 'iframe' }]);
  assert.ok(!commands.includes('Target.detachFromTarget'), 'nothing that is not a frame is ever held');

  // A move overtaken by the next before it went anywhere is left out.
  mouse('move', 110, 210);
  mouse('move', 130, 230);
  mouse('down', 130, 230, { button: 'left', clickCount: 1, modifiers: ['leftbuttondown'] });
  // Dragged out of the frame, the pointer stays with it until released.
  mouse('move', 500, 500, { modifiers: ['leftbuttondown'] });
  mouse('up', 500, 500, { button: 'left', clickCount: 1 });
  mouse('move', 600, 550);
  page.input({ action: 'wheel', x: 150, y: 250, deltaX: 0, deltaY: 40, modifiers: ['shift'] });
  await settle();
  assert.deepEqual(dispatched.map(({ session, type, x, y, button, buttons, clickCount, deltaY, modifiers }) =>
    [session, type, x, y, button, buttons, clickCount, deltaY, modifiers]), [
    ['captcha', 'mouseMoved', 30, 30, 'none', 0, 0, undefined, 0],
    ['captcha', 'mousePressed', 30, 30, 'left', 1, 1, undefined, 0],
    ['captcha', 'mouseMoved', 400, 300, 'none', 1, 0, undefined, 0],
    ['captcha', 'mouseReleased', 400, 300, 'left', 0, 1, undefined, 0],
    ['captcha', 'mouseWheel', 50, 50, undefined, undefined, undefined, 40, 8],
  ]);
  // Everywhere else the page receives the input itself, in its own pixels at Monky's zoom.
  assert.deepEqual(inputs.map(({ type, x, y }) => [type, x, y]), [['mouseMove', 13, 13], ['mouseMove', 750, 688]]);
});

test('files dropped on the page reach Discord as a drag from the system, over the drop zone it drew, and only real files go', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-discord-drop-'));
  const file = path.join(folder, 'photo.png');
  fs.writeFileSync(file, 'png');
  const sent = [];
  try {
    const page = openPage({
      isAttached: () => false,
      attach: () => undefined,
      on: () => undefined,
      sendCommand: async (method, params) => { sent.push({ method, ...params }); },
    }, { zoom: 1.25, run: async () => { sent.push('frames'); } });
    await page.drop(10, 20, [file]);
    assert.deepEqual(sent, [], 'a page Monky does not show takes no drop');
    page.layout(100, 100, true);
    await page.drop(10, 20, [file, folder, path.join(folder, 'missing.txt'), 'photo.png']);
    const drag = type => ({
      method: 'Input.dispatchDragEvent', type, x: 10, y: 20, data: { items: [], files: [file], dragOperationsMask: 1 },
    });
    // Discord draws its drop zone after the drag entered and accepts nothing before: the drag passes over it once drawn.
    assert.deepEqual(sent, [drag('dragEnter'), drag('dragOver'), 'frames', drag('dragOver'), drag('drop')],
      'only the existing file, by its full path, is dropped, in the page\'s CSS pixels whatever the zoom');
    sent.length = 0;
    await page.drop(10, 20, [folder]);
    assert.deepEqual(sent, [], 'a drop with no real file sends nothing');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('the files Discord asks for are chosen over Monky\'s window and handed to the field that asked', async () => {
  const handlers = {};
  const sent = [];
  const asked = [];
  let attached = false;
  let answer = { canceled: false, filePaths: ['C:\\fotos\\a.png', 'C:\\fotos\\b.png'] };
  const seen = {};
  const page = openPage({
    isAttached: () => attached,
    attach: () => { attached = true; },
    on: listenInto(handlers),
    sendCommand: async (method, params) => { sent.push([method, params]); return {}; },
  }, { seen, dialog: { showOpenDialog: async (parent, options) => { asked.push([parent, options]); return answer; } } });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  page.layout(800, 600, true);
  page.input({ action: 'mouse', type: 'move', x: 10, y: 10, modifiers: [] });
  page.input({ action: 'mouse', type: 'move', x: 12, y: 10, modifiers: [] });
  await settle();
  const chooserCommands = () => sent.filter(([method]) => method.startsWith('Page.') || method === 'DOM.setFileInputFiles');
  assert.deepEqual(chooserCommands(), [['Page.enable', undefined], ['Page.setInterceptFileChooserDialog', { enabled: true }]],
    'the page\'s chooser is taken once, before the person can reach Discord\'s buttons');

  handlers.message({}, 'Page.fileChooserOpened', { frameId: 'F', mode: 'selectMultiple', backendNodeId: 42 });
  await settle();
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], seen.owner, 'the chooser opens over Monky\'s window, not the hidden page\'s');
  assert.deepEqual(asked[0][1].properties, ['openFile', 'multiSelections']);
  assert.deepEqual(chooserCommands().slice(2), [['DOM.setFileInputFiles', { files: answer.filePaths, backendNodeId: 42 }]]);

  answer = { canceled: true, filePaths: [] };
  handlers.message({}, 'Page.fileChooserOpened', { frameId: 'F', mode: 'selectSingle', backendNodeId: 43 });
  await settle();
  assert.deepEqual(asked[1][1].properties, ['openFile']);
  assert.equal(chooserCommands().length, 3, 'a cancelled choice gives Discord nothing');

  // DevTools let go of the page (someone opened them): the chooser is taken again on the next input.
  attached = false;
  handlers.detach();
  page.input({ action: 'key', type: 'down', keyCode: 'Enter', modifiers: [] });
  await settle();
  assert.deepEqual(chooserCommands().slice(3).map(([method]) => method), ['Page.enable', 'Page.setInterceptFileChooserDialog']);
});

test('a video Discord shows on its whole screen, from its page or an embed, fills the page and Monky follows it in and out', () => {
  const inputs = [];
  const told = [];
  const seen = {};
  const page = openPage({ isAttached: () => false, attach: () => undefined, on: () => undefined, sendCommand: async () => ({}) },
    { inputs, seen, events: { fullscreen: fullscreen => told.push(fullscreen), closed: () => undefined } });
  // Allowed to take the screen, the hidden window would cover it and show.
  assert.equal(seen.options.fullscreenable, false);
  const contents = page.liveContents();
  const asks = (permission, requestingUrl, on = contents) => {
    let answer;
    seen.permission(on, permission, granted => { answer = granted; }, { requestingUrl });
    return answer;
  };
  assert.equal(asks('fullscreen', 'https://discord.com/channels/@me'), true);
  assert.equal(asks('fullscreen', 'https://www.youtube.com/embed/abc'), true, 'a video embedded in Discord may take the screen');
  assert.equal(asks('media', 'https://www.youtube.com/embed/abc'), false, 'an embed gets nothing else');
  assert.equal(asks('fullscreen', 'https://example.com/', { getURL: () => 'https://example.com/' }), false);

  page.exitFullscreen();
  assert.deepEqual(inputs, [], 'a page not on the whole screen is left alone');
  seen.on['enter-html-full-screen']();
  seen.on['enter-html-full-screen']();
  assert.deepEqual(told, [true]);
  page.exitFullscreen();
  assert.deepEqual(inputs.map(({ type, keyCode }) => `${type}:${keyCode}`), ['keyDown:Escape', 'keyUp:Escape']);
  seen.on['leave-html-full-screen']();
  assert.deepEqual(told, [true, false]);
  page.close();
  told.length = 0;
  seen.on['enter-html-full-screen']();
  assert.deepEqual(told, [], 'a closed page tells nothing');
});

test('reloading asks Discord for the page past the cache and settles once it has loaded, or once the page is gone', async () => {
  const seen = {};
  const page = openPage({ isAttached: () => false, attach: () => undefined, on: () => undefined, sendCommand: async () => ({}) },
    { seen, events: { closed: () => undefined } });
  let settled = false;
  const loading = page.reload().then(() => { settled = true; });
  assert.equal(seen.reloads, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the page is still loading');
  seen.once['did-stop-loading']();
  await loading;
  assert.deepEqual(Object.keys(seen.once).filter(name => name === 'did-stop-loading' || name === 'destroyed'), [],
    'nothing is left listening once it settled');
  const gone = page.reload();
  seen.once.destroyed();
  await gone;
  assert.equal(seen.reloads, 2);
  page.close();
  await page.reload();
  assert.equal(seen.reloads, 2, 'a closed page has nothing to reload');
});