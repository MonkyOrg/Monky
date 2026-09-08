import {
  MessageType, Permission, botSelectorPublicSchema, type BotSelectorPublic,
} from '@monky/shared';
import { appEvents } from '../core/EventBus';
import type { NetworkClient } from '../core/NetworkClient';
import { currentEventOrigin } from '../core/sessionRouting';
import type { ServerStore } from '../stores/serverStore';
import { getLanguage, t } from '../i18n';
import { escapeHtml } from '../utils/html';

/** Channel controls are rebuilt from server snapshots, never invocation memory. */
export class PublicSelectorView {
  private snapshots = new Map<string, BotSelectorPublic>();
  private drafts = new Map<string, string>();
  private pending = new Set<string>();
  private errors = new Map<string, string>();
  private unbind: Array<() => void> = [];
  private observer: MutationObserver;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private loading = false;

  constructor(
    private feed: HTMLElement,
    private client: NetworkClient,
    private server: ServerStore,
    private channelId: string
  ) {
    this.feed.addEventListener('click', this.onClick);
    this.feed.addEventListener('change', this.onChange);
    this.unbind.push(
      appEvents.on('message.SELECTOR_SNAPSHOT', (payload: unknown) => {
        if (!this.isOrigin()) return;
        const result = botSelectorPublicSchema.safeParse(payload);
        if (result.success && result.data.channelId === channelId) {
          this.snapshots.set(result.data.id, result.data);
          this.refresh();
        }
      }),
      appEvents.on('network.connected', () => { if (this.isOrigin()) void this.load(); }),
      appEvents.on('network.status', () => { if (this.isOrigin()) this.refresh(); }),
      appEvents.on('server.updated', () => { if (this.isOrigin()) { this.refresh(); void this.load(); } }),
      appEvents.on('server.roles_updated', () => { if (this.isOrigin()) { this.refresh(); void this.load(); } }),
    );
    this.observer = new MutationObserver((records) => {
      if (records.some((record) => [...record.addedNodes].some((node) =>
        node instanceof Element && (node.matches('[data-message-id]') || node.querySelector('[data-message-id]'))
      ))) this.refresh();
    });
    this.observer.observe(feed, { childList: true, subtree: true });
    void this.load();
  }

  private isOrigin(): boolean {
    const origin = currentEventOrigin();
    return origin === null || origin === this.client.sessionKey;
  }

  private async load(): Promise<void> {
    if (this.destroyed || this.loading || this.client.getStatus() !== 'CONNECTED') return;
    this.loading = true;
    try {
      const result = await this.client.sendRequest<{ selectors: unknown[] }>(MessageType.SELECTOR_LIST, { channelId: this.channelId });
      if (this.destroyed || !Array.isArray(result.selectors)) return;
      this.feed.querySelector('[data-selector-load-error]')?.remove();
      this.snapshots.clear();
      for (const entry of result.selectors) {
        const parsed = botSelectorPublicSchema.safeParse(entry);
        if (parsed.success && parsed.data.channelId === this.channelId) this.snapshots.set(parsed.data.id, parsed.data);
      }
      this.refresh();
    } catch (error: unknown) {
      if (!this.destroyed) {
        console.warn('Could not restore public bot selectors.', error);
        const notice = this.feed.querySelector<HTMLElement>('[data-selector-load-error]') ?? document.createElement('p');
        notice.dataset.selectorLoadError = '';
        notice.className = 'bot-error';
        notice.setAttribute('role', 'alert');
        notice.textContent = t('botSelector.loadError');
        this.feed.append(notice);
      }
    } finally {
      this.loading = false;
    }
  }

