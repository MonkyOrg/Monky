import { LIMITS, MAX_SERVER_INVITE_LENGTH, parseServerInviteLink, type VoiceMode } from '@monky/shared';
import { connectionStore, type CreatedServer, type SavedServer } from '../../stores/connectionStore';
import { settingsStore } from '../../stores/settingsStore';
import { t } from '../../i18n';
import { escapeHtml } from '../../utils/html';
import { enterModal, exitModal, handlesModalKey } from '../../utils/modalSurface';
import { cancelModalStep, replaceModalStep } from '../../utils/modalSteps';
import { setSurfaceVisible } from '../../utils/surfaceVisibility';
import { animateEnter, cancelSurfaceMotion } from '../../utils/surfaceMotion';
import { attachCapacityEstimatorEvents, renderCapacityEstimatorHtml, renderWhatPassesWhereTableHtml } from '../../utils/voiceModeInfo';
import { clientLog } from '../../core/ClientLogService';
import { assertServerBrowseAvailable, captureServerBrowseIntent, getServerSessionForAddress, openServerSession, updateSessionAvatar } from '../../core/serverConnection';
import { ensureHostedServerStarted, findOwnedServer } from '../../core/hostedServerStart';
import { checkServerOnline } from '../../utils/serverStatus';
import { showAlert, showConfirm } from '../Dialog';
import { joinInviteModal } from '../JoinInviteModal';
import { onboardingWizard, type WizardExit } from '../OnboardingWizard';

type AddServerScreen = 'choice' | 'join' | 'create';

/** The guide or the hosting tutorials are borrowing this modal's card. */
interface GuideVisit {
  /** Screen to show when the guide hands the card back; `null` closes the modal. */
  returnTo: AddServerScreen | null;
  /** Form kept aside so whatever the user typed is still there on return. */
  parked: { className: string; nodes: ChildNode[] } | null;
  onClosed?: () => void;
}

interface DiscoveredServer {
  host: string;
  port: number;
  serverName: string;
  version: string;
}

class AddServerModal {
  private modalEl: HTMLElement | null = null;
  private screen: AddServerScreen = 'choice';
  private connectionPending = false;
  private isScanningLan = false;
  private lanScanTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly discoveredServers = new Map<string, DiscoveredServer>();
  private readonly unbindLanListeners: Array<() => void> = [];
  private guide: GuideVisit | null = null;

  public open(screen: AddServerScreen = 'choice'): void {
    this.close(true);
    this.screen = screen;
    const modal = this.createBackdrop();
    modal.innerHTML = this.cardMarkup();
    this.bindCard(modal);
    enterModal(modal);
  }

  /**
   * Opens the getting-started guide and continues in the path the user picks.
   * The guide uses this modal's card, so joining or creating continues in the
   * same dialog instead of closing one and opening another.
   */
  public openGuide(onClosed?: () => void): void {
    if (this.guide) return;
    const opening = !this.modalEl;
    const modal = this.modalEl ?? this.createBackdrop();
    this.stopLanDiscovery();
    this.guide = { returnTo: opening ? null : this.screen, parked: null, onClosed };
    onboardingWizard.start(modal, 'guide', (result) => this.leaveGuide(result), opening ? 0 : 1);
    if (opening) enterModal(modal);
  }

  public close(immediate = false): void {
    if (!this.modalEl) return;
    const element = this.modalEl;
    const guide = this.guide;
    this.modalEl = null;
    this.guide = null;
    if (guide) onboardingWizard.stop();
    this.stopLanDiscovery();
    for (const off of this.unbindLanListeners.splice(0)) off();
    document.removeEventListener('keydown', this.handleKeyDown, true);
    exitModal(element, immediate);
    guide?.onClosed?.();
  }

  private createBackdrop(): HTMLElement {
    this.setupLanDiscoveryListeners();
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'add-server-modal';
    modal.addEventListener('mousedown', (event) => {
      if (event.target === modal) this.close();
    });
    document.body.appendChild(modal);
    this.modalEl = modal;
    document.removeEventListener('keydown', this.handleKeyDown, true);
    document.addEventListener('keydown', this.handleKeyDown, true);
    return modal;
  }

