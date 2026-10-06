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

function decoderFailureObservations(snapshot) {
  assert.ok(snapshot && typeof snapshot === 'object', 'Native receiver snapshot is unavailable.');
  const rows = [];
  const numbers = (row, value, names) => {
    for (const name of names) row[name] = Number.isSafeInteger(value?.[name]) ? value[name] : null;
    return row;
  };
  const engine = numbers({ kind: 'engine',
    state: ['starting', 'ready', 'closing', 'closed'].includes(snapshot.state) ? snapshot.state : null,
    snapshotScope: 'cached-control-observation',
  }, snapshot, ['pendingOperations', 'activeReceiverRoutes', 'decodedFrames', 'droppedFrames', 'rejectedEvents']);
  rows.push(engine);
  const decoders = snapshot.mf?.decoders;
  engine.decoderCount = Array.isArray(decoders) ? decoders.length : null;
  engine.truncated = Array.isArray(decoders) && decoders.length > 4;
  for (const decoder of Array.isArray(decoders) ? decoders.slice(0, 4) : []) {
    const sessionId = Number.isSafeInteger(decoder?.sessionId) ? decoder.sessionId : null;
    const operations = decoder?.diagnostics?.operations;
    const nativeOperations = ['mft-process-input', 'mft-process-output', 'gpu-output-copy', 'gpu-device-check',
      'gpu-texture-create', 'gpu-copy-submit', 'gpu-fence-signal', 'gpu-context-flush',
      'gpu-fence-poll', 'gpu-fence-arm', 'mf-sample-return', 'mft-end-streaming',
      'mft-shutdown', 'mf-platform-shutdown'].filter(name => {
      const value = operations?.[name];
      return Number.isSafeInteger(value?.calls) && value.calls > 0
        || Number.isSafeInteger(value?.inProgress) && value.inProgress > 0;
    });
    const inProgress = name => Number.isSafeInteger(operations[name]?.inProgress) && operations[name].inProgress > 0;
    const started = name => Number.isSafeInteger(operations[name]?.lastStartSteadyUs) ? operations[name].lastStartSteadyUs : 0;
    nativeOperations.sort((a, b) => Number(inProgress(b)) - Number(inProgress(a)) || started(b) - started(a));
    const worker = numbers({ kind: 'decoder-worker', sessionId }, decoder?.worker,
      ['observedAtRtcUs', 'observationSequence', 'status', 'pendingFrames', 'submittedMetadata',
        'retainedLeases', 'retiredCoreSessions', 'lossEpoch']);
    for (const name of ['recoveryRequested', 'recoveryInProgress', 'needsKeyframe', 'flushing', 'switching', 'stopping'])
      worker[name] = typeof decoder?.worker?.[name] === 'boolean' ? decoder.worker[name] : null;
    rows.push(worker);
    const core = numbers({ kind: 'decoder-core', sessionId }, decoder?.core,
      ['observedAtRtcUs', 'submitted', 'outputSamples', 'gpuFrames', 'pendingPackets', 'pendingGpuCopies', 'awaitingOutput']);
    numbers(core, decoder?.core?.adapter, ['vendorId', 'deviceId']);
    core.nativeObservedAtSteadyUs = Number.isSafeInteger(decoder?.diagnostics?.observedAtSteadyUs)
      ? decoder.diagnostics.observedAtSteadyUs : null;
    core.nativeOperationCount = nativeOperations.length;
    core.nativeOperationsTruncated = nativeOperations.length > 4;
    rows.push(core);
    for (const operation of ['core-create', 'core-enqueue', 'core-pump', 'core-flush',
      'core-stop', 'core-abort', 'core-stats-copy', 'cache-publish', 'callback', ...nativeOperations.slice(0, 4)]) {
      const value = operations?.[operation];
      if (!value) continue;
      rows.push(numbers({ kind: 'decoder-operation', sessionId, operation }, value,
        ['calls', 'inProgress', 'returned', 'exceptions', 'lastStartSteadyUs', 'lastCompletionSteadyUs']));
    }
  }
  return rows;
}

module.exports = { rtpReports, decoderObservations, decoderFailureObservations };
