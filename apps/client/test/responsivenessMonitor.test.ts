import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ResponsivenessMonitor, scriptFile } from '../src/renderer/core/ResponsivenessMonitor';

function fixture() {
  const reports: Record<string, unknown>[] = [];
  return { reports, monitor: new ResponsivenessMonitor(data => reports.push(data)) };
}

test('a quiet minute writes nothing', () => {
  const { reports, monitor } = fixture();
  monitor.recordEvent({ name: 'pointerover', startTime: 10, duration: 112, processingStart: 12, processingEnd: 14 });
  monitor.recordFrame({ startTime: 0, duration: 150, blockingDuration: 100, renderStart: 140, scripts: [] });
  monitor.flush({ visibility: 'visible', focused: true });
  assert.deepEqual(reports, []);
});

test('a slow hover with idle JavaScript is attributed to presentation, not to script', () => {
  const { reports, monitor } = fixture();
  // The compositor-stall signature: handlers ran in 2 ms, the next frame came 316 ms later.
  monitor.recordEvent({ name: 'pointerover', startTime: 1000, duration: 320, processingStart: 1002, processingEnd: 1004 });
  monitor.recordEvent({ name: 'click', startTime: 2000, duration: 240, processingStart: 2100, processingEnd: 2230 });
  monitor.flush({ visibility: 'visible', focused: true });
  assert.deepEqual(reports, [{
    windowSeconds: 60,
    slowEvents: 2,
    worstEvent: { type: 'pointerover', durationMs: 320, inputDelayMs: 2, processingMs: 2, presentationDelayMs: 316 },
    longFrames: 0,
    worstFrame: null,
    visibility: 'visible',
    focused: true,
  }]);
});

test('a long frame keeps its worst script without the user profile path', () => {
  const { reports, monitor } = fixture();
  const sourceURL = 'file:///C:/Users/someone/AppData/Local/Programs/Monky/resources/app.asar/dist/assets/index-Ab1_c.js?v=3';
  monitor.recordFrame({ startTime: 500, duration: 260, blockingDuration: 210, renderStart: 700, scripts: [
    { duration: 40, invokerType: 'user-callback', sourceURL },
    { duration: 180, invokerType: 'event-listener', sourceURL },
  ] });
  monitor.recordFrame({ startTime: 900, duration: 230, blockingDuration: 0, renderStart: 0, scripts: [] });
  monitor.flush({ visibility: 'hidden', focused: false });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].longFrames, 2);
  assert.deepEqual(reports[0].worstFrame, {
    durationMs: 260, blockingMs: 210, renderMs: 60,
    script: { invoker: 'event-listener', file: 'index-Ab1_c.js', durationMs: 180 },
  });
  assert.equal(JSON.stringify(reports).includes('someone'), false);
});

test('each report starts a new window', () => {
  const { reports, monitor } = fixture();
  monitor.recordEvent({ name: 'keydown', startTime: 0, duration: 400, processingStart: 300, processingEnd: 390 });
  monitor.flush({});
  monitor.flush({});
  monitor.recordEvent({ name: 'pointerdown', startTime: 0, duration: 208, processingStart: 1, processingEnd: 2 });
  monitor.flush({});
  assert.deepEqual(reports.map(report => report.slowEvents), [1, 1]);
  assert.deepEqual(reports.map(report => (report.worstEvent === null ? null : 'set')), ['set', 'set']);
});

test('script names are reduced to a safe bundle file name', () => {
  assert.equal(scriptFile('C:\\Users\\someone\\Monky\\dist\\assets\\vendor-9f.js'), 'vendor-9f.js');
  assert.equal(scriptFile('https://example.test/a/b.js#frag'), 'b.js');
  assert.equal(scriptFile(''), 'unknown');
  assert.equal(scriptFile('file:///C:/a/<script>.js'), 'unknown');
});
