import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { nativeBuildPlan } from './build-light.js';

const base = { root: path.resolve('fixture-repository'), nodeExecutable: process.execPath, jobs: 2 };

test('Windows builds use the existing Visual Studio toolchain and an isolated x64 directory', () => {
  const plan = nativeBuildPlan({ ...base, platform: 'win32', architecture: 'x64' });
  assert.equal(plan.buildDirectory, path.join(base.root, 'apps', 'light', 'build', 'windows-x64'));
  assert.deepEqual(plan.configure.slice(-4), ['-G', 'Visual Studio 17 2022', '-A', 'x64']);
  assert.ok(plan.configure.includes('-DMONKY_LIGHT_TARGET_ARCH:STRING=x64'));
  assert.deepEqual(plan.build, ['--build', plan.buildDirectory, '--config', 'Release', '--parallel', '2']);
});

test('macOS Intel and Apple Silicon builds do not share CMake caches', () => {
  const intel = nativeBuildPlan({ ...base, platform: 'darwin', architecture: 'x64' });
  const silicon = nativeBuildPlan({ ...base, platform: 'darwin', architecture: 'x64', args: ['--arch', 'arm64'] });
  assert.notEqual(intel.buildDirectory, silicon.buildDirectory);
  assert.ok(intel.configure.includes('-DCMAKE_OSX_ARCHITECTURES=x86_64'));
  assert.ok(silicon.configure.includes('-DCMAKE_OSX_ARCHITECTURES=arm64'));
});

test('requested CMake targets are passed as separate process arguments', () => {
  const plan = nativeBuildPlan({
    ...base, platform: 'win32', architecture: 'x64',
    args: ['--target', 'monky-light-platform-test'],
  });
  assert.deepEqual(plan.build.slice(-2), ['--target', 'monky-light-platform-test']);
  assert.ok(plan.configure.includes(`-DMONKY_NODE_EXECUTABLE:FILEPATH=${process.execPath}`));
});

test('unsupported platforms, architectures and malformed arguments fail instead of selecting a fallback', () => {
  assert.throws(() => nativeBuildPlan({ ...base, platform: 'linux', architecture: 'x64' }), /initial Monky Light targets/);
  assert.throws(() => nativeBuildPlan({ ...base, platform: 'win32', architecture: 'arm64' }), /Unsupported/);
  assert.throws(() => nativeBuildPlan({ ...base, platform: 'darwin', architecture: 'ia32' }), /Unsupported/);
  for (const args of [['--unknown', 'x64'], ['--arch'], ['--arch', '--target'], ['--arch', 'x64', '--arch', 'arm64'], ['--target', 'a;b']]) {
    assert.throws(() => nativeBuildPlan({ ...base, platform: 'darwin', architecture: 'arm64', args }));
  }
  assert.throws(() => nativeBuildPlan({ ...base, platform: 'darwin', architecture: 'arm64', jobs: 0 }), /parallelism/);
});
