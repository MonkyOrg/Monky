import { SCREEN_SHARE_LIMITS, type BotScreen } from '@monky/shared';
import type { ParticipantViewModel } from '../../core/ParticipantManager';

/**
 * A single renderable tile on the stage. A participant contributes one tile per
 * active media source, so someone sharing camera + screen at once shows up as
 * two independent tiles (#26). Participants with no video get a single 'voice'
 * (avatar) tile.
 */
export interface ParticipantStageTile {
  readonly p: ParticipantViewModel;
  readonly kind: 'voice' | 'camera' | 'screen';
  /** Stable identity for focus and the tile's card (stageTileKey). */
  readonly key: string;
  /** Which screen share this tile renders, for 'screen' tiles only (#253). */
  readonly shareId?: string;
  /** This client's own connection: its media comes from the call, ahead of the roster. */
  readonly local: boolean;
}

export type StageTile = ParticipantStageTile | { readonly kind: 'miniapp'; readonly key: string; readonly screen: BotScreen };

/** Tiles address a connection rather than a person: someone may join twice (#309). */
export function sidOf(p: ParticipantViewModel): string {
  return p.user.sessionId || p.user.id;
}

/**
 * Share id used for peers that only announce the legacy `isScreenSharing`
 * boolean (clients older than #253). They can only ever have one share, so a
 * fixed key is enough to give their tile a stable identity.
 */
export const LEGACY_SHARE_ID = 'legacy';

/**
 * Share ids come from other clients and are interpolated into DOM ids and data
 * attributes, so only MediaStream-shaped ids are accepted. Anything else is
 * treated as a hostile payload and ignored.
 */
const SAFE_SHARE_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export function isSafeShareId(shareId: string): boolean {
  return SAFE_SHARE_ID.test(shareId);
}

const SCREEN = ':screen:';

/** The one spelling of tile keys; the picture-in-picture window names the tile it took the same way. */
export const stageTileKey = {
  voice: (sessionId: string): string => `${sessionId}:voice`,
  camera: (sessionId: string): string => `${sessionId}:camera`,
  screen: (sessionId: string, shareId: string): string => `${sessionId}${SCREEN}${shareId}`,
  miniapp: (id: string): string => `miniapp:${id}`,
  isScreen: (key: string): boolean => key.includes(SCREEN),
  /** The share one of this connection's screen tiles shows; undefined for any other key. */
  shareOf: (key: string, sessionId: string): string | undefined =>
    key.startsWith(`${sessionId}${SCREEN}`) ? key.slice(sessionId.length + SCREEN.length) : undefined,
};

/**
 * Screen shares to render for a participant (#253): this client's own shares as
 * the call knows them, otherwise what the peer announced. Falls back to a single
 * synthetic share when the peer only reports the legacy `isScreenSharing`
 * boolean, so older clients still show up as one tile.
 *
 * Share ids arrive from other clients and end up in DOM ids and attributes,
 * so anything that isn't a plain MediaStream-style id is dropped here — this
 * is the single choke point every tile goes through.
 */
export function screenShareIds(p: ParticipantViewModel, ownShareIds?: readonly string[]): string[] {
  if (ownShareIds) return [...ownShareIds];
  const announced = p.voiceState?.screenShareIds;
  if (announced && announced.length > 0) {
    // A repeated id would give two tiles one key, and the stage keeps one card per key.
    const safe = [...new Set(announced.filter(isSafeShareId))];
    if (safe.length > 0) return safe.slice(0, SCREEN_SHARE_LIMITS.maximum);
  }
  return p.voiceState?.isScreenSharing ? [LEGACY_SHARE_ID] : [];
}

/** This client's own media in the call, which the roster may not reflect yet. */
export interface OwnStageMedia {
  readonly sessionId: string | undefined;
  readonly cameraOn: boolean;
  readonly screenShareIds: readonly string[];
}

/**
 * Expands the flat participant list into renderable tiles. Camera + screen
 * are independent, so a participant broadcasting both yields two tiles (#26);
 * a participant sharing two screens yields one tile per share (#253);
 * participants with no video yield a single avatar ('voice') tile. Miniapps follow.
 */
export function buildStageTiles(
  participants: readonly ParticipantViewModel[], own: OwnStageMedia, miniapps: readonly BotScreen[] = [],
): StageTile[] {
  const tiles: StageTile[] = [];
  for (const p of participants) {
    const sessionId = sidOf(p);
    const local = sessionId === own.sessionId;
    const cameraOn = local ? own.cameraOn : (p.voiceState?.isCameraOn ?? false);
    const shareIds = screenShareIds(p, local ? own.screenShareIds : undefined);
    if (cameraOn) tiles.push({ p, kind: 'camera', key: stageTileKey.camera(sessionId), local });
    for (const shareId of shareIds) {
      tiles.push({ p, kind: 'screen', key: stageTileKey.screen(sessionId, shareId), shareId, local });
    }
    if (!cameraOn && shareIds.length === 0) tiles.push({ p, kind: 'voice', key: stageTileKey.voice(sessionId), local });
  }
  for (const screen of miniapps) tiles.push({ kind: 'miniapp', key: stageTileKey.miniapp(screen.id), screen });
  return tiles;
}

/**
 * The tiles whose video is measured for telemetry (#340, #493): every camera, this client's
 * screens and the remote screens it watches. They keep the stage's keys, so each reading
 * lands on the overlay of its own tile.
 */
export function measuredTiles(
  tiles: readonly StageTile[], isWatching: (sessionId: string, shareId: string) => boolean,
): ParticipantStageTile[] {
  return tiles.filter((tile): tile is ParticipantStageTile => tile.kind === 'camera'
    || (tile.kind === 'screen' && (tile.local || isWatching(sidOf(tile.p), tile.shareId!))));
}

/**
 * Resolves the remote stream backing a screen tile. Pre-#253 peers announce
 * their real MediaStream id over `screen-video-meta` but never publish a
 * `screenShareIds` list, so their tile is keyed by LEGACY_SHARE_ID and has to
 * fall back to whichever single screen stream arrived for that user.
 */
export function remoteScreenStream(tile: ParticipantStageTile): MediaStream | undefined {
  const streams = tile.p.remoteScreenStreams;
  if (tile.shareId === LEGACY_SHARE_ID) return streams.values().next().value;
  return streams.get(tile.shareId!);
}

/** Stable, unique DOM id fragment for a tile — screens differ by share (#253). */
export function tileDomId(tile: StageTile): string {
  if (tile.kind === 'miniapp') return `bot-screen-${tile.screen.id}`;
  return tile.kind === 'screen' ? `${sidOf(tile.p)}-screen-${tile.shareId}` : `${sidOf(tile.p)}-${tile.kind}`;
}
