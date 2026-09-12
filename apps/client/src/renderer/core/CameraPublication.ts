import { MessageType } from '@monky/shared';
import { appEvents } from './EventBus';
import { clientLog } from './ClientLogService';
import { callClient } from './serverConnection';
import { videoService } from './VideoService';
import { webRtcManager } from './WebRtcManager';
import { voiceStore } from '../stores/voiceStore';
import { isCameraOperationCancelled } from '../utils/cameraEffects';

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

export function bindCameraPublication(): () => void {
  let revision = 0;
  const unbind = [
    appEvents.on('local.camera_stopped', () => {
      revision++;
      setLocalCameraState(false);
      void webRtcManager.setLocalCameraTrack(null).catch(reportCameraError);
    }),
    appEvents.on('local.camera_replaced', ({ stream }: { stream: MediaStream; previousStream: MediaStream }) => {
      const channelId = voiceStore.currentVoiceChannelId;
      const sessionKey = voiceStore.voiceSessionKey;
      const current = ++revision;
      // Parameter tuning gates the same live track while its preview is "starting".
      const isCurrent = () => current === revision && channelId !== null
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
          videoService.stopCamera();
          setLocalCameraState(false);
          reportCameraError(error);
        }
      };
      void replace();
    }),
    appEvents.on('camera.effects_error', reportCameraError),
    appEvents.on('camera.publication_failed', reportCameraError),
  ];
  return () => {
    revision++;
    unbind.forEach((off) => off());
  };
}
