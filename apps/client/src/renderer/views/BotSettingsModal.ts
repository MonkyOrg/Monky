import {
  MessageType, Permission, botSettingsListResponseSchema, botSettingsSnapshotSchema, localizeBotSettingsForm,
  normalizeBotLocale, resolveBotLocale, resolveBotSettingsValues, type BotLocale,
  botPermissionsSnapshotSchema, unreviewedBotPermissions, type BotCapability,
  type BotForm, type BotFormValues, type BotSettingsDefinition, type BotSettingsPatch, type BotSettingsSnapshot, type BotSettingsSummary,
} from '@monky/shared';
import { v4 as uuidv4 } from 'uuid';
import { appEvents } from '../core/EventBus';
import { getActiveNetworkClient, type NetworkClient } from '../core/NetworkClient';
import { currentEventOrigin } from '../core/sessionRouting';
import { audioPreviewService } from '../core/AudioPreviewService';
import { getActiveServerStore, type ServerStore } from '../stores/serverStore';
import { settingsStore } from '../stores/settingsStore';
import { getLanguage, SUPPORTED_LANGUAGES, t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { renderLoadingIndicator } from '../utils/loadingIndicator';
import { getAvatarUrl } from '../utils/avatar';
import { enableBackdropClose } from '../utils/modal';
import { botPreferenceScope } from '../utils/botPreferenceScope';
import { botPreferenceScopeFor } from '../utils/botSettingsContext';
import { botInputError, botRequestError, convertBotInputValues, initialBotInputValues } from '../utils/botInputs';
import { applyBotFieldAction, readBotFieldChange, renderBotFields, type BotFieldContext } from './botFields';
import { showAlert } from './Dialog';
import type { ContextMenuItem } from './ContextMenu';
import { renderLoadingSkeleton } from '../utils/loadingSkeleton';
import { SettingsSectionNavigation } from './settings/SettingsSectionNavigation';
import { readBotPermissionChange, renderBotPermissionControls, syncBotPermissionControls } from './botPermissionControls';

type Scope = 'user' | 'server' | 'permissions';
interface SettingsSession {
  client: NetworkClient;
  server: ServerStore;
  connectionId: ReturnType<NetworkClient['getConnectionId']>;
  serverUrl: string;
  serverId: string;
  userId: string;
}
interface SettingsDraft {
  values: BotFormValues;
  initial: BotFormValues;
  overrides: BotFormValues;
  dirty: boolean;
  reset: boolean;
}

function captureSession(client: NetworkClient, server: ServerStore): SettingsSession {
  return {
    client, server, connectionId: client.getConnectionId(), serverUrl: client.getCurrentServerUrl(),
    serverId: server.serverDetails?.id ?? '', userId: server.currentUser?.id ?? '',
  };
}

function validSession(session: SettingsSession): boolean {
  return session.client === getActiveNetworkClient() && session.server === getActiveServerStore() &&
    session.client.getStatus() === 'CONNECTED' && session.connectionId === session.client.getConnectionId() &&
    session.serverUrl === session.client.getCurrentServerUrl() &&
    session.serverId === session.server.serverDetails?.id && session.userId === session.server.currentUser?.id &&
    botPreferenceScope({ ...session, invokerId: session.userId, botId: 'catalog' }) !== null;
}

function sameValue(a: BotFormValues[string] | undefined, b: BotFormValues[string] | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class BotSettingsModal {
  private root: HTMLElement | null = null;
  private session: SettingsSession | null = null;
  private returnFocus: HTMLElement | null = null;
  private unbind: Array<() => void> = [];
  private pending = new Set<string>();
  private generation = 0;
  private bots: BotSettingsSummary[] = [];
  private snapshot: BotSettingsSnapshot | null = null;
  private selectedBotId: string | null = null;
  private drafts: Partial<Record<Scope, SettingsDraft>> = {};
  private scope: Scope = 'user';
  private confirmFileName = true;
  private localePreference: BotLocale | 'auto' = 'auto';
  private loading = false;
  private loadFailed = false;
  private saving = false;
  private schemaStale = false;
  private serverStale = false;
  private userStale = false;
  private message = '';
  private error = false;
  private permissionDraft: BotCapability[] = [];
  private permissionsStale = false;
  private sectionNavigation: SettingsSectionNavigation | null = null;

  public createOpenAction(
    botId?: string, client = getActiveNetworkClient(), server = getActiveServerStore()
  ): () => void {
    const session = captureSession(client, server);
    return () => { void this.openSession(session, botId); };
  }

  public open(botId?: string): Promise<void> {
    return this.openSession(captureSession(getActiveNetworkClient(), getActiveServerStore()), botId);
  }

  private async openSession(session: SettingsSession, botId?: string): Promise<void> {
    if (!validSession(session)) {
      await showAlert({ title: t('botSettings.title'), message: t('botSettings.sessionChanged'), variant: 'warning' });
      return;
    }
    this.close();
    this.session = session;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.root = document.createElement('div');
    this.root.className = 'modal-backdrop bot-settings-modal';
    document.body.appendChild(this.root);
    enableBackdropClose(this.root, () => this.close());
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('input', this.onInput);
    this.root.addEventListener('change', this.onInput);
    this.root.addEventListener('submit', this.onSubmit);
    window.addEventListener('keydown', this.onKeyDown);
    this.unbind.push(() => window.removeEventListener('keydown', this.onKeyDown), audioPreviewService.bind(this.root));
    this.unbind.push(appEvents.on('session.changed', () => this.close()));
    for (const event of ['network.disconnected', 'network.status', 'server.updated', 'server.roles_updated', 'user.updated']) {
      this.unbind.push(appEvents.on(event, () => {
        if (!this.isOrigin(session)) return;
        if (!this.isCurrent(session)) { this.close(); return; }
        this.refreshAuthorization();
      }));
    }
    this.unbind.push(
      appEvents.on('message.BOT_SETTINGS_LIST_RESPONSE', (payload: unknown) => this.receiveList(session, payload)),
      appEvents.on('message.BOT_SETTINGS_SNAPSHOT', (payload: unknown) => this.receiveSnapshot(session, payload)),
      appEvents.on('message.BOT_PERMISSIONS_SNAPSHOT', (payload: unknown) => {
        if (!this.isOrigin(session) || !this.isCurrent(session) || this.saving || !this.snapshot) return;
        const parsed = botPermissionsSnapshotSchema.safeParse(payload);
        if (!parsed.success || parsed.data.botId !== this.snapshot.bot.botId) return;
        this.permissionsStale ||= parsed.data.permissions.revision !== this.snapshot.bot.permissions?.revision;
        this.snapshot.bot = { ...this.snapshot.bot, permissions: parsed.data.permissions };
        this.render();
      }),
      appEvents.on('bot.preferences_updated', ({ scope }: { scope: string }) => {
        if (!this.isCurrent(session) || !this.snapshot || (this.saving && this.scope === 'user') ||
            scope !== botPreferenceScopeFor(session.client, session.server, this.snapshot.bot.botId)) return;
        if (this.drafts.user?.dirty) this.userStale = true;
        else this.initializeUserDraft();
        this.render();
      }),
      appEvents.on('i18n.language_changed', () => { if (this.isCurrent(session)) this.render(); })
    );
    if (botId) await this.loadBot(botId);
    else await this.loadList();
  }

  private isOrigin(session: SettingsSession): boolean {
    const origin = currentEventOrigin();
    return origin === null || origin === session.client.sessionKey;
  }

  private isCurrent(session: SettingsSession): boolean {
    return this.session === session && !!this.root?.isConnected && validSession(session);
  }

  private async request(session: SettingsSession, type: MessageType, payload: unknown): Promise<unknown> {
    if (!this.isCurrent(session)) throw new DOMException('Settings closed', 'AbortError');
    const id = uuidv4();
    this.pending.add(id);
    try { return await session.client.sendRequest<unknown>(type, payload, id); }
    finally { this.pending.delete(id); }
  }

  private async loadList(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const generation = ++this.generation;
    this.snapshot = null;
    this.selectedBotId = null;
    this.drafts = {};
    this.loading = true;
    this.loadFailed = false;
    this.message = '';
    this.error = false;
    this.render();
    try {
      const parsed = botSettingsListResponseSchema.safeParse(await this.request(session, MessageType.BOT_SETTINGS_LIST, {}));
      if (!this.isCurrent(session) || this.generation !== generation) return;
      if (!parsed.success) throw new Error(t('botSettings.invalidResponse'));
      this.bots = parsed.data.bots;
    } catch (error) {
      if (this.isCurrent(session) && this.generation === generation) {
        this.message = error instanceof Error ? botRequestError(error) : t('botSettings.loadFailed');
        this.error = true;
        this.loadFailed = true;
      }
    } finally {
      if (this.isCurrent(session) && this.generation === generation) { this.loading = false; this.render(); }
    }
  }

  private async loadBot(botId: string, preserveUser = false): Promise<void> {
    const session = this.session;
    if (!session) return;
    const generation = ++this.generation;
    if (this.selectedBotId !== botId) { this.snapshot = null; this.drafts = {}; }
    this.selectedBotId = botId;
    this.loading = true;
    this.loadFailed = false;
    this.message = '';
    this.error = false;
    this.render();
    try {
      const parsed = botSettingsSnapshotSchema.safeParse(await this.request(session, MessageType.BOT_SETTINGS_GET, { botId }));
      if (!this.isCurrent(session) || this.generation !== generation) return;
      if (!parsed.success || parsed.data.bot.botId !== botId) throw new Error(t('botSettings.invalidResponse'));
      this.acceptSnapshot(parsed.data, preserveUser);
    } catch (error) {
      if (this.isCurrent(session) && this.generation === generation) {
        this.message = error instanceof Error ? botRequestError(error) : t('botSettings.loadFailed');
        this.error = true;
        this.loadFailed = true;
      }
    } finally {
      if (this.isCurrent(session) && this.generation === generation) { this.loading = false; this.render(); }
    }
  }

  private acceptSnapshot(snapshot: BotSettingsSnapshot, preserveUser: boolean): void {
    const sameDeclaration = this.snapshot?.bot.botId === snapshot.bot.botId &&
      this.snapshot.bot.schemaRevision === snapshot.bot.schemaRevision;
    const keepUserDraft = preserveUser && sameDeclaration && this.drafts.user?.dirty;
    const userStale = !!keepUserDraft && this.userStale;
    this.snapshot = snapshot;
    this.permissionDraft = snapshot.bot.permissions?.granted.slice() ?? [];
    this.permissionsStale = false;
    if (!keepUserDraft) this.initializeUserDraft();
    const values = structuredClone(snapshot.server?.values ?? {});
    this.drafts.server = { values, initial: structuredClone(values), overrides: {}, dirty: false, reset: false };
    this.schemaStale = false;
    this.serverStale = false;
    this.userStale = userStale;
    this.message = '';
    this.error = false;
    if (!this.hasScope(this.scope)) this.scope = this.hasScope('user') ? 'user' : 'server';
    if (!sameDeclaration && snapshot.bot.permissions?.reviewRequired && this.canManage()) this.scope = 'permissions';
    this.refreshAuthorization(false);
  }

  private initializeUserDraft(): void {
    if (!this.session || !this.snapshot) return;
    const key = botPreferenceScopeFor(this.session.client, this.session.server, this.snapshot.bot.botId);
    const overrides = settingsStore.getBotUserSettings(key);
    const form = this.snapshot.definition.user;
    const resolved = resolveBotSettingsValues(form, overrides);
    const values = resolved.success ? resolved.values : { ...initialBotInputValues(form?.fields ?? []), ...overrides };
    this.drafts.user = { values, initial: structuredClone(values), overrides, dirty: false, reset: false };
    this.confirmFileName = !settingsStore.botDownloadConfirmationExceptions.includes(key);
    this.localePreference = settingsStore.getBotLocalePreference(key);
  }

  private canConfigure(): boolean {
    return !!this.snapshot?.bot.canConfigure && !!this.session?.server.hasPermission(Permission.CONFIGURE_BOTS);
  }

  private canManage(): boolean {
    return this.snapshot?.bot.canManage === true && this.session?.server.hasPermission(Permission.MANAGE_BOTS) === true;
  }

  private hasScope(scope: Scope): boolean {
    if (!this.snapshot) return false;
    if (scope === 'permissions') return this.canManage();
    return scope === 'user'
      ? true
      : this.snapshot.bot.hasServerSettings && this.canConfigure() && !!this.snapshot.definition.server && !!this.snapshot.server;
  }

  private refreshAuthorization(render = true): void {
    if (!this.snapshot) return;
    if (!this.canManage() && this.scope === 'permissions') {
      this.scope = 'user';
      this.permissionDraft = [];
      if (render) this.render();
    }
    if (!this.canConfigure() && (this.snapshot.server || this.snapshot.definition.server)) {
      const definition: BotSettingsDefinition = { user: this.snapshot.definition.user };
      for (const { code } of SUPPORTED_LANGUAGES) {
        const user = this.snapshot.definition.localizations?.[code]?.user;
        if (user) {
          definition.localizations ??= {};
          definition.localizations[code] = { user };
        }
      }
      this.snapshot = { ...this.snapshot, definition, server: undefined };
      delete this.drafts.server;
      if (this.scope === 'server') this.scope = 'user';
      if (render) this.render();
    } else if (this.canConfigure() && this.snapshot.bot.hasServerSettings && !this.snapshot.definition.server && !this.loading) {
      void this.loadBot(this.snapshot.bot.botId, true);
    }
  }

  private receiveList(session: SettingsSession, payload: unknown): void {
    if (!this.isOrigin(session) || !this.isCurrent(session)) return;
    const parsed = botSettingsListResponseSchema.safeParse(payload);
    if (!parsed.success) {
      this.loadFailed = true; this.message = t('botSettings.invalidResponse'); this.error = true; this.render(); return;
    }
    const listChanged = JSON.stringify(this.bots) !== JSON.stringify(parsed.data.bots);
    this.bots = parsed.data.bots;
    if (this.loading || this.saving) return;
    if (this.snapshot) {
      const bot = this.bots.find((entry) => entry.botId === this.snapshot?.bot.botId);
      if (!bot) {
        this.snapshot = null;
        this.selectedBotId = null;
        this.drafts = {};
        this.message = t('botSettings.unavailable');
        this.error = true;
      } else {
        const previous = this.snapshot.bot;
        if (JSON.stringify(previous) === JSON.stringify(bot)) return;
        this.schemaStale ||= bot.schemaRevision !== previous.schemaRevision;
        this.serverStale ||= bot.revision !== previous.revision;
        this.permissionsStale ||= bot.permissions?.revision !== previous.permissions?.revision;
        this.snapshot = { ...this.snapshot, bot };
        this.refreshAuthorization(false);
      }
    }
    if (this.snapshot || listChanged || this.message) this.render();
  }

  private receiveSnapshot(session: SettingsSession, payload: unknown): void {
    if (!this.isOrigin(session) || !this.isCurrent(session) || this.loading || this.saving || !this.snapshot) return;
    const parsed = botSettingsSnapshotSchema.safeParse(payload);
    if (!parsed.success) {
      this.loadFailed = true; this.message = t('botSettings.invalidResponse'); this.error = true; this.render(); return;
    }
    if (parsed.data.bot.botId !== this.snapshot.bot.botId) return;
    this.schemaStale ||= parsed.data.bot.schemaRevision !== this.snapshot.bot.schemaRevision;
    this.serverStale ||= parsed.data.server?.revision !== this.snapshot.server?.revision;
    this.permissionsStale ||= parsed.data.bot.permissions?.revision !== this.snapshot.bot.permissions?.revision;
    this.snapshot = { ...this.snapshot, bot: parsed.data.bot };
    this.refreshAuthorization(false);
    this.render();
  }

  private form(): BotForm | undefined {
    const locale = resolveBotLocale(this.localePreference === 'auto' ? getLanguage() : this.localePreference);
    return this.snapshot && this.scope !== 'permissions' ? localizeBotSettingsForm(this.snapshot.definition, this.scope, locale) : undefined;
  }
  private blocked(): boolean {
    return this.loading || this.loadFailed || this.saving || this.schemaStale ||
      (this.scope === 'permissions' ? this.permissionsStale || !this.canManage() || !this.snapshot?.bot.permissions?.requested
        : this.scope === 'server' ? this.serverStale : this.userStale);
  }
  private fieldContext(): BotFieldContext {
    return {
      prefix: `bot-settings-${this.scope}`,
      disabled: this.blocked(),
      persistentSelection: true,
      volumeScope: JSON.stringify(['bot-settings', this.session?.serverId, this.snapshot?.bot.botId, this.scope]),
    };
  }

  private render(): void {
    if (!this.root || !this.session) return;
    const focused = document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)
      ? document.activeElement : null;
    const selection = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
      ? { start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection } : null;
    const scrollTop = this.root.querySelector('.bot-settings-body')?.scrollTop ?? 0;
    this.sectionNavigation?.destroy();
    this.sectionNavigation = null;
    audioPreviewService.release(this.root);
    const snapshot = this.snapshot;
    const scopes = (['user', 'server', 'permissions'] as const).filter((scope) => this.hasScope(scope));
    const active = scopes.includes(this.scope);
    const form = this.form();
    const draft = this.drafts[this.scope];
    const invalid = !this.loading && draft ? resolveBotSettingsValues(form, convertBotInputValues(form?.fields ?? [], draft.values)) : undefined;
    const stale = this.schemaStale || (this.scope === 'permissions' ? this.permissionsStale : this.scope === 'server' ? this.serverStale : this.userStale);
    const message = stale ? t(this.scope === 'permissions' ? 'botPermissions.conflict' : 'botSettings.conflict') : this.message ||
      (invalid && !invalid.success ? t('botSettings.stalePreferences') : '');
    const error = stale || this.error || !!(invalid && !invalid.success);
    this.root.innerHTML = `<div class="modal-card settings-modal-card bot-settings-card" role="dialog" aria-modal="true" aria-labelledby="bot-settings-title" tabindex="-1">
      <div class="settings-sidebar">
        <button type="button" class="settings-tab-btn ${!snapshot ? 'active' : ''}" data-tab="catalog" data-settings-back ${this.saving ? 'disabled' : ''}>
          <span class="material-symbols-outlined md-18" aria-hidden="true">smart_toy</span>${t('botSettings.listTitle')}</button>
        <div role="tablist" aria-orientation="vertical" aria-label="${t('botSettings.title')}">
          ${scopes.map((scope) => `<button type="button" class="settings-tab-btn ${scope === this.scope ? 'active' : ''}" role="tab"
            id="bot-settings-tab-${scope}" data-tab="${scope}" data-settings-scope="${scope}"
            aria-selected="${scope === this.scope}" tabindex="${scope === this.scope ? '0' : '-1'}"
            aria-controls="tab-panel-${scope}" ${this.saving ? 'disabled' : ''}>
            <span class="material-symbols-outlined md-18" aria-hidden="true">${scope === 'permissions' ? 'shield' : scope === 'server' ? 'dns' : 'person'}</span>
            ${t(scope === 'permissions' ? 'botPermissions.title' : scope === 'user' ? 'botSettings.userTab' : 'botSettings.serverTab')}</button>`).join('')}
        </div>
      </div>
      <div class="settings-main-container">
      <div class="settings-content-header">
        <div><h2 class="modal-title" id="bot-settings-title">${t(this.selectedBotId ? 'botSettings.title' : 'botSettings.listTitle')}</h2>
          <div class="bot-settings-server">${escapeHtml(this.session.server.serverDetails?.name ?? '')}</div></div>
        <button type="button" class="settings-back-btn" data-settings-close aria-label="${t('common.close')}"><span class="material-symbols-outlined">close</span><span class="esc-hint">ESC</span></button>
      </div>
      <div class="settings-content-body bot-settings-body" aria-busy="${this.loading}">
      <div class="settings-tab-panel" id="tab-panel-${snapshot ? this.scope : 'catalog'}"
        ${snapshot ? `role="tabpanel" aria-labelledby="bot-settings-tab-${this.scope}"` : ''}>
        ${this.loading ? `<p class="bot-status" role="status">${renderLoadingIndicator(t('botSettings.loading'))}</p>${renderLoadingSkeleton('lines', 5)}` : snapshot ? `
          <div class="bot-settings-identity">
            <img src="${escapeHtml(getAvatarUrl(snapshot.bot.avatarUrl))}" alt="" data-fallback="avatar">
            <div><div class="bot-settings-name">${escapeHtml(snapshot.bot.name)}</div>
              <div class="bot-settings-presence">${t(snapshot.bot.online ? 'botSettings.online' : 'botSettings.offline')}</div></div>
          </div>
          ${!snapshot.bot.online ? `<p class="bot-settings-description">${t('botSettings.offlineHint')}</p>` : ''}
          ${this.scope === 'permissions' && active ? `<form id="bot-settings-form" class="bot-settings-form" novalidate>
            <h3>${t('botPermissions.title')}</h3>
            ${snapshot.bot.permissions?.reviewRequired !== false ? `<p role="status">${t('botPermissions.reviewPending')}</p>` : ''}
            ${renderBotPermissionControls(snapshot.bot.permissions?.requested ?? null, this.permissionDraft, 'bot-settings-permissions', this.blocked())}
          </form>` : active && draft ? `<div id="bot-settings-panel">
            <p class="bot-settings-description">${t(this.scope === 'user' ? 'botSettings.userDescription' : 'botSettings.serverDescription')}</p>
            ${this.scope === 'user' ? `<button type="button" class="btn btn-secondary" data-settings-local-tools>
              <span class="material-symbols-outlined md-16" aria-hidden="true">build</span>
              ${escapeHtml(t('localExecution.managePermissions'))}
            </button>` : ''}
            <form id="bot-settings-form" class="bot-settings-form" novalidate>
              <fieldset ${this.blocked() ? 'disabled' : ''}>
                ${this.scope === 'user' ? `<div class="bot-settings-host-preference bot-field" data-settings-section="language" data-settings-label="${escapeHtml(t('botSettings.language'))}">
                  <div class="bot-field-heading"><span id="bot-settings-language-label">${t('botSettings.language')}</span></div>
                  <p class="bot-field-description">${t('botSettings.languageDescription')}</p>
                  <div class="bot-choice-buttons" role="group" aria-labelledby="bot-settings-language-label">
                    <button type="button" id="bot-settings-locale-auto" class="btn btn-secondary" data-settings-locale="auto"
                      aria-pressed="${this.localePreference === 'auto'}" title="${t('botSettings.languageAutoDescription')}">${t('botSettings.languageAuto')}</button>
                    ${SUPPORTED_LANGUAGES.map((language) => `<button type="button" id="bot-settings-locale-${language.code}"
                      class="btn btn-secondary" data-settings-locale="${language.code}"
                      aria-pressed="${this.localePreference === language.code}">${escapeHtml(language.label)}</button>`).join('')}
                  </div>
                </div>` : ''}
                ${this.scope === 'user' && snapshot.bot.capabilities.downloadsSound ? `<div class="bot-settings-host-preference bot-field" data-settings-section="downloads" data-settings-label="${escapeHtml(t('botSettings.askFileName'))}">
                  <div class="bot-field-heading"><label for="bot-settings-host-prompt">${t('botSettings.askFileName')}</label></div>
                  <label class="toggle-switch"><input type="checkbox" role="switch" id="bot-settings-host-prompt"
                    data-settings-host-prompt aria-describedby="bot-settings-host-hint" ${this.confirmFileName ? 'checked' : ''}>
                    <span class="toggle-slider"></span></label>
                  <p class="bot-field-description" id="bot-settings-host-hint">${t('botSettings.askFileNameHint')}</p>
                </div>` : ''}
                <section data-settings-section="bot-defined" data-settings-label="${escapeHtml(form?.title ?? t('botSettings.userTab'))}">
                ${form ? `<h3 class="bot-settings-name">${escapeHtml(form.title)}</h3>` : ''}
                ${form?.description ? `<p class="bot-field-description">${escapeHtml(form.description)}</p>` : ''}
                ${renderBotFields(form?.fields ?? [], draft.values, this.fieldContext())}
                </section>
              </fieldset>
            </form>
          </div>` : ''}` : this.selectedBotId ? '' : `<div class="bot-settings-list">${this.bots.map((bot) => `
            <button type="button" class="bot-settings-entry" data-settings-bot="${escapeHtml(bot.botId)}">
              <img src="${escapeHtml(getAvatarUrl(bot.avatarUrl))}" alt="" data-fallback="avatar">
              <span class="bot-settings-name">${escapeHtml(bot.name)}</span>
              <span class="bot-settings-presence">${t(bot.online ? 'botSettings.online' : 'botSettings.offline')}</span>
            </button>`).join('') || `<p class="bot-status">${t('botSettings.empty')}</p>`}</div>`}
        <p class="bot-settings-message ${error ? 'bot-error' : 'bot-status'}" role="${error ? 'alert' : 'status'}">${escapeHtml(message)}</p>
      </div>
      </div>
      <div class="modal-footer">
        ${this.selectedBotId ? `<button type="button" class="btn btn-secondary" data-settings-back ${this.saving ? 'disabled' : ''}>${t('common.back')}</button>` : ''}
        <button type="button" class="btn btn-secondary" data-settings-reload ${this.loading || this.saving ? 'disabled' : ''} ${this.loading ? 'data-loading="1" aria-busy="true"' : ''}>${t('botSettings.reload')}</button>
        ${active && !this.loading ? `<button type="button" class="btn btn-secondary" data-settings-defaults ${this.blocked() ? 'disabled' : ''}>${t('botSettings.defaults')}</button>
          <button type="submit" form="bot-settings-form" class="btn btn-primary" data-settings-save ${this.blocked() ? 'disabled' : ''} ${this.saving ? 'data-loading="1" aria-busy="true"' : ''}>
            ${t(this.saving ? 'botSettings.saving' : 'common.save')}</button>` : ''}
      </div>
      </div>
    </div>`;
    this.sectionNavigation = new SettingsSectionNavigation(this.root);
    this.sectionNavigation.setTab(snapshot ? this.scope : 'catalog');
    const restored = focused?.id ? document.getElementById(focused.id) : null;
    if (restored && this.root.contains(restored)) {
      restored.focus({ preventScroll: true });
      if (selection?.start !== null && selection?.start !== undefined && selection.end !== null &&
          (restored instanceof HTMLInputElement || restored instanceof HTMLTextAreaElement)) {
        restored.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
      }
    } else if (!this.root.contains(document.activeElement)) this.root.querySelector<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
    const body = this.root.querySelector('.bot-settings-body');
    if (body) body.scrollTop = scrollTop;
  }

  private setMessage(message: string, error: boolean): void {
    this.message = message;
    this.error = error;
    const element = this.root?.querySelector<HTMLElement>('.bot-settings-message');
    if (element) {
      element.textContent = message;
      element.className = `bot-settings-message ${error ? 'bot-error' : 'bot-status'}`;
      element.setAttribute('role', error ? 'alert' : 'status');
    }
  }

  private onInput = (event: Event): void => {
    if (this.blocked() || !this.session || !this.isCurrent(this.session)) return;
    if (this.scope === 'permissions') {
      const requested = this.snapshot?.bot.permissions?.requested ?? null;
      const next = readBotPermissionChange(event.target, requested, this.permissionDraft);
      if (next && this.root && requested) {
        this.permissionDraft = next;
        syncBotPermissionControls(this.root, requested, next);
        this.setMessage('', false);
      }
      return;
    }
    const draft = this.drafts[this.scope];
    if (!draft) return;
    if (event.target instanceof HTMLInputElement && event.target.hasAttribute('data-settings-host-prompt')) {
      this.confirmFileName = event.target.checked;
      draft.dirty = true;
    } else {
      const values = readBotFieldChange(event.target, this.form()?.fields ?? [], draft.values);
      if (!values) return;
      draft.values = values;
      draft.dirty = true;
      if (event.target instanceof Element) event.target.closest('[data-field-name]')?.removeAttribute('aria-invalid');
    }
    this.setMessage('', false);
  };

  private onClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return;
    const target = event.target;
    if (target.closest('[data-settings-close]')) { this.close(); return; }
    if (!this.session || !this.isCurrent(this.session)) { this.close(); return; }
    if (this.loading || this.saving) return;
    if (this.scope === 'user' && target.closest('[data-settings-local-tools]')) {
      this.close();
      void import('./SettingsModal').then(({ settingsModal }) => settingsModal.open('local_tools', 'local-tools-permissions'))
        .catch(() => showAlert({ title: t('settings.tabLocalTools'), message: t('localExecution.failure.executor_unavailable'), variant: 'warning' }));
      return;
    }
    const bot = target.closest<HTMLElement>('[data-settings-bot]')?.dataset.settingsBot;
    if (bot) { void this.loadBot(bot); return; }
    if (target.closest('[data-settings-back]')) { void this.loadList(); return; }
    if (target.closest('[data-settings-reload]')) {
      if (this.selectedBotId) void this.loadBot(this.selectedBotId);
      else void this.loadList();
      return;
    }
    const scope = target.closest<HTMLElement>('[data-settings-scope]')?.dataset.settingsScope;
    if ((scope === 'user' || scope === 'server' || scope === 'permissions') && this.hasScope(scope)) {
      this.scope = scope; this.message = ''; this.error = false; this.render();
      this.root?.querySelector<HTMLElement>(`[data-settings-scope="${scope}"]`)?.focus();
      return;
    }
    if (this.blocked()) return;
    if (this.scope === 'permissions') {
      if (target.closest('[data-settings-defaults]') && this.root) {
        this.permissionDraft = [];
        syncBotPermissionControls(this.root, this.snapshot?.bot.permissions?.requested ?? [], []);
      }
      return;
    }
    const draft = this.drafts[this.scope];
    const form = this.form();
    if (!draft) return;
    const language = target.closest<HTMLElement>('[data-settings-locale]')?.dataset.settingsLocale;
    if (language && this.scope === 'user') {
      const locale = language === 'auto' ? 'auto' : normalizeBotLocale(language);
      if (!locale) return;
      this.localePreference = locale;
      draft.dirty = true;
      this.setMessage('', false);
      this.render();
      return;
    }
    if (target.closest('[data-settings-defaults]')) {
      const defaults = resolveBotSettingsValues(form, {});
      if (!defaults.success) { this.setMessage(t('botSettings.invalidResponse'), true); return; }
      draft.values = defaults.values;
      draft.reset = true;
      draft.dirty = true;
      if (this.scope === 'user') {
        this.confirmFileName = true;
        this.localePreference = 'auto';
      }
      this.message = t('botSettings.resetHint');
      this.error = false;
      this.render();
      return;
    }
    if (target.closest('[data-audio-choice-controls], [data-audio-preview-volume-control]')) return;
    const choice = target.closest<HTMLElement>('[data-bot-select-value]');
    if (choice) {
      const name = choice.closest<HTMLElement>('[data-field-name]')?.dataset.fieldName;
      const field = form?.fields.find((entry) => entry.name === name);
      const value = choice.dataset.botSelectValue;
      if (field?.type !== 'select' || value === undefined || !field.choices.some((entry) => entry.value === value)) return;
      draft.values = { ...draft.values, [field.name]: value };
      draft.dirty = true;
      this.render();
      [...(this.root?.querySelectorAll<HTMLElement>('[data-bot-select-value]') ?? [])].find((entry) =>
        entry.dataset.botSelectValue === choice.dataset.botSelectValue &&
        entry.closest<HTMLElement>('[data-field-name]')?.dataset.fieldName === name)?.focus();
      return;
    }
    const action = target.closest<HTMLButtonElement>('button[data-field-action]');
    if (action) {
      const values = applyBotFieldAction(action, form?.fields ?? [], draft.values, this.fieldContext());
      if (values) {
        draft.values = values;
        draft.dirty = true;
        if (this.root) audioPreviewService.prune(this.root);
        this.setMessage('', false);
      }
    }
  };

  private onSubmit = (event: SubmitEvent): void => {
    if (event.target instanceof HTMLFormElement && event.target.id === 'bot-settings-form') {
      event.preventDefault();
      void this.save();
    }
  };

  private async save(): Promise<void> {
    if (this.scope === 'permissions') { await this.savePermissions(); return; }
    const session = this.session;
    const snapshot = this.snapshot;
    const scope = this.scope;
    const draft = this.drafts[scope];
    if (!session || !snapshot || !draft || this.blocked()) return;
    if (!this.isCurrent(session)) { this.close(); return; }
    if (scope === 'server' && !this.canConfigure()) { this.setMessage(t('botSettings.permissionDenied'), true); return; }
    const form = this.form();
    const inputs = convertBotInputValues(form?.fields ?? [], draft.values);
    const resolved = resolveBotSettingsValues(form, inputs);
    if (!resolved.success) {
      this.setMessage(botInputError(form?.fields ?? [], resolved.field, resolved.reason), true);
      const field = [...(this.root?.querySelectorAll<HTMLElement>('[data-field-name]') ?? [])].find((entry) => entry.dataset.fieldName === resolved.field);
      field?.setAttribute('aria-invalid', 'true');
      field?.querySelector<HTMLElement>('input, select, textarea, [tabindex]')?.focus();
      return;
    }
    const defaults = resolveBotSettingsValues(form, {});
    if (!defaults.success) { this.setMessage(t('botSettings.invalidResponse'), true); return; }
    const patch: BotSettingsPatch = {};
    const overrides: BotFormValues = draft.reset ? {} : structuredClone(draft.overrides);
    // Untouched defaults stay implicit; resetting removes overrides instead of pinning today's defaults.
    for (const field of form?.fields ?? []) {
      const value = inputs[field.name];
      if (!draft.reset && sameValue(value, draft.initial[field.name])) continue;
      const reset = value === undefined || (draft.reset && sameValue(value, defaults.values[field.name]));
      patch[field.name] = reset ? null : value;
      if (reset) delete overrides[field.name];
      else overrides[field.name] = value;
    }
    this.saving = true;
    this.message = '';
    this.render();
    try {
      if (scope === 'user') {
        settingsStore.saveBotPreferences(botPreferenceScopeFor(session.client, session.server, snapshot.bot.botId), overrides,
          snapshot.bot.capabilities.downloadsSound ? this.confirmFileName : undefined, this.localePreference);
        this.initializeUserDraft();
        this.setMessage(t('botSettings.savedUser'), false);
      } else {
        if (!snapshot.server) throw new Error(t('botSettings.invalidResponse'));
        const parsed = botSettingsSnapshotSchema.safeParse(await this.request(session, MessageType.BOT_SETTINGS_UPDATE, {
          botId: snapshot.bot.botId, schemaRevision: snapshot.bot.schemaRevision,
          expectedRevision: snapshot.server.revision, patch,
        }));
        if (!this.isCurrent(session)) return;
        if (!parsed.success || parsed.data.bot.botId !== snapshot.bot.botId) throw new Error(t('botSettings.invalidResponse'));
        this.acceptSnapshot(parsed.data, true);
        this.setMessage(t('botSettings.savedServer'), false);
      }
    } catch (error) {
      if (this.isCurrent(session)) this.setMessage(scope === 'user' || !(error instanceof Error)
        ? t('botSettings.saveFailed') : botRequestError(error), true);
    } finally {
      if (this.isCurrent(session)) { this.saving = false; this.render(); }
    }
  }

  private async savePermissions(): Promise<void> {
    const session = this.session;
    const snapshot = this.snapshot;
    if (!session || !snapshot || !this.isCurrent(session) || this.blocked() || !this.canManage()) return;
    const permissions = snapshot.bot.permissions ?? unreviewedBotPermissions();
    if (permissions.requested === null) return;
    this.saving = true;
    this.message = '';
    this.render();
    try {
      const response = botPermissionsSnapshotSchema.parse(await this.request(session, MessageType.BOT_PERMISSIONS_UPDATE, {
        botId: snapshot.bot.botId, expectedRevision: permissions.revision, granted: this.permissionDraft,
      }));
      if (!this.isCurrent(session)) return;
      if (response.botId !== snapshot.bot.botId || this.snapshot?.bot.botId !== snapshot.bot.botId) {
        throw new Error(t('botSettings.invalidResponse'));
      }
      this.snapshot = { ...this.snapshot, bot: { ...this.snapshot.bot, permissions: response.permissions } };
      this.permissionDraft = this.canManage() ? response.permissions.granted.slice() : [];
      this.permissionsStale = false;
      this.refreshAuthorization(false);
      this.message = t('botPermissions.saved');
      this.error = false;
    } catch (error) {
      if (this.isCurrent(session)) this.setMessage(botRequestError(error), true);
    } finally {
      if (this.isCurrent(session)) { this.saving = false; this.render(); }
    }
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.root || event.defaultPrevented) return;
    if ([...document.querySelectorAll('.modal-backdrop')].filter((element) => element.getClientRects().length).at(-1) !== this.root) return;
    if (event.key === 'Escape') { event.preventDefault(); this.close(); return; }
    const target = event.target instanceof Element ? event.target : null;
    const language = target?.closest<HTMLButtonElement>('button[data-settings-locale]');
    if (language && !this.blocked() && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = [...this.root.querySelectorAll<HTMLButtonElement>('[data-settings-locale]')];
      const index = buttons.indexOf(language);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
      return;
    }
    const tab = target?.closest<HTMLButtonElement>('button[data-settings-scope]');
    if (tab && !this.saving && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const tabs = [...this.root.querySelectorAll<HTMLButtonElement>('[data-settings-scope]')];
      const index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next]?.click();
      return;
    }
    const choice = target && this.root.contains(target) ? target.closest<HTMLElement>('[data-bot-select-value]') : null;
    if (choice && !target?.closest('[data-audio-choice-controls], [data-audio-preview-volume-control]') && !this.blocked()) {
      const options = [...(choice.closest('[data-field-name]')?.querySelectorAll<HTMLElement>('[data-bot-select-value]') ?? [])];
      const index = options.indexOf(choice);
      if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(event.key)) {
        event.preventDefault();
        options[(index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length]?.focus();
      } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choice.click(); }
    }
    if (event.key !== 'Tab') return;
    const focusable = [...this.root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')]
      .filter((element) => element.tabIndex >= 0 && !element.closest('fieldset:disabled') && element.getClientRects().length);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (event.shiftKey && (active === first || !active || !focusable.includes(active))) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && (active === last || !active || !focusable.includes(active))) {
      event.preventDefault(); first?.focus();
    }
  };

  public close(): void {
    this.generation++;
    this.sectionNavigation?.destroy();
    this.sectionNavigation = null;
    for (const id of this.pending) this.session?.client.cancelRequest(id);
    this.pending.clear();
    this.unbind.forEach((unbind) => unbind());
    this.unbind = [];
    if (this.root) { audioPreviewService.release(this.root); this.root.remove(); }
    this.root = null;
    this.session = null;
    this.snapshot = null;
    this.selectedBotId = null;
    this.drafts = {};
    this.permissionDraft = [];
    this.permissionsStale = false;
    this.localePreference = 'auto';
    this.bots = [];
    this.loading = this.loadFailed = this.saving = this.schemaStale = this.serverStale = this.userStale = false;
    this.message = '';
    this.error = false;
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
  }
}

export const botSettingsModal = new BotSettingsModal();

export function botSettingsMenuItem(
  botId: string, client = getActiveNetworkClient(), server = getActiveServerStore()
): ContextMenuItem {
  return { label: t('botSettings.title'), icon: 'settings', onClick: botSettingsModal.createOpenAction(botId, client, server) };
}
