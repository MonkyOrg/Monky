import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stabilizePersonMask } from '../src/renderer/utils/cameraEffects';
import { registerServerInviteProtocol } from '../src/main/serverInvites';
import { fitOverlayCards, OVERLAY_RESIZE_HINTS, overlayResizeHint } from '../src/renderer/utils/overlayLayout';

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

test('overlay resize hints follow corners and the middle half of each edge', () => {
  for (const [width, height] of [[340, 240], [160, 120], [800, 600]]) {
    for (const hint of OVERLAY_RESIZE_HINTS) {
      assert.equal(overlayResizeHint(width, height, { x: hint.x * width, y: hint.y * height }), hint.direction);
    }
    assert.equal(overlayResizeHint(width, height, { x: width / 2, y: height / 2 }), undefined);
    assert.equal(overlayResizeHint(width, height, { x: -1, y: height / 2 }), undefined);
    assert.equal(overlayResizeHint(width, height, { x: width / 2, y: height + 1 }), undefined);
  }
  for (const x of [90, 170, 250]) {
    assert.equal(overlayResizeHint(340, 240, { x, y: 200 }), 's', 'the whole central zone reveals the bottom handle before reaching its pixel');
    assert.equal(overlayResizeHint(340, 240, { x, y: 40 }), 'n');
  }
  for (const y of [65, 120, 175]) {
    assert.equal(overlayResizeHint(340, 240, { x: 40, y }), 'w');
    assert.equal(overlayResizeHint(340, 240, { x: 300, y }), 'e');
  }
  for (const [x, y, direction] of [[5, 5, 'nw'], [335, 5, 'ne'], [5, 235, 'sw'], [335, 235, 'se']] as const) {
    assert.equal(overlayResizeHint(340, 240, { x, y }), direction, 'corners never activate a middle handle');
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
