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
 * Only a server in use — the one on screen or the one hosting the call — that
 * was closed or removed us gets a modal, because that loss is final and the
 * user needs to understand why. An update restart and any server merely kept
 * connected in the background (#400) get a toast instead: the app reconnects
 * by itself as soon as the server is back, and a modal would interrupt
 * whatever the user is doing.
 *
 * Has to run before the session is torn down, while the call and the screen
 * still point at the server that sent the notice.
 */
export function presentServerShutdownNotice(notice: ServerShutdownNotice): void {
  const updating = notice.reasonCode === 'update';
  const server = notice.serverName || '';
  // An update is temporary and the app reconnects by itself, so it never
  // needs a modal; only a final shutdown of a server in use does.
  if (updating || (notice.sessionKey && !isSessionInUse(notice.sessionKey))) {
    showInfoToast(t(updating ? 'app.serverUpdatingToast' : 'app.serverClosedToast', { server }), BACKGROUND_NOTICE_MS);
    return;
  }
  void showAlert({
    title: t('app.serverShutdownTitle'),
    message: notice.reason || t('app.serverShutdownMessage'),
    variant: 'warning',
  });
}

function isSessionInUse(sessionKey: string): boolean {
  return voiceStore.voiceSessionKey === sessionKey
    || (!sessionManager.isHome() && sessionManager.getActiveKey() === sessionKey);
}
