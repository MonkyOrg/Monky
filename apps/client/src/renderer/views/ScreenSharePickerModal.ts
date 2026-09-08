import { MessageType } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { appEvents } from '../core/EventBus';
import { enableBackdropClose } from '../utils/modal';
import { networkClient } from '../core/NetworkClient';
import { callClient } from '../core/serverConnection';
import { screenAudioService } from '../core/ScreenAudioService';
import { videoService } from '../core/VideoService';
import { voiceStore, VoiceStore } from '../stores/voiceStore';
import { webRtcManager } from '../core/WebRtcManager';
import { settingsStore } from '../stores/settingsStore';
import { setButtonLoading } from '../utils/buttonLoading';
import { showAlert, showConfirm } from './Dialog';
import { t } from '../i18n';

type DesktopSource = {
  id: string;
  name: string;
  type: 'screen' | 'window';
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
};

export class ScreenSharePickerModal {
  private modalEl: HTMLElement | null = null;
  private selectedSourceId: string | null = null;
  private activeTab: 'screen' | 'window' = 'screen';
  private isStarting = false;

  /** ScreenCaptureKit can only capture the whole system audio (#298). */
  private get isMac(): boolean {
    return window.api?.platform === 'darwin';
  }

  /**
   * Label for the "share audio" toggle. On Windows a shared window captures
   * only that app's audio, so the label can promise "app audio". On macOS the
   * OS captures the whole system mix even for a single window (#298), so the
   * label must be honest instead of promising something we cannot deliver.
   */
  private audioToggleLabel(tab: 'screen' | 'window'): string {
    if (screenAudioService.getIsCapturing()) return t('screenShare.audioAlreadySharing');
    if (tab === 'window') {
      return this.isMac
        ? t('screenShare.shareAudioMacWindow')
        : t('screenShare.shareAppAudio');
    }
    return t('screenShare.shareAudio');
  }

