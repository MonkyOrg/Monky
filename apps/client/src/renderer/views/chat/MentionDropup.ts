import { EVERYONE_MENTION_TOKENS, type UserSummary } from '@monky/shared';
import { t } from '../../i18n';
import { serverStore } from '../../stores/serverStore';
import { getAvatarUrl } from '../../utils/avatar';
import { html } from '../../utils/html';
import { setSurfaceVisible } from '../../utils/surfaceVisibility';
import type { MarkdownInput } from '../MarkdownInput';
import type { ChatContext } from './chatContext';

/** An entry in the @-mention dropup: a member or the channel-wide token (#464). */
export type MentionCandidate =
  | { kind: 'user'; user: UserSummary }
  | { kind: 'everyone'; token: string };

/**
 * The @-mention autocomplete of a channel composer (#14): it follows the
 * nickname being typed after an "@", offers the matching members (humans
 * only) and the channel-wide token, and inserts the full name on selection.
 */
export class MentionDropup {
  private active = false;
  private matches: MentionCandidate[] = [];
  private activeIndex = 0;
  /** Where the "@" of the mention being typed sits in the composer text. */
  private atIndex = -1;

  constructor(private readonly ctx: ChatContext) {}

  public get isOpen(): boolean {
    return this.active;
  }

  public update(input: MarkdownInput): void {
    const channelId = this.ctx.channelId;
    if (!channelId) {
      this.close();
      return;
    }
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.substring(0, caret);
    // A mention token is an "@" at start/after whitespace, followed by the
    // nickname typed so far (no spaces — nicknames may contain spaces but the
    // full name is inserted on selection, ending the token). Any other visible
    // character counts, since nicknames take accents and emoji (#567).
    const match = before.match(/(?:^|\s)@([^\s@]*)$/u);
    if (!match) {
      this.close();
      return;
    }
    const query = match[1].toLowerCase();
    this.atIndex = caret - match[1].length - 1;

    const all = serverStore.getMentionableUsers(channelId);
    const users = (query ? all.filter((u) => u.nickname.toLowerCase().includes(query)) : all)
      // Prioritize names that start with the query.
      .sort((a, b) => {
        const aStarts = a.nickname.toLowerCase().startsWith(query) ? 0 : 1;
        const bStarts = b.nickname.toLowerCase().startsWith(query) ? 0 : 1;
        return aStarts - bStarts;
      })
      .slice(0, 8);

    const matches: MentionCandidate[] = users.map((user) => ({ kind: 'user' as const, user }));

    // The channel-wide token leads the list when it matches what is being typed
    // and the server allows it (#464). Every spelling is accepted on the way in,
    // so suggesting only the one in the current language is enough.
    if (serverStore.serverDetails?.allowEveryoneMention !== false) {
      const suggested = EVERYONE_MENTION_TOKENS.find((token) => token.startsWith(query));
      const preferred = t('chat.everyoneMentionToken');
      const token = EVERYONE_MENTION_TOKENS.includes(preferred as typeof EVERYONE_MENTION_TOKENS[number])
        && preferred.startsWith(query)
        ? preferred
        : suggested;
      if (token) matches.unshift({ kind: 'everyone', token });
    }

    if (matches.length === 0) {
      this.close();
      return;
    }

    this.matches = matches;
    this.active = true;
    if (this.activeIndex >= matches.length || this.activeIndex < 0) {
      this.activeIndex = 0;
    }
    this.render();
  }

  /** While the dropup is open, arrows, Enter, Tab and Escape drive it (#14). Returns whether the key was taken. */
  public handleKey(event: KeyboardEvent): boolean {
    if (!this.active || this.matches.length === 0) return false;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex = (this.activeIndex + 1) % this.matches.length;
      this.render();
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex = (this.activeIndex - 1 + this.matches.length) % this.matches.length;
      this.render();
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      this.apply(this.activeIndex);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return true;
    }
    return false;
  }

  public render(): void {
    const el = this.ctx.container.querySelector<HTMLElement>('#mention-dropup');
    if (!el) return;
    el.innerHTML = this.matches
      .map((candidate, i) => {
        const active = i === this.activeIndex ? 'active' : '';
        if (candidate.kind === 'everyone') {
          return html`
            <div class="mention-item ${active}" data-mention-index="${i}">
              <span class="material-symbols-outlined md-18 mention-everyone-icon">campaign</span>
              <span class="mention-nick">@${candidate.token}</span>
              <span class="mention-everyone-hint">${t('chat.everyoneMentionHint')}</span>
            </div>
          `;
        }
        const u = candidate.user;
        const online = u.status !== 'DISCONNECTED';
        return html`
          <div class="mention-item ${active}" data-mention-index="${i}">
            <img class="mention-avatar" src="${getAvatarUrl(u.avatarUrl)}" data-fallback="avatar">
            <span class="mention-nick">${u.nickname}</span>
            <span class="mention-status-dot ${online ? 'online' : 'offline'}"></span>
          </div>
        `;
      })
      .join('');
    setSurfaceVisible(el, true, 'popover', 'block');

    el.querySelectorAll('.mention-item').forEach((item) => {
      item.addEventListener('mouseenter', () => {
        const idx = parseInt((item as HTMLElement).getAttribute('data-mention-index') || '0', 10);
        this.activeIndex = idx;
        el.querySelectorAll('.mention-item').forEach((el, i) => {
          el.classList.toggle('active', i === idx);
        });
      });
      // mousedown (not click) + preventDefault keeps focus in the textarea.
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = parseInt((item as HTMLElement).getAttribute('data-mention-index') || '0', 10);
        this.apply(idx);
      });
    });
  }

  public close(): void {
    this.active = false;
    this.matches = [];
    this.activeIndex = 0;
    this.atIndex = -1;
    const el = this.ctx.container.querySelector<HTMLElement>('#mention-dropup');
    if (el) {
      setSurfaceVisible(el, false, 'popover', undefined, () => el.replaceChildren());
    }
  }

  private apply(index: number): void {
    const input = this.ctx.container.querySelector<MarkdownInput>('#chat-message-input');
    const candidate = this.matches[index];
    if (!input || !candidate || this.atIndex < 0) {
      this.close();
      return;
    }
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.substring(0, this.atIndex);
    const after = input.value.substring(caret);
    const insert = candidate.kind === 'everyone' ? `@${candidate.token} ` : `@${candidate.user.nickname} `;
    input.value = `${before}${insert}${after}`;
    const newCaret = before.length + insert.length;
    input.setSelectionRange(newCaret, newCaret);
    this.close();
    input.focus();
    this.ctx.composer.textInserted(input);
  }
}
