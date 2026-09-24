'use strict';

// Device-free DOM/event model. Real layout and pixel checks remain in the
// Electron smokes; this fixture exercises production UI logic and markup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { setMaxListeners } = require('node:events');
const ts = require('typescript');
const shared = require('@monky/shared');
const MONITOR_SOURCE_ID = `native-monitor:${'1'.repeat(64)}`;

const renderer = path.resolve(__dirname, '..', '..', 'src', 'renderer');
const compiled = new Map();
function appEventHandlerSource(eventName) {
  const filename = path.join(renderer, 'main.ts');
  const cacheKey = `${filename}:${eventName}`;
  if (!compiled.has(cacheKey)) {
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2022, true);
    const handlers = [];
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'appEvents.on'
        && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === eventName) {
        handlers.push(node.arguments[1]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.equal(handlers.length, 1, `Exercise the actual unique ${eventName} UI handler without bootstrapping the app`);
    compiled.set(cacheKey, ts.transpileModule(`exports.notify = ${handlers[0].getText(source)};`, {
      fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText);
  }
  return compiled.get(cacheKey);
}

function appEventHandler(eventName, globals) {
  const exports = {};
  vm.runInNewContext(appEventHandlerSource(eventName), { exports, ...globals }, { filename: path.join(renderer, 'main.ts') });
  return exports.notify;
}

const decode = text => text.replace(/&(?:amp|lt|gt|quot|#039);/g, entity => ({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'",
})[entity]);
const dataName = key => `data-${key.replace(/[A-Z]/g, value => `-${value.toLowerCase()}`)}`;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); };

