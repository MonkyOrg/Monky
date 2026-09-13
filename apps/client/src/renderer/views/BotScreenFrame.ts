import { BOT_SCREEN_LIMITS, botScreenActionSchema, type BotScreen, type BotScreenAction, type BotScreenJson } from '@monky/shared';
import type { SupportedLanguage } from '../i18n';

export interface BotScreenViewer { id: string; nickname: string; locale: SupportedLanguage }

export const BOT_SCREEN_CSP = [
  "default-src 'none'", "script-src 'none'", "script-src-elem 'unsafe-inline'", "script-src-attr 'none'", "style-src 'unsafe-inline'",
  'img-src data:', 'font-src data:', "connect-src 'none'", "frame-src 'none'",
  "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  "media-src 'none'",
].join('; ');

interface FrameSeed {
  viewer: BotScreenViewer;
  state: BotScreenJson;
  revision: number;
  actionBytes: number;
  depth: number;
}

type FrameUpdate = { type: 'state'; state: BotScreenJson; revision: number } | { type: 'locale'; locale: SupportedLanguage };

/** Self-contained because its source executes in the opaque, unprivileged document. */
function screenBootstrap(seed: FrameSeed): void {
  // ICE is not covered by connect-src. Opaque child realms cannot reach this realm;
  // workers/child documents are denied by CSP, so do not expose peer networking here.
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'WebTransport']) {
    Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false });
  }
  let state = seed.state;
  let revision = seed.revision;
  let port: MessagePort | null = null;
  const listeners = new Set<(state: BotScreenJson, revision: number) => void>();
  let locale = seed.viewer.locale;
  const viewer = Object.freeze({ id: seed.viewer.id, nickname: seed.viewer.nickname, get locale() { return locale; } });
  let start = 0;
  let sent = 0;
  const api = Object.freeze({
    viewer,
    onState(callback: (state: BotScreenJson, revision: number) => void): () => void {
      if (typeof callback !== 'function') throw new TypeError('Expected a state callback.');
      listeners.add(callback);
      callback(structuredClone(state), revision);
      return () => { listeners.delete(callback); };
    },
    sendAction(action: string, payload: BotScreenJson): boolean {
      if (!port || typeof action !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(action)) return false;
      const now = Date.now();
      if (now - start >= 1000) { start = now; sent = 0; }
      if (++sent > 8) return false;
      try {
        const pending = [{ value: payload, depth: 0 }];
        let nodes = 0;
        while (pending.length) {
          const entry = pending.pop()!;
          if (++nodes > 8192 || entry.depth > seed.depth) return false;
          if (entry.value !== null && typeof entry.value === 'object') {
            for (const value of Object.values(entry.value)) pending.push({ value, depth: entry.depth + 1 });
          }
        }
        const json = JSON.stringify(payload);
        if (typeof json !== 'string' || json.length > seed.actionBytes || new TextEncoder().encode(json).byteLength > seed.actionBytes) return false;
        port.postMessage({ action, payload: JSON.parse(json), revision });
        return true;
      } catch { return false; }
    },
  });
  Object.defineProperty(window, 'monkyScreen', { value: api, writable: false, configurable: false });
  const connect = (event: MessageEvent<unknown>): void => {
    if (event.source !== parent || event.data !== 'monky-screen-connect' || event.ports.length !== 1 || port) return;
    port = event.ports[0]!;
    window.removeEventListener('message', connect);
    port.onmessage = (event: MessageEvent<FrameUpdate>) => {
      if (event.data.type === 'locale') {
        if (locale === event.data.locale) return;
        locale = event.data.locale;
      }
      else {
        state = event.data.state;
        revision = event.data.revision;
      }
      for (const callback of listeners) {
        try { callback(structuredClone(state), revision); } catch (error: unknown) { console.error(error); }
      }
    };
    port.start();
    for (const callback of listeners) {
      try { callback(structuredClone(state), revision); } catch (error: unknown) { console.error(error); }
    }
  };
  window.addEventListener('message', connect);
}

