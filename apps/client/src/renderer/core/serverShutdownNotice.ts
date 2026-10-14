import { t } from '../i18n';
import { voiceStore } from '../stores/voiceStore';
import { showInfoToast } from '../views/CopyToast';
import { showAlert } from '../views/Dialog';
import type { ServerShutdownNotice } from './NetworkClient';
import { sessionManager } from './SessionManager';

const BACKGROUND_NOTICE_MS = 8000;

/**
 * Tells the user that a server ended their session: it was closed, is
 * restarting to update, or removed them.
 *
 * Only the server in use gets a modal — the one on screen or the one hosting
 * the call — because losing it changes what the user sees or hears, so they
 * need to stop and understand why. A server merely kept connected in the
 * background (#400) gets a toast instead: a modal there would interrupt
 * whatever the user is doing elsewhere, and again on every restart, since the
 * app reconnects to it as soon as it is back.
 *
 * Has to run before the session is torn down, while the call and the screen
 * still point at the server that sent the notice.
 */
export function presentServerShutdownNotice(notice: ServerShutdownNotice): void {
  const updating = notice.reasonCode === 'update';
  const server = notice.serverName || '';
  if (notice.sessionKey && !isSessionInUse(notice.sessionKey)) {
    showInfoToast(t(updating ? 'app.serverUpdatingToast' : 'app.serverClosedToast', { server }), BACKGROUND_NOTICE_MS);
    return;
  }
  void showAlert({
    title: t(updating ? 'app.serverUpdatingTitle' : 'app.serverShutdownTitle'),
    message: updating ? t('app.serverUpdatingMessage', { server }) : notice.reason || t('app.serverShutdownMessage'),
    variant: 'warning',
  });
}

function isSessionInUse(sessionKey: string): boolean {
  return voiceStore.voiceSessionKey === sessionKey
    || (!sessionManager.isHome() && sessionManager.getActiveKey() === sessionKey);
}
