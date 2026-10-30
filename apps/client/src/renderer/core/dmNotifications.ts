import { t } from '../i18n';
import { dmStore } from '../stores/dmStore';
import { showInfoToast } from '../views/CopyToast';
import { serverRailView } from '../views/ServerRailView';
import { DmIncomingBurst } from './dmIncomingBurst';
import { soundEffects } from './SoundEffects';

/**
 * Sound, toast and Home badge for direct messages (#743). Nothing fires for
 * the conversation the user is reading in a focused window, and the messages
 * a friend sent while away ring once, as one "N new messages" toast.
 */
export function bindDmNotifications(): () => void {
  const syncBadge = () => serverRailView.setHomeBadge(dmStore.unreadTotal() + dmStore.incomingRequests());
  const reading = (peer: string) => dmStore.activePeer === peer && document.hasFocus();
  const nickname = (peer: string, fallback = '') => dmStore.peer(peer)?.nickname || fallback || peer.slice(0, 8);
  const incoming = new DmIncomingBurst({
    sound: () => soundEffects.play('chat_message'),
    toast: (peer, count) => {
      // The conversation may have been opened while the burst was still arriving.
      if (reading(peer)) return;
      showInfoToast(count > 1
        ? t('dm.newMessagesToast', { count, nickname: nickname(peer) })
        : t('dm.newMessageToast', { nickname: nickname(peer) }), 5000);
    },
  });

  const onFocus = () => {
    if (dmStore.activePeer) void dmStore.markRead(dmStore.activePeer);
  };
  window.addEventListener('focus', onFocus);

  const unsubscribers = [
    dmStore.bus.on('changed', syncBadge),
    dmStore.bus.on('incoming', ({ peer }) => {
      if (!reading(peer)) incoming.add(peer);
    }),
    dmStore.bus.on('friend-request', ({ peer, nickname: name }) => {
      soundEffects.play('chat_message');
      showInfoToast(t('dm.friendRequestToast', { nickname: nickname(peer, name) }), 6000);
    }),
    dmStore.bus.on('friend-accepted', ({ peer, nickname: name }) => {
      soundEffects.play('chat_message');
      showInfoToast(t('dm.friendAcceptedToast', { nickname: nickname(peer, name) }), 6000);
    }),
  ];
  syncBadge();

  return () => {
    window.removeEventListener('focus', onFocus);
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    incoming.dispose();
  };
}
