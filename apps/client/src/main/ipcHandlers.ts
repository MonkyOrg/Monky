import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, shell, systemPreferences } from 'electron';
import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { LanDiscovery } from './lanDiscovery';
import { globalInputHook } from './globalInputHook';
import { exportIdentity, getClientId, getIdentity, hasIdentity, importIdentity, signChallenge } from './identityService';
import { BACKUP_ENVELOPE_PREFIX, openEnvelope, sealEnvelope } from './secretEnvelope';
import { HostServerOptions, ServerManager } from './serverManager';
import { mt, setMainLanguage } from './i18n';
import { fetchLinkPreview } from './linkPreview';
import { TrayManager, VoiceStatus } from './trayManager';
import type { DesktopSource, OverlayBounds, OverlayConfig, OverlaySignalPayload, OverlaySyncState, PttConfig } from '@monky/shared';
import { OverlayManager } from './overlayManager';
import {
  HOME_MIN_HEIGHT,
  HOME_MIN_WIDTH,
  IN_SERVER_MIN_HEIGHT,
  IN_SERVER_MIN_WIDTH,
} from './windowSizing';

function sanitizeDownloadFileName(fileName: string): string {
  const baseName = path.basename((fileName || '').trim()) || 'download';
  const sanitized = baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  return sanitized || 'download';
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const tempPath = `${destPath}.downloading`;
  return await new Promise((resolve, reject) => {
    const requestDownload = (currentUrl: string, redirects: number): void => {
      if (redirects > 5) {
        reject(new Error('Too many redirects'));
        return;
      }

      const transport = currentUrl.startsWith('https:') ? https : http;
      const request = transport.get(currentUrl, { headers: { 'User-Agent': 'Monky-App' } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          const locationHeader = response.headers.location;
          const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
          response.resume();
          if (!location) {
            reject(new Error(`HTTP ${status}`));
            return;
          }
          requestDownload(new URL(location, currentUrl).toString(), redirects + 1);
          return;
        }

        if (status !== 200) {
          response.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }

        const file = fs.createWriteStream(tempPath);
        let settled = false;
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          file.destroy();
          fs.unlink(tempPath, () => reject(err));
        };

        response.on('aborted', () => fail(new Error('Download aborted')));
        response.on('error', fail);
        file.on('error', fail);
        file.on('finish', () => {
          if (settled) return;
          file.close(async (closeErr) => {
            if (closeErr) {
              fail(closeErr);
              return;
            }
            try {
              try {
                await fs.promises.rm(destPath, { force: true });
                await fs.promises.rename(tempPath, destPath);
              } catch {
                // Fallback para cross-device ou locks temporários do Windows
                await fs.promises.copyFile(tempPath, destPath);
                await fs.promises.unlink(tempPath).catch(() => {});
              }
              settled = true;
              resolve();
            } catch (err: any) {
              fail(err instanceof Error ? err : new Error(String(err)));
            }
          });
        });
        response.pipe(file);
      });
      request.setTimeout(30000, () => {
        request.destroy(new Error('Download timeout'));
      });
      request.on('error', reject);
    };

    requestDownload(url, 0);
  });
}

/** Extensões que a soundboard aceita, na listagem e na leitura de um som. */
const SOUNDBOARD_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm']);

interface NativeWindowOwner {
  windowId: number;
  pid: number;
  bundlePath: string;
  appName: string;
}

interface NativeWindowInfo {
  hwnd: number;
  title: string;
  processId: number;
  processPath: string;
  isIconic: boolean;
  isVisible: boolean;
  isCloaked: boolean;
  isToolWindow: boolean;
  isLayered: boolean;
  isTransparent: boolean;
  isNoActivate: boolean;
  isAppWindow: boolean;
  width: number;
  height: number;
}

// Screen audio native module (compiled only on CI — graceful fallback)
let screenAudio: {
  isSupported: () => boolean;
  start: (opts: any, cb: (buf: Buffer) => void) => { success: boolean; error?: string };
  stop: () => { success: boolean };
  getLastError: () => string;
  getStatus: () => number;
  listWindowOwners?: () => NativeWindowOwner[];
  listWindows?: () => NativeWindowInfo[];
  restoreWindow?: (hwnd: number) => boolean;
} | null = null;
try {
  screenAudio = require('@monky/screen-audio');
} catch (e) {
  console.warn('[ScreenAudio:Main] Native module not available:', (e as Error).message);
  screenAudio = null;
}

// Icones de app nao mudam enquanto o app roda, e ler o bundle do disco a cada
// abertura do seletor de tela seria desperdicio.
const appIconCache = new Map<string, string | null>();

/** Extrai o id nativo de `window:<id nativo>:<id do webContents>`. */
function nativeWindowIdFromSourceId(sourceId: string): number | null {
  const parts = sourceId.split(':');
  if (parts[0] !== 'window') return null;
  const nativeId = Number(parts[1]);
  return Number.isFinite(nativeId) ? nativeId : null;
}

