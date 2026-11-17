import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { screenShareIdSchema,
  browserScreenCommandSchema, nativeScreenCommandSchema, nativeScreenP2pControlSchema,
  type NativeScreenP2pControl,
} from '@monky/shared';
import {
  browserScreenFormats, browserScreenProfile, browserSourceProfile, encoderScaleDown, h264Level31Profile, isScreenCodec,
  screenSenderCodecs,
} from '../src/renderer/platform/web/webScreen/browserScreenProfile';
import { sameMediaBinding, sentMediaBinding, withScreenStreamId, withoutVideoOrientation } from '../src/renderer/platform/web/webScreen/screenSdp';
import {
  SCREEN_P2P_LIMITS, ScreenP2pPublisherPeer,
  type ScreenIceCandidate, type ScreenMediaKind, type ScreenPeerPort,
} from '../src/renderer/platform/web/webScreen/screenP2pPublisherPeer';
import type { ScreenMediaBinding } from '../src/renderer/platform/web/webScreen/screenSdp';
import { planBrowserAudio, type LiveScreens } from '../src/renderer/views/screenShare/captureRules';
import { createScreenShareStream } from '../src/renderer/core/screenShareStream';
import { webScreenCapabilities } from '../src/renderer/platform/web/webScreen/webScreenRuntime';
import { webCapabilities } from '../src/renderer/platform/web/webPlatform';
import {
  aliasH264MainOffer, browserAliasesH264Main, browserReceivesH264Main, browserReceivesScreenCodec, browserScreenRefusal,
  restoreH264MainAnswer,
} from '../src/renderer/core/webrtc/browserScreenCodecs';

const INSTANCE = '3dfbff6f-6556-49cb-be32-1a6699d242a1';
const CONNECTION = '74439c45-0865-42d3-9577-d4e451504e8c';
const CHANNEL = '98aac683-8f99-4f12-ad3c-f31f3eefcebf';
const SHARE = 'share-1';

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve)).then(() => new Promise(resolve => setImmediate(resolve)));

class FakePort implements ScreenPeerPort {
  public readonly operations: string[] = [];
  public readonly sending = new Map<ScreenMediaKind, boolean>();
  public local: 'offer' | 'answer' | null = null;
  public closed = false;
  public createLocal(type: 'offer' | 'answer'): Promise<string> {
    this.local = type;
    this.operations.push(`local:${type}`);
    return Promise.resolve(`sdp-${type}`);
  }
  public setRemote(type: 'offer' | 'answer', sdp: string): Promise<void> {
    this.operations.push(`remote:${type}:${sdp}`);
    return Promise.resolve();
  }
  public addIceCandidate(candidate: ScreenIceCandidate): Promise<void> {
    this.operations.push(`ice:${candidate.candidate}`);
    return Promise.resolve();
  }
  public binding(kind: ScreenMediaKind): ScreenMediaBinding | null {
    return this.local ? { trackId: `${kind}-track`, mid: kind === 'video' ? '0' : '1', streamIds: [INSTANCE] } : null;
  }
  public setSending(kind: ScreenMediaKind, sending: boolean): Promise<void> {
    this.sending.set(kind, sending);
    return Promise.resolve();
  }
  public close(): void { this.closed = true; }
}

function fixture(options: { sessionId: string; viewerSessionId: string; audio: boolean; generation?: number }) {
  const port = new FakePort();
  const sent: NativeScreenP2pControl[] = [];
  const errors: unknown[] = [];
  const generation = options.generation ?? 1;
  const peer = new ScreenP2pPublisherPeer({
    sessionId: options.sessionId, viewerSessionId: options.viewerSessionId, channelId: CHANNEL, shareId: SHARE,
    sourceInstanceId: INSTANCE, audio: options.audio, connectionId: CONNECTION, generation, port,
    send: control => { sent.push(control); return Promise.resolve(); },
    onError: error => { errors.push(error); },
  });
  const version = options.audio ? 2 : 1;
  const control = (body: Record<string, unknown>): NativeScreenP2pControl => nativeScreenP2pControlSchema.parse({
    protocol: 'monky-native-screen-p2p', version, callId: INSTANCE, channelId: CHANNEL, connectionId: CONNECTION,
    generation, ...body,
  });
  return { peer, port, sent, errors, control };
}

const types = (sent: readonly NativeScreenP2pControl[]): string[] => sent.map(control => control.type);