export function botScreenDocument(screen: BotScreen, viewer: BotScreenViewer): string {
  const seed: FrameSeed = {
    viewer, state: screen.state, revision: screen.revision,
    actionBytes: BOT_SCREEN_LIMITS.actionBytes, depth: BOT_SCREEN_LIMITS.jsonDepth,
  };
  const serialized = JSON.stringify(seed).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><meta http-equiv="Content-Security-Policy" content="${BOT_SCREEN_CSP}">` +
    `<script>(${screenBootstrap.toString()})(${serialized});</script></head><body>${screen.html}</body></html>`;
}

/** One port is bound to one opaque frame and one captured server/channel/screen. */
export class BotScreenFrame {
  private static active = new Set<BotScreenFrame>();
  readonly element: HTMLIFrameElement;
  private channel = new MessageChannel();
  private destroyed = false;
  private connected = false;
  private windowStart = 0;
  private count = 0;
  private snapshot: BotScreen;
  private locale: SupportedLanguage;

  constructor(screen: BotScreen, viewer: BotScreenViewer, private onAction: (action: BotScreenAction) => void) {
    if (BotScreenFrame.active.size >= 2) {
      this.channel.port1.close();
      this.channel.port2.close();
      throw new Error('Close another active miniapp first.');
    }
    BotScreenFrame.active.add(this);
    this.snapshot = screen;
    this.locale = viewer.locale;
    this.element = document.createElement('iframe');
    this.element.className = 'bot-screen-frame';
    this.element.name = `monky-bot-screen-${crypto.randomUUID()}`;
    this.element.title = screen.title;
    this.element.setAttribute('sandbox', 'allow-scripts');
    this.element.setAttribute('referrerpolicy', 'no-referrer');
    this.element.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; autoplay 'none'; encrypted-media 'none'; usb 'none'; serial 'none'; hid 'none'");
    this.element.addEventListener('load', this.onLoad);
    this.channel.port1.onmessage = this.onMessage;
    this.channel.port1.start();
    this.element.srcdoc = botScreenDocument(screen, viewer);
  }

  update(screen: BotScreen): void {
    if (this.destroyed || screen.id !== this.snapshot.id || screen.channelId !== this.snapshot.channelId ||
        screen.botId !== this.snapshot.botId || screen.revision <= this.snapshot.revision) return;
    this.snapshot = screen;
    if (this.connected) this.channel.port1.postMessage({ type: 'state', state: screen.state, revision: screen.revision } satisfies FrameUpdate);
  }

  setLocale(locale: SupportedLanguage): void {
    if (this.destroyed || locale === this.locale) return;
    this.locale = locale;
    if (this.connected) this.channel.port1.postMessage({ type: 'locale', locale } satisfies FrameUpdate);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    BotScreenFrame.active.delete(this);
    this.element.removeEventListener('load', this.onLoad);
    this.channel.port1.onmessage = null;
    this.channel.port1.close();
    this.channel.port2.close();
    this.element.remove();
  }

  private onLoad = (): void => {
    // A second load invalidates the bridge even if Chromium reports a local navigation.
    if (this.destroyed) return;
    if (this.connected) { this.destroy(); return; }
    this.connected = true;
    this.element.contentWindow?.postMessage('monky-screen-connect', '*', [this.channel.port2]);
    this.channel.port1.postMessage({ type: 'state', state: this.snapshot.state, revision: this.snapshot.revision } satisfies FrameUpdate);
    this.channel.port1.postMessage({ type: 'locale', locale: this.locale } satisfies FrameUpdate);
  };

  private onMessage = (event: MessageEvent<unknown>): void => {
    if (this.destroyed || !this.connected) return;
    const now = Date.now();
    if (now - this.windowStart >= 1000) { this.windowStart = now; this.count = 0; }
    if (++this.count > BOT_SCREEN_LIMITS.actionsPerSecond) return;
    if (!event.data || typeof event.data !== 'object' || !('action' in event.data) || !('payload' in event.data) ||
        !('revision' in event.data) || Object.keys(event.data).some((key) => key !== 'action' && key !== 'payload' && key !== 'revision')) return;
    const parsed = botScreenActionSchema.safeParse({
      id: this.snapshot.id, action: event.data.action, payload: event.data.payload,
      // Use the revision actually rendered in the child, not a newer state still in transit to it.
      revision: event.data.revision, actionId: crypto.randomUUID(),
    });
    if (parsed.success) this.onAction(parsed.data);
  };
}
