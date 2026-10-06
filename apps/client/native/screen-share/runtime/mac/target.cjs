'use strict';
const assert = require('node:assert/strict');
const integer = (value, minimum, maximum) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
function validateMacTarget(target) {
  assert.ok(target && typeof target === 'object' && !Array.isArray(target));
  assert.equal(target.platform, 'darwin');
  if (target.kind === 'window') {
    assert.deepEqual(Object.keys(target).sort(),
      ['platform', 'kind', 'windowId', 'expectedProcessId', 'expectedProcessStartTimeUs'].sort());
    assert.ok(integer(target.windowId, 1, 0xffffffff) && integer(target.expectedProcessId, 1, 0x7fffffff));
    assert.ok(typeof target.expectedProcessStartTimeUs === 'string' && /^[1-9]\d{0,19}$/.test(target.expectedProcessStartTimeUs));
    return Object.freeze({ ...target });
  }
  assert.equal(target.kind, 'monitor');
  assert.deepEqual(Object.keys(target).sort(), ['platform', 'kind', 'displayId', 'displayUuid', 'bounds'].sort());
  assert.ok(integer(target.displayId, 1, 0xffffffff) && typeof target.displayUuid === 'string'
    && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(target.displayUuid));
  const bounds = target.bounds;
  assert.ok(bounds && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
    && integer(bounds.width, 1, 32768) && integer(bounds.height, 1, 32768));
  assert.deepEqual(Object.keys(bounds).sort(), ['height', 'width', 'x', 'y']);
  return Object.freeze({ ...target, bounds: Object.freeze({ ...bounds }) });
}
module.exports = { validateMacTarget };
