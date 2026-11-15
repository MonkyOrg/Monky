import { app, BrowserWindow, screen, shell, session, type NativeImage, type Rectangle, type Session, type WebContents } from 'electron';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  DISCORD_WEB_HOME, DISCORD_WEB_MAX_POPUPS, discordWebLayersSchema, discordWebRouting, discordWebShowsServers, discordWebUrl,
  type DiscordWebCommand, type DiscordWebFrame, type DiscordWebLayers, type DiscordWebPopup,
} from '@monky/shared';
import { webUrl } from './ipc/guards';
import { attachDevTools, DiscordWebFrames } from './discordWebFrames';
import { DiscordWebFileChooser } from './discordWebFileChooser';
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
const NO_LAYERS: DiscordWebLayers = { popups: [], modal: null, servers: null };
/** Resolves after the page drew two frames: the one reacting to a drag and the one showing it. */
const NEXT_FRAMES = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))';
/** The longest a drop waits for the page to draw its drop zone. */
const DROP_ZONE_WAIT_MS = 150;
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
 * Discord's menus, tooltips and popouts (a profile card, the emoji picker) and
 * its modal windows: a dialog is told apart by what it does to the page.
 */
const POPUP_SELECTOR = '[role="menu"], [role="tooltip"], [role="dialog"]';
/** DevTools' drag operation that copies what is dropped. */
const DRAG_COPY = 1;

