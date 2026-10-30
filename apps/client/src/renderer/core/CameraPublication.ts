import { MessageType } from '@monky/shared';
import { appEvents } from './EventBus';
import { clientLog } from './ClientLogService';
import { callClient } from './callScope';
import { videoService } from './VideoService';
import { webRtcManager } from './WebRtcManager';
import { voiceStore } from '../stores/voiceStore';
import { isCameraOperationCancelled } from '../utils/cameraEffects';

/**
 * The call's camera: turning it on and off, and keeping what the call publishes
 * in step with the capture (#26, R-VOICE-9).
 *
 * It belongs to the call, not to a view: the stage, the sidebar media bar and
 * the global shortcut all come here. One counter orders every camera intent —
 * a start, a stop from anywhere and a source replacement — so a result that
 * resolves after a newer intent is dropped instead of undoing it.
 */
let epoch = 0;
/** The start still in flight: a second toggle cancels it instead of starting again. */
let starting: object | null = null;
/**
 * Set while this module stops the capture itself. The capture answers with a
 * synchronous `local.camera_stopped` for a publication that was already ended,
 * and ending it twice is what used to send the stop to every peer twice.
 */
let stoppingCapture = false;

const reportedErrors = new WeakSet<object>();

export function reportCameraError(error: unknown): void {
  if (isCameraOperationCancelled(error)) return;
  if (error && typeof error === 'object') {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
  }
  clientLog.error('VIDEO', 'Camera operation failed', { error: error instanceof Error ? error.message : String(error) });
  appEvents.emit('camera.error_notice', error);
}

export function setLocalCameraState(enabled: boolean): void {
  if (voiceStore.isCameraOn === enabled) return;
  voiceStore.setCameraOn(enabled);
  if (voiceStore.currentVoiceChannelId) {
    callClient().send(MessageType.VOICE_STATE_UPDATE, { isCameraOn: enabled });
  }
}

/** Ends what the call publishes for the camera, once, whoever stopped it. */
function endPublication(): Promise<void> {
  epoch++;
  starting = null;
  setLocalCameraState(false);
  return webRtcManager.setLocalCameraTrack(null);
}

function stopCapture(): void {
  stoppingCapture = true;
  try {
    videoService.stopCamera();
  } finally {
    stoppingCapture = false;
  }
}

/**
 * Turns the camera of the current call on or off. Camera and screen share are
 * independent (#26). A second toggle cancels an unfinished start, and a camera
 * that fails to start (e.g. none plugged in) is cleanly reverted.
 */
export async function toggleCamera(): Promise<void> {
  const channelId = voiceStore.currentVoiceChannelId;
  if (!channelId) return;
  if (voiceStore.isCameraOn || starting) {
    try {
      await turnCameraOff();
    } catch (error) {
      reportCameraError(error);
    }
    return;
  }
  await startCamera(channelId);
}

/** Turns the call's camera off, also cancelling a toggle that is still starting it. */
export async function turnCameraOff(): Promise<void> {
  const unpublished = endPublication();
  stopCapture();
  await unpublished;
}

/**
 * Starts the camera and publishes it. The capture announces `local.camera_started`
 * on the way; the start is published here instead, so it keeps a single owner
 * that can still cancel it.
 */
async function startCamera(channelId: string): Promise<void> {
  const sessionKey = voiceStore.voiceSessionKey;
  const intent = ++epoch;
  const attempt = {};
  starting = attempt;
  const isCurrentCall = () => epoch === intent
    && voiceStore.currentVoiceChannelId === channelId && voiceStore.voiceSessionKey === sessionKey;
  try {
    const stream = await videoService.startCamera();
    const track = stream.getVideoTracks()[0];
    const isCurrent = () => isCurrentCall() && videoService.getCameraStream() === stream;
    if (!track || !isCurrent()) throw new DOMException('Camera start was cancelled', 'AbortError');
    await webRtcManager.setLocalCameraTrack(track, isCurrent);
    if (isCurrent()) setLocalCameraState(true);
  } catch (error) {
    if (isCurrentCall() && !isCameraOperationCancelled(error)) {
      const unpublished = endPublication();
      stopCapture();
      await unpublished.catch(reportCameraError);
      reportCameraError(error);
    }
  } finally {
    if (starting === attempt) starting = null;
  }
}

/** Publishes the capture's new source (another device, an effect) in place of the old one. */
function republish(stream: MediaStream): void {
  const intent = ++epoch;
  const channelId = voiceStore.currentVoiceChannelId;
  const sessionKey = voiceStore.voiceSessionKey;
  // Parameter tuning gates the same live track while its preview is "starting".
  const isCurrent = () => epoch === intent && channelId !== null
    && voiceStore.currentVoiceChannelId === channelId && voiceStore.voiceSessionKey === sessionKey
    && videoService.getCameraState().publishing && videoService.getCameraStream() === stream;
  if (!isCurrent()) return;
  const replace = async () => {
    try {
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('Camera stream has no video track');
      await webRtcManager.setLocalCameraTrack(track, isCurrent);
      if (isCurrent()) setLocalCameraState(true);
    } catch (error) {
      if (!isCurrent() || isCameraOperationCancelled(error)) return;
      const unpublished = endPublication();
      stopCapture();
      reportCameraError(error);
      void unpublished.catch(reportCameraError);
    }
  };
  void replace();
}

export function bindCameraPublication(): () => void {
  const unbind = [
    // Stops from anywhere else: settings, a failed effect, leaving the call.
    appEvents.on('local.camera_stopped', () => {
      if (!stoppingCapture) void endPublication().catch(reportCameraError);
    }),
    appEvents.on('local.camera_replaced', ({ stream }: { stream: MediaStream; previousStream: MediaStream }) => {
      republish(stream);
    }),
    appEvents.on('camera.effects_error', reportCameraError),
    appEvents.on('camera.publication_failed', reportCameraError),
  ];
  return () => {
    epoch++;
    unbind.forEach((off) => off());
  };
}