import { MessageType, type DesktopSource, type NativeScreenCapabilities } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { appEvents } from '../core/EventBus';
import { enableBackdropClose } from '../utils/modal';
import { callClient } from '../core/serverConnection';
import { screenAudioService } from '../core/ScreenAudioService';
import { captureScreenShareCall, notifyScreenShareState, stopLocalScreenShares } from '../core/screenShareControls';
import { videoService } from '../core/VideoService';
import { voiceStore, VoiceStore } from '../stores/voiceStore';
import { webRtcManager } from '../core/WebRtcManager';
import { settingsStore } from '../stores/settingsStore';
import { setButtonLoading } from '../utils/buttonLoading';
import { renderLoadingError, renderLoadingSkeleton } from '../utils/loadingSkeleton';
import { showAlert, showConfirm } from './Dialog';
import { t } from '../i18n';
import { nativeScreenProfile } from '../core/webrtc/NativeScreenController';

type SourceLoadState =
  | { status: 'loading' }
  | { status: 'ready'; sources: DesktopSource[] }
  | { status: 'error' };

export class ScreenSharePickerModal {
  private modalEl: HTMLElement | null = null;
  private selectedSourceId: string | null = null;
  private activeTab: 'screen' | 'window' = 'screen';
  private isStarting = false;
  private sourceState: SourceLoadState = { status: 'loading' };
  private sourceRequest = 0;
  private nativeCapabilities: NativeScreenCapabilities | null = null;

  private hasScreenAudio(): boolean {
    return voiceStore.screenAudioShareId !== null || screenAudioService.getIsCapturing();
  }

  private usesNativeCapture(sourceId: string | undefined, audio: boolean): boolean {
    return !!sourceId?.startsWith('window:') && this.nativeCapabilities?.capture === true
      && (!audio || this.nativeCapabilities.captureAudio)
      && (settingsStore.preferredVideoCodec === 'auto' || settingsStore.preferredVideoCodec === 'h264')
      && nativeScreenProfile(videoService.getProfile()) !== null;
  }

