import { createHash } from 'node:crypto';
import type { NativeMonitorInfo, NativeWindowInfo, NativeWindowState } from '@monky/screen-audio';
import type { NativeScreenCaptureTarget } from '@monky/screen-share';
import { validateCaptureTarget } from '@monky/screen-share/target';
import type { DesktopSource, NativeScreenCaptureKind } from '@monky/shared';

export function nativeWindowIdFromSourceId(sourceId: string): number | null {
  const match = /^window:([1-9][0-9]{0,15}):(?:[0-9]{1,10}|[a-f0-9]{64})$/.exec(sourceId);
  const hwnd = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(hwnd) && hwnd > 0 ? hwnd : null;
}

export function isGhostWindow(window: NativeWindowInfo): boolean {
  return window.isCloaked || window.isToolWindow
    || (window.isLayered && (window.isTransparent || window.isNoActivate));
}

type Inspection = {
  windows(): NativeWindowInfo[];
  windowState(hwnd: number): NativeWindowState | null;
  monitors(): NativeMonitorInfo[];
  monitorState(deviceId: string): NativeMonitorInfo | null;
  isWindowExcluded?(hwnd: number): boolean;
  /** Running parents of each process, nearest first, from one snapshot; null for a process that is gone. */
  processAncestry?(processIds: readonly number[]): (number[] | null)[];
};
type ListedWindow = { id: string; window: NativeWindowInfo; processAncestry?: number[] };
type MonitorTarget = Extract<NativeScreenCaptureTarget, { deviceId: string }>;
type WindowTarget = Extract<NativeScreenCaptureTarget, { hwnd: number }>;
type UnidentifiedReason = 'invalid-identity' | 'ambiguous-identity';
/** A window or monitor without an exact capture identity: shown so the user knows it exists, never captured. */
export type UnidentifiedNativeSource =
  | { kind: 'window'; reason: UnidentifiedReason; window: NativeWindowInfo }
  | { kind: 'monitor'; reason: UnidentifiedReason; monitor: NativeMonitorInfo };
type OnUnidentified = (source: UnidentifiedNativeSource) => void;

function isValidTarget(target: NativeScreenCaptureTarget): boolean {
  try {
    validateCaptureTarget(target);
    return true;
  } catch {
    return false;
  }
}

function repeated<T, K>(items: readonly T[], key: (item: T) => K): Set<K> {
  const seen = new Set<K>(), duplicates = new Set<K>();
  for (const item of items) (seen.has(key(item)) ? duplicates : seen).add(key(item));
  return duplicates;
}

function monitorTarget(monitor: NativeMonitorInfo): MonitorTarget {
  const target: MonitorTarget = {
    kind: 'monitor', deviceId: monitor.deviceId, deviceName: monitor.deviceName,
    bounds: { ...monitor.bounds },
  };
  validateCaptureTarget(target);
  return target;
}

function monitorIdentity(target: MonitorTarget): string {
  const { x, y, width, height } = target.bounds;
  return JSON.stringify([target.deviceId, target.deviceName, x, y, width, height]);
}

/** Picker entries for unidentified sources: their ids name no capture target, so they can never be selected. */
export function unidentifiedDesktopSource(type: DesktopSource['type'], index: number, name: unknown): DesktopSource {
  return { id: `unidentified-${type}:${index}`, name: typeof name === 'string' ? name : '', type, unidentified: true,
    thumbnailDataUrl: '', appIconDataUrl: null, thumbnailState: 'unavailable' };
}

/**
 * The Screens tab in display order. A monitor without an exact identity (`id: null`) keeps its place
 * in the numbering, so "Screen 2" is still the second screen.
 */
export function nativeMonitorDesktopSources(
  monitors: readonly { id: string | null; monitor: NativeMonitorInfo }[],
): DesktopSource[] {
  const order = (monitor: NativeMonitorInfo) => typeof monitor.deviceName === 'string' ? monitor.deviceName : '';
  return [...monitors]
    .sort((a, b) => order(a.monitor).localeCompare(order(b.monitor), 'en', { numeric: true }))
    .map(({ id, monitor }, index): DesktopSource => id === null
      ? { ...unidentifiedDesktopSource('screen', index, monitor.name), displayNumber: index + 1 }
      : { id, name: monitor.name, displayNumber: index + 1, type: 'screen',
        thumbnailDataUrl: '', appIconDataUrl: null, thumbnailState: 'pending' });
}

export class NativeDesktopSources {
  private windows = new Map<string, WindowTarget>();
  private monitors = new Map<string, MonitorTarget>();

  constructor(private readonly inspect: Inspection) {}

