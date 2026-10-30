import { isDeepStrictEqual } from 'node:util';
import type { BrowserOcclusionEngine } from '@monky/shared';
import type { NativeScreenCaptureTarget } from '@monky/screen-share';
import * as screenAudio from '@monky/screen-audio';
import { browserOcclusionEngine } from '../browserOcclusion';
import type { DiagnosticData, NativeScreenDiagnostics } from './diagnosticLog';

/** Browser engine of a captured Windows window, whose capture freezes while other windows fully cover it. */
export function capturedBrowserEngine(target: { hwnd: number; expectedProcessId: number }): BrowserOcclusionEngine | null {
  if (typeof screenAudio.listWindows !== 'function' || typeof screenAudio.getWindowOcclusion !== 'function') return null;
  try {
    const window = screenAudio.listWindows().find(entry =>
      entry.hwnd === target.hwnd && entry.processId === target.expectedProcessId);
    return browserOcclusionEngine(window?.processPath);
  } catch (error) {
    console.warn('[NativeScreen] Could not identify the captured window browser:', error);
    return null;
  }
}

const sourceLost = (message: string): Error => Object.assign(new Error(message), { code: 'ERR_SCREEN_CAPTURE_SOURCE_LOST' });

/** Where a captured browser window's warnings go: the log, under its source, and the renderer. */
export interface OcclusionReport {
  readonly engine: BrowserOcclusionEngine;
  readonly diagnostics: NativeScreenDiagnostics;
  readonly context: DiagnosticData;
  changed(occluded: boolean): void;
}

/**
 * Whether a captured browser window froze behind other windows. "Covered" must persist across two samples so
 * window animations stay silent, and some browsers keep painting a covered window: only a window whose content
 * also stopped updating for two samples is frozen. Without the frame probe (old Windows or addon), coverage
 * alone keeps warning as before.
 */
class OcclusionTracker {
  private checks = 0;
  private coveredSamples = 0;
  private occluded = false;
  private tracked = true;
  // Counts the window's own content frames while it is covered; null until the first running sample.
  private frameProbe: { id: number; frames: number | null; stalledSamples: number } | null = null;
  private frameProbeUnavailable = false;

  constructor(private readonly hwnd: number, private readonly report: OcclusionReport) {}

  /** Samples the window on every fourth check: once a second on Windows. */
  check(paused: boolean): void {
    if (!this.tracked || ++this.checks % 4 !== 0) return;
    let covered: boolean;
    try {
      covered = !paused && screenAudio.getWindowOcclusion(this.hwnd) === true;
    } catch (error) {
      this.tracked = false;
      this.stopFrameProbe();
      this.report.diagnostics.logFailure('source-occlusion', error, undefined, this.report.context);
      return;
    }
    this.coveredSamples = covered ? this.coveredSamples + 1 : 0;
    if (!covered) this.stopFrameProbe();
    const next = covered && this.contentStalled() && this.coveredSamples >= 2;
    if (next === this.occluded) return;
    this.occluded = next;
    this.report.diagnostics.log('source-occlusion', { ...this.report.context, occluded: next, engine: this.report.engine,
      contentFrames: this.frameProbeUnavailable ? null : this.frameProbe?.frames ?? null }, next ? 'WARN' : 'INFO');
    this.report.changed(next);
  }

  stopFrameProbe(): void {
    if (!this.frameProbe) return;
    const { id, frames, stalledSamples } = this.frameProbe;
    this.frameProbe = null;
    try { screenAudio.stopWindowFrameProbe(id); }
    catch (error) { this.report.diagnostics.logFailure('source-frame-probe', error, undefined, this.report.context); }
    this.report.diagnostics.log('source-frame-probe', { ...this.report.context, frames, stalledSamples, warned: this.occluded });
  }

  private frameProbeFailed(error: unknown): void {
    this.frameProbeUnavailable = true;
    this.stopFrameProbe();
    this.report.diagnostics.logFailure('source-frame-probe', error, undefined, this.report.context);
  }

  private contentStalled(): boolean {
    if (this.frameProbeUnavailable) return true;
    try {
      if (!this.frameProbe) {
        const id = typeof screenAudio.startWindowFrameProbe === 'function'
          ? screenAudio.startWindowFrameProbe(this.hwnd) : null;
        if (id === null) {
          this.frameProbeUnavailable = true;
          this.report.diagnostics.log('source-frame-probe-unavailable', this.report.context, 'WARN');
          return true;
        }
        this.frameProbe = { id, frames: null, stalledSamples: 0 };
        return false;
      }
      const snapshot = screenAudio.getWindowFrameProbe(this.frameProbe.id);
      if (!snapshot || snapshot.state === 'failed' || snapshot.state === 'closed') {
        this.frameProbeFailed(new Error(snapshot?.error ?? `Window frame probe ${snapshot?.state ?? 'disappeared'}.`));
        return true;
      }
      if (snapshot.state !== 'running') return false;
      this.frameProbe.stalledSamples = this.frameProbe.frames !== null && snapshot.frames === this.frameProbe.frames
        ? this.frameProbe.stalledSamples + 1 : 0;
      this.frameProbe.frames = snapshot.frames;
      return this.frameProbe.stalledSamples >= 2;
    } catch (error) {
      this.frameProbeFailed(error);
      return true;
    }
  }
}

