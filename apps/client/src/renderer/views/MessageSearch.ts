import { getMessageText, MESSAGE_SEARCH_PAGE_SIZE, type AttachmentMeta, type ChannelSummary, type ChatMessage, type MessageSearchPayload,
  type MessageSearchResultPayload, type UserSummary } from '@monky/shared';
import { getLanguage, t } from '../i18n';
import { messageSearchEn, messageSearchPtBR } from '../i18n/messageSearch';
import '../styles/community.css';
import './MessageSearch.css';
import { openCommunityModal } from './CommunityModal';
import { cancelSurfaceMotion, hideWithMotion, showWithMotion } from '../utils/surfaceMotion';
import { getAvatarUrl } from '../utils/avatar';
import { dateFieldValue, formatCalendarValue, setDateFieldValue, todayCalendarValue } from '../utils/calendarDate';
import { renderMarkdown } from '../utils/markdown';
import { fileIconName, formatBytes, getAttachmentUrl } from '../utils/attachment';
import { downloadLightboxFile, lightboxModal, type LightboxMedia } from './LightboxModal';
import { initializeCustomMediaPlayers } from '../utils/videoPlayer';

export interface MessageSearchOptions {
  channels(): readonly ChannelSummary[];
  users(): readonly UserSummary[];
  currentChannelId(): string | null;
  canRead(): boolean;
  isCurrent(): boolean;
  search(payload: MessageSearchPayload, signal: AbortSignal): Promise<MessageSearchResultPayload>;
  navigate(channelId: string, messageId: string): void;
  setExpanded(expanded: boolean): void;
  /** Subscribe to permissions/channel changes, message edits/deletions, disconnect and session changes. */
  watch(invalidate: () => void): () => void;
}

type Key = keyof typeof messageSearchPtBR;
type Selection = 'authorIds' | 'channelIds' | 'mentionsUserIds';
type ContentKind = 'image' | 'video' | 'audio' | 'file' | 'link';
type QuickSelection = Selection | 'contains' | 'authorType';
type ComboChoice<T extends string> = { id: T; name: string; icon?: string; avatarUrl?: string | null };
const text = (key: Key) => (getLanguage() === 'en' ? messageSearchEn : messageSearchPtBR)[key];
const isMessageChannel = (channel: Pick<ChannelSummary, 'type'>) =>
  channel.type === 'TEXT' || channel.type === 'VOICE';
const channelIcon = (channel: Pick<ChannelSummary, 'type'>) =>
  channel.type === 'VOICE' ? 'volume_up' : 'tag';
const channelLabel = (channel: Pick<ChannelSummary, 'name' | 'type'>) =>
  channel.type === 'VOICE' ? channel.name : `# ${channel.name}`;

/** Bound to one server session; no search content is kept in global stores or browser storage. */
export class MessageSearch {
  private readonly bar = document.createElement('div');
  private readonly chips = document.createElement('div');
  private readonly launch = document.createElement('input');
  private readonly closeButton = document.createElement('button');
  private readonly panel = document.createElement('aside');
  private readonly suggestions = document.createElement('aside');
  private readonly lifetime = new AbortController();
  private readonly unwatch: () => void;
  private request: AbortController | null = null;
  private generation = 0;
  private cursors: Array<string | undefined> = [undefined];
  private page = 0;
  private nextCursor: string | undefined;
  private messages: ChatMessage[] = [];
  private total = 0;
  private filters: MessageSearchPayload = {};
  private readonly selected: Record<Selection, Set<string>> = {
    authorIds: new Set(), channelIds: new Set(), mentionsUserIds: new Set(),
  };
  private readonly contains = new Set<ContentKind>();
  private advanced: ReturnType<typeof openCommunityModal> | null = null;
  private advancedApplied = false;
  private dates = { kind: '', start: '', end: '' };
  private quickSelection: QuickSelection | null = null;
  private quickQuery = '';