/**
 * No macOS o Electron devolve `appIcon` vazio para janelas, mesmo com
 * `fetchWindowIcons: true` (#455). Descobrimos o app dono de cada janela pelo
 * modulo nativo e lemos o icone do proprio bundle.
 */
async function resolveMacAppIcons(sourceIds: string[]): Promise<Map<string, string>> {
  const iconsBySourceId = new Map<string, string>();
  if (process.platform !== 'darwin' || !screenAudio?.listWindowOwners) return iconsBySourceId;

  let owners: NativeWindowOwner[];
  try {
    owners = screenAudio.listWindowOwners();
  } catch (e) {
    console.warn('[ScreenShare:Main] Falha ao listar donos de janela:', (e as Error).message);
    return iconsBySourceId;
  }

  const bundlePathByWindowId = new Map<number, string>();
  for (const owner of owners) bundlePathByWindowId.set(owner.windowId, owner.bundlePath);

  for (const sourceId of sourceIds) {
    const nativeId = nativeWindowIdFromSourceId(sourceId);
    if (nativeId === null) continue;
    const bundlePath = bundlePathByWindowId.get(nativeId);
    if (!bundlePath) continue;

    let dataUrl = appIconCache.get(bundlePath);
    if (dataUrl === undefined) {
      try {
        const icon = await app.getFileIcon(bundlePath, { size: 'normal' });
        dataUrl = icon.isEmpty() ? null : icon.toDataURL();
      } catch (e) {
        console.warn(`[ScreenShare:Main] Sem icone para ${bundlePath}:`, (e as Error).message);
        dataUrl = null;
      }
      appIconCache.set(bundlePath, dataUrl);
    }
    if (dataUrl) iconsBySourceId.set(sourceId, dataUrl);
  }

  return iconsBySourceId;
}

/** Enumera as janelas nativas do Windows; vazio nas outras plataformas ou sem o modulo. */
function listNativeWindows(): NativeWindowInfo[] {
  if (process.platform !== 'win32' || !screenAudio?.listWindows) return [];
  try {
    return screenAudio.listWindows();
  } catch (e) {
    console.warn('[ScreenShare:Main] Falha ao enumerar janelas nativas:', (e as Error).message);
    return [];
  }
}

/**
 * O capturador WGC do Electron 34 parou de filtrar janelas de overlay/ferramenta,
 * entao elas vazam para o seletor como se fossem janelas reais (Medal Overlay,
 * helpers do Raycast, Radmin VPN na bandeja...). O discriminador abaixo foi
 * validado contra janelas reais: nenhuma janela legitima dispara qualquer uma das
 * combinacoes, enquanto todo overlay dispara pelo menos uma (#560).
 */
function isGhostWindow(w: NativeWindowInfo): boolean {
  if (w.isCloaked) return true;
  if (w.isToolWindow) return true;
  if (w.isLayered && w.isTransparent) return true;
  if (w.isLayered && w.isNoActivate) return true;
  return false;
}

/**
 * Icones das janelas minimizadas que reexibimos: o `getSources` nao as devolve,
 * entao lemos o icone direto do executavel do processo dono. Reaproveita o
 * `appIconCache` (chaveado por caminho absoluto, sem colisao com os bundles mac).
 */
async function resolveWindowsAppIcons(processPaths: string[]): Promise<Map<string, string>> {
  const icons = new Map<string, string>();
  if (process.platform !== 'win32') return icons;

  for (const processPath of processPaths) {
    if (!processPath || icons.has(processPath)) continue;

    let dataUrl = appIconCache.get(processPath);
    if (dataUrl === undefined) {
      try {
        const icon = await app.getFileIcon(processPath, { size: 'normal' });
        dataUrl = icon.isEmpty() ? null : icon.toDataURL();
      } catch (e) {
        console.warn(`[ScreenShare:Main] Sem icone para ${processPath}:`, (e as Error).message);
        dataUrl = null;
      }
      appIconCache.set(processPath, dataUrl);
    }
    if (dataUrl) icons.set(processPath, dataUrl);
  }

  return icons;
}

export interface SetupIpcOptions {
  setMinimizeToTray?: (enabled: boolean) => void;
  clientLogger?: import('./clientLogger').ClientLogger;
  overlayManager?: OverlayManager;
}

/**
 * Bundle identifier macOS uses to key TCC permissions. Read from the bundle
 * itself so a rename in electron-builder cannot silently break the reset below.
 */
function getMacBundleId(): string {
  try {
    // .../Monky.app/Contents/MacOS/Monky -> .../Monky.app/Contents/Info.plist
    const infoPlist = path.join(path.dirname(path.dirname(app.getPath('exe'))), 'Info.plist');
    const match = fs
      .readFileSync(infoPlist, 'utf8')
      .match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    if (match) return match[1];
  } catch {
    // Unpackaged runs have no Info.plist; the default below is only a hint.
  }
  return 'com.monky.app';
}

/**
 * macOS ties the Screen Recording permission to the app's code signature. Monky
 * ships unsigned, so every update produces a different identity and the previous
 * authorization stops applying — while System Settings keeps showing the old
 * entry as enabled, so the system never asks again (#327). Detect that state and
 * offer to clear the stale entry, which makes macOS prompt on the next attempt.
 */
