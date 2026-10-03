import type { DmPeerView } from '@monky/shared';
import { t } from '../../i18n';
import { dmStore } from '../../stores/dmStore';
import { connectionStore } from '../../stores/connectionStore';
import { escapeHtml } from '../../utils/html';
import { contextMenu } from '../ContextMenu';
import { DmConversationView } from './DmConversationView';
import { peerMenuItems, reportDmFailure } from './friendActions';
import { FriendsView, type FriendRowAction } from './FriendsView';
import { friendsHomeModel, type FriendsHomeModel } from './FriendsHomeModel';
import { HomeSidebar } from './HomeSidebar';

export class HomeView {
  private readonly sidebar = new HomeSidebar();
  private readonly friendsView: FriendsView;
  private conversationView: DmConversationView | null = null;
  /** Peer of the open conversation, `null` while the Friends list is shown. */
  private selectedPeer: string | null = null;
  private sidebarContainer: HTMLElement | null = null;
  private centerContainer: HTMLElement | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  private listeners: AbortController | null = null;
  /** True only while Home owns the sidebar/center; servers reuse those slots. */
  private active = false;

  constructor(private readonly model: FriendsHomeModel = friendsHomeModel) {
    this.friendsView = new FriendsView(model, {
      run: (action, id, anchor, event) => this.runFriendAction(action, id, anchor, event),
    });
  }

  public render(sidebarContainer: HTMLElement, centerContainer: HTMLElement): void {
    this.suspend();
    this.sidebarContainer = sidebarContainer;
    this.centerContainer = centerContainer;
    this.active = true;
    this.listeners = new AbortController();
    sidebarContainer.addEventListener('click', (event) => this.onSidebarClick(event), { signal: this.listeners.signal });
    sidebarContainer.addEventListener('contextmenu', (event) => this.onSidebarContextMenu(event), { signal: this.listeners.signal });
    this.unsubscribers.push(
      dmStore.bus.on('changed', () => this.refresh()),
      dmStore.bus.on('presence', () => this.refresh()),
    );
    this.syncModel();
    this.renderSidebar();
    this.renderCenter();
  }

  /** Opens a DM from anywhere in the app (e.g. a member's context menu). */
  public openConversation(peer: string): void {
    this.selectedPeer = peer;
    if (this.active) {
      this.renderSidebar();
      this.renderCenter();
    }
  }

  public showFriends(): void {
    this.selectedPeer = null;
    if (this.active) {
      this.renderSidebar();
      this.renderCenter();
    }
  }

  public suspend(): void {
    this.active = false;
    this.friendsView.destroy();
    this.conversationView?.destroy();
    this.conversationView = null;
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    this.listeners?.abort();
    this.listeners = null;
  }

  public destroy(): void {
    this.suspend();
  }

  private refresh(): void {
    if (!this.active) return;
    this.syncModel();
    this.renderSidebar();
    if (this.selectedPeer && !dmStore.peer(this.selectedPeer)) this.showFriends();
  }

  private syncModel(): void {
    const avatar = (peer: DmPeerView) => peer.avatar ?? undefined;
    this.model.setSnapshot({
      friends: dmStore.friends().map((peer) => ({
        id: peer.publicKey,
        nickname: peer.nickname,
        avatarUrl: avatar(peer),
        presence: dmStore.isOnline(peer.publicKey) ? 'online' : 'offline',
      })),
      pending: dmStore.pending().map((peer) => ({
        id: peer.publicKey,
        nickname: peer.nickname,
        avatarUrl: avatar(peer),
        direction: peer.relation === 'incoming' ? 'incoming' : 'outgoing',
      })),
      blocked: dmStore.blocked().map((peer) => ({ id: peer.publicKey, nickname: peer.nickname, avatarUrl: avatar(peer) })),
    });
  }

