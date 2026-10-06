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

test('native preparation can select Git explicitly without accepting ambiguous or relative arguments', () => {
  const python = path.resolve('tools', 'python.exe');
  const git = path.resolve('tools', 'git.exe');
  assert.deepEqual(options([`--python=${python}`, `--git=${git}`]), { python, git, jobs: 4 });
  assert.throws(() => options([`--python=${python}`, '--git=relative.exe']));
  assert.throws(() => options([`--python=${python}`, `--git=${git}`, `--git=${git}`]));
});
