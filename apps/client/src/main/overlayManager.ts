import { BrowserWindow, screen } from 'electron';
import { setWindowResizeAspect } from '@monky/screen-audio';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  OVERLAY_DEFAULT_WIDTH,
  OVERLAY_DEFAULT_HEIGHT,
  getOverlayCardSize,
} from '@monky/shared';
import type {
  OverlayBounds,
  OverlayCardLayout,
  OverlayConfig,
  OverlayPosition,
  OverlaySignalPayload,
  OverlaySyncState,
} from '@monky/shared';

const DEFAULT_OVERLAY_WIDTH = OVERLAY_DEFAULT_WIDTH;
const DEFAULT_OVERLAY_HEIGHT = OVERLAY_DEFAULT_HEIGHT;
const PADDING = 24;

export class OverlayManager {
  private overlayWindow: BrowserWindow | null = null;
  private readonly captureExcludedWindows = new Set<BrowserWindow>();
  private mainWindow: BrowserWindow;
  private currentConfig: OverlayConfig | null = null;
  private boundsDebounceTimeout: NodeJS.Timeout | null = null;
  private hoverPollTimer: NodeJS.Timeout | null = null;
  private isHovered = false;
  private isResizing = false;
  private resizeAspect: OverlayCardLayout['resizeAspect'];

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  public setMainWindow(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow;
  }

  public isOpen(): boolean {
    return !!this.overlayWindow && !this.overlayWindow.isDestroyed();
  }

  public isScreenShareSource(sourceId: string): boolean {
    const selectedId = /^window:([1-9][0-9]*):/.exec(sourceId)?.[1];
    if (!selectedId) return false;
    return [...this.captureExcludedWindows].some(window => !window.isDestroyed()
      && window.getMediaSourceId().split(':')[1] === selectedId);
  }

  public getConfig(): OverlayConfig | null {
    return this.currentConfig;
  }

  public open(config: OverlayConfig): boolean {
    this.currentConfig = { ...config };
    this.currentConfig[config.minimalistMode ? 'minimalistCardSize' : 'cardSize'] = getOverlayCardSize(config);

    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      if (config.position !== 'custom') {
        const { x, y } = this.calculatePosition(config.position, this.overlayWindow.getBounds());
        this.overlayWindow.setPosition(x, y);
      }
      this.overlayWindow.showInactive();
      this.updateResizeAspect();
      this.notifyConfigUpdated(this.currentConfig);
      this.notifyStateChanged(true);
      return true;
    }

    const initialBounds = this.getInitialBounds(config);
    this.resizeAspect = undefined;
    this.isResizing = false;

