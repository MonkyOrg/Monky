import type { DmFailure, DmPeerView } from '@monky/shared';
import { appEvents } from '../../core/EventBus';
import { t } from '../../i18n';
import { dmStore } from '../../stores/dmStore';
import type { ContextMenuEntry } from '../ContextMenu';
import { showErrorToast, showInfoToast } from '../CopyToast';
import { showConfirm } from '../Dialog';
import { dmFailureMessage } from './dmErrors';

type PeerSummary = Pick<DmPeerView, 'publicKey' | 'nickname' | 'relation' | 'blocked'>;

export async function reportDmFailure(operation: Promise<DmFailure | null>, peer: string, nickname = ''): Promise<boolean> {
  const failure = await operation;
  if (!failure) return true;
  showErrorToast(dmFailureMessage(failure, dmStore.peer(peer)?.nickname || nickname), 7000);
  return false;
}

/** Shows the conversation on Home, leaving the current server view if needed. */
export function openDirectMessage(peer: string): void {
  appEvents.emit('dm.open', peer);
}

export async function sendFriendRequest(peer: string, nickname: string): Promise<void> {
  if (await reportDmFailure(dmStore.sendFriendRequest(peer, nickname), peer, nickname)) {
    showInfoToast(t('home.friendRequestSent', { nickname }), 6000);
  }
}

export async function confirmRemoveFriend(peer: PeerSummary): Promise<void> {
  const confirmed = await showConfirm({
    title: t('home.removeFriendConfirmTitle', { nickname: peer.nickname }),
    message: t('home.removeFriendConfirm'),
    confirmLabel: t('home.removeFriend'),
    variant: 'danger',
  });
  if (confirmed) await reportDmFailure(dmStore.removeFriend(peer.publicKey), peer.publicKey);
}

export async function confirmBlock(peer: Pick<PeerSummary, 'publicKey' | 'nickname'>): Promise<void> {
  const confirmed = await showConfirm({
    title: t('home.blockConfirmTitle', { nickname: peer.nickname }),
    message: t('home.blockConfirm'),
    confirmLabel: t('home.blockUser'),
    variant: 'danger',
  });
  if (confirmed) await reportDmFailure(dmStore.block(peer.publicKey, peer.nickname), peer.publicKey, peer.nickname);
}

/**
 * Friendship actions offered for a person, the same on Home rows and in the
 * member menu inside servers, so both places behave identically.
 */
export function peerMenuItems(peer: PeerSummary): ContextMenuEntry[] {
  const id = peer.publicKey;
  if (peer.blocked) {
    return [{ label: t('home.unblockUser'), icon: 'lock_open', onClick: () => void reportDmFailure(dmStore.unblock(id), id) }];
  }
  const items: ContextMenuEntry[] = [];
  switch (peer.relation) {
    case 'friend':
      items.push({ label: t('dm.sendMessage'), icon: 'chat', onClick: () => openDirectMessage(id) });
      break;
    case 'incoming':
      items.push(
        { label: t('home.acceptRequest'), icon: 'person_add', onClick: () => void reportDmFailure(dmStore.acceptFriend(id), id) },
        { label: t('home.declineRequest'), icon: 'person_remove', onClick: () => void reportDmFailure(dmStore.declineFriend(id), id) },
      );
      break;
    case 'outgoing':
      items.push({ label: t('home.cancelRequest'), icon: 'close', onClick: () => void reportDmFailure(dmStore.cancelFriendRequest(id), id) });
      break;
    default:
      items.push({ label: t('dm.addFriend'), icon: 'person_add', onClick: () => void sendFriendRequest(id, peer.nickname) });
  }
  if (peer.relation === 'friend') {
    items.push({ label: t('home.removeFriend'), icon: 'person_remove', danger: true, onClick: () => void confirmRemoveFriend(peer) });
  }
  items.push({ label: t('home.blockUser'), icon: 'block', danger: true, onClick: () => void confirmBlock(peer) });
  return items;
}