  public async open(): Promise<void> {
    this.close();

    // macOS can silently deny capture after an update (#327); the picker would
    // only show black thumbnails, so ask the main process to sort it out first.
    if (window.api?.ensureScreenPermission && !(await window.api.ensureScreenPermission())) {
      return;
    }

    let sources: DesktopSource[] = [];
    if (window.api?.getDesktopSources) {
      sources = (await window.api.getDesktopSources()) as DesktopSource[];
    }

    // When there is nothing on a given tab, fall back to the one that has sources.
    const hasScreens = sources.some((s) => s.type === 'screen');
    if (!hasScreens && sources.some((s) => s.type === 'window')) {
      this.activeTab = 'window';
    }

    const alreadySharing = voiceStore.isScreenSharing;
    const audioAlreadyCaptured = screenAudioService.getIsCapturing();

    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal-backdrop';
    this.modalEl.innerHTML = `
      <div class="modal-card" style="max-width: 680px;">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);">screen_share</span>
            <span>${alreadySharing ? t('screenShare.titleSwitch') : t('screenShare.title')}</span>
          </div>
          <button id="modal-close" class="modal-close-btn">&times;</button>
        </div>

        ${alreadySharing ? `
          <div class="share-active-banner">
            <span class="live-pulse-dot"></span>
            <span>${t('screenShare.alreadySharingNotice')}</span>
          </div>
        ` : ''}

        <div class="nav-tabs" style="margin-bottom: 12px;">
          <button type="button" id="share-tab-screen" class="tab-button ${this.activeTab === 'screen' ? 'active' : ''}">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px; vertical-align: middle;">desktop_windows</span>
            ${t('screenShare.screensTab')}
          </button>
          <button type="button" id="share-tab-window" class="tab-button ${this.activeTab === 'window' ? 'active' : ''}">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px; vertical-align: middle;">web_asset</span>
            ${t('screenShare.windowsTab')}
          </button>
        </div>

        <div id="share-sources-panel"></div>

        <div class="modal-footer">
          <label id="share-audio-label" style="display: flex; align-items: center; gap: 8px; margin-right: auto; cursor: ${audioAlreadyCaptured ? 'not-allowed' : 'pointer'}; font-size: 0.85rem; color: var(--text-secondary); ${audioAlreadyCaptured ? 'opacity: 0.5;' : ''}">
            <span class="material-symbols-outlined md-16">volume_up</span>
            <span id="share-audio-text">${audioAlreadyCaptured ? t('screenShare.audioAlreadySharing') : this.audioToggleLabel(this.activeTab)}</span>
            <label class="toggle-switch" style="margin-left: 4px;">
              <input type="checkbox" id="chk-share-audio" ${audioAlreadyCaptured ? 'disabled' : (!screenAudioService.getIsTestTone() ? 'checked' : '')} />
              <span class="toggle-slider"></span>
            </label>
          </label>
          <button type="button" id="btn-cancel" class="btn btn-secondary">${t('common.cancel')}</button>
          ${alreadySharing && voiceStore.canAddScreenShare() ? `
            <button type="button" id="btn-share-add" class="btn btn-secondary" disabled>
              <span class="material-symbols-outlined md-16" style="margin-right: 4px;">add_to_queue</span>
              ${t('screenShare.confirmAdd')}
            </button>
          ` : ''}
          <button type="button" id="btn-share" class="btn btn-primary" disabled>
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">present_to_all</span>
            ${alreadySharing ? t('screenShare.confirmSwitch') : t('screenShare.confirm')}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(this.modalEl);
    this.renderSources(sources);
    this.attachEvents(sources);
    // Signal that the picker is now visible so the triggering button can clear
    // its loading state (loading should last only until the modal opens) (#48).
    appEvents.emit('modal.screenshare_picker_opened');
  }

  private renderSources(sources: DesktopSource[]): void {
    const panel = this.modalEl?.querySelector('#share-sources-panel');
    if (!panel) return;

    const filtered = sources.filter((s) => s.type === this.activeTab);
    const activeSourceIds = videoService.getActiveSourceIds();
    const available = filtered.filter((s) => !activeSourceIds.has(s.id));

    if (available.length === 0) {
      panel.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--text-muted);">
          ${this.activeTab === 'screen'
            ? t('screenShare.noScreens')
            : t('screenShare.noWindows')}
        </div>
      `;
      return;
    }

    panel.innerHTML = `
      ${this.renderGameTipHtml()}
      <div class="screen-sources-grid">
        ${available.map((s) => `
          <div class="source-item ${this.selectedSourceId === s.id ? 'selected' : ''}" data-source-id="${escapeHtml(s.id)}">
            ${s.thumbnailDataUrl
              ? `<img class="source-thumbnail" src="${s.thumbnailDataUrl}" alt="${escapeHtml(s.name)}">`
              : `<div class="source-thumbnail source-thumbnail--minimized">
                  <span class="material-symbols-outlined">web_asset</span>
                  <span class="source-thumbnail-label">${t('screenShare.minimizedNoPreview')}</span>
                </div>`}
            <div class="source-name" title="${escapeHtml(s.name)}">
              ${s.appIconDataUrl
                ? `<img class="source-app-icon" src="${s.appIconDataUrl}" alt="">`
                : `<span class="material-symbols-outlined source-app-icon-fallback">${s.type === 'screen' ? 'desktop_windows' : 'web_asset'}</span>`}
              ${escapeHtml(s.name)}
            </div>
          </div>
        `).join('')}
      </div>
    `;

