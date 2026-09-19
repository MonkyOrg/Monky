'use strict';

const assert = require('node:assert/strict');
const {
  nativeScreenRtpReportSchema, nativeScreenRtpReportTypeSchema, nativeScreenDecoderObservationSchema,
} = require('@monky/shared');

function rtpReports(raw) {
  assert.ok(Array.isArray(raw) && raw.length <= 512, 'Native RTC diagnostics require a bounded stats array.');
  for (const row of raw) assert.ok(row && typeof row === 'object' && !Array.isArray(row)
    && typeof row.id === 'string' && typeof row.type === 'string' && Number.isFinite(row.timestamp),
  'Native RTC diagnostics contain an invalid stats record.');
  return raw.filter(row => nativeScreenRtpReportTypeSchema.safeParse(row?.type).success).map(row => {
    const report = nativeScreenRtpReportSchema.parse(row);
    // RTCStats::ToJson uses microseconds, whereas the browser API and shared sampler use milliseconds.
    return { ...report, timestamp: report.timestamp / 1000 };
  });
}

function decoderObservations(mf) {
  assert.ok(Array.isArray(mf?.decoders) && mf.decoders.length <= 64, 'Native decoder observations are unavailable.');
  return mf.decoders.map(worker => nativeScreenDecoderObservationSchema.parse({
    sessionId: worker.sessionId, completedCallbacks: worker.diagnostics?.output?.outcomes?.['callback-completed'],
    observedAtSteadyUs: worker.diagnostics?.observedAtSteadyUs, snapshotCopyMs: worker.diagnostics?.snapshotCopyMs,
    clock: worker.diagnostics?.clock, counterScope: worker.diagnostics?.counterScope,
  }));
}

module.exports = { rtpReports, decoderObservations };
