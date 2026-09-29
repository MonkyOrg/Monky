'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute, write, digest, fingerprint, regularFiles } = require('./buildTools.cjs');
const { workspace, checkSpace } = require('./prepareMacRtc.cjs');
const pins = require('./native-rtc/pins.json');

function build({ arch = process.arch, jobs = 4 } = {}) {
  assert.equal(process.platform, 'darwin');
  assert.ok(['arm64', 'x64'].includes(arch));
  assert.ok(Number.isInteger(jobs) && jobs >= 1 && jobs <= 16);
  const sdk = path.join(workspace, 'webrtc', 'src');
  const python = path.join(workspace, 'python-3.11', 'bin', 'python3');
  const revision = pins.repositories.webrtc.commit;
  assert.equal(execute('git', ['-C', sdk, 'rev-parse', 'HEAD'], { capture: true }), revision);
  const compiler = path.join(sdk, 'third_party', 'llvm-build', 'Release+Asserts', 'bin', 'clang++');
  assert.match(execute(compiler, ['--version'], { capture: true }), /21\.0\.0git[\s\S]*bd809ffb/u);
  checkSpace();
  const localBuild = path.join(root, 'build', `rtc-mac-${arch}`);
  fs.mkdirSync(localBuild, { recursive: true });
  const lock = path.join(localBuild, 'compile.lock'), handle = fs.openSync(lock, 'wx');
  try {
    const source = path.join(root, 'src');
    const key = digest(fs.realpathSync(root)).slice(0, 8);
    const inputs = path.join(sdk, 'out', `monky-${key}-inputs`);
    const output = path.join(sdk, 'out', `monky-${key}-${arch}`);
    for (const directory of [inputs, output]) {
      const marker = path.join(directory, '.monky-owner.json');
      const expected = { root: fs.realpathSync(root), revision };
      if (fs.existsSync(directory)) {
        assert.ok(!fs.lstatSync(directory).isSymbolicLink());
        assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), expected);
      } else {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(marker, JSON.stringify(expected) + '\n', { flag: 'wx' });
      }
    }
    const sourceFiles = ['rtc', 'mac'].flatMap(directory =>
      regularFiles(path.join(source, directory)).map(relative => {
        const name = path.join(directory, relative), bytes = fs.readFileSync(path.join(source, name));
        write(path.join(inputs, name), bytes);
        return { path: name, sha256: digest(bytes) };
      }));
    const overlay = JSON.parse(fs.readFileSync(path.join(source, 'rtc', 'level6-upstream.json'), 'utf8'));
    assert.equal(overlay.revision, revision);
    for (const file of overlay.files)
      assert.equal(digest(fs.readFileSync(path.join(sdk, file.path))), file.sha256,
        `The native RTC overlay requires its pinned upstream source: ${file.path}`);
    const overlayFiles = sourceFiles.filter(file => file.path.startsWith('rtc/inputs/sdk/'));
    const vfs = path.join(inputs, 'sdk-vfs.json');
    write(vfs, JSON.stringify({ version: 0, 'case-sensitive': true, 'use-external-names': false,
      roots: overlayFiles.map(file => ({ type: 'file',
        name: path.join(sdk, path.relative('rtc/inputs/sdk', file.path)),
        'external-contents': path.join(inputs, file.path) })),
    }, null, 2) + '\n');
    const wrapper = path.join(inputs, 'rtc', 'inputs', 'build', 'rtc_overlay_compiler.py');
    const overlayHash = digest(JSON.stringify(overlayFiles) + digest(fs.readFileSync(wrapper)));
    const target = `//out/${path.basename(inputs)}/rtc`;
    const values = {
      target_os: 'mac', target_cpu: arch, is_debug: false, is_component_build: false, is_official_build: false,
      is_clang: true, use_custom_libcxx: true, use_custom_libcxx_for_host: true, use_rtti: true,
      use_thin_lto: false, symbol_level: 0, treat_warnings_as_errors: false,
      use_siso: false, use_remoteexec: false, clang_use_chrome_plugins: false,
      rtc_include_tests: false, rtc_build_examples: false, rtc_build_tools: false,
      rtc_enable_protobuf: false, rtc_use_h264: false, rtc_use_h265: false,
      enable_libaom: true, enable_rust: false, enable_rust_cxx: false, enable_chromium_prelude: false,
      mac_deployment_target: '14.0', mac_min_system_version: '14.0',
      cc_wrapper: `"${python}" -I -S -B "${wrapper}" "${vfs}" ${overlayHash} --`,
    };
    write(path.join(output, 'args.gn'), Object.entries(values)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n');
    const env = { ...process.env, PATH: `${path.dirname(python)}:${process.env.PATH}`,
      DEPOT_TOOLS_UPDATE: '0', DEPOT_TOOLS_WIN_TOOLCHAIN: '0' };
    delete env.FORCE_MAC_TOOLCHAIN;
    const gn = path.join(sdk, 'buildtools', 'mac', 'gn');
    execute(gn, ['gen', output, '--fail-on-unused-args', `--root=${sdk}`, `--root-target=${target}`,
      `--script-executable=${python}`], { cwd: sdk, env });
    execute(path.join(sdk, 'third_party', 'ninja', 'ninja'), ['-C', output, `-j${jobs}`, 'monky_screen_rtc', 'monky_av1'],
      { cwd: sdk, env });
    checkSpace();
    const library = path.join(output, 'libmonky_screen_rtc.dylib');
    const addonDirectory = path.join(localBuild, 'node');
    write(path.join(addonDirectory, 'binding.gyp'), JSON.stringify({ targets: [{
      target_name: 'monky_screen_rtc',
      sources: [path.relative(addonDirectory, path.join(source, 'rtc', 'inputs', 'engine', 'node', 'napi_engine.cc'))],
      include_dirs: [path.join(source, 'rtc', 'inputs', 'engine')],
      defines: ['NAPI_VERSION=8'],
      libraries: [library],
      xcode_settings: { CLANG_CXX_LANGUAGE_STANDARD: 'c++20', GCC_ENABLE_CPP_EXCEPTIONS: 'YES',
        MACOSX_DEPLOYMENT_TARGET: '14.0', OTHER_LDFLAGS: ['-Wl,-rpath,@loader_path'] },
    }, {
      target_name: 'monky_native_surfaces',
      sources: [path.relative(addonDirectory, path.join(source, 'rtc', 'inputs', 'engine', 'node', 'napi_surfaces.mm'))],
      defines: ['NAPI_VERSION=8'],
      libraries: ['-framework IOSurface', '-framework CoreFoundation', '-lbsm'],
      xcode_settings: { CLANG_CXX_LANGUAGE_STANDARD: 'c++20', MACOSX_DEPLOYMENT_TARGET: '14.0' },
    }] }, null, 2) + '\n');
    execute(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild', '--release',
      `--arch=${arch}`, `--python=${python}`, `--directory=${addonDirectory}`, `--jobs=${jobs}`], { env });
    const destination = path.join(root, 'bin', `darwin-${arch}`);
    const binaries = [library, path.join(output, 'libmonky_av1.dylib'), ...['monky_screen_rtc.node', 'monky_native_surfaces.node']
      .map(name => path.join(addonDirectory, 'build', 'Release', name))].map(filename => {
      const outputFile = path.join(destination, path.basename(filename));
      write(outputFile, fs.readFileSync(filename));
      execute('codesign', ['--force', '--sign', '-', outputFile]);
      return { name: path.basename(filename), ...fingerprint(outputFile) };
    });
    const probe = path.join(localBuild, 'rtc-capabilities');
    execute('xcrun', ['clang++', '-std=c++20', '-mmacosx-version-min=14.0',
      '-arch', arch === 'x64' ? 'x86_64' : arch,
      path.join(source, 'rtc', 'inputs', 'engine', 'capabilities_main.cc'),
      library, `-Wl,-rpath,${output}`, '-o', probe]);
    // Cross-built support must come from the actual target library, never from
    // another architecture's descriptor. arm64 hosts need Rosetta for x64 here.
    const capabilities = JSON.parse(execute(probe, [], { capture: true }));
    require('../runtime/nativeRtc/engine/node/encoded.cjs').validateCapabilities(capabilities, 'darwin');
    if (arch === process.arch) {
      const addon = path.join(destination, 'monky_screen_rtc.node');
      const nodeCapabilities = JSON.parse(execute(process.execPath, ['-e',
        'console.log(JSON.stringify(require(process.argv[1]).capabilities()))', addon], { capture: true }));
      assert.deepEqual(capabilities, nodeCapabilities);
    }
    for (const file of sourceFiles)
      assert.equal(digest(fs.readFileSync(path.join(source, file.path))), file.sha256,
        `Native input changed during compilation: ${file.path}`);
    const manifest = { schemaVersion: 1, platform: 'darwin', arch, minimumMacOS: '14.0',
      webrtcRevision: revision, sourceFiles, sourceRecipe: fingerprint(__filename), binaries, capabilities };
    write(path.join(destination, 'rtc-build.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify({ macRtcBuilt: true, arch, binaries, capabilities }));
    return manifest;
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}

module.exports = { build };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length <= 1 && (!args.length || /^--arch=(x64|arm64)$/.test(args[0])));
    build(args.length ? { arch: args[0].slice(7) } : {});
  } catch (error) { console.error(error); process.exitCode = 1; }
}
