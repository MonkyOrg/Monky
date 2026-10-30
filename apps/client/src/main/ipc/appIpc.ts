import { app, powerMonitor, shell } from 'electron';
import net from 'node:net';
import { trayVoiceStatusSchema, type ServerProbeResult } from '@monky/shared';
import { setMainLanguage } from '../i18n';
import { fetchLinkPreview } from '../linkPreview';
import type { SteamPresence } from '../steamPresence';
import type { TaskbarCallControls } from '../taskbarCallControls';
import type { TrayManager } from '../trayManager';
import { webUrl } from './guards';
import type { IpcRegistry } from './registry';

export interface AppIpcDeps {
  trayManager?: TrayManager;
  /** Call buttons on the Windows taskbar thumbnail; absent on other systems. */
  taskbarCallControls?: TaskbarCallControls | null;
  setMinimizeToTray?: (enabled: boolean) => void;
  steamPresence: Pick<SteamPresence, 'setEnabled' | 'getCurrent'>;
}

/**
 * TCP reachability probe (#37): distinguishes an unreachable host (offline)
 * from a reachable host whose port refuses the connection (server closed).
 */
function probeServer(host: unknown, port: number): Promise<ServerProbeResult> {
  // Without a host, a socket would quietly probe this computer instead.
  if (typeof host !== 'string' || !host) return Promise.resolve({ reachable: false, reason: 'unreachable' });
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: ServerProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(5000);
    socket.once('connect', () => finish({ reachable: true, reason: 'online' }));
    socket.once('timeout', () => finish({ reachable: false, reason: 'timeout' }));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') {
        // Host answered but the port is closed → machine is online, server is not.
        finish({ reachable: false, reason: 'refused' });
      } else if (err.code === 'ETIMEDOUT') {
        finish({ reachable: false, reason: 'timeout' });
      } else {
        // ENOTFOUND / EHOSTUNREACH / ENETUNREACH / etc. → host is offline.
        finish({ reachable: false, reason: 'unreachable' });
      }
    });

    try {
      socket.connect(port, host);
    } catch {
      finish({ reachable: false, reason: 'unreachable' });
    }
  });
}

/**
 * The app around the call: its version and language, the tray and taskbar,
 * starting with the system, links, game presence, idle time and whether a
 * server answers.
 */
export function registerAppIpc(registry: IpcRegistry, deps: AppIpcDeps): void {
  const { trayManager, taskbarCallControls, setMinimizeToTray, steamPresence } = deps;
  // App version (for update checks)
  registry.handle('app:get-version', 'main', () => app.getVersion());

  // Active UI language (#16): keeps native dialogs in the same language the
  // renderer is showing.
  registry.handle('app:set-language', 'main', (_event, language) => {
    setMainLanguage(language);
    // The tray builds its labels eagerly, so it needs a redraw to pick the
    // new language up (#16).
    trayManager?.refresh();
    taskbarCallControls?.refresh();
  });

  registry.handle('app:set-minimize-to-tray', 'main', (_event, enabled) => {
    if (typeof enabled === 'boolean') {
      setMinimizeToTray?.(enabled);
    }
  });

  // The taskbar buttons send their commands back to this window, so only its own frame reports the call.
  registry.handle('tray:update-voice-status', 'main', (_event, input) => {
    const status = trayVoiceStatusSchema.parse(input);
    trayManager?.updateVoiceStatus(status);
    taskbarCallControls?.update(status);
  });

  // Auto-start with OS (#245)
  registry.handle('app:get-auto-start', 'main', () => app.getLoginItemSettings().openAtLogin);
  registry.handle('app:set-auto-start', 'main', (_event, enabled) => {
    if (typeof enabled === 'boolean') app.setLoginItemSettings({ openAtLogin: enabled });
  });

  // Open an external URL in the default browser
  registry.handle('app:open-external', 'main', async (_event, url) => {
    const parsed = webUrl(url);
    if (!parsed) return { success: false };
    try {
      await shell.openExternal(parsed.toString());
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  registry.handle('link-preview:fetch', 'main', async (_event, url) => {
    if (typeof url !== 'string') return null;
    return await fetchLinkPreview(url);
  });

  // Presença de jogo (#675): só roda quando a pessoa liga nas configurações.
  registry.handle('game-presence:set-enabled', 'main', (_event, enabled) => {
    steamPresence.setEnabled(enabled === true);
  });
  registry.handle('game-presence:get-current', 'main', () => steamPresence.getCurrent());

  // Input anywhere in the system counts, not only in Monky's window: someone
  // playing a game in the foreground is not idle in the call.
  registry.handle('system:get-idle-seconds', 'main', () => powerMonitor.getSystemIdleTime());

  registry.handle('net:probe-server', 'main', (_event, host, port) => probeServer(host, port));
}
