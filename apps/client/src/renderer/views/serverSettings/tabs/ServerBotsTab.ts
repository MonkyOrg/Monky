import { BotInfo, MessageType, Permission } from '@monky/shared';
import { networkClient } from '../../../core/NetworkClient';
import { serverStore } from '../../../stores/serverStore';
import { appEvents } from '../../../core/EventBus';
import { escapeHtml } from '../../../utils/html';
import { getAvatarUrl } from '../../../utils/avatar';
import { t } from '../../../i18n';
import { showAlert, showConfirm } from '../../Dialog';

/**
 * Bots tab inside Server Settings (#569).
 *
 * Lets admins with `MANAGE_BOTS` permission create and revoke bots, and lists
 * all bots with their online/TOFU status.
 */
export class ServerBotsTab {
  private bots: BotInfo[] = [];
  private pendingToken: string | null = null;
  private unbind: Array<() => void> = [];

  public renderHtml(): string {
    return `
      <div style="display: flex; flex-direction: column; gap: 16px; width: 100%;">
        <!-- Create bot form -->
        <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 10px;">${t('bots.createTitle')}</div>
          <div style="display: flex; gap: 8px; align-items: flex-end;">
            <div style="flex: 1;">
              <label style="font-size: 11px; color: var(--text-muted); display: block; margin-bottom: 4px;">${t('bots.nameLabel')}</label>
              <input id="bot-name-input" type="text" class="input-field" placeholder="${t('bots.namePlaceholder')}" maxlength="32" style="width: 100%;">
            </div>
            <button id="btn-create-bot" type="button" class="btn btn-primary" style="white-space: nowrap;">
              <span class="material-symbols-outlined md-16">smart_toy</span>
              ${t('bots.createBtn')}
            </button>
          </div>
        </div>

        <!-- Token reveal (shown once after creation) -->
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

        <!-- Bot list -->
        <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 10px;">${t('bots.listTitle')}</div>
          <div id="bot-list-container" style="display: flex; flex-direction: column; gap: 6px;">
            <div style="font-size: 12px; color: var(--text-muted);">${t('bots.loading')}</div>
          </div>
        </div>
      </div>
    `;
  }

  public attachEvents(): void {
    this.detachEvents();

    const createBtn = document.getElementById('btn-create-bot');
    const nameInput = document.getElementById('bot-name-input') as HTMLInputElement | null;
    const copyBtn = document.getElementById('btn-copy-token');

    createBtn?.addEventListener('click', () => this.handleCreate(nameInput));
    copyBtn?.addEventListener('click', () => {
      if (this.pendingToken) {
        navigator.clipboard.writeText(this.pendingToken).catch(() => {});
      }
    });

    // Listen for BOT_CREATED (token reveal) and refresh.
    const u1 = appEvents.on(`message.${MessageType.BOT_CREATED}`, (payload: { bot: BotInfo; token: string }) => {
      this.pendingToken = payload.token;
      const reveal = document.getElementById('bot-token-reveal');
      const tokenEl = document.getElementById('bot-token-value');
      if (reveal && tokenEl) {
        tokenEl.textContent = payload.token;
        reveal.style.display = 'block';
      }
      this.refreshList();
    });

    const u2 = appEvents.on(`message.${MessageType.BOT_REVOKED}`, () => {
      this.refreshList();
    });

    const u3 = appEvents.on(`message.${MessageType.BOT_LIST}`, (payload: { bots: BotInfo[] }) => {
      this.bots = payload.bots;
      this.renderBotList();
    });

    this.unbind.push(u1, u2, u3);

    // Initial load.
    this.refreshList();
  }

  public detachEvents(): void {
    for (const fn of this.unbind) fn();
    this.unbind = [];
    this.pendingToken = null;
  }

  private async handleCreate(nameInput: HTMLInputElement | null): Promise<void> {
    const name = nameInput?.value.trim();
    if (!name || name.length < 2) {
      showAlert({ message: t('bots.nameRequired') });
      return;
    }
    try {
      await networkClient.sendRequest(MessageType.BOT_CREATE, { name });
      if (nameInput) nameInput.value = '';
    } catch (err: any) {
      showAlert({ message: err?.message || t('bots.createError') });
    }
  }

  private refreshList(): void {
    networkClient.send(MessageType.BOT_LIST, {});
  }

  private renderBotList(): void {
    const container = document.getElementById('bot-list-container');
    if (!container) return;

    if (this.bots.length === 0) {
      container.innerHTML = `<div style="font-size: 12px; color: var(--text-muted);">${t('bots.noBots')}</div>`;
      return;
    }

    container.innerHTML = this.bots.map((bot) => `
      <div class="bot-list-item" data-bot-id="${bot.id}" style="display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: var(--radius-sm); background: var(--bg-elevated);">
        <img src="${getAvatarUrl(bot.avatarUrl)}" data-fallback="avatar" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;">
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 13px; font-weight: 600; color: var(--text-primary);">${escapeHtml(bot.name)}</span>
            <span class="member-badge-bot">BOT</span>
            ${bot.online ? `<span style="width: 8px; height: 8px; border-radius: 50%; background: var(--success-color, #3ba55d);"></span>` : ''}
            ${bot.bound ? `<span style="font-size: 10px; color: var(--text-muted);" title="${t('bots.tofuBound')}">🔒</span>` : ''}
          </div>
          <div style="font-size: 11px; color: var(--text-muted);">${t('bots.createdAt')}: ${new Date(bot.createdAt).toLocaleDateString()}</div>
        </div>
        <button type="button" class="btn-revoke-bot btn btn-secondary" data-bot-id="${bot.id}" style="font-size: 11px; padding: 4px 10px; color: var(--danger-color, #ed4245);">
          <span class="material-symbols-outlined md-14">delete</span>
          ${t('bots.revoke')}
        </button>
      </div>
    `).join('');

    container.querySelectorAll('.btn-revoke-bot').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const botId = (btn as HTMLElement).dataset.botId;
        if (!botId) return;
        const bot = this.bots.find((b) => b.id === botId);
        const confirmed = await showConfirm({
          message: t('bots.revokeConfirm', { name: bot?.name || botId }),
          confirmLabel: t('bots.revoke'),
          variant: 'danger',
        });
        if (!confirmed) return;
        try {
          await networkClient.sendRequest(MessageType.BOT_REVOKE, { botId });
        } catch (err: any) {
          showAlert({ message: err?.message || t('bots.revokeError') });
        }
      });
    });
  }
}
