/**
 * Main-process performance diagnostics.
 *
 * A "Monky got slow" report needs context the renderer cannot see: which
 * process burns CPU, and what changed around it (displays, sleep, minimizing,
 * a GPU process crash). Only transitions and bounded summaries are logged.
 */

import { app, powerMonitor, screen, type BrowserWindow, type Display, type GPUFeatureStatus } from 'electron';
import type { ClientLogEntry, LogLevel } from '@monky/shared';

export const SAMPLE_INTERVAL_MS = 30_000;
export const GPU_FALLBACK_MS = 15_000;
/** One summary every 10 minutes keeps a baseline to compare a slow period against. */
export const SUMMARY_EVERY_SAMPLES = 20;
/** Percent of one core; the compositor stall pinned the renderer above 90 %. */
export const HOT_RENDERER_CPU = 70;
export const HOT_SAMPLES_TO_WARN = 4;
export const COOL_SAMPLES_TO_RECOVER = 2;

type LogSink = { write(entry: ClientLogEntry): void };

export interface DisplaySnapshot {
  id: number;
  size: { width: number; height: number };
  scaleFactor: number;
  displayFrequency: number;
}

/** The subset of Electron's ProcessMetric used here (memory in kilobytes). */
export interface ProcessSample {
  pid: number;
  type: string;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number; privateBytes?: number };
}

export interface ProcessGone {
  type: string;
  reason: string;
  exitCode: number;
  name?: string;
  serviceName?: string;
}

export interface WindowState {
  visible: boolean;
  minimized: boolean;
  focused: boolean;
}

export type GpuStatus = Pick<GPUFeatureStatus, 'gpu_compositing' | 'rasterization' | 'video_decode' | 'video_encode'>;

export interface GpuDevice {
  vendorId: number;
  deviceId: number;
  driverVersion?: string;
}
export type WindowEvent = 'minimize' | 'restore' | 'hide' | 'show' | 'unresponsive' | 'responsive';
export type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

interface Usage { cpu: number; memoryMb: number; processes: number }
interface GroupTotals extends Usage { maxCpu: number }

const round = (value: number): number => Math.round(value * 10) / 10;

function displays(list: readonly DisplaySnapshot[]): Record<string, number>[] {
  return list.map(display => ({
    id: display.id,
    width: display.size.width,
    height: display.size.height,
    scale: display.scaleFactor,
    hz: round(display.displayFrequency),
  }));
}

function memoryMb(sample: ProcessSample): number {
  return Math.round((sample.memory.privateBytes ?? sample.memory.workingSetSize) / 1024);
}

/** Reads the adapters from `app.getGPUInfo('basic')`, whose result Electron leaves untyped. */
export function gpuDevices(info: unknown): GpuDevice[] {
  if (!info || typeof info !== 'object' || !('gpuDevice' in info) || !Array.isArray(info.gpuDevice)) return [];
  const list: unknown[] = info.gpuDevice;
  const devices: GpuDevice[] = [];
  for (const device of list.slice(0, 4)) {
    if (!device || typeof device !== 'object') continue;
    if (!('vendorId' in device) || typeof device.vendorId !== 'number') continue;
    if (!('deviceId' in device) || typeof device.deviceId !== 'number') continue;
    const driverVersion = 'driverVersion' in device && typeof device.driverVersion === 'string'
      ? device.driverVersion.slice(0, 40) : undefined;
    devices.push({
      vendorId: device.vendorId,
      deviceId: device.deviceId,
      ...(driverVersion ? { driverVersion } : {}),
    });
  }
  return devices;
}

export class PerformanceDiagnostics {
  private samples = 0;
  private totals = new Map<string, GroupTotals>();
  private hotSamples = 0;
  private coolSamples = 0;
  private hotSince: number | null = null;
  private hotPeak = 0;
  private gpuKey: string | null = null;

  constructor(private readonly sink: LogSink, private readonly now: () => number = Date.now) {}

  private log(level: LogLevel, message: string, data: Record<string, unknown>): void {
    this.sink.write({ timestamp: new Date(this.now()).toISOString(), level, category: 'APP', message, data });
  }

  startup(list: readonly DisplaySnapshot[]): void {
    this.log('INFO', 'Performance diagnostics started', { displays: displays(list) });
  }

