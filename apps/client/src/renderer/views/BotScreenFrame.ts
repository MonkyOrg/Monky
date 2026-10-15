import { BOT_SCREEN_LIMITS, botScreenActionSchema, botScreenDocumentConsentSchema, type BotScreen, type BotScreenAction, type BotScreenDocumentConsent, type BotScreenJson } from '@monky/shared';
import type { SupportedLanguage } from '../i18n';
import { installMiniappVolume } from './botScreenVolume';

export interface BotScreenViewer { id: string; nickname: string; locale: SupportedLanguage }

export const BOT_SCREEN_CSP = [
  "default-src 'self' http: https: data: blob:",
  "script-src 'self' http: https: data: blob: 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' http: https: data: blob: 'unsafe-inline'",
  "connect-src 'self' http: https: ws: wss: data: blob:",
  "worker-src 'self' http: https: data: blob:",
  "object-src 'none'", "base-uri 'self' http: https:", "form-action http: https:",
].join('; ');

interface FrameSeed {
  viewer: BotScreenViewer;
  state: BotScreenJson;
  revision: number;
  actionBytes: number;
  depth: number;
  volume: number;
}

type FrameUpdate = { type: 'state'; state: BotScreenJson; revision: number } | { type: 'locale'; locale: SupportedLanguage }
  | { type: 'volume'; volume: number };

/** 0 mutes, 1 keeps the miniapp's own levels and 2 doubles its Web Audio output. */
function frameVolume(volume: number): number {
  return Number.isFinite(volume) ? Math.min(2, Math.max(0, volume)) : 1;
}

