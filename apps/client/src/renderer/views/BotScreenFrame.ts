import {
  BOT_SCREEN_LIMITS, botScreenActionSchema, botScreenDocumentConsentSchema, type BotScreen, type BotScreenAction,
  type BotScreenBeforeCloseReason, type BotScreenBridge, type BotScreenCloseReason, type BotScreenDocumentConsent, type BotScreenJson,
} from '@monky/shared';
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
  | { type: 'volume'; volume: number }
  | { type: 'beforeClose'; id: string; reason: BotScreenBeforeCloseReason } | { type: 'close'; reason: BotScreenCloseReason };

/** Lifecycle messages from the bridge; actions keep their own `{ action, payload, revision }` shape. */
type FrameControl = { type: 'hooks'; beforeClose: boolean; close: boolean } | { type: 'beforeCloseAck'; id: string }
  | { type: 'beforeCloseResult'; id: string; proceed: boolean } | { type: 'closed' };

/**
 * Sent with `window.postMessage`, unlike the port messages: it reaches the browser over the frame's
 * own route, after any download the miniapp started while answering, then is delivered to the parent.
 */
type FrameHandOff = { type: 'monky-screen-handoff'; id: string };

type BeforeCloseHandler = Parameters<BotScreenBridge['onBeforeClose']>[0];
type CloseHandler = Parameters<BotScreenBridge['onClose']>[0];

interface PendingBeforeClose {
  id: string;
  resolve: (proceed: boolean) => void;
  /** The acknowledgement deadline; once the miniapp agreed to close, the hand-off deadline. */
  timer: number | null;
  acknowledged: boolean;
  proceeding: boolean;
  handedOff: boolean;
}

/** A responsive bridge acknowledges at once, so silence means the document is stuck. */
const BEFORE_CLOSE_ACK_MS = 3000;
/** The hand-off normally arrives within milliseconds; a page that broke it only delays its close. */
const HAND_OFF_FALLBACK_MS = 1000;
/** How long a closing view may run hidden and muted for its onClose handlers to finish. */
const CLOSE_GRACE_MS = 5000;
/** Bridges announce hooks only when they change; a flood is not legitimate use. */
const HOOK_ANNOUNCEMENTS_PER_SECOND = 20;

/** 0 mutes, 1 keeps the miniapp's own levels and 2 doubles its Web Audio output. */
function frameVolume(volume: number): number {
  return Number.isFinite(volume) ? Math.min(2, Math.max(0, volume)) : 1;
}