  /**
   * Logged when the features or adapters change, e.g. a fallback to software
   * compositing after GPU process crashes.
   */
  gpu(status: GpuStatus, devices: readonly GpuDevice[]): void {
    const data = {
      compositing: status.gpu_compositing,
      rasterization: status.rasterization,
      videoDecode: status.video_decode,
      videoEncode: status.video_encode,
      devices: [...devices],
    };
    const key = JSON.stringify(data);
    if (key === this.gpuKey) return;
    this.gpuKey = key;
    // Without GPU compositing every frame is drawn by the CPU.
    this.log(status.gpu_compositing === 'enabled' ? 'INFO' : 'WARN', 'GPU feature status', data);
  }

  displayChanged(change: 'added' | 'removed' | 'changed', display: DisplaySnapshot,
    list: readonly DisplaySnapshot[], metrics: readonly string[] = []): void {
    // Work-area-only changes follow taskbar moves and carry no rendering signal.
    if (change === 'changed' && metrics.length === 1 && metrics[0] === 'workArea') return;
    this.log('INFO', `Display ${change}`, {
      display: displays([display])[0],
      ...(change === 'changed' ? { metrics: [...metrics] } : {}),
      displays: displays(list),
    });
  }

  power(event: PowerEvent): void {
    this.log('INFO', 'Power state changed', { event });
  }

  window(event: WindowEvent, state: WindowState): void {
    this.log(event === 'unresponsive' ? 'WARN' : 'INFO', 'Main window state changed', { event, ...state });
  }

  processGone(details: ProcessGone): void {
    // Native share hosts exit cleanly all the time; a clean GPU exit is still unusual.
    if (details.reason === 'clean-exit' && details.type !== 'GPU') return;
    this.log(details.reason === 'clean-exit' ? 'INFO' : 'ERROR', 'Child process gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      ...(details.name ? { name: details.name } : {}),
      ...(details.serviceName ? { service: details.serviceName } : {}),
    });
  }

  sample(metrics: readonly ProcessSample[], rendererPid: number, state: WindowState): void {
    const groups = new Map<string, Usage>();
    for (const metric of metrics) {
      const group = metric.pid === rendererPid ? 'renderer'
        : metric.type === 'GPU' ? 'gpu'
          : metric.type === 'Browser' ? 'browser'
            : metric.type === 'Utility' ? 'utility' : 'other';
      const usage = groups.get(group) ?? { cpu: 0, memoryMb: 0, processes: 0 };
      usage.cpu += metric.cpu.percentCPUUsage;
      usage.memoryMb += memoryMb(metric);
      usage.processes++;
      groups.set(group, usage);
    }
    for (const [group, usage] of groups) {
      const totals = this.totals.get(group) ?? { cpu: 0, maxCpu: 0, memoryMb: 0, processes: 0 };
      totals.cpu += usage.cpu;
      totals.maxCpu = Math.max(totals.maxCpu, usage.cpu);
      totals.memoryMb = usage.memoryMb;
      totals.processes = usage.processes;
      this.totals.set(group, totals);
    }
    this.trackRenderer(groups.get('renderer')?.cpu ?? 0, groups, state);
    if (++this.samples >= SUMMARY_EVERY_SAMPLES) this.summarize(state);
  }

  private usage(groups: Map<string, Usage>): Record<string, Record<string, number>> {
    const result: Record<string, Record<string, number>> = {};
    for (const [group, usage] of groups) result[group] = { cpu: round(usage.cpu), memoryMb: usage.memoryMb };
    return result;
  }

  private trackRenderer(cpu: number, groups: Map<string, Usage>, state: WindowState): void {
    if (cpu >= HOT_RENDERER_CPU) {
      this.coolSamples = 0;
      this.hotPeak = Math.max(this.hotPeak, cpu);
      if (++this.hotSamples === HOT_SAMPLES_TO_WARN) {
        this.hotSince = this.now() - (HOT_SAMPLES_TO_WARN - 1) * SAMPLE_INTERVAL_MS;
        this.log('WARN', 'Sustained renderer CPU', {
          sampleSeconds: SAMPLE_INTERVAL_MS / 1000, usage: this.usage(groups), ...state,
        });
      }
      return;
    }
    if (this.hotSince !== null && ++this.coolSamples >= COOL_SAMPLES_TO_RECOVER) {
      this.log('INFO', 'Renderer CPU recovered', {
        hotSeconds: Math.round((this.now() - this.hotSince) / 1000), peakCpu: round(this.hotPeak),
        usage: this.usage(groups), ...state,
      });
      this.hotSince = null;
    }
    if (this.hotSince === null) {
      this.hotSamples = 0;
      this.hotPeak = 0;
    }
  }

  private summarize(state: WindowState): void {
    const usage: Record<string, Record<string, number>> = {};
    for (const [group, totals] of this.totals) {
      usage[group] = { avgCpu: round(totals.cpu / this.samples), maxCpu: round(totals.maxCpu),
        memoryMb: totals.memoryMb, processes: totals.processes };
    }
    this.log('INFO', 'Process usage summary', {
      windowSeconds: (this.samples * SAMPLE_INTERVAL_MS) / 1000, usage, ...state,
    });
    this.samples = 0;
    this.totals = new Map();
  }
}

