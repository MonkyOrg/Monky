import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClientLogEntry } from '@monky/shared';
import {
  COOL_SAMPLES_TO_RECOVER,
  HOT_RENDERER_CPU,
  HOT_SAMPLES_TO_WARN,
  PerformanceDiagnostics,
  SAMPLE_INTERVAL_MS,
  SUMMARY_EVERY_SAMPLES,
  gpuDevices,
  type DisplaySnapshot,
  type GpuStatus,
  type ProcessSample,
} from '../src/main/performanceDiagnostics';

const RENDERER_PID = 200;
const visible = { visible: true, minimized: false, focused: true };

function fixture() {
  const entries: ClientLogEntry[] = [];
  let now = Date.parse('2026-10-12T18:00:00.000Z');
  const diagnostics = new PerformanceDiagnostics({ write: entry => entries.push(entry) }, () => now);
  return { entries, diagnostics, advance: (ms: number) => { now += ms; } };
}

function display(id: number, hz: number): DisplaySnapshot {
  return { id, size: { width: 2560, height: 1440 }, scaleFactor: 1.25, displayFrequency: hz };
}

function metrics(rendererCpu: number, gpuCpu = 5): ProcessSample[] {
  return [
    { pid: 100, type: 'Browser', cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 90_000, privateBytes: 102_400 } },
    { pid: RENDERER_PID, type: 'Tab', cpu: { percentCPUUsage: rendererCpu }, memory: { workingSetSize: 300_000, privateBytes: 409_600 } },
    { pid: 300, type: 'GPU', cpu: { percentCPUUsage: gpuCpu }, memory: { workingSetSize: 150_000 } },
    { pid: 400, type: 'Tab', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 50_000, privateBytes: 51_200 } },
    { pid: 500, type: 'Utility', cpu: { percentCPUUsage: 3 }, memory: { workingSetSize: 20_000, privateBytes: 20_480 } },
  ];
}

test('startup records each display with its refresh rate', () => {
  const { entries, diagnostics } = fixture();
  diagnostics.startup([display(1, 239.757), display(2, 165)]);
  assert.deepEqual(entries.map(entry => [entry.level, entry.category, entry.message]),
    [['INFO', 'APP', 'Performance diagnostics started']]);
  assert.deepEqual(entries[0].data, {
    displays: [
      { id: 1, width: 2560, height: 1440, scale: 1.25, hz: 239.8 },
      { id: 2, width: 2560, height: 1440, scale: 1.25, hz: 165 },
    ],
  });
});

test('GPU status is logged when its features or adapters change', () => {
  const { entries, diagnostics } = fixture();
  const hardware: GpuStatus = {
    gpu_compositing: 'enabled', rasterization: 'enabled', video_decode: 'enabled', video_encode: 'enabled',
  };
  const devices = gpuDevices({ gpuDevice: [
    { active: true, vendorId: 4098, deviceId: 30032, driverVersion: '32.0.21025.1024' }, { vendorId: 'x' }, null,
  ] });
  diagnostics.gpu(hardware, devices);
  diagnostics.gpu(hardware, devices);
  diagnostics.gpu({ ...hardware, gpu_compositing: 'disabled_software', rasterization: 'disabled_software' }, devices);
  assert.deepEqual(entries.map(entry => [entry.level, entry.message]),
    [['INFO', 'GPU feature status'], ['WARN', 'GPU feature status']]);
  assert.deepEqual(entries[0].data, {
    compositing: 'enabled', rasterization: 'enabled', videoDecode: 'enabled', videoEncode: 'enabled',
    devices: [{ vendorId: 4098, deviceId: 30032, driverVersion: '32.0.21025.1024' }],
  });
  assert.equal(entries[1].data?.compositing, 'disabled_software');
});

test('GPU adapters are read defensively from the untyped GPU info', () => {
  assert.deepEqual(gpuDevices(undefined), []);
  assert.deepEqual(gpuDevices({ gpuDevice: 'none' }), []);
  assert.deepEqual(gpuDevices({ gpuDevice: [{ vendorId: 4318, deviceId: 7, active: false, driverVersion: 3 }] }),
    [{ vendorId: 4318, deviceId: 7 }]);
});

test('display changes are logged with the resulting layout, except work-area-only moves', () => {
  const { entries, diagnostics } = fixture();
  diagnostics.displayChanged('changed', display(1, 240), [display(1, 240)], ['workArea']);
  assert.equal(entries.length, 0);
  // A refresh-rate-only change reaches Electron without a named metric.
  diagnostics.displayChanged('changed', display(1, 60), [display(1, 60)], []);
  diagnostics.displayChanged('removed', display(2, 165), [display(1, 60)]);
  assert.deepEqual(entries.map(entry => entry.message), ['Display changed', 'Display removed']);
  assert.deepEqual(entries[0].data?.metrics, []);
  assert.deepEqual(entries[0].data?.displays, [{ id: 1, width: 2560, height: 1440, scale: 1.25, hz: 60 }]);
  assert.equal(entries[1].data?.metrics, undefined);
});

