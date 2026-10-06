import { MessageType } from '@monky/shared';
import { voiceStore } from '../stores/voiceStore';
import { networkClient, type NetworkClient } from './NetworkClient';
import { sessionManager } from './SessionManager';
import { videoService } from './VideoService';
import { webRtcManager } from './WebRtcManager';
import type { ServerStore } from '../stores/serverStore';

interface ScreenShareCall {
  readonly client: NetworkClient | null;
  readonly serverStore: ServerStore | null;
  readonly isCurrent: () => boolean;
}

type StopScreenSharesOptions =
  | { shareIds?: readonly string[]; notify?: boolean; teardown?: false }
  | { teardown: true; shareIds?: never; notify?: false };

export function captureScreenShareCall(): ScreenShareCall {
  const sessionKey = voiceStore.voiceSessionKey;
  const channelId = voiceStore.currentVoiceChannelId;
  const session = sessionKey ? sessionManager.get(sessionKey) : sessionManager.getActive();
  const sessionId = session?.serverStore.currentUser?.sessionId;
  return {
    // Never fall back to the visible server when the call's session disappeared.
    client: session?.client ?? (sessionKey ? null : networkClient),
    serverStore: session?.serverStore ?? null,
    isCurrent: () => channelId !== null && voiceStore.currentVoiceChannelId === channelId
      && voiceStore.voiceSessionKey === sessionKey
      && (sessionKey ? !!session && sessionManager.get(sessionKey) === session : sessionManager.getActive() === session)
      && session?.serverStore.currentUser?.sessionId === sessionId,
  };
}

export function notifyScreenShareState(call: Pick<ScreenShareCall, 'client' | 'isCurrent'>): void {
  if (!call.isCurrent() || !call.client) return;
  const screenShareIds = [...voiceStore.screenShareIds];
  call.client.send(MessageType.VOICE_STATE_UPDATE, webRtcManager.getLocalScreenState());
  // Ordered signaling retires the old roster before replacement metadata has
  // to fit the receiver's bounded cache. SDP may have announced it too early.
  if (call.isCurrent()) webRtcManager.announcePublishedScreenSources(screenShareIds);
}

/**
 * Capture, transport and store cleanup share one boundary. Audio remains owned
 * by ScreenAudioService, passed explicitly to avoid its serverConnection cycle.
 */
export async function stopLocalScreenShares(
  audio: { stop(): Promise<void> },
  options: StopScreenSharesOptions = {},
): Promise<void> {
  const call = captureScreenShareCall();
  const allShares = options.shareIds === undefined;
  const activeIds = new Set([...videoService.getScreenShareIds(), ...voiceStore.screenShareIds]);
  const shareIds = allShares ? [...activeIds] : [...new Set(options.shareIds)];
  const nativeIds = shareIds.filter(shareId => videoService.getNativeScreenCapture(shareId) !== null);
  const removedIds = new Set(shareIds);
  // removeScreenShare clears this association, so decide before mutating it.
  const stopAudio = allShares
    || (voiceStore.screenAudioShareId !== null && removedIds.has(voiceStore.screenAudioShareId))
    || (shareIds.some(id => activeIds.has(id)) && [...activeIds].every(id => removedIds.has(id)));
  const audioStopped = stopAudio ? audio.stop() : Promise.resolve();

  if (allShares) {
    videoService.stopScreenShare();
    voiceStore.setScreenSharing(false);
  } else {
    for (const shareId of shareIds) {
      videoService.stopScreenShare(shareId);
      voiceStore.removeScreenShare(shareId);
    }
    if (stopAudio && voiceStore.screenAudioShareId !== null) voiceStore.setScreenAudioShare(null);
  }

  // Closing calls already retire their transports. Do not negotiate or announce
  // a late state update while a different channel is being admitted.
  const detached = (async () => {
    if (options.teardown) webRtcManager.clearLocalScreenTracks();
    else for (const shareId of shareIds) await webRtcManager.removeLocalScreenTrack(shareId);
  })();
  const notify = !options.teardown && options.notify !== false;
  if (notify && nativeIds.length === 0) notifyScreenShareState(call);

  const results = await Promise.allSettled([
    detached, audioStopped, ...nativeIds.map(shareId => webRtcManager.removeNativeScreenSource(shareId)),
  ]);
  // Native Closed/control messages still need the source's server-side leases.
  if (notify && nativeIds.length > 0) notifyScreenShareState(call);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}
