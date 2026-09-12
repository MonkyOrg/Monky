import {
  MessageType,
  Permission,
  type BotInfo,
  type BotCreatedPayload,
  type BotListResponsePayload,
} from '@monky/shared';
import type { NetworkClient } from '../../../core/NetworkClient';
import { appEvents } from '../../../core/EventBus';
import { escapeHtml } from '../../../utils/html';
import { getAvatarUrl } from '../../../utils/avatar';
import { getLanguage, t } from '../../../i18n';
import { showAlert, showConfirm } from '../../Dialog';
import { botSettingsModal } from '../../BotSettingsModal';
import { botRequestError } from '../../../utils/botInputs';
import type { ServerSettingsContext } from '../ServerSettingsContext';

/**
 * Bots tab inside Server Settings (#569).
 *
 * Lets admins with `MANAGE_BOTS` link and unlink bots, while bot-owned profile
 * identity stays read-only in the client.
 */
export class ServerBotsTab {
  private bots: BotInfo[] = [];
  private pendingToken: string | null = null;
  private unbind: Array<() => void> = [];
  private root: HTMLElement | null = null;
  private client: NetworkClient | null = null;
  private context: ServerSettingsContext | null = null;
  private generation = 0;
  private listRequest = 0;
  private creating = false;
  private hadPermission = false;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private manualLinkExpanded = false;

  public renderHtml(): string {
    return `
      <div id="server-bots-tab" style="display: flex; flex-direction: column; gap: 16px; width: 100%;">
        <div data-settings-section="install-bot" data-settings-label="${escapeHtml(t('bots.installTitle'))}" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px;">
            <div style="font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 6px;">
              <span class="material-symbols-outlined md-16">add_circle</span>
              ${t('bots.installTitle')}
            </div>
            <span style="display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; background: rgba(88,101,242,0.16); color: var(--accent-primary); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;">${t('bots.recommended')}</span>
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">${t('bots.installDescription')}</div>
          <div style="display: flex; gap: 8px; align-items: flex-end;">
            <div style="flex: 1;">
              <label style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 4px;">${t('bots.manifestUrlLabel')}</label>
              <input id="bot-manifest-url" type="url" class="input-field" placeholder="${t('bots.manifestUrlPlaceholder')}" style="width: 100%;">
            </div>
            <button id="btn-install-bot" type="button" class="btn btn-primary" style="white-space: nowrap;">
              <span class="material-symbols-outlined md-16">add_circle</span>
              ${t('bots.installBtn')}
            </button>
          </div>
          <div id="bot-install-status" style="display: none; margin-top: 8px; font-size: 12px; padding: 8px; border-radius: var(--radius-sm);"></div>
        </div>

        <div data-settings-section="manual-link-bot" data-settings-label="${escapeHtml(t('bots.createTitle'))}" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
          <div style="display: flex; justify-content: space-between; gap: 12px; align-items: flex-start;">
            <div style="min-width: 0;">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <div style="font-size: 13px; font-weight: 700;">${t('bots.createTitle')}</div>
                <span style="display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; background: rgba(250,166,26,0.16); color: var(--warning-color, #f0b232); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;">${t('bots.advanced')}</span>
              </div>
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">${t('bots.createDescription')}</div>
            </div>
            <button id="btn-toggle-manual-link" type="button" class="btn btn-secondary" aria-expanded="false" aria-controls="manual-bot-link-panel" style="white-space: nowrap;">
              <span class="material-symbols-outlined md-16" data-manual-link-icon>expand_more</span>
              <span data-manual-link-label>${t('bots.showAdvanced')}</span>
            </button>
          </div>
          <div id="manual-bot-link-panel" hidden style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-color);">
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 10px;">${t('bots.createHint')}</div>
            <button id="btn-create-bot" type="button" class="btn btn-secondary" style="white-space: nowrap;">
              <span class="material-symbols-outlined md-16">vpn_key</span>
              ${t('bots.createBtn')}
            </button>
          </div>
        </div>

        <div id="bot-token-reveal" style="display: none; background: var(--bg-card); border: 1px solid var(--warning-color, #f0b232); border-radius: var(--radius-md); padding: 14px;">
          <div style="font-size: 12px; font-weight: 700; color: var(--warning-color, #f0b232); margin-bottom: 6px;">
            <span class="material-symbols-outlined md-14" style="vertical-align: middle;">warning</span>
            ${t('bots.tokenWarning')}
          </div>
          <code id="bot-token-value" style="display: block; background: var(--bg-elevated); padding: 8px 10px; border-radius: var(--radius-sm); font-size: 12px; word-break: break-all; color: var(--text-primary); user-select: all;"></code>
          <button id="btn-copy-token" type="button" class="btn btn-secondary" style="margin-top: 8px; font-size: 11px;">
            <span class="material-symbols-outlined md-14">content_copy</span>
            ${t('bots.copyToken')}
          </button>
        </div>

        <div data-settings-section="bots" data-settings-label="${escapeHtml(t('bots.listTitle'))}" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 10px;">${t('bots.listTitle')}</div>
          <div id="bot-list-container" style="display: flex; flex-direction: column; gap: 6px;">
            <div style="font-size: 12px; color: var(--text-muted);">${t('bots.loading')}</div>
          </div>
        </div>
      </div>
    `;
  }