  private updateCaptureInfo(): void {
    const info = this.modalEl?.querySelector<HTMLElement>('#share-capture-info');
    if (!info) return;
    const audio = this.modalEl?.querySelector<HTMLInputElement>('#chk-share-audio')?.checked ?? false;
    const native = this.usesNativeCapture(this.selectedSourceId ?? `${this.activeTab}:`, audio);
    const profile = native ? nativeScreenProfile(videoService.getProfile()) : null;
    info.textContent = profile ? t('screenShare.nativeBackend', {
      width: profile.width, height: profile.height, fps: profile.fps, bitrate: profile.maxBitrateKbps,
    }) : t('screenShare.browserBackend');
    info.dataset.backend = native ? 'native' : 'browser';
  }

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
    if (this.hasScreenAudio()) return t('screenShare.audioAlreadySharing');
    if (tab === 'window') {
      return this.isMac
        ? t('screenShare.shareAudioMacWindow')
        : t('screenShare.shareAppAudio');
    }
    return t('screenShare.shareAudio');
  }

  public async open(): Promise<void> {
    this.close();

    const alreadySharing = voiceStore.isScreenSharing;
    const audioAlreadyCaptured = this.hasScreenAudio();

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

        <div id="share-sources-panel" aria-busy="true"></div>
        <p id="share-capture-info" class="share-game-tip" role="status"></p>

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

    const modal = this.modalEl;
    document.body.appendChild(modal);
    this.renderSources();
    this.attachEvents();
    // Signal that the picker is now visible so the triggering button can clear
    // its loading state (loading should last only until the modal opens) (#48).
    appEvents.emit('modal.screenshare_picker_opened');
    if (this.modalEl === modal) await this.loadSources(modal);
  }

  private async loadSources(modal: HTMLElement): Promise<void> {
    const request = ++this.sourceRequest;
    const isCurrent = (): boolean => this.modalEl === modal && this.sourceRequest === request;
    this.sourceState = { status: 'loading' };
    this.renderSources();
    try {
      // Permission still precedes enumeration, but no longer hides the picker.
      if (window.api?.ensureScreenPermission && !(await window.api.ensureScreenPermission())) {
        if (isCurrent()) this.close();
        return;
      }
      if (!isCurrent()) return;
      if (!window.api?.getDesktopSources) throw new Error('Desktop source enumeration is unavailable');
      const [sources, capabilities] = await Promise.all([
        window.api.getDesktopSources(),
        typeof window.api.nativeScreenCommand === 'function' ? webRtcManager.getNativeScreenCapabilities() : Promise.resolve(null),
      ]);
      if (!isCurrent()) return;
      this.nativeCapabilities = capabilities;
      this.sourceState = { status: 'ready', sources };
      if (!sources.some(source => source.type === 'screen') && sources.some(source => source.type === 'window')) {
        this.selectTab('window');
      } else {
        this.renderSources();
      }
      this.updateCaptureInfo();
    } catch (error: unknown) {
      if (!isCurrent()) return;
      console.error('[ScreenShare] Could not load capture sources', error);
      this.sourceState = { status: 'error' };
      this.renderSources();
    }
  }

  private renderSources(): void {
    const panel = this.modalEl?.querySelector('#share-sources-panel');
    if (!panel) return;
    panel.setAttribute('aria-busy', String(this.sourceState.status === 'loading'));
    if (this.sourceState.status === 'loading') {
      panel.innerHTML = renderLoadingSkeleton('cards', 2);
      return;
    }
    if (this.sourceState.status === 'error') {
      panel.innerHTML = renderLoadingError(t('screenShare.loadFailed'));
      const modal = this.modalEl;
      panel.querySelector('[data-loading-retry]')?.addEventListener('click', () => {
        if (modal && this.modalEl === modal) void this.loadSources(modal);
      });
      return;
    }

    const filtered = this.sourceState.sources.filter((s) => s.type === this.activeTab);
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
          <div class="source-item ${this.selectedSourceId === s.id ? 'selected' : ''}" data-source-id="${escapeHtml(s.id)}"
            role="button" tabindex="0" aria-pressed="${this.selectedSourceId === s.id}">
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
      const select = () => {
        sourceItems.forEach((i) => { i.classList.remove('selected'); i.setAttribute('aria-pressed', 'false'); });
        item.classList.add('selected');
        item.setAttribute('aria-pressed', 'true');
        this.selectedSourceId = item.getAttribute('data-source-id');
        confirmButtons.forEach((btn) => { btn.disabled = false; });
        this.updateCaptureInfo();
      };
      item.addEventListener('click', select);
      item.addEventListener('keydown', event => {
        if (event instanceof KeyboardEvent && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          select();
        }
      });

      item.addEventListener('dblclick', () => {
        this.selectedSourceId = item.getAttribute('data-source-id');
        // Double-click keeps the historical "switch source" shortcut (#264).
        this.startSharing('replace');
      });
    });
  }

  private selectTab(tab: 'screen' | 'window'): void {
    this.activeTab = tab;
    this.selectedSourceId = null;
    this.modalEl?.querySelectorAll<HTMLButtonElement>('#btn-share, #btn-share-add')
      .forEach(button => { button.disabled = true; });
    this.modalEl?.querySelector('#share-tab-screen')?.classList.toggle('active', tab === 'screen');
    this.modalEl?.querySelector('#share-tab-window')?.classList.toggle('active', tab === 'window');
    const audioText = this.modalEl?.querySelector('#share-audio-text');
    if (audioText) audioText.textContent = this.audioToggleLabel(tab);
    this.renderSources();
    this.updateCaptureInfo();
  }

  private attachEvents(): void {
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

    tabScreen?.addEventListener('click', () => this.selectTab('screen'));
    tabWindow?.addEventListener('click', () => this.selectTab('window'));
    this.modalEl.querySelector('#chk-share-audio')?.addEventListener('change', () => this.updateCaptureInfo());
  }

  /**
   * Starts a screen share. 'replace' keeps the historical behaviour of swapping
   * the current source (#264); 'add' broadcasts an extra screen alongside the
   * existing ones, up to VoiceStore.MAX_SCREEN_SHARES (#253).
   */
  private async startSharing(mode: 'add' | 'replace'): Promise<void> {
    if (this.isStarting || !this.modalEl) return;
    if (mode === 'add' && !voiceStore.canAddScreenShare()) {
      await showAlert({
        title: t('screenShare.limitTitle'),
        message: t('screenShare.limitMessage', { max: String(VoiceStore.MAX_SCREEN_SHARES) }),
        variant: 'warning',
      });
      return;
    }

    const modal = this.modalEl;
    const sourceId = this.selectedSourceId || undefined;
    const shareAudio = modal.querySelector<HTMLInputElement>('#chk-share-audio')?.checked ?? false;
    const call = captureScreenShareCall();
    let stream: MediaStream | null = null;
    let published = false;
    const assertCurrent = () => {
      if (this.modalEl !== modal || !call.isCurrent()
        || (stream && (videoService.getScreenStream(stream.id) !== stream
          || (!videoService.getNativeScreenCapture(stream.id) && stream.getVideoTracks()[0]?.readyState !== 'live')))) {
        throw new DOMException('Screen share was cancelled', 'AbortError');
      }
    };
    this.isStarting = true;
    const btnShare = modal.querySelector<HTMLButtonElement>('#btn-share');
    const btnShareAdd = modal.querySelector<HTMLButtonElement>('#btn-share-add');
    const btnCancel = modal.querySelector<HTMLButtonElement>('#btn-cancel');
    const btnClose = modal.querySelector<HTMLButtonElement>('#modal-close');
    const targetBtn = mode === 'add' && btnShareAdd ? btnShareAdd : btnShare;

    setButtonLoading(targetBtn, true);
    if (btnShare && btnShare !== targetBtn) btnShare.disabled = true;
    if (btnShareAdd && btnShareAdd !== targetBtn) btnShareAdd.disabled = true;
    if (btnCancel) btnCancel.disabled = true;
    if (btnClose) btnClose.disabled = true;

    try {
      // ScreenCaptureKit captures the entire system mix even for one window.
      // Confirm before capturing or replacing anything (#298).
      if (this.isMac && sourceId?.startsWith('window:') && shareAudio && !screenAudioService.getIsCapturing()) {
        const proceed = await showConfirm({
          title: t('screenShare.macSystemAudioWarnTitle'),
          message: t('screenShare.macSystemAudioWarnMessage'),
          confirmLabel: t('screenShare.macSystemAudioWarnConfirm'),
          variant: 'warning',
        });
        if (!proceed) return;
      }
      assertCurrent();
      const native = this.usesNativeCapture(sourceId, shareAudio);
      if (!native) webRtcManager.assertScreenShareSupported();
      // Acquire the new capture BEFORE tearing anything down: if the user
      // cancels the OS picker or the source vanished, the current share must
      // survive untouched instead of leaving local and server state disagreeing.
      const previousShareIds = mode === 'replace' ? [...voiceStore.screenShareIds] : [];
      if (native && sourceId) {
        const restored = await window.api.prepareScreenShareWindow(sourceId);
        if (restored) await new Promise(resolve => setTimeout(resolve, 350));
        assertCurrent();
        const thumbnail = this.sourceState.status === 'ready'
          ? this.sourceState.sources.find(source => source.id === sourceId)?.thumbnailDataUrl ?? '' : '';
        stream = await webRtcManager.startNativeScreenShare(sourceId, shareAudio, thumbnail,
          () => this.modalEl === modal && call.isCurrent());
      } else stream = await videoService.startScreenShare(sourceId);
      assertCurrent();
      if (!native) webRtcManager.assertScreenShareSupported();
      if (previousShareIds.length > 0) {
        await stopLocalScreenShares(screenAudioService, { shareIds: previousShareIds, notify: false });
      }

      assertCurrent();
      if (!native) await webRtcManager.addLocalScreenTrack(stream);
      else if (shareAudio) {
        await screenAudioService.stop();
        assertCurrent();
        voiceStore.setScreenAudioShare(stream.id);
      }
      assertCurrent();
      voiceStore.addScreenShare(stream.id);
      // Camera and screen are independent (#26) — do not disturb camera state.
      notifyScreenShareState(call);
      published = true;

      if (shareAudio && !native) {
        await screenAudioService.stop();
        if (!call.isCurrent() || videoService.getScreenStream(stream.id) !== stream) {
          throw new DOMException('Screen share was cancelled', 'AbortError');
        }
        // Associate before awaiting startup so source-ended also cancels audio
        // that has not finished acquiring its native capture yet.
        voiceStore.setScreenAudioShare(stream.id);
        let audioTrack: MediaStreamTrack | null = null;
        try {
          audioTrack = await screenAudioService.start(sourceId);
        } finally {
          if (!audioTrack && voiceStore.screenAudioShareId === stream.id) voiceStore.setScreenAudioShare(null);
        }
        if (!audioTrack) {
          console.warn('[ScreenShare] Screen audio capture not available or failed to start');
        }
      }

      if (this.modalEl === modal) this.close();
    } catch (err) {
      if (stream && !published && videoService.getScreenStream(stream.id) === stream) {
        try {
          if (call.isCurrent()) await stopLocalScreenShares(screenAudioService, { shareIds: [stream.id] });
          else videoService.stopScreenShare(stream.id);
        } catch (cleanupError) {
          console.warn('[ScreenShare] Failed to finish cancelled screen cleanup', cleanupError);
        }
      }
      if ((err instanceof Error && err.name === 'AbortError') || this.modalEl !== modal || !call.isCurrent()) {
        if (this.modalEl === modal) this.close();
        return;
      }
      await showAlert({
        title: t('screenShare.errorTitle'),
        message: t('screenShare.errorMessage', { error: err instanceof Error ? err.message : String(err) }),
        variant: 'danger',
      });
    } finally {
      if (this.modalEl === modal) {
        this.isStarting = false;
        setButtonLoading(targetBtn, false);
        if (btnShare) btnShare.disabled = !this.selectedSourceId;
        if (btnShareAdd) btnShareAdd.disabled = !this.selectedSourceId;
        if (btnCancel) btnCancel.disabled = false;
        if (btnClose) btnClose.disabled = false;
      }
    }
  }


  public close(): void {
    this.sourceRequest++;
    this.sourceState = { status: 'loading' };
    const wasOpen = this.modalEl !== null;
    if (this.modalEl) {
      if (this.isStarting) videoService.cancelPendingScreenShare();
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
