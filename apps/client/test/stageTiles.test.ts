import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCREEN_SHARE_LIMITS, type BotScreen, type UserSummary, type VoiceParticipantState } from '@monky/shared';
import type { ParticipantViewModel } from '../src/renderer/core/ParticipantManager';
import {
  LEGACY_SHARE_ID, buildStageTiles, measuredTiles, remoteScreenStream, screenShareIds, stageTileKey, tileDomId,
  type OwnStageMedia, type ParticipantStageTile,
} from '../src/renderer/views/stage/stageTiles';

function participant(
  sessionId: string, voice: Partial<VoiceParticipantState> = {}, streams: Record<string, MediaStream> = {},
): ParticipantViewModel {
  const userId = sessionId.split(':')[0];
  const user: UserSummary = { id: userId, clientId: `${userId}-client`, nickname: userId, status: 'VOICE', joinedAt: 0, sessionId };
  return {
    user, isSpeaking: false, remoteScreenStreams: new Map(Object.entries(streams)),
    voiceState: {
      sessionId, userId, channelId: 'room', isMuted: false, isDeafened: false, isSpeaking: false, isCameraOn: false,
      isScreenSharing: false, isSharingScreenAudio: false, serverMuted: false, serverDeafened: false, ...voice,
    },
  };
}

const NOBODY: OwnStageMedia = { sessionId: undefined, cameraOn: false, screenShareIds: [] };

test('tile keys have one spelling, and a screen key names its share only for its own connection', () => {
  assert.equal(stageTileKey.voice('ana:pc'), 'ana:pc:voice');
  assert.equal(stageTileKey.camera('ana:pc'), 'ana:pc:camera');
  assert.equal(stageTileKey.screen('ana:pc', 'share-1'), 'ana:pc:screen:share-1');
  assert.equal(stageTileKey.miniapp('chess'), 'miniapp:chess');
  assert.equal(stageTileKey.isScreen('ana:pc:screen:share-1'), true);
  assert.equal(stageTileKey.isScreen('ana:pc:camera'), false);
  assert.equal(stageTileKey.shareOf('ana:pc:screen:share-1', 'ana:pc'), 'share-1');
  assert.equal(stageTileKey.shareOf('ana:pc:screen:share-1', 'ana'), undefined, 'a prefix of the session is another connection');
  assert.equal(stageTileKey.shareOf('ana:pc:camera', 'ana:pc'), undefined);
});

test('each participant source is a tile, with an avatar only when nothing is broadcast (#26, #253)', () => {
  const tiles = buildStageTiles([
    participant('ana:pc', { isCameraOn: true, isScreenSharing: true, screenShareIds: ['one', 'two'] }),
    participant('bia:pc'),
  ], NOBODY, [{ id: 'chess' } as BotScreen]);
  assert.deepEqual(tiles.map(tile => [tile.key, tile.kind, tile.kind === 'miniapp' ? null : tile.local]), [
    ['ana:pc:camera', 'camera', false],
    ['ana:pc:screen:one', 'screen', false],
    ['ana:pc:screen:two', 'screen', false],
    ['bia:pc:voice', 'voice', false],
    ['miniapp:chess', 'miniapp', null],
  ]);
});

test("this client's own tiles follow the call, ahead of a roster that has not caught up", () => {
  const own: OwnStageMedia = { sessionId: 'me:pc', cameraOn: true, screenShareIds: ['fresh'] };
  const tiles = buildStageTiles([participant('me:pc', { isCameraOn: false, screenShareIds: ['stale'], isScreenSharing: true })], own);
  assert.deepEqual(tiles.map(tile => [tile.key, tile.kind === 'miniapp' ? null : tile.local]),
    [['me:pc:camera', true], ['me:pc:screen:fresh', true]]);
  // The same person on another device is somebody else's connection (#309).
  const elsewhere = buildStageTiles([participant('me:laptop', { isCameraOn: true })], own);
  assert.deepEqual(elsewhere.map(tile => [tile.key, tile.kind === 'miniapp' ? null : tile.local]), [['me:laptop:camera', false]]);
});

test('announced share ids are the single choke point for hostile, repeated or excess ids', () => {
  const hostile = participant('eve:pc', {
    isScreenSharing: true, screenShareIds: ['ok-1', '"><img src=x>', 'ok-1', 'x'.repeat(65), 'ok_2.b'],
  });
  assert.deepEqual(screenShareIds(hostile), ['ok-1', 'ok_2.b']);
  const many = Array.from({ length: SCREEN_SHARE_LIMITS.maximum + 3 }, (_, index) => `share-${index}`);
  assert.equal(screenShareIds(participant('max:pc', { isScreenSharing: true, screenShareIds: many })).length,
    SCREEN_SHARE_LIMITS.maximum);
  assert.deepEqual(screenShareIds(participant('old:pc', { isScreenSharing: true })), [LEGACY_SHARE_ID],
    'a peer older than #253 still shows one screen');
  assert.deepEqual(screenShareIds(participant('bad:pc', { isScreenSharing: true, screenShareIds: ['<b>'] })), [LEGACY_SHARE_ID]);
  assert.deepEqual(screenShareIds(participant('none:pc')), []);
  assert.deepEqual(screenShareIds(participant('me:pc', { screenShareIds: ['announced'] }), ['own']), ['own']);
});

test('telemetry measures cameras, own screens and watched remote screens, with the stage keys (#340, #493)', () => {
  const tiles = buildStageTiles([
    participant('me:pc'),
    participant('ana:pc', { isCameraOn: true, isScreenSharing: true, screenShareIds: ['watched', 'locked'] }),
    participant('bia:pc'),
  ], { sessionId: 'me:pc', cameraOn: false, screenShareIds: ['mine'] }, [{ id: 'chess' } as BotScreen]);
  const watched = new Set(['ana:pc/watched']);
  const measured = measuredTiles(tiles, (sessionId, shareId) => watched.has(`${sessionId}/${shareId}`));
  assert.deepEqual(measured.map(tile => tile.key), ['me:pc:screen:mine', 'ana:pc:camera', 'ana:pc:screen:watched']);
  assert.ok(measured.every(tile => tiles.includes(tile)), 'the same tiles the stage renders, not look-alikes');
});

test('a legacy screen tile plays whichever single screen stream arrived; others play their own share', () => {
  const first = { id: 'stream-a' } as MediaStream;
  const second = { id: 'stream-b' } as MediaStream;
  const legacy = participant('old:pc', { isScreenSharing: true }, { 'stream-a': first });
  const [legacyTile] = buildStageTiles([legacy], NOBODY);
  assert.equal(remoteScreenStream(legacyTile as ParticipantStageTile), first);
  const modern = participant('new:pc', { isScreenSharing: true, screenShareIds: ['stream-b'] }, { 'stream-a': first, 'stream-b': second });
  const [modernTile] = buildStageTiles([modern], NOBODY);
  assert.equal(remoteScreenStream(modernTile as ParticipantStageTile), second);
  assert.equal(tileDomId(modernTile), 'new:pc-screen-stream-b');
  assert.equal(tileDomId(buildStageTiles([], NOBODY, [{ id: 'chess' } as BotScreen])[0]), 'bot-screen-chess');
});
