import { voiceStore } from '../stores/voiceStore';
import { isCameraOperationCancelled } from '../utils/cameraEffects';
import { reportCameraError, setLocalCameraState } from './CameraPublication';
import { videoService } from './VideoService';
import { webRtcManager } from './WebRtcManager';

/**
 * The camera belongs to the call, not to a view: the stage, the sidebar media
 * bar and the global shortcut all go through here. Kept on the stage, the
 * in-flight state was lost with each re-render, so a second toggle could start
 * the camera again instead of cancelling the first one.
 */
let toggleEpoch = 0;
let togglePending = false;

/**
 * Turns the camera of the current call on or off. Camera and screen share are
 * independent (#26). A second toggle cancels an unfinished start, and a camera
 * that fails to start (e.g. none plugged in) is cleanly reverted.
 */
export async function toggleCamera(): Promise<void> {
  const epoch = ++toggleEpoch;
  const channelId = voiceStore.currentVoiceChannelId;
  const sessionKey = voiceStore.voiceSessionKey;
  const isCurrentCall = () => toggleEpoch === epoch && channelId !== null
    && voiceStore.currentVoiceChannelId === channelId && voiceStore.voiceSessionKey === sessionKey;
  if (!channelId) return;
  if (voiceStore.isCameraOn || togglePending) {
    togglePending = false;
    setLocalCameraState(false);
    videoService.stopCamera();
    try {
      await webRtcManager.setLocalCameraTrack(null);
    } catch (error) {
      reportCameraError(error);
    }
    return;
  }
  togglePending = true;
  try {
    const stream = await videoService.startCamera();
    const track = stream.getVideoTracks()[0];
    const isCurrent = () => isCurrentCall() && videoService.getCameraStream() === stream;
    if (!track || !isCurrent()) throw new DOMException('Camera start was cancelled', 'AbortError');
    await webRtcManager.setLocalCameraTrack(track, isCurrent);
    if (isCurrent()) setLocalCameraState(true);
  } catch (error) {
    if (isCurrentCall() && !isCameraOperationCancelled(error)) {
      setLocalCameraState(false);
      videoService.stopCamera();
      await webRtcManager.setLocalCameraTrack(null).catch(reportCameraError);
      reportCameraError(error);
    }
  } finally {
    if (toggleEpoch === epoch) togglePending = false;
  }
}

/** Turns the call's camera off, also cancelling a toggle that is still starting it. */
export async function turnCameraOff(): Promise<void> {
  toggleEpoch++;
  togglePending = false;
  setLocalCameraState(false);
  videoService.stopCamera();
  await webRtcManager.setLocalCameraTrack(null);
}
