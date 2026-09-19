'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { options } = require('../scripts/prepare.cjs');

test('native preparation requires explicit Python and bounded build parallelism', () => {
  const python = path.resolve('tools', 'python.exe');
  assert.deepEqual(options([`--python=${python}`, '--jobs=2']), { python, jobs: 2 });
  for (const args of [
    ['--python=relative'], [`--python=${python}`, '--jobs=0'],
    [`--python=${python}`, '--jobs=17'], [`--python=${python}`, '--unknown=true'],
    [`--python=${python}`, '--jobs=2', '--jobs=3'], ['--python'],
  ]) assert.throws(() => options(args));
});
