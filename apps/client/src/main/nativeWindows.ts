import { createHash } from 'node:crypto';
import type { NativeMonitorInfo, NativeWindowInfo, NativeWindowState } from '@monky/screen-audio';
import { validateCaptureTarget, type NativeScreenCaptureTarget } from '@monky/screen-share';
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
};
type MonitorTarget = Extract<NativeScreenCaptureTarget, { kind: 'monitor' }>;
type WindowTarget = Extract<NativeScreenCaptureTarget, { hwnd: number }>;

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

export function nativeMonitorDesktopSources(
  monitors: readonly { id: string; monitor: NativeMonitorInfo }[],
): DesktopSource[] {
  return [...monitors].sort((a, b) => a.monitor.deviceName.localeCompare(b.monitor.deviceName, 'en', { numeric: true }))
    .map(({ id, monitor }, index) => ({
      id, name: monitor.name, displayNumber: index + 1, type: 'screen',
      thumbnailDataUrl: '', appIconDataUrl: null, thumbnailState: 'pending',
    }));
}

export class NativeDesktopSources {
  private windows = new Map<string, WindowTarget>();
  private monitors = new Map<string, MonitorTarget>();

  constructor(private readonly inspect: Inspection) {}

  listWindows(): { id: string; window: NativeWindowInfo }[] {
    // Refreshing another picker must not revoke a still-owned hidden/minimized
    // selection needed for source restoration.
    const selected = new Map([...this.windows].filter(([, target]) => {
      if (this.inspect.isWindowExcluded?.(target.hwnd)) return false;
      const state = this.inspect.windowState(target.hwnd);
      return state?.isTopLevel && state.processId === target.expectedProcessId
        && state.processCreationTime100ns === target.expectedProcessCreationTime100ns;
    }));
    const handles = new Set<number>();
    const result: { id: string; window: NativeWindowInfo }[] = [];
    for (const window of this.inspect.windows()) {
      if (this.inspect.isWindowExcluded?.(window.hwnd)) continue;
      if (isGhostWindow(window) || (!window.isVisible && !window.isIconic) || !window.processCreationTime100ns) continue;
      if (handles.has(window.hwnd)) throw new Error('Native window identity is ambiguous.');
      handles.add(window.hwnd);
      const target: WindowTarget = { kind: 'window', hwnd: window.hwnd, expectedProcessId: window.processId,
        expectedProcessCreationTime100ns: window.processCreationTime100ns };
      validateCaptureTarget(target);
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
    return result;
  }

  listMonitors(): { id: string; monitor: NativeMonitorInfo }[] {
    const selected = new Map<string, MonitorTarget>();
    const devices = new Set<string>();
    const result = this.inspect.monitors().map(monitor => {
      const target = monitorTarget(monitor);
      if (devices.has(target.deviceId)) throw new Error('Native monitor device identity is ambiguous.');
      devices.add(target.deviceId);
      // Geometry is part of this selection: a mode/topology change invalidates
      // stored IDs rather than silently restoring capture on different pixels.
      const id = `native-monitor:${createHash('sha256').update(monitorIdentity(target)).digest('hex')}`;
      const previous = this.monitors.get(id);
      if (selected.has(id) || (previous && monitorIdentity(previous) !== monitorIdentity(target)))
        throw new Error('Native monitor selection identity collision.');
      selected.set(id, target);
      return { id, monitor };
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
