import { Permission } from '@monky/shared';
import { serverStore } from '../stores/serverStore';
import { t } from '../i18n';

/**
 * Text shown when a direct P2P route to somebody could not be established.
 *
 * Stating the failure alone leaves the reader stuck, and there are only two
 * ways out of it: relay the media through the server (TURN) or put both people
 * on the same VPN. Since the set of answers is small and known, the indicator
 * gives the applicable one instead of making anyone guess (#434).
 *
 * @param baseKey the message that merely describes the failure, kept as the
 *   first line so the tooltip still says what happened before what to do.
 */
export function peerFailureTooltip(baseKey: 'main.peerConnectionFailed' | 'stage.peerConnectionFailed'): string {
  const details = serverStore.serverDetails;
  let hint: string;

  if (details?.turnEnabled) {
    // TURN credentials are handed out at login, so somebody who was already
    // connected when the relay was switched on simply never received them.
    // Without saying this, a working relay looks broken.
    hint = t('peerFailure.relayOnReconnect');
  } else if (serverStore.hasPermission(Permission.MANAGE_SERVER)) {
    hint = t('peerFailure.enableRelay');
  } else {
    hint = t('peerFailure.askHost');
  }

  // A blank line keeps the suggestion from running into a single unreadable
  // line. It is plain text, so a template that escapes the title and one that
  // does not show the same two paragraphs.
  return `${t(baseKey)}\n\n${hint}`;
}