class ModelElement {
  constructor(document, tag = 'div') {
    this.ownerDocument = document;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.parentElement = null;
    this.style = {};
    this.scrollTop = 0;
    this.scrollHeight = 2000;
    this.clientHeight = 400;
    this.clientTop = 0;
    this.top = 0;
    this.checked = false;
    this.dataset = new Proxy({}, {
      get: (_, key) => this.getAttribute(dataName(key)) ?? undefined,
      set: (_, key, value) => { this.setAttribute(dataName(key), String(value)); return true; },
      deleteProperty: (_, key) => { this.removeAttribute(dataName(key)); return true; },
    });
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const selected = force ?? !this.classList.contains(name);
        this.classList[selected ? 'add' : 'remove'](name);
        return selected;
      },
    };
  }
  get id() { return this.getAttribute('id') ?? ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get inert() { return this.hasAttribute('inert'); }
  set inert(value) { if (value) this.setAttribute('inert', ''); else this.removeAttribute('inert'); }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? 0); }
  set tabIndex(value) { this.setAttribute('tabindex', String(value)); }
  get title() { return this.getAttribute('title') ?? ''; }
  set title(value) { this.setAttribute('title', value); }
  get type() { return this.getAttribute('type') ?? ''; }
  set type(value) { this.setAttribute('type', value); }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentElement?.isConnected; }
  get value() {
    if (this.tagName !== 'SELECT') return this.currentValue ?? this.getAttribute('value') ?? '';
    const options = this.querySelectorAll('option');
    if (this.currentValue !== undefined) return options.some(option => option.value === this.currentValue) ? this.currentValue : '';
    return (options.find(option => option.hasAttribute('selected')) ?? options.find(option => !option.disabled))?.value ?? '';
  }
  set value(value) { this.currentValue = String(value); }
  get innerHTML() { return this.markup ?? ''; }
  set innerHTML(value) {
    this.markup = value;
    this.replaceChildren();
    const stack = [this];
    for (const token of value.match(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g) ?? []) {
      if (token.startsWith('<!--')) continue;
      if (token.startsWith('</')) {
        const closed = stack.pop();
        assert.equal(closed.tagName.toLowerCase(), token.slice(2, -1).trim(), 'Model input must use balanced HTML');
      } else if (token.startsWith('<')) {
        const [, tag, rest] = /^<([\w-]+)([\s\S]*?)\/?>$/.exec(token) ?? [];
        assert.ok(tag, `Unsupported model markup: ${token}`);
        const element = this.ownerDocument.createElement(tag);
        for (const [, name, quoted, single, bare] of rest.matchAll(/([^\s=/]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)) {
          element.setAttribute(name, decode(quoted ?? single ?? bare ?? ''));
        }
        stack.at(-1).appendChild(element);
        if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag) && !token.endsWith('/>')) stack.push(element);
      } else stack.at(-1).children.push(decode(token));
    }
    assert.equal(stack.length, 1, 'Model input must close its elements');
  }
  get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(String(value)); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'checked') this.checked = true;
    if (name === 'style') {
      for (const part of value.split(';')) {
        const separator = part.indexOf(':');
        if (separator !== -1) this.style[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
      }
    }
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) {
    child.remove();
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  append(...children) { for (const child of children) this.appendChild(child); }
  replaceChildren(...children) {
    for (const child of this.children) if (typeof child !== 'string') child.parentElement = null;
    this.children = [];
    for (const child of children) {
      if (typeof child === 'string') this.children.push(child);
      else this.appendChild(child);
    }
  }
  after(element) {
    const parent = this.parentElement;
    element.remove();
    parent.children.splice(parent.children.indexOf(this) + 1, 0, element);
    element.parentElement = parent;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  contains(element) { return element === this || this.children.some(child => typeof child !== 'string' && child.contains(element)); }
  matches(selector) {
    const tag = /^[\w-]+/.exec(selector)?.[0];
    if (tag && tag.toUpperCase() !== this.tagName) return false;
    const rest = selector.replace(/^[\w-]+/, '');
    for (const [, id, className, attribute, value] of rest.matchAll(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (id && this.id !== id || className && !this.classList.contains(className)) return false;
      if (attribute && (value === undefined ? !this.hasAttribute(attribute) : this.getAttribute(attribute) !== value)) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if (typeof child === 'string') continue;
        if (selectors.some(value => {
          const pieces = value.match(/(?:\[[^\]]*\]|[^\s])+/g);
          if (!child.matches(pieces.pop())) return false;
          let parent = child.parentElement;
          while (pieces.length && parent) {
            if (parent.matches(pieces.at(-1))) pieces.pop();
            parent = parent.parentElement;
          }
          return pieces.length === 0;
        })) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  addEventListener(type, callback, options = {}) {
    if (options.signal?.aborted) return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(callback);
    this.listeners.set(type, listeners);
    options.signal?.addEventListener('abort', () => this.removeEventListener(type, callback), { once: true });
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatchEvent(event) {
    Object.defineProperty(event, 'target', { configurable: true, value: this });
    let current = this;
    while (current) {
      Object.defineProperty(event, 'currentTarget', { configurable: true, value: current });
      for (const listener of [...(current.listeners.get(event.type) ?? [])]) listener(event);
      current = event.bubbles && !event.cancelBubble ? current.parentElement : null;
    }
    return !event.defaultPrevented;
  }
  click() { if (!this.disabled && !this.closest('[inert]')) this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
  focus() { if (!this.disabled && !this.closest('[inert]')) this.ownerDocument.activeElement = this; }
  checkVisibility() { return !this.hidden && this.style.display !== 'none' && (!this.parentElement || this.parentElement.checkVisibility()); }
  getBoundingClientRect() { return { top: this.top, left: 0, width: 600, height: 50, right: 600, bottom: this.top + 50 }; }
  scrollTo({ top }) { this.scrollTop = top; }
}

function fixture(language = 'en') {
  const document = { documentElement: { lang: language }, createElement: tag => new ModelElement(document, tag) };
  document.body = document.createElement('body');
  document.activeElement = document.body;
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  const storage = new Map(), modules = new Map(), traces = [], alerts = [], warnings = [], events = [], observers = [];
  const captures = new Map(), streams = new Map();
  const source = (id, type, name = id) => ({ id, type, name, thumbnailDataUrl: '', appIconDataUrl: null });
  const sources = [source(MONITOR_SOURCE_ID, 'screen'), source('window:101:0', 'window'), source('window:202:0', 'window')];
  const capabilities = { capture: true, captureAudio: true, receive: true, captureKinds: ['window', 'monitor', 'game'], backend: 'libobs-amf', reason: null };
  const controls = {
    capabilities: async () => capabilities, sources: async () => sources,
    current: true, confirm: true, capturingAudio: false, settingsError: null,
    start: null, stop: null, reapply: async () => {},
    openExternal: async () => ({ success: true }),
  };
  let saves = 0, enumerations = 0, cancelled = 0, sequence = 0;
  const settingsStore = {
    screenShareReceiver: 'native',
    get nativeScreenReceiverComingSoon() { return api.platform === 'darwin'; },
    getScreenShareReceiver() { return this.nativeScreenReceiverComingSoon ? 'chromium' : this.screenShareReceiver; },
    setScreenShareReceiver(value) {
      if (value === 'native' && this.nativeScreenReceiverComingSoon) throw new Error('Native receiver unavailable');
      this.screenShareReceiver = value;
      this.save();
    },
    qualityPreset: 'NORMAL', customProfile: { ...shared.QUALITY_PRESETS.NORMAL },
    preferredVideoCodec: 'auto', screenSharePreviewPauseWhenUnfocused: true,
    screenShareTelemetryEnabled: false, screenShareTelemetryPosition: 'top-right', screenShareTelemetryMode: 'simple',
    save() { saves++; events.push(['settings.updated']); },
  };
  const voiceStore = {
    screenShareIds: [], screenAudioShareId: null, camera: 'preserved-camera', voice: 'preserved-call',
    get isScreenSharing() { return this.screenShareIds.length > 0; },
    canAddScreenShare() { return this.screenShareIds.length < 3; },
    addScreenShare(id) { this.screenShareIds.push(id); },
    setScreenAudioShare(id) { this.screenAudioShareId = id; },
  };
  const screenAudioService = {
    getIsCapturing: () => controls.capturingAudio, getIsTestTone: () => false,
    stop: async () => { traces.push(['audio-stop']); controls.capturingAudio = false; },
    start: async () => { throw new Error('Browser audio fallback must not run'); },
  };
  const videoService = {
    getActiveSourceIds: () => new Set([...captures.values()].map(capture => capture.desktopSourceId)),
    getProfile: () => settingsStore.qualityPreset === 'CUSTOM' ? settingsStore.customProfile : shared.QUALITY_PRESETS[settingsStore.qualityPreset],
    getScreenStream: id => streams.get(id),
    getNativeScreenCapture: id => captures.get(id),
    cancelPendingScreenShare: () => { cancelled++; },
    stopScreenShare: id => { traces.push(['video-stop', id]); streams.delete(id); captures.delete(id); },
    startScreenShare: async () => { throw new Error('Chromium capture fallback must not run'); },
  };
  const createStream = (desktopSourceId = 'window:101:0') => {
    const stream = { id: `stream-${++sequence}`, getVideoTracks: () => [] };
    streams.set(stream.id, stream);
    captures.set(stream.id, { desktopSourceId });
    return stream;
  };
  const webRtcManager = {
    getNativeScreenCapabilities: () => controls.capabilities(),
    async startNativeScreenShare(id, audio, thumbnail, isWanted, kind, preserveAspectRatio, audioReplacement) {
      traces.push(['native-start', id, audio, thumbnail, kind, preserveAspectRatio]);
      if (controls.start) return controls.start({ id, audio, thumbnail, isWanted, kind, preserveAspectRatio, audioReplacement });
      if (audioReplacement) {
        traces.push(['audio-replacement', audioReplacement.shareId]);
        await audioReplacement.retirePrevious();
        if (!isWanted()) throw new DOMException('Cancelled selection', 'AbortError');
      }
      return createStream(id);
    },
    assertScreenSharingSettings(profile, codec) {
      traces.push(['assert-settings', profile, codec]);
      if (controls.settingsError) throw controls.settingsError;
    },
    setQualityPreset: value => traces.push(['preset', value]),
    reapplyCodecPreferences: () => controls.reapply(),
  };
  const stopLocalScreenShares = async (_, { shareIds, notify }) => {
    traces.push(['stop-shares', [...shareIds], notify]);
    if (controls.stop) await controls.stop(shareIds);
    for (const id of shareIds) {
      streams.delete(id); captures.delete(id);
      voiceStore.screenShareIds = voiceStore.screenShareIds.filter(value => value !== id);
      if (voiceStore.screenAudioShareId === id) voiceStore.screenAudioShareId = null;
    }
  };
  class Controller extends AbortController {
    constructor() { super(); setMaxListeners(0, this.signal); }
  }
  class Observer {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    unobserve() {}
    disconnect() { this.disconnected = true; }
  }
  const mediaQuery = new ModelElement(document);
  mediaQuery.matches = true;
  const api = {
    platform: 'win32', nativeScreenCommand: async () => { throw new Error('Model must not perform native IPC'); },
    getDesktopSources: () => { enumerations++; return controls.sources(); },
    prepareScreenShareWindow: async id => { traces.push(['prepare-window', id]); return false; },
    openExternal: url => { traces.push(['open-external', url]); return controls.openExternal(url); },
  };
  const stubs = {
    'core/EventBus': { appEvents: { emit: (...value) => events.push(value) } },
    'core/ScreenAudioService': { screenAudioService },
    'core/VideoService': { videoService },
    'core/WebRtcManager': { webRtcManager },
    'stores/settingsStore': { settingsStore },
    'stores/voiceStore': { voiceStore, VoiceStore: { MAX_SCREEN_SHARES: 3 } },
    'core/screenShareControls': {
      captureScreenShareCall: () => ({ isCurrent: () => controls.current }),
      notifyScreenShareState: () => traces.push(['notify', [...voiceStore.screenShareIds]]),
      stopLocalScreenShares,
    },
    'core/webrtc/NativeScreenController': {
      nativeScreenProfile(profile) {
        const parsed = shared.nativeScreenVideoProfileSchema.safeParse({
          width: profile.screenWidth, height: profile.screenHeight, fps: profile.screenFps, maxBitrateKbps: profile.screenBitrateKbps,
        });
        return parsed.success ? parsed.data : null;
      },
    },
    'views/Dialog': { showAlert: async value => alerts.push(value), showConfirm: async () => controls.confirm },
    'utils/scroll': { scrollWithin: (body, target, offset) => { body.scrollTop = target.top - offset; return body.scrollTop; } },
  };
  const allowed = new Set([
    'views/ScreenSharePickerModal', 'views/GameCaptureGuideModal', 'views/CopyToast', 'views/settings/tabs/QualityTab', 'views/settings/qualityOptions',
    'views/settings/SettingsSectionNavigation', 'i18n/index', 'i18n/locales/en', 'i18n/locales/pt-BR',
    'utils/html', 'utils/buttonLoading', 'utils/loadingSkeleton',
  ]);
  function load(name) {
    if (Object.hasOwn(stubs, name)) return stubs[name];
    if (modules.has(name)) return modules.get(name);
    assert.ok(allowed.has(name), `Unexpected UI model dependency: ${name}`);
    const filename = path.join(renderer, ...name.split('/')) + '.ts';
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText);
    const module = { exports: {} };
    modules.set(name, module.exports);
    vm.runInNewContext(compiled.get(filename), {
      module, exports: module.exports, document, window: { api, matchMedia: () => mediaQuery, setTimeout, clearTimeout },
      localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
      navigator: { language, languages: [language] },
      Element: ModelElement, HTMLElement: ModelElement, HTMLButtonElement: ModelElement, HTMLInputElement: ModelElement,
      Event, DOMException, Error, AbortController: Controller, MutationObserver: Observer, ResizeObserver: Observer,
      CSS: { escape: value => value }, getComputedStyle: () => ({ rowGap: '8', opacity: '1', marginTop: '0', marginBottom: '0' }),
      requestAnimationFrame: callback => setImmediate(callback), cancelAnimationFrame: clearImmediate,
      setTimeout, clearTimeout, console: { warn: (...value) => warnings.push(value), error: (...value) => warnings.push(value) },
      require(request) {
        if (request === '@monky/shared') return shared;
        assert.ok(request.startsWith('.'), `Unexpected network/device dependency: ${request}`);
        let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), request));
        if (resolved === 'i18n') resolved = 'i18n/index';
        return load(resolved);
      },
    }, { filename });
    return module.exports;
  }
  const { ScreenSharePickerModal } = load('views/ScreenSharePickerModal');
  const { QualityTab } = load('views/settings/tabs/QualityTab');
  const { SettingsSectionNavigation } = load('views/settings/SettingsSectionNavigation');
  const i18n = load('i18n/index');
  i18n.setLanguage(language);
  const picker = new ScreenSharePickerModal(), quality = new QualityTab();
  const mountQuality = () => {
    const root = document.createElement('main');
    root.innerHTML = quality.renderHtml();
    document.body.appendChild(root);
    quality.attachEvents(root);
    return root;
  };
  return {
    picker, quality, SettingsSectionNavigation, i18n, load, mountQuality, document, api, controls, sources, source,
    notifyNativeFailure: appEventHandler('native_screen.source_failed', {
      t: i18n.t, showAlert: stubs['views/Dialog'].showAlert,
      showInfoToast: (message, durationMs) => traces.push(['info-toast', message, durationMs]),
    }),
    notifyCaptureFallback: appEventHandler('native_screen.capture_fallback', {
      t: i18n.t, showInfoToast: (message, durationMs) => traces.push(['info-toast', message, durationMs]),
      showAlert: stubs['views/Dialog'].showAlert,
    }),
    settingsStore, voiceStore, streams, captures, capabilities, createStream, traces, alerts, warnings, events, observers, mediaQuery,
    get saves() { return saves; }, get enumerations() { return enumerations; }, get cancelled() { return cancelled; },
    close() { picker.close(); quality.cleanup(); document.body.replaceChildren(); },
  };
}

module.exports = { fixture, deferred, flush, MONITOR_SOURCE_ID, appEventHandlerSource };
