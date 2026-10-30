/**
 * Startup milestones (#490) on the page's performance timeline, where the
 * preload marks the end of its own run too. One log entry, written once the
 * real UI has painted, tells which stage made a slow start slow: the page
 * itself, the preload, compiling the bundle, setting its modules up or the
 * work before the first render.
 *
 * main.ts imports this module before any other, so `bundle` marks when the
 * compiled bundle starts running.
 */

const PREFIX = 'monky:';

export type StartupStage = 'modules' | 'identity' | 'dm' | 'home' | 'painted';

performance.mark(`${PREFIX}bundle`);

export function markStartup(stage: StartupStage): void {
  performance.mark(`${PREFIX}${stage}`);
}

/** Milliseconds since the page started loading, per stage; a stage counts from its first mark. */
export function startupTimings(): Record<string, number> {
  const timings: Record<string, number> = {};
  const [navigation] = performance.getEntriesByType('navigation');
  if (navigation instanceof PerformanceNavigationTiming) timings.parsed = Math.round(navigation.domInteractive);
  for (const mark of performance.getEntriesByType('mark')) {
    if (!mark.name.startsWith(PREFIX)) continue;
    const stage = mark.name.slice(PREFIX.length);
    if (!(stage in timings)) timings[stage] = Math.round(mark.startTime);
  }
  return timings;
}
