import { WebContentsView, View, session, type BrowserWindow, type WebContents, type Session, type WebPreferences } from 'electron';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  BOT_SCREEN_LIMITS, MINIAPP_BROWSER_CHROME_HEIGHT, MINIAPP_BROWSER_FOCUS_ADDRESS, MINIAPP_BROWSER_STATE,
  miniappBrowserAddress, miniappBrowserUrl,
  type MiniappBrowserAppearance, type MiniappBrowserBounds, type MiniappBrowserControl, type MiniappBrowserFailure, type MiniappBrowserOpen, type MiniappBrowserState,
} from '@monky/shared';
import { sendEvent } from './ipc/registry';
import { allowPersonalBrowserNavigation } from './webContentsPolicy';
import { isolatedWebPreferences } from './windowPreferences';
import { MiniappBrowserSite } from './miniappBrowserSite';
import { renderMiniappBrowserHome } from './miniappBrowserHome';

interface BrowserEntry {
  input: MiniappBrowserOpen;
  container: View;
  toolbar: WebContentsView;
  toolbarContents: WebContents;
  view: WebContentsView;
  site: MiniappBrowserSite;
  session: Session;
  closed: boolean;
  visible: boolean;
  ready: boolean;
  volume: number;
  failure: MiniappBrowserFailure | null;
  failureId: number;
  navigationId: number;
  bounds: MiniappBrowserBounds | null;
  clip: MiniappBrowserBounds | null;
  placementVisible: boolean;
  appearance: MiniappBrowserAppearance | null;
  broadcasting: boolean;
  captureGranted: boolean;
  captureDeadline: number;
  disposeGuards?: () => void;
}

/** The toolbar is trusted; the sites below it have no preload, bridge, or shared session. */
export class MiniappBrowserWindows {
  private entries = new Map<string, BrowserEntry>();
  private cleanups = new Set<Promise<void>>();
  private disposed = false;
  private ownerContents: WebContents;

  private relayout = (): void => { for (const entry of this.entries.values()) this.layout(entry); };
  constructor(private owner: BrowserWindow, private onClosed: (requestId: string) => void) {
    this.ownerContents = owner.webContents;
    owner.on('resize', this.relayout);
    owner.on('show', this.relayout);
    owner.on('hide', this.relayout);
    owner.on('minimize', this.relayout);
    owner.on('restore', this.relayout);
    owner.webContents.on('zoom-changed', this.relayout);
  }

  controls(): WebContents[] {
    return [...this.entries.values()].filter(entry => !entry.closed).map(entry => entry.toolbar.webContents);
  }

  private privilegedOrigins(): string[] {
    const url = this.owner.webContents.getURL();
    return /^https?:/.test(url) ? [new URL(url).origin] : [];
  }