  private cardMarkup(): string {
    return `
      <section class="modal-card add-server-card" role="dialog" aria-modal="true" aria-labelledby="add-server-title">
        <header class="modal-header">
          <div class="modal-title" id="add-server-title">
            <span class="material-symbols-outlined" aria-hidden="true">add_circle</span>
            <span>${t('addServer.title')}</span>
          </div>
          <button type="button" class="btn btn-secondary" id="add-server-close" aria-label="${t('common.close')}">×</button>
        </header>
        <div id="add-server-content">
          ${this.renderContent()}
        </div>
      </section>
    `;
  }

  /** `content` holds the card's new children, which sit in a transition panel while a step animates. */
  private bindCard(content: HTMLElement): void {
    this.attachEvents();
    this.setConnectionPending(this.connectionPending);
    content.querySelector<HTMLElement>('button, input')?.focus({ preventScroll: true });
  }

  /** The guide hands the card back: slide to the chosen form, back to where it was opened, or close. */
  private leaveGuide(result: WizardExit): void {
    const guide = this.guide;
    const modal = this.modalEl;
    if (!guide || !modal) return;
    this.guide = null;
    onboardingWizard.stop();
    if (result === 'join' || result === 'host') {
      this.screen = result === 'join' ? 'join' : 'create';
      this.showCard(modal, 1);
    } else if (result === 'leave' && guide.returnTo) {
      this.screen = guide.returnTo;
      if (guide.parked) this.restoreCard(modal, guide.parked);
      else this.showCard(modal, -1);
    } else {
      this.close();
    }
    guide.onClosed?.();
  }

  private showCard(modal: HTMLElement, direction: number): void {
    const holder = document.createElement('div');
    holder.innerHTML = this.cardMarkup();
    const content = replaceModalStep(modal, holder.firstElementChild as HTMLElement, direction);
    modal.querySelector(':scope > .modal-card')?.setAttribute('aria-labelledby', 'add-server-title');
    this.bindCard(content);
  }

  /** Puts the parked form back as it was; its listeners stayed attached to the same nodes. */
  private restoreCard(modal: HTMLElement, parked: NonNullable<GuideVisit['parked']>): void {
    const card = document.createElement('section');
    card.className = parked.className;
    card.append(...parked.nodes);
    const content = replaceModalStep(modal, card, -1);
    modal.querySelector(':scope > .modal-card')?.setAttribute('aria-labelledby', 'add-server-title');
    this.setConnectionPending(this.connectionPending);
    content.querySelector<HTMLElement>('#add-server-open-tutorials')?.focus({ preventScroll: true });
  }

  private openHostTutorials(): void {
    const modal = this.modalEl;
    if (!modal || this.guide) return;
    // Settle any running step so the card holds the real form nodes, not transition panels.
    cancelModalStep(modal);
    const card = modal.querySelector<HTMLElement>(':scope > .modal-card');
    if (!card) return;
    this.guide = { returnTo: this.screen, parked: { className: card.className, nodes: [...card.childNodes] } };
    onboardingWizard.start(modal, 'host-tutorials', (result) => this.leaveGuide(result));
  }

  private renderContent(): string {
    if (this.screen === 'join') return this.renderJoin();
    if (this.screen === 'create') return this.renderCreate();
    return `
      <div class="add-server-choice-grid">
        <button type="button" class="add-server-option" id="add-server-option-create">
          <span class="material-symbols-outlined" aria-hidden="true">dns</span>
          <strong>${t('addServer.createTitle')}</strong>
          <small>${t('addServer.createDesc')}</small>
        </button>
        <button type="button" class="add-server-option" id="add-server-option-join">
          <span class="material-symbols-outlined" aria-hidden="true">login</span>
          <strong>${t('addServer.joinTitle')}</strong>
          <small>${t('addServer.joinDesc')}</small>
        </button>
      </div>
      <div class="add-server-guide-row">
        <button type="button" class="btn btn-secondary" id="add-server-open-guide">${t('onboarding.helpButton')}</button>
      </div>
    `;
  }

