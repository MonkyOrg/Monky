import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overlaySignalPayloadSchema, overlaySignalSchema } from '@monky/shared';
import { stabilizePersonMask } from '../src/renderer/utils/cameraEffects';
import { registerServerInviteProtocol } from '../src/main/serverInvites';
import { arrangeOverlayCards, fitOverlayCards, overlayFrameRestriction } from '../src/renderer/utils/overlayLayout';
import { waitForIceGatheringComplete, type IceGatheringTarget } from '../src/renderer/core/webrtc/iceGathering';

test('only an installed app repairs a missing invitation association', () => {
  let registered = 0;
  const app = { isPackaged: false, isDefaultProtocolClient: () => false,
    setAsDefaultProtocolClient: (scheme: string) => { assert.equal(scheme, 'monky'); registered++; return true; } };
  registerServerInviteProtocol(app);
  assert.equal(registered, 0);
  app.isPackaged = true;
  registerServerInviteProtocol(app);
  assert.equal(registered, 1);
  app.isDefaultProtocolClient = () => true;
  registerServerInviteProtocol(app);
  assert.equal(registered, 1);
});

test('overlay cards retain aspect ratio and fit after joins and resizing', () => {
  for (const [width, height] of [[340, 200], [160, 90], [800, 600]]) {
    for (const count of [1, 2, 3, 6, 12]) {
      for (const mode of ['grid', 'horizontal', 'vertical']) {
        const layout = fitOverlayCards(width, height, count, mode);
        assert.ok(Math.abs(layout.width / layout.height - 16 / 9) < 0.001);
        assert.ok(layout.columns * layout.width + (layout.columns - 1) * 6 <= width + 0.001);
        const rows = Math.ceil(count / layout.columns);
        assert.ok(rows * layout.height + (rows - 1) * 6 <= height + 0.001);
      }
    }
  }
});

test('initial fit and subsequent arrangement use the same grid; unconstrained resize fills both dimensions', () => {
  for (const [width, height] of [[312, 642], [1000, 100], [600, 400]]) {
    for (const count of [1, 4, 5, 9]) {
      for (const mode of ['grid', 'horizontal', 'vertical']) {
        for (const preserve of [true, false]) {
          const size = fitOverlayCards(width, height, count, mode, preserve);
          const arranged = arrangeOverlayCards(size, count, mode);
          assert.equal(size.columns, arranged.columns);
          assert.ok(arranged.width <= width + 0.001 && arranged.height <= height + 0.001);
          if (!preserve) {
            assert.ok(Math.abs(arranged.width - width) < 0.001);
            assert.ok(Math.abs(arranged.height - height) < 0.001);
          }
        }
      }
    }
  }
});

test('segmentation reduces stationary-edge jitter without lagging fast movements', () => {
  let previous: Float32Array | null = null;
  const outputs: number[] = [];
  for (let frame = 0; frame < 60; frame++) {
    previous = stabilizePersonMask(new Float32Array([frame % 2 ? 0.55 : 0.45]), previous);
    if (frame > 10) outputs.push(previous[0]);
  }
  assert.ok(Math.max(...outputs) - Math.min(...outputs) < 0.04, 'stationary jitter shrinks by at least 60%');
  assert.equal(stabilizePersonMask(new Float32Array([0]), previous)[0], 0, 'departing foreground is removed immediately');
  assert.equal(stabilizePersonMask(new Float32Array([1]), previous)[0], 1, 'new foreground is included immediately');
  assert.throws(() => stabilizePersonMask(new Float32Array([NaN]), null));
});

class FakeGathering implements IceGatheringTarget {
  public iceGatheringState: RTCIceGatheringState = 'gathering';
  public readonly listeners = new Set<() => void>();
  public addEventListener(_type: 'icegatheringstatechange', listener: () => void): void { this.listeners.add(listener); }
  public removeEventListener(_type: 'icegatheringstatechange', listener: () => void): void { this.listeners.delete(listener); }
  public change(state: RTCIceGatheringState): void {
    this.iceGatheringState = state;
    for (const listener of [...this.listeners]) listener();
  }
}

