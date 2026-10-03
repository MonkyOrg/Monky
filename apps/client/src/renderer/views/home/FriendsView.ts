import { t, type TranslationKey } from '../../i18n';
import { getAvatarUrl } from '../../utils/avatar';
import { escapeHtml } from '../../utils/html';
import {
  type BlockedFriendEntry,
  type FriendHomeEntry,
  type FriendsHomeModel,
  type FriendsHomeSnapshot,
  type PendingFriendEntry,
} from './FriendsHomeModel';

type FriendsTab = 'online' | 'all' | 'pending' | 'blocked';

export type FriendRowAction = 'message' | 'accept' | 'decline' | 'cancel' | 'unblock' | 'menu';

export interface FriendsViewActions {
  run(action: FriendRowAction, id: string, anchor: HTMLElement, event: MouseEvent): void;
}

export class FriendsView {
  private activeTab: FriendsTab = 'online';
  private unsubscribe: (() => void) | null = null;
  private listeners: AbortController | null = null;

  constructor(private readonly model: FriendsHomeModel, private readonly actions?: FriendsViewActions) {}

  public mount(container: HTMLElement): void {
    this.destroy();
    this.unsubscribe = this.model.subscribe(() => this.render(container));
    this.listeners = new AbortController();
    const { signal } = this.listeners;
    container.addEventListener('click', (event) => this.onClick(container, event), { signal });
    container.addEventListener('contextmenu', (event) => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('.friends-row[data-friend-id][data-friend-menu]');
      if (!row || !this.actions) return;
      event.preventDefault();
      this.actions.run('menu', row.dataset.friendId!, row, event);
    }, { signal });
    this.render(container);
  }

  public destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners?.abort();
    this.listeners = null;
  }

  /** Opens a tab programmatically, e.g. Pending after a friend request toast. */
  public showTab(tab: FriendsTab): void {
    this.activeTab = tab;
  }

  private onClick(container: HTMLElement, event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const tabButton = target.closest<HTMLButtonElement>('[data-friends-tab]');
    if (tabButton) {
      const next = tabButton.dataset.friendsTab as FriendsTab | undefined;
      if (!next || next === this.activeTab) return;
      this.activeTab = next;
      this.render(container);
      return;
    }
    if (!this.actions) return;
    const actionButton = target.closest<HTMLButtonElement>('[data-friend-action]');
    const row = target.closest<HTMLElement>('.friends-row[data-friend-id]');
    if (!row) return;
    const id = row.dataset.friendId!;
    if (actionButton) {
      event.stopPropagation();
      this.actions.run(actionButton.dataset.friendAction as FriendRowAction, id, actionButton, event);
      return;
    }
    if (row.dataset.friendMessage !== undefined) this.actions.run('message', id, row, event);
  }

  private render(container: HTMLElement): void {
    const snapshot = this.model.getSnapshot();
    if (this.activeTab === 'blocked' && snapshot.blocked.length === 0) this.activeTab = 'online';
    const incoming = snapshot.pending.filter((entry) => entry.direction === 'incoming').length;
    container.innerHTML = `
      <section class="friends-home" aria-labelledby="friends-home-title">
        <header class="friends-home-header">
          <div class="friends-home-heading">
            <span class="material-symbols-outlined md-24" aria-hidden="true">group</span>
            <h1 id="friends-home-title">${t('home.friendsTitle')}</h1>
          </div>
          <div class="friends-tabs" role="tablist" aria-label="${escapeHtml(t('home.friendsTabsLabel'))}">
            ${this.renderTab('online', t('home.tabAvailable'), this.countOnline(snapshot))}
            ${this.renderTab('all', t('home.tabAll'), snapshot.friends.length)}
            ${this.renderTab('pending', t('home.tabPending'), snapshot.pending.length, incoming > 0)}
            ${snapshot.blocked.length > 0 ? this.renderTab('blocked', t('home.tabBlocked'), snapshot.blocked.length) : ''}
          </div>
        </header>
        <div id="friends-home-panel" class="friends-home-panel" role="tabpanel">
          ${this.renderPanel(snapshot)}
        </div>
      </section>
    `;
  }

  private renderTab(tab: FriendsTab, label: string, count: number, highlight = false): string {
    const selected = this.activeTab === tab;
    return `
      <button type="button" class="friends-tab ${selected ? 'selected' : ''}" role="tab"
        aria-selected="${selected}" data-friends-tab="${tab}">
        <span>${escapeHtml(label)}</span>
        <span class="friends-tab-count${highlight ? ' friends-tab-count--alert' : ''}">${count}</span>
      </button>
    `;
  }

  private renderPanel(snapshot: FriendsHomeSnapshot): string {
    if (this.activeTab === 'online') {
      const online = snapshot.friends.filter(friend => friend.presence === 'online');
      return online.length ? this.renderFriendRows(online) : this.renderEmpty('home.emptyAvailableTitle', 'home.emptyAvailableDesc', 'person_add');
    }
    if (this.activeTab === 'all') {
      return snapshot.friends.length ? this.renderFriendRows(snapshot.friends) : this.renderEmpty('home.emptyAllTitle', 'home.emptyAllDesc', 'group_add');
    }
    if (this.activeTab === 'pending') {
      return snapshot.pending.length ? this.renderPendingRows(snapshot.pending) : this.renderEmpty('home.emptyPendingTitle', 'home.emptyPendingDesc', 'hourglass_empty');
    }
    return snapshot.blocked.length ? this.renderBlockedRows(snapshot.blocked) : this.renderEmpty('home.emptyBlockedTitle', 'home.emptyBlockedDesc', 'block');
  }

  private actionButton(action: FriendRowAction, icon: string, label: string, danger = false): string {
    if (!this.actions) return '';
    return `<button type="button" class="friends-row-action${danger ? ' friends-row-action--danger' : ''}" data-friend-action="${action}"
      title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
      <span class="material-symbols-outlined md-20" aria-hidden="true">${icon}</span>
    </button>`;
  }

  private renderAvatar(avatarUrl: string | undefined, presence?: FriendHomeEntry['presence']): string {
    return `<span class="friends-row-avatar-wrap">
      <img class="friends-row-avatar" src="${escapeHtml(getAvatarUrl(avatarUrl))}" alt="" data-fallback="avatar">
      ${presence ? `<span class="status-indicator ${presence === 'online' ? 'online' : 'offline'}" aria-hidden="true"></span>` : ''}
    </span>`;
  }

  private renderFriendRows(friends: FriendHomeEntry[]): string {
    return `
      <div class="friends-list" role="list">
        ${friends.map(friend => `
          <div class="friends-row friends-row--clickable" role="listitem" data-friend-id="${escapeHtml(friend.id)}" data-friend-message data-friend-menu>
            ${this.renderAvatar(friend.avatarUrl, friend.presence)}
            <div class="friends-row-main">
              <strong>${escapeHtml(friend.nickname)}</strong>
              <span>${friend.presence === 'online' ? t('main.statusOnline') : t('main.statusOffline')}</span>
            </div>
            <div class="friends-row-actions">
              ${this.actionButton('message', 'chat', t('dm.sendMessage'))}
              ${this.actionButton('menu', 'more_vert', t('home.moreActions'))}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  private renderPendingRows(pending: PendingFriendEntry[]): string {
    return `
      <div class="friends-list" role="list">
        ${pending.map(friend => `
          <div class="friends-row" role="listitem" data-friend-id="${escapeHtml(friend.id)}" data-friend-menu>
            ${this.renderAvatar(friend.avatarUrl)}
            <div class="friends-row-main">
              <strong>${escapeHtml(friend.nickname)}</strong>
              <span>${friend.direction === 'incoming' ? t('home.pendingIncoming') : t('home.pendingOutgoing')}</span>
            </div>
            <div class="friends-row-actions">
              ${friend.direction === 'incoming'
                ? `${this.actionButton('accept', 'check', t('home.acceptRequest'))}${this.actionButton('decline', 'close', t('home.declineRequest'), true)}`
                : this.actionButton('cancel', 'close', t('home.cancelRequest'), true)}
              ${this.actionButton('menu', 'more_vert', t('home.moreActions'))}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  private renderBlockedRows(blocked: BlockedFriendEntry[]): string {
    return `
      <div class="friends-list" role="list">
        ${blocked.map(friend => `
          <div class="friends-row" role="listitem" data-friend-id="${escapeHtml(friend.id)}">
            ${this.renderAvatar(friend.avatarUrl)}
            <div class="friends-row-main">
              <strong>${escapeHtml(friend.nickname)}</strong>
              <span>${t('home.blockedUser')}</span>
            </div>
            <div class="friends-row-actions">
              ${this.actionButton('unblock', 'lock_open', t('home.unblockUser'))}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  private renderEmpty(titleKey: string, descKey: string, icon: string): string {
    return `
      <div class="friends-empty-state" role="status">
        <span class="material-symbols-outlined" aria-hidden="true">${icon}</span>
        <h2>${t(titleKey as TranslationKey)}</h2>
        <p>${t(descKey as TranslationKey)}</p>
      </div>
    `;
  }

  private countOnline(snapshot: FriendsHomeSnapshot): number {
    return snapshot.friends.filter(friend => friend.presence === 'online').length;
  }
}