    this.overlayWindow = new BrowserWindow({
      x: initialBounds.x,
      y: initialBounds.y,
      width: initialBounds.width,
      height: initialBounds.height,
      minWidth: 160,
      minHeight: config.minimalistMode ? 94 : 120,
      frame: false,
      transparent: true,
      hasShadow: false,
      alwaysOnTop: true,
      resizable: true,
      skipTaskbar: true,
      backgroundColor: '#00000000',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        webSecurity: true,
      },
    });

    const openedWindow = this.overlayWindow;
    this.captureExcludedWindows.add(openedWindow);
    this.overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    this.overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    if (process.env.VITE_DEV_SERVER_URL) {
      const devUrl = new URL(process.env.VITE_DEV_SERVER_URL);
      devUrl.searchParams.set('overlay', '1');
      this.overlayWindow.loadURL(devUrl.toString());
    } else {
      const distHtmlPath = path.join(__dirname, '../../dist/index.html');
      const fileUrl = pathToFileURL(distHtmlPath);
      fileUrl.searchParams.set('overlay', '1');
      this.overlayWindow.loadURL(fileUrl.toString());
    }

    this.overlayWindow.once('ready-to-show', () => {
      if (this.overlayWindow === openedWindow && !openedWindow.isDestroyed()) {
        this.overlayWindow.showInactive();
        this.notifyStateChanged(true);
        if (this.currentConfig) {
          this.notifyConfigUpdated(this.currentConfig);
        }
      }
    });

    // These events exclude setPosition/setBounds, so choosing a preset stays a preset.
    const rememberUserBounds = (_event: Electron.Event, bounds: OverlayBounds) => {
      if (this.overlayWindow !== openedWindow || !this.currentConfig) return;
      this.currentConfig.position = 'custom';
      this.currentConfig.bounds = { ...bounds };
    };
    this.overlayWindow.on('will-move', rememberUserBounds);
    this.overlayWindow.on('will-resize', (event, bounds) => {
      if (this.overlayWindow !== openedWindow) return;
      this.setResizing(true);
      rememberUserBounds(event, bounds);
      if (this.currentConfig) this.currentConfig[this.currentConfig.minimalistMode ? 'minimalistCardSize' : 'cardSize'] = undefined;
    });

    const handleBoundsChange = () => {
      if (this.overlayWindow !== openedWindow || openedWindow.isDestroyed()) return;
      if (this.currentConfig) this.currentConfig.bounds = this.overlayWindow.getBounds();
      if (this.boundsDebounceTimeout) clearTimeout(this.boundsDebounceTimeout);
      this.boundsDebounceTimeout = setTimeout(() => {
        this.boundsDebounceTimeout = null;
        if (this.overlayWindow !== openedWindow || openedWindow.isDestroyed()) return;
        if (this.currentConfig) this.notifyConfigUpdated(this.currentConfig);
      }, 250);
    };

    this.overlayWindow.on('moved', handleBoundsChange);
    this.overlayWindow.on('resized', () => {
      if (this.overlayWindow !== openedWindow) return;
      this.setResizing(false);
      handleBoundsChange();
    });
    this.overlayWindow.on('close', () => {
      if (!this.currentConfig || this.overlayWindow !== openedWindow || openedWindow.isDestroyed()) return;
      this.currentConfig.bounds = this.overlayWindow.getBounds();
      this.notifyConfigUpdated(this.currentConfig);
    });

    // The top bar is a `-webkit-app-region: drag` region, and drag regions
    // swallow DOM mouse events, so CSS `:hover` never fires while the pointer is
    // over the bar. We track the cursor from the main process instead and push a
    // hover flag to the overlay, so the whole overlay (bar included) lights up
    // (#543).
    this.startHoverTracking();

    this.overlayWindow.on('closed', () => {
      this.captureExcludedWindows.delete(openedWindow);
      if (this.overlayWindow !== openedWindow) return;
      this.overlayWindow = null;
      this.stopHoverTracking();
      if (this.boundsDebounceTimeout) {
        clearTimeout(this.boundsDebounceTimeout);
        this.boundsDebounceTimeout = null;
      }
      this.notifyStateChanged(false);
    });

    return true;
  }

  public close(): boolean {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.stopHoverTracking();
      this.overlayWindow.close();
      this.overlayWindow = null;
      if (this.boundsDebounceTimeout) {
        clearTimeout(this.boundsDebounceTimeout);
        this.boundsDebounceTimeout = null;
      }
      this.notifyStateChanged(false);
      return true;
    }
    return false;
  }

  /**
   * Polls the cursor position and tells the overlay when it enters or leaves the
   * window. This is the only reliable way to drive a hover state that also covers
   * the draggable top bar, since `-webkit-app-region: drag` regions never emit
   * DOM mouse events to the renderer (#543).
   */
  private startHoverTracking(): void {
    this.stopHoverTracking();
    this.hoverPollTimer = setInterval(() => {
      if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
        this.stopHoverTracking();
        return;
      }
      const point = screen.getCursorScreenPoint();
      const b = this.overlayWindow.getBounds();
      const inside =
        point.x >= b.x &&
        point.x < b.x + b.width &&
        point.y >= b.y &&
        point.y < b.y + b.height;
      if (inside || inside !== this.isHovered) {
        this.isHovered = inside;
        this.overlayWindow.webContents.send('overlay:hover-changed', inside, { x: point.x - b.x, y: point.y - b.y });
      }
    }, 120);
  }

  private stopHoverTracking(): void {
    if (this.hoverPollTimer) {
      clearInterval(this.hoverPollTimer);
      this.hoverPollTimer = null;
    }
    this.isHovered = false;
  }

  private setResizing(resizing: boolean): void {
    if (this.isResizing === resizing) return;
    this.isResizing = resizing;
    this.overlayWindow?.webContents.send('overlay:resize-state-changed', resizing);
  }

  public setConfig(configPartial: Partial<OverlayConfig>): void {
    if (!this.currentConfig) {
      this.currentConfig = {
        mode: 'cameras-only',
        layout: 'grid',
        position: 'bottom-right',
        cardOpacity: 0.85,
        focusActiveSpeaker: false,
        ...configPartial,
      };
    } else {
      this.currentConfig = { ...this.currentConfig, ...configPartial };
    }

    this.currentConfig[this.currentConfig.minimalistMode ? 'minimalistCardSize' : 'cardSize'] = getOverlayCardSize(this.currentConfig);
    if (configPartial.position && configPartial.position !== 'custom' && this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      const { x, y } = this.calculatePosition(configPartial.position, this.overlayWindow.getBounds());
      this.overlayWindow.setPosition(x, y);
    }

    this.notifyConfigUpdated(this.currentConfig);
    this.updateResizeAspect();
  }

  private updateResizeAspect(): void {
    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) return;
    this.overlayWindow.setMinimumSize(160, this.currentConfig?.minimalistMode ? 94 : 120);
    const aspect = this.currentConfig?.preserveAspectRatio !== false
      ? this.resizeAspect : undefined;
    if (process.platform === 'win32') {
      setWindowResizeAspect(this.overlayWindow.getNativeWindowHandle(), aspect?.ratio ?? 0,
        aspect?.extraSize.width ?? 0, aspect?.extraSize.height ?? 0);
    } else {
      this.overlayWindow.setAspectRatio(aspect?.ratio ?? 0, aspect?.extraSize);
    }
  }

  public resetBounds(): void {
    if (!this.currentConfig) return;
    this.currentConfig[this.currentConfig.minimalistMode ? 'minimalistCardSize' : 'cardSize'] = undefined;
    const window = this.overlayWindow && !this.overlayWindow.isDestroyed() ? this.overlayWindow : null;
    const bounds = window?.getBounds() ?? this.currentConfig.bounds;
    if (bounds) {
      const resized = { ...bounds, width: DEFAULT_OVERLAY_WIDTH, height: DEFAULT_OVERLAY_HEIGHT };
      this.currentConfig.bounds = resized;
      window?.setBounds(resized);
    }

    this.notifyConfigUpdated(this.currentConfig);
  }

  public layoutCards(senderId: number, layout: OverlayCardLayout): OverlayBounds {
    const window = this.overlayWindow;
    if (!window || window.isDestroyed() || window.webContents.id !== senderId || !this.currentConfig) {
      throw new Error('Only the current overlay may size its cards.');
    }
    if (!layout || !layout.cardSize
      || (layout.minimalistMode !== undefined && typeof layout.minimalistMode !== 'boolean')
      || (layout.preserveAspectRatio !== undefined && typeof layout.preserveAspectRatio !== 'boolean')
      || ![layout.cardSize.width, layout.cardSize.height].every(value => Number.isFinite(value) && value >= 1 && value <= 16384)
      || ![layout.width, layout.height].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 1000000)) {
      throw new Error('Invalid overlay card layout.');
    }
    if (layout.resizeAspect !== undefined && (!layout.resizeAspect
      || !Number.isFinite(layout.resizeAspect.ratio) || layout.resizeAspect.ratio < 1 / 16384 || layout.resizeAspect.ratio > 16384
      || !layout.resizeAspect.extraSize || ![layout.resizeAspect.extraSize.width, layout.resizeAspect.extraSize.height]
        .every(value => Number.isSafeInteger(value) && value >= 0 && value <= 65536))) {
      throw new Error('Invalid overlay resize aspect.');
    }
    const bounds = window.getBounds();
    // A queued pre-gesture layout must never fight the native drag. The renderer
    // measures and submits its final layout again after resize-state-changed.
    if (this.isResizing
      || (layout.minimalistMode !== undefined && layout.minimalistMode !== !!this.currentConfig.minimalistMode)
      || (layout.preserveAspectRatio !== undefined && layout.preserveAspectRatio !== (this.currentConfig.preserveAspectRatio !== false))) {
      return bounds;
    }
    const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea;
    const width = Math.max(160, Math.min(layout.width, Math.floor(Math.min(area.width, area.x + area.width - bounds.x))));
    const height = Math.max(this.currentConfig.minimalistMode ? 94 : 120,
      Math.min(layout.height, Math.floor(Math.min(area.height, area.y + area.height - bounds.y))));
    this.currentConfig[this.currentConfig.minimalistMode ? 'minimalistCardSize' : 'cardSize'] = { ...layout.cardSize };
    this.resizeAspect = layout.resizeAspect;
    this.updateResizeAspect();
    if (width !== bounds.width || height !== bounds.height) {
      this.currentConfig.position = 'custom';
      window.setBounds({ ...bounds, width, height });
    }
    this.currentConfig.bounds = window.getBounds();
    this.notifyConfigUpdated(this.currentConfig);
    return { ...this.currentConfig.bounds };
  }

  public sendSignal(payload: OverlaySignalPayload): void {
    if (payload.target === 'overlay') {
      if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.webContents.send('overlay:signal-received', payload.signal);
      }
    } else if (payload.target === 'main') {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('overlay:signal-received', payload.signal);
      }
    }
  }

  public sendSyncState(state: OverlaySyncState): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      if (state.participants.length === 0) {
        this.resizeAspect = undefined;
        this.updateResizeAspect();
      }
      this.overlayWindow.webContents.send('overlay:sync-state-received', state);
    }
  }

  private notifyStateChanged(isOpen: boolean): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('overlay:state-changed', isOpen);
    }
  }

  private notifyConfigUpdated(config: OverlayConfig): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('overlay:config-updated', config);
    }
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.webContents.send('overlay:config-updated', config);
    }
  }

  private getInitialBounds(config: OverlayConfig): OverlayBounds {
    const width = config.bounds?.width || DEFAULT_OVERLAY_WIDTH;
    const height = config.bounds?.height || DEFAULT_OVERLAY_HEIGHT;

    if (config.position === 'custom' && config.bounds) {
      const display = screen.getDisplayNearestPoint({ x: config.bounds.x, y: config.bounds.y });
      const workArea = display.workArea;
      const x = Math.max(workArea.x, Math.min(config.bounds.x, workArea.x + workArea.width - width));
      const y = Math.max(workArea.y, Math.min(config.bounds.y, workArea.y + workArea.height - height));
      return { x, y, width, height };
    }

    const pos = config.position === 'custom' ? 'bottom-right' : config.position;
    const { x, y } = this.calculatePosition(pos, { width, height });
    return { x, y, width, height };
  }

  private calculatePosition(
    position: OverlayPosition,
    size: { width: number; height: number }
  ): { x: number; y: number } {
    let targetDisplay = screen.getPrimaryDisplay();
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const mainBounds = this.mainWindow.getBounds();
      targetDisplay = screen.getDisplayNearestPoint({
        x: mainBounds.x + mainBounds.width / 2,
        y: mainBounds.y + mainBounds.height / 2,
      });
    }

    const { x: areaX, y: areaY, width: areaW, height: areaH } = targetDisplay.workArea;

    switch (position) {
      case 'top-left':
        return { x: areaX + PADDING, y: areaY + PADDING };
      case 'top-right':
        return { x: areaX + areaW - size.width - PADDING, y: areaY + PADDING };
      case 'bottom-left':
        return { x: areaX + PADDING, y: areaY + areaH - size.height - PADDING };
      case 'bottom-right':
      default:
        return { x: areaX + areaW - size.width - PADDING, y: areaY + areaH - size.height - PADDING };
    }
  }
}