  public attachEvents(container: HTMLElement, context: ServerSettingsContext): void {
    this.detachEvents();
    const root = container.querySelector<HTMLElement>('#server-bots-tab');
    if (!root) return;
    this.root = root;
    this.context = context;
    this.client = context.client;
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof HTMLElement) || !this.isAttached()) return;
      const button = event.target.closest<HTMLButtonElement>('button');
      if (!button || button.matches(':disabled')) return;
      if (button.id === 'btn-create-bot') void this.handleCreate();
      else if (button.id === 'btn-install-bot') void this.handleInstall();
      else if (button.id === 'btn-toggle-manual-link') this.setManualLinkExpanded(!this.manualLinkExpanded);
      else if (button.id === 'btn-copy-token' && this.pendingToken) {
        void navigator.clipboard.writeText(this.pendingToken).catch(() => {
          if (this.isAttached()) context.operations.reportError('bot-token', t('bots.copyToken'), t('chat.copyFailed'));
        });
      } else if (button.dataset.botConfigure) void botSettingsModal.open(button.dataset.botConfigure);
      else if (button.dataset.botRevoke) void this.revokeBot(button.dataset.botRevoke);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement) || !this.isAttached()) return;
      if (event.target.id === 'bot-manifest-url') { event.preventDefault(); void this.handleInstall(); }
    };
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeyDown);
    this.unbind.push(
      () => root.removeEventListener('click', onClick),
      () => root.removeEventListener('keydown', onKeyDown),
      appEvents.on('server.members_updated', () => {
        if (this.isAttached()) void this.refreshList();
      }),
      appEvents.on('user.updated', () => {
        if (this.isAttached()) void this.refreshList();
      })
    );
    this.setManualLinkExpanded(this.manualLinkExpanded);
    this.refreshPermissions();
  }

  public detachEvents(): void {
    this.generation++;
    for (const fn of this.unbind) fn();
    this.unbind = [];
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.pendingToken = null;
    this.creating = false;
    this.hadPermission = false;
    this.manualLinkExpanded = false;
    this.root = null;
    this.client = null;
    this.context = null;
    this.bots = [];
  }

  private isAttached(generation = this.generation, client = this.client): boolean {
    return generation === this.generation && !!this.root?.isConnected && client !== null &&
      client === this.client && this.context?.isCurrent() === true &&
      this.context.store.hasPermission(Permission.MANAGE_BOTS);
  }

  public refreshPermissions(): void {
    const context = this.context;
    if (!context || !this.root || !context.isCurrent()) return;
    const allowed = context.store.hasPermission(Permission.MANAGE_BOTS);
    if (allowed && !this.hadPermission) {
      this.hadPermission = true;
      void this.refreshList();
    } else if (!allowed && this.hadPermission) {
      this.hadPermission = false;
      this.pendingToken = null;
      this.bots = [];
      this.renderBotList();
      const reveal = this.root.querySelector<HTMLElement>('#bot-token-reveal');
      if (reveal) reveal.style.display = 'none';
      const token = this.root.querySelector('#bot-token-value');
      if (token) token.textContent = '';
    }
  }

  private setManualLinkExpanded(expanded: boolean): void {
    this.manualLinkExpanded = expanded;
    const button = this.root?.querySelector<HTMLButtonElement>('#btn-toggle-manual-link');
    const panel = this.root?.querySelector<HTMLElement>('#manual-bot-link-panel');
    const icon = this.root?.querySelector<HTMLElement>('[data-manual-link-icon]');
    const label = this.root?.querySelector<HTMLElement>('[data-manual-link-label]');
    if (button) button.setAttribute('aria-expanded', String(expanded));
    if (panel) panel.hidden = !expanded;
    if (icon) icon.textContent = expanded ? 'expand_less' : 'expand_more';
    if (label) label.textContent = t(expanded ? 'bots.hideAdvanced' : 'bots.showAdvanced');
  }

  private async handleInstall(): Promise<void> {
    const client = this.client;
    const context = this.context;
    const generation = this.generation;
    const urlInput = this.root?.querySelector<HTMLInputElement>('#bot-manifest-url');
    const button = this.root?.querySelector<HTMLButtonElement>('#btn-install-bot');
    if (!client || !context || button?.disabled || context.operations.isPending('bot-install')) return;
    const url = urlInput?.value.trim();
    if (!url) {
      showAlert({ message: t('bots.manifestUrlRequired') });
      return;
    }

    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      showAlert({ message: t('bots.manifestUrlInvalid') });
      return;
    }

    this.showInstallStatus('loading', t('bots.installing'));
    if (button) button.disabled = true;

    try {
      const result = await context.operations.run('bot-install', t('bots.installTitle'), Permission.MANAGE_BOTS,
        () => context.request<unknown>(MessageType.BOT_INSTALL, { manifestUrl: url }, Permission.MANAGE_BOTS, 30000));
      if (!result.ok) throw new Error(result.message);
      if (!this.isAttached(generation, client)) return;
      if (urlInput) urlInput.value = '';
      this.showInstallStatus('success', t('bots.installSuccess'));
      void this.refreshList();
    } catch (error) {
      if (!this.isAttached(generation, client)) return;
      const raw = error instanceof Error ? error.message : '';
      const message = raw.includes('Timeout')
        ? t('bots.installTimeout')
        : raw || t('bots.installError');
      this.showInstallStatus('error', message);
    } finally {
      if (button && generation === this.generation) button.disabled = false;
    }
  }

  private showInstallStatus(type: 'loading' | 'success' | 'error', message: string): void {
    const el = this.root?.querySelector<HTMLElement>('#bot-install-status');
    if (!el) return;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    el.style.display = 'block';
    el.textContent = message;
    if (type === 'success') {
      el.style.background = 'var(--success-color-bg, rgba(59,165,93,0.15))';
      el.style.color = 'var(--success-color, #3ba55d)';
    } else if (type === 'error') {
      el.style.background = 'var(--danger-color-bg, rgba(237,66,69,0.15))';
      el.style.color = 'var(--danger-color, #ed4245)';
    } else {
      el.style.background = 'var(--bg-elevated)';
      el.style.color = 'var(--text-muted)';
    }
    if (type === 'success') {
      this.statusTimer = setTimeout(() => { el.style.display = 'none'; this.statusTimer = null; }, 5000);
    }
  }

  private async handleCreate(): Promise<void> {
    const client = this.client;
    const context = this.context;
    const generation = this.generation;
    const button = this.root?.querySelector<HTMLButtonElement>('#btn-create-bot');
    if (!client || !context || this.creating || button?.disabled || context.operations.isPending('bot-create')) return;
    this.creating = true;
    if (button) button.disabled = true;
    try {
      const result = await context.operations.run('bot-create', t('bots.createTitle'), Permission.MANAGE_BOTS,
        () => context.request<BotCreatedPayload>(MessageType.BOT_CREATE, {}, Permission.MANAGE_BOTS));
      if (!result.ok) throw new Error(result.message);
      const response = result.value;
      if (!this.isAttached(generation, client)) return;
      this.pendingToken = response.token;
      const reveal = this.root?.querySelector<HTMLElement>('#bot-token-reveal');
      const token = this.root?.querySelector<HTMLElement>('#bot-token-value');
      if (reveal && token) {
        token.textContent = response.token;
        reveal.style.display = 'block';
      }
      this.bots = [...this.bots.filter((bot) => bot.id !== response.bot.id), response.bot];
      this.renderBotList();
      void this.refreshList();
    } catch (error) {
      if (this.isAttached(generation, client)) void showAlert({ message: botRequestError(error) });
    } finally {
      if (generation === this.generation) {
        this.creating = false;
        if (button) button.disabled = false;
      }
    }
  }

  private async refreshList(): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    const request = ++this.listRequest;
    if (!client || !this.isAttached()) return;
    try {
      const response = await client.sendRequest<BotListResponsePayload>(MessageType.BOT_LIST, {});
      if (!this.isAttached(generation, client) || request !== this.listRequest) return;
      this.bots = response.bots;
      this.renderBotList();
    } catch (error) {
      if (!this.isAttached(generation, client) || request !== this.listRequest) return;
      const container = this.root?.querySelector<HTMLElement>('#bot-list-container');
      if (container) {
        const message = document.createElement('p');
        message.className = 'bot-error';
        message.setAttribute('role', 'alert');
        message.textContent = botRequestError(error);
        container.querySelector('.bot-error')?.remove();
        container.prepend(message);
      }
    }
  }

  private renderBotList(): void {
    const container = this.root?.querySelector<HTMLElement>('#bot-list-container');
    if (!container) return;

    if (this.bots.length === 0) {
      container.innerHTML = `<div style="font-size: 12px; color: var(--text-muted);">${t('bots.noBots')}</div>`;
      return;
    }

    container.innerHTML = this.bots.map((bot) => {
      const pending = bot.profilePending;
      const name = escapeHtml(pending ? t('bots.pendingIdentity') : bot.name);
      const avatarUrl = escapeHtml(getAvatarUrl(pending ? null : bot.avatarUrl));
      const meta = [
        pending ? t('bots.pendingIdentity') : t(bot.online ? 'botSettings.online' : 'botSettings.offline'),
        bot.bound ? t('bots.tofuBound') : null,
        `${t('bots.createdAt')}: ${new Date(bot.createdAt).toLocaleDateString(getLanguage())}`,
      ].filter((value): value is string => !!value).map(escapeHtml).join(' • ');
      const configureTitle = pending ? t('bots.configurePending') : t('bots.configure');
      return `
        <div class="bot-list-item" data-bot-id="${escapeHtml(bot.id)}" style="display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: var(--radius-sm); background: var(--bg-elevated);">
          <img src="${avatarUrl}" alt="" data-fallback="avatar" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;">
          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
              <span style="font-size: 13px; font-weight: 600; color: var(--text-primary);">${name}</span>
              <span class="member-badge-bot">${t('botChat.badge')}</span>
              ${bot.online ? `<span style="width: 8px; height: 8px; border-radius: 50%; background: var(--success-color, #3ba55d);" title="${escapeHtml(t('botSettings.online'))}"></span>` : ''}
            </div>
            <div style="font-size: 11px; color: var(--text-muted);">${meta}</div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end;">
            <button type="button" class="btn btn-secondary" data-bot-configure="${escapeHtml(bot.id)}" title="${escapeHtml(configureTitle)}" ${pending ? 'disabled' : ''}>
              <span class="material-symbols-outlined md-16">settings</span>
              ${t('bots.configure')}
            </button>
            <button type="button" class="btn-revoke-bot btn btn-secondary" data-bot-revoke="${escapeHtml(bot.id)}" style="font-size: 11px; padding: 4px 10px; color: var(--danger-color, #ed4245);">
              <span class="material-symbols-outlined md-14">delete</span>
              ${t('bots.revoke')}
            </button>
          </div>
        </div>
      `;
    }).join('');
  }

  private async revokeBot(botId: string): Promise<void> {
    const client = this.client;
    const context = this.context;
    const generation = this.generation;
    const bot = this.bots.find((entry) => entry.id === botId);
    if (!client || !context || !bot || context.operations.isPending(`bot-revoke:${botId}`)) return;
    await context.operations.run(`bot-revoke:${botId}`, t('bots.revoke'), Permission.MANAGE_BOTS, async () => {
      const confirmed = await showConfirm({
        message: t('bots.revokeConfirm', { name: this.displayName(bot) }),
        confirmLabel: t('bots.revoke'),
        variant: 'danger',
      });
      if (!confirmed) return;
      await context.request<unknown>(MessageType.BOT_REVOKE, { botId }, Permission.MANAGE_BOTS);
      if (this.isAttached(generation, client)) {
        this.bots = this.bots.filter((entry) => entry.id !== botId);
        this.renderBotList();
        void this.refreshList();
      }
    });
  }

  private displayName(bot: BotInfo): string {
    return bot.profilePending ? t('bots.pendingIdentity') : bot.name;
  }
}
