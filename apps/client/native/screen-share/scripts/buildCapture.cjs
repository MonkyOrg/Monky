'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute, write, fingerprint, verify, redistributableCrt, regularFiles } = require('./buildTools.cjs');

const vendor = path.join(root, 'src', 'vendor', 'obs');
const source = path.join(root, 'src', 'capture');
const inputs = require(path.join(vendor, 'sources.json'));
const runtimeInputs = require(path.join(vendor, 'runtime-inputs.json'));
const additionalInputs = require(path.join(source, 'runtime-additions.json'));
const { bindGameSource, bindMonitorSource } = require('./captureSourceBindings.cjs');
const quote = value => {
  assert.ok(typeof value === 'string' && !/["%!\r\n]/u.test(value), 'Unsupported build argument.');
  return `"${value.replace(/\\$/u, '\\\\')}"`;
};

function options(argv) {
  const result = { stock: process.env.MONKY_OBS_RUNTIME, dependencies: process.env.MONKY_OBS_DEPENDENCIES,
    buildDirectory: path.join(root, 'build', 'capture-production'), output: path.join(root, 'bin', 'win32-x64'),
    job: path.join(root, 'build', 'tools', 'monky_msvc_job.exe') };
  const seen = new Set();
  for (const argument of argv) {
    const at = argument.indexOf('='), key = argument.slice(0, at), value = argument.slice(at + 1);
    assert.ok(at > 0 && value && !seen.has(key), 'Use unique --obs-root= and --deps-root= paths.');
    seen.add(key);
    if (key === '--obs-root') result.stock = value;
    else if (key === '--deps-root') result.dependencies = value;
    else if (key === '--build-root') result.buildDirectory = value;
    else if (key === '--out') result.output = value;
    else if (key === '--job') result.job = value;
    else throw new Error(`Unknown capture build option: ${key}`);
  }
  for (const [name, value] of Object.entries(result))
    assert.ok(value && path.isAbsolute(value), `Set an absolute ${name} input directory.`);
  return result;
}

function build(config) {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  const stock = fs.realpathSync(config.stock), dependencies = fs.realpathSync(config.dependencies);
  const sourceFiles = regularFiles(source).map(relative => ({ path: relative, ...fingerprint(path.join(source, relative)) }));
  for (const file of inputs.files) verify(path.join(vendor, file.path), file);
  for (const file of inputs.dependencies.files) verify(path.join(dependencies, file.path), file);
  assert.equal(additionalInputs.obsVersion, inputs.version);
  assert.equal(additionalInputs.obsRevision, inputs.revision);
  assert.equal(additionalInputs.archiveSha256, runtimeInputs.archive.sha256);
  for (const file of additionalInputs.dependencies) verify(path.join(dependencies, file.path), file);
  const installer = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer');
  const visualStudio = execute(path.join(installer, 'vswhere.exe'),
    ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationPath'], { capture: true });
  assert.ok(path.isAbsolute(visualStudio), 'Visual Studio 2022 C++ tools are required.');
  const version = fs.readFileSync(path.join(visualStudio, 'VC', 'Auxiliary', 'Build',
    'Microsoft.VCToolsVersion.default.txt'), 'utf8').trim();
  assert.match(version, /^14\.\d+\.\d+$/u);
  const compiler = path.join(visualStudio, 'VC', 'Tools', 'MSVC', version, 'bin', 'Hostx64', 'x64');
  const crt = redistributableCrt(visualStudio);
  const vcvars = path.join(visualStudio, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  const job = config.job ?? path.join(root, 'build', 'tools', 'monky_msvc_job.exe');
  assert.ok(fs.existsSync(job), 'Build the RTC toolchain before the capture host.');
  const buildDirectory = config.buildDirectory ?? path.join(root, 'build', 'capture-production');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const lock = path.join(buildDirectory, 'capture.lock'), handle = fs.openSync(lock, 'wx');
  try {
    const env = { ...process.env, VSCMD_SKIP_SENDTELEMETRY: '1', MSBUILDDISABLENODEREUSE: '1' };
    for (const key of Object.keys(env))
      if (/^(CL|_CL_|LINK|CFLAGS|CXXFLAGS|LDFLAGS|CPATH|CPLUS_INCLUDE_PATH|C_INCLUDE_PATH|LIBRARY_PATH|NODE_OPTIONS|NODE_PATH)$/iu.test(key))
        delete env[key];
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'Path';
    env[pathKey] = `${installer};${env[pathKey] ?? ''}`;
    const commands = [];
    const run = (name, operation) => {
      const output = execute(process.env.ComSpec, ['/d', '/s', '/c',
        `"call ${quote(vcvars)} >nul && ${operation}"`],
      { cwd: buildDirectory, env, capture: true, windowsVerbatimArguments: true });
      write(path.join(buildDirectory, `${name}.log`), output + '\n');
      commands.push(name);
      return output;
    };
    const compile = (name, args) => {
      const response = path.join(buildDirectory, `${name}.rsp`);
      write(response, args.join(' ') + '\n');
      const output = run(name, `${quote(job)} ${quote(compiler)} ${quote(path.join(compiler, 'cl.exe'))} @${quote(response)}`);
      const cleanup = JSON.parse(output.match(/^MONKY_MSVC_CLEANUP (.+)$/mu)?.[1] ?? 'null');
      assert.equal(cleanup?.msbuildExitCode, 0); assert.equal(cleanup?.remainingOwnedHelpers, 0);
    };
    const generated = path.join(buildDirectory, 'generated');
    let obsconfig = fs.readFileSync(path.join(vendor, 'libobs', 'obsconfig.h.in'), 'utf8');
    for (const [name, value] of Object.entries({
      OBS_DATA_PATH: 'data/obs-studio', OBS_PLUGIN_PATH: 'obs-plugins', OBS_PLUGIN_DESTINATION: 'obs-plugins/64bit',
    })) obsconfig = obsconfig.replace(`#cmakedefine ${name} "@${name}@"`, `#define ${name} "${value}"`);
    for (const name of ['GIO_FOUND', 'PULSEAUDIO_FOUND', 'XCB_XINPUT_FOUND', 'ENABLE_WAYLAND'])
      obsconfig = obsconfig.replace(`#cmakedefine ${name}`, `/* ${name} is not enabled. */`);
    obsconfig = obsconfig.replaceAll('@OBS_RELEASE_CANDIDATE@', '0').replaceAll('@OBS_BETA@', '0');
    assert.ok(!obsconfig.includes('@') && !obsconfig.includes('#cmakedefine'));
    write(path.join(generated, 'obsconfig.h'), obsconfig);
    const definitions = path.join(generated, 'module-defines.h');
    write(definitions, '#pragma once\n#define OBS_VERSION "32.1.1"\n' +
      '#define OBS_INSTALL_PREFIX "."\n');
    const stockFiles = [...runtimeInputs.files, ...additionalInputs.files];
    const byPath = new Map(stockFiles.map(file => [file.path, file]));
    assert.equal(byPath.size, stockFiles.length, 'Duplicate capture runtime pins.');
    const selected = new Map();
    const select = relative => {
      if (selected.has(relative)) return;
      const record = byPath.get(relative);
      assert.ok(record, `Unpinned runtime dependency: ${relative}`);
      verify(path.join(stock, relative), record);
      selected.set(relative, record);
    };
    const importLibraries = [];
    for (const name of ['obs', 'w32-pthreads']) {
      const relative = path.join('bin', '64bit', `${name}.dll`);
      select(relative);
      const exports = execute(path.join(compiler, 'dumpbin.exe'),
        ['/nologo', '/exports', path.join(stock, relative)], { capture: true });
      const names = [...exports.matchAll(/^\s+\d+\s+[a-f0-9]+\s+[a-f0-9]+\s+([a-z_][a-z0-9_]*)(?:[ \t]+= [^\r\n]*)?[ \t]*\r?$/gmi)]
        .map(match => match[1]);
      assert.ok(names.length > 50 && new Set(names).size === names.length);
      assert.equal(names.length, Number(exports.match(/(\d+) number of names/u)?.[1]));
      const definition = path.join(generated, `${name}.def`), library = path.join(generated, `${name}.lib`);
      write(definition, `LIBRARY ${name}.dll\nEXPORTS\n${names.map(value => `  ${value}`).join('\n')}\n`);
      run(`imports-${name}`, `lib /nologo /machine:x64 /def:${quote(definition)} /out:${quote(library)}`);
      importLibraries.push(library);
    }
    const objects = path.join(buildDirectory, 'module-objects');
    fs.mkdirSync(objects, { recursive: true });
    const names = ['app-helpers', 'audio-helpers', 'compat-helpers', 'cursor-capture', 'dc-capture', 'load-graphics-offsets',
      'monitor-capture', 'nt-stuff', 'window-capture'];
    const specialized = [];
    for (const [name, bind] of [['game-capture', bindGameSource], ['duplicator-monitor-capture', bindMonitorSource]]) {
      const filename = path.join(generated, `${name}-bound.c`);
      write(filename, bind(fs.readFileSync(path.join(vendor, 'plugins', 'win-capture', `${name}.c`), 'utf8')));
      specialized.push(filename);
    }
    const moduleSources = [...names.map(name => path.join(vendor, 'plugins', 'win-capture', `${name}.c`)),
      ...specialized, path.join(source, 'sourceBinding.c'), path.join(source, 'wgc-plugin-main.c'),
      path.join(vendor, 'libobs', 'util', 'windows', 'obfuscate.c'),
      path.join(vendor, 'shared', 'obs-inject-library', 'inject-library.c'),
      path.join(vendor, 'shared', 'ipc-util', 'ipc-util', 'pipe-windows.c')];
    const includes = [generated, source, path.join(vendor, 'plugins', 'win-capture'), path.join(vendor, 'libobs'),
      path.join(vendor, 'libobs-winrt'), path.join(vendor, 'deps', 'w32-pthreads'),
      ...['obs-hook-config', 'obs-inject-library', 'ipc-util', 'file-updater'].map(name => path.join(vendor, 'shared', name)),
      path.join(dependencies, 'include')];
    const module = path.join(buildDirectory, 'win-capture.dll');
    compile('module', ['/nologo', '/LD', '/TC', '/std:c17', '/O2', '/MD', '/W3', '/WX', '/utf-8',
      '/Zc:preprocessor', '/Brepro', '/DNOMINMAX', '/DUNICODE', '/D_UNICODE', '/D_WIN32_WINNT=0x0A00',
      '/DWINVER=0x0A00', '/D_CRT_SECURE_NO_WARNINGS', '/D_CRT_NONSTDC_NO_WARNINGS',
      `/FI${quote(definitions)}`, ...includes.map(value => `/I${quote(value)}`), ...moduleSources.map(quote),
      `/Fo${quote(objects + path.sep)}`, `/Fe${quote(module)}`, '/link', '/INCREMENTAL:NO', '/OPT:REF', '/OPT:ICF', '/IGNORE:4098', '/WX',
      ...importLibraries.map(quote),
      quote(path.join(dependencies, 'lib', 'jansson.lib')),
      'user32.lib', 'gdi32.lib', 'shell32.lib', 'advapi32.lib', 'kernel32.lib']);
    const moduleExports = execute(path.join(compiler, 'dumpbin.exe'), ['/nologo', '/exports', module], { capture: true });
    for (const name of ['monky_configure_capture_startup', 'monky_bind_game_target', 'monky_bind_monitor_target',
      'obs_module_load', 'obs_module_unload', 'obs_module_ver'])
      assert.ok(new RegExp(`\\b${name}\\b`, 'u').test(moduleExports), `Missing capture module export: ${name}`);

    const dlls = new Map(runtimeInputs.files.filter(file => file.path.startsWith('bin\\64bit\\'))
      .map(file => [path.basename(file.path).toLowerCase(), file.path]));
    const inspected = new Set(), systemDependencies = new Set(), selectedCrt = new Map();
    const inspect = filename => {
      if (inspected.has(filename)) return;
      inspected.add(filename);
      const output = execute(path.join(compiler, 'dumpbin.exe'), ['/nologo', '/dependents', filename], { capture: true });
      for (const [, name] of output.matchAll(/^[ \t]+([\w.-]+\.dll)[ \t]*\r?$/gmi)) {
        const relative = dlls.get(name.toLowerCase());
        if (relative) { select(relative); inspect(path.join(stock, relative)); }
        else if (crt.files.has(name.toLowerCase())) {
          const filename = crt.files.get(name.toLowerCase());
          selectedCrt.set(name.toLowerCase(), filename);
          inspect(filename);
        } else {
          assert.ok(!/^(?:msvcp|vcruntime|concrt|vccorlib)\d/iu.test(name),
            `A Visual C++ runtime must be distributed app-local: ${name}`);
          assert.ok(/^api-ms-win-/iu.test(name) || fs.existsSync(path.join(process.env.SystemRoot, 'System32', name)),
            `A non-system dependency was not provisioned: ${name}`);
          systemDependencies.add(name.toLowerCase());
        }
      }
    };
    for (const relative of ['bin\\64bit\\obs.dll', 'bin\\64bit\\libobs-d3d11.dll', 'bin\\64bit\\libobs-winrt.dll',
      'bin\\64bit\\obs-amf-test.exe', 'bin\\64bit\\obs-nvenc-test.exe',
      'bin\\64bit\\obs-qsv-test.exe',
      'obs-plugins\\64bit\\obs-ffmpeg.dll', 'obs-plugins\\64bit\\obs-nvenc.dll',
      ...['32', '64'].flatMap(arch => ['graphics-hook' + arch + '.dll',
        'inject-helper' + arch + '.exe', 'get-graphics-offsets' + arch + '.exe']
        .map(name => path.join('data', 'obs-plugins', 'win-capture', name)))]) {
      select(relative); inspect(path.join(stock, relative));
    }
    inspect(module);
    for (const file of stockFiles) {
      if (file.path.startsWith('data\\libobs\\') ||
        /^data\\obs-plugins\\(?:win-capture|obs-ffmpeg|obs-nvenc)\\locale\\en-US\.ini$/u.test(file.path) ||
        /^data\\obs-plugins\\win-capture\\(?:compatibility|package)\.json$/u.test(file.path) ||
        file.path.startsWith('data\\obs-plugins\\win-capture\\schema\\')) select(file.path);
    }
    const runtime = [...selected.values()].sort((a, b) => a.path.localeCompare(b.path));
    assert.ok(runtime.every(file => !/Qt6|obs-vulkan|obs64\.exe/iu.test(file.path)),
      'GUI and global Vulkan installer files do not belong in the explicit capture runtime.');
    const modulePin = fingerprint(module);
    write(path.join(generated, 'runtime-pins.h'),
      '#pragma once\n#include <cstdint>\nnamespace monky::screen_capture {\n' +
      'struct RuntimePin { const wchar_t* relative; std::uint64_t bytes; const char* sha256; };\n' +
      `inline constexpr RuntimePin kCaptureModule{L"obs-plugins\\\\64bit\\\\win-capture.dll", ${modulePin.bytes}ULL, "${modulePin.sha256}"};\n` +
      'inline constexpr RuntimePin kRuntimeFiles[] = {\n' +
      runtime.map(file => `  {L${JSON.stringify(file.path)}, ${file.bytes}ULL, "${file.sha256}"},`).join('\n') + '\n};\n}\n');
    const executable = path.join(buildDirectory, 'monky-screen-capture.exe');
    const tests = path.join(buildDirectory, 'capture-contract-test.exe');
    for (const [name, input, output] of [['host', 'host.cpp', executable], ['contracts', 'contractTest.cpp', tests]]) {
      compile(name, ['/nologo', '/std:c++20', '/EHsc', '/MD', '/W4', '/WX', '/O2', '/utf-8', '/Brepro',
        `/I${quote(generated)}`, `/I${quote(path.join(dependencies, 'include'))}`,
        quote(path.join(source, input)), `/Fo${quote(path.join(buildDirectory, `${name}.obj`))}`,
        `/Fe${quote(output)}`, '/link', '/INCREMENTAL:NO', 'bcrypt.lib', 'd3d11.lib', 'dxgi.lib', 'user32.lib', 'ole32.lib']);
    }
    inspect(executable);
    const contracts = JSON.parse(execute(tests, [], { capture: true }));
    assert.ok(contracts.deviceFree && contracts.checks >= 60 && contracts.headerBytes === 96);
    const platformProbe = JSON.parse(execute(tests, ['--platform-probe'], { capture: true }));
    assert.equal(platformProbe.deviceFree, true); assert.equal(platformProbe.synthetic, true);
    assert.equal(platformProbe.messages.length, 24);
    const protocol = require('../runtime/captureProtocol.cjs');
    for (const [index, message] of platformProbe.messages.entries()) {
      protocol.validateMessage(message);
      if (index % 4) protocol.validateProgress(platformProbe.messages[index - 1], message);
    }
    contracts.crossLanguagePlatformMessages = platformProbe.messages.length;
    const encoderProbe = JSON.parse(execute(tests, ['--encoder-probe-contract'], { capture: true }));
    assert.equal(encoderProbe.deviceFree, true); assert.equal(encoderProbe.synthetic, true);
    assert.equal(encoderProbe.messages.length, 8);
    for (const [index, message] of encoderProbe.messages.entries()) {
      protocol.validateEncoderProbeMessage(message);
      if (index % 4 === 1) protocol.validateEncoderProbeProgress(encoderProbe.messages[index - 1], message);
    }
    contracts.crossLanguageEncoderProbeMessages = encoderProbe.messages.length;
    for (const file of inputs.files) verify(path.join(vendor, file.path), file);
    for (const file of runtime) verify(path.join(stock, file.path), file);
    for (const file of sourceFiles) verify(path.join(source, file.path), file);
    const bin = config.output ?? path.join(root, 'bin', 'win32-x64');
    for (const file of runtime) write(path.join(bin, 'obs', file.path), fs.readFileSync(path.join(stock, file.path)));
    for (const probe of ['obs-amf-test.exe', 'obs-nvenc-test.exe'])
      write(path.join(bin, probe), fs.readFileSync(path.join(stock, 'bin', '64bit', probe)));
    write(path.join(bin, 'monky-screen-capture.exe'), fs.readFileSync(executable));
    write(path.join(bin, 'obs-plugins', '64bit', 'win-capture.dll'), fs.readFileSync(module));
    write(path.join(bin, 'obs', 'COPYING'), fs.readFileSync(path.join(vendor, 'COPYING')));
    const redistributables = [];
    for (const [name, filename] of [...selectedCrt].sort(([a], [b]) => a.localeCompare(b))) {
      for (const relative of [name, path.join('obs', 'bin', '64bit', name)]) {
        write(path.join(bin, relative), fs.readFileSync(filename));
        redistributables.push({ path: relative, ...fingerprint(filename) });
      }
    }
    const report = {
      schemaVersion: 3, obsVersion: inputs.version, obsRevision: inputs.revision, runtime,
      sourceFiles,
      sourceBindingRecipe: fingerprint(path.join(__dirname, 'captureSourceBindings.cjs')),
      crt: { version: crt.version, files: redistributables },
      host: { path: 'monky-screen-capture.exe', ...fingerprint(executable) },
      module: { path: 'obs-plugins\\64bit\\win-capture.dll', ...modulePin },
      source: fingerprint(path.join(source, 'wgc-plugin-main.c')), systemDependencies: [...systemDependencies].sort(),
      contracts, commands, configuration: {
        captureKinds: ['window', 'monitor', 'game'], encoders: ['h264_texture_amf', 'obs_nvenc_h264_tex'],
        encoderProbe: 'source-free-hardware-initialization',
        gameCaptureStartup: 'explicit-game-target-only', compatibilityUpdater: false,
        globalVulkanHook: false, hardwareQualified: false, scaleMode: 'stretch',
      },
    };
    write(path.join(bin, 'capture-build.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ captureBuilt: true, checks: contracts.checks, runtimeFiles: runtime.length,
      runtimeBytes: runtime.reduce((sum, file) => sum + file.bytes, 0), host: report.host, module: report.module }));
    return report;
  } finally {
    fs.closeSync(handle); fs.unlinkSync(lock);
  }
}

module.exports = { options, build };
if (require.main === module) {
  try { build(options(process.argv.slice(2))); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
