import { t } from '../../i18n';
import { getAvatarUrl } from '../../utils/avatar';
import { escapeHtml } from '../../utils/html';

export interface DirectMessagePreview {
  id: string;
  title: string;
  avatarUrl?: string;
  unreadCount?: number;
  online?: boolean;
  preview?: string;
}

export class HomeSidebar {
  private conversations: DirectMessagePreview[] = [];
  private selectedId: string | null = null;
  private pendingCount = 0;

  public setConversations(conversations: DirectMessagePreview[]): void {
    this.conversations = [...conversations];
  }

  /** `null` selects the Friends entry. */
  public setSelected(id: string | null): void {
    this.selectedId = id;
  }

  public setPendingCount(count: number): void {
    this.pendingCount = count;
  }

  public render(): string {
    const friendsSelected = this.selectedId === null;
    return `
      <nav class="home-sidebar" aria-label="${escapeHtml(t('home.sidebarLabel'))}">
        <button type="button" id="home-nav-friends" class="home-nav-entry${friendsSelected ? ' selected' : ''}" ${friendsSelected ? 'aria-current="page"' : ''}>
          <span class="material-symbols-outlined md-20" aria-hidden="true">group</span>
          <span>${t('home.friendsTitle')}</span>
          ${this.pendingCount > 0 ? `<span class="home-dm-unread" aria-label="${escapeHtml(t('home.pendingIncomingCount', { count: this.pendingCount }))}">${this.pendingCount}</span>` : ''}
        </button>
        <section class="home-dm-section" aria-labelledby="home-dm-heading">
          <div class="home-section-heading" id="home-dm-heading">${t('home.directMessages')}</div>
          <div id="home-dm-list" class="home-dm-list" role="list">
            ${this.conversations.length ? this.conversations.map((conversation) => this.renderItem(conversation)).join('') : `
              <div class="home-dm-empty" role="status">
                <span class="material-symbols-outlined md-20" aria-hidden="true">chat_bubble</span>
                <span>${t('home.dmEmpty')}</span>
              </div>
            `}
          </div>
        </section>
      </nav>
    `;
  }

  private renderItem(conversation: DirectMessagePreview): string {
    const selected = conversation.id === this.selectedId;
    const unread = conversation.unreadCount ?? 0;
    return `
      <div class="home-dm-item${selected ? ' selected' : ''}${unread > 0 ? ' home-dm-item--unread' : ''}" role="listitem" data-dm-id="${escapeHtml(conversation.id)}">
        <button type="button" class="home-dm-open" data-dm-open ${selected ? 'aria-current="page"' : ''}>
          <span class="home-dm-avatar" aria-hidden="true">
            <img src="${escapeHtml(getAvatarUrl(conversation.avatarUrl))}" alt="" data-fallback="avatar">
            <span class="status-indicator ${conversation.online ? 'online' : 'offline'}"></span>
          </span>
          <span class="home-dm-text">
            <span class="home-dm-title">${escapeHtml(conversation.title)}</span>
            ${conversation.preview ? `<span class="home-dm-preview">${escapeHtml(conversation.preview)}</span>` : ''}
          </span>
          ${unread > 0 ? `<span class="home-dm-unread">${unread > 99 ? '99+' : unread}</span>` : ''}
        </button>
        <button type="button" class="home-dm-hide" data-dm-hide title="${escapeHtml(t('home.closeConversation'))}" aria-label="${escapeHtml(t('home.closeConversation'))}">
          <span class="material-symbols-outlined md-16" aria-hidden="true">close</span>
        </button>
      </div>
    `;
  }
}
