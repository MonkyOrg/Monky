import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_CUSTOM_PROFILE, QUALITY_PRESETS, type DesktopSource, type NativeScreenCapabilities, type NativeScreenCaptureKind,
  type QualityPresetType,
} from '@monky/shared';
import { applyMediaEncodingPolicy, getMediaEncodingPolicy } from '../src/renderer/core/webrtc/mediaEncodingPolicy';
import { updateRtpSenderParameters } from '../src/renderer/core/webrtc/rtpSenderParameters';
import {
  canCaptureNatively, captureUnavailableMessage, planAudio, sourceMatchesTab, supportsCaptureKind, supportsTab,
  type CaptureContext, type LiveScreens,
} from '../src/renderer/views/screenShare/captureRules';
import { setLanguage, t } from '../src/renderer/i18n';
import './screenSubscriptions.test';

function parameters(): RTCRtpSendParameters {
  return {
    transactionId: 'negotiation',
    codecs: [{ mimeType: 'video/H264', clockRate: 90000, payloadType: 102 }],
    headerExtensions: [],
    rtcp: { cname: 'camera', reducedSize: true },
    encodings: [{ active: false, rid: 'camera', priority: 'high', scaleResolutionDownBy: 1 }],
  };
}

function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, resolve: () => release() };
}

test('all presets and custom use one per-publication audio/camera encoding policy', () => {
  const presets: QualityPresetType[] = ['ECONOMIC', 'NORMAL', 'HIGH', 'GAMING', 'QHD', 'UHD', 'UHD120', 'CUSTOM'];
  for (const preset of presets) {
    const profile = preset === 'CUSTOM' ? DEFAULT_CUSTOM_PROFILE : QUALITY_PRESETS[preset];
    const audio = getMediaEncodingPolicy('audio', preset, profile);
    const camera = getMediaEncodingPolicy('camera', preset, profile);
    assert.deepEqual(audio, { encoding: { maxBitrate: profile.audioBitrateKbps * 1000 } });
    assert.deepEqual(camera.encoding, { maxBitrate: profile.cameraBitrateKbps * 1000, maxFramerate: profile.cameraFps });
    assert.equal(camera.degradationPreference, ['GAMING', 'QHD', 'UHD', 'UHD120'].includes(preset)
      ? 'maintain-framerate' : 'maintain-resolution', 'Named 60+ FPS profiles hold frame rate; CUSTOM keeps resolution.');
  }
});

test('quality preserves paused state, negotiation metadata and auxiliary encodings', () => {
  const params = parameters();
  params.encodings.push({ active: false, rid: 'other', maxBitrate: 42 });
  const before = structuredClone(params);
  const policy = getMediaEncodingPolicy('camera', 'GAMING', QUALITY_PRESETS.GAMING);
  assert.equal(applyMediaEncodingPolicy(params, policy), true);
  assert.deepEqual(params, {
    ...before, degradationPreference: 'maintain-framerate',
    encodings: [{ ...before.encodings[0], ...policy.encoding }, before.encodings[1]],
  });
  const empty = { ...parameters(), encodings: [] };
  assert.equal(applyMediaEncodingPolicy(empty, policy), false);
  assert.deepEqual(empty.encodings, [], 'setParameters cannot invent a negotiated encoding');
});

test('quality is a snapshot even if the custom profile changes while an update is queued', () => {
  const profile = { ...DEFAULT_CUSTOM_PROFILE };
  const policy = getMediaEncodingPolicy('camera', 'CUSTOM', profile);
  profile.cameraBitrateKbps = 1;
  profile.cameraFps = 1;
  assert.equal(policy.encoding.maxBitrate, DEFAULT_CUSTOM_PROFILE.cameraBitrateKbps * 1000);
  assert.equal(policy.encoding.maxFramerate, DEFAULT_CUSTOM_PROFILE.cameraFps);
});

test('updates share a sender transaction queue without blocking other senders', async () => {
  let current = parameters();
  const events: string[] = [];
  const writing = gate();
  const release = gate();
  let writes = 0;
  const sender = {
    getParameters() { events.push('read'); return structuredClone(current); },
    async setParameters(value: RTCRtpSendParameters) {
      events.push(`write-${++writes}`);
      if (writes === 1) { writing.resolve(); await release.promise; }
      current = structuredClone(value);
    },
  };
  const activating = updateRtpSenderParameters(sender, params => {
    params.encodings[0].active = true;
    return true;
  });
  await writing.promise;
  const settingQuality = updateRtpSenderParameters(sender, params =>
    applyMediaEncodingPolicy(params, getMediaEncodingPolicy('camera', 'HIGH', QUALITY_PRESETS.HIGH)));
  let independentWritten = false;
  await updateRtpSenderParameters({
    getParameters: parameters,
    async setParameters() { independentWritten = true; },
  }, () => true);
  assert.equal(independentWritten, true);
  assert.equal(writes, 1);
  release.resolve();
  await Promise.all([activating, settingQuality]);
  assert.deepEqual(events, ['read', 'write-1', 'read', 'write-2']);
  assert.equal(current.encodings[0].active, true, 'the queued update reads the committed write instead of overwriting it');
  assert.equal(current.encodings[0].maxBitrate, QUALITY_PRESETS.HIGH.cameraBitrateKbps * 1000);
});

