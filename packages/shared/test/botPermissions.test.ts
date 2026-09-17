import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOT_CAPABILITIES, botCapabilitiesSchema, botManifestSchema, botPermissionsSchema,
  commandRegisterSchema, isBotPublishSignalAllowed, unreviewedBotPermissions,
} from '../src/index.js';

test('only supported explicit requests and approved subsets are valid', () => {
  assert.deepEqual(botCapabilitiesSchema.parse(['send_messages', 'commands']), ['commands', 'send_messages']);
  for (const invalid of [undefined, null, ['receive_voice'], ['listen_voice'], ['commands', 'commands'], [...BOT_CAPABILITIES, 'files']]) {
    assert.equal(botCapabilitiesSchema.safeParse(invalid).success, false);
  }
  const state = unreviewedBotPermissions();
  assert.deepEqual(botPermissionsSchema.parse(state), state);
  assert.equal(botPermissionsSchema.safeParse({ ...state, granted: ['commands'] }).success, false);
  assert.equal(botPermissionsSchema.safeParse({ ...state, reviewRequired: false }).success, false);
  assert.equal(botPermissionsSchema.safeParse({ ...state, requested: [], reviewedBy: 'admin' }).success, false);
  assert.equal(botPermissionsSchema.safeParse({
    requested: ['commands'], granted: ['commands'], revision: 1, reviewRequired: false, reviewedBy: 'admin', reviewedAt: 1,
  }).success, true);
});

test('legacy or self-approved declarations cannot bypass administrator review', () => {
  const manifest = { name: 'Bot', registrationUrl: 'https://bot.example/register' };
  assert.equal(botManifestSchema.safeParse(manifest).success, false);
  assert.equal(botManifestSchema.safeParse({ ...manifest, requestedCapabilities: [] }).success, true);
  assert.equal(botManifestSchema.safeParse({ ...manifest, requestedCapabilities: [], permissions: ['commands'] }).success, false);
  const commands = [{ name: 'ping', description: 'Ping' }];
  assert.equal(botManifestSchema.safeParse({ ...manifest, commands, requestedCapabilities: [] }).success, false);
  assert.equal(botManifestSchema.safeParse({ ...manifest, commands, requestedCapabilities: ['commands'] }).success, true);
  assert.equal(botManifestSchema.safeParse({
    ...manifest, commands: [{ ...commands[0], receiveVoice: true }], requestedCapabilities: ['commands'],
  }).success, false);
  const credentialedUrl = new URL(manifest.registrationUrl);
  credentialedUrl.username = 'fixture';
  assert.equal(botManifestSchema.safeParse({
    ...manifest, requestedCapabilities: [], registrationUrl: credentialedUrl.href,
  }).success, false);
  assert.equal(commandRegisterSchema.safeParse({ commands }).success, false);
  assert.equal(commandRegisterSchema.safeParse({ commands, requestedCapabilities: [] }).success, false);
  assert.equal(commandRegisterSchema.safeParse({ commands, requestedCapabilities: ['commands'], granted: ['commands'] }).success, false);
  for (const [feature, value, capability] of [
    ['downloadsSound', true, 'sound_download'],
    ['localCapabilities', ['youtube-audio'], 'local_execution'],
  ] as const) {
    const declaration = { commands: [{ ...commands[0], [feature]: value }], requestedCapabilities: ['commands'] };
    assert.equal(commandRegisterSchema.safeParse(declaration).success, false);
    assert.equal(commandRegisterSchema.safeParse({ ...declaration, requestedCapabilities: ['commands', capability] }).success, true);
  }
});

test('P2P bot negotiation cannot receive microphone, screen, video or data-channel media', () => {
  const signal = (sdp: string) => ({
    fromSessionId: 'bot:bot', targetSessionId: 'human', signalType: 'offer', sdp: { type: 'offer', sdp },
  });
  const audio = (direction: string) => `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${direction}\r\n`;
  assert.equal(isBotPublishSignalAllowed(signal(audio('sendonly')), true), true);
  assert.equal(isBotPublishSignalAllowed(signal(audio('recvonly')), false), true);
  for (const direction of ['recvonly', 'sendrecv']) assert.equal(isBotPublishSignalAllowed(signal(audio(direction)), true), false);
  for (const direction of ['sendonly', 'sendrecv']) assert.equal(isBotPublishSignalAllowed(signal(audio(direction)), false), false);
  for (const sdp of [
    'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
    audio('sendonly') + 'a=recvonly\r\n',
    audio('sendonly') + 'a=recvonly \t\r\n',
    audio('sendonly') + audio('sendonly').replace('v=0\r\n', ''),
    audio('sendonly') + 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n',
    audio('sendonly') + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n',
    'v=0\r\nm=audio 0 UDP/TLS/RTP/SAVPF 111\r\na=bundle-only\r\na=recvonly\r\n',
    audio('sendonly') + 'm=audio 0 UDP/TLS/RTP/SAVPF 111\r\na=bundle-only\r\na=sendonly\r\n',
    audio('sendonly') + 'm=application 0 UDP/DTLS/SCTP webrtc-datachannel\r\na=bundle-only\r\n',
  ]) assert.equal(isBotPublishSignalAllowed(signal(sdp), true), false, sdp);
  assert.equal(isBotPublishSignalAllowed(signal(audio('inactive')), true), true);
  assert.equal(isBotPublishSignalAllowed({ ...signal(audio('sendonly')), signalType: 'answer' }, true), false);
  assert.equal(isBotPublishSignalAllowed({ ...signal(audio('sendonly')), signalType: 'screen-audio-meta' }, false), false);
});
