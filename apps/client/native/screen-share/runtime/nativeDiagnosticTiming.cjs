'use strict';

const defaultNow = () => performance.now();

function timestamp(now) {
  const value = now();
  if (!Number.isFinite(value) || value < 0) throw new Error('Diagnostic timing requires a finite monotonic timestamp.');
  return value;
}

function elapsedMs(started, now = defaultNow) {
  const finished = timestamp(now);
  if (!Number.isFinite(started) || started < 0 || finished < started) {
    throw new Error('Diagnostic timing clock regressed or has an invalid origin.');
  }
  return finished - started;
}

function timedSync(operation, now = defaultNow) {
  const started = timestamp(now);
  const value = operation();
  return { value, wallMs: elapsedMs(started, now) };
}

function timedAsync(operation, now = defaultNow) {
  const started = timestamp(now);
  // Invoke immediately, preserving both parallel launch order and synchronous failures.
  return Promise.resolve(operation()).then(value => ({ value, wallMs: elapsedMs(started, now) }));
}

function createTimingSummary() {
  return { count: 0, totalMs: 0, maxMs: null, meanMs: null };
}

function recordTiming(summary, wallMs) {
  if (!Number.isFinite(wallMs) || wallMs < 0) throw new Error('Invalid diagnostic timing duration.');
  summary.count++;
  summary.totalMs += wallMs;
  summary.maxMs = summary.maxMs === null ? wallMs : Math.max(summary.maxMs, wallMs);
  summary.meanMs = summary.totalMs / summary.count;
}

module.exports = { elapsedMs, timedSync, timedAsync, createTimingSummary, recordTiming };