    this.attachSourceEvents();
  }

  /**
   * Tells people how to share a game without paying for it in frame rate (#526).
   *
   * Both tips are only worth showing when they are actionable: pointing at the
   * Apps tab makes no sense once you are already on it, and the codec advice is
   * noise for someone already on the Gaming preset, where "Automatic" picks
   * H.264 on its own.
   */
  private renderGameTipHtml(): string {
    const tips: string[] = [];
    if (this.activeTab === 'screen') tips.push(t('screenShare.gameTipWindow'));
    if (settingsStore.qualityPreset !== 'GAMING') tips.push(t('screenShare.gameTipCodec'));
    if (tips.length === 0) return '';

    return `
      <div class="share-game-tip">
        <span class="material-symbols-outlined md-18">sports_esports</span>
        <span>${tips.join(' ')}</span>
      </div>
    `;
  }

  private attachSourceEvents(): void {
    if (!this.modalEl) return;
    const confirmButtons = this.modalEl.querySelectorAll(
      '#btn-share, #btn-share-add'
    ) as NodeListOf<HTMLButtonElement>;
    const sourceItems = this.modalEl.querySelectorAll('.source-item');

    sourceItems.forEach((item) => {
      item.addEventListener('click', () => {
        sourceItems.forEach((i) => i.classList.remove('selected'));
        item.classList.add('selected');
        this.selectedSourceId = item.getAttribute('data-source-id');
        confirmButtons.forEach((btn) => { btn.disabled = false; });
      });

      item.addEventListener('dblclick', () => {
        this.selectedSourceId = item.getAttribute('data-source-id');
        // Double-click keeps the historical "switch source" shortcut (#264).
        this.startSharing('replace');
      });
    });
  }

  private attachEvents(sources: DesktopSource[]): void {
    if (!this.modalEl) return;

    const btnClose = this.modalEl.querySelector('#modal-close');
    const btnCancel = this.modalEl.querySelector('#btn-cancel');
    const btnShare = this.modalEl.querySelector('#btn-share') as HTMLButtonElement;
    const btnShareAdd = this.modalEl.querySelector('#btn-share-add') as HTMLButtonElement | null;
    const tabScreen = this.modalEl.querySelector('#share-tab-screen');
    const tabWindow = this.modalEl.querySelector('#share-tab-window');

    btnClose?.addEventListener('click', () => this.close());
    enableBackdropClose(this.modalEl, () => this.close());
    btnCancel?.addEventListener('click', () => this.close());
    btnShare?.addEventListener('click', () => this.startSharing('replace'));
    btnShareAdd?.addEventListener('click', () => this.startSharing('add'));

    const switchTab = (tab: 'screen' | 'window') => {
      this.activeTab = tab;
      this.selectedSourceId = null;
      if (btnShare) btnShare.disabled = true;
      if (btnShareAdd) btnShareAdd.disabled = true;
      tabScreen?.classList.toggle('active', tab === 'screen');
      tabWindow?.classList.toggle('active', tab === 'window');
      const audioText = this.modalEl?.querySelector('#share-audio-text');
      if (audioText) {
        // Keep the "audio already being shared" warning across tab switches (#315)
        audioText.textContent = this.audioToggleLabel(tab);
      }
      this.renderSources(sources);
    };

    tabScreen?.addEventListener('click', () => switchTab('screen'));
    tabWindow?.addEventListener('click', () => switchTab('window'));
  }

  /**
   * Starts a screen share. 'replace' keeps the historical behaviour of swapping
   * the current source (#264); 'add' broadcasts an extra screen alongside the
   * existing ones, up to VoiceStore.MAX_SCREEN_SHARES (#253).
   */
  private async startSharing(mode: 'add' | 'replace'): Promise<void> {
    if (this.isStarting) return;
    if (mode === 'add' && !voiceStore.canAddScreenShare()) {
      await showAlert({
        title: t('screenShare.limitTitle'),
        message: t('screenShare.limitMessage', { max: String(VoiceStore.MAX_SCREEN_SHARES) }),
        variant: 'warning',
      });
      return;
    }

    // On macOS ScreenCaptureKit cannot isolate a single window's audio: enabling
    // audio for a window share broadcasts the entire system mix — other apps,
    // notifications, other calls (#298). Warn explicitly before starting so the
    // user is not surprised. Shown before anything is torn down so cancelling is
    // a clean no-op.
    const audioChk = this.modalEl?.querySelector('#chk-share-audio') as HTMLInputElement | null;
    const sharingWindow = (this.selectedSourceId ?? '').startsWith('window:');
    if (this.isMac && sharingWindow && audioChk?.checked && !screenAudioService.getIsCapturing()) {
      const proceed = await showConfirm({
        title: t('screenShare.macSystemAudioWarnTitle'),
        message: t('screenShare.macSystemAudioWarnMessage'),
        confirmLabel: t('screenShare.macSystemAudioWarnConfirm'),
        variant: 'warning',
      });
      if (!proceed) return;
    }

    this.isStarting = true;
    const btnShare = this.modalEl?.querySelector('#btn-share') as HTMLButtonElement | null;
    const btnShareAdd = this.modalEl?.querySelector('#btn-share-add') as HTMLButtonElement | null;
    const btnCancel = this.modalEl?.querySelector('#btn-cancel') as HTMLButtonElement | null;
    const btnClose = this.modalEl?.querySelector('#modal-close') as HTMLButtonElement | null;
    const targetBtn = mode === 'add' && btnShareAdd ? btnShareAdd : btnShare;

    setButtonLoading(targetBtn, true);
    if (btnShare && btnShare !== targetBtn) btnShare.disabled = true;
    if (btnShareAdd && btnShareAdd !== targetBtn) btnShareAdd.disabled = true;
    if (btnCancel) btnCancel.disabled = true;
    if (btnClose) btnClose.disabled = true;

    try {
      // Acquire the new capture BEFORE tearing anything down: if the user
      // cancels the OS picker or the source vanished, the current share must
      // survive untouched instead of leaving local and server state disagreeing.
      const previousShareIds = mode === 'replace' ? [...voiceStore.screenShareIds] : [];
      const stream = await videoService.startScreenShare(this.selectedSourceId || undefined);

      for (const previousId of previousShareIds) {
        videoService.stopScreenShare(previousId);
        await webRtcManager.removeLocalScreenTrack(previousId);
        voiceStore.removeScreenShare(previousId);
      }

      await webRtcManager.addLocalScreenTrack(stream);
      voiceStore.addScreenShare(stream.id);
      // Camera and screen are independent (#26) — do not disturb camera state.
      callClient().send(MessageType.VOICE_STATE_UPDATE, {
        screenShareIds: voiceStore.screenShareIds,
        isScreenSharing: true,
      });

      // Start or stop screen audio capture based on checkbox. When sharing a
      // single window, pass its source id so only that app's audio is captured.
      // Only one share may carry system audio at a time (#253), so starting it
      // for a new share replaces whatever was capturing before.
      const chk = this.modalEl?.querySelector('#chk-share-audio') as HTMLInputElement | null;
      if (chk?.checked) {
        if (screenAudioService.getIsCapturing()) {
          await screenAudioService.stop();
        }
        const audioTrack = await screenAudioService.start(this.selectedSourceId || undefined);
        if (audioTrack) {
          voiceStore.setScreenAudioShare(stream.id);
        } else {
          console.warn('[ScreenShare] Screen audio capture not available or failed to start');
        }
      }

      this.close();
    } catch (err: any) {
      await showAlert({
        title: t('screenShare.errorTitle'),
        message: t('screenShare.errorMessage', { error: err.message }),
        variant: 'danger',
      });
    } finally {
      this.isStarting = false;
      if (this.modalEl) {
        setButtonLoading(targetBtn, false);
        if (btnShare) btnShare.disabled = !this.selectedSourceId;
        if (btnShareAdd) btnShareAdd.disabled = !this.selectedSourceId;
        if (btnCancel) btnCancel.disabled = false;
        if (btnClose) btnClose.disabled = false;
      }
    }
  }


  public close(): void {
    const wasOpen = this.modalEl !== null;
    if (this.modalEl) {
      this.modalEl.remove();
      this.modalEl = null;
      this.selectedSourceId = null;
      this.isStarting = false;
    }
    // Let callers (e.g. the screen-share button loading state) know the picker
    // is no longer open, including on cancel (#48). Only emit when something was
    // actually open, otherwise the close() call at the start of open() would
    // instantly clear the button loading before the picker even appears.
    if (wasOpen) {
      appEvents.emit('modal.screenshare_picker_closed');
    }
  }
}

export const screenSharePickerModal = new ScreenSharePickerModal();
