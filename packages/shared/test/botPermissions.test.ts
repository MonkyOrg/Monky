import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOT_CAPABILITIES, botCapabilitiesSchema, botManifestSchema, botPermissionsSchema, botVoiceParticipantSchema,
  commandRegisterSchema, isBotPublishSignalAllowed, isBotVoiceSignalAllowed, isReceivingBotVoice, unreviewedBotPermissions,
} from '../src/index.js';

test('only supported explicit requests and approved subsets are valid', () => {
  assert.deepEqual(botCapabilitiesSchema.parse(['send_messages', 'commands']), ['commands', 'send_messages']);
  assert.deepEqual(botCapabilitiesSchema.parse(['receive_voice']), ['receive_voice']);
  for (const invalid of [undefined, null, ['receive_screen'], ['listen_voice'], ['commands', 'commands'], [...BOT_CAPABILITIES, 'files']]) {
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

test('voice reception and publication are independent grants and never cover other media', () => {
  const signal = (direction: string, extra = '') => ({
    fromSessionId: 'bot:bot', targetSessionId: 'human', signalType: 'offer',
    sdp: { type: 'offer', sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${direction}\r\n${extra}` },
  });
  for (const fromBot of [true, false]) {
    for (const publish of [true, false]) for (const receive of [true, false]) {
      const grants = { publish, receive };
      assert.equal(isBotVoiceSignalAllowed(signal('sendrecv'), fromBot, grants), publish && receive);
      assert.equal(isBotVoiceSignalAllowed(signal('sendonly'), fromBot, grants), fromBot ? publish : receive);
      assert.equal(isBotVoiceSignalAllowed(signal('recvonly'), fromBot, grants), fromBot ? receive : publish);
      assert.equal(isBotVoiceSignalAllowed(signal('inactive'), fromBot, grants), true);
      for (const extra of [
        'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv\r\n',
        'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendrecv\r\n',
        'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
      ]) assert.equal(isBotVoiceSignalAllowed(signal('sendrecv', extra), fromBot, grants), false);
    }
  }
  assert.equal(isReceivingBotVoice({}), false);
  assert.equal(isReceivingBotVoice({ receivesVoice: true }), true);
  assert.equal(isReceivingBotVoice({ receivesVoice: true, isDeafened: true }), false);
  assert.equal(isReceivingBotVoice({ receivesVoice: true, serverDeafened: true }), false);
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

test('voice roster preserves requested, granted and administrative states independently', () => {
  for (const permissions of [
    { publish: true, receive: true, publishRequested: true, receiveRequested: true },
    { publish: false, receive: true, publishRequested: false, receiveRequested: true },
    { publish: true, receive: false, publishRequested: true, receiveRequested: false },
    { publish: false, receive: true, publishRequested: true, receiveRequested: true },
    { publish: true, receive: false, publishRequested: true, receiveRequested: true },
  ]) {
    const participant = {
      user: { id: 'bot', sessionId: 'bot:one', isBot: true },
      voiceState: { sessionId: 'bot:one', channelId: 'voice', serverMuted: true, botVoicePermissions: permissions },
    };
    assert.deepEqual(botVoiceParticipantSchema.parse(participant), participant);
    assert.equal(botVoiceParticipantSchema.safeParse({ ...participant,
      voiceState: { ...participant.voiceState, botVoicePermissions: { ...permissions, publishRequested: undefined } },
    }).success, false);
    assert.equal(botVoiceParticipantSchema.safeParse({ ...participant,
      voiceState: { ...participant.voiceState, botVoicePermissions: { ...permissions, receiveRequested: 'true' } },
    }).success, false);
  }
});

test('publish-only P2P bot negotiation cannot receive microphone, screen, video or data-channel media', () => {
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
