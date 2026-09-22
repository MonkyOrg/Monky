'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Platform } = require('app-builder-lib');
const { getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher');
const { computeNodeModuleFileSets } = require('app-builder-lib/out/util/appFileCopier');
const { build: config } = require('../../../package.json');

test('the real packager excludes native build inputs and server data in workspace and hoisted dependencies', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-package-filter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = path.join(directory, 'apps', 'client');
  const modules = [
    { name: '@monky/screen-share', dir: path.join(app, 'native', 'screen-share'), native: true },
    { name: '@monky/server', dir: path.join(directory, 'apps', 'server'), native: false },
    { name: '@monky/screen-share', dir: path.join(directory, 'node_modules', '@monky', 'screen-share'), native: true },
    { name: '@monky/server', dir: path.join(directory, 'node_modules', '@monky', 'server'), native: false },
  ];
  for (const module of modules) {
    const entries = module.native
      ? ['package.json', 'runtime/entry.cjs', 'bin/win32-x64/runtime.node',
        'build/old.exe', 'src/source.cjs', 'scripts/build.cjs', 'test/case.cjs']
      : ['package.json', 'dist/entry.js', 'data/server.db'];
    for (const entry of entries) {
      const filename = path.join(module.dir, entry);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, '{}');
    }
  }
  const info = {
    config,
    appInfo: { type: 'commonjs' },
    debugLogger: { isEnabled: false },
    getNodeDependencyInfo: () => ({ value: Promise.resolve(modules) }),
  };
  const matcher = getNodeModuleFileMatcher(app, path.join(directory, 'output'), value => value, {}, info);
  const sets = await computeNodeModuleFileSets({ info, config, platform: Platform.WINDOWS }, matcher);
  assert.equal(sets.length, modules.length);
  for (const [index, set] of sets.entries()) {
    const relative = set.files.map(filename => path.relative(modules[index].dir, filename).split(path.sep).join('/')).sort();
    assert.deepEqual(relative, modules[index].native
      ? ['bin/win32-x64/runtime.node', 'package.json', 'runtime/entry.cjs']
      : ['dist/entry.js', 'package.json']);
  }
});
