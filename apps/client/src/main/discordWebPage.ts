import { app, BrowserWindow, screen, shell, session, type NativeImage, type Rectangle, type Session } from 'electron';
import {
  DISCORD_WEB_HOME, DISCORD_WEB_MAX_POPUPS, discordWebLayersSchema, discordWebRouting, discordWebShowsServers, discordWebUrl,
  type DiscordWebCommand, type DiscordWebFrame, type DiscordWebLayers, type DiscordWebPopup,
} from '@monky/shared';
import { webUrl } from './ipc/guards';
import { allowDiscordNavigation } from './webContentsPolicy';

/** Persistent, so the Discord login survives restarts; it never shares storage with Monky's own pages. */
const DISCORD_PARTITION = 'persist:monky-discord';
const DISCORD_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-sanitized-write']);
const FRAME_RATE = 60;
/** Repaints closer together than this reach Monky's window as one patch. */
const FLUSH_INTERVAL_MS = 16;

/** A world of Monky's own in the page, which Discord's scripts can neither see nor reach. */
const LAYERS_WORLD = 1001;
/** A page too busy to answer keeps its last known layers rather than holding its pictures back. */
const LAYERS_TIMEOUT_MS = 100;
const NO_LAYERS: DiscordWebLayers = { popups: [], modal: false, servers: null };
/**
 * How opaque a menu or tooltip must be to be drawn. Discord fades them in and
 * out: drawn whole elsewhere, a fading one would show the page behind it. It
 * still counts below that, so the parts of Monky where it does not belong
 * keep it out; only one too faint to paint anything is left aside.
 */
const MIN_POPUP_OPACITY = 0.95;
const MIN_PAINTED_OPACITY = 0.01;
/** A point this far above the page's bottom, in the middle of the server list's column, lies on Discord's user panel. */
const PANEL_PROBE_RISE = 24;

/**
 * Finds where Discord's own menus and tooltips are, whether it shows a modal
 * window, how far its server list has scrolled and how tall its user panel is,
 * by their standard accessibility roles, Discord's list id and what lies at the
 * list's bottom. It reads boxes, visibility and
 * scroll only: no text, and nothing on the page is changed.
 */
export const LAYERS_PROBE = `(() => {
  const popups = [];
  for (const element of document.querySelectorAll('[role="menu"], [role="tooltip"]')) {
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || getComputedStyle(element).visibility !== 'visible') continue;
    let opacity = 1;
    for (let node = element; node && opacity >= ${MIN_PAINTED_OPACITY}; node = node.parentElement) {
      opacity *= parseFloat(getComputedStyle(node).opacity) || 0;
    }
    if (opacity < ${MIN_PAINTED_OPACITY}) continue;
    popups.push({ kind: element.getAttribute('role'), x: box.left, y: box.top, width: box.width, height: box.height,
      radius: Math.min(64, parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0), shown: opacity >= ${MIN_POPUP_OPACITY} });
    if (popups.length === ${DISCORD_WEB_MAX_POPUPS}) break;
  }
  const tree = document.querySelector('[data-list-id="guildsnav"]');
  const list = tree && [tree, ...tree.children].find(node => /^(?:auto|scroll)$/.test(getComputedStyle(node).overflowY));
  const box = list && list.getBoundingClientRect();
  // Discord's user panel, which covers the bottom of its list, is the outermost
  // box at that corner that does not hold the list too; a call makes it taller.
  let panel = tree && document.elementsFromPoint(box ? box.left + box.width / 2 : 36, innerHeight - ${PANEL_PROBE_RISE})
    .find(node => !node.contains(tree) && !tree.contains(node) && !node.closest('[role="menu"], [role="tooltip"]'));
  while (panel && panel.parentElement && !panel.parentElement.contains(tree)) panel = panel.parentElement;
  const panelBox = panel && panel.getBoundingClientRect();
  const panelRise = panelBox && panelBox.height >= 1 && panelBox.height < innerHeight / 2 && box && panelBox.left < box.right
    ? innerHeight - panelBox.top : null;
  const servers = list && box.height >= 1
    ? { top: box.top, height: list.clientHeight, scrollTop: Math.max(0, list.scrollTop), scrollHeight: list.scrollHeight,
      panel: panelRise }
    : null;
  return { popups, modal: document.querySelector('[role="dialog"][aria-modal="true"]') !== null, servers };
})()`;