/** Only a file that exists, named by its full path, is handed to Discord; never a folder. */
function isDroppableFile(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds where Discord's own menus, popouts and tooltips are, where its modal
 * window starts, how far its server list has scrolled and how tall its user panel is,
 * by their standard accessibility roles, Discord's list id and what lies at the
 * list's bottom. A popout takes the pointer as a menu does, so it is reported as
 * one. It reads boxes, colors, visibility and
 * scroll only: no text, and nothing on the page is changed.
 */
export const LAYERS_PROBE = `(() => {
  // Discord marks its account card aria-modal like a modal window, and both lay
  // a box over the whole page to catch clicks outside them; only a modal window
  // paints that box, dimming the page.
  const dimmed = [[1, 1], [innerWidth - 2, 1], [1, innerHeight - 2], [innerWidth - 2, innerHeight - 2]].some(([x, y]) => {
    const top = document.elementFromPoint(x, y);
    const box = top && top.getBoundingClientRect();
    if (!box || box.width < innerWidth || box.height < innerHeight) return false;
    const style = getComputedStyle(top);
    return !/^(?:transparent|rgba\\(0, 0, 0, 0\\))$/.test(style.backgroundColor) || (style.backdropFilter || 'none') !== 'none';
  });
  const popups = [];
  let modal = null;
  for (const element of document.querySelectorAll('${POPUP_SELECTOR}')) {
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || getComputedStyle(element).visibility !== 'visible') continue;
    const whole = box.width >= innerWidth && box.height >= innerHeight;
    if (element.getAttribute('aria-modal') === 'true' && (dimmed || whole)) {
      // Discord's settings fill the page and lay their content out from its left edge in a narrow one.
      const left = whole ? 0 : Math.max(0, box.left);
      modal = { left: modal ? Math.min(modal.left, left) : left };
      continue;
    }
    // A dialog filling the whole page is one of Discord's screens, not a popout.
    if (whole) continue;
    let opacity = 1;
    for (let node = element; node && opacity >= ${MIN_PAINTED_OPACITY}; node = node.parentElement) {
      opacity *= parseFloat(getComputedStyle(node).opacity) || 0;
    }
    if (opacity < ${MIN_PAINTED_OPACITY}) continue;
    if (popups.length === ${DISCORD_WEB_MAX_POPUPS}) continue;
    popups.push({ kind: element.getAttribute('role') === 'tooltip' ? 'tooltip' : 'menu', x: box.left, y: box.top, width: box.width, height: box.height,
      radius: Math.min(64, parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0), shown: opacity >= ${MIN_POPUP_OPACITY} });
  }
  const tree = document.querySelector('[data-list-id="guildsnav"]');
  const list = tree && [tree, ...tree.children].find(node => /^(?:auto|scroll)$/.test(getComputedStyle(node).overflowY));
  const box = list && list.getBoundingClientRect();
  // Discord's user panel, which covers the bottom of its list, is the outermost
  // box at that corner that does not hold the list too; a call makes it taller.
  let panel = tree && document.elementsFromPoint(box ? box.left + box.width / 2 : 36, innerHeight - ${PANEL_PROBE_RISE})
    .find(node => !node.contains(tree) && !tree.contains(node) && !node.closest('${POPUP_SELECTOR}'));
  while (panel && panel.parentElement && !panel.parentElement.contains(tree)) panel = panel.parentElement;
  const panelBox = panel && panel.getBoundingClientRect();
  const panelRise = panelBox && panelBox.height >= 1 && panelBox.height < innerHeight / 2 && box && panelBox.left < box.right
    ? innerHeight - panelBox.top : null;
  const servers = list && box.height >= 1
    ? { top: box.top, height: list.clientHeight, scrollTop: Math.max(0, list.scrollTop), scrollHeight: list.scrollHeight,
      panel: panelRise }
    : null;
  return { popups, modal, servers };
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
  fullscreen(fullscreen: boolean): void;
  closed(): void;
}

function fromDiscord(url: string | undefined): boolean {
  return typeof url === 'string' && discordWebUrl(url) !== null;
}

/**
 * What the page may use. A video may take the whole screen from a frame of
 * another site too (a YouTube embed): Discord's own page decides which frames
 * it lets do so.
 */
function permitted(contents: WebContents | null, permission: string, url: string | undefined): boolean {
  if (permission === 'fullscreen') return fromDiscord(contents?.getURL());
  return DISCORD_PERMISSIONS.has(permission) && fromDiscord(url);
}

/** The plain Chrome identity: Discord gets no hint of Electron or Monky that could make it expect its own desktop app. */
function chromeUserAgent(): string {
  const embedder = new RegExp(`^(?:Electron|${app.getName().replace(/[^a-z0-9]/gi, '')})/`, 'i');
  return app.userAgentFallback.split(' ').filter(token => !embedder.test(token)).join(' ');
}

function prepareSession(discord: Session): void {
  discord.setUserAgent(chromeUserAgent());
  discord.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(permitted(contents, permission, details.requestingUrl));
  });
  discord.setPermissionCheckHandler((contents, permission, origin) => permitted(contents, permission, origin));
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
  /** Whether Monky's keyboard is on the page, as Monky's window last told. */
  private focusWanted = false;
  /** Whether the page currently believes it has the focus (see applyFocus). */
  private focusEmulated = false;
  /** Takes the pointer to the frames the page embeds from other sites. */
  private frames: DiscordWebFrames | null = null;
  /** Opens the files the page asks for over Monky's window. */
  private chooser: DiscordWebFileChooser | null = null;
  /** Whether the page shows something on its whole screen, which Monky's window then shows alone. */
  private fullscreen = false;

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
      // A video on the whole screen fills the page itself; the hidden window would otherwise cover the screen and show.
      fullscreenable: false,
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
    contents.on('enter-html-full-screen', () => this.setFullscreen(window, true));
    contents.on('leave-html-full-screen', () => this.setFullscreen(window, false));
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
    const frames = new DiscordWebFrames(contents);
    this.frames = frames;
    const chooser = new DiscordWebFileChooser(contents, this.owner);
    this.chooser = chooser;
    contents.debugger.on('detach', () => {
      if (this.window !== window) return;
      this.focusEmulated = false;
      frames.detached();
      chooser.detached();
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
    this.applyFocus();
    // Monky's copy of the page may be stale after it was hidden: send it whole again.
    if (appeared) this.liveContents()?.invalidate();
  }

  focus(focused: boolean): void {
    this.focusWanted = focused;
    this.applyFocus();
  }

  input(command: InputCommand): void {
    const contents = this.liveContents();
    if (!contents || !this.visible) return;
    this.chooser?.watch();
    if (command.action === 'key') {
      contents.sendInputEvent({ type: KEY_TYPES[command.type], keyCode: command.keyCode, modifiers: command.modifiers });
      return;
    }
    const zoom = this.sharedZoom;
    const x = Math.round(command.x * zoom), y = Math.round(command.y * zoom);
    const frames = this.frames;
    if (!frames) return;
    if (command.action === 'wheel') {
      // Electron counts wheel deltas the other way round from the DOM.
      frames.route(command, () => contents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -command.deltaX * zoom,
        deltaY: -command.deltaY * zoom, canScroll: true, modifiers: command.modifiers }));
      return;
    }
    frames.route(command, () => contents.sendInputEvent({ type: MOUSE_TYPES[command.type], x, y, button: command.button,
      clickCount: command.clickCount, modifiers: command.modifiers }));
  }

  /**
   * Drops files from the disk on the page where the person let go of them, as
   * Chromium would for a drag from the system: Discord attaches them to the
   * message being written. An offscreen page takes no drag from the system, so
   * DevTools carries it, in the page's CSS pixels, which match Monky's.
   * Discord only accepts a drop once its drop zone, drawn after the drag
   * entered, is under the pointer; Chromium turns a drop the page has not
   * accepted yet into another drag entering. So the drag waits for the page to
   * draw that zone and passes over it again before letting go.
   */
  async drop(x: number, y: number, paths: readonly string[]): Promise<void> {
    const contents = this.liveContents();
    if (!contents || !this.visible) return;
    const files = paths.filter(isDroppableFile);
    if (!files.length) return;
    attachDevTools(contents);
    const data = { items: [], files, dragOperationsMask: DRAG_COPY };
    const drag = (type: 'dragEnter' | 'dragOver' | 'drop') =>
      contents.debugger.sendCommand('Input.dispatchDragEvent', { type, x, y, data });
    await drag('dragEnter');
    await drag('dragOver');
    await this.nextFrames(contents);
    if (this.liveContents() !== contents) return;
    await drag('dragOver');
    await drag('drop');
  }

  /** Waits for the page to draw a couple of frames, or a little while if it draws none. */
  private async nextFrames(contents: WebContents): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>(resolve => { timer = setTimeout(resolve, DROP_ZONE_WAIT_MS); });
    try {
      await Promise.race([contents.executeJavaScriptInIsolatedWorld(LAYERS_WORLD, [{ code: NEXT_FRAMES }]), late]);
    } catch {
      // A page between two addresses draws nothing; the wait above is enough.
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Monky's window left the whole screen (Esc, or Monky showing something
   * else): the page leaves it too, by the Escape a person would press.
   * Chromium takes that key itself; Discord never sees it.
   */
  exitFullscreen(): void {
    const contents = this.liveContents();
    if (!contents || !this.fullscreen) return;
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  }

  /** Loads the page again, past the cache; settles once it has loaded, failed or closed. */
  reload(): Promise<void> {
    const contents = this.liveContents();
    if (!contents) return Promise.resolve();
    return new Promise(resolve => {
      const done = (): void => {
        contents.removeListener('did-stop-loading', done);
        contents.removeListener('destroyed', done);
        resolve();
      };
      contents.once('did-stop-loading', done);
      contents.once('destroyed', done);
      contents.reloadIgnoringCache();
    });
  }

  private setFullscreen(window: BrowserWindow, fullscreen: boolean): void {
    if (this.window !== window || fullscreen === this.fullscreen) return;
    this.fullscreen = fullscreen;
    this.events.fullscreen(fullscreen);
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

  /**
   * An offscreen page never gets the focus: Electron's offscreen views ignore
   * it, so Chromium draws no text cursor, although typed keys still arrive.
   * DevTools' focus emulation makes the page focused and active, as Puppeteer
   * does. Only while Monky's keyboard is on it: a focused page tells Discord the
   * person is looking at it, and Discord then keeps its notifications quiet.
   */
  private applyFocus(): void {
    const contents = this.liveContents();
    const focused = this.focusWanted && this.visible;
    if (!contents || focused === this.focusEmulated) return;
    try {
      attachDevTools(contents);
    } catch (error) {
      console.warn('[Discord web] Could not show the text cursor.', error instanceof Error ? error.message : error);
      return;
    }
    this.focusEmulated = focused;
    void contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: focused }).catch(error => {
      if (this.liveContents() === contents) console.warn('[Discord web] Could not show the text cursor.', error instanceof Error ? error.message : error);
    });
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
    this.focusWanted = false;
    this.focusEmulated = false;
    this.fullscreen = false;
    this.frames = null;
    this.chooser = null;
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
