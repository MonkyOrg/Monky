import { MessageType } from '@monky/shared';
import { networkClient } from '../core/NetworkClient';
import { serverStore } from '../stores/serverStore';
import { connectionStore } from '../stores/connectionStore';
import { t } from '../i18n';
import { enableBackdropClose } from '../utils/modal';
import { AccountTab } from './settings/tabs/AccountTab';
import { VoiceVideoTab } from './settings/tabs/VoiceVideoTab';
import { SoundboardTab } from './settings/tabs/SoundboardTab';
import { StickersTab } from './settings/tabs/StickersTab';
import { KeybindsTab } from './settings/tabs/KeybindsTab';
import { NotificationsTab } from './settings/tabs/NotificationsTab';
import { QualityTab } from './settings/tabs/QualityTab';
import { LogsTab } from './settings/tabs/LogsTab';
import { AboutTab } from './settings/tabs/AboutTab';

export class SettingsModal {
  private modalEl: HTMLElement | null = null;
  private activeTab = 'account';

  private accountTab = new AccountTab();
  private voiceVideoTab = new VoiceVideoTab();
  private soundboardTab = new SoundboardTab();
  private stickersTab = new StickersTab();
  private keybindsTab = new KeybindsTab();
  private notificationsTab = new NotificationsTab();
  private qualityTab = new QualityTab();
  private logsTab = new LogsTab();
  private aboutTab = new AboutTab();

