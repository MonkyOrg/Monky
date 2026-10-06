import { t } from '../i18n';
import { dmStore } from '../stores/dmStore';
import { showInfoToast } from '../views/CopyToast';
import { serverRailView } from '../views/ServerRailView';
import { soundEffects } from './SoundEffects';

/**
 * Sound, toast and Home badge for direct messages (#743). Nothing fires for
 * the conversation the user is reading in a focused window.
 */
export function bindDmNotifications(): () => void {
  const syncBadge = () => serverRailView.setHomeBadge(dmStore.unreadTotal() + dmStore.incomingRequests());
  const reading = (peer: string) => dmStore.activePeer === peer && document.hasFocus();
  const nickname = (peer: string, fallback = '') => dmStore.peer(peer)?.nickname || fallback || peer.slice(0, 8);

  const onFocus = () => {
    if (dmStore.activePeer) void dmStore.markRead(dmStore.activePeer);
  };
  window.addEventListener('focus', onFocus);

  const unsubscribers = [
    dmStore.bus.on('changed', syncBadge),
    dmStore.bus.on<{ peer: string }>('incoming', ({ peer }) => {
      if (reading(peer)) return;
      soundEffects.play('chat_message');
      showInfoToast(t('dm.newMessageToast', { nickname: nickname(peer) }), 5000);
    }),
    dmStore.bus.on<{ peer: string; nickname: string }>('friend-request', ({ peer, nickname: name }) => {
      soundEffects.play('chat_message');
      showInfoToast(t('dm.friendRequestToast', { nickname: nickname(peer, name) }), 6000);
    }),
    dmStore.bus.on<{ peer: string; nickname: string }>('friend-accepted', ({ peer, nickname: name }) => {
      soundEffects.play('chat_message');
      showInfoToast(t('dm.friendAcceptedToast', { nickname: nickname(peer, name) }), 6000);
    }),
  ];
  syncBadge();

  return () => {
    window.removeEventListener('focus', onFocus);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  };
}