test('the browser publisher, as pair leader, offers its screen and sends only what the viewer watches (#858)', async () => {
  const f = fixture({ sessionId: 'a-session', viewerSessionId: 'b-session', audio: true });
  f.peer.start();
  await flush();
  assert.deepEqual(types(f.sent), ['turn', 'publication', 'publication', 'offer']);
  const [turn, video, audio, offer] = f.sent;
  assert.ok(turn.type === 'turn' && turn.turn === 1 && turn.offererSessionId === 'a-session');
  assert.ok(video.type === 'publication' && video.version === 2 && video.kind === 'video' && video.syncGroup === INSTANCE
    && video.trackId === 'video-track' && video.mid === '0' && video.streamIds.includes(INSTANCE));
  assert.ok(audio.type === 'publication' && audio.version === 2 && audio.kind === 'audio' && audio.publicationId !== video.publicationId);
  assert.ok(offer.type === 'offer' && offer.sdp === 'sdp-offer');

  // A candidate that arrives before the answer waits for it.
  await f.peer.receive(f.control({ type: 'ice', turn: 1, candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }));
  assert.deepEqual(f.port.operations, ['local:offer']);
  await f.peer.receive(f.control({ type: 'answer', turn: 1, sdp: 'remote-answer' }));
  assert.deepEqual(f.port.operations, ['local:offer', 'remote:answer:remote-answer', 'ice:candidate:1']);
  assert.equal(f.sent.at(-1)?.type, 'turn-done');
  assert.equal(f.port.sending.size, 0, 'Nothing is sent before the viewer watches.');

  const identity = (publication: NativeScreenP2pControl) => publication.type === 'publication' ? {
    shareId: SHARE, publicationId: publication.publicationId, publicationVersion: publication.publicationVersion,
    metadataVersion: publication.metadataVersion,
  } : assert.fail('Expected a publication.');
  await f.peer.receive(f.control({ type: 'watch', kind: 'video', ...identity(video), subscriptionId: 1, revision: 1, watching: true }));
  assert.equal(f.port.sending.get('video'), true);
  assert.equal(f.peer.isSending('audio'), false);
  // Sound bound to another video subscription is not sent.
  const { shareId: _shareId, ...videoBinding } = identity(video);
  await f.peer.receive(f.control({ type: 'watch', kind: 'audio', ...identity(audio), subscriptionId: 2, revision: 2,
    watching: true, video: { ...videoBinding, subscriptionId: 1, revision: 9 } }));
  assert.equal(f.peer.isSending('audio'), false);
  await f.peer.receive(f.control({ type: 'watch', kind: 'audio', ...identity(audio), subscriptionId: 2, revision: 3,
    watching: true, video: { ...videoBinding, subscriptionId: 1, revision: 1 } }));
  assert.equal(f.port.sending.get('audio'), true);
  // An older revision changes nothing; stopping the video stops the sound bound to it.
  await f.peer.receive(f.control({ type: 'watch', kind: 'video', ...identity(video), subscriptionId: 1, revision: 1, watching: false }));
  assert.equal(f.port.sending.get('video'), true);
  await f.peer.receive(f.control({ type: 'watch', kind: 'video', ...identity(video), subscriptionId: 1, revision: 4, watching: false }));
  assert.equal(f.port.sending.get('video'), false);
  assert.equal(f.port.sending.get('audio'), false);
  assert.deepEqual(f.errors, []);
  await f.peer.close();
  assert.equal(f.port.closed, true);
});

test('the browser publisher asks the leading viewer for a turn before offering (#858)', async () => {
  const f = fixture({ sessionId: 'b-session', viewerSessionId: 'a-session', audio: false });
  f.peer.start();
  await flush();
  assert.deepEqual(types(f.sent), ['negotiate']);
  await f.peer.receive(f.control({ type: 'turn', turn: 1, offererSessionId: 'b-session' }));
  assert.deepEqual(types(f.sent), ['negotiate', 'publication', 'offer']);
  const publication = f.sent[1];
  assert.ok(publication.type === 'publication' && publication.version === 1 && !('kind' in publication));
  await f.peer.receive(f.control({ type: 'answer', turn: 1, sdp: 'answer' }));
  assert.equal(f.sent.at(-1)?.type, 'turn-applied');
  await f.peer.receive(f.control({ type: 'turn-done', turn: 1 }));
  // A repeated completion of a finished turn is ignored.
  await f.peer.receive(f.control({ type: 'turn-done', turn: 1 }));
  assert.deepEqual(f.errors, []);
  await f.peer.close();
});