  /**
   * One window without an exact identity is reported on its own: it must not hide every other
   * window from the picker, and it can never become a capture target either.
   */
  listWindows(onUnidentified: OnUnidentified = () => {}): ListedWindow[] {
    // Refreshing another picker must not revoke a still-owned hidden/minimized
    // selection needed for source restoration.
    const selected = new Map([...this.windows].filter(([, target]) => {
      if (this.inspect.isWindowExcluded?.(target.hwnd)) return false;
      const state = this.inspect.windowState(target.hwnd);
      return state?.isTopLevel && state.processId === target.expectedProcessId
        && state.processCreationTime100ns === target.expectedProcessCreationTime100ns;
    }));
    const candidates = this.inspect.windows().filter((window): window is NativeWindowInfo & { processCreationTime100ns: string } =>
      !this.inspect.isWindowExcluded?.(window.hwnd) && !isGhostWindow(window) && (window.isVisible || window.isIconic)
      && !!window.processCreationTime100ns);
    const ambiguous = repeated(candidates, window => window.hwnd);
    const result: ListedWindow[] = [];
    for (const window of candidates) {
      if (ambiguous.has(window.hwnd)) {
        onUnidentified({ kind: 'window', reason: 'ambiguous-identity', window });
        continue;
      }
      const target: WindowTarget = { kind: 'window', hwnd: window.hwnd, expectedProcessId: window.processId,
        expectedProcessCreationTime100ns: window.processCreationTime100ns };
      if (!isValidTarget(target)) {
        onUnidentified({ kind: 'window', reason: 'invalid-identity', window });
        continue;
      }
      const identity = JSON.stringify([target.hwnd, target.expectedProcessId, target.expectedProcessCreationTime100ns]);
      const id = `window:${window.hwnd}:${createHash('sha256').update(identity).digest('hex')}`;
      const previous = this.windows.get(id);
      if (previous && (previous.hwnd !== target.hwnd
        || previous.expectedProcessId !== target.expectedProcessId
        || previous.expectedProcessCreationTime100ns !== target.expectedProcessCreationTime100ns))
        throw new Error('Native window selection identity collision.');
      selected.set(id, target);
      result.push({ id, window });
    }
    this.windows = selected;
    return this.withAncestry(result);
  }

  /**
   * Windows captures an application's audio together with the processes it started, so the picker keeps
   * related applications, like a launcher and the game it opened, from both sharing audio (#253). Main
   * checks again before capturing; without this list the picker only compares the processes themselves.
   */
  private withAncestry(listed: ListedWindow[]): ListedWindow[] {
    if (!this.inspect.processAncestry || !listed.length) return listed;
    const chains = new Map<number, number[]>();
    try {
      const processIds = [...new Set(listed.map(({ window }) => window.processId))];
      for (let offset = 0; offset < processIds.length; offset += 256) {
        const chunk = processIds.slice(offset, offset + 256);
        this.inspect.processAncestry(chunk).forEach((chain, index) => { if (chain) chains.set(chunk[index], chain); });
      }
    } catch (error) {
      console.warn('[ScreenShare:Main] Could not read window process ancestry:', error);
      return listed;
    }
    return listed.map(entry => {
      const processAncestry = chains.get(entry.window.processId);
      return processAncestry ? { ...entry, processAncestry } : entry;
    });
  }

  /** Like windows, a monitor without an exact identity is reported on its own instead of hiding every screen. */
  listMonitors(onUnidentified: OnUnidentified = () => {}): { id: string; monitor: NativeMonitorInfo }[] {
    const selected = new Map<string, MonitorTarget>();
    const valid = this.inspect.monitors().flatMap(monitor => {
      try {
        return [{ monitor, target: monitorTarget(monitor) }];
      } catch {
        onUnidentified({ kind: 'monitor', reason: 'invalid-identity', monitor });
        return [];
      }
    });
    const ambiguous = repeated(valid, ({ target }) => target.deviceId);
    const result = valid.flatMap(({ monitor, target }) => {
      if (ambiguous.has(target.deviceId)) {
        onUnidentified({ kind: 'monitor', reason: 'ambiguous-identity', monitor });
        return [];
      }
      // Geometry is part of this selection: a mode/topology change invalidates
      // stored IDs rather than silently restoring capture on different pixels.
      const id = `native-monitor:${createHash('sha256').update(monitorIdentity(target)).digest('hex')}`;
      const previous = this.monitors.get(id);
      if (selected.has(id) || (previous && monitorIdentity(previous) !== monitorIdentity(target)))
        throw new Error('Native monitor selection identity collision.');
      selected.set(id, target);
      return [{ id, monitor }];
    });
    this.monitors = selected;
    return result;
  }

  resolve(sourceId: string, kind: NativeScreenCaptureKind): NativeScreenCaptureTarget {
    if (kind === 'monitor') {
      const selected = this.monitors.get(sourceId);
      const current = selected ? this.inspect.monitorState(selected.deviceId) : null;
      if (!selected || !current || monitorIdentity(monitorTarget(current)) !== monitorIdentity(selected))
        throw new Error('The selected monitor changed or disconnected. Select it again explicitly.');
      return { ...selected, bounds: { ...selected.bounds } };
    }
    const selected = this.windows.get(sourceId);
    const state = selected ? this.inspect.windowState(selected.hwnd) : null;
    if (!selected || this.inspect.isWindowExcluded?.(selected.hwnd) || !state?.isTopLevel || state.processId !== selected.expectedProcessId
      || state.processCreationTime100ns !== selected.expectedProcessCreationTime100ns)
      throw new Error('The selected screen-sharing window is unavailable or was replaced.');
    const target: WindowTarget = { ...selected, kind };
    validateCaptureTarget(target);
    return target;
  }
}
