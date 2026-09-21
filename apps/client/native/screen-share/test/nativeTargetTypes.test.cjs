'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');
const { validateCaptureTarget, probeCaptureCapabilities } = require(path.resolve(__dirname, '..', 'index.cjs'));

test('the public source-free probe export is the native-owned implementation, without invoking it', () => {
  assert.equal(typeof probeCaptureCapabilities, 'function');
  assert.equal(probeCaptureCapabilities,
    require(path.resolve(__dirname, '..', 'runtime', 'captureBridge.cjs')).probeCaptureCapabilities);
});

test('the public target validator returns the original explicit or legacy input without freezing it', () => {
  const targets = [
    { hwnd: 123, expectedProcessId: 456 },
    { kind: 'window', hwnd: 123, expectedProcessId: 456, expectedProcessCreationTime100ns: '789' },
    { kind: 'game', hwnd: 123, expectedProcessId: 456, expectedProcessCreationTime100ns: '789' },
    { kind: 'monitor', deviceId: String.raw`\\?\DISPLAY#SELECTED#ONE`, deviceName: String.raw`\\.\DISPLAY2`,
      bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
  ];
  for (const target of targets) {
    assert.equal(validateCaptureTarget(target), target);
    assert.equal(Object.isFrozen(target), false);
    if (target.kind === 'monitor') assert.equal(Object.isFrozen(target.bounds), false);
  }
  for (const kind of ['window', 'game'])
    assert.throws(() => validateCaptureTarget({ kind, hwnd: 123, expectedProcessId: 456 }));
  assert.throws(() => validateCaptureTarget({ ...targets[3], name: 'Metadata is not a capture target', isPrimary: true }));
});

test('capture declarations preserve exact target and source-free initialization contracts', () => {
  const filename = path.resolve(__dirname, 'native-target-types.fixture.ts');
  const source = `
    import { validateCaptureTarget, probeCaptureCapabilities, type CaptureBridge,
      type NativeScreenEndpointOptions, type NativeScreenCaptureProbeOptions } from '@monky/screen-share';
    declare const bridge: CaptureBridge;
    declare const input: unknown;
    const windowTarget = validateCaptureTarget({ kind: 'window', hwnd: 123, expectedProcessId: 456,
      expectedProcessCreationTime100ns: '789' });
    const gameTarget = validateCaptureTarget({ kind: 'game', hwnd: 123, expectedProcessId: 456,
      expectedProcessCreationTime100ns: '789' });
    const monitorTarget = validateCaptureTarget({ kind: 'monitor', deviceId: 'device', deviceName: 'name',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 } });
    const windowKind: 'window' = windowTarget.kind;
    const gameKind: 'game' = gameTarget.kind;
    const monitorKind: 'monitor' = monitorTarget.kind;
    const birth: string = gameTarget.expectedProcessCreationTime100ns;
    const width: number = monitorTarget.bounds.width;
    const legacy = validateCaptureTarget({ hwnd: 123, expectedProcessId: 456 });
    const hwnd: number = legacy.hwnd;
    void bridge.prepare(legacy);
    void bridge.start(legacy);
    void bridge.prepare(windowTarget);
    void bridge.start(gameTarget);
    void bridge.prepare(monitorTarget);
    const checked = validateCaptureTarget(input);
    if (checked.kind === 'monitor') {
      const deviceId: string = checked.deviceId;
    } else {
      const processId: number = checked.expectedProcessId;
    }
    const legacyEndpoint: NativeScreenEndpointOptions['target'] = legacy;
    const windowEndpoint: NativeScreenEndpointOptions['target'] = windowTarget;
    // @ts-expect-error Explicit window capture still requires exact process birth.
    void bridge.prepare({ kind: 'window', hwnd: 123, expectedProcessId: 456 });
    // @ts-expect-error Explicit Game Capture is never the legacy window variant.
    void bridge.start({ kind: 'game', hwnd: 123, expectedProcessId: 456 });
    // @ts-expect-error Endpoint targets keep the same strict explicit-kind contract.
    const missingBirth: NativeScreenEndpointOptions['target'] = { kind: 'window', hwnd: 123, expectedProcessId: 456 };
    declare const probeOptions: NativeScreenCaptureProbeOptions;
    declare const signal: AbortSignal;
    declare const proof: Awaited<ReturnType<typeof probeCaptureCapabilities>>;
    const pendingProof: Promise<typeof proof> = probeCaptureCapabilities(probeOptions, signal);
    const initialized: true = proof.encoderInitialized;
    const verified: true = proof.probeVerified;
    const captured: false = proof.sourceCaptured;
    const hardwareSession: false = proof.hardwareSessionConfirmed;
    const qualified: false = proof.hardwareQualified;
    const kinds: readonly ['window', 'monitor', 'game'] = proof.captureKinds;
    const observedBitrate: number = proof.video.bitrateKbps;
    // @ts-expect-error A source-free probe cannot receive a selected target.
    void probeCaptureCapabilities({ ...probeOptions, target: windowTarget });
    // @ts-expect-error A source-free probe cannot receive a media packet callback.
    void probeCaptureCapabilities({ ...probeOptions, onPacket: () => undefined });
    // @ts-expect-error Probe failures reject; no observer callback is an accepted option.
    void probeCaptureCapabilities({ ...probeOptions, onError: () => {} });
    // @ts-expect-error The returned profile is an immutable verified observation.
    proof.video.bitrateKbps = 20000;
    // @ts-expect-error Implementation kinds cannot be appended after verification.
    proof.captureKinds.push('game');
  `;
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true,
    exactOptionalPropertyTypes: true, skipLibCheck: true, noEmit: true, types: ['node'] };
  const host = ts.createCompilerHost(options), getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) => path.resolve(name) === filename
    ? ts.createSourceFile(name, source, options.target, true) : getSourceFile(name, ...args);
  host.writeFile = () => assert.fail('Type contracts must not emit files.');
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => '\n',
  }));
});
