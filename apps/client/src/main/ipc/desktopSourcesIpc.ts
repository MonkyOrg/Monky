import { app, desktopCapturer, dialog, shell, systemPreferences, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DESKTOP_SOURCES_IPC, desktopSourcePreviewsRequestSchema, desktopSourcesOptionsSchema,
  type DesktopSource, type DesktopSourceList, type NativeScreenCaptureKind,
} from '@monky/shared';
import type { MacScreenProvider, NativeScreenCaptureTarget, NativeThumbnailCapturer } from '@monky/screen-share';
import * as screenAudio from '@monky/screen-audio';
import type { NativeWindowInfo, WindowOwner } from '@monky/screen-audio';
import type { ClientLogger } from '../clientLogger';
import { browserOcclusionEngine } from '../browserOcclusion';
import { DesktopSourcePreviews } from '../desktopSourcePreviews';
import { gameWindowIds } from '../gameWindows';
import { mt } from '../i18n';
import {
  NativeDesktopSources, nativeMonitorDesktopSources, nativeWindowIdFromSourceId, unidentifiedDesktopSource,
  type UnidentifiedNativeSource,
} from '../nativeWindows';
import { NativeScreenNotice, rendererFailure } from '../nativeScreen/errorDiagnostics';
import { screenShareModule } from '../nativeScreen/screenShareModule';
import type { IpcRegistry } from './registry';

// Icones de app nao mudam enquanto o app roda, e ler o bundle do disco a cada
// abertura do seletor de tela seria desperdicio.
const appIconCache = new Map<string, string | null>();

/**
 * O ScreenCaptureKit nao entrega o icone do app dono da janela (#455, #825).
 * Descobrimos o app de cada janela pelo modulo nativo e lemos o icone do
 * proprio bundle.
 */
async function resolveMacAppIcons(sourceIds: string[]): Promise<Map<string, string>> {
  const iconsBySourceId = new Map<string, string>();
  if (process.platform !== 'darwin' || sourceIds.length === 0) return iconsBySourceId;

  let owners: WindowOwner[];
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

function listNativeWindows(): NativeWindowInfo[] {
  if (process.platform !== 'win32') return [];
  try {
    return screenAudio.listWindows();
  } catch (e) {
    console.warn('[ScreenShare:Main] Falha ao enumerar janelas nativas:', (e as Error).message);
    throw e;
  }
}

/**
 * Le o icone do executavel do processo dono usando a API nativa do sistema.
 * Reaproveita o
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
 * macOS ties the Screen Recording permission to the app's code signature. An
 * ad-hoc build gets a new identity with every update, so the previous
 * authorization stops applying — while System Settings keeps showing the old
 * entry as enabled, so the system never asks again (#327). Releases signed with
 * the project certificate keep their identity, but the first of them still
 * differs from the ad-hoc version before it. Detect that state and offer to
 * clear the stale entry, which makes macOS prompt on the next attempt.
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

/** Windows' own windows and monitors, whose picker ids native capture resolves without Chromium. */
export function windowsDesktopSources(isExcluded: (sourceId: string) => boolean): NativeDesktopSources {
  return new NativeDesktopSources({
    windows: listNativeWindows,
    isWindowExcluded: hwnd => isExcluded(`window:${hwnd}:0`),
    windowState: hwnd => screenAudio.getWindowState(hwnd),
    monitors: () => screenAudio.listMonitors(),
    monitorState: deviceId => screenAudio.getMonitorState(deviceId),
    processAncestry: ids => screenAudio.getProcessAncestry(ids),
  });
}

/** Fixed messages the native module and the identity checks throw, safe to log as they are. */
const NATIVE_ENUMERATION_FAILURES = new Set([
  'Cannot enumerate unambiguous monitor device identities',
  'Cannot obtain physical monitor coordinates',
  'Native window selection identity collision.',
  'Native monitor selection identity collision.',
]);
/**
 * Why native enumeration failed, without the raw message of an unknown error: the
 * native module's own fixed messages and error codes, otherwise only the error's class.
 */
function enumerationFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code = 'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code : undefined;
  return code ?? (NATIVE_ENUMERATION_FAILURES.has(error.message) ? error.message : error.name);
}

function writeLog(logger: Pick<ClientLogger, 'write'> | undefined, level: 'WARN' | 'ERROR', message: string,
  data: Record<string, unknown>): void {
  try {
    logger?.write({ timestamp: new Date().toISOString(), level, category: 'SCREEN_SHARE', message, data });
  } catch (loggingError) {
    console.error('[ScreenShare:Main] Could not persist screen-share log entry:', loggingError);
  }
}

