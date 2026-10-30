import { MessageType, ProtocolErrorCode, type NativeScreenEvent, type ServerErrorPayload } from '@monky/shared';
import { appEvents } from './EventBus';
import type { LocalExecutionTaskNotice } from './LocalExecutionController';
import { presentServerShutdownNotice } from './serverShutdownNotice';
import { sessionManager } from './SessionManager';
import { soundEffects } from './SoundEffects';
import { translateProtocolError } from '../i18n/protocolErrors';
import { cameraEffectErrorMessage } from '../utils/cameraEffectErrors';
import { showInfoToast } from '../views/CopyToast';
import { showAlert } from '../views/Dialog';
import { t } from '../i18n';

/**
 * What the app tells the person on its own, with no action of theirs to answer.
 * A terminal media failure (reconnection, microphone, camera, screen capture)
 * stays in a dialog so it is not missed; passing news goes to a toast.
 */
export function bindUserNotices(): () => void {
  const unbind = [
    appEvents.on('community.event_started', notice => {
      soundEffects.play('chat_message');
      showInfoToast(t('community.started', { event: notice.title, server: notice.serverName }), 7000);
    }),

    appEvents.on('localExecution.task_failed', (notice: LocalExecutionTaskNotice) => {
      if (!sessionManager.get(notice.sessionKey)) return;
      void showAlert({
        title: t('settings.tabLocalTools'),
        message: t('localExecution.taskFailed', {
          bot: notice.botName, server: notice.serverName, error: t(`localExecution.failure.${notice.reason}`),
        }),
        variant: 'danger',
      });
    }),

    appEvents.on('camera.error_notice', (error) => {
      void showAlert({ title: t('stage.cameraErrorTitle'), message: cameraEffectErrorMessage(error), variant: 'danger' });
    }),

    appEvents.on('voice.rejoin_failed', (payload: { error: string }) => {
      void showAlert({
        title: t('voiceReconnect.failedTitle'),
        message: t('voiceReconnect.failed', { error: payload.error }),
        variant: 'danger',
      });
    }),

    appEvents.on('voice.microphone_failed', (payload: { error: string }) => {
      void showAlert({
        title: t('voiceJoin.microphoneTitle'),
        message: t('voiceJoin.microphoneUnavailable', { error: payload.error }),
        variant: 'danger',
      });
    }),

    appEvents.on('audio.processing_error', () => {
      void showAlert({ title: t('audioNoise.title'), message: t('audioNoise.processingFailed'), variant: 'danger' });
    }),

    appEvents.on('native_screen.capture_fallback', (_payload: { shareId: string }) => {
      showInfoToast(t('screenShare.gameFallback'), 8000);
    }),
    appEvents.on('native_screen.source_failed', (payload: Pick<Extract<NativeScreenEvent, { type: 'error' }>, 'reason' | 'code'>) => {
      if (payload.reason === 'source-unavailable') {
        showInfoToast(t('screenShare.sourceStopping'), 8000);
        return;
      }
      if (payload.reason === 'connection-failed') {
        showInfoToast(t('screenShare.nativeFailure.connection-failed'), 8000);
        return;
      }
      void showAlert({
        title: t('screenShare.errorTitle'),
        message: payload.code === 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE'
          ? t('screenShare.gameCaptureUnavailable') : t(`screenShare.nativeFailure.${payload.reason}`),
        variant: 'danger',
      });
    }),

    // A server ended the session on purpose (closed, updating or removed us).
    // The server in use gets a modal; one kept in the background, a toast.
    appEvents.on('network.server_shutdown', presentServerShutdownNotice),

    // The SFU refusing to start after an admin switched the server to it
    // arrives as an error with no requestId, which `NetworkClient` cannot
    // correlate to anything and therefore only re-emits — so without a
    // listener the admin would never hear about it.
    //
    // The server's own message is preferred over the code's canned text: it
    // carries what actually failed (the worker error and the port preflight),
    // while the canned string only describes the port conflict. Uncorrelated
    // errors are otherwise left alone, since fire-and-forget requests fail
    // this way too and have always been silent here.
    appEvents.on(`message.${MessageType.SERVER_ERROR}`, (payload: ServerErrorPayload) => {
      if (payload?.code !== ProtocolErrorCode.SFU_UNAVAILABLE) return;
      void showAlert({
        title: t('sfu.unavailableTitle'),
        message: payload.message || translateProtocolError(payload.code, payload.message),
        variant: 'warning',
      });
    }),
  ];
  return () => unbind.forEach(off => off());
}
