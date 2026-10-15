import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION, type ChannelSummary, type ServerDetails } from '@monky/shared';
import {
  afkChannelIdOf, isIdleInCall, parseVoiceUserLimitInput, renderVoiceUserLimitBadge, voiceUserLimitOf,
} from '../src/renderer/utils/voiceRooms';

const channel = (overrides: Partial<ChannelSummary> = {}): ChannelSummary => ({
  id: 'room', serverId: 'server', name: 'Room', type: 'VOICE', position: 0, createdAt: 1, isPrivate: false,
  allowedRoleIds: [], botCommandsEnabled: true, maxParticipants: 6, ...overrides,
});
const server = (features: string[], overrides: Partial<ServerDetails> = {}): ServerDetails => ({
  id: 'server', name: 'Server', createdAt: 1, maxUsers: 0, members: [], voiceStates: {},
  channels: [channel(), channel({ id: 'afk', maxParticipants: 0 })], afkChannelId: 'afk',
  protocol: { version: PROTOCOL_VERSION, minimumVersion: MIN_CLIENT_PROTOCOL, features }, ...overrides,
});

test('the user limit shows only for limited voice rooms of servers that understand it, never on the AFK room', () => {
  const supported = server(['voice-user-limit', 'afk-channel']);
  assert.equal(voiceUserLimitOf(supported, channel()), 6);
  assert.equal(voiceUserLimitOf(supported, channel({ maxParticipants: 0 })), null);
  assert.equal(voiceUserLimitOf(supported, channel({ maxParticipants: undefined })), null);
  assert.equal(voiceUserLimitOf(supported, channel({ type: 'TEXT' })), null);
  assert.equal(voiceUserLimitOf(supported, channel({ id: 'afk', maxParticipants: 4 })), null);
  assert.equal(voiceUserLimitOf(server([]), channel({ maxParticipants: 10 })), null, 'older servers kept a hidden limit of 10');
});

test('the AFK room is only known on servers that negotiated it', () => {
  assert.equal(afkChannelIdOf(server(['afk-channel'])), 'afk');
  assert.equal(afkChannelIdOf(server(['afk-channel'], { afkChannelId: null })), null);
  assert.equal(afkChannelIdOf(server([])), null);
  assert.equal(afkChannelIdOf(null), null);
});

test('the limit field takes blank as no limit and whole numbers up to the maximum', () => {
  assert.equal(parseVoiceUserLimitInput(''), LIMITS.VOICE_USER_LIMIT_NONE);
  assert.equal(parseVoiceUserLimitInput('   '), LIMITS.VOICE_USER_LIMIT_NONE);
  assert.equal(parseVoiceUserLimitInput(' 6 '), 6);
  assert.equal(parseVoiceUserLimitInput('1'), 1);
  assert.equal(parseVoiceUserLimitInput(String(LIMITS.VOICE_USER_LIMIT_MAX)), LIMITS.VOICE_USER_LIMIT_MAX);
  for (const invalid of ['0', String(LIMITS.VOICE_USER_LIMIT_MAX + 1), '-1', '2.5', '1e1', 'abc', '６']) {
    assert.equal(parseVoiceUserLimitInput(invalid), null, invalid);
  }
});

test('the badge pads both numbers to two digits and reddens the count only above the limit', () => {
  const full = renderVoiceUserLimitBadge(6, 6);
  assert.match(full, /voice-user-limit-count" aria-hidden="true">06</);
  assert.match(full, /voice-user-limit-max" aria-hidden="true">06</);
  assert.doesNotMatch(full, /voice-user-limit--over/, 'a full room is not over its limit');
  assert.match(renderVoiceUserLimitBadge(0, 6), /voice-user-limit-count" aria-hidden="true">00</);
  assert.match(renderVoiceUserLimitBadge(7, 6), /voice-user-limit--over/);
});

test('a member is idle only after the whole timeout without input or speech, and never while broadcasting or watching', () => {
  const idle = { idleSeconds: 900, msSinceSpeech: 900_000, timeoutSeconds: 900, broadcasting: false, watching: false };
  assert.equal(isIdleInCall(idle), true);
  assert.equal(isIdleInCall({ ...idle, idleSeconds: 899 }), false, 'recent keyboard or mouse input');
  assert.equal(isIdleInCall({ ...idle, msSinceSpeech: 899_999 }), false, 'recent speech');
  assert.equal(isIdleInCall({ ...idle, broadcasting: true }), false, 'sharing the screen or the camera');
  assert.equal(isIdleInCall({ ...idle, watching: true }), false, 'watching a stream');
});