test('sender failures reach callers without poisoning later updates; cancellation skips writing', async () => {
  const failure = new Error('encoder unavailable');
  let writes = 0;
  const sender = {
    getParameters: parameters,
    async setParameters() { if (++writes === 1) throw failure; },
  };
  await assert.rejects(updateRtpSenderParameters(sender, () => true), error => error === failure);
  await updateRtpSenderParameters(sender, () => true);
  await updateRtpSenderParameters(sender, () => false);
  assert.equal(writes, 2);
});

const capabilities = (value: Partial<NativeScreenCapabilities> = {}): NativeScreenCapabilities => ({
  capture: true, captureAudio: true, receive: true, captureKinds: ['window', 'monitor', 'game'], backend: 'libobs-amf', reason: null,
  ...value,
});

/** Live shares by id: the kind each one captures and the desktop source it came from. */
function live(shares: Record<string, { kind: NativeScreenCaptureKind; source: string; audio?: boolean; settingUp?: boolean }>): LiveScreens {
  const entries = Object.entries(shares);
  return {
    shareIds: entries.filter(([, share]) => !share.settingUp).map(([id]) => id),
    audioShareIds: entries.filter(([, share]) => share.audio).map(([id]) => id),
    capture: shareId => shares[shareId] ? { captureKind: shares[shareId].kind, desktopSourceId: shares[shareId].source } : null,
  };
}

const appWindow = (id: string, processId?: number, processAncestry?: number[]): DesktopSource => ({
  id: `window:${id}:0`, type: 'window', name: id, thumbnailDataUrl: '', appIconDataUrl: null,
  ...(processId === undefined ? {} : { processId }), ...(processAncestry ? { processAncestry } : {}),
});
const monitor: DesktopSource = { id: `native-monitor:${'1'.repeat(64)}`, type: 'screen', name: 'Screen', thumbnailDataUrl: '', appIconDataUrl: null };

test('capture methods follow the declared kinds; legacy capabilities only ever enable windows', () => {
  assert.equal(supportsTab(null, 'window'), false);
  assert.equal(supportsTab(capabilities({ captureKinds: undefined }), 'window'), true);
  assert.equal(supportsTab(capabilities({ captureKinds: undefined }), 'screen'), false, 'No monitor support is assumed');
  assert.equal(supportsTab(capabilities({ captureKinds: [] }), 'window'), false);
  assert.equal(supportsTab(capabilities({ captureKinds: ['game'] }), 'window'), true, 'Game Capture alone still lists windows');
  assert.equal(supportsCaptureKind(capabilities({ capture: false }), 'window'), false);
  assert.equal(supportsCaptureKind(capabilities({ capture: false, requiresSelectionProbe: true, captureKinds: ['monitor'] }), 'monitor'), true,
    'A selection probe needs its explicit flag and declared kinds');
  assert.equal(supportsCaptureKind(capabilities({ capture: false, requiresSelectionProbe: true, captureKinds: undefined }), 'window'), false);
  assert.equal(sourceMatchesTab(monitor, 'screen'), true);
  assert.equal(sourceMatchesTab({ ...monitor, id: 'screen:1:0' }, 'screen'), false, 'Electron display ids are not native monitors');
  assert.equal(sourceMatchesTab(appWindow('a'), 'window'), true);
  assert.equal(sourceMatchesTab(appWindow('a'), 'screen'), false);
});

