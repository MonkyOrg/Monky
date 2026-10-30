import { performance } from 'perf_hooks';
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import type { ClientLogger } from './clientLogger';

/**
 * Startup milestones of the main process (#490), in milliseconds since the
 * process started. main.ts imports this module right after the stdio guard, so
 * `main` marks when Electron handed control to Monky and `modules` when every
 * import of main.ts had loaded. `painted` is when the first window reported its
 * real UI on screen, the time Monky took to open.
 */
export type MainStartupStage = 'modules' | 'ready' | 'window';

const timings: Record<string, number> = { main: Math.round(performance.now()) };
let reported = false;

export function markStartup(stage: MainStartupStage): void {
  if (!(stage in timings)) timings[stage] = Math.round(performance.now());
}

/** Logs the milestones once, when the first window that paints says so. */
export function reportStartupWhenPainted(window: BrowserWindow, logger: Pick<ClientLogger, 'write'>): void {
  if (reported) return;
  const contents = window.webContents;
  const stop = (): void => { ipcMain.removeListener('app:renderer-ready', onPainted); };
  const onPainted = (event: IpcMainEvent): void => {
    if (event.sender !== contents) return;
    stop();
    if (reported) return;
    reported = true;
    logger.write({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      category: 'APP',
      message: 'Main startup timing',
      data: { ...timings, painted: Math.round(performance.now()) },
    });
  };
  ipcMain.on('app:renderer-ready', onPainted);
  window.once('closed', stop);
}
