/**
 * Records slow events and long animation frames, at most one log line a minute.
 *
 * Each slow event is split into input delay, processing and presentation delay:
 * busy JavaScript shows up as delay/processing, while a long presentation delay
 * with little processing points at the compositor or the GPU instead.
 */

import { clientLog } from './ClientLogService';

/** The "needs improvement" bound for interaction latency. */
export const SLOW_EVENT_MS = 200;
export const LONG_FRAME_MS = 200;
export const REPORT_INTERVAL_MS = 60_000;

export interface EventTiming {
  name: string;
  startTime: number;
  duration: number;
  processingStart: number;
  processingEnd: number;
}

export interface FrameScript {
  duration: number;
  invokerType: string;
  sourceURL: string;
}

/** The subset of a `long-animation-frame` entry used here. */
export interface FrameTiming {
  startTime: number;
  duration: number;
  blockingDuration: number;
  renderStart: number;
  scripts: readonly FrameScript[];
}

interface SlowEvent {
  type: string;
  durationMs: number;
  inputDelayMs: number;
  processingMs: number;
  presentationDelayMs: number;
}

interface LongFrame {
  durationMs: number;
  blockingMs: number;
  renderMs: number;
  script: { invoker: string; file: string; durationMs: number } | null;
}

const round = (value: number): number => Math.max(0, Math.round(value));

/** Only the bundle file name: full script URLs can contain the user's profile path. */
export function scriptFile(url: string): string {
  const name = url.split(/[?#]/, 1)[0].split(/[/\\]/).pop() ?? '';
  return /^[\w.-]{1,80}$/.test(name) ? name : 'unknown';
}

export class ResponsivenessMonitor {
  private slowEvents = 0;
  private worstEvent: SlowEvent | null = null;
  private longFrames = 0;
  private worstFrame: LongFrame | null = null;

  constructor(private readonly report: (data: Record<string, unknown>) => void) {}

  recordEvent(entry: EventTiming): void {
    if (entry.duration < SLOW_EVENT_MS) return;
    this.slowEvents++;
    if (this.worstEvent && this.worstEvent.durationMs >= entry.duration) return;
    this.worstEvent = {
      type: entry.name,
      durationMs: round(entry.duration),
      inputDelayMs: round(entry.processingStart - entry.startTime),
      processingMs: round(entry.processingEnd - entry.processingStart),
      presentationDelayMs: round(entry.startTime + entry.duration - entry.processingEnd),
    };
  }

  recordFrame(entry: FrameTiming): void {
    if (entry.duration < LONG_FRAME_MS) return;
    this.longFrames++;
    if (this.worstFrame && this.worstFrame.durationMs >= entry.duration) return;
    let script: FrameScript | null = null;
    for (const candidate of entry.scripts) if (!script || candidate.duration > script.duration) script = candidate;
    this.worstFrame = {
      durationMs: round(entry.duration),
      blockingMs: round(entry.blockingDuration),
      renderMs: entry.renderStart > 0 ? round(entry.startTime + entry.duration - entry.renderStart) : 0,
      script: script
        ? { invoker: script.invokerType, file: scriptFile(script.sourceURL), durationMs: round(script.duration) }
        : null,
    };
  }

  flush(context: Record<string, unknown>): void {
    if (this.slowEvents === 0 && this.longFrames === 0) return;
    this.report({
      windowSeconds: REPORT_INTERVAL_MS / 1000,
      slowEvents: this.slowEvents,
      worstEvent: this.worstEvent,
      longFrames: this.longFrames,
      worstFrame: this.worstFrame,
      ...context,
    });
    this.slowEvents = 0;
    this.worstEvent = null;
    this.longFrames = 0;
    this.worstFrame = null;
  }
}

function isEventTiming(entry: PerformanceEntry): entry is PerformanceEventTiming {
  return entry.entryType === 'event' && 'processingStart' in entry && 'processingEnd' in entry;
}

function isLongFrame(entry: PerformanceEntry): entry is PerformanceEntry & FrameTiming {
  return entry.entryType === 'long-animation-frame' && 'blockingDuration' in entry
    && 'renderStart' in entry && 'scripts' in entry && Array.isArray(entry.scripts);
}

/** Starts observing the current document; the returned function stops it. */
export function startResponsivenessMonitor(): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  const supported = PerformanceObserver.supportedEntryTypes;
  const monitor = new ResponsivenessMonitor(data => clientLog.warn('UI', 'Slow rendering detected', data));
  const observers: PerformanceObserver[] = [];
  if (supported.includes('event')) {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (isEventTiming(entry)) monitor.recordEvent(entry);
    });
    observer.observe({ type: 'event' });
    observers.push(observer);
  }
  if (supported.includes('long-animation-frame')) {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (isLongFrame(entry)) monitor.recordFrame(entry);
    });
    observer.observe({ type: 'long-animation-frame' });
    observers.push(observer);
  }
  if (observers.length === 0) return () => {};
  const flush = (): void => monitor.flush({ visibility: document.visibilityState, focused: document.hasFocus() });
  const timer = window.setInterval(flush, REPORT_INTERVAL_MS);
  return () => {
    window.clearInterval(timer);
    for (const observer of observers) observer.disconnect();
    flush();
  };
}
