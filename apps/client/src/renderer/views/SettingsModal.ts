import { sessionManager } from '../core/SessionManager';
import { gamePresence } from '../core/GamePresenceController';
import { serverStore } from '../stores/serverStore';
import { applyProfileEverywhere, recordProfileChange } from '../core/profileSync';
import { connectionStore } from '../stores/connectionStore';
import { t } from '../i18n';
import { html, trustedHtml } from '../utils/html';
import { openModal, type ModalShell } from '../utils/modalShell';
import { reportError } from '../utils/feedback';
import { AccountTab } from './settings/tabs/AccountTab';
import { VoiceVideoTab } from './settings/tabs/VoiceVideoTab';
import { SoundboardTab } from './settings/tabs/SoundboardTab';
import { StickersTab } from './settings/tabs/StickersTab';
import { KeybindsTab } from './settings/tabs/KeybindsTab';
import { NotificationsTab } from './settings/tabs/NotificationsTab';
import { QualityTab } from './settings/tabs/QualityTab';
import { LocalToolsTab } from './settings/tabs/LocalToolsTab';
import { LogsTab } from './settings/tabs/LogsTab';
import { AboutTab } from './settings/tabs/AboutTab';
import { SettingsSectionNavigation } from './settings/SettingsSectionNavigation';
import { renderSettingsTabButtons, renderSettingsTabLabel, selectSettingsTab, type SettingsTabEntry } from './settings/settingsLayout';
import { showLogoutDialog } from './LogoutDialog';

type SettingsTabId = 'account' | 'voice_video' | 'soundboard' | 'stickers' | 'keybinds' | 'notifications'
  | 'quality' | 'local_tools' | 'logs' | 'about';

/** A tab of the app's settings, declared once: its entry in the sidebar, its panel and its life. */
interface SettingsTab extends SettingsTabEntry {
  id: SettingsTabId;
  render(): string;
  /** Binds the rendered panel; a promise settles once content that loads on its own is in place. */
  attach(root: HTMLElement): void | Promise<void>;
  cleanup?(): void;
  /** The tab came on screen, or left it. */
  show?(root: HTMLElement): void;
  hide?(): void;
}

export class SettingsModal {
  private shell: ModalShell | null = null;
  private modalEl: HTMLElement | null = null;
  private activeTab: SettingsTabId = 'account';
  private sectionNavigation: SettingsSectionNavigation | null = null;

  private accountTab = new AccountTab();
  private voiceVideoTab = new VoiceVideoTab();
  private soundboardTab = new SoundboardTab();
  private stickersTab = new StickersTab();
  private keybindsTab = new KeybindsTab();
  private notificationsTab = new NotificationsTab();
  private qualityTab = new QualityTab();
  private localToolsTab = new LocalToolsTab();
  private logsTab = new LogsTab();
  private aboutTab = new AboutTab();

  private readonly tabs: readonly SettingsTab[] = [
    {
      id: 'account', icon: 'person', label: 'settings.tabAccount',
      render: () => this.accountTab.renderHtml(),
      attach: (root) => this.accountTab.attachEvents(root, {
        onSaveNickname: async (name: string) => {
          applyProfileEverywhere({ nickname: name });
          // The new name also reaches this identity's other devices and friends' DMs.
          void recordProfileChange({ nickname: true });
        },
        onAvatarChanged: async (base64: string) => {
          applyProfileEverywhere({ avatar: base64 });
          void recordProfileChange({ avatar: true });
        },
        onReloadModal: () => {
          void this.open();
        },
        showError: (msg: string) => { reportError(msg); },
        onPresenceChanged: (status) => {
          sessionManager.setPresenceStatus(status);
        },
        onGameActivityChanged: () => {
          void gamePresence.refresh();
        },
      }),
      cleanup: () => this.accountTab.cleanup(),
    },
    {
      id: 'voice_video', icon: 'mic', label: 'settings.tabVoiceVideo',
      render: () => this.voiceVideoTab.renderHtml(),
      attach: (root) => this.voiceVideoTab.attachEvents(root),
      cleanup: () => this.voiceVideoTab.cleanup(),
      show: (root) => {
        this.voiceVideoTab.startVadMeter(root);
        this.voiceVideoTab.activateCameraPreview();
      },
      hide: () => this.voiceVideoTab.deactivate(),
    },
    {
      id: 'soundboard', icon: 'music_note', label: 'settings.tabSoundboard',
      render: () => this.soundboardTab.renderHtml(),
      attach: (root) => this.soundboardTab.attachEvents(root),
      cleanup: () => this.soundboardTab.cleanup(),
    },
    {
      id: 'stickers', icon: 'mood', label: 'settings.tabStickers',
      render: () => this.stickersTab.renderHtml(),
      attach: (root) => this.stickersTab.attachEvents(root),
    },
    {
      id: 'keybinds', icon: 'keyboard', label: 'settings.tabKeybinds',
      render: () => this.keybindsTab.renderHtml(),
      attach: (root) => this.keybindsTab.attachEvents(root),
    },
    {
      id: 'notifications', icon: 'notifications', label: 'settings.tabNotifications',
      render: () => this.notificationsTab.renderHtml(),
      attach: (root) => this.notificationsTab.attachEvents(root),
      cleanup: () => this.notificationsTab.cleanup(),
    },
    {
      id: 'quality', icon: 'speed', label: 'settings.tabQuality',
      render: () => this.qualityTab.renderHtml(),
      attach: (root) => this.qualityTab.attachEvents(root),
      cleanup: () => this.qualityTab.cleanup(),
      show: () => this.qualityTab.activate(),
      hide: () => this.qualityTab.deactivate(),
    },
    {
      id: 'local_tools', icon: 'build', label: 'settings.tabLocalTools',
      render: () => this.localToolsTab.renderHtml(),
      attach: (root) => this.localToolsTab.attachEvents(root),
      cleanup: () => this.localToolsTab.cleanup(),
    },
    {
      id: 'logs', icon: 'description', label: 'settings.tabLogs',
      render: () => this.logsTab.renderHtml(),
      attach: (root) => this.logsTab.attachEvents(root),
    },
    {
      id: 'about', icon: 'info', label: 'settings.tabAbout', separated: true,
      render: () => this.aboutTab.renderHtml(),
      attach: (root) => this.aboutTab.attachEvents(root),
      cleanup: () => this.aboutTab.cleanup(),
    },
  ];

