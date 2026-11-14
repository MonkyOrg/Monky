'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadMain } = require('./mainModules.cjs');

const { LAYERS_PROBE, settleLayers } = loadMain('discordWebPage', { packages: { electron: {} } });

const tooltip = { kind: 'tooltip', x: 80, y: 120, width: 60, height: 32, radius: 4, shown: true };
const menu = { kind: 'menu', x: 80, y: 200, width: 180, height: 240, radius: 8, shown: true };
const layers = (popups, modal = false) => ({ popups, modal, servers: null });
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
  let state = settleLayers([], layers([menu], true), 0);
  assert.equal(state.layers.modal, true);
  state = settleLayers(state.seen, layers([menu, tooltip], true), 100);
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
const probe = (elements, tree = null, corner = []) => vm.runInNewContext(LAYERS_PROBE, {
  document: {
    querySelectorAll: () => elements,
    querySelector: selector => (selector === '[data-list-id="guildsnav"]' ? tree : null),
    elementsFromPoint: () => corner,
  },
  innerHeight: 1018,
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
    modal: false,
    servers: null,
  });
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