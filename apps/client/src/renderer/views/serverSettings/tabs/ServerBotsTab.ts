import {
  MessageType,
  botCreateSchema,
  botProfileUpdateSchema,
  type BotInfo,
  type BotCreatedPayload,
  type BotListResponsePayload,
  type BotProfileUpdatedPayload,
} from '@monky/shared';
import { getActiveNetworkClient, type NetworkClient } from '../../../core/NetworkClient';
import { isForegroundEvent } from '../../../core/sessionRouting';
import { appEvents } from '../../../core/EventBus';
import { escapeHtml } from '../../../utils/html';
import { getAvatarUrl } from '../../../utils/avatar';
import { getLanguage, t } from '../../../i18n';
import { showAlert, showConfirm } from '../../Dialog';
import { pickAndCropImage } from '../../ImageCropModal';
import { validateBotAvatar } from '../../../utils/botProfile';
import { botRequestError } from '../../../utils/botInputs';

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
  private root: HTMLElement | null = null;
  private client: NetworkClient | null = null;
  private generation = 0;
  private listRequest = 0;
  private createAvatar: string | undefined;
  private profileAvatar: string | null | undefined;
  private editingBotId: string | null = null;
  private creating = false;
  private saving = false;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  public renderHtml(): string {
    return `
      <div id="server-bots-tab" style="display: flex; flex-direction: column; gap: 16px; width: 100%;">
        <!-- Create bot form -->
        <div data-settings-section="create-bot" data-settings-label="${escapeHtml(t('bots.createTitle'))}" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 10px;">${t('bots.createTitle')}</div>
          ${this.photoHtml('create')}
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

        <!-- Add bot from URL (#578) -->
        <div data-settings-section="install-bot" data-settings-label="${escapeHtml(t('bots.installTitle'))}" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 10px;">
            <span class="material-symbols-outlined md-16" style="vertical-align: middle;">add_circle</span>
            ${t('bots.installTitle')}
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
        <div data-settings-section="bots" data-settings-label="${escapeHtml(t('bots.listTitle'))}" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
          <div style="font-size: 13px; font-weight: 700; margin-bottom: 10px;">${t('bots.listTitle')}</div>
          <div id="bot-list-container" style="display: flex; flex-direction: column; gap: 6px;">
            <div style="font-size: 12px; color: var(--text-muted);">${t('bots.loading')}</div>
          </div>
        </div>
        <div id="bot-profile-editor" data-settings-section="bot-profile" data-settings-label="${escapeHtml(t('bots.profileEdit'))}" class="bot-profile-editor" hidden></div>
      </div>
    `;
  }

  public attachEvents(): void {
    this.detachEvents();
    const root = document.getElementById('server-bots-tab');
    if (!root) return;
    this.root = root;
    this.client = getActiveNetworkClient();
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof HTMLElement) || !this.isAttached()) return;
      const button = event.target.closest<HTMLButtonElement>('button');
      if (!button || button.disabled) return;
      if (button.id === 'btn-create-bot') void this.handleCreate();
      else if (button.id === 'btn-install-bot') void this.handleInstall();
      else if (button.id === 'btn-copy-token' && this.pendingToken) {
        void navigator.clipboard.writeText(this.pendingToken).catch(() => {});
      } else if (button.dataset.photoTarget === 'create' || button.dataset.photoTarget === 'profile') {
        void this.selectPhoto(button.dataset.photoTarget);
      } else if (button.dataset.photoRemove === 'create' || button.dataset.photoRemove === 'profile') {
        this.removePhoto(button.dataset.photoRemove);
      } else if (button.dataset.botEdit) this.editProfile(button.dataset.botEdit);
      else if (button.dataset.botRevoke) void this.revokeBot(button.dataset.botRevoke);
      else if (button.id === 'btn-save-bot-profile') void this.saveProfile();
      else if (button.id === 'btn-cancel-bot-profile' && !this.saving) this.closeProfile();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement) || !this.isAttached()) return;
      if (event.target.id === 'bot-name-input') { event.preventDefault(); void this.handleCreate(); }
      else if (event.target.id === 'bot-profile-name') { event.preventDefault(); void this.saveProfile(); }
    };
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeyDown);
    this.unbind.push(
      () => root.removeEventListener('click', onClick),
      () => root.removeEventListener('keydown', onKeyDown),
      appEvents.on('server.members_updated', () => {
        if (this.isAttached()) void this.refreshList();
      })
    );
    void this.refreshList();
  }

  public detachEvents(): void {
    this.generation++;
    for (const fn of this.unbind) fn();
    this.unbind = [];
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    this.pendingToken = null;
    this.createAvatar = undefined;
    this.profileAvatar = undefined;
    this.editingBotId = null;
    this.creating = false;
    this.saving = false;
    this.root = null;
    this.client = null;
    this.bots = [];
  }

  private isAttached(generation = this.generation, client = this.client): boolean {
    return generation === this.generation && !!this.root?.isConnected && client !== null &&
      client === this.client && client === getActiveNetworkClient() && isForegroundEvent();
  }

  private async handleInstall(): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    const urlInput = this.root?.querySelector<HTMLInputElement>('#bot-manifest-url');
    const button = this.root?.querySelector<HTMLButtonElement>('#btn-install-bot');
    if (!client || button?.disabled) return;
    const url = urlInput?.value.trim();
    if (!url) {
      showAlert({ message: t('bots.manifestUrlRequired') });
      return;
    }

    // Basic URL validation.
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
      // BOT_INSTALL fetches the manifest and POSTs to the bot — may take longer than default 8s.
      await client.sendRequest<unknown>(MessageType.BOT_INSTALL, { manifestUrl: url }, undefined, 30000);
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
      if (button && this.isAttached(generation, client)) button.disabled = false;
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
    if (type !== 'loading') {
      this.statusTimer = setTimeout(() => { el.style.display = 'none'; this.statusTimer = null; }, 5000);
    }
  }

  private async handleCreate(): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    const nameInput = this.root?.querySelector<HTMLInputElement>('#bot-name-input');
    if (!client || this.creating) return;
    const name = nameInput?.value.trim();
    const parsed = botCreateSchema.safeParse({ name, avatarBase64: this.createAvatar });
    if (!parsed.success) {
      showAlert({ message: t('bots.nameRequired') });
      return;
    }
    const button = this.root?.querySelector<HTMLButtonElement>('#btn-create-bot');
    this.creating = true;
    if (button) button.disabled = true;
    if (nameInput) nameInput.disabled = true;
    try {
      const response = await client.sendRequest<BotCreatedPayload>(MessageType.BOT_CREATE, parsed.data);
      if (!this.isAttached(generation, client)) return;
      this.pendingToken = response.token;
      const reveal = this.root?.querySelector<HTMLElement>('#bot-token-reveal');
      const token = this.root?.querySelector<HTMLElement>('#bot-token-value');
      if (reveal && token) { token.textContent = response.token; reveal.style.display = 'block'; }
      if (nameInput) nameInput.value = '';
      this.createAvatar = undefined;
      this.updatePhoto('create', null);
      void this.refreshList();
    } catch (error) {
      if (this.isAttached(generation, client)) void showAlert({ message: botRequestError(error) });
    } finally {
      if (this.isAttached(generation, client)) {
        this.creating = false;
        if (button) button.disabled = false;
        if (nameInput) nameInput.disabled = false;
      }
    }
  }

  private async refreshList(): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    const request = ++this.listRequest;
    if (!client) return;
    try {
      const response = await client.sendRequest<BotListResponsePayload>(MessageType.BOT_LIST, {});
      if (!this.isAttached(generation, client) || request !== this.listRequest) return;
      this.bots = response.bots;
      this.renderBotList();
      if (this.editingBotId && !this.bots.some((bot) => bot.id === this.editingBotId)) this.closeProfile();
    } catch (error) {
      if (!this.isAttached(generation, client) || request !== this.listRequest) return;
      const container = this.root?.querySelector<HTMLElement>('#bot-list-container');
      if (container && this.bots.length === 0) container.textContent = botRequestError(error);
    }
  }

  private renderBotList(): void {
    const container = this.root?.querySelector<HTMLElement>('#bot-list-container');
    if (!container) return;

    if (this.bots.length === 0) {
      container.innerHTML = `<div style="font-size: 12px; color: var(--text-muted);">${t('bots.noBots')}</div>`;
      return;
    }

    container.innerHTML = this.bots.map((bot) => `
      <div class="bot-list-item" data-bot-id="${escapeHtml(bot.id)}" style="display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: var(--radius-sm); background: var(--bg-elevated);">
        <img src="${escapeHtml(getAvatarUrl(bot.avatarUrl))}" alt="" data-fallback="avatar" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;">
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 13px; font-weight: 600; color: var(--text-primary);">${escapeHtml(bot.name)}</span>
            <span class="member-badge-bot">${t('botChat.badge')}</span>
            ${bot.online ? `<span style="width: 8px; height: 8px; border-radius: 50%; background: var(--success-color, #3ba55d);"></span>` : ''}
            ${bot.bound ? `<span style="font-size: 10px; color: var(--text-muted);" title="${t('bots.tofuBound')}">🔒</span>` : ''}
          </div>
          <div style="font-size: 11px; color: var(--text-muted);">${t('bots.createdAt')}: ${new Date(bot.createdAt).toLocaleDateString(getLanguage())}</div>
        </div>
        <button type="button" class="btn btn-secondary" data-bot-edit="${escapeHtml(bot.id)}" title="${t('bots.profileEdit')}">
          <span class="material-symbols-outlined md-16">edit</span>
        </button>
        <button type="button" class="btn-revoke-bot btn btn-secondary" data-bot-revoke="${escapeHtml(bot.id)}" style="font-size: 11px; padding: 4px 10px; color: var(--danger-color, #ed4245);">
          <span class="material-symbols-outlined md-14">delete</span>
          ${t('bots.revoke')}
        </button>
      </div>
    `).join('');

  }

  private photoHtml(target: 'create' | 'profile', avatarUrl?: string | null): string {
    return `<div class="bot-profile-photo-row">
      <button type="button" class="bot-profile-photo" data-photo-target="${target}" title="${t('bots.photo')}">
        <img data-photo-preview="${target}" src="${escapeHtml(getAvatarUrl(avatarUrl))}" alt="${t('bots.photo')}" data-fallback="avatar">
        <span class="material-symbols-outlined md-16">photo_camera</span>
      </button>
      <div><p class="bot-field-description">${t('bots.photoHint')}</p>
        <button type="button" class="bot-field-clear" data-photo-remove="${target}">${t('bots.removePhoto')}</button>
      </div>
    </div>`;
  }

  private updatePhoto(target: 'create' | 'profile', dataUrl?: string | null): void {
    const image = this.root?.querySelector<HTMLImageElement>(`[data-photo-preview="${target}"]`);
    if (image) image.src = getAvatarUrl(dataUrl);
  }

  private async selectPhoto(target: 'create' | 'profile'): Promise<void> {
    if (this.creating || this.saving) return;
    const client = this.client;
    const generation = this.generation;
    const editingBot = this.editingBotId;
    let image: string | null;
    try {
      image = await pickAndCropImage();
    } catch {
      if (this.isAttached(generation, client)) void showAlert({ message: t('protocolError.avatarInvalidType') });
      return;
    }
    if (!image || !this.isAttached(generation, client) || (target === 'profile' && this.editingBotId !== editingBot)) return;
    const error = validateBotAvatar(image);
    if (error) {
      void showAlert({ message: t(error === 'size' ? 'protocolError.avatarTooLarge' : 'protocolError.avatarInvalidType') });
      return;
    }
    if (target === 'create') this.createAvatar = image;
    else this.profileAvatar = image;
    this.updatePhoto(target, image);
  }

  private removePhoto(target: 'create' | 'profile'): void {
    if (this.creating || this.saving) return;
    if (target === 'create') this.createAvatar = undefined;
    else this.profileAvatar = null;
    this.updatePhoto(target, null);
  }

  private editProfile(botId: string): void {
    if (this.saving) return;
    const bot = this.bots.find((entry) => entry.id === botId);
    const editor = this.root?.querySelector<HTMLElement>('#bot-profile-editor');
    if (!bot || !editor) return;
    this.editingBotId = botId;
    this.profileAvatar = undefined;
    editor.hidden = false;
    editor.innerHTML = `<h3>${t('bots.profileEdit')} · ${escapeHtml(bot.name)}</h3>
      ${this.photoHtml('profile', bot.avatarUrl)}
      <label for="bot-profile-name">${t('bots.nameLabel')}</label>
      <input id="bot-profile-name" class="input-field" maxlength="32" value="${escapeHtml(bot.name)}">
      <p class="bot-error" id="bot-profile-error" role="alert" hidden></p>
      <div class="bot-command-actions">
        <button id="btn-save-bot-profile" type="button" class="btn btn-primary">${t('bots.profileSave')}</button>
        <button id="btn-cancel-bot-profile" type="button" class="btn btn-secondary">${t('common.cancel')}</button>
      </div>`;
    editor.querySelector<HTMLInputElement>('#bot-profile-name')?.focus();
    editor.scrollIntoView({ block: 'nearest' });
  }

  private closeProfile(): void {
    this.editingBotId = null;
    this.profileAvatar = undefined;
    const editor = this.root?.querySelector<HTMLElement>('#bot-profile-editor');
    if (editor) { editor.innerHTML = ''; editor.hidden = true; }
  }

  private async saveProfile(): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    const botId = this.editingBotId;
    if (!client || !botId || this.saving) return;
    const input = this.root?.querySelector<HTMLInputElement>('#bot-profile-name');
    const errorElement = this.root?.querySelector<HTMLElement>('#bot-profile-error');
    const parsed = botProfileUpdateSchema.safeParse({
      botId,
      name: input?.value.trim(),
      ...(this.profileAvatar !== undefined ? { avatarBase64: this.profileAvatar } : {}),
    });
    if (!parsed.success) {
      if (errorElement) { errorElement.textContent = t('protocolError.botInvalidProfile'); errorElement.hidden = false; }
      return;
    }
    const button = this.root?.querySelector<HTMLButtonElement>('#btn-save-bot-profile');
    this.saving = true;
    if (button) { button.disabled = true; button.textContent = t('bots.profileSaving'); }
    if (input) input.disabled = true;
    try {
      const response = await client.sendRequest<BotProfileUpdatedPayload>(MessageType.BOT_UPDATE_PROFILE, parsed.data);
      if (!this.isAttached(generation, client)) return;
      this.bots = this.bots.map((bot) => bot.id === response.bot.id ? response.bot : bot);
      this.renderBotList();
      this.closeProfile();
      this.showInstallStatus('success', t('bots.profileSaved'));
    } catch (error) {
      if (!this.isAttached(generation, client)) return;
      if (errorElement) { errorElement.textContent = botRequestError(error); errorElement.hidden = false; }
    } finally {
      if (this.isAttached(generation, client)) {
        this.saving = false;
        if (button) { button.disabled = false; button.textContent = t('bots.profileSave'); }
        if (input) input.disabled = false;
      }
    }
  }

  private async revokeBot(botId: string): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    const bot = this.bots.find((entry) => entry.id === botId);
    if (!client || !bot) return;
    const confirmed = await showConfirm({
      message: t('bots.revokeConfirm', { name: bot.name }),
      confirmLabel: t('bots.revoke'),
      variant: 'danger',
    });
    if (!confirmed || !this.isAttached(generation, client)) return;
    try {
      await client.sendRequest<unknown>(MessageType.BOT_REVOKE, { botId });
      if (this.isAttached(generation, client)) void this.refreshList();
    } catch (error) {
      if (this.isAttached(generation, client)) void showAlert({ message: botRequestError(error) });
    }
  }
}