async function ensureScreenRecordingPermission(mainWindow: BrowserWindow): Promise<boolean> {
  if (process.platform !== 'darwin') return true;

  const status = systemPreferences.getMediaAccessStatus('screen');
  // 'not-determined' means macOS still shows its own prompt on the first capture.
  if (status === 'granted' || status === 'not-determined') return true;

  const bundleId = getMacBundleId();
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: mt('screenPermission.title'),
    message: mt('screenPermission.message'),
    detail: mt('screenPermission.detail'),
    buttons: [mt('screenPermission.reset'), mt('screenPermission.openSettings'), mt('screenPermission.cancel')],
    defaultId: 0,
    cancelId: 2,
  });

  if (response === 1) {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
    return false;
  }

  if (response !== 0) return false;

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('tccutil', ['reset', 'ScreenCapture', bundleId], (error) =>
        error ? reject(error) : resolve()
      );
    });
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: mt('screenPermission.resetFailedTitle'),
      message: (error as Error).message,
      detail: mt('screenPermission.resetFailedDetail', { bundleId }),
    });
    return false;
  }

  // TCC caches the verdict per process, so the new prompt only appears on a
  // fresh launch.
  app.relaunch();
  app.exit(0);
  return false;
}

export function setupIpcHandlers(
  mainWindow: BrowserWindow,
  serverManager: ServerManager,
  trayManager?: TrayManager,
  options?: SetupIpcOptions
): void {
  const lanDiscovery = new LanDiscovery(mainWindow);
  globalInputHook.init(mainWindow);
  const overlayManager = options?.overlayManager || new OverlayManager(mainWindow);

  // Overlay (#169)
  ipcMain.handle('overlay:open', (_event, config: OverlayConfig) => {
    return { success: overlayManager.open(config) };
  });

  ipcMain.handle('overlay:close', () => {
    return { success: overlayManager.close() };
  });

  ipcMain.handle('overlay:is-open', () => {
    return overlayManager.isOpen();
  });

  ipcMain.handle('overlay:get-config', () => {
    return overlayManager.getConfig();
  });

  ipcMain.handle('overlay:set-config', (_event, config: Partial<OverlayConfig>) => {
    overlayManager.setConfig(config);
  });

  ipcMain.handle('overlay:save-bounds', (_event, bounds: OverlayBounds) => {
    overlayManager.setConfig({ bounds, position: 'custom' });
  });

  ipcMain.handle('overlay:reset-bounds', () => {
    overlayManager.resetBounds();
  });

  ipcMain.handle('overlay:send-signal', (_event, payload: OverlaySignalPayload) => {
    overlayManager.sendSignal(payload);
  });

  ipcMain.handle('overlay:send-sync-state', (_event, state: OverlaySyncState) => {
    overlayManager.sendSyncState(state);
  });

  ipcMain.handle('tray:update-voice-status', (_, status: VoiceStatus) => {
    trayManager?.updateVoiceStatus(status);
  });

  // Active UI language (#16): keeps native dialogs in the same language the
  // renderer is showing.
  ipcMain.handle('app:set-language', (_event, language: string) => {
    setMainLanguage(language);
    // The tray builds its labels eagerly, so it needs a redraw to pick the
    // new language up (#16).
    trayManager?.refresh();
  });

  ipcMain.handle('app:set-minimize-to-tray', (_event, enabled: boolean) => {
    if (typeof enabled === 'boolean') {
      options?.setMinimizeToTray?.(enabled);
    }
  });

  ipcMain.handle('identity:has', async () => hasIdentity());
  ipcMain.handle('identity:get', async () => getIdentity(true));
  ipcMain.handle('identity:get-client-id', async () => getClientId());
  ipcMain.handle('identity:sign-challenge', async (_event, nonceHex: string) => signChallenge(nonceHex));
  ipcMain.handle('identity:export', async (_event, password: string, extras?: string) =>
    exportIdentity(password, typeof extras === 'string' ? extras : undefined)
  );
  ipcMain.handle('identity:import', async (_event, exportedIdentity: string, password: string) => importIdentity(exportedIdentity, password));

  // Backup of saved servers and app settings (#472). The renderer owns the
  // content (it all lives in localStorage); the main process only picks the
  // path, seals the file with the user's password and touches the disk.
  //
  // The backup carries the passwords of saved servers, so it gets the very same
  // protection as the identity export instead of landing on disk as plain JSON.
  ipcMain.handle('backup:encrypt', async (_event, contents: string, password: string) => {
    if (typeof contents !== 'string' || !contents) {
      return { success: false, error: 'Conteúdo de backup inválido.' };
    }
    try {
      return { success: true, payload: sealEnvelope(contents, password, BACKUP_ENVELOPE_PREFIX) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('backup:decrypt', async (_event, payload: string, password: string) => {
    if (typeof payload !== 'string' || !payload) {
      return { success: false, error: 'Arquivo de backup inválido.' };
    }
    try {
      const contents = openEnvelope(
        payload,
        password,
        BACKUP_ENVELOPE_PREFIX,
        'Arquivo de backup inválido.',
        'Senha incorreta ou backup corrompido.'
      );
      return { success: true, contents };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('backup:save-file', async (_event, contents: string, suggestedName: string) => {
    if (typeof contents !== 'string' || !contents) {
      return { success: false, error: 'Conteúdo de backup inválido.' };
    }
    try {
      const safeName = sanitizeDownloadFileName(suggestedName || 'monky-backup.monkybackup');
      const result = await dialog.showSaveDialog(mainWindow, {
        title: mt('dialog.saveBackup'),
        defaultPath: path.join(app.getPath('documents'), safeName),
        filters: [{ name: 'Monky', extensions: ['monkybackup', 'json'] }],
      });
      if (result.canceled || !result.filePath) return { success: false };
      await fs.promises.writeFile(result.filePath, contents, 'utf8');
      return { success: true, filePath: result.filePath };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('backup:open-file', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: mt('dialog.openBackup'),
        filters: [{ name: 'Monky', extensions: ['monkybackup', 'json'] }],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) return { success: false };
      const contents = await fs.promises.readFile(result.filePaths[0], 'utf8');
      return { success: true, contents };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Local Server Management
  ipcMain.handle('server-host:start', async (_, options: HostServerOptions) => {
    return await serverManager.startServer(options);
  });

  ipcMain.handle('server-host:stop', async () => {
    await serverManager.stopServer();
    return { success: true };
  });

  ipcMain.handle('server-host:status', async () => {
    return serverManager.getStatus();
  });

  ipcMain.handle('server-host:logs', async () => {
    return serverManager.getLogs();
  });

  ipcMain.handle('server-host:clear-logs', async () => {
    serverManager.clearLogs();
  });

  ipcMain.handle('server-host:stats', async () => {
    return serverManager.getStats();
  });

  // Removing a server from "Meus Servidores" has to take its data with it (#364).
  ipcMain.handle('server-host:delete-data', async (_, serverId: string) => {
    if (typeof serverId !== 'string') return { success: false };
    return serverManager.deleteServerData(serverId);
  });

  ipcMain.handle('lan:start', async () => {
    await lanDiscovery.start();
  });

  ipcMain.handle('lan:stop', async () => {
    await lanDiscovery.stop();
  });

  // Desktop Screen Sharing sources
  ipcMain.handle('screen-share:ensure-permission', async () => {
    return await ensureScreenRecordingPermission(mainWindow);
  });

  ipcMain.handle('screen-share:get-sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });

    const nativeWindows = listNativeWindows();
    const nativeByHwnd = new Map<number, NativeWindowInfo>();
    for (const w of nativeWindows) nativeByHwnd.set(w.hwnd, w);

    const macIcons = await resolveMacAppIcons(sources.map((s) => s.id));

    // 1) Remove os overlays/tool windows que o capturador WGC passou a vazar. Sem
    //    dados nativos (outra plataforma ou janela que fechou no meio) mantemos a
    //    fonte para nao esconder algo legitimo por engano.
    const realSources = sources.filter((s) => {
      if (!s.id.startsWith('window:')) return true;
      const hwnd = nativeWindowIdFromSourceId(s.id);
      const info = hwnd === null ? undefined : nativeByHwnd.get(hwnd);
      return info ? !isGhostWindow(info) : true;
    });

    const result: DesktopSource[] = realSources.map((s) => {
      const electronIcon = s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null;
      return {
        id: s.id,
        name: s.name,
        type: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnailDataUrl: s.thumbnail.toDataURL(),
        appIconDataUrl: electronIcon ?? macIcons.get(s.id) ?? null,
      };
    });

    // 2) Reexibe janelas minimizadas que o WGC omite — tipicamente um jogo em tela
    //    cheia que minimizou quando o usuario deu alt-tab para abrir este seletor
    //    (#560). Sem preview ao vivo (a janela esta minimizada), a UI mostra um
    //    tile de fallback; a captura passa a exibir o jogo assim que ele volta ao
    //    primeiro plano.
    const presentHwnds = new Set<number>();
    for (const s of sources) {
      const hwnd = nativeWindowIdFromSourceId(s.id);
      if (hwnd !== null) presentHwnds.add(hwnd);
    }
    const minimizedExtras = nativeWindows.filter(
      (w) =>
        w.isIconic &&
        !presentHwnds.has(w.hwnd) &&
        !isGhostWindow(w) &&
        w.width >= 240 &&
        w.height >= 160,
    );
    const extraIcons = await resolveWindowsAppIcons(minimizedExtras.map((w) => w.processPath));
    for (const w of minimizedExtras) {
      result.push({
        id: `window:${w.hwnd}:0`,
        name: w.title,
        type: 'window',
        thumbnailDataUrl: '',
        appIconDataUrl: extraIcons.get(w.processPath) ?? null,
      });
    }

    return result;
  });

  // Restaura uma janela minimizada antes da captura (#560). O capturador WGC nao
  // consegue iniciar numa janela minimizada, entao o jogo em tela cheia que
  // minimizou no alt-tab precisa voltar ao primeiro plano antes do getUserMedia.
  ipcMain.handle('screen-share:prepare-window', (_event, sourceId: string) => {
    if (process.platform !== 'win32' || !screenAudio?.restoreWindow) return false;
    if (typeof sourceId !== 'string') return false;
    const hwnd = nativeWindowIdFromSourceId(sourceId);
    if (hwnd === null) return false;
    try {
      return screenAudio.restoreWindow(hwnd);
    } catch (e) {
      console.warn('[ScreenShare:Main] Falha ao restaurar janela:', (e as Error).message);
      return false;
    }
  });

  // Avatar Image Selection Dialog
  ipcMain.handle('dialog:select-image', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mt('dialog.selectProfilePhoto'),
      filters: [
        { name: 'Imagens (PNG, JPG, WebP)', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      ],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const filePath = result.filePaths[0];
    const buffer = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const base64 = buffer.toString('base64');

    return {
      fileName: path.basename(filePath),
      mimeType: mime,
      base64: `data:${mime};base64,${base64}`,
    };
  });

  // Custom sound file selection (#7)
  ipcMain.handle('dialog:select-sound-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mt('dialog.selectSoundFile'),
      filters: [
        { name: mt('dialog.audioFilter'), extensions: ['wav', 'mp3', 'ogg', 'webm'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const buffer = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : ext === 'webm' ? 'audio/webm' : 'audio/wav';
    const base64 = buffer.toString('base64');
    return `data:${mime};base64,${base64}`;
  });

  // Soundboard Folder Selection
  ipcMain.handle('dialog:select-soundboard-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mt('dialog.selectSoundboardFolder'),
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  // Soundboard List Sounds
  ipcMain.handle('soundboard:list-sounds', async (_, folderPath: string) => {
    if (!folderPath || typeof folderPath !== 'string') {
      return [];
    }
    try {
      const folderStat = await fs.promises.stat(folderPath).catch(() => null);
      if (!folderStat || !folderStat.isDirectory()) {
        return [];
      }
      const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
      const validExts = SOUNDBOARD_EXTENSIONS;
      
      const soundPromises = entries
        .filter((entry) => entry.isFile() && validExts.has(path.extname(entry.name).toLowerCase()))
        .map(async (entry) => {
          const ext = path.extname(entry.name).toLowerCase();
          const fullPath = path.join(folderPath, entry.name);
          const stat = await fs.promises.stat(fullPath);
          const displayName = path.basename(entry.name, ext);
          return {
            name: displayName,
            fileName: entry.name,
            filePath: fullPath,
            sizeBytes: stat.size,
            ext,
          };
        });

      const sounds = await Promise.all(soundPromises);
      sounds.sort((a, b) => a.name.localeCompare(b.name));
      return sounds;
    } catch (e) {
      console.warn('Error reading soundboard folder:', e);
      return [];
    }
  });

  // Soundboard Read Sound
  ipcMain.handle('soundboard:read-sound', async (_, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') {
      return null;
    }
    // O caminho vem do renderer, então a extensão é conferida antes da leitura:
    // sem isso o canal devolvia o conteúdo de qualquer arquivo até 3 MB (#372).
    if (!SOUNDBOARD_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      return null;
    }
    try {
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile()) {
        return null;
      }
      if (stat.size > 3 * 1024 * 1024) {
        throw new Error(mt('error.audioFileTooLarge'));
      }
      const buffer = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      let mime = 'audio/mp3';
      if (ext === '.wav') mime = 'audio/wav';
      else if (ext === '.ogg') mime = 'audio/ogg';
      else if (ext === '.m4a' || ext === '.aac') mime = 'audio/mp4';
      else if (ext === '.webm') mime = 'audio/webm';

      return {
        fileName: path.basename(filePath),
        soundName: path.basename(filePath, ext),
        mimeType: mime,
        base64: buffer.toString('base64'),
        dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
        sizeBytes: stat.size,
      };
    } catch (e: any) {
      console.warn('Error reading sound file:', e);
      return null;
    }
  });

  // --- Figurinhas do chat (#356) ---
  // Same shape as the soundboard folder feature: the user points at a folder on
  // their machine and we only ever read image files out of it.
  const STICKER_MIME_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.apng': 'image/apng',
    '.avif': 'image/avif',
  };
  // Animated GIFs and WebPs are routinely a few megabytes, so the ceiling has to
  // be generous enough not to quietly swallow a normal sticker. The server
  // accepts far more (LIMITS.MAX_ATTACHMENT_FILE_SIZE_DEFAULT is 50 MB); the
  // tighter bound here exists only because the renderer decodes these as base64
  // data URLs, which costs ~33% on top of the file size.
  const MAX_STICKER_BYTES = 8 * 1024 * 1024;
  const MAX_STICKERS_LISTED = 500;

  /**
   * Folders the user confirmed through the dialog below. `stickers:save` is the
   * only channel here that writes to disk, so it refuses any folder outside this
   * set: the renderer handles untrusted remote chat content and must not be able
   * to name an arbitrary write target. Listing and reading stay path-based, like
   * the pre-existing soundboard channels, because they cannot modify anything.
   *
   * It is persisted so the confirmation survives a restart — otherwise the first
   * save of every session would pop a folder dialog for no reason the user can
   * see.
   */
  const confirmedFoldersFile = path.join(app.getPath('userData'), 'sticker-folders.json');

  const loadConfirmedStickerFolders = (): Set<string> => {
    try {
      const raw = fs.readFileSync(confirmedFoldersFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((p): p is string => typeof p === 'string'));
    } catch {
      return new Set();
    }
  };

  const confirmedStickerFolders = loadConfirmedStickerFolders();

  const confirmStickerFolder = (folder: string): void => {
    confirmedStickerFolders.add(path.resolve(folder));
    try {
      fs.writeFileSync(confirmedFoldersFile, JSON.stringify(Array.from(confirmedStickerFolders)), 'utf8');
    } catch (e) {
      // Losing the record only costs an extra dialog next session.
      console.warn('Could not persist the confirmed stickers folder:', e);
    }
  };

  ipcMain.handle('dialog:select-stickers-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mt('dialog.selectStickersFolder'),
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    confirmStickerFolder(result.filePaths[0]);
    return result.filePaths[0];
  });

  ipcMain.handle('stickers:list', async (_, folderPath: string) => {
    if (!folderPath || typeof folderPath !== 'string') {
      return [];
    }
    try {
      const folderStat = await fs.promises.stat(folderPath).catch(() => null);
      if (!folderStat || !folderStat.isDirectory()) {
        return [];
      }
      const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isFile() && STICKER_MIME_TYPES[path.extname(entry.name).toLowerCase()])
        .slice(0, MAX_STICKERS_LISTED);

      const stickers = await Promise.all(
        candidates.map(async (entry) => {
          const ext = path.extname(entry.name).toLowerCase();
          const fullPath = path.join(folderPath, entry.name);
          const stat = await fs.promises.stat(fullPath).catch(() => null);
          if (!stat) return null;
          return {
            name: path.basename(entry.name, ext),
            fileName: entry.name,
            filePath: fullPath,
            sizeBytes: stat.size,
            ext,
            mimeType: STICKER_MIME_TYPES[ext],
            // Listed but flagged instead of dropped, so an oversized file is
            // visibly rejected rather than appearing to have been ignored.
            tooLarge: stat.size > MAX_STICKER_BYTES,
          };
        })
      );

      const valid = stickers.filter((s): s is NonNullable<typeof s> => s !== null);
      valid.sort((a, b) => a.name.localeCompare(b.name));
      return valid;
    } catch (e) {
      console.warn('Error reading stickers folder:', e);
      return [];
    }
  });

  ipcMain.handle('stickers:read', async (_, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') {
      return null;
    }
    // Only ever hand image bytes back to the renderer, whatever path it asks for.
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = STICKER_MIME_TYPES[ext];
    if (!mimeType) return null;
    try {
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > MAX_STICKER_BYTES) {
        return null;
      }
      const buffer = await fs.promises.readFile(filePath);
      return {
        fileName: path.basename(filePath),
        mimeType,
        dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
        sizeBytes: stat.size,
      };
    } catch (e) {
      console.warn('Error reading sticker file:', e);
      return null;
    }
  });

  // Saves a sticker somebody else sent into the user's own folder (#356 QA).
  ipcMain.handle('stickers:save', async (_, folderPath: string, fileName: string, bytes: Uint8Array) => {
    if (!folderPath || typeof folderPath !== 'string') {
      return { ok: false, reason: 'no-folder' as const };
    }
    // Only a folder the user confirmed through the dialog is writable, so the
    // renderer cannot pick the destination on its own.
    if (!confirmedStickerFolders.has(path.resolve(folderPath))) {
      return { ok: false, reason: 'no-folder' as const };
    }
    // The renderer supplies the name, so only the basename is trusted: it must
    // never be able to steer the write outside that folder.
    const safeName = path.basename(String(fileName ?? ''));
    const ext = path.extname(safeName).toLowerCase();
    if (!safeName || !STICKER_MIME_TYPES[ext]) {
      return { ok: false, reason: 'bad-extension' as const };
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_STICKER_BYTES) {
      return { ok: false, reason: 'too-large' as const };
    }
    try {
      const folderStat = await fs.promises.stat(folderPath).catch(() => null);
      if (!folderStat || !folderStat.isDirectory()) {
        return { ok: false, reason: 'no-folder' as const };
      }

      // Never clobber an existing sticker: "cat.gif" becomes "cat (1).gif". The
      // 'wx' flag makes the filesystem itself reject an existing name, so there
      // is no window between checking and writing.
      const base = path.basename(safeName, ext);
      for (let i = 0; i < 100; i++) {
        const candidate = i === 0 ? safeName : `${base} (${i})${ext}`;
        try {
          await fs.promises.writeFile(path.join(folderPath, candidate), bytes, { flag: 'wx' });
          return { ok: true, fileName: candidate };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      }
      return { ok: false, reason: 'write-failed' as const };
    } catch (e) {
      console.warn('Error saving sticker file:', e);
      return { ok: false, reason: 'write-failed' as const };
    }
  });

  // Global shortcuts for the soundboard and actions (mute/deafen/camera/etc.)
  // are matched through the passive uiohook listener (globalInputHook) instead
  // of Electron globalShortcut. globalShortcut.register() consumes the key on
  // Windows, so a single-key bind like "Q" was swallowed and never reached the
  // focused game (#571). uiohook only observes input, so the key passes through.
  ipcMain.handle('soundboard:register-shortcuts', (_, shortcuts: Array<{ soundName: string; accelerator: string }>) => {
    return globalInputHook.setSoundboardHotkeys(Array.isArray(shortcuts) ? shortcuts : []);
  });

  // Action Global Shortcuts Registration (#252)
  ipcMain.handle('shortcuts:register-actions', (_, shortcuts: Array<{ action: string; accelerator: string }>) => {
    return globalInputHook.setActionHotkeys(Array.isArray(shortcuts) ? shortcuts : []);
  });

  // Push to Talk (PTT) (#186)
  ipcMain.handle('ptt:set-config', (_, config: PttConfig) => {
    return globalInputHook.setPttConfig(config);
  });

  ipcMain.handle('ptt:start-capture', () => {
    return globalInputHook.startCapture();
  });

  ipcMain.handle('ptt:stop-capture', () => {
    return globalInputHook.stopCapture();
  });

  // Window Controls
  ipcMain.handle('window:minimize', () => {
    mainWindow.minimize();
  });
  ipcMain.handle('window:toggle-maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.handle('window:maximize', () => {
    mainWindow.maximize();
  });

  // The connection screen is a narrow card, but the in-server layout (rail +
  // channels + stage + members) needs room to stay usable, so the floor is
  // raised to a 16:9 box while a server is open (#342).
  ipcMain.handle('window:set-in-server', (_event, inServer: boolean) => {
    const [minWidth, minHeight] = inServer
      ? [IN_SERVER_MIN_WIDTH, IN_SERVER_MIN_HEIGHT]
      : [HOME_MIN_WIDTH, HOME_MIN_HEIGHT];

    mainWindow.setMinimumSize(minWidth, minHeight);

    // setMinimumSize does not resize a window that is already smaller, which
    // would leave the layout clipped until the user dragged an edge.
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      const [width, height] = mainWindow.getSize();
      if (width < minWidth || height < minHeight) {
        mainWindow.setSize(Math.max(width, minWidth), Math.max(height, minHeight));
      }
    }
  });

  ipcMain.handle('window:close', () => {
    mainWindow.close();
  });

  // The connection screen must never need scrolling: it grows to whatever the
  // card measures, error banner included, and only stops at the display's work
  // area so the window can't outgrow the monitor (#536).
  ipcMain.handle('window:fit-home-content', (_event, contentHeight: number) => {
    if (!Number.isFinite(contentHeight) || contentHeight <= 0) return;
    if (mainWindow.isDestroyed() || mainWindow.isMaximized() || mainWindow.isFullScreen()) return;

    const bounds = mainWindow.getBounds();
    const [, currentContentHeight] = mainWindow.getContentSize();
    // Title bar and borders are not part of the measured content.
    const chrome = bounds.height - currentContentHeight;
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const desired = Math.ceil(contentHeight) + chrome;
    const target = Math.max(HOME_MIN_HEIGHT, Math.min(desired, workArea.height));

    mainWindow.setMinimumSize(HOME_MIN_WIDTH, target);

    // Only ever grow: shrinking would fight a user who deliberately enlarged
    // the window, and a taller window never causes the scrollbar this fixes.
    if (bounds.height >= target) return;

    // Growing downwards past the taskbar would push the card off-screen, so the
    // window slides up just enough to stay inside the work area.
    const y = Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - target));
    mainWindow.setBounds({ ...bounds, y, height: target });
  });

  // App version (for update checks)
  ipcMain.handle('app:get-version', () => app.getVersion());

  // Open an external URL in the default browser
  ipcMain.handle('app:open-external', async (_, url: string) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { success: false };
      }

      await shell.openExternal(parsed.toString());
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('link-preview:fetch', async (_, url: string) => {
    if (typeof url !== 'string') return null;
    return await fetchLinkPreview(url);
  });

  // Auto-start with OS (#245)
  ipcMain.handle('app:get-auto-start', () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('app:set-auto-start', (_, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
  });

  ipcMain.handle('app:download-file', async (_, url: string, fileName: string) => {
    try {
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { success: false, error: 'Invalid URL' };
      }

      const fallbackName = sanitizeDownloadFileName(decodeURIComponent(path.basename(parsedUrl.pathname) || 'download'));
      const suggestedName = sanitizeDownloadFileName(fileName || fallbackName);
      const saveResult = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(app.getPath('downloads'), suggestedName),
      });

      if (saveResult.canceled || !saveResult.filePath) {
        return { success: false };
      }

      await downloadToFile(parsedUrl.toString(), saveResult.filePath);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // TCP reachability probe (#37): distinguishes an unreachable host (offline)
  // from a reachable host whose port refuses the connection (server closed).
  ipcMain.handle('net:probe-server', async (_, host: string, port: number) => {
    return await new Promise<{ reachable: boolean; reason: 'online' | 'refused' | 'timeout' | 'unreachable' }>(
      (resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (result: { reachable: boolean; reason: 'online' | 'refused' | 'timeout' | 'unreachable' }) => {
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
      }
    );
  });

  // Screen Audio Capture (native module)
  ipcMain.handle('screen-audio:is-supported', () => {
    return screenAudio ? screenAudio.isSupported() : false;
  });

  ipcMain.handle('screen-audio:diagnose', () => {
    const os = require('os');
    const release = os.release();
    return {
      nativeModuleLoaded: screenAudio !== null,
      platformSupported: screenAudio ? screenAudio.isSupported() : false,
      osVersion: `${os.platform()} ${release}`,
      pid: process.pid,
      captureStatus: screenAudio ? screenAudio.getStatus() : -1,
      lastError: screenAudio ? screenAudio.getLastError() : 'Module not loaded',
    };
  });

  // Screen Audio buffer aggregation (batching) to avoid IPC message saturation (#55)
  let audioBufferAccumulator: Buffer[] = [];
  let accumulatedBytes = 0;
  let audioFlushTimer: NodeJS.Timeout | null = null;

  const flushScreenAudioFrames = (): void => {
    if (audioBufferAccumulator.length === 0) return;
    const merged = Buffer.concat(audioBufferAccumulator, accumulatedBytes);
    audioBufferAccumulator = [];
    accumulatedBytes = 0;
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('screen-audio:frame', merged);
    }
  };

  const clearAudioBufferAccumulator = (): void => {
    if (audioFlushTimer) {
      clearTimeout(audioFlushTimer);
      audioFlushTimer = null;
    }
    audioBufferAccumulator = [];
    accumulatedBytes = 0;
  };

  ipcMain.handle('screen-audio:start', (_event, sourceId?: string) => {
    if (!screenAudio || !screenAudio.isSupported()) {
      return { success: false, error: 'Not supported on this platform' };
    }
    clearAudioBufferAccumulator();
    const excludePid = process.pid;
    // Electron encodes a window source id as `window:<id>:<n>` — the HWND on
    // Windows, the CGWindowID on macOS. When the user shares a single application
    // window, capture only that app's audio instead of the whole machine (#298).
    let includeWindowId = 0;
    if (sourceId && sourceId.startsWith('window:')) {
      const parsed = Number.parseInt(sourceId.split(':')[1] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) includeWindowId = parsed;
    }
    const opts: Record<string, number> = { excludePid, sampleRate: 48000, channels: 2 };
    if (includeWindowId) opts.includeWindowId = includeWindowId;
    console.log(`[ScreenAudio:Main] Starting capture (excludePid=${excludePid}, includeWindowId=${includeWindowId || 'none'}, source=${sourceId ?? 'screen'})`);
    const result = screenAudio.start(
      opts,
      (buffer: Buffer) => {
        if (!buffer || buffer.length === 0) {
          console.warn('[ScreenAudio:Main] Native capture stream error detected (0-byte frame).');
          const lastErr = screenAudio?.getLastError() || 'Audio device invalidated or disconnected';
          clearAudioBufferAccumulator();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('screen-audio:error', lastErr);
          }
          return;
        }

        audioBufferAccumulator.push(buffer);
        accumulatedBytes += buffer.length;

        // Flush when we accumulate ~16KB of PCM (~40ms) or via timer every ~35ms
        if (accumulatedBytes >= 16384) {
          if (audioFlushTimer) {
            clearTimeout(audioFlushTimer);
            audioFlushTimer = null;
          }
          flushScreenAudioFrames();
        } else if (!audioFlushTimer) {
          audioFlushTimer = setTimeout(() => {
            audioFlushTimer = null;
            flushScreenAudioFrames();
          }, 35);
        }
      }
    );
    console.log(`[ScreenAudio:Main] start() result:`, result);
    return result;
  });

  ipcMain.handle('screen-audio:stop', () => {
    clearAudioBufferAccumulator();
    if (!screenAudio) return { success: false };
    return screenAudio.stop();
  });

  // Client Logging (#444)
  const logger = options?.clientLogger;
  if (logger) {
    ipcMain.handle('client-log:write', (_, entry) => {
      logger.write(entry);
    });
    ipcMain.handle('client-log:get-config', () => logger.getConfig());
    ipcMain.handle('client-log:set-config', (_, config) => {
      logger.setConfig(config);
    });
    ipcMain.handle('client-log:export', () => logger.exportLogs());
    ipcMain.handle('client-log:get-size', () => logger.getTotalSize());
    ipcMain.handle('client-log:clear', () => {
      logger.clearLogs();
    });
  }

  mainWindow.on('closed', () => {
    clearAudioBufferAccumulator();
    void lanDiscovery.stop();
    globalInputHook.destroy();
  });
}