/** What the periodic checks report to the source's owner. */
export interface CapturedSourceChecks {
  /** False once the source's call stops or another source replaced it: its checks then stay silent. */
  isCurrent(): boolean;
  /** The source as it resolves now; macOS compares it with the selected one on every check. */
  resolve(): NativeScreenCaptureTarget | Promise<NativeScreenCaptureTarget>;
  /** Paused (minimized or invisible) or resumed since the previous check. */
  pausedChanged(paused: boolean): void;
  /** Hidden for two checks in a row, or shown again. */
  hiddenChanged(hidden: boolean): void;
  /** Every check that found the source current. */
  checked(): void;
  /** The source closed or changed: its checks stopped and every later `assertCurrent()` throws `error`. */
  lost(error: unknown): void;
  /** A check failed unexpectedly. */
  failed(error: unknown): void;
}

/**
 * The source a screen share captures, as Main observes it: still the window or monitor the user selected
 * (same process, same bounds), paused while minimized or invisible, and, once started, checked four times a
 * second on Windows and once a second on macOS.
 */
export class CapturedSourceMonitor {
  private isPaused = false;
  private failure: unknown;
  private checkedDisplayGeneration: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private occlusion: OcclusionTracker | null = null;
  private checking = false;
  private observedPaused = false;
  private reportedHidden = false;
  private hiddenChecks = 0;

  constructor(private readonly target: NativeScreenCaptureTarget, private readonly displayGeneration: () => number,
    private readonly onPause: (paused: boolean) => void) {}

  get paused(): boolean {
    return this.isPaused;
  }

  /** Throws if the source closed, changed or was lost; otherwise refreshes `paused`. */
  assertCurrent(): void {
    if (this.failure) throw this.failure;
    const target = this.target;
    if (target.platform === 'darwin') return; // The helper verifies ownership again before each captured frame.
    if (target.kind === 'monitor') {
      // A monitor identity read can wait behind another program's registry writes while holding the system
      // display lock, freezing every screen, so it runs only after Windows reported a display change.
      if (this.checkedDisplayGeneration === this.displayGeneration()) return;
      const generation = this.displayGeneration();
      const current = screenAudio.getMonitorState(target.deviceId);
      if (!current || current.deviceId !== target.deviceId || current.deviceName !== target.deviceName
        || !isDeepStrictEqual(current.bounds, target.bounds))
        throw sourceLost('The selected monitor disconnected or changed its bounds. Select it again explicitly.');
      this.checkedDisplayGeneration = generation;
      return;
    }
    const state = screenAudio.getWindowState(target.hwnd);
    if (!state?.isTopLevel || state.processId !== target.expectedProcessId
      || state.processCreationTime100ns !== target.expectedProcessCreationTime100ns)
      throw sourceLost('The selected screen-sharing window was closed or replaced.');
    const nextPaused = state.isIconic || !state.isVisible;
    if (this.isPaused !== nextPaused) this.onPause(nextPaused);
    this.isPaused = nextPaused;
  }

  /** Starts the periodic checks; `occlusion` also watches a captured browser window for frozen content. */
  start(checks: CapturedSourceChecks, occlusion: OcclusionReport | null): void {
    const target = this.target;
    if (occlusion && target.platform !== 'darwin' && target.kind !== 'monitor')
      this.occlusion = new OcclusionTracker(target.hwnd, occlusion);
    this.observedPaused = this.isPaused;
    this.timer = setInterval(() => {
      void this.check(checks).catch(error => checks.failed(error));
    }, target.platform === 'darwin' ? 1000 : 250);
    this.timer.unref();
  }

  /** Stops the checks and the window's frame probe. */
  stop(): void {
    this.stopChecks();
    this.occlusion?.stopFrameProbe();
  }

  private stopChecks(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async check(checks: CapturedSourceChecks): Promise<void> {
    if (this.checking || !checks.isCurrent()) return;
    this.checking = true;
    try {
      if (this.target.platform === 'darwin') {
        const current = await checks.resolve();
        if (!isDeepStrictEqual(current, this.target)) throw sourceLost('The selected macOS source changed identity.');
      }
      if (!checks.isCurrent()) return;
      this.assertCurrent();
      if (this.observedPaused !== this.isPaused) {
        this.observedPaused = this.isPaused;
        checks.pausedChanged(this.isPaused);
      }
      // Apps often hide a window right before destroying it; only a hidden state that outlives one check is reported.
      this.hiddenChecks = this.isPaused ? this.hiddenChecks + 1 : 0;
      const hidden = this.hiddenChecks >= 2;
      if (this.reportedHidden !== hidden) {
        this.reportedHidden = hidden;
        checks.hiddenChanged(hidden);
      }
      this.occlusion?.check(this.isPaused);
      checks.checked();
    } catch (error) {
      if (!checks.isCurrent()) return;
      this.failure = error;
      this.stopChecks();
      checks.lost(error);
    } finally { this.checking = false; }
  }
}