  private renderSidebar(): void {
    if (!this.sidebarContainer) return;
    const me = dmStore.snapshot.me?.publicKey;
    this.sidebar.setSelected(this.selectedPeer);
    this.sidebar.setPendingCount(dmStore.incomingRequests());
    const conversations = dmStore.conversationList();
    if (this.selectedPeer && !conversations.some((conversation) => conversation.peer === this.selectedPeer)) {
      const peer = dmStore.peer(this.selectedPeer);
      if (peer) conversations.unshift({ peer: peer.publicKey, lastMessageAt: Date.now(), lastMessagePreview: '', lastMessageAuthor: null, unread: 0, hidden: false, readOnly: false });
    }
    this.sidebar.setConversations(conversations.map((conversation) => {
      const peer = dmStore.peer(conversation.peer);
      const prefix = conversation.lastMessageAuthor && conversation.lastMessageAuthor === me ? t('dm.youPrefix') : '';
      return {
        id: conversation.peer,
        title: peer?.nickname || conversation.peer.slice(0, 8),
        avatarUrl: peer?.avatar ?? undefined,
        unreadCount: conversation.peer === this.selectedPeer ? 0 : conversation.unread,
        online: dmStore.isOnline(conversation.peer),
        preview: conversation.lastMessagePreview ? `${prefix}${conversation.lastMessagePreview}` : '',
      };
    }));
    this.sidebarContainer.innerHTML = this.sidebar.render();
  }

  private renderCenter(): void {
    const center = this.centerContainer;
    if (!center) return;
    this.friendsView.destroy();
    this.conversationView?.destroy();
    this.conversationView = null;
    if (this.selectedPeer && dmStore.peer(this.selectedPeer)) {
      center.innerHTML = '<div class="home-view home-view--conversation" id="home-view"><div id="dm-conversation-root" class="dm-conversation-root"></div></div>';
      const root = center.querySelector<HTMLElement>('#dm-conversation-root');
      if (!root) return;
      this.conversationView = new DmConversationView(this.selectedPeer);
      this.conversationView.mount(root);
      return;
    }
    this.selectedPeer = null;
    center.innerHTML = `
      <div class="home-view" id="home-view">
        ${connectionStore.savedServers.length === 0 ? `
          <div class="home-add-server-hint" id="home-add-server-hint" role="status">
            <span class="material-symbols-outlined md-18" aria-hidden="true">add_circle</span>
            <span>${escapeHtml(t('home.addServerHint'))}</span>
          </div>
        ` : ''}
        <div id="friends-home-root"></div>
      </div>
    `;
    const friendsRoot = center.querySelector<HTMLElement>('#friends-home-root');
    if (friendsRoot) this.friendsView.mount(friendsRoot);
  }

  private onSidebarClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest('#home-nav-friends')) {
      if (this.selectedPeer !== null) this.showFriends();
      return;
    }
    const item = target.closest<HTMLElement>('.home-dm-item[data-dm-id]');
    if (!item) return;
    const peer = item.dataset.dmId!;
    if (target.closest('[data-dm-hide]')) {
      event.stopPropagation();
      dmStore.hide(peer);
      if (this.selectedPeer === peer) this.showFriends();
      return;
    }
    if (target.closest('[data-dm-open]') && this.selectedPeer !== peer) this.openConversation(peer);
  }

  private onSidebarContextMenu(event: MouseEvent): void {
    const item = (event.target as HTMLElement).closest<HTMLElement>('.home-dm-item[data-dm-id]');
    if (!item) return;
    event.preventDefault();
    this.openPeerMenu(item.dataset.dmId!, event.clientX, event.clientY, item);
  }

  private runFriendAction(action: FriendRowAction, id: string, anchor: HTMLElement, event: MouseEvent): void {
    switch (action) {
      case 'message':
        this.openConversation(id);
        break;
      case 'accept':
        void reportDmFailure(dmStore.acceptFriend(id), id);
        break;
      case 'decline':
        void reportDmFailure(dmStore.declineFriend(id), id);
        break;
      case 'cancel':
        void reportDmFailure(dmStore.cancelFriendRequest(id), id);
        break;
      case 'unblock':
        void reportDmFailure(dmStore.unblock(id), id);
        break;
      case 'menu': {
        const rect = anchor.getBoundingClientRect();
        const x = event.type === 'contextmenu' ? event.clientX : rect.left;
        const y = event.type === 'contextmenu' ? event.clientY : rect.bottom + 4;
        this.openPeerMenu(id, x, y, anchor);
        break;
      }
    }
  }

  private openPeerMenu(id: string, x: number, y: number, anchor: HTMLElement): void {
    const peer = dmStore.peer(id);
    if (peer) contextMenu.open(x, y, peerMenuItems(peer), anchor);
  }
}