  private renderJoin(): string {
    return `
      <form id="add-server-join-form" class="add-server-form">
        <button type="button" class="btn btn-secondary add-server-back" id="add-server-join-back">
          <span class="material-symbols-outlined md-16" aria-hidden="true">arrow_back</span>
          ${t('common.back')}
        </button>
        <div class="form-group">
          <label for="add-server-invite">${t('invite.pasteLabel')}</label>
          <div class="add-server-inline-row">
            <input id="add-server-invite" type="text" maxlength="${MAX_SERVER_INVITE_LENGTH}" autocomplete="off" spellcheck="false"
              placeholder="${t('invite.pastePlaceholder')}">
            <button id="add-server-review-invite" type="button" class="btn btn-secondary">${t('invite.reviewButton')}</button>
          </div>
          <small>${t('invite.pasteHint')}</small>
        </div>
        <div id="add-server-lan-section">${this.renderLanSection()}</div>
        <div class="form-row">
          <div class="form-group" style="flex: 2;">
            <label for="add-server-host">${t('connection.hostLabel')}</label>
            <input id="add-server-host" type="text" placeholder="${t('connection.hostPlaceholder')}" value="127.0.0.1" required>
          </div>
          <div class="form-group small-col">
            <label for="add-server-port">${t('connection.portLabel')}</label>
            <input id="add-server-port" type="number" placeholder="3000" value="3000" required min="1024" max="65535">
          </div>
        </div>
        <div class="form-group">
          <label for="add-server-password">${t('connection.passwordLabel')}</label>
          <input id="add-server-password" type="password" placeholder="••••••••">
        </div>
        <div class="modal-footer">
          <button type="submit" id="add-server-submit-join" class="btn btn-primary">
            <span class="material-symbols-outlined md-18" aria-hidden="true">login</span>
            ${t('connection.join')}
          </button>
        </div>
      </form>
    `;
  }

  private renderCreate(): string {
    return `
      <form id="add-server-create-form" class="add-server-form">
        <button type="button" class="btn btn-secondary add-server-back" id="add-server-create-back">
          <span class="material-symbols-outlined md-16" aria-hidden="true">arrow_back</span>
          ${t('common.back')}
        </button>
        <div class="add-server-tutorial-callout">
          <span class="material-symbols-outlined md-20" aria-hidden="true">school</span>
          <div>
            <strong>${t('addServer.tutorialsTitle')}</strong>
            <p>${t('addServer.tutorialsDesc')}</p>
          </div>
          <button type="button" class="btn btn-secondary" id="add-server-open-tutorials">${t('addServer.openTutorials')}</button>
        </div>
        <div class="form-group">
          <label for="add-server-name">${t('connection.serverNameLabel')}</label>
          <input id="add-server-name" type="text" placeholder="${t('connection.serverNamePlaceholder')}" value="${t('connection.serverNameDefault')}" required minlength="2" maxlength="50">
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="add-server-local-port">${t('connection.localPortLabel')}</label>
            <input id="add-server-local-port" type="number" value="3000" required min="1024" max="65535">
          </div>
          <div class="form-group">
            <label for="add-server-access-password">${t('connection.accessPasswordLabel')}</label>
            <input id="add-server-access-password" type="password" placeholder="${t('connection.optional')}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="add-server-text-channel">${t('connection.textChannelLabel')}</label>
            <input id="add-server-text-channel" type="text" value="geral" required>
          </div>
          <div class="form-group">
            <label for="add-server-voice-channel">${t('connection.voiceChannelLabel')}</label>
            <input id="add-server-voice-channel" type="text" value="Geral" required>
          </div>
        </div>
        <div class="form-group">
          <div class="channel-privacy-row add-server-switch-row">
            <div class="channel-privacy-info">
              <span class="channel-privacy-title">${t('connection.memberLimitLabel')}</span>
              <span class="channel-privacy-desc">${t('connection.memberLimitDesc')}</span>
            </div>
            <label class="toggle-switch" aria-label="${t('connection.memberLimitLabel')}">
              <input id="add-server-limit-members" type="checkbox" role="switch">
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="form-group" id="add-server-max-users-group" hidden>
          <label for="add-server-max-users">${t('connection.memberLimitValueLabel')}</label>
          <input id="add-server-max-users" type="number" min="1" step="1" value="20">
        </div>
        <div class="form-group add-server-voice-mode">
          <div class="add-server-field-title">
            <span class="material-symbols-outlined md-18" aria-hidden="true">hub</span>
            <span>${t('serverSettings.voiceModeLabel')}</span>
          </div>
          <p>${t('serverSettings.voiceModeDesc')}</p>
          <div class="add-server-choice-row" id="add-server-voice-mode-cards">
            ${this.renderVoiceModeCard('p2p', true)}
            ${this.renderVoiceModeCard('sfu', false)}
          </div>
          <input type="hidden" id="add-server-voice-mode" value="p2p">
          ${renderWhatPassesWhereTableHtml()}
          ${renderCapacityEstimatorHtml('add-server')}
        </div>
        <div class="modal-footer">
          <button type="submit" id="add-server-submit-create" class="btn btn-primary">
            <span class="material-symbols-outlined md-18" aria-hidden="true">add_circle</span>
            ${t('connection.createAndStart')}
          </button>
        </div>
      </form>
    `;
  }

