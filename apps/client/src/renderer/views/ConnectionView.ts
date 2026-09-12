import { escapeHtml } from '../utils/html';
import { LIMITS, MessageType } from '@monky/shared';
import { connectionStore, type CreatedServer, type SavedServer } from '../stores/connectionStore';
import { favoritesStore, savedServerFavoriteKey } from '../stores/favoritesStore';
import {
  assertServerBrowseAvailable, captureServerBrowseIntent, getServerSessionForAddress, openServerSession,
} from '../core/serverConnection';
import { ensureHostedServerStarted, findOwnedServer } from '../core/hostedServerStart';
import { clientLog } from '../core/ClientLogService';
import { getAvatarUrl } from '../utils/avatar';
import { settingsModal } from './SettingsModal';
import { settingsStore } from '../stores/settingsStore';
import { withButtonLoading } from '../utils/buttonLoading';
import { showAlert, showConfirm } from './Dialog';
import { pickAndCropImage } from './ImageCropModal';
import { showIdentityImportDialog } from './IdentityDialogs';
import { serverMonitorModal } from './ServerMonitorModal';
import { confirmStopHostedServer } from '../utils/hostedServer';
import { checkServerOnline } from '../utils/serverStatus';
import { sortFavoritesFirst, type FavoriteOrderEntry } from '../utils/favoriteOrder';
import { FavoriteListMotion, type FavoriteMotionKind } from '../utils/favoriteMotion';
import { renderFavoriteToggle, renderFavoritesFilter, updateFavoritesFilter } from './FavoritesControls';
import { onboardingWizard } from './OnboardingWizard';
import logoUrl from '../assets/Logo.png';
import { getLanguage, t } from '../i18n';
import {
  renderWhatPassesWhereTableHtml,
  renderCapacityEstimatorHtml,
  attachCapacityEstimatorEvents,
} from '../utils/voiceModeInfo';

interface DiscoveredServer {
  host: string;
  port: number;
  serverName: string;
  version: string;
}

export class ConnectionView {
  private container: HTMLElement;
  private activeTab: 'join' | 'host' = 'join';
  private selectedAvatarBase64: string = '';
  private selectedSavedHost: string | null = null;
  private selectedSavedPort: number | null = null;
  private isHostedServerRunning: boolean = false;
  private runningCreatedServerId: string | null = null;
  private runningHostedPort: number | null = null;
  private readonly discoveredServers: Map<string, DiscoveredServer> = new Map();
  private onboardingAutoOpened: boolean = false;
  private contentResizeObserver: ResizeObserver | null = null;
  private savedFavoritesOnly = false;
  private connectionPending = false;
  private readonly savedFavoriteMotion = new FavoriteListMotion();

  constructor(container: HTMLElement) {
    this.container = container;
    connectionStore.loadUserProfile();
    connectionStore.loadSavedServers();
    connectionStore.loadCreatedServers();
    this.selectedAvatarBase64 = connectionStore.savedAvatarBase64 || '';
    this.setupLanDiscoveryListeners();
    this.setupHostedServerListener();
    void this.syncHostedServerStatus();
  }

  /**
   * Keeps the hosted server state fresh even while another screen is up. It
   * used to be polled only when this view painted, so a server started from the
   * server rail while connected elsewhere was still shown as stopped once the
   * user came back (#333).
   */
  private setupHostedServerListener(): void {
    window.api?.onHostServerStatusChanged?.((status) => {
      this.applyHostedServerStatus(status);
      // Repainting while the main screen is up would drop the user back on the
      // connection screen mid-session.
      if (this.container.querySelector('.connection-layout') && !this.connectionPending) {
        this.render();
      }
    });
  }

  private applyHostedServerStatus(status: { isRunning: boolean; port: number | null; serverId: string | null }): void {
    this.isHostedServerRunning = !!status.isRunning;
    this.runningHostedPort = this.isHostedServerRunning ? status.port : null;
    this.runningCreatedServerId = this.isHostedServerRunning
      ? this.resolveRunningCreatedServerId(status.serverId, status.port)
      : null;
  }

