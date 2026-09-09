import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceModeReconnect, type VoiceReconnectCall } from '../src/renderer/core/VoiceModeReconnect';
import { selectScreenVideoCodecs, ScreenCodecError } from '../src/renderer/core/webrtc/codecPreferences';
import { type VoiceUserLeftPayload } from '@monky/shared';
import { getLanguage, setLanguage, t as translate } from '../src/renderer/i18n';

const departure: VoiceUserLeftPayload = {
  channelId: 'room', userId: 'alice', sessionId: 'alice:desktop',
  reconnect: { id: 'change-1', from: 'sfu', to: 'p2p' },
};
const settings = { name: 'Server', hasPassword: false, voiceMode: 'p2p' as const, voiceTransition: departure.reconnect };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function fixture() {
  let current: VoiceReconnectCall | null = { sessionKey: 'server-a', sessionId: 'alice:desktop', channelId: 'room' };
  let allowed = true;
  let tears = 0, joins = 0, notices = 0, cancelled = 0;
  const failures: Error[] = [];
  let finishTeardown = () => {};
  const teardown = new Promise<void>((resolve) => { finishTeardown = resolve; });
  let rejoin: () => Promise<void> = async () => {};
  const controller = new VoiceModeReconnect({
    currentCall: () => current, canReconnect: () => allowed,
    teardown: () => { tears++; return teardown; },
    rejoin: async (call, id, isCurrent) => {
      assert.deepEqual(call, current);
      assert.equal(id, 'change-1');
      assert.equal(isCurrent(), true);
      joins++;
      await rejoin();
    },
    notify: () => { notices++; }, failed: (_call, error) => failures.push(error),
    cancelled: () => { cancelled++; }, timeoutMessage: () => 'Reconnection timed out',
  });
  return {
    controller, finishTeardown, failures, counts: () => ({ tears, joins, notices, cancelled }),
    setCall: (call: VoiceReconnectCall | null) => { current = call; },
    revoke: () => { allowed = false; },
    setRejoin: (action: () => Promise<void>) => { rejoin = action; },
  };
}

test('mode rejoin requires own departure, matching settings and completed full teardown exactly once', async (t) => {
  const f = fixture();
  t.after(() => f.controller.cancel());
  assert.equal(f.controller.departed('server-a', departure), 'reconnect');
  f.controller.settingsUpdated('server-a', settings);
  await flush();
  assert.equal(f.counts().joins, 0, 'settings never skip teardown');
  assert.equal(f.controller.departed('server-a', departure), 'ignore');
  f.finishTeardown();
  await flush();
  assert.deepEqual(f.counts(), { tears: 1, joins: 1, notices: 1, cancelled: 0 });
  f.controller.settingsUpdated('server-a', settings);
  f.controller.departed('server-a', departure);
  await flush();
  assert.equal(f.counts().joins, 1, 'repeated departure after reconnection cannot evict the new call');
});

test('background server, another device/channel, plain departure and unmatched settings never auto-join', async (t) => {
  for (const [origin, payload] of [
    ['server-b', departure],
    ['server-a', { ...departure, sessionId: 'alice:phone' }],
    ['server-a', { ...departure, channelId: 'other-room' }],
    ['server-a', { ...departure, reconnect: undefined }],
  ] satisfies Array<[string, VoiceUserLeftPayload]>) {
    const f = fixture();
    t.after(() => f.controller.cancel());
    f.controller.departed(origin, payload);
    f.controller.settingsUpdated(origin, settings);
    f.finishTeardown();
    await flush();
    assert.equal(f.counts().joins, 0);
    assert.equal(f.counts().notices, 0);
  }
  const f = fixture();
  t.after(() => f.controller.cancel());
  f.controller.settingsUpdated('server-a', settings);
  f.controller.departed('server-a', departure);
  f.finishTeardown();
  f.controller.settingsUpdated('server-a', { ...settings, voiceTransition: undefined });
  await flush();
  assert.equal(f.counts().joins, 0, 'saving unchanged p2p does not authorize admission');
});