  private renderVoiceModeCard(mode: VoiceMode, selected: boolean): string {
    const isP2p = mode === 'p2p';
    return `
      <button type="button" class="voice-mode-card ${selected ? 'selected' : ''}" data-mode="${mode}" aria-pressed="${selected}">
        <span class="material-symbols-outlined md-18" aria-hidden="true">${isP2p ? 'wifi_tethering' : 'hub'}</span>
        <strong>${t(isP2p ? 'serverSettings.voiceModeP2pTitle' : 'serverSettings.voiceModeSfuTitle')}</strong>
        <small>${t(isP2p ? 'serverSettings.voiceModeP2pDesc' : 'serverSettings.voiceModeSfuDesc')}</small>
      </button>
    `;
  }

  private renderLanSection(): string {
    const servers = Array.from(this.discoveredServers.values()).sort((a, b) =>
      a.serverName.localeCompare(b.serverName) || a.host.localeCompare(b.host) || a.port - b.port);
    return `
      <section class="add-server-lan-list" aria-labelledby="add-server-lan-heading">
        <div class="add-server-section-heading">
          <span id="add-server-lan-heading">${t('connection.lanServersCount', { count: servers.length })}</span>
          <button type="button" id="add-server-scan-lan" class="btn btn-secondary" ${this.isScanningLan ? 'disabled' : ''}>
            <span class="material-symbols-outlined md-14" aria-hidden="true">radar</span>
            ${this.isScanningLan ? t('connection.scanning') : t('connection.scan')}
          </button>
        </div>
        ${servers.length ? servers.map(server => `
          <div class="add-server-lan-item">
            <div>
              <strong>${escapeHtml(server.serverName)}</strong>
              <span>${escapeHtml(server.host)}:${server.port} • v${escapeHtml(server.version)}</span>
            </div>
            <button type="button" class="btn btn-primary add-server-use-lan" data-host="${escapeHtml(server.host)}" data-port="${server.port}">
              ${t('connection.join')}
            </button>
          </div>
        `).join('') : `
          <div class="add-server-lan-empty">${t('connection.scanHint', { button: t('connection.scan') })}</div>
        `}
      </section>
    `;
  }