/** Self-contained because its source executes in a separate, unprivileged origin. */
function screenBootstrap(seed: FrameSeed, installVolume: typeof installMiniappVolume): void {
  let setVolume: ((volume: number) => void) | null = null;
  try { setVolume = installVolume(window, seed.volume); }
  catch (error: unknown) { console.warn('[Monky] The miniapp volume control is unavailable.', error); }
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
      if (event.data.type === 'volume') {
        setVolume?.(event.data.volume);
        return;
      }
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

export function botScreenDocument(screen: BotScreen, viewer: BotScreenViewer, volume = 1): string {
  const seed: FrameSeed = {
    viewer, state: screen.state, revision: screen.revision,
    actionBytes: BOT_SCREEN_LIMITS.actionBytes, depth: BOT_SCREEN_LIMITS.jsonDepth, volume: frameVolume(volume),
  };
  const serialized = JSON.stringify(seed).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="x-dns-prefetch-control" content="off"><meta http-equiv="Content-Security-Policy" content="${BOT_SCREEN_CSP}">` +
    `<script>(${screenBootstrap.toString()})(${serialized},${installMiniappVolume.toString()});</script></head><body>${screen.html}</body></html>`;
}

/** One port is bound to one isolated origin and one captured server/channel/screen. */
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
  private volume: number;
  private documentUrl: string | null = null;

  constructor(screen: BotScreen, viewer: BotScreenViewer, private consent: BotScreenDocumentConsent,
    private onAction: (action: BotScreenAction) => void,
    private onError: (error: unknown) => void, volume = 1) {
    if (!botScreenDocumentConsentSchema.safeParse(consent).success || consent.screenId !== screen.id ||
        consent.instanceId !== screen.instanceId || consent.botId !== screen.botId) {
      this.channel.port1.close();
      this.channel.port2.close();
      throw new Error('Miniapp consent does not match this instance.');
    }
    if (BotScreenFrame.active.size >= 2) {
      this.channel.port1.close();
      this.channel.port2.close();
      throw new Error('Close another active miniapp first.');
    }
    BotScreenFrame.active.add(this);
    this.snapshot = screen;
    this.locale = viewer.locale;
    this.volume = frameVolume(volume);
    this.element = document.createElement('iframe');
    this.element.className = 'bot-screen-frame';
    this.element.name = `monky-bot-screen-${crypto.randomUUID()}`;
    this.element.title = screen.title;
    this.element.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-downloads allow-presentation');
    this.element.setAttribute('referrerpolicy', 'no-referrer');
    this.element.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen *; autoplay *; encrypted-media *; gamepad *; usb 'none'; serial 'none'; hid 'none'");
    this.channel.port1.onmessage = this.onMessage;
    this.channel.port1.start();
    void this.loadDocument(botScreenDocument(screen, viewer, this.volume)).catch(error => {
      if (!this.destroyed) this.onError(error);
    });
  }

  private async loadDocument(html: string): Promise<void> {
    const url = await window.api.createBotScreenDocument(html, this.consent);
    if (this.destroyed) {
      await window.api.removeBotScreenDocument(url);
      return;
    }
    this.documentUrl = url;
    this.element.addEventListener('load', this.onLoad);
    this.element.src = url;
  }

  update(screen: BotScreen): void {
    if (this.destroyed || screen.id !== this.snapshot.id || screen.instanceId !== this.snapshot.instanceId || screen.channelId !== this.snapshot.channelId ||
        screen.botId !== this.snapshot.botId || screen.revision <= this.snapshot.revision) return;
    this.snapshot = screen;
    if (this.connected) this.channel.port1.postMessage({ type: 'state', state: screen.state, revision: screen.revision } satisfies FrameUpdate);
  }

  setLocale(locale: SupportedLanguage): void {
    if (this.destroyed || locale === this.locale) return;
    this.locale = locale;
    if (this.connected) this.channel.port1.postMessage({ type: 'locale', locale } satisfies FrameUpdate);
  }

  setVolume(volume: number): void {
    const next = frameVolume(volume);
    if (this.destroyed || next === this.volume) return;
    this.volume = next;
    if (this.connected) this.channel.port1.postMessage({ type: 'volume', volume: next } satisfies FrameUpdate);
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
    if (this.documentUrl) {
      void window.api.removeBotScreenDocument(this.documentUrl).catch(error => {
        console.error('[Bot screens] Could not release miniapp document.', error);
      });
      this.documentUrl = null;
    }
  }

  private onLoad = (): void => {
    // Navigation is allowed, but the new page cannot inherit the authenticated bridge.
    if (this.destroyed) return;
    if (this.connected) {
      this.channel.port1.onmessage = null;
      this.channel.port1.close();
      this.element.removeEventListener('load', this.onLoad);
      return;
    }
    this.connected = true;
    this.element.contentWindow?.postMessage('monky-screen-connect', '*', [this.channel.port2]);
    this.channel.port1.postMessage({ type: 'state', state: this.snapshot.state, revision: this.snapshot.revision } satisfies FrameUpdate);
    this.channel.port1.postMessage({ type: 'locale', locale: this.locale } satisfies FrameUpdate);
    // The document started with the volume of its creation; it may have changed while loading.
    this.channel.port1.postMessage({ type: 'volume', volume: this.volume } satisfies FrameUpdate);
  };

  private onMessage = (event: MessageEvent<unknown>): void => {
    if (this.destroyed || !this.connected) return;
    const now = Date.now();
    if (now - this.windowStart >= 1000) { this.windowStart = now; this.count = 0; }
    if (++this.count > BOT_SCREEN_LIMITS.actionsPerSecond) return;
    if (!event.data || typeof event.data !== 'object' || !('action' in event.data) || !('payload' in event.data) ||
        !('revision' in event.data) || Object.keys(event.data).some((key) => key !== 'action' && key !== 'payload' && key !== 'revision')) return;
    const parsed = botScreenActionSchema.safeParse({
      id: this.snapshot.id, instanceId: this.snapshot.instanceId, action: event.data.action, payload: event.data.payload,
      // Use the revision actually rendered in the child, not a newer state still in transit to it.
      revision: event.data.revision, actionId: crypto.randomUUID(),
    });
    if (parsed.success) this.onAction(parsed.data);
  };
}
