import { screenAudioService } from './ScreenAudioService';
import { captureScreenShareCall, notifyScreenShareState, stopLocalScreenShares } from './screenShareControls';
import { videoService } from './VideoService';
import { webRtcManager } from './WebRtcManager';
import { voiceStore } from '../stores/voiceStore';

/**
 * Streams the game window straight away, without the picker (#763): the click
 * on the game row is the explicit confirmation sharing requires, and there is
 * nothing to choose — the window, Normal capture, the game's audio, the whole
 * call as audience. It is only offered while nothing is shared, so there is
 * never a previous share or audio owner to retire.
 *
 * Mirrors the native branch of ScreenSharePickerModal.startSharing; any error
 * is thrown to the caller after the half-started capture is cleaned up.
 * `claim` learns the share id right before it is published, so the game strip
 * owns the "live" status from the first voice update on.
 */
export async function startGameShare(sourceId: string, claim: (shareId: string) => void): Promise<void> {
  if (voiceStore.isScreenSharing) return;
  const call = captureScreenShareCall();
  const capabilities = await webRtcManager.getNativeScreenCapabilities();
  // Better a silent stream than none: audio is dropped, never the share.
  const shareAudio = !voiceStore.permissionMuted && capabilities.captureAudio === true
    && !screenAudioService.getIsTestTone() && !screenAudioService.getIsCapturing();
  let stream: MediaStream | null = null;
  let published = false;
  const isWanted = () => call.isCurrent() && !voiceStore.isScreenSharing;
  try {
    // A minimized game is restored first, or the capture would be blank.
    if (await window.api.prepareScreenShareWindow(sourceId)) await new Promise(resolve => setTimeout(resolve, 350));
    if (!isWanted()) return;
    stream = await webRtcManager.startNativeScreenShare(sourceId, shareAudio, isWanted, 'window', true);
    if (!isWanted()) throw new DOMException('Screen share was cancelled', 'AbortError');
    if (shareAudio) {
      await screenAudioService.stop();
      voiceStore.addScreenAudioShare(stream.id);
    }
    claim(stream.id);
    voiceStore.addScreenShare(stream.id);
    notifyScreenShareState(call);
    published = true;
  } catch (error) {
    if (stream && !published && videoService.getScreenStream(stream.id) === stream) {
      try {
        if (call.isCurrent()) await stopLocalScreenShares(screenAudioService, { shareIds: [stream.id] });
        else videoService.stopScreenShare(stream.id);
      } catch (cleanupError) {
        console.warn('[GameShare] Failed to clean up the cancelled game share', cleanupError);
      }
    }
    if (error instanceof Error && error.name === 'AbortError') return;
    throw error;
  }
}