  private attachEvents(): void {
    if (!this.modalEl) return;
    this.modalEl.querySelector('#add-server-close')?.addEventListener('click', () => this.close());
    this.modalEl.querySelector('#add-server-option-create')?.addEventListener('click', () => this.switchScreen('create'));
    this.modalEl.querySelector('#add-server-option-join')?.addEventListener('click', () => this.switchScreen('join'));
    this.modalEl.querySelector('#add-server-join-back')?.addEventListener('click', () => this.switchScreen('choice'));
    this.modalEl.querySelector('#add-server-create-back')?.addEventListener('click', () => this.switchScreen('choice'));
    this.modalEl.querySelector('#add-server-open-tutorials')?.addEventListener('click', () => this.openHostTutorials());
    this.modalEl.querySelector('#add-server-open-guide')?.addEventListener('click', () => this.openGuide());
    this.attachJoinEvents();
    this.attachCreateEvents();
  }

  private attachJoinEvents(): void {
    if (!this.modalEl || this.screen !== 'join') return;
    const invitation = this.modalEl.querySelector<HTMLInputElement>('#add-server-invite');
    const reviewInvite = () => { if (invitation) void this.reviewInviteLink(invitation.value); };
    this.modalEl.querySelector('#add-server-review-invite')?.addEventListener('click', reviewInvite);
    invitation?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      reviewInvite();
    });
    this.modalEl.querySelector<HTMLFormElement>('#add-server-join-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await this.submitJoin();
    });
    this.attachLanEvents();
  }

  private attachCreateEvents(): void {
    if (!this.modalEl || this.screen !== 'create') return;
    const limitToggle = this.modalEl.querySelector<HTMLInputElement>('#add-server-limit-members');
    const limitGroup = this.modalEl.querySelector<HTMLElement>('#add-server-max-users-group');
    limitToggle?.addEventListener('change', () => {
      if (limitGroup) setSurfaceVisible(limitGroup, limitToggle.checked);
    });
    const modeInput = this.modalEl.querySelector<HTMLInputElement>('#add-server-voice-mode');
    this.modalEl.querySelectorAll<HTMLButtonElement>('#add-server-voice-mode-cards .voice-mode-card').forEach((card) => {
      card.addEventListener('click', () => {
        const mode = card.dataset.mode as VoiceMode | undefined;
        if (!mode) return;
        if (modeInput) modeInput.value = mode;
        this.modalEl?.querySelectorAll<HTMLButtonElement>('#add-server-voice-mode-cards .voice-mode-card').forEach((item) => {
          const selected = item.dataset.mode === mode;
          item.classList.toggle('selected', selected);
          item.setAttribute('aria-pressed', String(selected));
        });
      });
    });
    attachCapacityEstimatorEvents(this.modalEl, 'add-server');
    this.modalEl.querySelector<HTMLFormElement>('#add-server-create-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await this.submitCreate();
    });
  }

  private attachLanEvents(): void {
    if (!this.modalEl) return;
    this.modalEl.querySelector('#add-server-scan-lan')?.addEventListener('click', async () => {
      if (this.isScanningLan) return;
      this.isScanningLan = true;
      this.discoveredServers.clear();
      this.renderLanSectionIntoDom();
      await window.api?.startLanDiscovery?.();
      this.lanScanTimeout = setTimeout(() => {
        this.isScanningLan = false;
        this.lanScanTimeout = null;
        void window.api?.stopLanDiscovery?.();
        this.renderLanSectionIntoDom();
      }, 5000);
    });
    this.modalEl.querySelectorAll<HTMLButtonElement>('.add-server-use-lan').forEach((button) => {
      button.addEventListener('click', () => {
        const host = button.dataset.host;
        const port = button.dataset.port;
        const hostInput = this.modalEl?.querySelector<HTMLInputElement>('#add-server-host');
        const portInput = this.modalEl?.querySelector<HTMLInputElement>('#add-server-port');
        if (!host || !port || !hostInput || !portInput) return;
        hostInput.value = host;
        portInput.value = port;
        this.modalEl?.querySelector<HTMLFormElement>('#add-server-join-form')?.requestSubmit();
      });
    });
  }

  private switchScreen(screen: AddServerScreen): void {
    this.screen = screen;
    if (screen !== 'join') this.stopLanDiscovery();
    if (!this.modalEl) return;
    const content = this.modalEl.querySelector<HTMLElement>('#add-server-content');
    if (!content) return;
    cancelSurfaceMotion(content);
    content.innerHTML = this.renderContent();
    animateEnter(content, 'panel');
    this.attachEvents();
  }

  private async submitJoin(): Promise<void> {
    if (!this.modalEl || this.connectionPending) return;
    this.hideError();
    const invitation = this.modalEl.querySelector<HTMLInputElement>('#add-server-invite')?.value.trim();
    if (invitation) {
      await this.reviewInviteLink(invitation);
      return;
    }
    const host = this.modalEl.querySelector<HTMLInputElement>('#add-server-host')?.value.trim() ?? '';
    const port = Number(this.modalEl.querySelector<HTMLInputElement>('#add-server-port')?.value ?? 0);
    const password = this.modalEl.querySelector<HTMLInputElement>('#add-server-password')?.value || undefined;
    await this.openAndSaveServer(host, port, password);
  }

  private async submitCreate(): Promise<void> {
    if (!this.modalEl || this.connectionPending) return;
    this.hideError();
    const serverName = this.modalEl.querySelector<HTMLInputElement>('#add-server-name')?.value.trim() ?? '';
    const port = Number(this.modalEl.querySelector<HTMLInputElement>('#add-server-local-port')?.value ?? 0);
    const password = this.modalEl.querySelector<HTMLInputElement>('#add-server-access-password')?.value || undefined;
    const textChannel = this.modalEl.querySelector<HTMLInputElement>('#add-server-text-channel')?.value.trim() ?? '';
    const voiceChannel = this.modalEl.querySelector<HTMLInputElement>('#add-server-voice-channel')?.value.trim() ?? '';
    const wantsLimit = this.modalEl.querySelector<HTMLInputElement>('#add-server-limit-members')?.checked ?? false;
    const rawLimit = Number(this.modalEl.querySelector<HTMLInputElement>('#add-server-max-users')?.value ?? 0);
    if (!serverName || !port || !textChannel || !voiceChannel) {
      this.showError(t('connection.createServerError'));
      return;
    }
    if (wantsLimit && (!Number.isFinite(rawLimit) || rawLimit < 1)) {
      this.showError(t('connection.memberLimitInvalid'));
      return;
    }
    const now = Date.now();
    const existing = connectionStore.createdServers.find((server) =>
      server.name === serverName && server.port === port && (server.password || '') === (password || '')
      && server.textChannel === textChannel && server.voiceChannel === voiceChannel);
    const createdServer: CreatedServer = {
      id: existing?.id || `created-${now}-${Math.random().toString(36).slice(2, 8)}`,
      name: serverName,
      port,
      password,
      textChannel,
      voiceChannel,
      createdAt: existing?.createdAt || now,
      lastStarted: now,
      maxUsers: wantsLimit ? rawLimit : LIMITS.MAX_USERS_UNLIMITED,
      voiceMode: (this.modalEl.querySelector<HTMLInputElement>('#add-server-voice-mode')?.value as VoiceMode | undefined) ?? 'p2p',
    };
    this.setConnectionPending(true);
    try {
      await ensureHostedServerStarted(createdServer);
      await this.openAndSaveServer('127.0.0.1', port, password);
    } catch (error: unknown) {
      clientLog.warn('SERVER_HOST', 'Could not create the local server from the add-server modal', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.showError(error instanceof Error && error.message ? error.message : t('connection.createServerError'));
    } finally {
      this.setConnectionPending(false);
    }
  }

  private async openAndSaveServer(host: string, port: number, password?: string): Promise<void> {
    if (!this.modalEl || this.connectionPending && this.screen === 'join') return;
    const nickname = connectionStore.savedNickname.trim();
    if (!nickname) {
      this.showError(t('protocolError.nicknameInvalid'));
      return;
    }
    this.setConnectionPending(true);
    const isCurrent = captureServerBrowseIntent();
    try {
      assertServerBrowseAvailable(host, port);
      const owned = findOwnedServer(host, port);
      const connected = getServerSessionForAddress(host, port)?.client.getStatus() === 'CONNECTED';
      if (owned && !connected && !(await checkServerOnline(host, port))) {
        const confirmed = await showConfirm({
          title: t('main.serverOfflineStartTitle'),
          message: t('main.serverOfflineStartMessage', { name: owned.name }),
          confirmLabel: t('main.serverOfflineStartConfirm'),
          variant: 'warning',
        });
        if (!confirmed || !isCurrent()) return;
        await ensureHostedServerStarted(owned);
      }
      const identity = connectionStore.hasIdentity && connectionStore.clientId && connectionStore.publicKey
        ? { clientId: connectionStore.clientId, publicKey: connectionStore.publicKey }
        : await window.api.getIdentity();
      if (!isCurrent()) return;
      connectionStore.setIdentity(identity);
      const result = await openServerSession(host, port, identity, nickname, password);
      const savedServer: SavedServer = {
        host,
        port,
        name: result.server.name,
        serverId: result.server.id,
        password: password || undefined,
        lastConnected: Date.now(),
      };
      connectionStore.addSavedServer(savedServer);
      const avatar = connectionStore.savedAvatarBase64;
      if (avatar) await updateSessionAvatar(host, port, avatar);
      await window.api?.maximize?.();
      this.close();
    } catch (error: unknown) {
      clientLog.warn('CONNECTION', 'Could not join the server from the add-server modal', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.showError(error instanceof Error && error.message ? error.message : t('connection.connectError'));
    } finally {
      this.setConnectionPending(false);
      await window.api?.stopLanDiscovery?.();
    }
  }

  private async reviewInviteLink(value: string): Promise<void> {
    const parsed = parseServerInviteLink(value.trim());
    if (!parsed.ok) {
      this.showError(t('invite.invalidLink'));
      return;
    }
    try {
      await joinInviteModal.open(parsed.invite);
      this.close();
    } catch (error: unknown) {
      clientLog.warn('CONNECTION', 'Could not open the pasted invitation from the add-server modal', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.showError(t('invite.readFailed'));
    }
  }

  private setupLanDiscoveryListeners(): void {
    for (const off of this.unbindLanListeners.splice(0)) off();
    const found = window.api?.onLanDiscoveryFound?.((server) => {
      this.discoveredServers.set(`${server.host}:${server.port}`, server);
      this.renderLanSectionIntoDom();
    });
    const lost = window.api?.onLanDiscoveryLost?.((server) => {
      this.discoveredServers.delete(`${server.host}:${server.port}`);
      this.renderLanSectionIntoDom();
    });
    if (found) this.unbindLanListeners.push(found);
    if (lost) this.unbindLanListeners.push(lost);
  }

  private renderLanSectionIntoDom(): void {
    const section = this.modalEl?.querySelector<HTMLElement>('#add-server-lan-section');
    if (!section) return;
    section.innerHTML = this.renderLanSection();
    this.attachLanEvents();
  }

  private stopLanDiscovery(): void {
    if (this.lanScanTimeout) clearTimeout(this.lanScanTimeout);
    this.lanScanTimeout = null;
    this.isScanningLan = false;
    this.discoveredServers.clear();
    void window.api?.stopLanDiscovery?.();
  }

  private setConnectionPending(pending: boolean): void {
    this.connectionPending = pending;
    this.modalEl?.querySelectorAll<HTMLButtonElement>('button').forEach(button => {
      if (button.id !== 'add-server-close') button.disabled = pending;
    });
  }

  private showError(message: string): void {
    void showAlert({ title: t('common.error'), message, variant: 'danger' });
  }

  private hideError(): void {
    const error = this.modalEl?.querySelector<HTMLElement>('#add-server-error');
    if (!error) return;
    error.textContent = '';
    error.hidden = true;
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (!handlesModalKey(this.modalEl, event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close();
    }
  };
}

export const addServerModal = new AddServerModal();