  async open(input: MiniappBrowserOpen): Promise<void> {
    if (this.disposed || this.owner.isDestroyed()) throw new Error('The miniapp owner is closed.');
    if (this.entries.has(input.requestId) || this.entries.size >= BOT_SCREEN_LIMITS.activePerChannel) {
      throw new Error('Close another active miniapp browser first.');
    }
    const browserSession = session.fromPartition(`monky-browser-${randomUUID()}`, { cache: false });
    const toolbarSession = session.fromPartition(`monky-browser-toolbar-${randomUUID()}`, { cache: false });
    const toolbarView = new WebContentsView({
      webPreferences: isolatedWebPreferences('miniappBrowserPreload', {
        session: toolbarSession, webviewTag: false, spellcheck: false,
      }),
    });
    const toolbarContents = toolbarView.webContents;
    let site: MiniappBrowserSite | undefined;
    try {
      const sitePreferences: WebPreferences = {
        session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, webviewTag: false, navigateOnDragDrop: false,
      };
      const [width, height] = this.owner.getContentSize();
      site = new MiniappBrowserSite(sitePreferences, Math.max(1, width), Math.max(1, height - MINIAPP_BROWSER_CHROME_HEIGHT));
      const view = site.view;
      const container = new View();
      container.setVisible(false);
      const entry: BrowserEntry = {
        input, container, toolbar: toolbarView, toolbarContents, view, site, session: browserSession, closed: false, visible: false, ready: false,
        volume: 1, failure: null, failureId: 0, navigationId: 0,
        bounds: null, clip: null, placementVisible: false, appearance: null,
        broadcasting: false, captureGranted: false, captureDeadline: 0,
      };
      this.entries.set(input.requestId, entry);
      container.addChildView(toolbarView);
      this.owner.contentView.addChildView(container);
      const toolbar = toolbarContents;
      toolbar.once('destroyed', () => this.close(input.requestId, toolbar));
      toolbar.on('render-process-gone', () => this.close(input.requestId));
      toolbar.setWindowOpenHandler(() => ({ action: 'deny' }));
      toolbar.on('will-navigate', event => event.preventDefault());
      toolbar.on('will-frame-navigate', event => event.preventDefault());
      const contents = view.webContents;
      contents.once('destroyed', () => this.close(input.requestId, contents));
      contents.setAudioMuted(true);
      allowPersonalBrowserNavigation(contents, sitePreferences);
      const deny = (failure: MiniappBrowserFailure): void => this.fail(entry, failure);
      const permitted = (url: string): boolean => miniappBrowserUrl(url, this.privilegedOrigins()) !== null;
      const guardNavigation = (event: { url: string; preventDefault(): void }): void => {
        if (!permitted(event.url)) { event.preventDefault(); deny('invalid-url'); }
      };
      contents.on('will-navigate', guardNavigation);
      contents.on('will-frame-navigate', guardNavigation);
      contents.on('will-redirect', guardNavigation);
      contents.setWindowOpenHandler(() => {
        deny('popup-denied');
        return { action: 'deny' };
      });
      contents.on('before-input-event', (event, key) => {
        if (!entry.closed && key.type === 'keyDown' && (key.control || key.meta) && key.key.toLowerCase() === 'l') {
          event.preventDefault();
          toolbar.focus();
          sendEvent(toolbar, MINIAPP_BROWSER_FOCUS_ADDRESS);
        } else if (!entry.closed && key.type === 'keyDown' && key.key === 'Escape' && this.owner.isFullScreen()) {
          event.preventDefault();
          this.owner.webContents.focus();
          this.owner.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        }
      });
      const denyDownload = (event: { preventDefault(): void }): void => {
        event.preventDefault();
        deny('download-denied');
      };
      entry.disposeGuards = () => {
        browserSession.removeListener('will-download', denyDownload);
        browserSession.webRequest.onBeforeRequest(null);
        browserSession.setPermissionCheckHandler(null);
        browserSession.setPermissionRequestHandler(null);
        browserSession.setDevicePermissionHandler(null);
        browserSession.setDisplayMediaRequestHandler(null);
      };
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.setPermissionRequestHandler((requester, permission, callback, details) => {
        // Electron asks the captured tab's session, not the capturer's. Admit only
        // the one-use owner-scoped tab token, never a website's camera/mic request.
        if (!entry.closed && requester === contents && permission === 'media' && details.isMainFrame
          && 'mediaTypes' in details && details.mediaTypes?.length === 0 && entry.captureDeadline > Date.now()
          && details.requestingUrl === contents.getURL() && 'securityOrigin' in details
          && this.captureOriginMatches(details.securityOrigin)) {
          entry.captureDeadline = 0;
          callback(true);
          return;
        }
        callback(false);
        deny('permission-denied');
      });
      browserSession.setDevicePermissionHandler(() => false);
      browserSession.setDisplayMediaRequestHandler((_request, callback) => {
        callback({});
        deny('permission-denied');
      });
      browserSession.on('will-download', denyDownload);
      // Dedicated session: this guard never overwrites the application's global request guard.
      browserSession.webRequest.onBeforeRequest((details, callback) => {
        const navigation = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
        const resourceUrl = details.url.replace(/^ws(s?):/i, 'http$1:');
        const cancel = entry.closed || (navigation ? !permitted(details.url)
          : !/^(?:blob:|data:)/i.test(details.url) && !permitted(resourceUrl));
        callback({ cancel });
        if (cancel && !entry.closed) deny('invalid-url');
      });
      const publish = (): void => this.publish(entry);
      contents.on('did-navigate', publish);
      contents.on('did-navigate-in-page', publish);
      contents.on('did-start-loading', publish);
      contents.on('did-stop-loading', publish);
      contents.on('did-finish-load', () => { if (entry.ready) this.refreshHome(entry); });
      contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
        if (mainFrame && code !== -3 && !entry.closed) deny('navigation-failed');
      });
      contents.on('render-process-gone', () => {
        if (!entry.closed) { deny('navigation-failed'); this.close(input.requestId); }
      });
      const dev = process.env.VITE_DEV_SERVER_URL;
      if (dev) await toolbar.loadURL(new URL('miniappBrowser.html', dev).href);
      else await toolbar.loadFile(path.join(__dirname, '../../dist/miniappBrowser.html'));
      await contents.loadURL('about:blank');
      if (!entry.closed) await renderMiniappBrowserHome(contents, entry.input.locale, entry.appearance);
      if (!entry.closed && !this.disposed) {
        // Activate hidden-but-painting after the first renderer exists. Setting the
        // preference before creation can leave a never-shown view without a surface.
        contents.setBackgroundThrottling(false);
        entry.ready = true;
        this.publish(entry);
        this.layout(entry);
      }
    } catch (error: unknown) {
      if (this.entries.has(input.requestId)) this.close(input.requestId);
      else {
        site?.close();
        if (!toolbarContents.isDestroyed()) toolbarContents.close({ waitForBeforeUnload: false });
        await Promise.all([browserSession.clearStorageData(), toolbarSession.clearStorageData()]);
      }
      throw error;
    }
  }

  private captureOriginMatches(origin: string | undefined): boolean {
    if (!origin || this.ownerContents.isDestroyed()) return false;
    try {
      const owner = new URL(this.ownerContents.getURL()), capturer = new URL(origin);
      return owner.protocol === capturer.protocol && (owner.protocol === 'file:' || owner.origin === capturer.origin);
    } catch {
      return false;
    }
  }

  private state(entry: BrowserEntry): MiniappBrowserState {
    const contents = entry.view.webContents;
    return {
      url: contents.getURL() === 'about:blank' ? '' : contents.getURL(),
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(), locale: entry.input.locale, failure: entry.failure, failureId: entry.failureId,
      appearance: entry.appearance,
      broadcasting: entry.broadcasting,
    };
  }

  private publish(entry: BrowserEntry): void {
    if (!entry.closed && !entry.toolbar.webContents.isDestroyed()) sendEvent(entry.toolbar.webContents, MINIAPP_BROWSER_STATE, this.state(entry));
  }

  private fail(entry: BrowserEntry, failure: MiniappBrowserFailure): void {
    entry.failure = failure;
    entry.failureId++;
    this.publish(entry);
  }

  async control(sender: WebContents, command: MiniappBrowserControl): Promise<MiniappBrowserState | null> {
    const entry = [...this.entries.values()].find(entry => !entry.closed && entry.toolbar.webContents === sender);
    if (!entry) throw new Error('This toolbar no longer owns a browser.');
    const contents = entry.view.webContents;
    if (command.action === 'close') { this.close(entry.input.requestId); return null; }
    if (command.action !== 'state' && !entry.broadcasting) {
      this.fail(entry, 'broadcast-unavailable');
      return this.state(entry);
    }
    if (command.action !== 'state') { entry.failure = null; entry.navigationId++; }
    const navigationId = entry.navigationId;
    if (command.action === 'navigate') {
      const url = miniappBrowserAddress(command.url, this.privilegedOrigins());
      if (!url) this.fail(entry, 'invalid-url');
      else {
        try { await contents.loadURL(url); }
        catch (error: unknown) {
          if (!entry.closed && entry.navigationId === navigationId) {
            console.warn('[Miniapp browser] Navigation failed.', error instanceof Error ? error.name : 'Error');
            if (entry.failure !== 'navigation-failed') this.fail(entry, 'navigation-failed');
          }
        }
      }
    } else if (command.action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (command.action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (command.action === 'reload') contents.reload();
    else if (command.action === 'stop') contents.stop();
    if (entry.closed) return null;
    this.publish(entry);
    return this.state(entry);
  }

  visibility(requestId: string, visible: boolean): void {
    const entry = this.entries.get(requestId);
    if (!entry || entry.closed) return;
    entry.visible = visible;
    this.layout(entry);
  }

  captureSourceId(requestId: string): string {
    const entry = this.entries.get(requestId);
    if (!entry || entry.closed || !entry.ready || entry.captureGranted || this.ownerContents.isDestroyed())
      throw new Error('The browser capture has already been acquired or retired.');
    const sourceId = entry.view.webContents.getMediaSourceId(this.ownerContents);
    entry.captureGranted = true;
    entry.captureDeadline = Date.now() + 10000;
    return sourceId;
  }

  broadcasting(requestId: string, active: boolean): void {
    const entry = this.entries.get(requestId);
    if (!entry || entry.closed) return;
    if (active && !entry.captureGranted) throw new Error('The browser has no acquired tab capture.');
    entry.broadcasting = active;
    this.publish(entry);
  }

  placement(requestId: string, bounds: MiniappBrowserBounds, clip: MiniappBrowserBounds, visible: boolean): void {
    const entry = this.entries.get(requestId);
    if (!entry || entry.closed) return;
    entry.bounds = bounds;
    entry.clip = clip;
    entry.placementVisible = visible;
    this.layout(entry);
  }

  private layout(entry: BrowserEntry): void {
    if (entry.closed || this.owner.isDestroyed()) return;
    const bounds = entry.bounds, clip = entry.clip;
    const [ownerWidth, ownerHeight] = this.owner.getContentSize();
    const zoom = this.owner.webContents.getZoomFactor();
    let shown = false;
    let containerBounds = entry.container.getBounds(), toolbarBounds = entry.toolbar.getBounds();
    let siteBounds = entry.view.getBounds();
    if (bounds && clip) {
      const x = Math.max(0, Math.ceil(clip.x * zoom)), y = Math.max(0, Math.ceil(clip.y * zoom));
      const right = Math.min(ownerWidth, Math.floor((clip.x + clip.width) * zoom));
      const bottom = Math.min(ownerHeight, Math.floor((clip.y + clip.height) * zoom));
      const width = Math.max(0, right - x), height = Math.max(0, bottom - y);
      const offsetX = Math.round(bounds.x * zoom) - x, offsetY = Math.round(bounds.y * zoom) - y;
      const fullWidth = Math.round(bounds.width * zoom), fullHeight = Math.round(bounds.height * zoom);
      const chrome = Math.min(fullHeight, Math.round(MINIAPP_BROWSER_CHROME_HEIGHT * zoom));
      containerBounds = { x, y, width, height };
      toolbarBounds = { x: offsetX, y: offsetY, width: fullWidth, height: chrome };
      const previous = entry.view.getBounds();
      siteBounds = { x: offsetX, y: offsetY + chrome, width: fullWidth > 0 ? fullWidth : previous.width,
        height: fullHeight > chrome ? fullHeight - chrome : previous.height };
      shown = entry.ready && entry.visible && entry.placementVisible && width > 0 && height > 0
        && this.owner.isVisible() && !this.owner.isMinimized();
    }
    if (!shown && (entry.toolbar.webContents.isFocused() || entry.view.webContents.isFocused())) this.owner.webContents.focus();
    // Park before hiding/resizing an ancestor, not after its compositor has stopped.
    if (!shown) entry.site.present(entry.container, siteBounds, false);
    if (entry.closed) return;
    entry.container.setBounds(containerBounds);
    entry.toolbar.setBounds(toolbarBounds);
    entry.toolbar.webContents.setZoomFactor(zoom);
    if (shown) entry.site.present(entry.container, siteBounds, true);
    if (entry.closed) return;
    entry.container.setVisible(shown);
    entry.view.webContents.setAudioMuted(!shown || entry.volume === 0);
  }

  locale(requestId: string, locale: MiniappBrowserOpen['locale']): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    entry.input = { ...entry.input, locale };
    this.refreshHome(entry);
    this.publish(entry);
  }

  appearance(requestId: string, appearance: MiniappBrowserAppearance): void {
    const entry = this.entries.get(requestId);
    if (!entry || entry.closed) return;
    entry.appearance = appearance;
    this.refreshHome(entry);
    this.publish(entry);
  }

  private refreshHome(entry: BrowserEntry): void {
    if (entry.closed || !entry.ready || entry.site.contents.getURL() !== 'about:blank') return;
    const navigationId = entry.navigationId;
    void renderMiniappBrowserHome(entry.site.contents, entry.input.locale, entry.appearance).catch(error => {
      if (!entry.closed && entry.navigationId === navigationId && entry.site.contents.getURL() === 'about:blank') {
        console.warn('[Miniapp browser] Home update failed.', error instanceof Error ? error.name : 'Error');
        this.fail(entry, 'navigation-failed');
      }
    });
  }

  volume(requestId: string, volume: number): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    entry.volume = volume;
    this.layout(entry);
  }

  close(requestId: string, destroyedContents?: WebContents): void {
    const entry = this.entries.get(requestId);
    if (!entry || entry.closed) return;
    entry.container.setVisible(false);
    this.release(entry, entry.toolbarContents.session, destroyedContents);
  }

  private release(entry: BrowserEntry, toolbarSession: Session, destroyedContents?: WebContents): void {
    if (entry.closed) return;
    entry.closed = true;
    this.entries.delete(entry.input.requestId);
    const contents = entry.site.contents;
    const destroyed = contents === destroyedContents || contents.isDestroyed() ? Promise.resolve()
      : new Promise<void>(resolve => contents.once('destroyed', () => resolve()));
    entry.site.close();
    if (!this.owner.isDestroyed()) this.owner.contentView.removeChildView(entry.container);
    const toolbar = entry.toolbarContents;
    const toolbarDestroyed = toolbar === destroyedContents || toolbar.isDestroyed() ? Promise.resolve()
      : new Promise<void>(resolve => toolbar.once('destroyed', () => resolve()));
    if (!toolbar.isDestroyed()) toolbar.close({ waitForBeforeUnload: false });
    this.onClosed(entry.input.requestId);
    const cleanup = Promise.all([destroyed, toolbarDestroyed]).then(async () => {
      await Promise.all([entry.session.closeAllConnections(), toolbarSession.closeAllConnections()]);
      entry.disposeGuards?.();
      await Promise.all([
        entry.session.clearStorageData(), entry.session.clearCache(), entry.session.clearAuthCache(),
        toolbarSession.clearStorageData(), toolbarSession.clearCache(), toolbarSession.clearAuthCache(),
      ]);
    });
    this.cleanups.add(cleanup);
    void cleanup.catch(error => console.error('[Miniapp browser] Session cleanup failed.', error))
      .finally(() => this.cleanups.delete(cleanup));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.owner.removeListener('resize', this.relayout);
    this.owner.removeListener('show', this.relayout);
    this.owner.removeListener('hide', this.relayout);
    this.owner.removeListener('minimize', this.relayout);
    this.owner.removeListener('restore', this.relayout);
    this.ownerContents.removeListener('zoom-changed', this.relayout);
    await this.closeAll();
  }

  async closeAll(): Promise<void> {
    for (const id of this.entries.keys()) this.close(id);
    await Promise.all([...this.cleanups]);
  }
}
