import { screen, type BrowserWindow } from 'electron';
import type { ScreenPictureInPictureWindows } from '../screenPictureInPictureWindow';
import { HOME_MIN_HEIGHT, HOME_MIN_WIDTH, IN_SERVER_MIN_HEIGHT, IN_SERVER_MIN_WIDTH } from '../windowSizing';
import { windowContents, type IpcRegistry } from './registry';

export interface WindowIpcDeps {
  window: BrowserWindow;
  /** Authorizes the screen Picture-in-Picture popups this window opens. */
  pipWindows: Pick<ScreenPictureInPictureWindows, 'authorize'>;
}

/** Window controls, whether the window is on screen, and screen Picture-in-Picture. */
export function registerWindowIpc(registry: IpcRegistry, { window, pipWindows }: WindowIpcDeps): void {
  // Automatic Picture-in-Picture follows the window leaving the screen
  // (minimized or hidden to the tray), never a plain focus change.
  const isWindowAway = (): boolean => window.isMinimized() || !window.isVisible();
  let away = isWindowAway();
  const notifyActivity = (): void => {
    if (!windowContents(window)) return;
    const now = isWindowAway();
    // Minimize, hide, restore and show can describe the same native transition.
    if (now === away) return;
    away = now;
    registry.send('main', now ? 'window:inactive' : 'window:active');
  };
  window.on('minimize', notifyActivity);
  window.on('hide', notifyActivity);
  window.on('restore', notifyActivity);
  window.on('show', notifyActivity);
  window.on('focus', notifyActivity);

  // Authorizes one popup from the main frame; the renderer opens it right
  // after with window.open, which needs no user activation in Electron.
  registry.handle('screen-pip:open', 'main', (_event, requestId, requireInactive, aspectRatio) => {
    if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)
      || typeof requireInactive !== 'boolean'
      || typeof aspectRatio !== 'number' || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
      throw new Error('Invalid screen Picture-in-Picture request.');
    }
    if (requireInactive && !isWindowAway()) return false;
    pipWindows.authorize(requestId, aspectRatio);
    return true;
  });
  // "Voltar ao Monky" must bring back a minimized or tray-hidden window.
  registry.handle('screen-pip:return', 'main', () => {
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  });

  registry.handle('window:minimize', 'main', () => {
    window.minimize();
  });
  registry.handle('window:toggle-maximize', 'main', () => {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  registry.handle('window:maximize', 'main', () => {
    window.maximize();
  });
  registry.handle('window:close', 'main', () => {
    window.close();
  });

  // The connection screen is a narrow card, but the in-server layout (rail +
  // channels + stage + members) needs room to stay usable, so the floor is
  // raised to a 16:9 box while a server is open (#342).
  registry.handle('window:set-in-server', 'main', (_event, inServer) => {
    const [minWidth, minHeight] = inServer
      ? [IN_SERVER_MIN_WIDTH, IN_SERVER_MIN_HEIGHT]
      : [HOME_MIN_WIDTH, HOME_MIN_HEIGHT];

    window.setMinimumSize(minWidth, minHeight);

    // setMinimumSize does not resize a window that is already smaller, which
    // would leave the layout clipped until the user dragged an edge.
    if (!window.isMaximized() && !window.isFullScreen()) {
      const [width, height] = window.getSize();
      if (width < minWidth || height < minHeight) {
        window.setSize(Math.max(width, minWidth), Math.max(height, minHeight));
      }
    }
  });

  // The connection screen must never need scrolling: it grows to whatever the
  // card measures, error banner included, and only stops at the display's work
  // area so the window can't outgrow the monitor (#536).
  registry.handle('window:fit-home-content', 'main', (_event, contentHeight) => {
    if (!Number.isFinite(contentHeight) || contentHeight <= 0) return;
    if (window.isMaximized() || window.isFullScreen()) return;

    const bounds = window.getBounds();
    const [, currentContentHeight] = window.getContentSize();
    // Title bar and borders are not part of the measured content.
    const chrome = bounds.height - currentContentHeight;
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const desired = Math.ceil(contentHeight) + chrome;
    const target = Math.max(HOME_MIN_HEIGHT, Math.min(desired, workArea.height));

    window.setMinimumSize(HOME_MIN_WIDTH, target);

    // Only ever grow: shrinking would fight a user who deliberately enlarged
    // the window, and a taller window never causes the scrollbar this fixes.
    if (bounds.height >= target) return;

    // Growing downwards past the taskbar would push the card off-screen, so the
    // window slides up just enough to stay inside the work area.
    const y = Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - target));
    window.setBounds({ ...bounds, y, height: target });
  });
}