test('the browser publisher answers a viewer that offers in its own granted turn (#858)', async () => {
  const f = fixture({ sessionId: 'b-session', viewerSessionId: 'a-session', audio: false });
  await f.peer.receive(f.control({ type: 'turn', turn: 1, offererSessionId: 'a-session' }));
  await f.peer.receive(f.control({ type: 'offer', turn: 1, sdp: 'viewer-offer' }));
  assert.deepEqual(f.port.operations, ['remote:offer:viewer-offer', 'local:answer']);
  assert.deepEqual(types(f.sent).slice(-2), ['publication', 'answer']);
  await f.peer.receive(f.control({ type: 'turn-done', turn: 1 }));
  assert.deepEqual(f.errors, []);
  await f.peer.close();
});

test('the browser publisher refuses controls of another connection or generation (#858)', async () => {
  const f = fixture({ sessionId: 'a-session', viewerSessionId: 'b-session', audio: false, generation: 2 });
  const stale = nativeScreenP2pControlSchema.parse({
    protocol: 'monky-native-screen-p2p', version: 1, callId: INSTANCE, channelId: CHANNEL, connectionId: CONNECTION,
    generation: 1, type: 'turn-done', turn: 1,
  });
  await assert.rejects(f.peer.receive(stale), /does not belong/);
  const other = nativeScreenP2pControlSchema.parse({ ...stale, generation: 2, connectionId: 'another-connection' });
  await assert.rejects(f.peer.receive(other), /does not belong/);
  // A leader never receives a turn grant from its viewer.
  await assert.rejects(f.peer.receive(f.control({ type: 'turn', turn: 1, offererSessionId: 'a-session' })), /leader grants/);
  await f.peer.close();
});

test('a negotiation turn that never finishes retires the viewer connection (#858)', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ sessionId: 'a-session', viewerSessionId: 'b-session', audio: false });
  f.peer.start();
  await flush();
  assert.equal(f.sent.at(-1)?.type, 'offer');
  t.mock.timers.tick(SCREEN_P2P_LIMITS.turnTimeoutMs);
  assert.equal(f.errors.length, 1);
  assert.match(String(f.errors[0]), /did not finish/);
  // A disconnection reported afterwards fails it only once.
  f.peer.connectionState('failed');
  assert.equal(f.errors.length, 1);
  await f.peer.close();
});

test('a viewer connection that stays disconnected fails after its grace period (#858)', async (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ sessionId: 'a-session', viewerSessionId: 'b-session', audio: false });
  f.peer.connectionState('disconnected');
  t.mock.timers.tick(SCREEN_P2P_LIMITS.disconnectedGraceMs - 1);
  f.peer.connectionState('connected');
  t.mock.timers.tick(SCREEN_P2P_LIMITS.disconnectedGraceMs);
  assert.deepEqual(f.errors, []);
  f.peer.connectionState('disconnected');
  t.mock.timers.tick(SCREEN_P2P_LIMITS.disconnectedGraceMs);
  assert.equal(f.errors.length, 1);
  await f.peer.close();
});

test('a browser capture announces the chosen quality fitted to what it captured (#858)', () => {
  const requested = { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 8000 };
  // A taller window keeps its shape inside the chosen box.
  assert.deepEqual({ ...browserScreenProfile(requested, { width: 2560, height: 1600, frameRate: 60 }) },
    { width: 1728, height: 1080, fps: 60, maxBitrateKbps: 8000 });
  // A small surface is never enlarged, and the frame rate is what the browser delivers.
  assert.deepEqual({ ...browserScreenProfile(requested, { width: 1279, height: 721, frameRate: 29.97 }) },
    { width: 1276, height: 720, fps: 30, maxBitrateKbps: 8000 });
  // Without settings the chosen quality stands.
  assert.deepEqual({ ...browserScreenProfile(requested, {}) }, requested);
});

test('an upright phone fills the chosen quality long side to long side, as a sideways one does', () => {
  const requested = { width: 852, height: 480, fps: 30, maxBitrateKbps: 1500 };
  // An iPhone held upright once shrank to 220×480 inside the landscape box.
  assert.deepEqual({ ...browserScreenProfile(requested, { width: 1206, height: 2622, frameRate: 30 }) },
    { width: 388, height: 852, fps: 30, maxBitrateKbps: 1500 });
  assert.deepEqual({ ...browserScreenProfile(requested, { width: 2622, height: 1206, frameRate: 30 }) },
    { width: 852, height: 390, fps: 30, maxBitrateKbps: 1500 });
  assert.deepEqual({ ...browserScreenProfile(requested, { width: 1920, height: 1080, frameRate: 30 }) },
    { width: 852, height: 478, fps: 30, maxBitrateKbps: 1500 });
});

const macroblocks = (width: number, height: number): number => Math.ceil(width / 16) * Math.ceil(height / 16);