  constructor(header: HTMLElement, host: HTMLElement, private readonly options: MessageSearchOptions) {
    this.bar.className = 'message-search-bar';
    this.chips.className = 'message-search-bar-chips';
    this.launch.type = 'search';
    this.launch.name = 'query';
    this.launch.maxLength = 200;
    this.launch.className = 'message-search-launch';
    this.launch.placeholder = text('messageSearch.placeholder');
    this.launch.setAttribute('aria-label', text('messageSearch.title'));
    this.launch.setAttribute('aria-expanded', 'false');
    this.bar.hidden = !options.canRead();
    this.closeButton.type = 'button';
    this.closeButton.className = 'message-search-close';
    this.closeButton.setAttribute('aria-label', text('messageSearch.close'));
    this.closeButton.innerHTML = '<span class="material-symbols-outlined md-18" aria-hidden="true">close</span>';
    this.closeButton.hidden = true;
    this.closeButton.addEventListener('click', () => this.close(), { signal: this.lifetime.signal });
    this.bar.append(this.chips, this.launch, this.closeButton);
    header.append(this.bar);
    this.panel.className = 'message-search-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', text('messageSearch.title'));
    this.suggestions.className = 'message-search-panel is-suggestions';
    this.suggestions.hidden = true;
    this.suggestions.setAttribute('aria-label', text('messageSearch.filters'));
    host.append(this.panel, this.suggestions);
    this.launch.addEventListener('click', () => {
      if (!this.isOpen()) this.open();
      else if (!this.advanced && !this.suggestionsOpen()) {
        this.renderSuggestions();
        showWithMotion(this.suggestions);
        this.renderLaunchState();
      }
    }, { signal: this.lifetime.signal });
    this.launch.addEventListener('input', () => {
      if (!this.options.isCurrent() || !this.options.canRead()) return;
      this.recognizeQuickPrefix();
      if (!this.suggestionsOpen()) showWithMotion(this.suggestions);
      this.launch.setAttribute('aria-expanded', 'true');
      this.renderLaunchState();
      this.renderSuggestions(this.quickSelection);
    }, { signal: this.lifetime.signal });
    this.launch.addEventListener('keydown', event => {
      if (event.key === 'Backspace' && !this.launch.value && this.quickSelection) {
        event.preventDefault();
        this.cancelQuickSelection();
      } else if (event.key === 'Backspace' && !this.launch.value && this.chips.lastElementChild) {
        event.preventDefault();
        (this.chips.lastElementChild as HTMLButtonElement).click();
      } else if (event.key === 'Escape' && this.quickSelection) {
        event.preventDefault();
        event.stopPropagation();
        this.cancelQuickSelection();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (this.quickSelection) this.suggestions.querySelector<HTMLButtonElement>('[data-quick-value]')?.click();
        else this.searchQuick();
      } else if (event.key === 'ArrowDown' && this.isOpen()) {
        event.preventDefault();
        this.suggestions.querySelector<HTMLButtonElement>('button')?.focus();
      }
    }, { signal: this.lifetime.signal });
    document.addEventListener('pointerdown', event => {
      if (!this.advanced && this.suggestionsOpen() && event.target instanceof Node
        && !this.bar.contains(event.target) && !this.suggestions.contains(event.target)) {
        if (this.resultsOpen()) this.closeSuggestions();
        else this.close(false);
      }
    }, { signal: this.lifetime.signal });
    document.addEventListener('keydown', event => {
      if (!options.isCurrent()) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
        const id = options.currentChannelId();
        if (!id || !options.canRead() || !options.channels().some(channel => channel.id === id && isMessageChannel(channel))) return;
        event.preventDefault();
        this.open(id);
      } else if (event.key === 'Escape' && this.isOpen() && !this.advanced) {
        event.preventDefault();
        if (this.suggestionsOpen() && this.resultsOpen()) this.closeSuggestions(true);
        else this.close();
      }
    }, { signal: this.lifetime.signal });
    this.unwatch = options.watch(() => this.invalidate());
    this.renderLaunchState();
  }

  public open(channelId?: string): void {
    if (!this.options.isCurrent() || !this.options.canRead()) return;
    this.options.setExpanded(true);
    this.advanced?.close();
    this.filters = {};
    this.dates = { kind: '', start: '', end: '' };
    this.quickSelection = null;
    this.quickQuery = '';
    this.launch.value = '';
    this.clearResults();
    for (const values of Object.values(this.selected)) values.clear();
    this.contains.clear();
    if (channelId && this.options.channels().some(channel => channel.id === channelId && isMessageChannel(channel))) {
      this.selected.channelIds.add(channelId);
    }
    cancelSurfaceMotion(this.panel);
    this.panel.hidden = true;
    this.panel.replaceChildren();
    if (!this.suggestionsOpen()) showWithMotion(this.suggestions);
    this.launch.setAttribute('aria-expanded', 'true');
    this.renderLaunchState();
    this.renderSuggestions();
    this.launch.focus();
  }

  public close(restoreFocus = true): void {
    this.options.setExpanded(false);
    this.advanced?.close();
    this.clearResults(false);
    hideWithMotion(this.panel, 'panel', () => this.panel.replaceChildren());
    hideWithMotion(this.suggestions, 'panel', () => this.suggestions.replaceChildren());
    this.launch.setAttribute('aria-expanded', 'false');
    for (const values of Object.values(this.selected)) values.clear();
    this.contains.clear();
    this.filters = {};
    this.dates = { kind: '', start: '', end: '' };
    this.quickSelection = null;
    this.quickQuery = '';
    this.launch.value = '';
    this.renderLaunchState();
    if (restoreFocus && this.options.isCurrent() && !this.bar.hidden) this.launch.focus();
  }

  public invalidate(): void {
    const visible = this.isOpen();
    this.advanced?.close(true);
    this.close(false);
    cancelSurfaceMotion(this.panel);
    cancelSurfaceMotion(this.suggestions);
    this.panel.hidden = true;
    this.suggestions.hidden = true;
    this.panel.replaceChildren();
    this.suggestions.replaceChildren();
    this.bar.hidden = !this.options.isCurrent() || !this.options.canRead();
    if (visible && !this.bar.hidden) {
      this.open();
      this.status(text('messageSearch.revoked'));
    }
  }

  public destroy(): void {
    this.advanced?.close(true);
    this.close(false);
    this.lifetime.abort();
    this.unwatch();
    this.bar.remove();
    cancelSurfaceMotion(this.panel);
    cancelSurfaceMotion(this.suggestions);
    this.panel.remove();
    this.suggestions.remove();
  }

  private isOpen(): boolean {
    return this.resultsOpen() || this.suggestionsOpen();
  }

  private resultsOpen(): boolean {
    return !this.panel.hidden && !this.panel.hasAttribute('data-ui-closing');
  }

  private suggestionsOpen(): boolean {
    return !this.suggestions.hidden && !this.suggestions.hasAttribute('data-ui-closing');
  }

  private closeSuggestions(restoreFocus = false): void {
    hideWithMotion(this.suggestions, 'panel', () => this.suggestions.replaceChildren());
    if (this.quickSelection) this.launch.value = this.quickQuery;
    this.quickSelection = null;
    this.quickQuery = '';
    this.launch.setAttribute('aria-expanded', String(this.resultsOpen()));
    this.renderLaunchState();
    if (restoreFocus) this.launch.focus();
  }

  private clearResults(clearContent = true): void {
    this.generation++;
    this.request?.abort();
    this.request = null;
    this.messages = [];
    this.total = 0;
    this.cursors = [undefined];
    this.page = 0;
    this.nextCursor = undefined;
    this.panel.removeAttribute('aria-busy');
    if (clearContent) {
      this.panel.querySelector('.message-search-results')?.replaceChildren();
      this.panel.querySelector('.message-search-pagination')?.replaceChildren();
    }
  }

  private button(label: Key, action: () => void, className = 'btn btn-secondary'): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text(label);
    button.addEventListener('click', action);
    return button;
  }

  private field(label: Key, input: HTMLElement): HTMLLabelElement {
    const element = document.createElement('label');
    element.append(document.createTextNode(text(label)), input);
    return element;
  }

  private filterField(label: Key, hint: Key, control: HTMLElement): HTMLElement {
    const field = document.createElement('div');
    field.className = 'message-search-filter-field';
    const title = document.createElement('strong');
    title.textContent = text(label);
    const help = document.createElement('small');
    help.textContent = text(hint);
    control.setAttribute('aria-label', text(label));
    field.append(title, help, control);
    return field;
  }

  private select(name: string, values: Array<{ value: string; label: Key }>): HTMLSelectElement {
    const select = document.createElement('select');
    select.name = name;
    for (const value of values) select.add(new Option(text(value.label), value.value));
    return select;
  }

  private renderLaunchState(): void {
    this.chips.replaceChildren();
    for (const selection of ['authorIds', 'channelIds', 'mentionsUserIds'] as const) {
      const choices = selection === 'channelIds'
        ? this.options.channels().filter(isMessageChannel).map(channel => ({ id: channel.id, name: channelLabel(channel) }))
        : this.options.users().filter(user => selection !== 'mentionsUserIds' || !user.isBot)
          .map(user => ({ id: user.id, name: user.nickname }));
      for (const choice of choices.filter(choice => this.selected[selection].has(choice.id))) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'message-search-bar-chip';
        chip.dataset.selection = selection;
        chip.dataset.value = choice.id;
        chip.setAttribute('aria-label', `${text('messageSearch.removeFilter')}: ${choice.name}`);
        const prefix = text(selection === 'channelIds' ? 'messageSearch.inPrefix'
          : selection === 'authorIds' ? 'messageSearch.fromPrefix' : 'messageSearch.mentionsPrefix').trim();
        const label = document.createElement('span');
        label.className = 'message-search-bar-chip-label';
        label.textContent = `${prefix} ${choice.name}`;
        chip.append(label);
        const close = document.createElement('span');
        close.className = 'material-symbols-outlined md-14';
        close.setAttribute('aria-hidden', 'true');
        close.textContent = 'close';
        chip.append(close);
        chip.addEventListener('click', () => {
          this.selected[selection].delete(choice.id);
          this.renderLaunchState();
          if (this.resultsOpen() || !this.suggestionsOpen()) this.searchQuick();
          else this.renderSuggestions();
        });
        this.chips.append(chip);
      }
    }
    for (const kind of this.contains) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'message-search-bar-chip';
      chip.dataset.selection = 'contains';
      chip.dataset.value = kind;
      const label = document.createElement('span');
      label.className = 'message-search-bar-chip-label';
      label.textContent = `${text('messageSearch.contains')}: ${text(`messageSearch.${kind}`)}`;
      const close = document.createElement('span');
      close.className = 'material-symbols-outlined md-14';
      close.setAttribute('aria-hidden', 'true');
      close.textContent = 'close';
      chip.append(label, close);
      chip.addEventListener('click', () => {
        this.contains.delete(kind);
        this.renderLaunchState();
        this.searchQuick();
      });
      this.chips.append(chip);
    }
    if (this.filters.authorType === 'human' || this.filters.authorType === 'bot') {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'message-search-bar-chip';
      chip.dataset.selection = 'authorType';
      chip.dataset.value = this.filters.authorType;
      const label = document.createElement('span');
      label.className = 'message-search-bar-chip-label';
      label.textContent = `${text('messageSearch.authorType')}: ${text(
        this.filters.authorType === 'human' ? 'messageSearch.human' : 'messageSearch.bot')}`;
      const close = document.createElement('span');
      close.className = 'material-symbols-outlined md-14';
      close.setAttribute('aria-hidden', 'true');
      close.textContent = 'close';
      chip.append(label, close);
      chip.addEventListener('click', () => {
        const { authorType: _authorType, ...filters } = this.filters;
        this.filters = filters;
        this.renderLaunchState();
        this.searchQuick();
      });
      this.chips.append(chip);
    }
    if (this.quickSelection) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'message-search-bar-chip is-active';
      chip.dataset.activeFilter = this.quickSelection;
      chip.setAttribute('aria-label', `${text('messageSearch.removeFilter')}: ${this.quickPrefix(this.quickSelection)}`);
      const label = document.createElement('span');
      label.className = 'message-search-bar-chip-label';
      label.textContent = this.quickPrefix(this.quickSelection);
      const close = document.createElement('span');
      close.className = 'material-symbols-outlined md-14';
      close.setAttribute('aria-hidden', 'true');
      close.textContent = 'close';
      chip.append(label, close);
      chip.addEventListener('click', () => this.cancelQuickSelection());
      this.chips.append(chip);
    }
    this.bar.classList.toggle('has-filters', !!this.chips.childElementCount);
    this.closeButton.hidden = !this.isOpen();
  }

  private cancelQuickSelection(): void {
    if (!this.quickSelection) return;
    this.quickSelection = null;
    this.launch.value = this.quickQuery;
    this.quickQuery = '';
    this.renderLaunchState();
    if (this.suggestionsOpen()) this.renderSuggestions();
    this.launch.focus();
  }

  private quickPrefix(selection: QuickSelection): string {
    if (selection === 'contains') return `${text('messageSearch.contains')}:`;
    if (selection === 'authorType') return `${text('messageSearch.authorType')}:`;
    return text(selection === 'channelIds' ? 'messageSearch.inPrefix'
      : selection === 'mentionsUserIds' ? 'messageSearch.mentionsPrefix' : 'messageSearch.fromPrefix');
  }

  private quickHeading(selection: QuickSelection): Key {
    if (selection === 'channelIds') return 'messageSearch.quickInTitle';
    if (selection === 'contains') return 'messageSearch.quickContainsTitle';
    if (selection === 'mentionsUserIds') return 'messageSearch.quickMentionsTitle';
    if (selection === 'authorType') return 'messageSearch.quickAuthorTypeTitle';
    return 'messageSearch.quickFromTitle';
  }

  private recognizeQuickPrefix(): void {
    if (this.quickSelection) return;
    const value = this.launch.value;
    const lower = value.toLocaleLowerCase();
    let match: { selection: Selection; prefix: string; index: number } | null = null;
    for (const selection of ['authorIds', 'channelIds', 'mentionsUserIds'] as const) {
      const prefix = this.quickPrefix(selection);
      const prefixLower = prefix.toLocaleLowerCase();
      let index = lower.lastIndexOf(prefixLower);
      while (index >= 0 && index > 0 && !/\s/.test(value[index - 1])) {
        index = lower.lastIndexOf(prefixLower, index - 1);
      }
      if (index >= 0 && (!match || index > match.index)) match = { selection, prefix, index };
    }
    if (!match) return;
    this.quickQuery = value.slice(0, match.index).trim();
    this.quickSelection = match.selection;
    const optionQuery = value.slice(match.index + match.prefix.length).trimStart();
    this.launch.value = optionQuery;
  }

  private renderSuggestions(selection: QuickSelection | null = null): void {
    this.suggestions.replaceChildren();
    const contextualQuery = selection ? '' : this.launch.value.trim();
    if (contextualQuery) {
      this.renderContextualSuggestions(contextualQuery);
      return;
    }
    const heading = document.createElement('h2');
    heading.textContent = text(selection ? this.quickHeading(selection) : 'messageSearch.filters');
    this.suggestions.append(heading);
    const choices: Array<{ id: string; name: string; avatarUrl?: string | null; icon?: string }> =
      selection === 'contains'
        ? (['image', 'video', 'audio', 'file', 'link'] as ContentKind[])
          .map(id => ({ id, name: text(`messageSearch.${id}`), icon: id === 'file' ? 'draft'
            : id === 'link' ? 'link' : id === 'audio' ? 'audio_file' : id === 'video' ? 'videocam' : 'image' }))
        : selection === 'authorType'
          ? [{ id: '', name: text('messageSearch.any'), icon: 'group' },
            { id: 'human', name: text('messageSearch.human'), icon: 'person' },
            { id: 'bot', name: text('messageSearch.bot'), icon: 'smart_toy' }]
          : selection === 'channelIds'
            ? this.options.channels().filter(isMessageChannel)
              .map(channel => ({ id: channel.id, name: channel.name, avatarUrl: null, icon: channelIcon(channel) }))
            : this.options.users().filter(user => selection !== 'mentionsUserIds' || !user.isBot)
              .map(user => ({ id: user.id, name: user.nickname, avatarUrl: user.avatarUrl }));
    if (selection) {
      const query = this.launch.value.trim().toLocaleLowerCase();
      for (const choice of choices.filter(choice => choice.name.toLocaleLowerCase().includes(query)).slice(0, 100)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'message-search-suggestion';
        button.dataset.quickValue = choice.id;
        const icon = choice.avatarUrl ? document.createElement('img') : document.createElement('span');
        icon.className = choice.icon ? 'material-symbols-outlined md-20'
          : choice.avatarUrl ? 'message-search-avatar' : 'message-search-initial';
        if (icon instanceof HTMLImageElement) {
          icon.src = getAvatarUrl(choice.avatarUrl);
          icon.alt = '';
          icon.dataset.fallback = 'avatar';
        } else icon.textContent = choice.icon ?? choice.name.slice(0, 1);
        button.append(icon, document.createTextNode(choice.name));
        const selected = selection === 'contains' ? this.contains.has(choice.id as ContentKind)
          : selection === 'authorType' ? (this.filters.authorType ?? '') === choice.id
            : this.selected[selection].has(choice.id);
        button.setAttribute('aria-pressed', String(selected));
        button.addEventListener('click', () => {
          if (selection === 'contains') {
            const kind = choice.id as ContentKind;
            if (this.contains.has(kind)) this.contains.delete(kind); else this.contains.add(kind);
          } else if (selection === 'authorType') {
            const { authorType: _authorType, ...filters } = this.filters;
            this.filters = choice.id === 'human' || choice.id === 'bot'
              ? { ...filters, authorType: choice.id } : filters;
          } else {
            const selected = this.selected[selection];
            if (selected.has(choice.id)) selected.delete(choice.id); else if (selected.size < 50) selected.add(choice.id);
          }
          this.launch.value = this.quickQuery;
          this.quickSelection = null;
          this.quickQuery = '';
          this.renderLaunchState();
          this.searchQuick();
          this.launch.focus();
        });
        this.suggestions.append(button);
      }
    } else {
      for (const [key, label, icon] of [
        ['authorIds', 'messageSearch.from', 'person'], ['channelIds', 'messageSearch.in', 'tag'],
        ['contains', 'messageSearch.contains', 'attachment'], ['mentionsUserIds', 'messageSearch.mentions', 'alternate_email'],
        ['authorType', 'messageSearch.authorType', 'smart_toy'],
      ] as const) {
        const button = this.button(label, () => {
          this.quickQuery = this.launch.value;
          this.quickSelection = key;
          this.launch.value = '';
          this.renderLaunchState();
          this.renderSuggestions(key);
          this.launch.focus();
        }, 'message-search-suggestion');
        button.dataset.quickFilter = key;
        const symbol = document.createElement('span');
        symbol.className = 'material-symbols-outlined md-20';
        symbol.textContent = icon;
        button.prepend(symbol);
        const count = key === 'contains' ? this.contains.size : key === 'authorType' ? Number(!!this.filters.authorType)
          : this.selected[key].size;
        if (count) button.append(document.createTextNode(` (${count})`));
        this.suggestions.append(button);
      }
    }
    const advanced = this.button('messageSearch.advanced', () => this.openAdvanced(),
      'message-search-suggestion message-search-advanced-link');
    advanced.dataset.searchAdvanced = '';
    const advancedIcon = document.createElement('span');
    advancedIcon.className = 'material-symbols-outlined md-20';
    advancedIcon.setAttribute('aria-hidden', 'true');
    advancedIcon.textContent = 'manage_search';
    advanced.prepend(advancedIcon);
    this.suggestions.append(advanced);
    const status = document.createElement('p');
    status.className = 'message-search-status';
    status.setAttribute('role', 'status');
    this.suggestions.append(status);
  }

  private renderContextualSuggestions(query: string): void {
    const search = document.createElement('button');
    search.type = 'button';
    search.className = 'message-search-suggestion message-search-query-action';
    search.dataset.searchQuery = '';
    const searchIcon = document.createElement('span');
    searchIcon.className = 'material-symbols-outlined md-20';
    searchIcon.setAttribute('aria-hidden', 'true');
    searchIcon.textContent = 'search';
    const searchLabel = document.createElement('span');
    searchLabel.textContent = text('messageSearch.searchFor').replace('{query}', query);
    search.append(searchIcon, searchLabel);
    search.addEventListener('click', () => this.searchQuick());

    const advanced = this.button('messageSearch.addFilters', () => this.openAdvanced(), 'message-search-suggestion');
    advanced.dataset.searchAdvanced = '';
    const tune = document.createElement('span');
    tune.className = 'material-symbols-outlined md-20';
    tune.setAttribute('aria-hidden', 'true');
    tune.textContent = 'tune';
    advanced.prepend(tune);
    this.suggestions.append(search, advanced);

    const users = this.options.users();
    this.appendContextualGroup('messageSearch.from', 'authorIds',
      users.filter(user => !this.selected.authorIds.has(user.id))
        .map(user => ({ id: user.id, name: user.nickname, avatarUrl: user.avatarUrl })), query);
    this.appendContextualGroup('messageSearch.in', 'channelIds',
      this.options.channels().filter(channel => isMessageChannel(channel) && !this.selected.channelIds.has(channel.id))
        .map(channel => ({ id: channel.id, name: channel.name, icon: channelIcon(channel) })), query);
    this.appendContextualGroup('messageSearch.mentions', 'mentionsUserIds',
      users.filter(user => !user.isBot && !this.selected.mentionsUserIds.has(user.id))
        .map(user => ({ id: user.id, name: user.nickname, avatarUrl: user.avatarUrl, icon: 'alternate_email' })), query);
    const status = document.createElement('p');
    status.className = 'message-search-status';
    status.setAttribute('role', 'status');
    this.suggestions.append(status);
  }

  private appendContextualGroup(
    label: Key,
    selection: Selection,
    choices: Array<{ id: string; name: string; avatarUrl?: string | null; icon?: string }>,
    query: string,
  ): void {
    const matches = choices.filter(choice => this.matchesOption(choice.name, query)).slice(0, 5);
    if (!matches.length) return;
    const heading = document.createElement('h2');
    heading.className = 'message-search-suggestion-group';
    heading.textContent = text(label);
    this.suggestions.append(heading);
    for (const choice of matches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-search-suggestion message-search-context-option';
      button.dataset.contextSelection = selection;
      button.dataset.value = choice.id;
      const icon = choice.avatarUrl ? document.createElement('img') : document.createElement('span');
      icon.className = choice.avatarUrl ? 'message-search-avatar' : 'material-symbols-outlined md-20';
      if (icon instanceof HTMLImageElement) {
        icon.src = getAvatarUrl(choice.avatarUrl);
        icon.alt = '';
        icon.dataset.fallback = 'avatar';
      } else {
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = choice.icon ?? 'person';
      }
      const copy = document.createElement('span');
      copy.className = 'message-search-suggestion-copy';
      const name = document.createElement('strong');
      name.textContent = choice.name;
      const hint = document.createElement('small');
      hint.textContent = `${this.quickPrefix(selection)} ${choice.name}`;
      copy.append(name, hint);
      button.append(icon, copy);
      button.addEventListener('click', () => {
        if (this.selected[selection].size >= 50) return;
        this.selected[selection].add(choice.id);
        this.launch.value = '';
        this.renderLaunchState();
        this.searchQuick();
        this.launch.focus();
      });
      this.suggestions.append(button);
    }
  }

  private matchesOption(value: string, query: string): boolean {
    const normalize = (input: string) => input.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
    return normalize(value).includes(normalize(query));
  }

  private searchQuick(): void {
    if (this.quickSelection) return;
    this.clearResults();
    this.filters = { ...this.filters, query: this.launch.value, authorIds: [...this.selected.authorIds],
      channelIds: [...this.selected.channelIds], mentionsUserIds: [...this.selected.mentionsUserIds],
      contains: [...this.contains], sort: this.filters.sort ?? 'newest' };
    this.closeSuggestions();
    this.showResults();
    void this.loadPage(0);
  }

  private openAdvanced(dateMode?: 'on' | 'range'): void {
    if (this.advanced) return;
    if (this.quickSelection) { this.launch.value = this.quickQuery; this.quickSelection = null; }
    const reopenSuggestions = this.suggestionsOpen() && !this.resultsOpen();
    this.closeSuggestions();
    const selected = { authorIds: new Set(this.selected.authorIds), channelIds: new Set(this.selected.channelIds), mentionsUserIds: new Set(this.selected.mentionsUserIds) };
    const contains = new Set(this.contains), filters = this.filters, dates = { ...this.dates }, query = this.launch.value;
    if (dateMode) this.dates = { kind: dateMode, start: '', end: '' };
    const modal = openCommunityModal(text('messageSearch.filters'));
    modal.element.querySelector('.community-modal')?.classList.add('message-search-modal');
    this.advanced = modal;
    this.advancedApplied = false;
    modal.signal.addEventListener('abort', () => {
      this.advanced = null;
      if (!this.advancedApplied) {
        Object.assign(this.selected, selected);
        this.contains.clear();
        for (const kind of contains) this.contains.add(kind);
        this.filters = filters;
        this.dates = dates;
        this.launch.value = query;
        if (reopenSuggestions) {
          this.renderSuggestions();
          showWithMotion(this.suggestions);
          this.renderLaunchState();
        }
      }
    }, { once: true });
    this.renderForm();
    if (dateMode) queueMicrotask(() => modal.content.querySelector<HTMLInputElement>('[name=start]')?.click());
  }

  private showResults(): void {
    if (!this.resultsOpen()) showWithMotion(this.panel);
    this.launch.setAttribute('aria-expanded', 'true');
    this.panel.replaceChildren();
    const heading = document.createElement('header');
    const title = document.createElement('h2');
    title.className = 'message-search-result-count';
    title.textContent = text('messageSearch.loading');
    const advanced = this.button('messageSearch.filters', () => this.openAdvanced());
    advanced.classList.add('message-search-toolbar-button');
    const advancedLabel = document.createElement('span');
    advancedLabel.textContent = `${text('messageSearch.filters')} (${this.filterCount()})`;
    advanced.replaceChildren(this.paginationIcon('tune'), advancedLabel);
    advanced.dataset.searchAdvanced = '';
    const sortWrap = document.createElement('div');
    sortWrap.className = 'message-search-sort-wrap';
    const sort = document.createElement('button');
    sort.type = 'button';
    sort.className = 'btn btn-secondary message-search-toolbar-button message-search-sort';
    sort.setAttribute('aria-label', text('messageSearch.sort'));
    sort.setAttribute('aria-haspopup', 'menu');
    sort.setAttribute('aria-expanded', 'false');
    const sortLabel = document.createElement('span');
    sortLabel.textContent = text('messageSearch.order');
    sort.append(this.paginationIcon('swap_vert'), sortLabel, this.paginationIcon('expand_more'));
    const sortMenu = document.createElement('div');
    sortMenu.className = 'message-search-sort-menu';
    sortMenu.setAttribute('role', 'menu');
    sortMenu.setAttribute('aria-label', text('messageSearch.sort'));
    sortMenu.hidden = true;
    let outside: AbortController | null = null;
    const setSortOpen = (open: boolean) => {
      outside?.abort();
      outside = null;
      sort.setAttribute('aria-expanded', String(open));
      if (!open) {
        hideWithMotion(sortMenu, 'popover');
        return;
      }
      showWithMotion(sortMenu, 'popover');
      outside = new AbortController();
      queueMicrotask(() => {
        const signal = outside?.signal;
        if (!signal) return;
        document.addEventListener('pointerdown', event => {
          if (event.target instanceof Node && !sortWrap.contains(event.target)) setSortOpen(false);
        }, { signal });
        document.addEventListener('keydown', event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setSortOpen(false);
            sort.focus();
          }
        }, { signal, capture: true });
      });
    };
    const sortOptions: Array<{ value: 'newest' | 'oldest'; label: Key }> = [
      { value: 'newest', label: 'messageSearch.newest' },
      { value: 'oldest', label: 'messageSearch.oldest' },
    ];
    for (const option of sortOptions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-search-sort-option';
      button.dataset.value = option.value;
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String((this.filters.sort ?? 'newest') === option.value));
      const label = document.createElement('span');
      label.textContent = text(option.label);
      const check = this.paginationIcon('check');
      check.classList.add('message-search-sort-check');
      button.append(label, check);
      button.addEventListener('click', () => {
        for (const item of sortMenu.querySelectorAll<HTMLElement>('[role=menuitemradio]')) {
          item.setAttribute('aria-checked', String(item === button));
        }
        setSortOpen(false);
        if ((this.filters.sort ?? 'newest') === option.value) return;
        this.filters = { ...this.filters, sort: option.value };
        this.clearResults();
        void this.loadPage(0);
      });
      button.addEventListener('keydown', event => {
        if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...sortMenu.querySelectorAll<HTMLButtonElement>('button')];
        const index = buttons.indexOf(button);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      });
      sortMenu.append(button);
    }
    sort.addEventListener('click', () => {
      const opening = sortMenu.hidden || sortMenu.hasAttribute('data-ui-closing');
      setSortOpen(opening);
      if (opening) sortMenu.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus();
    });
    sortWrap.append(sort, sortMenu);
    const actions = document.createElement('div');
    actions.className = 'message-search-header-actions';
    actions.append(advanced, sortWrap);
    heading.append(title, actions);
    const status = document.createElement('p');
    status.className = 'message-search-status';
    status.setAttribute('role', 'status');
    const results = document.createElement('div');
    results.className = 'message-search-results';
    const pagination = document.createElement('nav');
    pagination.className = 'message-search-pagination message-search-actions';
    this.panel.append(heading, status, results, pagination);
    this.renderLaunchState();
  }

  private filterCount(): number {
    return Number(this.selected.authorIds.size > 0) + Number(this.selected.channelIds.size > 0)
      + Number(this.selected.mentionsUserIds.size > 0) + Number(this.contains.size > 0)
      + Number(!!this.filters.authorType) + Number(!!this.dates.kind);
  }

  private renderForm(): void {
    const modal = this.advanced;
    if (!modal) return;
    modal.content.replaceChildren();
    const form = document.createElement('form');
    const query = document.createElement('input');
    query.name = 'query';
    query.maxLength = 200;
    query.type = 'hidden';
    query.value = this.launch.value;
    query.placeholder = text('messageSearch.placeholder');
    form.append(query);
    form.append(this.picker('authorIds', 'messageSearch.from'), this.picker('channelIds', 'messageSearch.in'));
    const contentChoices: Array<ComboChoice<'image' | 'video' | 'audio' | 'file' | 'link'>> = [
      { id: 'image', name: text('messageSearch.image'), icon: 'image' },
      { id: 'video', name: text('messageSearch.video'), icon: 'videocam' },
      { id: 'audio', name: text('messageSearch.audio'), icon: 'audio_file' },
      { id: 'file', name: text('messageSearch.file'), icon: 'draft' },
      { id: 'link', name: text('messageSearch.link'), icon: 'link' },
    ];
    const authorType = this.select('authorType', [
      { value: '', label: 'messageSearch.any' }, { value: 'human', label: 'messageSearch.human' },
      { value: 'bot', label: 'messageSearch.bot' },
    ]);
    const date = this.select('date', ['', 'before', 'after', 'on', 'range'].map(value => ({
      value, label: `messageSearch.${value || 'any'}` as Key,
    })));
    const dates = document.createElement('div');
    dates.className = 'message-search-dates';
    const today = todayCalendarValue();
    const startValue = this.dates.start || today;
    const endValue = this.dates.end || today;
    const start = document.createElement('input');
    start.type = 'text';
    start.readOnly = true;
    start.dataset.pickerOnly = '';
    start.dataset.datePicker = '';
    start.dataset.dateValue = startValue;
    start.value = formatCalendarValue(startValue, getLanguage());
    start.name = 'start';
    start.id = 'message-search-date-start';
    start.setAttribute('aria-label', text('messageSearch.date'));
    const end = document.createElement('input');
    end.type = 'text';
    end.readOnly = true;
    end.dataset.pickerOnly = '';
    end.dataset.datePicker = '';
    end.dataset.dateValue = endValue;
    end.value = formatCalendarValue(endValue, getLanguage());
    end.name = 'end';
    end.id = 'message-search-date-end';
    end.hidden = true;
    end.tabIndex = -1;
    end.setAttribute('aria-hidden', 'true');
    dates.append(start, end);
    const dateChoice = document.createElement('div');
    dateChoice.append(date, dates);
    const syncDateDisplay = () => {
      const startDate = dateFieldValue(start);
      const endDate = dateFieldValue(end);
      if (date.value === 'range') {
        start.value = `${formatCalendarValue(startDate, getLanguage())} – ${formatCalendarValue(endDate, getLanguage())}`;
        start.setAttribute('aria-label', text('messageSearch.range'));
      } else {
        setDateFieldValue(start, startDate, getLanguage());
        start.setAttribute('aria-label', text('messageSearch.date'));
      }
    };
    const syncDate = () => {
      dates.hidden = !date.value;
      start.disabled = !date.value;
      end.disabled = date.value !== 'range';
      start.required = !!date.value;
      end.required = false;
      if (date.value === 'range') {
        start.dataset.dateRangeStart = start.id;
        start.dataset.dateRangeEnd = end.id;
      } else {
        delete start.dataset.dateRangeStart;
        delete start.dataset.dateRangeEnd;
      }
      syncDateDisplay();
    };
    start.addEventListener('change', syncDateDisplay);
    end.addEventListener('change', syncDateDisplay);
    authorType.value = this.filters.authorType ?? '';
    date.value = this.dates.kind;
    date.addEventListener('change', syncDate);
    syncDate();
    form.append(this.comboPicker('messageSearch.contains', 'messageSearch.containsHint', 'messageSearch.anyContent',
      contentChoices, this.contains, () => {}, 'contains'),
      this.picker('mentionsUserIds', 'messageSearch.mentions'),
      this.filterField('messageSearch.date', 'messageSearch.dateHint', dateChoice),
      this.filterField('messageSearch.authorType', 'messageSearch.authorTypeHint', authorType));
    const actions = document.createElement('div');
    actions.className = 'message-search-actions';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn-primary';
    submit.textContent = text('messageSearch.apply');
    actions.append(this.button('messageSearch.reset', () => {
      for (const values of Object.values(this.selected)) values.clear();
      this.contains.clear();
      this.filters = {};
      this.dates = { kind: '', start: '', end: '' };
      this.launch.value = '';
      this.renderForm();
    }), this.button('messageSearch.cancel', modal.close), submit);
    form.append(actions);
    const status = document.createElement('p');
    status.className = 'message-search-status';
    status.setAttribute('role', 'status');
    form.insertBefore(status, actions);
    modal.content.append(form);
    form.addEventListener('submit', event => {
      event.preventDefault();
      this.clearResults();
      const filters: MessageSearchPayload = {
        query: query.value, authorIds: [...this.selected.authorIds], channelIds: [...this.selected.channelIds],
        mentionsUserIds: [...this.selected.mentionsUserIds], contains: [...this.contains],
        ...(authorType.value === 'human' || authorType.value === 'bot' ? { authorType: authorType.value } : {}),
      };
      if (date.value) {
        const startDate = dateFieldValue(start);
        const endDate = dateFieldValue(end);
        const first = Date.parse(`${startDate}T00:00:00.000Z`);
        const last = Date.parse(`${endDate}T00:00:00.000Z`);
        if (!Number.isFinite(first) || (date.value === 'range' && (!Number.isFinite(last) || last < first))) {
          this.status(text('messageSearch.invalidDate')); return;
        }
        if (date.value === 'before') filters.before = first;
        if (date.value === 'after') filters.after = first + 86400000 - 1;
        if (date.value === 'on') filters.on = startDate;
        if (date.value === 'range') { filters.after = Math.max(0, first - 1); filters.before = last + 86400000; }
      }
      this.filters = filters;
      this.dates = { kind: date.value, start: dateFieldValue(start), end: dateFieldValue(end) };
      this.launch.value = query.value;
      this.renderLaunchState();
      this.advancedApplied = true;
      modal.close();
      this.showResults();
      void this.loadPage(0);
    });
  }

  private picker(selection: Selection, label: Key): HTMLElement {
    const choices = selection === 'channelIds'
      ? this.options.channels().filter(isMessageChannel)
        .map(channel => ({ id: channel.id, name: channelLabel(channel), icon: channelIcon(channel) }))
      : this.options.users().filter(user => selection !== 'mentionsUserIds' || !user.isBot)
        .map(user => ({ id: user.id, name: user.nickname, avatarUrl: user.avatarUrl }));
    return this.comboPicker(label, selection === 'channelIds' ? 'messageSearch.inHint'
      : selection === 'authorIds' ? 'messageSearch.fromHint' : 'messageSearch.mentionsHint',
    selection === 'channelIds' ? 'messageSearch.chooseChannels' : 'messageSearch.chooseUsers',
    choices, this.selected[selection], () => this.renderLaunchState(), selection);
  }

  private comboPicker<T extends string>(
    label: Key,
    hint: Key,
    placeholder: Key,
    choices: Array<ComboChoice<T>>,
    selected: Set<T>,
    onChange: () => void = () => {},
    selection?: Selection | 'contains',
  ): HTMLElement {
    const control = document.createElement('div');
    control.className = 'message-search-combobox';
    if (selection) control.dataset.selection = selection;
    const inputSurface = document.createElement('div');
    inputSurface.className = 'message-search-combobox-field';
    const chips = document.createElement('div');
    chips.className = 'message-search-combobox-chips';
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.autocomplete = 'off';
    filter.setAttribute('role', 'combobox');
    filter.setAttribute('aria-autocomplete', 'list');
    filter.setAttribute('aria-expanded', 'false');
    filter.setAttribute('aria-label', text(label));
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'message-search-combobox-toggle';
    toggle.setAttribute('aria-label', text(label));
    toggle.setAttribute('aria-expanded', 'false');
    const chevron = document.createElement('span');
    chevron.className = 'material-symbols-outlined md-18';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = 'expand_more';
    toggle.append(chevron);
    const list = document.createElement('div');
    list.className = 'message-search-combobox-options';
    list.id = `message-search-options-${crypto.randomUUID()}`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-multiselectable', 'true');
    list.setAttribute('aria-label', text(label));
    list.hidden = true;
    filter.setAttribute('aria-controls', list.id);
    toggle.setAttribute('aria-controls', list.id);
    const setOpen = (open: boolean) => {
      list.hidden = !open;
      control.classList.toggle('is-open', open);
      filter.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-expanded', String(open));
      chevron.textContent = open ? 'expand_less' : 'expand_more';
      if (!open) {
        filter.value = '';
        filter.placeholder = selected.size ? '' : text(placeholder);
      }
    };
    const renderChips = () => {
      chips.replaceChildren();
      for (const choice of choices.filter(item => selected.has(item.id))) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'message-search-combobox-chip';
        chip.dataset.value = choice.id;
        chip.setAttribute('aria-label', `${text('messageSearch.removeFilter')}: ${choice.name}`);
        chip.append(document.createTextNode(choice.name));
        const remove = document.createElement('span');
        remove.className = 'material-symbols-outlined md-14';
        remove.setAttribute('aria-hidden', 'true');
        remove.textContent = 'close';
        chip.append(remove);
        chip.addEventListener('click', () => {
          selected.delete(choice.id);
          filter.value = '';
          render();
          onChange();
          filter.focus();
        });
        chips.append(chip);
      }
      filter.placeholder = selected.size ? '' : text(placeholder);
    };
    const render = () => {
      renderChips();
      list.replaceChildren();
      const matches = choices.filter(choice => choice.name.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase()));
      for (const choice of matches.slice(0, 100)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'message-search-combobox-option';
        button.dataset.value = choice.id;
        button.setAttribute('role', 'option');
        button.setAttribute('aria-selected', String(selected.has(choice.id)));
        if (choice.avatarUrl) {
          const image = document.createElement('img');
          image.src = getAvatarUrl(choice.avatarUrl);
          image.alt = '';
          image.dataset.fallback = 'avatar';
          button.append(image);
        } else {
          const icon = document.createElement('span');
          icon.className = 'material-symbols-outlined md-18';
          icon.textContent = choice.icon ?? 'person';
          button.append(icon);
        }
        button.append(document.createTextNode(choice.name));
        const check = document.createElement('span');
        check.className = 'message-search-combobox-check';
        check.setAttribute('aria-hidden', 'true');
        button.append(check);
        button.addEventListener('click', () => {
          if (selected.has(choice.id)) selected.delete(choice.id); else if (selected.size < 50) selected.add(choice.id);
          filter.value = '';
          render();
          onChange();
          filter.focus();
        });
        list.append(button);
      }
      if (!matches.length) {
        const more = document.createElement('small');
        more.textContent = text('messageSearch.noOptions');
        list.append(more);
      }
    };
    filter.addEventListener('focus', () => { setOpen(true); render(); });
    filter.addEventListener('click', () => { setOpen(true); render(); });
    filter.addEventListener('input', () => { setOpen(true); render(); });
    filter.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        filter.blur();
      } else if (event.key === 'Backspace' && !filter.value && selected.size) {
        event.preventDefault();
        selected.delete([...selected].at(-1)!);
        render();
        onChange();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        list.querySelector<HTMLButtonElement>('button')?.focus();
      }
    });
    const toggleList = () => {
      const open = list.hidden;
      setOpen(open);
      if (open) {
        render();
        filter.focus({ preventScroll: true });
      }
    };
    toggle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      toggleList();
    });
    toggle.addEventListener('click', event => {
      if (event.detail !== 0) return;
      toggleList();
    });
    list.addEventListener('keydown', event => {
      if (!(event.target instanceof HTMLButtonElement) || !['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Escape') { setOpen(false); filter.focus(); return; }
      const options = [...list.querySelectorAll<HTMLButtonElement>('button')];
      const index = options.indexOf(event.target);
      options[Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    });
    list.addEventListener('pointerdown', event => {
      if (event.target instanceof Element && event.target.closest('button')) event.preventDefault();
    });
    control.addEventListener('focusout', () => queueMicrotask(() => {
      if (!control.contains(document.activeElement)) setOpen(false);
    }));
    inputSurface.append(chips, filter, toggle);
    control.append(inputSurface, list);
    render();
    return this.filterField(label, hint, control);
  }

  private status(message: string): void {
    const node = (this.advanced?.content ?? this.panel).querySelector('.message-search-status');
    if (node) node.textContent = message;
  }

  private renderResultAttachments(attachments: AttachmentMeta[] | undefined, message: ChatMessage): HTMLElement | null {
    if (!attachments?.length) return null;
    const container = document.createElement('div');
    container.className = 'message-search-result-attachments';
    for (const attachment of attachments) {
      if (!attachment.url) continue;
      const src = getAttachmentUrl(attachment.url);
      if (!src) continue;
      if (attachment.kind === 'image') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'message-search-result-image';
        button.title = attachment.originalName;
        const image = document.createElement('img');
        image.src = src;
        image.alt = attachment.originalName;
        image.loading = 'lazy';
        button.append(image);
        button.addEventListener('click', event => {
          event.stopPropagation();
          const item: LightboxMedia = {
            kind: 'image', url: src, fileName: attachment.originalName, senderName: message.userNickname,
            timestamp: new Date(message.createdAt).toLocaleString(getLanguage()), source: button,
          };
          lightboxModal.open([item], 0, downloadLightboxFile);
        });
        container.append(button);
        continue;
      }
      if (attachment.kind === 'video') {
        const player = document.createElement('div');
        player.className = 'chat-video-player message-search-result-video-player';
        const video = document.createElement('video');
        video.className = 'chat-attachment-video message-search-result-video';
        video.src = src;
        video.preload = 'metadata';
        video.playsInline = true;
        player.append(video);
        container.append(player);
        continue;
      }
      if (attachment.mimeType.startsWith('audio/')) {
        const player = document.createElement('div');
        player.className = 'chat-audio-player message-search-result-audio-player';
        const audio = document.createElement('audio');
        audio.className = 'chat-attachment-audio message-search-result-audio';
        audio.src = src;
        audio.preload = 'metadata';
        audio.setAttribute('aria-label', attachment.originalName);
        const meta = document.createElement('div');
        meta.className = 'chat-audio-meta';
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined md-24 chat-audio-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'audio_file';
        const copy = document.createElement('span');
        copy.className = 'chat-audio-copy';
        const name = document.createElement('strong');
        name.textContent = attachment.originalName;
        name.title = attachment.originalName;
        const size = document.createElement('small');
        size.textContent = formatBytes(attachment.sizeBytes);
        copy.append(name, size);
        const download = document.createElement('button');
        download.type = 'button';
        download.className = 'chat-audio-download';
        download.title = t('common.download');
        download.setAttribute('aria-label', `${t('common.download')} ${attachment.originalName}`);
        download.innerHTML = '<span class="material-symbols-outlined md-20" aria-hidden="true">download</span>';
        download.addEventListener('click', event => {
          event.stopPropagation();
          void downloadLightboxFile(src, attachment.originalName);
        });
        meta.append(icon, copy, download);
        player.append(audio, meta);
        container.append(player);
        continue;
      }
      const file = document.createElement('button');
      file.type = 'button';
      file.className = 'chat-attachment-file message-search-result-file';
      file.setAttribute('aria-label', `${t('common.download')} ${attachment.originalName}`);
      const icon = document.createElement('span');
      icon.className = 'material-symbols-outlined md-20 af-icon';
      icon.textContent = fileIconName(attachment.kind, attachment.mimeType, attachment.originalName);
      const copy = document.createElement('span');
      copy.className = 'af-meta message-search-result-file-copy';
      const name = document.createElement('strong');
      name.className = 'af-name';
      name.textContent = attachment.originalName;
      const size = document.createElement('small');
      size.className = 'af-size';
      size.textContent = formatBytes(attachment.sizeBytes);
      copy.append(name, size);
      const download = document.createElement('span');
      download.className = 'material-symbols-outlined md-20 af-dl';
      download.setAttribute('aria-hidden', 'true');
      download.textContent = 'download';
      file.append(icon, copy, download);
      file.addEventListener('click', event => {
        event.stopPropagation();
        void downloadLightboxFile(src, attachment.originalName);
      });
      container.append(file);
    }
    return container.childElementCount ? container : null;
  }

  private async loadPage(page: number, render = true): Promise<boolean> {
    if (!this.options.isCurrent() || !this.options.canRead()) { this.invalidate(); return false; }
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const generation = ++this.generation;
    this.messages = [];
    this.panel.querySelector('.message-search-results')?.replaceChildren();
    this.panel.querySelector('.message-search-pagination')?.replaceChildren();
    this.status(text('messageSearch.loading'));
    this.panel.setAttribute('aria-busy', 'true');
    try {
      const result = await this.options.search({ ...this.filters, cursor: this.cursors[page] }, request.signal);
      if (request.signal.aborted || generation !== this.generation) return false;
      if (!this.options.isCurrent() || !this.options.canRead()) { this.invalidate(); return false; }
      const channels = new Set(this.options.channels().filter(isMessageChannel).map(channel => channel.id));
      if (result.messages.some(message => message.deletedAt || !channels.has(message.channelId))) { this.invalidate(); return false; }
      this.messages = result.messages;
      this.total = result.total;
      this.page = page;
      this.nextCursor = result.nextCursor;
      if (result.nextCursor) this.cursors[page + 1] = result.nextCursor;
      else this.cursors.splice(page + 1);
      if (render) this.renderResults();
      return true;
    } catch {
      if (request.signal.aborted || generation !== this.generation) return false;
      this.clearResults();
      this.status(text('messageSearch.error'));
      return false;
    } finally {
      if (this.request === request) this.request = null;
      if (generation === this.generation) this.panel.removeAttribute('aria-busy');
    }
  }

  private async goToPage(target: number): Promise<void> {
    const last = Math.max(0, Math.ceil(this.total / MESSAGE_SEARCH_PAGE_SIZE) - 1);
    target = Math.max(0, Math.min(target, last));
    if (target === 0 || this.cursors[target] !== undefined) {
      await this.loadPage(target);
      return;
    }
    let page = target - 1;
    while (page > 0 && this.cursors[page] === undefined) page--;
    for (; page <= target; page++) {
      if (!(await this.loadPage(page, page === target))) return;
      if (page < target) await new Promise(resolve => setTimeout(resolve, 275));
    }
  }

  private renderResults(): void {
    const results = this.panel.querySelector('.message-search-results');
    const pagination = this.panel.querySelector('.message-search-pagination');
    if (!results || !pagination) return;
    results.replaceChildren();
    this.status(this.messages.length ? '' : text('messageSearch.empty'));
    const count = this.panel.querySelector('.message-search-result-count');
    if (count) count.textContent = this.total === 1
      ? text('messageSearch.resultOne') : text('messageSearch.resultMany').replace('{count}', String(this.total));
    for (const message of this.messages) {
      const result = document.createElement('article');
      result.className = 'message-search-result';
      result.tabIndex = 0;
      result.setAttribute('role', 'button');
      const navigate = () => {
        if (!this.options.isCurrent() || !this.options.canRead()
          || !this.options.channels().some(channel => channel.id === message.channelId && isMessageChannel(channel))) {
          this.invalidate(); return;
        }
        this.options.navigate(message.channelId, message.id);
      };
      result.addEventListener('click', event => {
        if (event.target instanceof Element && event.target.closest('a, button, video, audio')) return;
        navigate();
      });
      result.addEventListener('keydown', event => {
        if ((event.key === 'Enter' || event.key === ' ') && event.target === result) {
          event.preventDefault();
          navigate();
        }
      });
      result.dataset.messageId = message.id;
      result.setAttribute('aria-label', `${text('messageSearch.jump')}: ${message.userNickname}`);
      const jump = document.createElement('span');
      jump.className = 'message-search-result-jump';
      jump.textContent = text('messageSearch.jump');
      const author = document.createElement('strong');
      author.textContent = `${message.userNickname} · #${this.options.channels().find(channel => channel.id === message.channelId)?.name ?? ''}`;
      const time = document.createElement('time');
      time.dateTime = new Date(message.createdAt).toISOString();
      time.textContent = new Date(message.createdAt).toLocaleString(getLanguage());
      const content = document.createElement('div');
      content.className = 'chat-message-text message-search-result-content';
      content.innerHTML = renderMarkdown(getMessageText(message, getLanguage()).slice(0, 1200), {
        interactive: true,
        knownNicknames: this.options.users().map(user => user.nickname),
      });
      content.querySelectorAll('.md-code-copy').forEach(button => button.remove());
      result.append(jump, author, time, content);
      const attachments = this.renderResultAttachments(message.attachments, message);
      if (attachments) result.append(attachments);
      results.append(result);
    }
    initializeCustomMediaPlayers(results);
    pagination.replaceChildren();
    const previous = this.button('messageSearch.previous', () => void this.goToPage(this.page - 1), 'message-search-page-nav');
    previous.disabled = this.page === 0;
    previous.replaceChildren(this.paginationIcon('chevron_left'));
    previous.setAttribute('aria-label', text('messageSearch.previous'));
    previous.title = text('messageSearch.previous');
    const totalPages = Math.max(1, Math.ceil(this.total / MESSAGE_SEARCH_PAGE_SIZE));
    const visible = new Set<number>();
    if (totalPages <= 7) {
      for (let page = 0; page < totalPages; page++) visible.add(page);
    } else {
      for (const page of [0, 1, 2, this.page - 1, this.page, this.page + 1, totalPages - 1]) {
        if (page >= 0 && page < totalPages) visible.add(page);
      }
    }
    const pages: HTMLElement[] = [];
    let previousPage = -1;
    for (const page of [...visible].sort((a, b) => a - b)) {
      if (previousPage >= 0 && page - previousPage > 1) {
        const ellipsis = document.createElement('span');
        ellipsis.className = 'message-search-page-ellipsis';
        ellipsis.textContent = '…';
        ellipsis.setAttribute('aria-hidden', 'true');
        pages.push(ellipsis);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-search-page';
      button.dataset.page = String(page);
      button.textContent = String(page + 1);
      button.setAttribute('aria-label', String(page + 1));
      if (page === this.page) {
        button.setAttribute('aria-current', 'page');
        button.disabled = true;
      }
      button.addEventListener('click', () => void this.goToPage(page));
      pages.push(button);
      previousPage = page;
    }
    const next = this.button('messageSearch.next', () => void this.goToPage(this.page + 1), 'message-search-page-nav');
    next.replaceChildren(this.paginationIcon('chevron_right'));
    next.setAttribute('aria-label', text('messageSearch.next'));
    next.title = text('messageSearch.next');
    next.disabled = !this.nextCursor;
    pagination.append(previous, ...pages, next);
  }

  private paginationIcon(name: string): HTMLSpanElement {
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined md-16';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = name;
    return icon;
  }
}