export interface DesktopSourceCatalogDeps {
  nativeSources: NativeDesktopSources;
  /** The overlay: never listed, previewed or captured. */
  isExcluded: (sourceId: string) => boolean;
  logger?: Pick<ClientLogger, 'write'>;
}

/** The sources listed, and each kind the system could not list at all, with why. */
type SourceCollection = {
  sources: DesktopSource[];
  failures: { type: DesktopSource['type']; error: unknown }[];
};

/**
 * What the screen picker offers, with previews and app icons, and the capture
 * target behind each of its ids: native identities on Windows and macOS,
 * Chromium's sources elsewhere.
 */
export class DesktopSourceCatalog {
  readonly previews: DesktopSourcePreviews;
  private thumbnails: NativeThumbnailCapturer | undefined;
  private macProvider: MacScreenProvider | undefined;
  private frozen = false;
  private readonly reportedUnidentified = new Set<string>();

  constructor(private readonly deps: DesktopSourceCatalogDeps) {
    this.previews = new DesktopSourcePreviews((type, ids, signal) => this.enumerate(false, type, ids, signal));
  }

  get nativeSources(): NativeDesktopSources {
    return this.deps.nativeSources;
  }

  private macSources(): MacScreenProvider {
    return this.macProvider ??= screenShareModule().createMacScreenProvider();
  }

  /** The overlay: never listed, previewed or captured. */
  excludes(sourceId: string): boolean {
    return this.deps.isExcluded(sourceId);
  }

  assertAllowed(sourceId: string): void {
    if (this.excludes(sourceId)) {
      throw new NativeScreenNotice(mt('screenShare.overlayWindowUnavailable'));
    }
  }

  /** The exact window, monitor or game a picker id names, for native capture. */
  resolveTarget(sourceId: string, kind: NativeScreenCaptureKind): NativeScreenCaptureTarget | Promise<NativeScreenCaptureTarget> {
    this.assertAllowed(sourceId);
    if (process.platform === 'darwin') {
      if (kind === 'game') throw new Error('macOS does not support Windows game hooks.');
      return this.macSources().resolveTarget(sourceId, kind);
    }
    return this.deps.nativeSources.resolve(sourceId, kind);
  }

  async enumerate(metadataOnly: boolean, type?: DesktopSource['type'],
    sourceIds?: readonly string[], signal?: AbortSignal): Promise<DesktopSource[]> {
    const { sources, failures } = await this.collect(metadataOnly, type, sourceIds, signal);
    if (failures.length) throw failures[0].error;
    return sources;
  }

  /** The picker's list: when the system cannot list one kind of source, the other stays usable. */
  async list(metadataOnly: boolean): Promise<DesktopSourceList> {
    const { sources, failures } = await this.collect(metadataOnly);
    if (failures.some(failure => failure.type === 'window') && failures.some(failure => failure.type === 'screen'))
      throw failures[0].error;
    return { sources, failedTypes: failures.map(failure => failure.type) };
  }

  /** Each kind of unidentified source goes to the log once, not on every picker refresh. */
  private reportUnidentified(source: UnidentifiedNativeSource): void {
    const key = `${source.kind}:${source.reason}`;
    if (this.reportedUnidentified.has(key)) return;
    this.reportedUnidentified.add(key);
    console.warn('[ScreenShare:Main] Native desktop source has no exact identity:', key);
    writeLog(this.deps.logger, 'WARN', 'Native desktop source has no exact identity',
      { kind: source.kind, reason: source.reason });
  }