test('a screen fitted to H.264 Level 3.1 keeps its shape inside 3600 macroblocks and 30 FPS at that size', () => {
  const fitted = h264Level31Profile({ width: 1920, height: 1080, fps: 60, maxBitrateKbps: 8000 });
  assert.deepEqual({ ...fitted }, { width: 1272, height: 716, fps: 30, maxBitrateKbps: 8000 });
  assert.ok(macroblocks(fitted.width, fitted.height) <= 3600);
  // An iPhone held upright fills the level as 720p does; a smaller screen keeps its frame rate.
  assert.deepEqual({ ...h264Level31Profile({ width: 720, height: 1280, fps: 30, maxBitrateKbps: 2500 }) },
    { width: 720, height: 1280, fps: 30, maxBitrateKbps: 2500 });
  assert.deepEqual({ ...h264Level31Profile({ width: 328, height: 720, fps: 60, maxBitrateKbps: 20000 }) },
    { width: 328, height: 720, fps: 60, maxBitrateKbps: 14000 });
});

test('Safari, and every browser on the iPhone, publishes screens its level 3.1 encoder emits; Chromium keeps the size', (t: TestContext) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });
  const as = (userAgent: string): void => { Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent } }); };
  const requested = { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 8000 };
  const display = { width: 2560, height: 1440, frameRate: 60 };
  as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Safari/605.1.15');
  assert.deepEqual({ ...browserSourceProfile(requested, display, 'compatible') }, { width: 1272, height: 716, fps: 30, maxBitrateKbps: 8000 });
  as('Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/146.0.0.0 Mobile/15E148 Safari/604.1');
  assert.deepEqual({ ...browserSourceProfile(requested, display, 'compatible') }, { width: 1272, height: 716, fps: 30, maxBitrateKbps: 8000 });
  as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36');
  assert.deepEqual({ ...browserSourceProfile(requested, display, 'compatible') }, requested);
  assert.deepEqual({ ...browserSourceProfile(requested, display, 'main') }, requested);
});

test('the encoder shrinks a copy the browser did not resize to its rendition, never enlarging it', () => {
  const rendition = { width: 328, height: 720, fps: 30, maxBitrateKbps: 2500 };
  const scale = encoderScaleDown({ width: 1206, height: 2622 }, rendition);
  assert.equal(scale, 1206 / 328);
  assert.ok(1206 / scale <= rendition.width && 2622 / scale <= rendition.height);
  // Turned sideways, the same scale keeps the frame inside the level.
  assert.ok(macroblocks(Math.round(2622 / scale), Math.round(1206 / scale)) <= 3600);
  // The rendition of an upright capture holds the same capture rotated, at the same scale.
  assert.equal(encoderScaleDown({ width: 2622, height: 1206 }, rendition), scale);
  assert.equal(encoderScaleDown({ width: 328, height: 720 }, rendition), 1);
  assert.equal(encoderScaleDown({ width: 200, height: 400 }, rendition), 1);
  assert.equal(encoderScaleDown({}, rendition), 1);
});