  private refresh(): void {
    if (this.destroyed) return;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    for (const controls of this.feed.querySelectorAll<HTMLElement>('[data-public-selector]')) {
      if (!this.snapshots.has(controls.dataset.publicSelector ?? '')) controls.remove();
    }
    let nextExpiry = Infinity;
    for (const selector of this.snapshots.values()) {
      const row = [...this.feed.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find((element) => element.dataset.messageId === selector.messageId);
      if (!row || row.classList.contains('chat-message-deleted')) continue;
      const body = row.querySelector<HTMLElement>('.chat-message-body');
      if (!body) continue;
      const question = body.querySelector<HTMLElement>('.chat-message-text');
      if (question && question.textContent !== selector.title) question.textContent = selector.title;
      let controls = body.querySelector<HTMLElement>('[data-public-selector]');
      if (!controls) {
        controls = document.createElement('section');
        controls.dataset.publicSelector = selector.id;
        controls.className = 'bot-inline-form public-bot-selector';
        controls.setAttribute('aria-label', selector.title);
        body.append(controls);
      }
      const closed = selector.closedAt !== null ||
        (selector.expiresAt !== undefined && selector.expiresAt <= Date.now());
      if (!closed && selector.expiresAt !== undefined) nextExpiry = Math.min(nextExpiry, selector.expiresAt);
      const channel = this.server.serverDetails?.channels.find((entry) => entry.id === this.channelId);
      const permitted = this.client.getStatus() === 'CONNECTED' && channel?.botCommandsEnabled !== false &&
        this.server.hasPermission(Permission.READ_MESSAGES) &&
        this.server.hasPermission(Permission.SEND_MESSAGES) && this.server.hasPermission(Permission.USE_BOT_COMMANDS);
      const disabled = closed || !permitted || !selector.canRespond || this.pending.has(selector.id);
      const selected = this.drafts.get(selector.id) ?? selector.ownResponse ?? selector.choices[0]?.value ?? '';
      const choices = selector.presentation === 'buttons'
        ? `<div class="bot-choice-buttons">${selector.choices.map((choice) =>
          `<button type="button" class="btn ${selector.ownResponse === choice.value ? 'btn-primary' : 'btn-secondary'}"
            data-selector-value="${escapeHtml(choice.value)}" aria-pressed="${selector.ownResponse === choice.value}"
            ${disabled ? 'disabled' : ''}>${escapeHtml(choice.label)} (${selector.counts[choice.value] ?? 0})</button>`
        ).join('')}</div>`
        : `<label>${escapeHtml(t('botSelector.choose'))}
          <select data-selector-dropdown ${disabled ? 'disabled' : ''}>${selector.choices.map((choice) =>
            `<option value="${escapeHtml(choice.value)}" ${selected === choice.value ? 'selected' : ''}>
              ${escapeHtml(choice.label)} (${selector.counts[choice.value] ?? 0})</option>`
          ).join('')}</select></label>
          <button type="button" class="btn btn-primary" data-selector-confirm ${disabled ? 'disabled' : ''}>
            ${escapeHtml(t('common.confirm'))}</button>`;
      const conditions = [
        selector.expiresAt === undefined ? '' : t('botSelector.deadline', {
          time: new Date(selector.expiresAt).toLocaleString(getLanguage()),
        }),
        selector.maxResponders === undefined ? '' : t('botSelector.participants', {
          count: selector.responseCount, max: selector.maxResponders,
        }),
      ].filter(Boolean).join(' · ');
      const html = `${choices}<p class="bot-status" role="status">${closed
        ? t('botSelector.closed')
        : this.pending.has(selector.id) ? t('botChat.submitting')
          : t('botSelector.responses', { count: selector.responseCount })}</p>
        <p class="bot-field-description">${escapeHtml(conditions)}</p>
        <p class="bot-error" role="alert" ${this.errors.has(selector.id) ? '' : 'hidden'}>${escapeHtml(this.errors.get(selector.id) ?? '')}</p>`;
      if (controls.innerHTML !== html) {
        const focused = document.activeElement instanceof HTMLElement && controls.contains(document.activeElement)
          ? document.activeElement : null;
        const focusedValue = focused?.dataset.selectorValue;
        const wasDropdown = focused?.hasAttribute('data-selector-dropdown');
        controls.innerHTML = html;
        const target = wasDropdown ? controls.querySelector<HTMLElement>('[data-selector-dropdown]')
          : [...controls.querySelectorAll<HTMLElement>('[data-selector-value]')]
            .find((element) => element.dataset.selectorValue === focusedValue);
        if (focused && target) target.focus();
      }
    }
    if (Number.isFinite(nextExpiry)) {
      this.expiryTimer = setTimeout(() => this.refresh(), Math.min(2_147_483_647, Math.max(1, nextExpiry - Date.now())));
    }
  }

  private onChange = (event: Event): void => {
    if (!(event.target instanceof HTMLSelectElement) || !event.target.hasAttribute('data-selector-dropdown')) return;
    const id = event.target.closest<HTMLElement>('[data-public-selector]')?.dataset.publicSelector;
    if (id) this.drafts.set(id, event.target.value);
  };

  private onClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>('button[data-selector-value],button[data-selector-confirm]');
    if (!button || button.disabled) return;
    const controls = button.closest<HTMLElement>('[data-public-selector]');
    const id = controls?.dataset.publicSelector;
    const value = button.dataset.selectorValue ?? controls?.querySelector<HTMLSelectElement>('select')?.value;
    if (!id || value === undefined) return;
    event.preventDefault();
    void this.respond(id, value);
  };

  private async respond(id: string, value: string): Promise<void> {
    if (this.pending.has(id) || this.destroyed) return;
    this.pending.add(id);
    this.errors.delete(id);
    this.refresh();
    try {
      const result = await this.client.sendRequest<unknown>(MessageType.SELECTOR_RESPOND, { id, value });
      const parsed = botSelectorPublicSchema.parse(result);
      if (this.destroyed) return;
      this.snapshots.set(id, parsed);
      this.drafts.delete(id);
    } catch (error: unknown) {
      if (!this.destroyed) this.errors.set(id, error instanceof Error ? error.message : t('botSelector.responseFailed'));
    } finally {
      this.pending.delete(id);
      this.refresh();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.observer.disconnect();
    this.feed.removeEventListener('click', this.onClick);
    this.feed.removeEventListener('change', this.onChange);
    for (const unbind of this.unbind) unbind();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.snapshots.clear();
    this.drafts.clear();
    this.errors.clear();
  }
}