  private async syncHostedServerStatus(): Promise<void> {
    if (!window.api?.hostServerStatus) return;

    try {
      const status = await window.api.hostServerStatus();
      this.applyHostedServerStatus(status);
    } catch (error: unknown) {
      clientLog.warn('SERVER_HOST', 'Could not refresh hosted server status', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.isHostedServerRunning = false;
      this.runningCreatedServerId = null;
      this.runningHostedPort = null;
    }
  }

  /** True when this entry of "Meus Servidores" is the instance currently up (#333). */
  private isCreatedServerRunning(server: CreatedServer): boolean {
    if (!this.isHostedServerRunning) return false;
    if (this.runningCreatedServerId === server.id) return true;
    // Only one hosted server runs at a time, so a port match is conclusive even
    // when whoever started it never reported which entry it came from.
    return this.runningHostedPort !== null && this.runningHostedPort === server.port;
  }

  /**
   * Maps the running instance back to an entry of "Meus Servidores". Falls back
   * to the port because only one hosted server runs at a time, which also covers
   * instances started before the id was reported (#333).
   */
  private resolveRunningCreatedServerId(serverId: string | null, port: number | null): string | null {
    const createdServers = connectionStore.createdServers || [];
    if (serverId && createdServers.some((server) => server.id === serverId)) {
      return serverId;
    }
    if (port !== null) {
      return createdServers.find((server) => server.port === port)?.id ?? null;
    }
    return null;
  }

  /**
   * Re-reads the hosted server state and repaints only when it actually moved,
   * so returning to this screen never shows a stale "Iniciar" on a server that
   * is already up (#333). The change guard keeps it from looping.
   */
  private async refreshHostedServerStatus(): Promise<void> {
    const wasRunning = this.isHostedServerRunning;
    const previousId = this.runningCreatedServerId;
    const previousPort = this.runningHostedPort;
    await this.syncHostedServerStatus();
    const changed =
      wasRunning !== this.isHostedServerRunning ||
      previousId !== this.runningCreatedServerId ||
      previousPort !== this.runningHostedPort;
    if (changed && this.container.querySelector('.connection-layout') && !this.connectionPending) {
      this.render();
    }
  }

  private formatDateTime(timestamp: number): string {
    if (!timestamp) return t('connection.neverStarted');

    try {
      return new Intl.DateTimeFormat(getLanguage(), {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(timestamp);
    } catch {
      return new Date(timestamp).toLocaleString(getLanguage());
    }
  }

  private createCreatedServerId(): string {
    return `created-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private getHostNicknameValue(): string {
    const input = document.getElementById('host-nickname') as HTMLInputElement | null;
    return (input?.value || connectionStore.savedNickname || '').trim();
  }

  private getCreatedServersSectionHtml(createdServers: CreatedServer[]): string {
    if (createdServers.length === 0) {
      return `
        <div class="saved-servers-container" style="margin-bottom: 14px;">
          <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; display: flex; align-items: center; gap: 4px;">
            <span class="material-symbols-outlined md-14" style="color: var(--accent-primary);">dns</span>
            ${t('connection.createdServers')}
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45;">
            ${t('connection.noCreatedServers')}
          </div>
        </div>
      `;
    }

    return `
      <div class="saved-servers-container" style="margin-bottom: 14px;">
        <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
          <span style="display: flex; align-items: center; gap: 4px;">
            <span class="material-symbols-outlined md-14" style="color: var(--accent-primary);">dns</span>
            ${t('connection.createdServersCount', { count: createdServers.length, max: 10 })}
          </span>
          <span style="font-size: 10px; font-weight: normal; color: var(--text-muted);">${t('connection.createdServersHint')}</span>
        </div>
        <div class="saved-servers-list" style="max-height: 220px;">
          ${createdServers.map((server) => {
            const isRunning = this.isCreatedServerRunning(server);
            return `
              <div class="saved-server-item" style="cursor: default;" data-created-server-id="${escapeHtml(server.id)}">
                <div style="display: flex; flex-direction: column; overflow: hidden; min-width: 0;">
                  <span style="font-size: 13px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px;">
                    <span class="material-symbols-outlined md-16" style="color: ${isRunning ? 'var(--success)' : 'var(--accent-primary)'};">${isRunning ? 'radio_button_checked' : 'storage'}</span>
                    ${escapeHtml(server.name)}
                  </span>
                  <span style="font-size: 11px; color: var(--text-muted); margin-left: 22px;">${t('connection.portLabelValue', { port: server.port })}${server.password ? ` • ${t('connection.withPassword')}` : ` • ${t('connection.withoutPassword')}`}</span>
                  <span style="font-size: 11px; color: var(--text-muted); margin-left: 22px;">#${escapeHtml(server.textChannel)} • ${escapeHtml(server.voiceChannel)}</span>
                  <span style="font-size: 10px; color: ${isRunning ? 'var(--success)' : 'var(--text-muted)'}; margin-left: 22px; margin-top: 4px;">
                    ${isRunning ? t('connection.serverRunning') : t('connection.lastStarted', { date: escapeHtml(this.formatDateTime(server.lastStarted)) })}
                  </span>
                </div>
                <div style="display: flex; gap: 6px; align-items: center; margin-left: 10px; flex-shrink: 0;">
                  ${
                    isRunning
                      ? `
                        <button type="button" class="btn btn-secondary btn-monitor-created-server" data-created-server-id="${escapeHtml(server.id)}" title="${t('serverMonitor.title')}" style="padding: 2px 8px; font-size: 11px; height: 28px;">
                          <span class="material-symbols-outlined md-16">monitoring</span>
                        </button>
                        <button type="button" class="btn btn-danger btn-stop-created-server" data-created-server-id="${escapeHtml(server.id)}" style="padding: 2px 10px; font-size: 11px; height: 28px;">
                          ${t('connection.stop')}
                        </button>
                      `
                      : `
                        <button type="button" class="btn btn-start-created-server" data-created-server-id="${escapeHtml(server.id)}" style="padding: 2px 10px; font-size: 11px; height: 28px; background: var(--success); color: #fff; border: 1px solid var(--success);">
                          ${t('connection.start')}
                        </button>
                      `
                  }
                  <button type="button" class="btn-delete-saved-srv btn-remove-created-server" data-created-server-id="${escapeHtml(server.id)}" title="${t('connection.deleteSavedServer')}" style="color: var(--danger); background: rgba(242, 63, 67, 0.12);">
                    <span class="material-symbols-outlined md-16">close</span>
                  </button>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  public render(): void {
    this.savedFavoriteMotion.cancel();
    const savedNick = connectionStore.savedNickname || '';
    const savedServers = sortFavoritesFirst(connectionStore.savedServers || [], server => this.savedServerOrder(server), getLanguage());
    const createdServers = connectionStore.createdServers || [];
    // Keep the password field in sync with the currently selected saved server (#308)
    const selectedSaved = savedServers.find(
      (s) => s.host === this.selectedSavedHost && s.port === this.selectedSavedPort
    );

    this.container.innerHTML = `
      <div class="connection-layout">
        <div class="connection-card">
          
          <button id="btn-open-settings" class="btn btn-secondary" title="${t('connection.settingsTitle')}" style="position: absolute; top: 12px; right: 12px; padding: 6px 8px; z-index: 2;">
            <span class="material-symbols-outlined md-18">settings</span>
          </button>

          <div class="brand-header" style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; margin-bottom: 16px;">
            <img src="${logoUrl}" alt="Monky Logo" style="width: 200px; max-width: 70%; height: auto; max-height: 80px; object-fit: contain; filter: drop-shadow(0 4px 16px rgba(88, 101, 242, 0.4));">
            <div class="brand-logo" style="display: flex; align-items: center; justify-content: center; gap: 8px;">
              <span style="font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">Monky</span>
              <span class="brand-badge" style="font-size: 11px; padding: 2px 8px;">${t('connection.brandBadge')}</span>
            </div>
            <div class="brand-tagline" style="font-size: 12px; color: var(--text-secondary); margin-top: 2px;">${t('connection.tagline')}</div>
          </div>

          <!-- Onboarding help button -->
          <button class="onboarding-help-btn" id="btn-onboarding">
            ${t('onboarding.helpButton')}
          </button>

          <div class="nav-tabs" style="margin-bottom: 14px;">
            <button id="tab-join" class="tab-button ${this.activeTab === 'join' ? 'active' : ''}">${t('connection.tabJoin')}</button>
            <button id="tab-host" class="tab-button ${this.activeTab === 'host' ? 'active' : ''}">${t('connection.tabHost')}</button>
          </div>

          <div id="error-banner" class="error-banner"></div>

          <!-- Avatar Picker -->
          <div class="avatar-picker" style="margin-bottom: 14px; gap: 12px;">
            <img id="avatar-preview" class="avatar-preview-img" style="width: 46px; height: 46px;" src="${getAvatarUrl(this.selectedAvatarBase64)}" data-fallback="avatar">
            <div>
              <button id="btn-select-avatar" class="btn btn-secondary" style="padding: 5px 10px; font-size: 11px;">
                <span class="material-symbols-outlined md-14" style="margin-right: 4px;">photo_camera</span>
                ${t('connection.choosePhoto')}
              </button>
              <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">${t('connection.photoHint')}</div>
            </div>
          </div>

          <!-- Tab 1: Join Server -->
          <form id="form-join" style="display: ${this.activeTab === 'join' ? 'block' : 'none'};">
            <div id="lan-discovery-section">
              ${this.getDiscoveredServersSectionHtml()}
            </div>

            ${
              !connectionStore.hasIdentity
                ? `
              <div style="margin-bottom: 14px; padding: 12px; border: 1px solid rgba(88, 101, 242, 0.35); border-radius: var(--radius-md); background: rgba(88, 101, 242, 0.08);">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px; color: var(--text-primary); font-weight: 600;">
                  <span class="material-symbols-outlined md-18" style="color: var(--accent-primary);">manage_accounts</span>
                  ${t('identity.firstLaunchTitle')}
                </div>
                <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin-bottom: 10px;">
                  ${t('identity.firstLaunchHint')}
                </div>
                <button type="button" id="btn-import-existing-identity" class="btn btn-secondary" style="font-size: 12px;">
                  <span class="material-symbols-outlined md-16" style="margin-right: 4px;">qr_code_scanner</span>
                  ${t('identity.importAction')}
                </button>
              </div>
            `
                : ''
            }

            ${savedServers.length > 0 || this.savedFavoritesOnly ? `
              <div id="home-saved-servers" class="saved-servers-container">
                <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                  <span style="display: flex; align-items: center; gap: 4px;">
                    <span class="material-symbols-outlined md-14" style="color: var(--accent-primary);">bookmark</span>
                    ${t('connection.savedServersCount', { count: savedServers.length })}
                  </span>
                  <span style="font-size: 10px; font-weight: normal; color: var(--text-muted);">${t('connection.clickToSelect')}</span>
                </div>
                <div style="margin-bottom: 8px;">${renderFavoritesFilter('home-saved-filter', this.savedFavoritesOnly)}</div>
                <div class="saved-servers-list">
                  ${savedServers.map((s) => {
                    const isSelected = this.selectedSavedHost === s.host && this.selectedSavedPort === s.port;
                    return `
                      <div class="saved-server-item ${isSelected ? 'selected' : ''}" data-host="${escapeHtml(s.host)}" data-port="${s.port}" data-password="${escapeHtml(s.password || '')}">
                        <div style="display: flex; flex-direction: column; overflow: hidden; pointer-events: none;">
                          <span style="font-size: 13px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px;">
                            <span class="server-status-dot" data-status="checking" data-host="${escapeHtml(s.host)}" data-port="${s.port}" title="${t('connection.checkingStatus')}"></span>
                            <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">dns</span>
                            ${escapeHtml(s.name || t('connection.serverFallbackName'))}
                          </span>
                          <span style="font-size: 11px; color: var(--text-muted); margin-left: 22px;">${escapeHtml(s.host)}:${s.port}</span>
                          <div class="saved-server-preview" data-host="${escapeHtml(s.host)}" data-port="${s.port}" style="margin-left: 22px; margin-top: 4px;"></div>
                        </div>
                        <div style="display: flex; gap: 6px; align-items: center;">
                          ${renderFavoriteToggle(savedServerFavoriteKey(s), s.name || s.host, favoritesStore.isServerFavorite(s))}
                          <button type="button" class="btn btn-secondary btn-select-saved" data-host="${escapeHtml(s.host)}" data-port="${s.port}" data-password="${escapeHtml(s.password || '')}" style="padding: 2px 8px; font-size: 11px; height: 24px;">
                            ${isSelected ? `✓ ${t('connection.selected')}` : t('connection.use')}
                          </button>
                          <button type="button" class="btn-edit-saved-srv" data-host="${escapeHtml(s.host)}" data-port="${s.port}" data-name="${escapeHtml(s.name || '')}" data-password="${escapeHtml(s.password || '')}" title="${t('connection.editSavedServer')}">
                            <span class="material-symbols-outlined md-16">edit</span>
                          </button>
                          <button type="button" class="btn-delete-saved-srv" data-host="${escapeHtml(s.host)}" data-port="${s.port}" title="${t('connection.removeFromSaved')}">
                            <span class="material-symbols-outlined md-16">close</span>
                          </button>
                        </div>
                      </div>
                    `;
                  }).join('')}
                </div>
                <div id="home-favorites-empty" class="favorites-empty" role="status" style="display: none;">
                  <strong>${t('favorites.emptyServersTitle')}</strong>
                  <span>${t('favorites.emptyServersDescription')}</span>
                  <button type="button" id="home-favorites-show-all" class="btn btn-secondary">${t('favorites.showAll')}</button>
                </div>
              </div>
            ` : ''}

            <div class="form-group">
              <label>${t('connection.nicknameLabel')}</label>
              <input id="join-nickname" type="text" placeholder="${t('connection.nicknamePlaceholder')}" value="${escapeHtml(savedNick)}" required minlength="2" maxlength="32">
            </div>

            <div class="form-row">
              <div class="form-group" style="flex: 2;">
                <label>${t('connection.hostLabel')}</label>
                <input id="join-host" type="text" placeholder="${t('connection.hostPlaceholder')}" value="${escapeHtml(this.selectedSavedHost || '127.0.0.1')}" required>
              </div>
              <div class="form-group small-col">
                <label>${t('connection.portLabel')}</label>
                <input id="join-port" type="number" placeholder="3000" value="${this.selectedSavedPort || 3000}" required min="1024" max="65535">
              </div>
            </div>

            <div class="form-group">
              <label>${t('connection.passwordLabel')}</label>
              <input id="join-password" type="password" placeholder="••••••••" value="${escapeHtml(selectedSaved?.password || '')}">
            </div>

            <button type="submit" id="btn-submit-join" class="btn btn-primary" style="width: 100%; margin-top: 8px;">
              <span class="material-symbols-outlined md-18" style="margin-right: 6px;">login</span>
              ${t('connection.tabJoin')}
            </button>
          </form>

          <!-- Tab 2: Meus Servidores -->
          <form id="form-host" style="display: ${this.activeTab === 'host' ? 'block' : 'none'};">
            ${this.getCreatedServersSectionHtml(createdServers)}

            <div id="host-create-toggle" style="margin-bottom: 10px;">
              <button type="button" id="btn-show-create-form" class="btn btn-secondary" style="width: 100%; padding: 8px 12px; font-size: 12px;">
                <span class="material-symbols-outlined md-18" style="margin-right: 6px;">add_circle</span>
                ${t('connection.createServer')}
              </button>
            </div>

            <div id="host-create-form-section" style="display: none;">
              <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 10px;">
                <span class="material-symbols-outlined md-14" style="color: var(--accent-primary);">add_circle</span>
                ${t('connection.createNewServer')}
              </div>

              <div style="background: rgba(88, 101, 242, 0.1); border: 1px solid rgba(88, 101, 242, 0.3); border-radius: var(--radius-md); padding: 10px 12px; font-size: 12px; color: var(--text-secondary); margin-bottom: 14px; line-height: 1.4; display: flex; gap: 8px; align-items: flex-start;">
                <span class="material-symbols-outlined md-18" style="color: var(--accent-primary); flex-shrink: 0; margin-top: 1px;">info</span>
                <div>
                  ${t('connection.howItWorks')}
                </div>
              </div>

              <div class="form-group">
                <label>${t('connection.hostNicknameLabel')}</label>
                <input id="host-nickname" type="text" placeholder="${t('connection.nicknamePlaceholder')}" value="${escapeHtml(savedNick)}" required minlength="2" maxlength="32">
              </div>

              <div class="form-group">
                <label>${t('connection.serverNameLabel')}</label>
                <input id="host-name" type="text" placeholder="${t('connection.serverNamePlaceholder')}" value="${t('connection.serverNameDefault')}" required minlength="2" maxlength="50">
              </div>

              <div class="form-row">
                <div class="form-group">
                  <label>${t('connection.localPortLabel')}</label>
                  <input id="host-port" type="number" value="3000" required min="1024" max="65535">
                </div>
                <div class="form-group">
                  <label>${t('connection.accessPasswordLabel')}</label>
                  <input id="host-password" type="password" placeholder="${t('connection.optional')}">
                </div>
              </div>

              <div class="form-row">
                <div class="form-group">
                  <label>${t('connection.textChannelLabel')}</label>
                  <input id="host-text-channel" type="text" value="geral" required>
                </div>
                <div class="form-group">
                  <label>${t('connection.voiceChannelLabel')}</label>
                  <input id="host-voice-channel" type="text" value="Geral" required>
                </div>
              </div>

              <div class="form-group" style="flex-direction: row; align-items: center; justify-content: space-between; gap: 12px;">
                <div>
                  <label style="margin-bottom: 2px;">${t('connection.memberLimitLabel')}</label>
                  <div style="font-size: 11px; color: var(--text-muted);">${t('connection.memberLimitDesc')}</div>
                </div>
                <label class="toggle-switch" aria-label="${t('connection.memberLimitLabel')}">
                  <input id="host-limit-members" type="checkbox">
                  <span class="toggle-slider"></span>
                </label>
              </div>
              <div class="form-group" id="host-max-users-group" hidden>
                <label>${t('connection.memberLimitValueLabel')}</label>
                <input id="host-max-users" type="number" min="1" step="1" value="20">
              </div>

              <div class="form-group" style="margin-top: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px;">
                <div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                  <span class="material-symbols-outlined md-18" style="color: var(--accent-primary);">hub</span>
                  <span>${t('serverSettings.voiceModeLabel')}</span>
                </div>
                <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 12px;">
                  ${t('serverSettings.voiceModeDesc')}
                </div>

                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;" id="host-voice-mode-cards">
                  <div class="voice-mode-card selected" data-mode="p2p" style="padding: 10px 12px; border: 1.5px solid var(--accent-primary); background: rgba(88, 101, 242, 0.1); border-radius: var(--radius-md); cursor: pointer; transition: all 0.15s ease;">
                    <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
                      <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">wifi_tethering</span>
                      <span style="font-size: 12px; font-weight: 600; color: var(--text-primary);">${t('serverSettings.voiceModeP2pTitle')}</span>
                    </div>
                    <div style="font-size: 10px; color: var(--text-muted); line-height: 1.3;">${t('serverSettings.voiceModeP2pDesc')}</div>
                  </div>
                  <div class="voice-mode-card" data-mode="sfu" style="padding: 10px 12px; border: 1.5px solid var(--border-color); background: var(--bg-card-secondary); border-radius: var(--radius-md); cursor: pointer; transition: all 0.15s ease;">
                    <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
                      <span class="material-symbols-outlined md-16" style="color: var(--text-muted);">hub</span>
                      <span style="font-size: 12px; font-weight: 600; color: var(--text-primary);">${t('serverSettings.voiceModeSfuTitle')}</span>
                    </div>
                    <div style="font-size: 10px; color: var(--text-muted); line-height: 1.3;">${t('serverSettings.voiceModeSfuDesc')}</div>
                  </div>
                </div>
                <input type="hidden" id="input-host-voice-mode" value="p2p" />

                ${renderWhatPassesWhereTableHtml()}
                ${renderCapacityEstimatorHtml('host')}
              </div>

              <button type="submit" id="btn-submit-host" class="btn btn-primary" style="width: 100%; margin-top: 8px;">
                <span class="material-symbols-outlined md-18" style="margin-right: 6px;">add_circle</span>
                ${t('connection.createAndStart')}
              </button>
            </div>
          </form>

        </div>
      </div>
    `;

    this.attachEvents();
    this.setConnectionPending(this.connectionPending);
    this.observeContentHeight();
    void this.refreshHostedServerStatus();
  }

  /**
   * Grows the window to whatever the card currently measures so the home screen
   * never needs scrolling (#536). A ResizeObserver covers every cause at once:
   * the error banner, switching tabs, the LAN/saved server lists and language
   * changes. The main process caps the result at the display's work area.
   */
  private observeContentHeight(): void {
    const layout = this.container.querySelector('.connection-layout') as HTMLElement | null;
    const card = layout?.querySelector('.connection-card') as HTMLElement | null;
    if (!layout || !card || typeof ResizeObserver === 'undefined') return;

    this.contentResizeObserver?.disconnect();
    this.contentResizeObserver = new ResizeObserver(() => {
      const cardHeight = card.getBoundingClientRect().height;
      // A detached card measures zero; resizing to that would be nonsense.
      if (cardHeight <= 0) return;
      const style = getComputedStyle(layout);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      // The custom title bar sits outside the layout but inside the window, so
      // asking only for the card's height left it short by exactly that strip —
      // enough to keep a scrollbar around. Measuring the gap instead of
      // hardcoding 33px keeps this right if the title bar ever changes.
      const outsideLayout = Math.max(0, window.innerHeight - layout.getBoundingClientRect().height);
      const needed = cardHeight + (Number.isFinite(padding) ? padding : 0) + outsideLayout;
      void window.api?.fitHomeWindowToContent?.(Math.ceil(needed));
    });
    this.contentResizeObserver.observe(card);
  }

  private async startHostedServer(server: CreatedServer, nickname: string): Promise<void> {
    if (this.connectionPending) return;
    this.setConnectionPending(true);
    const avatar = this.selectedAvatarBase64;
    const isCurrent = captureServerBrowseIntent();
    try {
      assertServerBrowseAvailable('127.0.0.1', server.port);
      connectionStore.saveUserProfile(nickname, avatar);
      await ensureHostedServerStarted(server);
      await this.syncHostedServerStatus();
      if (!isCurrent()) return;

      const identity = connectionStore.hasIdentity && connectionStore.clientId && connectionStore.publicKey
        ? { clientId: connectionStore.clientId, publicKey: connectionStore.publicKey }
        : await window.api.getIdentity();
      if (!isCurrent()) return;
      connectionStore.setIdentity(identity);
      const result = await openServerSession('127.0.0.1', server.port, identity, nickname, server.password);
      await this.updateSessionAvatar('127.0.0.1', server.port, avatar);

      connectionStore.addSavedServer({
        host: '127.0.0.1',
        port: server.port,
        name: result.server.name,
        password: server.password,
        lastConnected: Date.now(),
      });
      await window.api?.maximize?.();
    } finally {
      this.setConnectionPending(false);
    }
  }

  private async updateSessionAvatar(host: string, port: number, avatar: string): Promise<void> {
    const session = getServerSessionForAddress(host, port);
    if (!avatar || !session || session.client.getStatus() !== 'CONNECTED') return;
    try {
      await session.client.sendRequest(MessageType.USER_UPDATE_AVATAR, { avatarBase64: avatar, mimeType: 'image/png' });
    } catch (error: unknown) {
      clientLog.warn('CONNECTION', 'Could not update the avatar on the opened server session', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private setConnectionPending(pending: boolean): void {
    this.connectionPending = pending;
    this.container.querySelectorAll<HTMLButtonElement>('#btn-submit-join, #btn-submit-host, .btn-start-created-server')
      .forEach(button => { button.disabled = pending; });
  }

  private attachSavedFavoriteEvents(): void {
    const section = this.container.querySelector('#home-saved-servers');
    if (!section) return;
    section.querySelectorAll<HTMLButtonElement>('[data-favorites-filter]').forEach(button => {
      button.addEventListener('click', () => {
        this.savedFavoritesOnly = button.dataset.favoritesFilter === 'favorites';
        this.updateSavedFavoriteControls('filter');
      });
    });
    section.querySelector('#home-favorites-show-all')?.addEventListener('click', () => {
      this.savedFavoritesOnly = false;
      this.updateSavedFavoriteControls('filter');
      section.querySelector<HTMLButtonElement>('#home-saved-filter-all')?.focus();
    });
    section.querySelectorAll<HTMLButtonElement>('.favorite-toggle').forEach(button => {
      button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        const server = connectionStore.savedServers.find(item => savedServerFavoriteKey(item) === button.dataset.favoriteKey);
        if (!server) return;
        try {
          favoritesStore.toggleServer(server);
          this.updateSavedFavoriteControls('reorder');
        } catch (error: unknown) {
          clientLog.warn('STORE', 'Could not save the server favorite', {
            error: error instanceof Error ? error.message : String(error),
          });
          await showAlert({ title: t('common.error'), message: t('favorites.saveFailed'), variant: 'danger' });
        }
      });
    });
    this.updateSavedFavoriteControls();
  }

  private updateSavedFavoriteControls(animate: FavoriteMotionKind | false = false): void {
    const section = this.container.querySelector<HTMLElement>('#home-saved-servers');
    const list = section?.querySelector<HTMLElement>('.saved-servers-list');
    if (!section || !list) return;
    this.savedFavoriteMotion.update(section, '.saved-server-item', () => {
      updateFavoritesFilter(section, this.savedFavoritesOnly);
      const focused = document.activeElement;
      const scrollTop = list.scrollTop;
      const visibleButtons: HTMLButtonElement[] = [];
      let hiddenFocus = false;
      const rows = Array.from(list.querySelectorAll<HTMLElement>('.saved-server-item')).flatMap(item => {
        const server = connectionStore.savedServers.find(entry => entry.host === item.dataset.host
          && entry.port === Number(item.dataset.port));
        return server ? [{ item, server }] : [];
      });
      sortFavoritesFirst(rows, row => this.savedServerOrder(row.server), getLanguage()).forEach(({ item, server }, index) => {
        if (list.children[index] !== item) list.insertBefore(item, list.children[index] ?? null);
        const favorite = favoritesStore.isServerFavorite(server);
        const visible = !this.savedFavoritesOnly || favorite;
        item.style.display = visible ? '' : 'none';
        if (!visible && focused && item.contains(focused)) hiddenFocus = true;
        const button = item.querySelector<HTMLButtonElement>('.favorite-toggle');
        if (button) {
          const label = t(favorite ? 'favorites.remove' : 'favorites.add', { name: server.name || server.host });
          button.setAttribute('aria-pressed', String(favorite));
          button.setAttribute('aria-label', label);
          button.title = label;
          if (visible) visibleButtons.push(button);
        }
      });
      list.scrollTop = scrollTop;
      const empty = section.querySelector<HTMLElement>('#home-favorites-empty');
      if (empty) empty.style.display = this.savedFavoritesOnly && visibleButtons.length === 0 ? '' : 'none';
      if (hiddenFocus) {
        const next = visibleButtons[0] ?? section.querySelector<HTMLButtonElement>('#home-saved-filter-favorites');
        next?.focus({ preventScroll: true });
        next?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      } else if (focused instanceof HTMLElement && list.contains(focused)) {
        if (document.activeElement !== focused) focused.focus({ preventScroll: true });
        focused.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
    }, animate);
  }

  private savedServerOrder(server: SavedServer): FavoriteOrderEntry {
    return {
      favorite: favoritesStore.isServerFavorite(server),
      name: server.name || t('connection.serverFallbackName'),
      identity: savedServerFavoriteKey(server),
    };
  }

  private async stopHostedServer(): Promise<void> {
    if (!window.api?.hostServerStop) return;

    // Everyone on the server loses their session when it goes down (#334).
    if (!(await confirmStopHostedServer())) return;

    const stopRes = await window.api.hostServerStop();
    if (!stopRes.success) {
      throw new Error(t('connection.stopServerError'));
    }

    // Re-derive instead of assuming: the main process owns this state now (#333).
    await this.syncHostedServerStatus();
  }

  private async removeCreatedServer(server: CreatedServer): Promise<void> {
    const needsStop = this.isCreatedServerRunning(server);
    const confirmed = await showConfirm({
      title: t('connection.deleteSavedServer'),
      message: needsStop
        ? t('connection.deleteRunningServerMessage', { name: server.name })
        : t('connection.deleteServerMessage', { name: server.name }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      variant: 'danger',
    });
    if (!confirmed) return;

    if (needsStop) {
      await this.stopHostedServer();
      // The stop can be called off when other people are still connected; the
      // entry must survive so the running server stays reachable (#334).
      if (this.isCreatedServerRunning(server)) return;
    }

    // The entry alone was never the whole server: its database, avatars and
    // attachments stayed on disk and were inherited by the next server created
    // (#364).
    const deleted = await window.api?.hostServerDeleteData?.(server.id);
    connectionStore.removeCreatedServer(server.id);
    connectionStore.removeSavedServer('127.0.0.1', server.port);
    this.render();

    if (deleted && !deleted.success) {
      this.showError(deleted.error || t('connection.deleteServerError'));
    }
  }

  private unbindLanListeners: Array<() => void> = [];
  private isScanningLan: boolean = false;
  private lanScanTimeout: any = null;

  private setupLanDiscoveryListeners(): void {
    for (const unbind of this.unbindLanListeners) {
      unbind();
    }
    this.unbindLanListeners = [];

    if (!window.api?.onLanDiscoveryFound || !window.api?.onLanDiscoveryLost) return;

    const u1 = window.api.onLanDiscoveryFound((server) => {
      this.discoveredServers.set(this.getDiscoveredServerKey(server.host, server.port), server);
      this.renderDiscoveredServersSection();
    });

    const u2 = window.api.onLanDiscoveryLost((server) => {
      this.discoveredServers.delete(this.getDiscoveredServerKey(server.host, server.port));
      this.renderDiscoveredServersSection();
    });

    this.unbindLanListeners.push(u1, u2);
  }

  private async loadServerPreviews(): Promise<void> {
    const nodes = Array.from(
      this.container.querySelectorAll('.saved-server-preview')
    ) as HTMLElement[];

    for (const node of nodes) {
      const host = node.getAttribute('data-host');
      const port = node.getAttribute('data-port');
      if (!host || !port) continue;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        const res = await fetch(`http://${host}:${port}/preview`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) {
          this.setServerStatusDot(host, port, 'offline');
          continue;
        }
        this.setServerStatusDot(host, port, 'online');
        const info = await res.json();
        this.renderServerPreview(node, host, port, info);
      } catch {
        // Server offline/unreachable — mark the indicator and leave the preview empty.
        this.setServerStatusDot(host, port, 'offline');
      }
    }
  }

  private setServerStatusDot(host: string, port: string, status: 'online' | 'offline'): void {
    const dot = this.container.querySelector(
      `.server-status-dot[data-host="${CSS.escape(host)}"][data-port="${CSS.escape(port)}"]`
    ) as HTMLElement | null;
    if (!dot) return;
    dot.setAttribute('data-status', status);
    dot.title = status === 'online' ? t('connection.serverOnline') : t('connection.serverOffline');
  }

  private renderServerPreview(
    node: HTMLElement,
    host: string,
    port: string,
    info: {
      userCount?: number;
      memberCount?: number;
      maxUsers?: number;
      users?: Array<{ nickname?: string; avatarUrl?: string }>;
    }
  ): void {
    const users = Array.isArray(info.users) ? info.users.slice(0, 5) : [];
    const count = typeof info.userCount === 'number' ? info.userCount : users.length;
    // The cap counts registered members, not who happens to be online, so the
    // two numbers are shown separately instead of as one misleading "3/20" (#403).
    const max = typeof info.maxUsers === 'number' && info.maxUsers > 0 ? info.maxUsers : null;
    const members = typeof info.memberCount === 'number' ? info.memberCount : null;
    const membersLabel =
      max !== null && members !== null
        ? ` • ${t('connection.membersOfLimit', { count: members, max })}`
        : '';

    const avatars = users
      .map((u) => {
        const raw = u.avatarUrl && u.avatarUrl.startsWith('/avatars/')
          ? `http://${host}:${port}${u.avatarUrl}`
          : u.avatarUrl || getAvatarUrl(null);
        const title = escapeHtml(u.nickname || t('connection.unknownUser'));
        return `<img class="preview-avatar" src="${raw}" title="${title}" data-fallback="avatar">`;
      })
      .join('');

    node.innerHTML = `
      <div class="server-preview-row">
        <div class="preview-avatars">${avatars}</div>
        <span class="preview-count">${count} ${t('connection.online')}${membersLabel}</span>
      </div>
    `;
  }

  private getDiscoveredServersSectionHtml(): string {
    const servers = Array.from(this.discoveredServers.values()).sort((a, b) => {
      if (a.serverName !== b.serverName) {
        return a.serverName.localeCompare(b.serverName, 'pt-BR');
      }
      return a.host.localeCompare(b.host, 'pt-BR') || a.port - b.port;
    });

    return `
      <div class="saved-servers-container" style="margin-bottom: 14px;">
        <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
          <span style="display: flex; align-items: center; gap: 4px;">
            <span class="material-symbols-outlined md-14" style="color: #3ba55d;">wifi</span>
            ${t('connection.lanServersCount', { count: servers.length })}
          </span>
          <button type="button" id="btn-scan-lan" class="btn btn-secondary" ${this.isScanningLan ? 'disabled' : ''} style="padding: 2px 10px; font-size: 10px; height: 22px;">
            <span class="material-symbols-outlined md-14" style="margin-right: 3px;">radar</span>
            ${this.isScanningLan ? t('connection.scanning') : t('connection.scan')}
          </button>
        </div>
        ${servers.length > 0 ? `
          <div class="saved-servers-list">
            ${servers.map((server) => `
              <div class="saved-server-item">
                <div style="display: flex; flex-direction: column; overflow: hidden;">
                  <span style="font-size: 13px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px;">
                    <span title="${t('connection.discoveredOnLan')}" style="width: 9px; height: 9px; border-radius: 50%; background: #3ba55d; box-shadow: 0 0 0 2px rgba(59, 165, 93, 0.16); display: inline-block;"></span>
                    <span class="material-symbols-outlined md-16" style="color: #3ba55d;">lan</span>
                    ${escapeHtml(server.serverName)}
                  </span>
                  <span style="font-size: 11px; color: var(--text-muted); margin-left: 21px;">${escapeHtml(server.host)}:${server.port} • v${escapeHtml(server.version)}</span>
                </div>
                <button
                  type="button"
                  class="btn btn-primary btn-join-discovered-server"
                  data-host="${escapeHtml(server.host)}"
                  data-port="${server.port}"
                  style="padding: 2px 10px; font-size: 11px; height: 28px; flex-shrink: 0;"
                >
                  ${t('connection.join')}
                </button>
              </div>
            `).join('')}
          </div>
        ` : `
          <div style="padding: 8px 12px; border: 1px dashed rgba(255, 255, 255, 0.12); border-radius: var(--radius-md); color: var(--text-muted); font-size: 12px;">
            ${t('connection.scanHint', { button: t('connection.scan') })}
          </div>
        `}
      </div>
    `;
  }

  private renderDiscoveredServersSection(): void {
    const section = this.container.querySelector('#lan-discovery-section') as HTMLElement | null;
    if (!section) return;
    section.innerHTML = this.getDiscoveredServersSectionHtml();
    this.attachDiscoveredServerEvents();
  }

  private attachDiscoveredServerEvents(): void {
    const joinHostInput = document.getElementById('join-host') as HTMLInputElement | null;
    const joinPortInput = document.getElementById('join-port') as HTMLInputElement | null;
    const formJoin = document.getElementById('form-join') as HTMLFormElement | null;

    // Scan button — starts discovery for 5s then stops
    const scanBtn = this.container.querySelector('#btn-scan-lan') as HTMLButtonElement | null;
    scanBtn?.addEventListener('click', async () => {
      if (this.isScanningLan) return;
      this.isScanningLan = true;
      if (this.lanScanTimeout) {
        clearTimeout(this.lanScanTimeout);
        this.lanScanTimeout = null;
      }
      this.discoveredServers.clear();
      this.renderDiscoveredServersSection();
      await window.api?.startLanDiscovery?.();

      this.lanScanTimeout = setTimeout(async () => {
        this.isScanningLan = false;
        this.lanScanTimeout = null;
        await window.api?.stopLanDiscovery?.();
        this.renderDiscoveredServersSection();
      }, 5000);
    });

    const buttons = this.container.querySelectorAll('.btn-join-discovered-server');
    buttons.forEach((button) => {
      button.addEventListener('click', () => {
        const host = button.getAttribute('data-host');
        const port = button.getAttribute('data-port');
        if (!host || !port || !joinHostInput || !joinPortInput || !formJoin) return;

        joinHostInput.value = host;
        joinPortInput.value = port;
        this.selectedSavedHost = host;
        this.selectedSavedPort = parseInt(port, 10);
        formJoin.requestSubmit();
      });
    });
  }

  private async syncLanDiscoveryForActiveTab(): Promise<void> {
    // Discovery is manual now — only stop when leaving join tab
    if (this.activeTab !== 'join') {
      if (this.lanScanTimeout) {
        clearTimeout(this.lanScanTimeout);
        this.lanScanTimeout = null;
      }
      this.isScanningLan = false;
      this.discoveredServers.clear();
      this.renderDiscoveredServersSection();
      await window.api?.stopLanDiscovery?.();
    }
  }

  private getDiscoveredServerKey(host: string, port: number): string {
    return `${host}:${port}`;
  }

  private async submitJoinForm(): Promise<void> {
    if (this.connectionPending) return;
    this.hideError();

    const nickname = (document.getElementById('join-nickname') as HTMLInputElement).value.trim();
    const host = (document.getElementById('join-host') as HTMLInputElement).value.trim();
    const port = parseInt((document.getElementById('join-port') as HTMLInputElement).value, 10);
    const password = (document.getElementById('join-password') as HTMLInputElement).value;

    const avatar = this.selectedAvatarBase64;
    connectionStore.saveUserProfile(nickname, avatar);

    const btn = document.getElementById('btn-submit-join') as HTMLButtonElement;
    this.setConnectionPending(true);
    const isCurrent = captureServerBrowseIntent();
    btn.innerText = t('main.connectingTo', { name: host });

    try {
      assertServerBrowseAvailable(host, port);
      const owned = findOwnedServer(host, port);
      const connected = getServerSessionForAddress(host, port)?.client.getStatus() === 'CONNECTED';
      if (owned && !connected && !(await checkServerOnline(host, port))) {
        if (!isCurrent()) return;
        const confirmed = await showConfirm({
          title: t('main.serverOfflineStartTitle'),
          message: t('main.serverOfflineStartMessage', { name: owned.name }),
          confirmLabel: t('main.serverOfflineStartConfirm'),
          variant: 'warning',
        });
        if (!confirmed || !isCurrent()) return;
        await ensureHostedServerStarted(owned);
        if (!isCurrent()) return;
      }
      const identity = connectionStore.hasIdentity && connectionStore.clientId && connectionStore.publicKey
        ? { clientId: connectionStore.clientId, publicKey: connectionStore.publicKey }
        : await window.api.getIdentity();
      if (!isCurrent()) return;
      connectionStore.setIdentity(identity);

      const res = await openServerSession(host, port, identity, nickname, password);
      await this.updateSessionAvatar(host, port, avatar);

      connectionStore.addSavedServer({
        host,
        port,
        name: res.server.name,
        password: password || undefined,
        lastConnected: Date.now(),
      });

      await window.api?.stopLanDiscovery?.();
      await window.api?.maximize?.();
    } catch (err: unknown) {
      this.showError(err instanceof Error && err.message ? err.message : t('connection.connectError'));
    } finally {
      this.setConnectionPending(false);
      btn.innerHTML = `<span class="material-symbols-outlined md-18" style="margin-right: 6px;">login</span> ${t('connection.tabJoin')}`;
    }
  }

  private attachEvents(): void {
    const tabJoin = document.getElementById('tab-join');
    const tabHost = document.getElementById('tab-host');
    const formJoin = document.getElementById('form-join') as HTMLFormElement;
    const formHost = document.getElementById('form-host') as HTMLFormElement;
    const btnSelectAvatar = document.getElementById('btn-select-avatar');
    const joinNickInput = document.getElementById('join-nickname') as HTMLInputElement;
    const hostNickInput = document.getElementById('host-nickname') as HTMLInputElement;
    const joinHostInput = document.getElementById('join-host') as HTMLInputElement;
    const joinPortInput = document.getElementById('join-port') as HTMLInputElement;
    const joinPassInput = document.getElementById('join-password') as HTMLInputElement;
    const startCreatedButtons = this.container.querySelectorAll('.btn-start-created-server');
    const stopCreatedButtons = this.container.querySelectorAll('.btn-stop-created-server');
    const monitorCreatedButtons = this.container.querySelectorAll('.btn-monitor-created-server');
    const removeCreatedButtons = this.container.querySelectorAll('.btn-remove-created-server');
    const importIdentityButton = document.getElementById('btn-import-existing-identity');

    // Sync and save nickname as user types
    const handleNickChange = (val: string) => {
      if (joinNickInput && joinNickInput.value !== val) joinNickInput.value = val;
      if (hostNickInput && hostNickInput.value !== val) hostNickInput.value = val;
      connectionStore.saveUserProfile(val, this.selectedAvatarBase64);
    };

    joinNickInput?.addEventListener('input', (e) => handleNickChange((e.target as HTMLInputElement).value));
    hostNickInput?.addEventListener('input', (e) => handleNickChange((e.target as HTMLInputElement).value));

    document.getElementById('btn-open-settings')?.addEventListener('click', (e) => {
      withButtonLoading(e.currentTarget as HTMLElement, () => settingsModal.open());
    });

    // Onboarding wizard button
    document.getElementById('btn-onboarding')?.addEventListener('click', () => {
      onboardingWizard.open((action) => {
        if (action === 'join' && this.activeTab !== 'join') {
          this.activeTab = 'join';
          this.render();
        } else if (action === 'host' && this.activeTab !== 'host') {
          this.activeTab = 'host';
          this.render();
        }
      });
    });

    // Auto-open onboarding on first launch
    if (!settingsStore.onboardingCompleted && !onboardingWizard.isOpen && !this.onboardingAutoOpened) {
      this.onboardingAutoOpened = true;
      onboardingWizard.open((action) => {
        if (action === 'join' && this.activeTab !== 'join') {
          this.activeTab = 'join';
          this.render();
        } else if (action === 'host' && this.activeTab !== 'host') {
          this.activeTab = 'host';
          this.render();
        }
      });
    }

    importIdentityButton?.addEventListener('click', async () => {
      const identity = await showIdentityImportDialog();
      if (!identity) return;
      connectionStore.setIdentity(identity);
      this.render();
      await showAlert({
        title: t('identity.importTitle'),
        message: t('identity.importSuccess'),
        variant: 'success',
      });
    });

    this.loadServerPreviews();
    this.attachDiscoveredServerEvents();
    void this.syncLanDiscoveryForActiveTab();

    // Toggle create server form visibility
    document.getElementById('btn-show-create-form')?.addEventListener('click', () => {
      const section = document.getElementById('host-create-form-section');
      const toggleBtn = document.getElementById('btn-show-create-form');
      if (section && toggleBtn) {
        const visible = section.style.display !== 'none';
        section.style.display = visible ? 'none' : 'block';
        toggleBtn.innerHTML = visible
          ? `<span class="material-symbols-outlined md-18" style="margin-right: 6px;">add_circle</span> ${t('connection.createServer')}`
          : `<span class="material-symbols-outlined md-18" style="margin-right: 6px;">close</span> ${t('common.cancel')}`;
      }
    });

    const hostVoiceCards = document.querySelectorAll('#host-voice-mode-cards .voice-mode-card');
    const hiddenHostVoiceMode = document.getElementById('input-host-voice-mode') as HTMLInputElement | null;
    hostVoiceCards.forEach((card) => {
      card.addEventListener('click', () => {
        const mode = (card as HTMLElement).dataset.mode;
        if (!mode) return;
        if (hiddenHostVoiceMode) hiddenHostVoiceMode.value = mode;
        hostVoiceCards.forEach((c) => {
          const isSelected = (c as HTMLElement).dataset.mode === mode;
          c.classList.toggle('selected', isSelected);
          (c as HTMLElement).style.borderColor = isSelected ? 'var(--accent-primary)' : 'var(--border-color)';
          (c as HTMLElement).style.background = isSelected ? 'rgba(88, 101, 242, 0.1)' : 'var(--bg-card-secondary)';
          const icon = c.querySelector('.material-symbols-outlined') as HTMLElement | null;
          if (icon) icon.style.color = isSelected ? 'var(--accent-primary)' : 'var(--text-muted)';
        });
      });
    });

    attachCapacityEstimatorEvents(this.container, 'host');

    startCreatedButtons.forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        if (this.connectionPending) return;
        this.hideError();

        const serverId = btn.getAttribute('data-created-server-id');
        const server = connectionStore.createdServers.find((item) => item.id === serverId);
        const nickname = this.getHostNicknameValue();
        if (!server) return;

        if (nickname.length < 2) {
          this.showError(t('connection.hostNicknameRequired'));
          hostNickInput?.focus();
          return;
        }

        const button = btn as HTMLButtonElement;
        const originalHtml = button.innerHTML;
        button.disabled = true;
        button.textContent = t('connection.startingServer');

        try {
          await this.startHostedServer(server, nickname);
          await window.api?.stopLanDiscovery?.();
        } catch (err: unknown) {
          if (this.container.querySelector('.connection-layout')) this.render();
          this.showError(err instanceof Error && err.message ? err.message : t('connection.startSavedServerError'));
          return;
        } finally {
          if (button.isConnected) {
            button.disabled = false;
            button.innerHTML = originalHtml;
          }
        }
      });
    });