test('a browser screen sender offers only the H.264 profile of its format and its retransmission (#858)', () => {
  const codecs = [
    { mimeType: 'video/VP8' },
    { mimeType: 'video/rtx' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=4d001f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f' },
  ];
  const lines = (format: 'compatible' | 'main'): string[] => screenSenderCodecs(codecs, format).map(codec => codec.sdpFmtpLine ?? codec.mimeType);
  // Compatible is Constrained Baseline, what every receiver decodes, even when the browser lists Main first.
  assert.deepEqual(lines('compatible'), ['level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f', 'video/rtx']);
  assert.deepEqual(lines('main'), ['level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f', 'video/rtx']);
  // Plain Baseline (42 00) and High (64) are neither: not every receiver decodes them.
  assert.equal(isScreenCodec(codecs[3], 'compatible'), false);
  assert.equal(isScreenCodec(codecs[7], 'main'), false);
  assert.deepEqual(screenSenderCodecs(codecs.slice(0, 4), 'compatible'), []);
  assert.deepEqual(browserScreenFormats(codecs), ['compatible', 'main']);
});

/** What Firefox's WebRTC lists: H.264 only as Constrained Baseline, through OpenH264. */
const FIREFOX_VIDEO_CODECS = [
  { mimeType: 'video/VP8', sdpFmtpLine: 'max-fs=12288;max-fr=60' },
  { mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e01f;level-asymmetry-allowed=1;packetization-mode=1' },
  { mimeType: 'video/AV1' },
];
const CHROMIUM_VIDEO_CODECS = [
  { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
  { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f' },
  { mimeType: 'video/rtx' },
  { mimeType: 'video/AV1', sdpFmtpLine: 'level-idx=5;profile=0;tier=0' },
];
const NO_H264_VIDEO_CODECS = [{ mimeType: 'video/VP8' }, { mimeType: 'video/AV1' }];

/** Runs `body` as a browser tab with `codecs` in its WebRTC sender and receiver. */
function inBrowser(t: TestContext, codecs: readonly { mimeType: string; sdpFmtpLine?: string }[], body: () => void): void {
  const descriptors = ['window', 'navigator', 'RTCRtpSender', 'RTCRtpReceiver']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  const capabilities = { getCapabilities: () => ({ codecs, headerExtensions: [] }) };
  const define = (name: string, value: unknown): void => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  define('window', globalThis);
  define('navigator', { mediaDevices: { getDisplayMedia: () => Promise.reject(new Error('unused')), getSupportedConstraints: () => ({}) } });
  define('RTCRtpSender', capabilities);
  define('RTCRtpReceiver', capabilities);
  body();
}

test('Firefox, with only Constrained Baseline, shares screens in the compatible format (#858)', (t: TestContext) => {
  inBrowser(t, FIREFOX_VIDEO_CODECS, () => {
    const capabilities = webScreenCapabilities();
    assert.deepEqual({ capture: capabilities.capture, reason: capabilities.reason, formats: capabilities.browserFormats },
      { capture: true, reason: null, formats: ['compatible'] });
    // One rule: the button follows what the runtime would do with the click.
    assert.equal(webCapabilities().screenShare, true);
  });
});

test('a Chromium browser offers the compatible format and the better Main (#858)', (t: TestContext) => {
  inBrowser(t, CHROMIUM_VIDEO_CODECS, () => {
    assert.equal(webScreenCapabilities().capture, true);
    assert.deepEqual(webScreenCapabilities().browserFormats, ['compatible', 'main']);
    assert.equal(webCapabilities().screenShare, true);
  });
});

test('a browser without a usable H.264 encoder shows screen sharing locked, as its runtime refuses it (#858)', (t: TestContext) => {
  inBrowser(t, NO_H264_VIDEO_CODECS, () => {
    assert.deepEqual({ capture: webScreenCapabilities().capture, reason: webScreenCapabilities().reason }, { capture: false, reason: 'encoder' });
    assert.equal(webCapabilities().screenShare, false);
  });
});

test('Firefox watches compatible H.264 screens and knows it cannot decode Main (#858)', (t: TestContext) => {
  inBrowser(t, FIREFOX_VIDEO_CODECS, () => {
    assert.equal(browserReceivesScreenCodec('h264'), true);
    assert.equal(browserReceivesH264Main(), false);
    assert.equal(browserReceivesScreenCodec('av1'), true);
  });
  inBrowser(t, CHROMIUM_VIDEO_CODECS, () => {
    assert.equal(browserReceivesScreenCodec('h264'), true);
    assert.equal(browserReceivesH264Main(), true);
  });
  inBrowser(t, NO_H264_VIDEO_CODECS, () => {
    assert.equal(browserReceivesScreenCodec('h264'), false);
  });
});

test('a browser that cannot decode a screen is told which format and where to watch it (#858)', (t: TestContext) => {
  inBrowser(t, FIREFOX_VIDEO_CODECS, () => {
    // Firefox reaches an H.264 screen only when it is Main: the desktop's or the web's better format.
    assert.equal(browserScreenRefusal('h264'), 'unwatchable');
    // Firefox lists AV1 but does not decode the screen: named as AV1, never the generic network failure.
    assert.equal(browserScreenRefusal('av1'), 'unwatchable');
  });
  inBrowser(t, CHROMIUM_VIDEO_CODECS, () => {
    assert.equal(browserScreenRefusal('h264'), null);
    assert.equal(browserScreenRefusal('av1'), 'switch');
  });
  inBrowser(t, NO_H264_VIDEO_CODECS, () => {
    assert.equal(browserScreenRefusal('h264'), 'unwatchable');
  });
});

/** What Safari lists, on the iPhone and iPad too: H.264 as Constrained High and Constrained Baseline, never Main. */
const SAFARI_VIDEO_CODECS = [
  { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f' },
  { mimeType: 'video/rtx', sdpFmtpLine: 'apt=96' },
  { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
  { mimeType: 'video/H265' },
  { mimeType: 'video/VP8' },
  { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=0' },
];

test('Safari watches H.264 Main screens through its Constrained High receiver, never told to watch elsewhere', (t: TestContext) => {
  inBrowser(t, SAFARI_VIDEO_CODECS, () => {
    assert.equal(browserAliasesH264Main(), true);
    assert.equal(browserReceivesH264Main(), true);
    assert.equal(browserScreenRefusal('h264'), null);
    // AV1, which it does not receive, can still become the H.264 it plays.
    assert.equal(browserScreenRefusal('av1'), 'switch');
  });
  for (const codecs of [CHROMIUM_VIDEO_CODECS, FIREFOX_VIDEO_CODECS, NO_H264_VIDEO_CODECS])
    inBrowser(t, codecs, () => assert.equal(browserAliasesH264Main(), false));
});

test('an aliased H.264 Main offer is answered back under the profile each payload had', () => {
  const offer = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99', 'a=rtpmap:96 H264/90000',
    'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d0033', 'a=rtpmap:97 rtx/90000', 'a=fmtp:97 apt=96',
    'a=rtpmap:98 H264/90000', 'a=fmtp:98 profile-level-id=4D401F;packetization-mode=1',
    'a=rtpmap:99 H264/90000', 'a=fmtp:99 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f',
    'm=audio 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 opus/48000/2', 'a=fmtp:96 profile-level-id=4d0033', ''].join('\r\n');
  const aliased = aliasH264MainOffer(offer);
  assert.deepEqual([...aliased.aliases], [[96, '4d00'], [98, '4D40']]);
  assert.match(aliased.sdp, /a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c33\r\n/);
  assert.match(aliased.sdp, /a=fmtp:98 profile-level-id=640c1F;packetization-mode=1\r\n/);
  assert.match(aliased.sdp, /a=fmtp:99 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f\r\n/);
  // Only H.264 in video carries a profile to alias.
  assert.match(aliased.sdp, /a=fmtp:96 profile-level-id=4d0033\r\n$/);
  const answer = aliased.sdp.replace('profile-level-id=640c33', 'profile-level-id=640c1f');
  const restored = restoreH264MainAnswer(answer, aliased.aliases);
  assert.match(restored, /a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f\r\n/, 'the level the receiver chose stays');
  assert.match(restored, /a=fmtp:98 profile-level-id=4D401F;packetization-mode=1\r\n/);
  assert.match(restored, /a=fmtp:99 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f\r\n/, 'a real Constrained High stays');
  assert.equal(restoreH264MainAnswer(answer, new Map()), answer);
});

test('the sent screen stream is renamed after its instance and read back as its binding (#858)', () => {
  const sdp = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:0', 'a=msid:random-stream video-track',
    'a=ssrc:1 msid:random-stream video-track', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=mid:1', 'a=msid:random-stream audio-track', ''].join('\r\n');
  const renamed = withScreenStreamId(sdp, 'random-stream', INSTANCE);
  assert.ok(!renamed.includes('random-stream'));
  assert.ok(renamed.includes(`a=ssrc:1 msid:${INSTANCE} video-track`));
  const video = sentMediaBinding(renamed, '0');
  assert.deepEqual(video, { trackId: 'video-track', mid: '0', streamIds: [INSTANCE] });
  assert.deepEqual(sentMediaBinding(renamed, '1'), { trackId: 'audio-track', mid: '1', streamIds: [INSTANCE] });
  assert.equal(sentMediaBinding(renamed, '2'), null);
  assert.equal(sameMediaBinding(video, { trackId: 'video-track', mid: '0', streamIds: [INSTANCE] }), true);
  assert.equal(sameMediaBinding(video, { trackId: 'video-track', mid: '1', streamIds: [INSTANCE] }), false);
});

test('browser commands name browser captures, and the desktop never accepts one (#858)', () => {
  const video = { width: 1280, height: 720, fps: 30, maxBitrateKbps: 2500 };
  const add = (desktopSourceId: string) => ({
    action: 'source-add', callId: INSTANCE, shareId: SHARE, desktopSourceId, video, audio: false, audioBitrateKbps: 128,
  });
  const capture = `browser-capture:${CONNECTION}`;
  assert.equal(browserScreenCommandSchema.safeParse(add(capture)).success, true);
  assert.equal(nativeScreenCommandSchema.safeParse(add(capture)).success, false);
  assert.equal(browserScreenCommandSchema.safeParse(add('window:123:0')).success, false);
  assert.equal(nativeScreenCommandSchema.safeParse(add('window:123:0')).success, true);
  assert.equal(browserScreenCommandSchema.safeParse(add('browser-capture:not-a-uuid')).success, false);
});

test('a share chosen in the browser carries sound only when no other share keeps its own (#858)', () => {
  const live = (shareIds: string[], audioShareIds: string[]): LiveScreens => ({ shareIds, audioShareIds, capture: () => null });
  assert.deepEqual(planBrowserAudio({ mode: 'add' }, live([], [])), { kind: 'free', handedOver: [] });
  assert.deepEqual(planBrowserAudio({ mode: 'add' }, live(['one'], ['one'])), { kind: 'blocked', reason: 'system' });
  assert.deepEqual(planBrowserAudio({ mode: 'replace' }, live(['one'], ['one'])), { kind: 'free', handedOver: ['one'] });
  assert.deepEqual(planBrowserAudio({ mode: 'replace', targetShareId: 'two' }, live(['one', 'two'], ['one'])),
    { kind: 'blocked', reason: 'system' });
  assert.deepEqual(planBrowserAudio({ mode: 'replace', targetShareId: 'one' }, live(['one', 'two'], ['one'])),
    { kind: 'free', handedOver: ['one'] });
  // Sound still being set up for a share belongs to nobody yet.
  assert.deepEqual(planBrowserAudio({ mode: 'replace' }, live([], ['pending'])), { kind: 'blocked', reason: 'system' });
});

test('a share started in Firefox, whose streams are named {uuid}, gets a share id every side accepts (#858)', (t: TestContext) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'MediaStream');
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'MediaStream', descriptor); else Reflect.deleteProperty(globalThis, 'MediaStream'); });
  let next = '';
  class FakeStream { get id(): string { return next; } }
  Object.defineProperty(globalThis, 'MediaStream', { value: FakeStream, configurable: true, writable: true });
  next = '{8e5c3b1a-6f2d-4c1e-9a7b-3d2e1f0a9b8c}';
  const firefox = createScreenShareStream();
  assert.equal(screenShareIdSchema.safeParse(firefox.id).success, true);
  assert.equal(firefox.id, firefox.id, 'the id stays the same every time it is read');
  next = 'Q2o7mVb1xK0dLr9sTz4wHy3nUe6cGj5pFa8i';
  assert.equal(createScreenShareStream().id, next, 'an id the rule accepts is kept');
});

test('a browser screen never negotiates the orientation mark, so a turned phone sends its pixels turned', () => {
  const sdp = ['m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:0', 'a=extmap:3 urn:3gpp:video-orientation',
    'a=extmap:4/sendrecv urn:3gpp:video-orientation', 'a=extmap:5 urn:ietf:params:rtp-hdrext:sdes:mid', 'a=sendonly', ''].join('\r\n');
  assert.equal(withoutVideoOrientation(sdp),
    ['m=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:0', 'a=extmap:5 urn:ietf:params:rtp-hdrext:sdes:mid', 'a=sendonly', ''].join('\r\n'));
});

test('Safari answers a desktop viewer whose renegotiation offers H.264 at Level 6, read as the 5.2 WebKit parses', async (t: TestContext) => {
  const received: string[] = [];
  class FakePeer {
    public onicecandidate: unknown = null;
    public onconnectionstatechange: unknown = null;
    addTransceiver() { return { setCodecPreferences() {}, sender: {}, mid: '0' }; }
    // WebKit drops a codec at a level its parser predates: the screen's section is left with none.
    async setRemoteDescription(description: RTCSessionDescriptionInit) {
      if (/profile-level-id=[0-9a-f]{4}3[5-9a-f]/i.test(description.sdp ?? '')) throw new Error('Failed to setup RTCP mux.');
      received.push(description.sdp ?? '');
    }
    close() {}
  }
  const names = ['RTCPeerConnection', 'MediaStream'] as const;
  const descriptors = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { value: FakePeer, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'MediaStream', { value: class { id = 'stream'; }, configurable: true, writable: true });
  const { BrowserScreenPeer } = await import('../src/renderer/platform/web/webScreen/browserScreenPeer');
  const offer = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 98 96 35', 'a=mid:0', 'a=recvonly', 'a=rtpmap:98 H264/90000',
    'a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e03c', 'a=rtpmap:96 H264/90000',
    'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d0033', 'a=rtpmap:35 AV1/90000',
    'a=fmtp:35 level-idx=23;profile=0;tier=0', ''].join('\r\n');
  await new Promise<void>((resolve, reject) => inBrowser(t, SAFARI_VIDEO_CODECS, () => {
    const peer = new BrowserScreenPeer({
      iceServers: [], format: 'compatible', streamId: INSTANCE, video: {} as MediaStreamTrack, audio: null,
      maxBitrateBps: 2_500_000, maxFramerate: 30, scaleResolutionDownBy: 1, audioBitrateBps: 128_000,
      onCandidate: () => {}, onState: () => {},
    });
    peer.setRemote('offer', offer).then(resolve, reject);
  }));
  assert.match(received[0], /a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e034\r\n/);
  assert.match(received[0], /profile-level-id=4d0033\r\n/, 'a level WebKit reads stays');
  assert.match(received[0], /a=fmtp:35 level-idx=23;profile=0;tier=0\r\n/, 'only H.264 carries a profile level');
});

