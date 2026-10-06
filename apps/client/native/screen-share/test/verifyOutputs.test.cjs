'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { options } = require('../scripts/verifyOutputs.cjs');

test('native output verification selects platforms, architectures and legal checks explicitly', () => {
  assert.deepEqual(options(['mac']), { platform: 'mac' });
  assert.deepEqual(options(['mac', '--arch=x64']), { platform: 'mac', architectures: ['x64'] });
  assert.deepEqual(options(['mac', '--arch=x64,arm64', '--legal']),
    { platform: 'mac', architectures: ['arm64', 'x64'], legal: true });
  assert.deepEqual(options(['win']), { platform: 'win' });
  for (const argv of [[], ['linux'], ['mac', '--arch=ppc'], ['mac', '--arch=arm64,arm64'], ['mac', '--legal', '--legal'],
    ['mac', '--arch=arm64', '--arch=x64'], ['win', '--legal'], ['mac', '--unknown']])
    assert.throws(() => options(argv), undefined, argv.join(' '));
});