    stopCreatedButtons.forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        this.hideError();

        const button = btn as HTMLButtonElement;
        const originalHtml = button.innerHTML;
        button.disabled = true;
        button.textContent = t('connection.stoppingServer');

        try {
          await this.stopHostedServer();
          this.render();
        } catch (err: any) {
          this.showError(err.message || t('connection.stopServerError'));
          if (button.isConnected) {
            button.disabled = false;
            button.innerHTML = originalHtml;
          }
        }
      });
    });

    monitorCreatedButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void serverMonitorModal.open();
      });
    });

    removeCreatedButtons.forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.hideError();

        const serverId = btn.getAttribute('data-created-server-id');
        const server = connectionStore.createdServers.find((item) => item.id === serverId);
        if (!server) return;

        try {
          await this.removeCreatedServer(server);
        } catch (err: any) {
          this.showError(err.message || t('connection.deleteServerError'));
        }
      });
    });

    // Handle clicking a saved server card
    this.attachSavedFavoriteEvents();
    const savedServerItems = this.container.querySelectorAll('#home-saved-servers .saved-server-item');
    savedServerItems.forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target instanceof Element
          && e.target.closest('.favorite-toggle, .btn-delete-saved-srv, .btn-edit-saved-srv')) return;

        const host = item.getAttribute('data-host');
        const port = parseInt(item.getAttribute('data-port') || '3000', 10);
        const pass = item.getAttribute('data-password') || '';

        if (host) {
          this.selectedSavedHost = host;
          this.selectedSavedPort = port;
          if (joinHostInput) joinHostInput.value = host;
          if (joinPortInput) joinPortInput.value = port.toString();
          if (joinPassInput) joinPassInput.value = pass;

          savedServerItems.forEach((el) => el.classList.remove('selected'));
          item.classList.add('selected');
        }
      });
    });

    // Handle delete saved server button
    const deleteButtons = this.container.querySelectorAll('.btn-delete-saved-srv');
    deleteButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const host = btn.getAttribute('data-host');
        const port = parseInt(btn.getAttribute('data-port') || '3000', 10);
        if (host) {
          connectionStore.removeSavedServer(host, port);
          if (this.selectedSavedHost === host && this.selectedSavedPort === port) {
            this.selectedSavedHost = null;
            this.selectedSavedPort = null;
          }
          this.render();
        }
      });
    });

    // Handle edit saved server button
    const editButtons = this.container.querySelectorAll('.btn-edit-saved-srv');
    editButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const oldHost = btn.getAttribute('data-host') || '';
        const oldPort = parseInt(btn.getAttribute('data-port') || '3000', 10);
        const oldName = btn.getAttribute('data-name') || '';
        const oldPass = btn.getAttribute('data-password') || '';
        this.showEditServerDialog(oldHost, oldPort, oldName, oldPass);
      });
    });

    tabJoin?.addEventListener('click', () => {
      this.activeTab = 'join';
      tabJoin.classList.add('active');
      tabHost?.classList.remove('active');
      formJoin.style.display = 'block';
      formHost.style.display = 'none';
      this.hideError();
      void this.syncLanDiscoveryForActiveTab();
    });

    tabHost?.addEventListener('click', () => {
      this.activeTab = 'host';
      tabHost.classList.add('active');
      tabJoin?.classList.remove('active');
      formHost.style.display = 'block';
      formJoin.style.display = 'none';
      this.hideError();
      void this.syncLanDiscoveryForActiveTab();
    });

    btnSelectAvatar?.addEventListener('click', async (e) => {
      e.preventDefault();
      const croppedAvatar = await pickAndCropImage();
      if (croppedAvatar) {
        this.selectedAvatarBase64 = croppedAvatar;
        const img = document.getElementById('avatar-preview') as HTMLImageElement;
        if (img) img.src = croppedAvatar;
        const currentNick = joinNickInput?.value || hostNickInput?.value || connectionStore.savedNickname;
        connectionStore.saveUserProfile(currentNick, this.selectedAvatarBase64);
      }
    });

    formJoin?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.submitJoinForm();
    });

    const limitToggle = document.getElementById('host-limit-members') as HTMLInputElement | null;
    const limitGroup = document.getElementById('host-max-users-group') as HTMLElement | null;
    limitToggle?.addEventListener('change', () => {
      if (limitGroup) limitGroup.hidden = !limitToggle.checked;
    });

    formHost?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this.connectionPending) return;
      this.hideError();

      const nickname = (document.getElementById('host-nickname') as HTMLInputElement).value.trim();
      const serverName = (document.getElementById('host-name') as HTMLInputElement).value.trim();
      const port = parseInt((document.getElementById('host-port') as HTMLInputElement).value, 10);
      const password = (document.getElementById('host-password') as HTMLInputElement).value;
      const initialText = (document.getElementById('host-text-channel') as HTMLInputElement).value.trim();
      const initialVoice = (document.getElementById('host-voice-channel') as HTMLInputElement).value.trim();
      const wantsLimit = (document.getElementById('host-limit-members') as HTMLInputElement | null)?.checked ?? false;
      const rawLimit = parseInt((document.getElementById('host-max-users') as HTMLInputElement | null)?.value ?? '', 10);
      if (wantsLimit && (!Number.isFinite(rawLimit) || rawLimit < 1)) {
        this.showError(t('connection.memberLimitInvalid'));
        return;
      }
      const maxUsers = wantsLimit ? rawLimit : LIMITS.MAX_USERS_UNLIMITED;

      connectionStore.saveUserProfile(nickname, this.selectedAvatarBase64);

      const btn = document.getElementById('btn-submit-host') as HTMLButtonElement;
      btn.disabled = true;
      btn.innerText = t('connection.startingServer');

      try {
        const now = Date.now();
        const existingServer = connectionStore.createdServers.find((server) =>
          server.name === serverName &&
          server.port === port &&
          (server.password || '') === password &&
          server.textChannel === initialText &&
          server.voiceChannel === initialVoice
        );
        const voiceModeInput = (document.getElementById('input-host-voice-mode') as HTMLInputElement | null) ||
          (document.querySelector('input[name="host-voice-mode"]:checked') as HTMLInputElement | null);
        const voiceMode = (voiceModeInput?.value as 'p2p' | 'sfu') || 'p2p';

        const createdServer: CreatedServer = {
          id: existingServer?.id || this.createCreatedServerId(),
          name: serverName,
          port,
          password: password || undefined,
          textChannel: initialText,
          voiceChannel: initialVoice,
          createdAt: existingServer?.createdAt || now,
          lastStarted: now,
          maxUsers,
          voiceMode,
        };

        await this.startHostedServer(createdServer, nickname);
        await window.api?.stopLanDiscovery?.();
      } catch (err: unknown) {
        if (this.container.querySelector('.connection-layout')) this.render();
        this.showError(err instanceof Error && err.message ? err.message : t('connection.createServerError'));
      } finally {
        if (btn.isConnected) {
          btn.disabled = false;
          btn.innerHTML = `<span class="material-symbols-outlined md-18" style="margin-right: 6px;">add_circle</span> ${t('connection.createServerButton')}`;
        }
      }
    });
  }

  private showError(msg: string): void {
    const el = document.getElementById('error-banner');
    if (el) {
      el.innerText = msg;
      el.style.display = 'block';
    } else {
      void showAlert({ title: t('common.error'), message: msg, variant: 'danger' });
    }
  }

  private hideError(): void {
    const el = document.getElementById('error-banner');
    if (el) {
      el.style.display = 'none';
      el.innerText = '';
    }
  }

  private showEditServerDialog(oldHost: string, oldPort: number, oldName: string, oldPass: string): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-card" style="max-width: 420px;">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);">edit</span>
            <span>${t('connection.editSavedServer')}</span>
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 12px; padding: 4px 0;">
          <div class="form-group" style="margin-bottom: 0;">
            <label>${t('connection.serverNameLabel')}</label>
            <input id="edit-srv-name" type="text" value="${escapeHtml(oldName)}" placeholder="${t('connection.serverNamePlaceholder')}">
          </div>
          <div class="form-row" style="gap: 12px;">
            <div class="form-group" style="flex: 2; margin-bottom: 0;">
              <label>${t('connection.hostLabel')}</label>
              <input id="edit-srv-host" type="text" value="${escapeHtml(oldHost)}" required>
            </div>
            <div class="form-group small-col" style="margin-bottom: 0;">
              <label>${t('connection.portLabel')}</label>
              <input id="edit-srv-port" type="number" value="${oldPort}" required min="1024" max="65535">
            </div>
          </div>
          <div class="form-group" style="margin-bottom: 0;">
            <label>${t('connection.passwordLabel')}</label>
            <input id="edit-srv-pass" type="password" value="${escapeHtml(oldPass)}" placeholder="••••••••">
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-action="cancel">${t('common.cancel')}</button>
          <button type="button" class="btn btn-primary" data-action="save">${t('common.save')}</button>
        </div>
      </div>
    `;

    const close = () => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
    };

    const save = () => {
      const name = (backdrop.querySelector('#edit-srv-name') as HTMLInputElement).value.trim();
      const host = (backdrop.querySelector('#edit-srv-host') as HTMLInputElement).value.trim();
      const port = parseInt((backdrop.querySelector('#edit-srv-port') as HTMLInputElement).value, 10);
      const password = (backdrop.querySelector('#edit-srv-pass') as HTMLInputElement).value;

      if (!host || !port || port < 1024 || port > 65535) return;

      const saved = connectionStore.savedServers.find((s) => s.host === oldHost && s.port === oldPort);
      connectionStore.updateSavedServer(oldHost, oldPort, {
        host,
        port,
        name,
        password,
        lastConnected: saved?.lastConnected ?? Date.now(),
      });

      if (this.selectedSavedHost === oldHost && this.selectedSavedPort === oldPort) {
        this.selectedSavedHost = host;
        this.selectedSavedPort = port;
      }

      close();
      this.render();
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Enter') { e.preventDefault(); save(); }
    };

    backdrop.querySelector('[data-action="cancel"]')?.addEventListener('click', close);
    backdrop.querySelector('[data-action="save"]')?.addEventListener('click', save);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey, true);

    document.body.appendChild(backdrop);
    (backdrop.querySelector('#edit-srv-name') as HTMLInputElement)?.focus();
  }
}