test('a whole screen\'s sound leaves no room for other sound; applications each share their own (#253)', () => {
  const add = (kind: NativeScreenCaptureKind, source: DesktopSource, sources: DesktopSource[] = []) =>
    ({ mode: 'add' as const, kind, source, sources });
  assert.deepEqual(planAudio(add('monitor', monitor), live({}), false), { kind: 'free', handedOver: [] });
  const screenWithSound = live({ screen: { kind: 'monitor', source: monitor.id, audio: true } });
  assert.deepEqual(planAudio(add('window', appWindow('b')), screenWithSound, false), { kind: 'blocked', reason: 'system' });
  assert.deepEqual(planAudio(add('window', appWindow('b')), screenWithSound, true), { kind: 'blocked', reason: 'mac' });
  assert.deepEqual(planAudio({ mode: 'replace', kind: 'window', source: appWindow('b'), sources: [] }, screenWithSound, false),
    { kind: 'free', handedOver: ['screen'] }, 'The share being replaced hands its sound over');
  const appWithSound = live({ app: { kind: 'window', source: appWindow('a', 10).id, audio: true }, silent: { kind: 'game', source: appWindow('c').id } });
  assert.deepEqual(planAudio(add('monitor', monitor), appWithSound, false), { kind: 'ask', apps: ['app'], handedOver: [] });
  assert.deepEqual(planAudio({ mode: 'replace', targetShareId: 'silent', kind: 'monitor', source: monitor, sources: [] }, appWithSound, false),
    { kind: 'ask', apps: ['app'], handedOver: [] }, 'Only the share that is switched hands its sound over');
  assert.deepEqual(planAudio(add('window', appWindow('b', 20), [appWindow('a', 10)]), appWithSound, false), { kind: 'free', handedOver: [] });
  assert.deepEqual(planAudio(add('window', appWindow('b', 10), [appWindow('a', 10)]), appWithSound, false),
    { kind: 'blocked', reason: 'app' }, 'Another window of the same application');
  assert.deepEqual(planAudio(add('game', appWindow('game', 30, [10]), [appWindow('a', 10)]), appWithSound, false),
    { kind: 'blocked', reason: 'app' }, 'A game opened by the launcher already sharing its sound');
  assert.deepEqual(planAudio(add('window', appWindow('launcher', 10), [appWindow('a', 30, [10])]),
    live({ game: { kind: 'game', source: appWindow('a', 30, [10]).id, audio: true } }), false),
  { kind: 'blocked', reason: 'app' }, 'The launcher of a game already sharing its sound');
  assert.deepEqual(planAudio(add('window', appWindow('b')), live({ pending: { kind: 'window', source: 'x', audio: true, settingUp: true } }), false),
    { kind: 'blocked', reason: 'system' }, 'Sound held by a share still being set up blocks everything');
});

test('native capture is explained by its first missing condition, in the app\'s language', () => {
  setLanguage('en');
  const context = (value: Partial<CaptureContext> = {}): CaptureContext => ({
    capabilities: capabilities(), loading: false, ownWindow: false, unownedAudio: false, profileAvailable: true, ...value,
  });
  assert.equal(canCaptureNatively(appWindow('a').id, true, 'window', context()), true);
  assert.equal(canCaptureNatively(monitor.id, true, 'window', context()), false, 'The id must match the method');
  assert.equal(canCaptureNatively(appWindow('a').id, true, 'window', context({ ownWindow: true })), false);
  assert.equal(canCaptureNatively(appWindow('a').id, false, 'window', context({ ownWindow: true })), true, 'Only Monky\'s own sound is refused');
  assert.equal(canCaptureNatively(appWindow('a').id, true, 'window', context({ capabilities: capabilities({ captureAudio: false }) })), false);
  assert.equal(canCaptureNatively(appWindow('a').id, false, 'window', context({ profileAvailable: false })), false);
  const message = (audio: boolean, value: Partial<CaptureContext>, kind: NativeScreenCaptureKind = 'window') =>
    captureUnavailableMessage(audio, kind, context(value));
  assert.equal(message(true, { ownWindow: true, capabilities: null }), t('screenShare.ownWindowAudioUnavailable'));
  assert.equal(message(false, { capabilities: null, loading: true }), t('common.loading'));
  assert.equal(message(false, { capabilities: capabilities({ capture: false, reason: 'encoder' }) }), t('screenShare.nativeEncoderUnavailable'));
  assert.equal(message(false, { capabilities: capabilities({ capture: false, reason: 'runtime' }) }), t('screenShare.nativeUnavailable'));
  assert.equal(message(false, { capabilities: null }), t('screenShare.platformSoon'));
  assert.equal(message(false, { capabilities: capabilities({ captureKinds: ['window'] }) }, 'game'),
    t('screenShare.captureMethodUnavailable', { method: t('screenShare.gameCapture') }));
  assert.equal(message(true, { unownedAudio: true }), t('screenShare.audioAlreadySharing'));
  assert.equal(message(true, { capabilities: capabilities({ captureAudio: false }) }), t('screenShare.nativeAudioUnavailable'));
  assert.equal(message(false, { profileAvailable: false }), t('screenShare.nativeProfileChangeBlocked'));
});