test('ICE gathering waits for complete or the timeout, and always lets go of the connection', async () => {
  const done = new FakeGathering();
  done.iceGatheringState = 'complete';
  await waitForIceGatheringComplete(done, 60_000);
  assert.equal(done.listeners.size, 0, 'An already complete gathering resolves without listening');

  const gathering = new FakeGathering();
  let settled = false;
  const completed = waitForIceGatheringComplete(gathering, 60_000).then(() => { settled = true; });
  assert.equal(gathering.listeners.size, 1);
  gathering.change('gathering');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'Only complete ends the wait');
  gathering.change('complete');
  await completed;
  assert.equal(gathering.listeners.size, 0, 'The listener is removed once gathering completes');

  const stalled = new FakeGathering();
  const started = Date.now();
  await waitForIceGatheringComplete(stalled, 30);
  assert.ok(Date.now() - started >= 25, 'A gathering that never completes is bounded by the timeout');
  assert.equal(stalled.listeners.size, 0, 'The listener is removed on timeout too');
});

test('overlay signals carry their connection session and nothing else', () => {
  const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
  const session = '8b6f5c1e-2a7d-4c39-9f1b-0d4e6a2b7c11';
  for (const signal of [
    { kind: 'hello', session }, { kind: 'ready', session }, { kind: 'ready', session: null },
    { kind: 'offer', session, sdp }, { kind: 'answer', session, sdp }, { kind: 'scale', session, pixelRatio: 1.5 },
  ]) {
    assert.deepEqual(overlaySignalSchema.parse(signal), signal);
  }
  for (const signal of [
    null, 'ready', JSON.stringify({ type: 'ready' }), { type: 'answer', sdp },
    { kind: 'offer', session }, { kind: 'answer', session: null, sdp }, { kind: 'hello', session: null },
    { kind: 'answer', session: 'bad session!', sdp }, { kind: 'answer', session: 'x'.repeat(65), sdp },
    { kind: 'offer', session, sdp: '' }, { kind: 'offer', session, sdp: 'x'.repeat(262_145) },
    { kind: 'offer', session, sdp, candidate: 'extra' }, { kind: 'restart', session },
    { kind: 'scale', session: null, pixelRatio: 1 }, { kind: 'scale', session, pixelRatio: 0 },
    { kind: 'scale', session, pixelRatio: Number.NaN }, { kind: 'scale', session, pixelRatio: 100 },
    { kind: 'scale', session, pixelRatio: '2' },
  ]) {
    assert.equal(overlaySignalSchema.safeParse(signal).success, false, JSON.stringify(signal)?.slice(0, 80));
  }
  assert.equal(overlaySignalPayloadSchema.safeParse({ target: 'overlay', signal: { kind: 'hello', session } }).success, true);
  assert.equal(overlaySignalPayloadSchema.safeParse({ target: 'popup', signal: { kind: 'hello', session } }).success, false);
  assert.equal(overlaySignalPayloadSchema.safeParse({ target: 'main', signal: '{"type":"answer"}' }).success, false);
});

test('an overlay slot never sends more pixels than its card shows', () => {
  const card = { width: 240, height: 135 };
  assert.deepEqual(overlayFrameRestriction(card, 1, 'contain'), { maxWidth: 240, maxHeight: 135 });
  assert.deepEqual(overlayFrameRestriction(card, 1.5, 'contain', { width: 1920, height: 1080 }),
    { maxWidth: 360, maxHeight: 203 }, 'Device pixels count, rounded up');
  for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(overlayFrameRestriction(card, ratio, 'contain'), { maxWidth: 240, maxHeight: 135 });
  }
  // Cover crops the frame to the card: the kept part must still fill it in both directions.
  const wide = overlayFrameRestriction(card, 1, 'cover', { width: 2560, height: 1080 });
  assert.equal(wide.maxHeight, 135);
  assert.ok(wide.maxWidth / wide.maxHeight >= 2560 / 1080 - 0.01 && wide.maxWidth >= 240);
  const square = overlayFrameRestriction(card, 1, 'cover', { width: 640, height: 640 });
  assert.deepEqual(square, { maxWidth: 240, maxHeight: 240 });
  const portrait = overlayFrameRestriction(card, 2, 'cover', { width: 720, height: 1280 });
  assert.equal(portrait.maxWidth, 480);
  assert.ok(portrait.maxHeight >= 853);
  assert.deepEqual(overlayFrameRestriction(card, 1, 'cover', {}), { maxWidth: 240, maxHeight: 240 },
    'Without the source size, a square on the longer side covers frames up to the card proportion');
});
