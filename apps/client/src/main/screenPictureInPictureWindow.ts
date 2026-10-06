import { screen } from 'electron';
import type { BrowserWindow, HandlerDetails, Rectangle, WebContents, WindowOpenHandlerResponse } from 'electron';

/**
 * Monky's own Picture-in-Picture window for watched screen broadcasts.
 *
 * Chromium's PiP cannot tell its close button from "back to tab", so the
 * renderer opens a same-origin popup that shows the same MediaStream and owns
 * its buttons. Main only lets that popup exist for a single-use request from
 * the main frame and gives it the floating window chrome.
 */
export const SCREEN_PIP_FRAME_PREFIX = 'monky-screen-pip-';

const REQUEST_TTL_MS = 10_000;
const HOVER_POLL_MS = 100;
const EDGE_MARGIN = 16;
const MIN_SHORT_SIDE = 108;
const MIN_ASPECT = 0.25;
const MAX_ASPECT = 4;
// The renderer's stylesheet reveals its controls through this property: a
// draggable window never reports mouse hover to the page.
const HOVER_CSS = ':root { --monky-pip-hover: 1; }';

const managers = new WeakMap<WebContents, ScreenPictureInPictureWindows>();

export function handleScreenPictureInPictureOpen(
  contents: WebContents, details: Pick<HandlerDetails, 'url' | 'frameName' | 'disposition'>,
): WindowOpenHandlerResponse | null {
  if (!details.frameName.startsWith(SCREEN_PIP_FRAME_PREFIX)) return null;
  return managers.get(contents)?.handleOpen(details) ?? { action: 'deny' };
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const contains = (bounds: Rectangle, point: { x: number; y: number }): boolean =>
  point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height;

export class ScreenPictureInPictureWindows {
  private readonly requests = new Map<string, { aspect: number; expiresAt: number }>();
  private readonly opening = new Map<string, number>();
  private window: BrowserWindow | null = null;
  private lastBounds: Rectangle | null = null;

  constructor(
    private readonly owner: BrowserWindow,
    private readonly now: () => number = Date.now,
    private readonly cursor: () => { x: number; y: number } = () => screen.getCursorScreenPoint(),
  ) {
    managers.set(owner.webContents, this);
    owner.webContents.on('did-create-window', (window, details) => this.adopt(window, details.frameName));
  }

  public authorize(requestId: string, aspect: number): void {
    const now = this.now();
    for (const [id, request] of this.requests) {
      if (request.expiresAt <= now) this.requests.delete(id);
    }
    this.requests.set(requestId, { aspect: clamp(aspect, MIN_ASPECT, MAX_ASPECT), expiresAt: now + REQUEST_TTL_MS });
  }

  public handleOpen(details: Pick<HandlerDetails, 'url' | 'frameName' | 'disposition'>): WindowOpenHandlerResponse {
    const requestId = details.frameName.slice(SCREEN_PIP_FRAME_PREFIX.length);
    const request = this.requests.get(requestId);
    this.requests.delete(requestId);
    if (!request || request.expiresAt <= this.now() || details.url !== 'about:blank'
      || details.disposition !== 'new-window' || this.owner.isDestroyed()) {
      return { action: 'deny' };
    }
    this.opening.set(details.frameName, request.aspect);
    const bounds = this.initialBounds(request.aspect);
    const portrait = request.aspect < 1;
    return {
      action: 'allow',
      outlivesOpener: false,
      overrideBrowserWindowOptions: {
        ...bounds,
        minWidth: portrait ? MIN_SHORT_SIDE : Math.round(MIN_SHORT_SIDE * request.aspect),
        minHeight: portrait ? Math.round(MIN_SHORT_SIDE / request.aspect) : MIN_SHORT_SIDE,
        show: false,
        frame: false,
        backgroundColor: '#000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        title: 'Monky',
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webviewTag: false,
          backgroundThrottling: false,
          spellcheck: false,
        },
      },
    };
  }

  private adopt(window: BrowserWindow, frameName: string): void {
    const aspect = this.opening.get(frameName);
    if (aspect === undefined) return;
    this.opening.delete(frameName);
    const previous = this.window;
    if (previous && !previous.isDestroyed()) previous.close();
    this.window = window;
    window.removeMenu();
    // On Windows the ratio trims a frameless window by a couple of pixels; reopening
    // from the remembered bounds would then shrink the PiP a little every time.
    const bounds = window.getBounds();
    window.setAspectRatio(aspect);
    window.setBounds(bounds);
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => event.preventDefault());
    const remember = (): void => {
      if (!window.isDestroyed() && !window.isMinimized()) this.lastBounds = window.getBounds();
    };
    window.on('moved', remember);
    window.on('resized', remember);
    window.on('close', remember);
    let hovering = false;
    let css: Promise<string | null> = Promise.resolve(null);
    const reveal = (visible: boolean): void => {
      css = css.then(async key => {
        if (contents.isDestroyed()) return null;
        if (key) await contents.removeInsertedCSS(key).catch(() => undefined);
        return visible ? contents.insertCSS(HOVER_CSS).catch(() => null) : null;
      });
    };
    const poll = setInterval(() => {
      if (window.isDestroyed()) return;
      const inside = window.isVisible() && contains(window.getBounds(), this.cursor());
      if (inside === hovering) return;
      hovering = inside;
      reveal(inside);
    }, HOVER_POLL_MS);
    window.once('closed', () => {
      clearInterval(poll);
      if (this.window === window) this.window = null;
    });
    // Like Chromium's PiP, appearing never takes focus from the game or app in use.
    window.showInactive();
  }

  private initialBounds(aspect: number): Rectangle {
    if (this.lastBounds) {
      const area = screen.getDisplayMatching(this.lastBounds).workArea;
      return this.fit({ ...this.lastBounds, height: Math.round(this.lastBounds.width / aspect) }, area, aspect);
    }
    const area = screen.getDisplayMatching(this.owner.getNormalBounds()).workArea;
    let width = clamp(Math.round(area.width / 5), 320, 640);
    let height = Math.round(width / aspect);
    const maxHeight = Math.round(area.height / 2.5);
    if (height > maxHeight) {
      height = maxHeight;
      width = Math.round(height * aspect);
    }
    return this.fit({
      x: area.x + area.width - width - EDGE_MARGIN,
      y: area.y + area.height - height - EDGE_MARGIN,
      width, height,
    }, area, aspect);
  }

  private fit(bounds: Rectangle, area: Rectangle, aspect: number): Rectangle {
    let { width, height } = bounds;
    const maxWidth = Math.max(1, area.width - EDGE_MARGIN * 2);
    const maxHeight = Math.max(1, area.height - EDGE_MARGIN * 2);
    if (width > maxWidth) {
      width = maxWidth;
      height = Math.round(width / aspect);
    }
    if (height > maxHeight) {
      height = maxHeight;
      width = Math.round(height * aspect);
    }
    return {
      x: clamp(bounds.x, area.x, area.x + area.width - width),
      y: clamp(bounds.y, area.y, area.y + area.height - height),
      width, height,
    };
  }
}