  public async open(): Promise<void> {
    this.close();

    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal-backdrop modal-backdrop--settings';
    this.modalEl.innerHTML = `
      <div class="modal-card settings-modal-card">
        <!-- Sidebar Navigation -->
        <div class="settings-sidebar">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-muted); padding: 4px 10px 8px;">
            ${t('connection.settingsTitle')}
          </div>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'account' ? 'active' : ''}" data-tab="account">
            <span class="material-symbols-outlined md-18">person</span>
            <span>${t('settings.tabAccount')}</span>
          </button>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'voice_video' ? 'active' : ''}" data-tab="voice_video">
            <span class="material-symbols-outlined md-18">mic</span>
            <span>${t('settings.tabVoiceVideo')}</span>
          </button>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'soundboard' ? 'active' : ''}" data-tab="soundboard">
            <span class="material-symbols-outlined md-18">music_note</span>
            <span>${t('settings.tabSoundboard')}</span>
          </button>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'stickers' ? 'active' : ''}" data-tab="stickers">
            <span class="material-symbols-outlined md-18">mood</span>
            <span>${t('settings.tabStickers')}</span>
          </button>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'keybinds' ? 'active' : ''}" data-tab="keybinds">
            <span class="material-symbols-outlined md-18">keyboard</span>
            <span>${t('settings.tabKeybinds')}</span>
          </button>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'notifications' ? 'active' : ''}" data-tab="notifications">
            <span class="material-symbols-outlined md-18">notifications</span>
            <span>${t('settings.tabNotifications')}</span>
          </button>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'quality' ? 'active' : ''}" data-tab="quality">
            <span class="material-symbols-outlined md-18">speed</span>
            <span>${t('settings.tabQuality')}</span>
          </button>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'logs' ? 'active' : ''}" data-tab="logs">
            <span class="material-symbols-outlined md-18">description</span>
            <span>${t('settings.tabLogs')}</span>
          </button>
          <div style="height: 1px; background: var(--border-color); margin: 6px 4px;"></div>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'about' ? 'active' : ''}" data-tab="about">
            <span class="material-symbols-outlined md-18">info</span>
            <span>${t('settings.tabAbout')}</span>
          </button>
        </div>

        <!-- Main Content Area -->
        <div class="settings-main-container">
          <!-- Top Header -->
          <div class="settings-content-header">
            <div id="settings-current-tab-title" style="font-size: 16px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
              ${this.getTabHeaderTitle(this.activeTab)}
            </div>
            <button id="modal-close" class="settings-back-btn" title="${t('common.back')} (ESC)">
              <span class="material-symbols-outlined md-18">close</span>
              <span class="esc-hint">ESC</span>
            </button>
          </div>

          <!-- Body Scroll Container -->
          <div class="settings-content-body">
            <div id="settings-error-banner" class="error-banner"></div>

            <div class="settings-tab-panel" id="tab-panel-account" style="${this.activeTab === 'account' ? '' : 'display: none;'}">
              ${this.accountTab.renderHtml()}
            </div>

            <div class="settings-tab-panel" id="tab-panel-voice_video" style="${this.activeTab === 'voice_video' ? '' : 'display: none;'}">
              ${this.voiceVideoTab.renderHtml()}
            </div>

            <div class="settings-tab-panel" id="tab-panel-soundboard" style="${this.activeTab === 'soundboard' ? '' : 'display: none;'}">
              ${this.soundboardTab.renderHtml()}
            </div>

            <div class="settings-tab-panel" id="tab-panel-stickers" style="${this.activeTab === 'stickers' ? '' : 'display: none;'}">
              ${this.stickersTab.renderHtml()}
            </div>

            <div class="settings-tab-panel" id="tab-panel-keybinds" style="${this.activeTab === 'keybinds' ? '' : 'display: none;'}">
              ${this.keybindsTab.renderHtml()}
            </div>

            <div class="settings-tab-panel" id="tab-panel-notifications" style="${this.activeTab === 'notifications' ? '' : 'display: none;'}">
              ${this.notificationsTab.renderHtml()}
            </div>

            <div class="settings-tab-panel" id="tab-panel-quality" style="${this.activeTab === 'quality' ? '' : 'display: none;'}">
              ${this.qualityTab.renderHtml()}
            </div>

            <div class="settings-tab-panel" id="tab-panel-logs" style="${this.activeTab === 'logs' ? '' : 'display: none;'}">
              ${this.logsTab.renderHtml()}
            </div>

            <div class="settings-tab-panel" id="tab-panel-about" style="${this.activeTab === 'about' ? '' : 'display: none;'}">
              ${this.aboutTab.renderHtml()}
            </div>
          </div>

          <!-- Footer -->
          <div class="modal-footer" style="padding: 12px 24px; border-top: 1px solid var(--border-color); margin: 0; background: var(--bg-secondary);">
            <button id="btn-settings-close" class="btn btn-primary">${t('common.done')}</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(this.modalEl);
    this.attachEvents();
    await this.voiceVideoTab.refreshDevices(this.modalEl);
    await this.aboutTab.loadAppVersion(this.modalEl);
    this.voiceVideoTab.startVadMeter(this.modalEl);
  }

  private getTabHeaderTitle(tab: string): string {
    switch (tab) {
      case 'voice_video':
        return `<span class="material-symbols-outlined" style="color: var(--accent-primary);">mic</span><span>${t('settings.tabVoiceVideo')}</span>`;
      case 'soundboard':
        return `<span class="material-symbols-outlined" style="color: var(--accent-primary);">music_note</span><span>${t('settings.tabSoundboard')}</span>`;
      case 'stickers':
        return `<span class="material-symbols-outlined" style="color: var(--accent-primary);">mood</span><span>${t('settings.tabStickers')}</span>`;
      case 'keybinds':
        return `<span class="material-symbols-outlined" style="color: var(--accent-primary);">keyboard</span><span>${t('settings.tabKeybinds')}</span>`;
      case 'notifications':
        return `<span class="material-symbols-outlined" style="color: var(--accent-primary);">notifications</span><span>${t('settings.tabNotifications')}</span>`;
      case 'quality':
        return `<span class="material-symbols-outlined" style="color: var(--accent-primary);">speed</span><span>${t('settings.tabQuality')}</span>`;
      case 'logs':
        return `<span class="material-symbols-outlined" style="color: var(--accent-primary);">description</span><span>${t('settings.tabLogs')}</span>`;
      case 'about':
        return `<span class="material-symbols-outlined" style="color: var(--accent-primary);">info</span><span>${t('settings.tabAbout')}</span>`;
      case 'account':
      default:
        return `<span class="material-symbols-outlined" style="color: var(--accent-primary);">person</span><span>${t('settings.tabAccount')}</span>`;
    }
  }

  private attachEvents(): void {
    if (!this.modalEl) return;

    // Tab switcher
    this.modalEl.querySelectorAll('.settings-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        if (tab) this.switchTab(tab);
      });
    });

    // Close handlers
    const closeModal = () => this.close();
    this.modalEl.querySelector('#modal-close')?.addEventListener('click', closeModal);
    this.modalEl.querySelector('#btn-settings-close')?.addEventListener('click', closeModal);
    enableBackdropClose(this.modalEl, closeModal);

    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const nestedModal = document.querySelector('.modal-backdrop:not(.modal-backdrop--settings)');
        if (!nestedModal) {
          closeModal();
        }
      }
    };
    window.addEventListener('keydown', onEsc);
    (this.modalEl as any)._escHandler = onEsc;

    // Attach sub-tab event listeners
    this.accountTab.attachEvents(this.modalEl, {
      onSaveNickname: async (name: string) => {
        if (serverStore.currentUser) {
          serverStore.currentUser.nickname = name;
          networkClient.send(MessageType.USER_CHANGE_NICKNAME, { newNickname: name });
        }
        connectionStore.saveUserProfile(name);
      },
      onAvatarChanged: async (base64: string) => {
        if (serverStore.currentUser) {
          serverStore.currentUser.avatarUrl = base64;
          networkClient.send(MessageType.USER_UPDATE_AVATAR, { avatarBase64: base64 });
        }
        connectionStore.saveUserProfile(serverStore.currentUser?.nickname || connectionStore.savedNickname, base64);
      },
      onReloadModal: () => {
        void this.open();
      },
      showError: (msg: string) => this.showError(msg),
      onVisibilityChanged: (appearOffline: boolean) => {
        networkClient.send(MessageType.USER_UPDATE_VISIBILITY, { appearOffline });
      },
    });

    this.voiceVideoTab.attachEvents(this.modalEl);
    this.soundboardTab.attachEvents(this.modalEl);
    this.stickersTab.attachEvents(this.modalEl);
    this.keybindsTab.attachEvents(this.modalEl);
    this.notificationsTab.attachEvents(this.modalEl);
    this.qualityTab.attachEvents(this.modalEl);
    this.logsTab.attachEvents(this.modalEl);
    this.aboutTab.attachEvents(this.modalEl);
  }

  private switchTab(tab: string): void {
    if (!this.modalEl) return;
    this.activeTab = tab;

    this.modalEl.querySelectorAll('.settings-tab-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });

    this.modalEl.querySelectorAll('.settings-tab-panel').forEach((panel) => {
      (panel as HTMLElement).style.display = panel.id === `tab-panel-${tab}` ? 'block' : 'none';
    });

    const header = this.modalEl.querySelector('#settings-current-tab-title');
    if (header) {
      header.innerHTML = this.getTabHeaderTitle(tab);
    }

    if (tab === 'voice_video') {
      this.voiceVideoTab.startVadMeter(this.modalEl);
    } else {
      this.voiceVideoTab.cleanup();
    }
  }

  private showError(msg: string): void {
    const banner = this.modalEl?.querySelector<HTMLElement>('#settings-error-banner');
    if (banner) {
      banner.textContent = msg;
      banner.style.display = 'block';
      setTimeout(() => {
        if (banner) banner.style.display = 'none';
      }, 5000);
    }
  }

  public close(): void {
    this.voiceVideoTab.cleanup();
    this.accountTab.cleanup();
    if (this.modalEl) {
      const handler = (this.modalEl as any)._escHandler;
      if (handler) window.removeEventListener('keydown', handler);
      this.modalEl.remove();
      this.modalEl = null;
    }
  }
}

export const settingsModal = new SettingsModal();
