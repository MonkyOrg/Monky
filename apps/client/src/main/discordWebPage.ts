import { app, BrowserWindow, screen, shell, session, type NativeImage, type Rectangle, type Session } from 'electron';
import { DISCORD_WEB_HOME, discordWebShowsServers, discordWebUrl, type DiscordWebCommand, type DiscordWebFrame } from '@monky/shared';
import { webUrl } from './ipc/guards';
import { allowDiscordNavigation } from './webContentsPolicy';

/** Persistent, so the Discord login survives restarts; it never shares storage with Monky's own pages. */
const DISCORD_PARTITION = 'persist:monky-discord';
const DISCORD_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-sanitized-write']);
const FRAME_RATE = 60;
/** Repaints closer together than this reach Monky's window as one patch. */
const FLUSH_INTERVAL_MS = 16;

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
  // Sharing a screen from inside Discord is outside the pilot.
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
 * keyboard back to it. The page itself is never scripted, styled or read: it
 * only receives the input a person gives it through Monky.
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
  private disposed = false;
  private split = false;

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
    const followAddress = (): void => { if (this.window === window) this.setSplit(discordWebShowsServers(contents.getURL())); };
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
    if (this.flushTimer !== null) return;
    const wait = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - this.lastFlush));
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.flushTimer = null;
    const image = this.image, dirty = this.dirty;
    this.image = null;
    this.dirty = null;
    if (!image || !dirty || !this.visible) return;
    this.lastFlush = Date.now();
    const { width, height } = image.getSize();
    const x = Math.max(0, Math.min(width, dirty.x)), y = Math.max(0, Math.min(height, dirty.y));
    const patchWidth = Math.min(width, dirty.x + dirty.width) - x, patchHeight = Math.min(height, dirty.y + dirty.height) - y;
    if (patchWidth <= 0 || patchHeight <= 0) return;
    const pixels = image.crop({ x, y, width: patchWidth, height: patchHeight }).toBitmap();
    if (pixels.length !== patchWidth * patchHeight * 4) return;
    this.events.frame({ width, height, x, y, patchWidth, patchHeight, pixels });
  }

  close(): void {
    const window = this.window;
    if (!window) return;
    this.window = null;
    this.visible = false;
    this.size = null;
    this.sharedZoom = 1;
    this.split = false;
    this.image = null;
    this.dirty = null;
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