/** Self-contained because its source executes in a separate, unprivileged origin. */
function screenBootstrap(seed: FrameSeed, installVolume: typeof installMiniappVolume): void {
  let setVolume: ((volume: number) => void) | null = null;
  try { setVolume = installVolume(window, seed.volume); }
  catch (error: unknown) { console.warn('[Monky] The miniapp volume control is unavailable.', error); }
  // Captured before the bot's scripts run: they can replace `window.parent`, not this reference.
  const host = parent;
  let state = seed.state;
  let revision = seed.revision;
  let port: MessagePort | null = null;
  const listeners = new Set<(state: BotScreenJson, revision: number) => void>();
  const beforeCloseHandlers = new Set<BeforeCloseHandler>();
  const closeHandlers = new Set<CloseHandler>();
  // The parent only waits for the hooks it was told about.
  let announced = 'false,false';
  let closing = false;
  let locale = seed.viewer.locale;
  const viewer = Object.freeze({ id: seed.viewer.id, nickname: seed.viewer.nickname, get locale() { return locale; } });
  let start = 0;
  let sent = 0;
  const announce = (): void => {
    const beforeClose = beforeCloseHandlers.size > 0;
    const close = closeHandlers.size > 0;
    if (!port || closing || `${beforeClose},${close}` === announced) return;
    announced = `${beforeClose},${close}`;
    port.postMessage({ type: 'hooks', beforeClose, close } satisfies FrameControl);
  };
  const runBeforeClose = async (id: string, reason: BotScreenBeforeCloseReason): Promise<void> => {
    if (closing) return;
    // Acknowledge first: the parent tells a stuck document from one asking its person something.
    port?.postMessage({ type: 'beforeCloseAck', id } satisfies FrameControl);
    const event = Object.freeze({ reason });
    let proceed = true;
    for (const handler of [...beforeCloseHandlers]) {
      try {
        if (await handler(event) === false) {
          proceed = false;
          break;
        }
      } catch (error: unknown) { console.error(error); }
    }
    if (closing) return;
    port?.postMessage({ type: 'beforeCloseResult', id, proceed } satisfies FrameControl);
    // Downloads started while answering (e.g. "Save") must reach the browser before the parent
    // discards this document; the port alone does not order them.
    if (proceed) host.postMessage({ type: 'monky-screen-handoff', id } satisfies FrameHandOff, '*');
  };
  const runClose = (reason: BotScreenCloseReason): void => {
    if (closing) return;
    closing = true;
    // The view is already hidden from its person; it must not be heard either.
    setVolume?.(0);
    const event = Object.freeze({ reason });
    void Promise.allSettled([...closeHandlers].map(async (handler) => { await handler(event); })).then((results) => {
      for (const result of results) if (result.status === 'rejected') console.error(result.reason);
      port?.postMessage({ type: 'closed' } satisfies FrameControl);
    });
  };
  const api: BotScreenBridge = Object.freeze({
    viewer,
    onState(callback: (state: BotScreenJson, revision: number) => void): () => void {
      if (typeof callback !== 'function') throw new TypeError('Expected a state callback.');
      listeners.add(callback);
      callback(structuredClone(state), revision);
      return () => { listeners.delete(callback); };
    },
    sendAction(action: string, payload: BotScreenJson): boolean {
      if (!port || closing || typeof action !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(action)) return false;
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
    onBeforeClose(handler: BeforeCloseHandler): () => void {
      if (typeof handler !== 'function') throw new TypeError('Expected a before-close handler.');
      beforeCloseHandlers.add(handler);
      announce();
      return () => {
        beforeCloseHandlers.delete(handler);
        announce();
      };
    },
    onClose(handler: CloseHandler): () => void {
      if (typeof handler !== 'function') throw new TypeError('Expected a close handler.');
      closeHandlers.add(handler);
      announce();
      return () => {
        closeHandlers.delete(handler);
        announce();
      };
    },
  });
  Object.defineProperty(window, 'monkyScreen', { value: api, writable: false, configurable: false });
  const connect = (event: MessageEvent<unknown>): void => {
    if (event.source !== host || event.data !== 'monky-screen-connect' || event.ports.length !== 1 || port) return;
    port = event.ports[0]!;
    window.removeEventListener('message', connect);
    port.onmessage = (event: MessageEvent<FrameUpdate>) => {
      if (event.data.type === 'beforeClose') {
        void runBeforeClose(event.data.id, event.data.reason);
        return;
      }
      if (event.data.type === 'close') {
        runClose(event.data.reason);
        return;
      }
      // A closing view stays muted and receives nothing else.
      if (closing) return;
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
    // Hooks are usually registered while the document loads, before the port arrives.
    announce();
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

/** Strict parsing of the bridge's lifecycle messages; anything else is ignored. */
function frameControl(data: object): FrameControl | null {
  if (!('type' in data)) return null;
  const keys = Object.keys(data).sort().join();
  if (data.type === 'hooks' && keys === 'beforeClose,close,type' && 'beforeClose' in data && 'close' in data &&
      typeof data.beforeClose === 'boolean' && typeof data.close === 'boolean') {
    return { type: 'hooks', beforeClose: data.beforeClose, close: data.close };
  }
  if (data.type === 'beforeCloseAck' && keys === 'id,type' && 'id' in data && typeof data.id === 'string') {
    return { type: 'beforeCloseAck', id: data.id };
  }
  if (data.type === 'beforeCloseResult' && keys === 'id,proceed,type' && 'id' in data && 'proceed' in data &&
      typeof data.id === 'string' && typeof data.proceed === 'boolean') {
    return { type: 'beforeCloseResult', id: data.id, proceed: data.proceed };
  }
  return data.type === 'closed' && keys === 'type' ? { type: 'closed' } : null;
}

let holdingArea: HTMLElement | null = null;

/**
 * Parks a closing frame off stage, so re-rendering or leaving the stage cannot cut its onClose
 * short. `moveBefore()` keeps the browsing context alive, where `append()` would reload it.
 */
function park(element: HTMLIFrameElement): boolean {
  if (!element.isConnected) return false;
  let area = holdingArea;
  if (!area?.isConnected) {
    area = document.createElement('div');
    area.className = 'bot-screen-holding';
    area.hidden = true;
    area.inert = true;
    area.setAttribute('aria-hidden', 'true');
    document.body.append(area);
    holdingArea = area;
  }
  const host: ParentNode & { moveBefore?: (node: Node, child: Node | null) => void } = area;
  if (typeof host.moveBefore !== 'function') return false;
  try {
    host.moveBefore(element, null);
    return true;
  } catch (error: unknown) {
    console.warn('[Bot screens] Could not keep a closing miniapp off stage.', error);
    return false;
  }
}

/** One port is bound to one isolated origin and one captured server/channel/screen. */
export class BotScreenFrame {
  private static active = new Set<BotScreenFrame>();
  /** Closing frames still own one of the window's documents until their onClose ends. */
  private static retiring = new Set<BotScreenFrame>();
  readonly element: HTMLIFrameElement;
  private channel = new MessageChannel();
  private destroyed = false;
  private connected = false;
  private closing = false;
  private hooks = { beforeClose: false, close: false };
  private pendingBeforeClose: PendingBeforeClose | null = null;
  private closeTimer: number | null = null;
  private windowStart = 0;
  private count = 0;
  private hookWindowStart = 0;
  private hookCount = 0;
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
    // A closing view gives way to one being opened, within the window's two documents.
    for (const frame of BotScreenFrame.retiring) {
      if (BotScreenFrame.active.size + BotScreenFrame.retiring.size < 2) break;
      frame.destroy();
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
    if (this.destroyed || this.closing || screen.id !== this.snapshot.id || screen.instanceId !== this.snapshot.instanceId || screen.channelId !== this.snapshot.channelId ||
        screen.botId !== this.snapshot.botId || screen.revision <= this.snapshot.revision) return;
    this.snapshot = screen;
    if (this.connected) this.channel.port1.postMessage({ type: 'state', state: screen.state, revision: screen.revision } satisfies FrameUpdate);
  }

  setLocale(locale: SupportedLanguage): void {
    if (this.destroyed || this.closing || locale === this.locale) return;
    this.locale = locale;
    if (this.connected) this.channel.port1.postMessage({ type: 'locale', locale } satisfies FrameUpdate);
  }

  setVolume(volume: number): void {
    const next = frameVolume(volume);
    if (this.destroyed || this.closing || next === this.volume) return;
    this.volume = next;
    if (this.connected) this.channel.port1.postMessage({ type: 'volume', volume: next } satisfies FrameUpdate);
  }

  /** Whether a close this person asks for must first wait for the miniapp's onBeforeClose. */
  get asksBeforeClose(): boolean {
    return !this.destroyed && !this.closing && this.connected && this.hooks.beforeClose;
  }

  /**
   * Resolves whether to go on closing: the miniapp's answer, or `true` when it is stuck, gone or
   * was overridden with **Close now**. The person can always leave.
   */
  requestBeforeClose(reason: BotScreenBeforeCloseReason): Promise<boolean> {
    if (!this.asksBeforeClose) return Promise.resolve(true);
    if (this.pendingBeforeClose) return Promise.resolve(false);
    return new Promise((resolve) => {
      const pending: PendingBeforeClose = {
        id: crypto.randomUUID(), resolve, timer: null, acknowledged: false, proceeding: false, handedOff: false,
      };
      pending.timer = window.setTimeout(() => {
        if (this.pendingBeforeClose === pending) this.settleBeforeClose(true);
      }, BEFORE_CLOSE_ACK_MS);
      this.pendingBeforeClose = pending;
      window.addEventListener('message', this.onHandOff);
      this.channel.port1.postMessage({ type: 'beforeClose', id: pending.id, reason } satisfies FrameUpdate);
    });
  }

  /** **Close now**: stops waiting for the miniapp's answer. */
  forceClose(): void {
    this.settleBeforeClose(true);
  }

  /**
   * Two-phase close. At once, as any revocation requires: no bridge, no sound and nothing on
   * screen. Then, only for a document with onClose hooks, up to CLOSE_GRACE_MS off stage.
   */
  retire(reason: BotScreenCloseReason): void {
    if (this.destroyed || this.closing) return;
    this.settleBeforeClose(true);
    if (!this.connected || !this.hooks.close) {
      this.destroy();
      return;
    }
    if (document.fullscreenElement === this.element) {
      void document.exitFullscreen().catch((error: unknown) => { console.warn('[Bot screens] Could not exit miniapp fullscreen.', error); });
    }
    if (!park(this.element)) {
      this.destroy();
      return;
    }
    this.closing = true;
    BotScreenFrame.active.delete(this);
    BotScreenFrame.retiring.add(this);
    this.channel.port1.postMessage({ type: 'close', reason } satisfies FrameUpdate);
    this.closeTimer = window.setTimeout(() => this.destroy(), CLOSE_GRACE_MS);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    BotScreenFrame.active.delete(this);
    BotScreenFrame.retiring.delete(this);
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.settleBeforeClose(true);
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
      // Nor the lifecycle hooks of the page that registered them.
      this.hooks = { beforeClose: false, close: false };
      this.settleBeforeClose(true);
      if (this.closing) this.destroy();
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
    if (event.data && typeof event.data === 'object' && 'type' in event.data) {
      this.onControl(event.data);
      return;
    }
    // A closing view has no bridge: its actions are dropped, not queued.
    if (this.closing) return;
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

  private onControl(data: object): void {
    const message = frameControl(data);
    if (!message) return;
    if (message.type === 'hooks') {
      const now = Date.now();
      if (now - this.hookWindowStart >= 1000) { this.hookWindowStart = now; this.hookCount = 0; }
      if (++this.hookCount > HOOK_ANNOUNCEMENTS_PER_SECOND || this.closing) return;
      this.hooks = { beforeClose: message.beforeClose, close: message.close };
    } else if (message.type === 'beforeCloseAck') {
      const pending = this.pendingBeforeClose;
      if (pending?.id !== message.id || pending.acknowledged || pending.proceeding) return;
      // Responsive: from now on the miniapp may take as long as its person needs.
      pending.acknowledged = true;
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = null;
    } else if (message.type === 'beforeCloseResult') {
      const pending = this.pendingBeforeClose;
      if (pending?.id !== message.id || pending.proceeding) return;
      if (!message.proceed || pending.handedOff) {
        this.settleBeforeClose(message.proceed);
        return;
      }
      // Closing now could discard a download the person just started: wait for the hand-off.
      pending.proceeding = true;
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.timer = window.setTimeout(() => {
        if (this.pendingBeforeClose === pending) this.settleBeforeClose(true);
      }, HAND_OFF_FALLBACK_MS);
    } else if (this.closing) this.destroy();
  }

  /** Window messages come from anything in the frame; only the pending request's own ID counts. */
  private onHandOff = (event: MessageEvent<unknown>): void => {
    const pending = this.pendingBeforeClose;
    const data = event.data;
    if (!pending || event.source !== this.element.contentWindow || !data || typeof data !== 'object' ||
        !('type' in data) || !('id' in data) || data.type !== 'monky-screen-handoff' || data.id !== pending.id ||
        Object.keys(data).length !== 2) return;
    pending.handedOff = true;
    if (pending.proceeding) this.settleBeforeClose(true);
  };

  private settleBeforeClose(proceed: boolean): void {
    const pending = this.pendingBeforeClose;
    if (!pending) return;
    this.pendingBeforeClose = null;
    window.removeEventListener('message', this.onHandOff);
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.resolve(proceed);
  }
}
