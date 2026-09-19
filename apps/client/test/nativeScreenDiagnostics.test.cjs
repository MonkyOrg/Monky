'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { rtpReports, decoderObservations } = require('../native/screen-share/runtime/nativeVideoDiagnostics.cjs');

function load(name) {
  const filename = path.resolve(__dirname, '..', 'src', 'renderer', 'core', 'webrtc', `${name}.ts`);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInThisContext(`(function(exports) { ${compiled}\n})`, { filename })(exports);
  return exports;
}
const { VideoDiagnosticsSampler } = load('videoDiagnostics');
const { NativeDecoderDiagnosticsSampler } = load('nativeDecoderDiagnostics');
const rtc = (timestamp, framesEncoded, bytesSent) => [
  { id: 'codec', type: 'codec', timestamp, mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=4d0033' },
  { id: 'video', type: 'outbound-rtp', kind: 'video', timestamp, framesEncoded, framesSent: framesEncoded,
    bytesSent, codecId: 'codec', frameWidth: 1920, frameHeight: 1080 },
];
const observation = (sessionId, completedCallbacks, observedAtSteadyUs) => ({
  sessionId, completedCallbacks, observedAtSteadyUs, snapshotCopyMs: 0.05,
  clock: 'process-steady-clock', counterScope: 'decoder-worker-lifetime',
});
const reportMap = rows => new Map(rows.map(row => [row.id, row]));

test('native RTC microseconds are normalized once and measured rates never come from the requested profile', () => {
  const sampler = new VideoDiagnosticsSampler(), target = {};
  const limits = { encodings: [{ maxBitrate: 2000000, maxFramerate: 30 }] };
  const first = rtpReports(rtc(1000000, 100, 1000));
  assert.equal(first[0].timestamp, 1000);
  const baseline = sampler.sampleOutbound(target, reportMap(first), limits, 'actual-source')[0];
  assert.equal(baseline.fps, null);
  assert.equal(baseline.bitrateKbps, null);
  const measured = sampler.sampleOutbound(target, reportMap(rtpReports(rtc(2000000, 220, 201000))), limits, 'actual-source')[0];
  assert.equal(measured.intervalMs, 1000);
  assert.equal(measured.fps, 120);
  assert.equal(measured.sentFps, 120);
  assert.equal(measured.bitrateKbps, 1600);
  assert.equal(measured.maxFramerate, 30);
  assert.equal(measured.maxBitrateKbps, 2000);
  assert.equal(measured.width, 1920);
  assert.equal(measured.codec, 'H264');
});

test('native stats preserve unavailable fields and reject malformed counts without exposing network addresses', () => {
  const rows = rtpReports([
    ...rtc(1000000, 1, 10),
    { id: 'private-candidate', type: 'local-candidate', address: '192.0.2.10', timestamp: 1000000 },
    { id: 'pair', type: 'candidate-pair', timestamp: 1000000, currentRoundTripTime: 0.015,
      address: '192.0.2.11', credential: 'not-a-real-secret' },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(Object.hasOwn(rows[1], 'encoderImplementation'), false);
  assert.equal(JSON.stringify(rows).includes('192.0.2.'), false);
  assert.equal(JSON.stringify(rows).includes('credential'), false);
  assert.throws(() => rtpReports(rtc(1000000, -1, 10)));
  assert.throws(() => rtpReports([null]), /invalid stats record/);
  assert.throws(() => rtpReports({ guessedFrameRate: 120 }), /bounded stats array/);
});

test('native decoder observations keep each worker clock and lifetime counter rather than getter time', () => {
  const workers = decoderObservations({ decoders: [{
    sessionId: 7, diagnostics: { clock: 'process-steady-clock', counterScope: 'decoder-worker-lifetime',
      observedAtSteadyUs: 1000000, snapshotCopyMs: 0.05, output: { outcomes: { 'callback-completed': 100 } },
      javascriptGetterAtMs: 9000000 },
  }] });
  assert.deepEqual(workers, [observation(7, 100, 1000000)]);
  const sampler = new NativeDecoderDiagnosticsSampler(), target = {};
  assert.equal(sampler.sample(target, workers).fps, null);
  const result = sampler.sample(target, [observation(7, 220, 2000000)]);
  assert.ok(result.fps > 119.98 && result.fps < 120);
  assert.ok(result.upperBoundFps > 120 && result.upperBoundFps < 120.02);
  const cached = sampler.sample(target, [observation(7, 220, 2000000)]);
  assert.equal(cached.fps, null);
  assert.equal(cached.reason, 'cached-observation');
  assert.throws(() => sampler.sample(target, [observation(7, 221, 2000000)]), /inconsistent/);
  assert.equal(sampler.sample(target, [observation(7, 340, 3000000)]).fps, null);
});

test('native decoder replacement, transition and retirement cannot reuse a previous worker baseline', () => {
  const sampler = new NativeDecoderDiagnosticsSampler(), target = {}, other = {};
  sampler.sample(target, [observation(1, 100, 1000000)]);
  assert.equal(sampler.sample(other, [observation(1, 220, 2000000)]).fps, null);
  assert.equal(sampler.sample(target, [observation(2, 5, 2000000)]).reason, 'first-observation');
  assert.equal(sampler.sample(target, [observation(2, 125, 3000000), observation(3, 1, 3000000)]).reason, 'transition');
  assert.equal(sampler.sample(target, [observation(2, 245, 4000000)]).fps, null);
  sampler.retainTargets(new Set());
  assert.equal(sampler.sample(target, [observation(2, 365, 5000000)]).fps, null);
  assert.equal(sampler.sample(target, []).reason, 'unavailable');
});