  private async collect(metadataOnly: boolean, type?: DesktopSource['type'],
    sourceIds?: readonly string[], signal?: AbortSignal): Promise<SourceCollection> {
    if (this.frozen || signal?.aborted)
      throw new DOMException('Desktop source enumeration was cancelled.', 'AbortError');
    const { nativeSources, isExcluded, logger } = this.deps;
    if (process.platform === 'darwin') {
      const provider = this.macSources();
      let sources = (await provider.listSources({ signal })).filter(source =>
        (!type || source.type === type) && !isExcluded(source.id));
      if (metadataOnly) return { sources, failures: [] };
      if (sourceIds) sources = sources.filter(source => sourceIds.includes(source.id));
      const icons = await resolveMacAppIcons(sources.filter(source => source.type === 'window').map(source => source.id));
      if (signal?.aborted) throw new DOMException('Desktop preview icons were cancelled.', 'AbortError');
      for (const source of sources) source.appIconDataUrl = icons.get(source.id) ?? null;
      for (let offset = 0; offset < sources.length; offset += 4) {
        await Promise.all(sources.slice(offset, offset + 4).map(async source => {
          try {
            const bytes = await provider.thumbnail(source.id, { signal });
            source.thumbnailDataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
            source.thumbnailState = 'ready';
          } catch (error) {
            if (signal?.aborted || error instanceof Error && error.name === 'AbortError') throw error;
            console.warn('[ScreenShare:Main] Native macOS preview unavailable:', error);
            source.thumbnailState = 'unavailable';
          }
        }));
      }
      return { sources, failures: [] };
    }
    if (process.platform === 'win32') {
      const failures: SourceCollection['failures'] = [];
      const listKind = <T>(kind: DesktopSource['type'],
        read: (onUnidentified: (source: UnidentifiedNativeSource) => void) => T[]) => {
        const unidentified: UnidentifiedNativeSource[] = [];
        try {
          const listed = read(source => unidentified.push(source));
          unidentified.forEach(source => this.reportUnidentified(source));
          return { listed, unidentified };
        } catch (error) {
          console.warn('[ScreenShare:Main] Native desktop source enumeration failed:', error);
          writeLog(logger, 'ERROR', 'Native desktop source enumeration failed', {
            phase: 'native-source-identities', stage: kind, reason: enumerationFailureReason(error), metadataOnly,
            type: type ?? 'all',
          });
          failures.push({ type: kind, error });
          return { listed: [], unidentified: [] };
        }
      };
      const windows = type === 'screen' ? { listed: [], unidentified: [] }
        : listKind('window', onUnidentified => nativeSources.listWindows(onUnidentified));
      let result: DesktopSource[] = windows.listed.map(({ id, window, processAncestry }) => {
        const occlusionEngine = browserOcclusionEngine(window.processPath);
        return {
          id, name: window.title, type: 'window', isOwnWindow: window.processId === process.pid,
          processId: window.processId,
          ...(processAncestry ? { processAncestry } : {}),
          ...(occlusionEngine ? { occlusionEngine } : {}),
          thumbnailDataUrl: '', appIconDataUrl: null, thumbnailState: window.isIconic ? 'unavailable' : 'pending',
        } satisfies DesktopSource;
      });
      result.push(...windows.unidentified.flatMap((source, index) =>
        source.kind === 'window' ? [unidentifiedDesktopSource('window', index, source.window.title)] : []));
      if (type !== 'window') {
        const monitors = listKind('screen', onUnidentified => nativeSources.listMonitors(onUnidentified));
        result.push(...nativeMonitorDesktopSources([...monitors.listed,
          ...monitors.unidentified.flatMap(source => source.kind === 'monitor' ? [{ id: null, monitor: source.monitor }] : [])]));
      }
      if (metadataOnly) return { sources: result, failures };
      if (sourceIds) {
        const requested = new Set(sourceIds);
        result = result.filter(source => requested.has(source.id));
      }
      const paths = new Map(windows.listed.map(({ id, window }) => [id, window.processPath]));
      const iconPaths = result.flatMap(source => {
        const filename = paths.get(source.id);
        return filename ? [filename] : [];
      });
      const icons = await new Promise<Map<string, string>>((resolve, reject) => {
        const abort = () => {
          signal?.removeEventListener('abort', abort);
          reject(new DOMException('Desktop preview icons were cancelled.', 'AbortError'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        void resolveWindowsAppIcons(iconPaths).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
      });
      const previews = await Promise.allSettled(result.map(async source => {
        source.appIconDataUrl = icons.get(paths.get(source.id) ?? '') ?? null;
        if (source.thumbnailState === 'unavailable') return;
        try {
          if (signal?.aborted) throw new DOMException('Desktop preview was cancelled.', 'AbortError');
          if (!this.thumbnails) {
            const { NativeThumbnailCapturer: Capturer, loadThumbnailRuntime } = screenShareModule();
            this.thumbnails = new Capturer(loadThumbnailRuntime());
          }
          const kind = source.type === 'screen' ? 'monitor' : 'window';
          const target = nativeSources.resolve(source.id, kind);
          const image = await this.thumbnails.capture(target, { signal });
          nativeSources.resolve(source.id, kind);
          source.thumbnailDataUrl = `data:image/png;base64,${image.toString('base64')}`;
          source.thumbnailState = 'ready';
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
          const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
            && /^ERR_DESKTOP_PREVIEW_[A-Z_]{1,32}$/u.test(error.code) ? error.code : 'ERR_DESKTOP_PREVIEW_UNAVAILABLE';
          const hresult = error instanceof Error && 'hresult' in error && typeof error.hresult === 'number'
            && Number.isInteger(error.hresult) && error.hresult >= 0 && error.hresult <= 0xffffffff ? error.hresult : undefined;
          console.warn('[ScreenShare:Main] Native desktop preview unavailable:', code);
          logger?.write({
            timestamp: new Date().toISOString(), level: 'WARN', category: 'SCREEN_SHARE',
            message: 'Native desktop preview unavailable', data: { type: source.type, code, hresult },
          });
          source.thumbnailState = 'unavailable';
        }
      }));
      const errors = previews.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Native desktop preview requests failed.');
      return { sources: result, failures };
    }
    const sources = (await desktopCapturer.getSources({
      types: type ? [type] : ['screen', 'window'],
      thumbnailSize: metadataOnly ? { width: 0, height: 0 } : { width: 320, height: 180 },
      fetchWindowIcons: !metadataOnly,
    })).filter(source => !isExcluded(source.id));
    return { failures: [], sources: sources.map((s): DesktopSource => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnailDataUrl: metadataOnly || s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      appIconDataUrl: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
      thumbnailState: metadataOnly ? 'pending' : s.thumbnail.isEmpty() ? 'unavailable' : 'ready',
    })) };
  }

  /** Quitting: nothing new is listed and pending previews are dropped. */
  freeze(): void {
    this.frozen = true;
    this.previews.clear();
  }

  async close(): Promise<void> {
    this.frozen = true;
    await Promise.all([this.previews.dispose(), this.thumbnails?.close(), this.macProvider?.close()]);
  }
}

export interface DesktopSourcesIpcDeps {
  window: BrowserWindow;
  catalog: DesktopSourceCatalog;
  /** Where the running game is installed, to find its windows (#763). */
  gameFolders: () => Promise<string[]>;
}

/** The screen picker: sources, previews, the macOS permission and restoring a window before capture. */
export function registerDesktopSourcesIpc(registry: IpcRegistry, { window, catalog, gameFolders }: DesktopSourcesIpcDeps): void {
  registry.handle('screen-share:ensure-permission', 'main', async () => ensureScreenRecordingPermission(window));

  registry.handle(DESKTOP_SOURCES_IPC.list, 'main', async (_event, input) => {
    const options = desktopSourcesOptionsSchema.parse(input === undefined ? {} : input);
    if (options.refresh) catalog.previews.clear();
    const list = await catalog.list(options.metadataOnly === true);
    return options.metadataOnly ? { ...list, sources: list.sources.map(source => {
      const cached = catalog.previews.cached(source.id);
      if (!cached) return source;
      return source.thumbnailState === 'unavailable' ? { ...source, appIconDataUrl: cached.appIconDataUrl }
        : { ...source, ...cached, thumbnailState: cached.thumbnailDataUrl ? 'ready' as const : 'unavailable' as const };
    }) } : list;
  });
  registry.handle(DESKTOP_SOURCES_IPC.previews, 'main', async (_event, input) => {
    const request = desktopSourcePreviewsRequestSchema.parse(input);
    return catalog.previews.get({ ...request, sourceIds: request.sourceIds.filter(id => !catalog.excludes(id)) });
  });
  registry.handle(DESKTOP_SOURCES_IPC.cancelPreviews, 'main', async () => catalog.previews.cancel());

  // Restaura uma janela minimizada antes da captura (#560). O capturador WGC nao
  // consegue iniciar numa janela minimizada, entao o jogo em tela cheia que
  // minimizou no alt-tab precisa voltar ao primeiro plano antes do getUserMedia.
  registry.handle('screen-share:prepare-window', 'main', (_event, sourceId) => {
    try { catalog.assertAllowed(sourceId); }
    catch (error) { throw rendererFailure(error); }
    if (process.platform !== 'win32') return false;
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

  // Listing here also registers the ids, so the native capture can resolve them (#763).
  registry.handle('game-share:find-windows', 'main', async () => {
    if (process.platform !== 'win32') return [];
    const folders = await gameFolders();
    if (folders.length === 0) return [];
    try {
      return gameWindowIds(catalog.nativeSources.listWindows(), folders);
    } catch (error) {
      console.warn('[GameShare] Could not list the game windows:', (error as Error).message);
      return [];
    }
  });

  registry.onDispose(() => {
    void catalog.close().catch(error => console.error('[ScreenShare:Main] Preview shutdown failed:', error));
  });
}