test('Safari declares the Constrained Baseline its VideoToolbox keyframes omit, which the desktop requires to show them', async (t: TestContext) => {
  // The SPS WebKit sends on macOS and the iPhone: profile 66, constraint flags 0x00, level 5.2.
  const sps = [0, 0, 0, 1, 0x27, 0x42, 0x00, 0x34, 0xab, 0x40, 0x28, 0x02, 0xdd];
  const slice = [0, 0, 0, 1, 0x25, 0x88, 0x84];
  const sender: { transform: unknown } = { transform: null };
  const workers: string[] = [];
  class FakePeer {
    public onicecandidate: unknown = null;
    public onconnectionstatechange: unknown = null;
    addTransceiver() { return { setCodecPreferences() {}, sender, mid: '0' }; }
    close() {}
  }
  const names = ['RTCPeerConnection', 'MediaStream', 'Worker', 'RTCRtpScriptTransform'] as const;
  const descriptors = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
  });
  const define = (name: string, value: unknown): void => { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  define('RTCPeerConnection', FakePeer);
  define('MediaStream', class { id = 'stream'; });
  define('Worker', class { onerror: unknown = null; constructor(url: string) { workers.push(url); } terminate() {} });
  define('RTCRtpScriptTransform', class { constructor(public readonly worker: unknown) {} });
  const { BrowserScreenPeer } = await import('../src/renderer/platform/web/webScreen/browserScreenPeer');
  const open = (userAgent: string) => inBrowser(t, SAFARI_VIDEO_CODECS, () => {
    define('navigator', { userAgent });
    new BrowserScreenPeer({
      iceServers: [], format: 'compatible', streamId: INSTANCE, video: {} as MediaStreamTrack, audio: null,
      maxBitrateBps: 2_500_000, maxFramerate: 30, scaleResolutionDownBy: 1, audioBitrateBps: 128_000,
      onCandidate: () => {}, onState: () => {},
    }).close();
  });
  open('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36');
  assert.equal(sender.transform, null, 'Chromium encoders already declare it: their frames are left alone');
  open('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  assert.ok(sender.transform, 'the screen video passes through the declaring transform');

  // The worker runs only its own source text.
  const { resolveObjectURL } = await import('node:buffer');
  const source = await resolveObjectURL(workers[0])!.text();
  const { runInNewContext } = await import('node:vm');
  const scope = new EventTarget();
  runInNewContext(source, { self: scope, TransformStream });
  const frames = [{ type: 'key', data: new Uint8Array([...sps, ...slice]).buffer },
    { type: 'delta', data: new Uint8Array([0, 0, 0, 1, 0x21, 0x9a]).buffer }];
  const sent: Uint8Array[] = [];
  const done = new Promise<void>(resolve => scope.dispatchEvent(Object.assign(new Event('rtctransform'), {
    transformer: {
      readable: new ReadableStream({ start(controller) { frames.forEach(frame => controller.enqueue(frame)); controller.close(); } }),
      writable: new WritableStream<{ data: ArrayBuffer }>({ write: frame => { sent.push(new Uint8Array(frame.data)); }, close: resolve }),
    },
  })));
  await done;
  assert.deepEqual([...sent[0]], [...sps.slice(0, 6), 0x40, ...sps.slice(7), ...slice], 'constraint_set1 now declared');
  assert.deepEqual([...sent[1]], [0, 0, 0, 1, 0x21, 0x9a]);
});

test('Only a Baseline SPS that omits it is declared Constrained Baseline', async () => {
  const { declareConstrainedBaseline } = await import('../src/renderer/platform/web/webScreen/constrainedBaseline');
  const declared = (bytes: number[]) => { const frame = new Uint8Array(bytes); return [declareConstrainedBaseline(frame), [...frame]]; };
  assert.deepEqual(declared([0, 0, 1, 0x67, 0x42, 0xc0, 0x1f]), [false, [0, 0, 1, 0x67, 0x42, 0xc0, 0x1f]]);
  assert.deepEqual(declared([0, 0, 1, 0x67, 0x4d, 0x00, 0x33]), [false, [0, 0, 1, 0x67, 0x4d, 0x00, 0x33]], 'Main is not Baseline');
  assert.deepEqual(declared([0, 0, 1, 0x67, 0x42, 0x0c, 0x1f]), [true, [0, 0, 1, 0x67, 0x42, 0x40, 0x1f]], 'constraint_set4/5 cleared');
  assert.deepEqual(declared([0, 0, 1, 0x65, 0x42, 0x00, 0x1f]), [false, [0, 0, 1, 0x65, 0x42, 0x00, 0x1f]], 'only an SPS');
});