  public async open(
    tab?: 'voice_video' | 'local_tools',
    section?: 'camera' | 'noise-suppression' | 'local-tools-storage' | 'local-tools-tools' | 'local-tools-permissions' | 'local-tools-tasks',
  ): Promise<void> {
    this.close();
    if (tab) this.activeTab = tab;
    const active = this.tab(this.activeTab);

    const shell = openModal({
      backdropClass: 'modal-backdrop--settings',
      card: html`
      <div class="modal-card settings-modal-card" aria-labelledby="settings-current-tab-title">
        <div class="settings-sidebar">
          ${renderSettingsTabButtons(this.tabs, this.activeTab)}
          <button type="button" id="settings-logout-btn" class="settings-logout-btn">
            <span class="material-symbols-outlined md-18" aria-hidden="true">logout</span>
            <span>${t('settings.logout')}</span>
          </button>
        </div>

        <div class="settings-main-container">
          <div class="settings-content-header">
            <div id="settings-current-tab-title" class="settings-tab-title">${renderSettingsTabLabel(active)}</div>
            <button type="button" id="modal-close" class="settings-back-btn" data-modal-close title="${t('common.back')} (ESC)" aria-label="${t('common.close')}">
              <span class="material-symbols-outlined md-18" aria-hidden="true">close</span>
              <span class="esc-hint" aria-hidden="true">ESC</span>
            </button>
          </div>

          <div class="settings-content-body">
            ${this.tabs.map(entry => html`<div class="settings-tab-panel" id="tab-panel-${entry.id}" ${entry.id === this.activeTab ? null : html`hidden`}>
              ${trustedHtml(entry.render())}
            </div>`)}
          </div>

          <div class="modal-footer" style="padding: 12px 24px; border-top: 1px solid var(--border-color); margin: 0; background: var(--bg-secondary);">
            <button type="button" id="btn-settings-close" class="btn btn-primary" data-modal-close>${t('common.done')}</button>
          </div>
        </div>
      </div>
    `,
      initialFocus: `.settings-tab-btn[data-tab="${this.activeTab}"]`,
      onClose: () => { if (this.shell === shell) this.teardown(); },
    });
    this.shell = shell;
    this.modalEl = shell.element;

    const localToolsReady = this.attachEvents(shell.element);
    this.sectionNavigation = new SettingsSectionNavigation(shell.element);
    this.sectionNavigation.setTab(this.activeTab);
    if (section && this.activeTab !== 'local_tools') this.sectionNavigation.revealSection(section);
    if (this.activeTab === 'voice_video') {
      this.voiceVideoTab.activateCameraPreview();
    }
    if (this.activeTab === 'quality') this.qualityTab.activate();
    const modal = shell.element;
    await Promise.all([
      this.voiceVideoTab.refreshDevices(modal).then(() => {
        if (this.modalEl === modal && this.activeTab === 'voice_video') this.voiceVideoTab.startVadMeter(modal);
      }),
      this.aboutTab.loadAppVersion(modal),
      localToolsReady.then(() => {
        if (section && this.modalEl === modal && this.activeTab === 'local_tools') this.sectionNavigation?.revealSection(section);
      }),
    ]);
  }

  private tab(id: SettingsTabId): SettingsTab {
    return this.tabs.find(entry => entry.id === id) ?? this.tabs[0];
  }

  /** Binds every tab; resolves when the local tools finished loading. */
  private attachEvents(root: HTMLElement): Promise<void> {
    const signal = this.shell?.signal;
    root.querySelectorAll<HTMLButtonElement>('.settings-tab-btn[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = this.tabs.find(entry => entry.id === button.dataset.tab);
        if (target) this.switchTab(target.id);
      }, { signal });
    });
    root.querySelector('#settings-logout-btn')?.addEventListener('click', () => {
      void showLogoutDialog();
    }, { signal });
    let ready: Promise<void> = Promise.resolve();
    for (const entry of this.tabs) {
      const attached = entry.attach(root);
      if (entry.id === 'local_tools' && attached) ready = attached;
    }
    return ready;
  }

  private switchTab(id: SettingsTabId): void {
    const root = this.modalEl;
    if (!root || id === this.activeTab) return;
    const previous = this.tab(this.activeTab);
    const next = this.tab(id);
    this.activeTab = id;
    selectSettingsTab(root, id);
    root.querySelectorAll<HTMLElement>('.settings-tab-panel').forEach((panel) => {
      panel.hidden = panel.id !== `tab-panel-${id}`;
    });
    const header = root.querySelector('#settings-current-tab-title');
    if (header) header.innerHTML = renderSettingsTabLabel(next).toString();
    this.sectionNavigation?.setTab(id);
    previous.hide?.();
    next.show?.(root);
  }

  public close(): void {
    if (this.shell) this.shell.close('api');
    else this.teardown();
  }

  private teardown(): void {
    this.sectionNavigation?.destroy();
    this.sectionNavigation = null;
    for (const entry of this.tabs) entry.cleanup?.();
    this.shell = null;
    this.modalEl = null;
  }
}

export const settingsModal = new SettingsModal();