test('leave, kick, new call/server, revoked permission, deleted channel and mode reversal cancel pending rejoin', async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.setCall(null); f.controller.validate(); },
    (f: ReturnType<typeof fixture>) => f.controller.cancel(),
    (f: ReturnType<typeof fixture>) => { f.setCall({ sessionKey: 'server-a', sessionId: 'alice:desktop', channelId: 'other' }); f.controller.validate(); },
    (f: ReturnType<typeof fixture>) => { f.setCall({ sessionKey: 'server-b', sessionId: 'alice:desktop', channelId: 'room' }); f.controller.validate(); },
    (f: ReturnType<typeof fixture>) => { f.revoke(); f.controller.validate(); },
    (f: ReturnType<typeof fixture>) => f.controller.settingsUpdated('server-a', { ...settings, voiceMode: 'sfu' }),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    f.controller.departed('server-a', departure);
    f.controller.settingsUpdated('server-a', settings);
    mutate(f);
    f.finishTeardown();
    await flush();
    assert.equal(f.counts().joins, 0);
    assert.equal(f.counts().cancelled, 1);
    assert.equal(f.failures.length, 0);
  }
});

test('late rejected/completed requests after cancellation do not revive or fail a new call', async () => {
  const f = fixture();
  let reject = (_error: Error) => {};
  f.setRejoin(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  f.controller.departed('server-a', departure);
  f.finishTeardown();
  f.controller.settingsUpdated('server-a', settings);
  await flush();
  assert.equal(f.counts().joins, 1);
  f.controller.cancel();
  reject(new Error('Old socket failed'));
  await flush();
  assert.equal(f.failures.length, 0);
});

test('a failed admission or missing settings completion surfaces one meaningful failure, never retries a generic join', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.controller.departed('server-a', departure);
  t.mock.timers.tick(15000);
  assert.equal(f.failures[0]?.message, 'Reconnection timed out');
  f.finishTeardown();
  f.controller.settingsUpdated('server-a', settings);
  await flush();
  assert.equal(f.counts().joins, 0);
  const denied = fixture();
  denied.setRejoin(async () => { throw new Error('Channel access revoked'); });
  denied.controller.departed('server-a', departure);
  denied.finishTeardown();
  denied.controller.settingsUpdated('server-a', settings);
  await flush();
  assert.equal(denied.failures[0]?.message, 'Channel access revoked');
  assert.equal(denied.counts().joins, 1);
});

test('explicit screen selection preserves every chosen profile and only associated RTX; auto alone keeps fallback', () => {
  const codecs = [
    { mimeType: 'video/AV1', preferredPayloadType: 98 },
    { mimeType: 'video/rtx', sdpFmtpLine: 'apt=98', preferredPayloadType: 99 },
    { mimeType: 'video/H264', preferredPayloadType: 100, sdpFmtpLine: 'profile-level-id=42e01f' },
    { mimeType: 'video/rtx', sdpFmtpLine: 'apt=100', preferredPayloadType: 101 },
    { mimeType: 'video/H264', preferredPayloadType: 102, sdpFmtpLine: 'profile-level-id=42001f' },
    { mimeType: 'video/rtx', sdpFmtpLine: 'apt=102', preferredPayloadType: 103 },
    { mimeType: 'video/VP8', preferredPayloadType: 96 },
  ];
  assert.deepEqual(selectScreenVideoCodecs(codecs, 'h264').map((codec) => codec.preferredPayloadType), [100, 102, 101, 103]);
  assert.equal(selectScreenVideoCodecs(codecs, 'auto').length, codecs.length);
  assert.throws(() => selectScreenVideoCodecs(codecs, 'vp9'), ScreenCodecError);
  assert.deepEqual(selectScreenVideoCodecs([
    { mimeType: 'video/H264' }, { mimeType: 'video/rtx' }, { mimeType: 'video/AV1' },
  ], 'h264').map((codec) => codec.mimeType), ['video/H264', 'video/rtx']);
});

test('mode change and explicit-codec failures use the selected app language', () => {
  const language = getLanguage();
  try {
    setLanguage('en');
    assert.match(translate('voiceReconnect.notice'), /reconnect automatically/);
    assert.match(new ScreenCodecError('h264', 'unsupported').message, /not supported/);
    setLanguage('pt-BR');
    assert.match(translate('voiceReconnect.notice'), /reconectada automaticamente/);
    assert.match(new ScreenCodecError('h264', 'unsupported').message, /não é compatível/);
  } finally {
    setLanguage(language);
  }
});
