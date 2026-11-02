'use strict';

// The WebRTC build steps that Windows (buildRtc.cjs) and macOS (buildMacRtc.cjs) share: owned build
// directories, the staged inputs and SDK overlay, the GN arguments and graph, the toolchain and
// contract checks, the installed binaries and the manifest. A WebRTC update edits them here once.
// Each platform keeps what really differs: its linker and SDK arguments, binding.gyp, signing and,
// on Windows, the MSVC job.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute, write, digest, fingerprint, regularFiles } = require('./buildTools.cjs');
const pins = require('./native-rtc/pins.json');

const revision = pins.repositories.webrtc.commit;
const CLANG_VERSION = /21\.0\.0git[\s\S]*bd809ffb/u;
const BASE_GN_ARGS = Object.freeze({
  is_debug: false, is_component_build: false, is_official_build: false, is_clang: true,
  use_custom_libcxx: true, use_custom_libcxx_for_host: true, use_rtti: true, use_thin_lto: false,
  symbol_level: 0, treat_warnings_as_errors: false, use_siso: false, use_remoteexec: false,
  clang_use_chrome_plugins: false, rtc_include_tests: false, rtc_build_examples: false, rtc_build_tools: false,
  rtc_enable_protobuf: false, rtc_use_h264: false, rtc_use_h265: false,
  enable_libaom: true, enable_rust: false, enable_rust_cxx: false, enable_chromium_prelude: false,
});

/** A build directory inside the SDK checkout that only this checkout of Monky may use. */
function ownedDirectory(directory, marker, owner) {
  const filename = path.join(directory, marker);
  if (fs.existsSync(directory)) {
    assert.ok(!fs.lstatSync(directory).isSymbolicLink(), 'Build directories cannot be aliases.');
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), owner, 'Build directory belongs to another checkout.');
  } else {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(owner) + '\n', { flag: 'wx' });
  }
  return directory;
}

/** The SDK checkout, its compiler and the upstream files under the maintained overlay are the pinned ones. */
function checkSdk({ sdk, compiler, env = process.env }) {
  assert.equal(execute('git', ['--no-pager', '-C', sdk, 'rev-parse', 'HEAD'], { env, capture: true }), revision,
    'WebRTC revision differs from the pinned native media toolchain.');
  assert.match(execute(compiler, ['--version'], { env, capture: true }), CLANG_VERSION,
    'The WebRTC checkout does not hold its pinned Chromium clang.');
  const level6 = JSON.parse(fs.readFileSync(path.join(root, 'src', 'rtc', 'level6-upstream.json'), 'utf8'));
  assert.equal(level6.revision, revision);
  for (const file of level6.files) {
    assert.equal(digest(fs.readFileSync(path.join(sdk, ...file.path.split('/')))), file.sha256,
      `The maintained Level6 overlay requires its exact upstream source: ${file.path}`);
  }
}

/**
 * Copies the owned sources (`directories` of `source`) into `inputs`, recording each SHA-256, and writes
 * the compiler VFS overlay that replaces the maintained SDK files. `base` is where src/rtc lands inside
 * `inputs`: its root on Windows, rtc/ on macOS, which also builds src/mac.
 */
function stageInputs({ sdk, inputs, source, directories, base, caseSensitive }) {
  const sourceFiles = directories.flatMap(directory =>
    regularFiles(path.join(source, directory)).map(relative => {
      const name = path.join(directory, relative), bytes = fs.readFileSync(path.join(source, name));
      write(path.join(inputs, name), bytes);
      return { path: name, sha256: digest(bytes) };
    }));
  const overlay = path.join(base, 'inputs', 'sdk');
  const overlayFiles = sourceFiles.filter(file => file.path.startsWith(overlay + path.sep));
  const vfs = path.join(inputs, 'sdk-vfs.json');
  write(vfs, JSON.stringify({
    version: 0, 'case-sensitive': caseSensitive, 'use-external-names': false,
    roots: overlayFiles.map(file => ({
      type: 'file', name: path.join(sdk, path.relative(overlay, file.path)),
      'external-contents': path.join(inputs, file.path),
    })),
  }, null, 2) + '\n');
  const wrapper = path.join(inputs, base, 'inputs', 'build', 'rtc_overlay_compiler.py');
  const overlayHash = digest(JSON.stringify(overlayFiles) + digest(fs.readFileSync(wrapper)));
  return {
    source, sourceFiles,
    rootTarget: ['//out', path.basename(inputs), base].filter(Boolean).join('/'),
    ccWrapper: python => `"${python}" -I -S -B "${wrapper}" "${vfs}" ${overlayHash} --`,
  };
}

/** args.gn: the arguments both platforms build with, plus the platform's own. */
function writeGnArgs(output, { targetOs, targetCpu, platformArgs, ccWrapper }) {
  for (const name of Object.keys(platformArgs))
    assert.ok(!Object.hasOwn(BASE_GN_ARGS, name), `A platform cannot override the shared GN argument ${name}.`);
  const values = { target_os: targetOs, target_cpu: targetCpu, ...BASE_GN_ARGS, ...platformArgs, cc_wrapper: ccWrapper };
  write(path.join(output, 'args.gn'), Object.entries(values)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n');
  return values;
}

/** Generates the GN graph and returns the arguments that address it (for gn desc). */
function generate({ gn, sdk, output, rootTarget, python, env, extraArgs = [] }) {
  const graphArgs = [`--root=${sdk}`, `--root-target=${rootTarget}`, `--script-executable=${python}`, ...extraArgs];
  execute(gn, ['gen', output, '--fail-on-unused-args', ...graphArgs], { cwd: sdk, env });
  return graphArgs;
}

function compile({ ninja, sdk, output, jobs, targets, env }) {
  assert.ok(Number.isInteger(jobs) && jobs >= 1 && jobs <= 16, 'Native build jobs must be 1..16.');
  execute(ninja, ['-C', output, `-j${jobs}`, ...targets], { cwd: sdk, env });
}

/** The device-free engine contract probe ran completely, including every required group. */
function checkContracts(contracts, { minimum, groups = [] }) {
  const missing = groups.filter(name => !(contracts.groups?.[name] > 0));
  assert.ok(contracts.checks > minimum && contracts.devicesOpened === false && !missing.length,
    `Native device-free contract checks did not complete${missing.length ? `: ${missing.join(', ')}` : '.'}`);
  return contracts;
}

function assertUnchanged(source, sourceFiles) {
  for (const file of sourceFiles)
    assert.equal(digest(fs.readFileSync(path.join(source, file.path))), file.sha256,
      `Native input changed during compilation: ${file.path}`);
}

/** Copies the built files into `destination` (signing them where the platform does) and records them. */
function installBinaries(files, destination, { sign } = {}) {
  return files.map(filename => {
    const installed = path.join(destination, path.basename(filename));
    write(installed, fs.readFileSync(filename));
    sign?.(installed);
    return { name: path.basename(filename), ...fingerprint(installed) };
  });
}

function writeManifest(destination, { platform = {}, sourceFiles, recipes = {}, binaries, capabilities, contracts }) {
  const manifest = { schemaVersion: 1, ...platform, webrtcRevision: revision, sourceFiles, ...recipes,
    binaries, capabilities, contracts };
  write(path.join(destination, 'rtc-build.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

module.exports = {
  revision, BASE_GN_ARGS, ownedDirectory, checkSdk, stageInputs, writeGnArgs, generate, compile,
  checkContracts, assertUnchanged, installBinaries, writeManifest,
};