/** Binds the diagnostics to the main window; everything is released when it closes. */
export function bindPerformanceDiagnostics(window: BrowserWindow, sink: LogSink): () => void {
  const diagnostics = new PerformanceDiagnostics(sink);
  const state = (): WindowState => ({
    visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(),
  });
  const allDisplays = (): Display[] => screen.getAllDisplays();
  diagnostics.startup(allDisplays());
  // Feature status and the active adapter are only final once the GPU process
  // reported them (`gpu-info-update`); the timer covers an update sent before binding.
  let disposed = false;
  const reportGpu = (): void => {
    void app.getGPUInfo('basic').then(info => {
      if (!disposed) diagnostics.gpu(app.getGPUFeatureStatus(), gpuDevices(info));
    }, () => {});
  };
  app.on('gpu-info-update', reportGpu);
  const gpuFallback = setTimeout(reportGpu, GPU_FALLBACK_MS);

  const onDisplayAdded = (_event: Electron.Event, display: Display): void =>
    diagnostics.displayChanged('added', display, allDisplays());
  const onDisplayRemoved = (_event: Electron.Event, display: Display): void =>
    diagnostics.displayChanged('removed', display, allDisplays());
  const onDisplayChanged = (_event: Electron.Event, display: Display, metrics: string[]): void =>
    diagnostics.displayChanged('changed', display, allDisplays(), metrics);
  screen.on('display-added', onDisplayAdded);
  screen.on('display-removed', onDisplayRemoved);
  screen.on('display-metrics-changed', onDisplayChanged);

  const powerEvents: PowerEvent[] = ['suspend', 'resume', 'lock-screen', 'unlock-screen'];
  const powerEmitter: NodeJS.EventEmitter = powerMonitor;
  const powerListeners = powerEvents.map(event => {
    const listener = (): void => diagnostics.power(event);
    powerEmitter.on(event, listener);
    return { event, listener };
  });

  const windowEvents: WindowEvent[] = ['minimize', 'restore', 'hide', 'show', 'unresponsive', 'responsive'];
  const windowEmitter: NodeJS.EventEmitter = window;
  const windowListeners = windowEvents.map(event => {
    const listener = (): void => diagnostics.window(event, state());
    windowEmitter.on(event, listener);
    return { event, listener };
  });

  const onProcessGone = (_event: Electron.Event, details: Electron.Details): void => diagnostics.processGone(details);
  app.on('child-process-gone', onProcessGone);

  const timer = setInterval(() => {
    if (window.isDestroyed()) return;
    diagnostics.sample(app.getAppMetrics(), window.webContents.getOSProcessId(), state());
  }, SAMPLE_INTERVAL_MS);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    clearTimeout(gpuFallback);
    app.removeListener('gpu-info-update', reportGpu);
    screen.removeListener('display-added', onDisplayAdded);
    screen.removeListener('display-removed', onDisplayRemoved);
    screen.removeListener('display-metrics-changed', onDisplayChanged);
    for (const { event, listener } of powerListeners) powerEmitter.removeListener(event, listener);
    for (const { event, listener } of windowListeners) windowEmitter.removeListener(event, listener);
    app.removeListener('child-process-gone', onProcessGone);
  };
  window.once('closed', dispose);
  return dispose;
}