/**
 * How long a menu or tooltip must stay in the same place, opaque, before Monky
 * draws it whole. The page is read after its picture is taken, and its
 * pictures reach Monky a few frames behind it: drawn sooner, a popup that just
 * appeared, moved or changed size would show the page behind it instead.
 */
const POPUP_SETTLE_MS = 80;

export interface SeenPopup { popup: DiscordWebPopup; since: number }

const samePopup = (a: DiscordWebPopup, b: DiscordWebPopup): boolean => a.kind === b.kind && a.shown === b.shown
  && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5
  && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

/**
 * Tells which of the popups just read are shown, opaque and settled (see
 * POPUP_SETTLE_MS), and how long until the next one settles, if any is still
 * settling. The others are still handed on, not shown, so that Monky keeps them
 * out of the parts of its window where they do not belong.
 */
export function settleLayers(seen: readonly SeenPopup[], current: DiscordWebLayers, now: number): {
  seen: SeenPopup[]; layers: DiscordWebLayers; wait: number | null;
} {
  const next = current.popups.map(popup => ({ popup, since: seen.find(entry => samePopup(entry.popup, popup))?.since ?? now }));
  const settling = next.filter(entry => entry.popup.shown && now - entry.since < POPUP_SETTLE_MS);
  return {
    seen: next,
    layers: { ...current, popups: next.map(entry => ({ ...entry.popup, shown: entry.popup.shown && !settling.includes(entry) })) },
    wait: settling.length ? Math.max(1, Math.min(...settling.map(entry => entry.since + POPUP_SETTLE_MS - now))) : null,
  };
}

type InputCommand = Extract<DiscordWebCommand, { action: 'mouse' | 'wheel' | 'key' }>;

const MOUSE_TYPES = { down: 'mouseDown', up: 'mouseUp', move: 'mouseMove', enter: 'mouseEnter', leave: 'mouseLeave' } as const;
const KEY_TYPES = { down: 'keyDown', up: 'keyUp', char: 'char' } as const;

export interface DiscordWebPageEvents {
  frame(frame: DiscordWebFrame): void;
  cursor(type: string): void;
  split(split: boolean): void;
  closed(): void;
}

function fromDiscord(url: string | undefined): boolean {
  return typeof url === 'string' && discordWebUrl(url) !== null;
}

/** The plain Chrome identity: Discord gets no hint of Electron or Monky that could make it expect its own desktop app. */
function chromeUserAgent(): string {
  const embedder = new RegExp(`^(?:Electron|${app.getName().replace(/[^a-z0-9]/gi, '')})/`, 'i');
  return app.userAgentFallback.split(' ').filter(token => !embedder.test(token)).join(' ');
}

function prepareSession(discord: Session): void {
  discord.setUserAgent(chromeUserAgent());
  discord.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(DISCORD_PERMISSIONS.has(permission) && fromDiscord(details.requestingUrl));
  });
  discord.setPermissionCheckHandler((_contents, permission, origin) => DISCORD_PERMISSIONS.has(permission) && fromDiscord(origin));
  discord.setDevicePermissionHandler(() => false);
  // Sharing a screen from inside Discord is not offered.
  discord.setDisplayMediaRequestHandler((_request, callback) => callback({}));
}

function openExternal(value: string): void {
  const url = webUrl(value);
  if (url) void shell.openExternal(url.href).catch(error => console.warn('[Discord web] Could not open a link.', error));
}

function union(a: Rectangle | null, b: Rectangle): Rectangle {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * One real Discord page, rendered offscreen in a hidden window that is never
 * shown. Monky's window draws its frames in two places (the server list in
 * Monky's rail, the rest in Monky's main area) and hands the pointer and the
 * keyboard back to it. The page itself is never changed, styled or automated:
 * it only receives the input a person gives it through Monky. All Monky reads
 * from it is where its menus and tooltips are and how far its server list has
 * scrolled (see LAYERS_PROBE), so that they show whole next to what opened them
 * and every server stays within reach in Monky's rail.
 */