test('only abnormal child exits and GPU exits are logged', () => {
  const { entries, diagnostics } = fixture();
  diagnostics.processGone({ type: 'Utility', reason: 'clean-exit', exitCode: 0, name: 'Monky screen host' });
  diagnostics.processGone({ type: 'GPU', reason: 'clean-exit', exitCode: 0 });
  diagnostics.processGone({ type: 'GPU', reason: 'crashed', exitCode: -1073741819, name: 'GPU' });
  assert.deepEqual(entries.map(entry => entry.level), ['INFO', 'ERROR']);
  assert.deepEqual(entries[1].data, { type: 'GPU', reason: 'crashed', exitCode: -1073741819, name: 'GPU' });
});

test('window and power transitions carry the window state', () => {
  const { entries, diagnostics } = fixture();
  diagnostics.window('minimize', { visible: true, minimized: true, focused: false });
  diagnostics.window('unresponsive', visible);
  diagnostics.power('resume');
  assert.deepEqual(entries.map(entry => [entry.level, entry.message]), [
    ['INFO', 'Main window state changed'], ['WARN', 'Main window state changed'], ['INFO', 'Power state changed'],
  ]);
  assert.deepEqual(entries[0].data, { event: 'minimize', visible: true, minimized: true, focused: false });
  assert.deepEqual(entries[2].data, { event: 'resume' });
});

test('a sustained hot renderer is reported once when it starts and once when it recovers', () => {
  const { entries, diagnostics, advance } = fixture();
  const hot = HOT_RENDERER_CPU + 25;
  for (let index = 0; index < HOT_SAMPLES_TO_WARN - 1; index++) {
    diagnostics.sample(metrics(hot), RENDERER_PID, visible); advance(SAMPLE_INTERVAL_MS);
  }
  // A short spike is normal work, not a slowdown.
  diagnostics.sample(metrics(5), RENDERER_PID, visible); advance(SAMPLE_INTERVAL_MS);
  assert.equal(entries.length, 0);
  for (let index = 0; index < HOT_SAMPLES_TO_WARN + 3; index++) {
    diagnostics.sample(metrics(index === 5 ? 140 : hot), RENDERER_PID, visible); advance(SAMPLE_INTERVAL_MS);
  }
  assert.deepEqual(entries.map(entry => entry.message), ['Sustained renderer CPU']);
  assert.equal(entries[0].level, 'WARN');
  assert.deepEqual(entries[0].data?.usage, {
    browser: { cpu: 2, memoryMb: 100 }, renderer: { cpu: hot, memoryMb: 400 }, gpu: { cpu: 5, memoryMb: 146 },
    other: { cpu: 1, memoryMb: 50 }, utility: { cpu: 3, memoryMb: 20 },
  });
  // One cool sample inside a hot period does not end it.
  diagnostics.sample(metrics(5), RENDERER_PID, visible); advance(SAMPLE_INTERVAL_MS);
  diagnostics.sample(metrics(hot), RENDERER_PID, visible); advance(SAMPLE_INTERVAL_MS);
  for (let index = 0; index < COOL_SAMPLES_TO_RECOVER; index++) {
    diagnostics.sample(metrics(5), RENDERER_PID, visible); advance(SAMPLE_INTERVAL_MS);
  }
  assert.deepEqual(entries.map(entry => entry.message), ['Sustained renderer CPU', 'Renderer CPU recovered']);
  assert.equal(entries[1].data?.peakCpu, 140);
  // From the streak's first hot sample to the sample that confirmed recovery: 10 intervals.
  assert.equal(entries[1].data?.hotSeconds, 300);
});

test('a periodic summary averages each process group over its window and starts a new one', () => {
  const { entries, diagnostics } = fixture();
  for (let index = 0; index < SUMMARY_EVERY_SAMPLES; index++)
    diagnostics.sample(metrics(index % 2 ? 30 : 10, index === 3 ? 60 : 4), RENDERER_PID, visible);
  assert.deepEqual(entries.map(entry => entry.message), ['Process usage summary']);
  assert.equal(entries[0].data?.windowSeconds, SUMMARY_EVERY_SAMPLES * 30);
  assert.deepEqual(entries[0].data?.usage, {
    browser: { avgCpu: 2, maxCpu: 2, memoryMb: 100, processes: 1 },
    renderer: { avgCpu: 20, maxCpu: 30, memoryMb: 400, processes: 1 },
    gpu: { avgCpu: 6.8, maxCpu: 60, memoryMb: 146, processes: 1 },
    other: { avgCpu: 1, maxCpu: 1, memoryMb: 50, processes: 1 },
    utility: { avgCpu: 3, maxCpu: 3, memoryMb: 20, processes: 1 },
  });
  for (let index = 0; index < SUMMARY_EVERY_SAMPLES; index++) diagnostics.sample(metrics(50), RENDERER_PID, visible);
  assert.deepEqual(entries[1].data?.usage, {
    browser: { avgCpu: 2, maxCpu: 2, memoryMb: 100, processes: 1 },
    renderer: { avgCpu: 50, maxCpu: 50, memoryMb: 400, processes: 1 },
    gpu: { avgCpu: 5, maxCpu: 5, memoryMb: 146, processes: 1 },
    other: { avgCpu: 1, maxCpu: 1, memoryMb: 50, processes: 1 },
    utility: { avgCpu: 3, maxCpu: 3, memoryMb: 20, processes: 1 },
  });
});
