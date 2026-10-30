import { MessageType, SCREEN_SHARE_LIMITS } from '@monky/shared';
import { voiceStore } from '../stores/voiceStore';
import type { NetworkClient } from './NetworkClient';
import { captureCall } from './callScope';
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

/** The call the screens are published to; a call whose session disappeared has no client (R-VOICE-8). */
export function captureScreenShareCall(): ScreenShareCall {
  const call = captureCall();
  return { client: call.server?.client ?? null, serverStore: call.server?.serverStore ?? null, isCurrent: call.isCurrent };
}

/** Screens this call may publish at once; a server without `screen-shares-8` only accepts the legacy pair. */
export function screenShareLimit(call: Pick<ScreenShareCall, 'serverStore'>): number {
  return call.serverStore?.serverDetails?.protocol?.features.includes('screen-shares-8')
    ? SCREEN_SHARE_LIMITS.maximum : SCREEN_SHARE_LIMITS.legacy;
}

export function notifyScreenShareState(call: Pick<ScreenShareCall, 'client' | 'isCurrent'>): void {
  if (!call.isCurrent() || !call.client) return;
  call.client.send(MessageType.VOICE_STATE_UPDATE, webRtcManager.getLocalScreenState());
}

/** Capture, transport and store cleanup share one boundary; native sources own their audio. */
export async function stopLocalScreenShares(options: StopScreenSharesOptions = {}): Promise<void> {
  const call = captureScreenShareCall();
  const allShares = options.shareIds === undefined;
  const activeIds = new Set([...videoService.getScreenShareIds(), ...voiceStore.screenShareIds]);
  const shareIds = allShares ? [...activeIds] : [...new Set(options.shareIds)];
  const nativeIds = shareIds.filter(shareId => videoService.getNativeScreenCapture(shareId) !== null);
  const removedIds = new Set(shareIds);

  if (allShares) {
    videoService.stopScreenShare();
    voiceStore.setScreenSharing(false);
  } else {
    // removeScreenShare clears this association, so decide before mutating it.
    const releasesAudio = voiceStore.screenAudioShareIds.some(id => removedIds.has(id))
      || (shareIds.some(id => activeIds.has(id)) && [...activeIds].every(id => removedIds.has(id)));
    for (const shareId of shareIds) {
      videoService.stopScreenShare(shareId);
      voiceStore.removeScreenShare(shareId);
    }
    // With nothing left on air, no audio association may outlive its share.
    if (releasesAudio && !voiceStore.isScreenSharing) {
      for (const id of [...voiceStore.screenAudioShareIds]) voiceStore.removeScreenAudioShare(id);
    }
  }

  // Closing calls already retire their transports. Do not announce a late
  // state update while a different channel is being admitted.
  const notify = !options.teardown && options.notify !== false;
  if (notify && nativeIds.length === 0) notifyScreenShareState(call);

  const results = await Promise.allSettled(nativeIds.map(shareId => webRtcManager.removeNativeScreenSource(shareId)));
  // Native Closed/control messages still need the source's server-side leases.
  if (notify && nativeIds.length > 0) notifyScreenShareState(call);
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}