export class DiscordWebPage {
  private window: BrowserWindow | null = null;
  private visible = false;
  private size: { width: number; height: number } | null = null;
  /** Monky's zoom last handed to the page, so both draw at the same scale. */
  private sharedZoom = 1;
  private image: NativeImage | null = null;
  private dirty: Rectangle | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlush = 0;
  /** A picture waits for its layers, so the next one waits for it. */
  private flushing = false;
  private layers: DiscordWebLayers = NO_LAYERS;
  /** The popups last read, and since when each has stayed in place. */
  private seen: SeenPopup[] = [];
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Whether the page shows Discord's server list; unknown until Discord routes its entry address. */
  private split: boolean | null = null;

  constructor(private readonly owner: BrowserWindow, private readonly events: DiscordWebPageEvents) {}

  open(): void {
    if (this.disposed || this.owner.isDestroyed()) throw new Error('The Discord owner window is closed.');
    if (this.window) return;
    const discord = session.fromPartition(DISCORD_PARTITION);
    prepareSession(discord);
    const scale = screen.getDisplayMatching(this.owner.getBounds()).scaleFactor;
    const window = new BrowserWindow({
      show: false, frame: false, skipTaskbar: true, enableLargerThanScreen: true, useContentSize: true, width: 1280, height: 720,
      title: 'Discord', paintWhenInitiallyHidden: true,
      webPreferences: {
        session: discord, offscreen: { deviceScaleFactor: scale }, sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, webviewTag: false, navigateOnDragDrop: false, spellcheck: true,
        // Discord keeps its connection and notifications while Monky shows something else.
        backgroundThrottling: false,
      },
    });
    const contents = window.webContents;
    allowDiscordNavigation(contents);
    this.window = window;
    contents.setFrameRate(FRAME_RATE);
    contents.on('paint', (_event, dirty, image) => this.painted(window, dirty, image));
    contents.on('cursor-changed', (_event, type) => { if (this.window === window) this.events.cursor(type); });
    const followAddress = (): void => {
      const url = contents.getURL();
      if (this.window === window && !discordWebRouting(url)) this.setSplit(discordWebShowsServers(url));
    };
    contents.on('did-navigate', followAddress);
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) followAddress(); });

    const leaveDiscord = (event: { url: string; preventDefault(): void }): void => {
      if (fromDiscord(event.url)) return;
      event.preventDefault();
      openExternal(event.url);
    };
    contents.on('will-navigate', leaveDiscord);
    contents.on('will-redirect', event => { if (event.isMainFrame) leaveDiscord(event); });
    contents.setWindowOpenHandler(({ url }) => {
      if (fromDiscord(url)) void contents.loadURL(url).catch(() => undefined);
      else openExternal(url);
      return { action: 'deny' };
    });
    contents.once('render-process-gone', () => { if (this.window === window) this.close(); });
    window.once('closed', () => { if (this.window === window) this.close(); });
    this.applyLayout();
    void contents.loadURL(DISCORD_WEB_HOME).catch(error => {
      if (this.window === window) console.warn('[Discord web] The first page did not finish loading.', error instanceof Error ? error.message : error);
    });
  }

  /** The page's size in Monky's CSS pixels, and whether Monky currently shows it. */
  layout(width: number, height: number, visible: boolean): void {
    const appeared = visible && !this.visible;
    this.size = { width, height };
    this.visible = visible;
    if (!visible) this.seen = [];
    this.applyLayout();
    // Monky's copy of the page may be stale after it was hidden: send it whole again.
    if (appeared) this.liveContents()?.invalidate();
  }

  input(command: InputCommand): void {
    const contents = this.liveContents();
    if (!contents || !this.visible) return;
    if (command.action === 'key') {
      contents.sendInputEvent({ type: KEY_TYPES[command.type], keyCode: command.keyCode, modifiers: command.modifiers });
      return;
    }
    const zoom = this.sharedZoom;
    const x = Math.round(command.x * zoom), y = Math.round(command.y * zoom);
    if (command.action === 'wheel') {
      // Electron counts wheel deltas the other way round from the DOM.
      contents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -command.deltaX * zoom, deltaY: -command.deltaY * zoom,
        canScroll: true, modifiers: command.modifiers });
      return;
    }
    contents.sendInputEvent({ type: MOUSE_TYPES[command.type], x, y, button: command.button, clickCount: command.clickCount,
      modifiers: command.modifiers });
  }

  private setSplit(split: boolean): void {
    if (split === this.split) return;
    this.split = split;
    this.events.split(split);
  }

  private liveContents(): Electron.WebContents | null {
    const window = this.window;
    return window && !window.isDestroyed() && !window.webContents.isDestroyed() ? window.webContents : null;
  }

  private applyLayout(): void {
    const window = this.window, contents = this.liveContents(), size = this.size;
    if (!window || !contents) return;
    if (size && !this.owner.isDestroyed()) {
      const zoom = this.owner.webContents.getZoomFactor();
      if (zoom !== this.sharedZoom || contents.getZoomFactor() !== zoom) {
        this.sharedZoom = zoom;
        contents.setZoomFactor(zoom);
      }
      const width = Math.max(1, Math.round(size.width * zoom)), height = Math.max(1, Math.round(size.height * zoom));
      const [currentWidth, currentHeight] = window.getContentSize();
      if (currentWidth !== width || currentHeight !== height) window.setContentSize(width, height);
    }
    if (this.visible && !contents.isPainting()) contents.startPainting();
    else if (!this.visible && contents.isPainting()) contents.stopPainting();
  }

  private painted(window: BrowserWindow, dirty: Rectangle, image: NativeImage): void {
    if (this.window !== window || !this.visible || dirty.width <= 0 || dirty.height <= 0) return;
    this.image = image;
    this.dirty = union(this.dirty, dirty);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.flushing || !this.dirty) return;
    const wait = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - this.lastFlush));
    this.flushTimer = setTimeout(() => void this.flush(), wait);
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    const window = this.window, image = this.image, dirty = this.dirty;
    this.image = null;
    this.dirty = null;
    if (!window || !image || !dirty || !this.visible) return;
    this.lastFlush = Date.now();
    const { width, height } = image.getSize();
    const x = Math.max(0, Math.min(width, dirty.x)), y = Math.max(0, Math.min(height, dirty.y));
    const patchWidth = Math.min(width, dirty.x + dirty.width) - x, patchHeight = Math.min(height, dirty.y + dirty.height) - y;
    if (patchWidth <= 0 || patchHeight <= 0) return;
    const pixels = image.crop({ x, y, width: patchWidth, height: patchHeight }).toBitmap();
    if (pixels.length !== patchWidth * patchHeight * 4) return;
    this.flushing = true;
    try {
      // The picture travels with the menus and tooltips it shows, so Monky never draws one where it does not belong.
      const layers = await this.readLayers(window);
      if (this.window !== window || !this.visible) return;
      const settled = settleLayers(this.seen, layers, Date.now());
      this.seen = settled.seen;
      this.events.frame({ width, height, x, y, patchWidth, patchHeight, pixels, ...settled.layers });
      if (settled.wait !== null) this.recheckLayers(window, image, settled.wait);
    } finally {
      this.flushing = false;
      this.scheduleFlush();
    }
  }

  /** Reads a still page again once its settling popups are due; one pixel of its own picture carries them. */
  private recheckLayers(window: BrowserWindow, image: NativeImage, wait: number): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.window !== window || !this.visible) return;
      this.image ??= image;
      this.dirty = union(this.dirty, { x: 0, y: 0, width: 1, height: 1 });
      this.scheduleFlush();
    }, wait);
  }

  private async readLayers(window: BrowserWindow): Promise<DiscordWebLayers> {
    const contents = this.liveContents();
    if (!contents || this.window !== window) return NO_LAYERS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), LAYERS_TIMEOUT_MS); });
    try {
      const read: unknown = await Promise.race([contents.executeJavaScriptInIsolatedWorld(LAYERS_WORLD, [{ code: LAYERS_PROBE }]), late]);
      if (read !== null && this.window === window) {
        const parsed = discordWebLayersSchema.safeParse(read);
        this.layers = parsed.success ? parsed.data : NO_LAYERS;
      }
    } catch {
      // A page between two addresses has no menus to show.
      if (this.window === window) this.layers = NO_LAYERS;
    } finally {
      clearTimeout(timer);
    }
    return this.window === window ? this.layers : NO_LAYERS;
  }

  close(): void {
    const window = this.window;
    if (!window) return;
    this.window = null;
    this.visible = false;
    this.size = null;
    this.sharedZoom = 1;
    this.split = null;
    this.image = null;
    this.dirty = null;
    this.layers = NO_LAYERS;
    this.seen = [];
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!window.isDestroyed()) window.destroy();
    this.events.closed();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.close();
  }
}
