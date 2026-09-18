import { GameInvitePayload, GameJoinRequestedPayload, MessageType } from '@monky/shared';
import { t } from '../i18n';
import { showAlert, showConfirm, showConfirmWithText } from '../views/Dialog';
import { showInfoToast } from '../views/CopyToast';
import { getActiveNetworkClient } from './NetworkClient';
import { appEvents } from './EventBus';

/**
 * Asking to join and inviting, the two halves of #675.
 *
 * Monky cannot read the lobby a game is in — that needs the Steamworks SDK
 * running inside a Steam app — but the host can always copy the link Steam
 * itself puts behind "Join game". So the host is the one who closes the loop,
 * and everything here is built around that: a request nudges them, and their
 * answer carries the link.
 */

/** Who an invite is being addressed to — no more of a user than this is needed. */
export interface InviteTarget {
  id: string;
  nickname: string;
}

/** Asks the host for the link Steam gives them, then sends it to one person. */
export async function promptLobbyInviteFor(user: InviteTarget): Promise<void> {
  const { confirmed, value } = await showConfirmWithText({
    title: t('gameInvite.promptTitle'),
    message: t('gameInvite.promptMessage', { nickname: user.nickname }),
    variant: 'info',
    confirmLabel: t('gameInvite.promptConfirm'),
    textInput: {
      label: t('gameInvite.promptLabel'),
      value: '',
      hint: t('gameInvite.promptHint'),
      maxLength: 200,
    },
  });
  if (!confirmed) return;

  // Parsed in the main process: the renderer never turns text into a steam:// URL.
  const invite = await window.api?.parseGameLobbyLink?.(value ?? '');
  if (!invite) {
    await showAlert({
      title: t('gameInvite.invalidTitle'),
      message: t('gameInvite.invalidMessage'),
      variant: 'warning',
    });
    return;
  }

  getActiveNetworkClient().send(MessageType.GAME_INVITE_SEND, { targetUserId: user.id, invite });
  showInfoToast(t('gameInvite.sent', { nickname: user.nickname }));
}

/**
 * Listens for the two directed messages (#675).
 *
 * Both sides are a prompt rather than a silent action: a request should not
 * hand out a lobby without the host agreeing, and an incoming invite should not
 * launch a game on its own.
 */
export function installGameInviteHandlers(): () => void {
  const offRequested = appEvents.on(
    `message.${MessageType.GAME_JOIN_REQUESTED}`,
    (payload: GameJoinRequestedPayload) => {
      void (async () => {
        const accepted = await showConfirm({
          title: t('gameInvite.requestTitle'),
          message: t('gameInvite.requestMessage', { nickname: payload.nickname }),
          variant: 'info',
          confirmLabel: t('gameInvite.requestConfirm'),
        });
        if (!accepted) return;
        await promptLobbyInviteFor({ id: payload.fromUserId, nickname: payload.nickname });
      })();
    }
  );

  const offInvite = appEvents.on(
    `message.${MessageType.GAME_INVITE}`,
    (payload: GameInvitePayload) => {
      void (async () => {
        const join = await showConfirm({
          title: t('gameInvite.receivedTitle'),
          message: t('gameInvite.receivedMessage', { nickname: payload.nickname }),
          variant: 'info',
          confirmLabel: t('gameInvite.receivedConfirm'),
        });
        if (!join) return;
        const result = await window.api?.openGameLobby?.(payload.invite);
        if (!result?.success) {
          await showAlert({
            title: t('gameInvite.openFailedTitle'),
            message: t('gameInvite.openFailedMessage'),
            variant: 'warning',
          });
        }
      })();
    }
  );

  return () => {
    offRequested();
    offInvite();
  };
}
