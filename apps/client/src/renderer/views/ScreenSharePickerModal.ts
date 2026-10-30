import {
  PUBLIC_AUDIENCE, SCREEN_SHARE_LIMITS, type DesktopSource, type NativeScreenCapabilities, type ResourceAudience,
} from '@monky/shared';
import { escapeHtml, html, trustedHtml } from '../utils/html';
import { appEvents } from '../core/EventBus';
import { captureScreenShareCall, screenShareLimit, type ScreenShareCall } from '../core/screenShareControls';
import { startScreenShare } from '../core/screenShareStart';
import { videoService } from '../core/VideoService';
import { voiceStore } from '../stores/voiceStore';
import { webRtcManager } from '../core/WebRtcManager';
import { setButtonLoading } from '../utils/buttonLoading';
import { ScreenShareUserError, screenShareFailureMessage } from '../utils/screenShareFailure';
import { renderLoadingError, renderLoadingSkeleton } from '../utils/loadingSkeleton';
import { showAlert, showConfirm } from './Dialog';
import { showErrorToast } from './CopyToast';
import { screenShareChooser } from './ScreenShareChooser';
import { getLanguage, t } from '../i18n';
import { openModal, type ModalShell } from '../utils/modalShell';
import { reportError } from '../utils/feedback';
import { setSurfaceVisible } from '../utils/surfaceVisibility';
import { nativeScreenProfile } from '../core/webrtc/NativeScreenController';
import { GameCaptureGuideModal } from './GameCaptureGuideModal';
import { ResourceAudiencePicker, type AudienceTexts } from './ResourceAudiencePicker';
import { nextIndex } from '../utils/rovingFocus';
import {
  SOURCE_TABS, canCaptureNatively, captureKindOf, captureUnavailableMessage, hasUnownedAudio, isMacPlatform, planAudio,
  sourceMatchesTab, supportsCaptureKind, supportsTab, windowCaptureMethods,
  type AudioBlock, type CaptureContext, type LiveScreens, type SourceTab, type WindowCaptureMethod,
} from './screenShare/captureRules';

type SourceLoadState =
  | { status: 'loading' }
  | { status: 'ready'; sources: DesktopSource[] }
  | { status: 'error' };

/** A private share speaks of who can watch; the picker is the same one community resources use. */
const SCREEN_AUDIENCE_TEXTS: AudienceTexts = {
  private: 'screenShare.privateLabel', description: 'screenShare.privateDescription', who: 'screenShare.privateAudience',
  search: 'screenShare.privateSearch', choose: 'screenShare.privateChoose', noResults: 'screenShare.privateNoResults',
  empty: 'screenShare.privateEmpty', selected: 'screenShare.privateSelected', roles: 'screenShare.privateRoles',
  members: 'screenShare.privateUsers', more: 'screenShare.privateMore',
};

/** The live shares as the audio rules read them. */
function liveScreens(): LiveScreens {
  return {
    shareIds: voiceStore.screenShareIds,
    audioShareIds: voiceStore.screenAudioShareIds,
    capture: shareId => videoService.getNativeScreenCapture(shareId),
  };
}

export class ScreenSharePickerModal {
  private shell: ModalShell | null = null;
  private modalEl: HTMLElement | null = null;
  private selectedSourceId: string | null = null;
  private activeTab: SourceTab = 'window';
  private windowCaptureMethod: WindowCaptureMethod = 'window';
  private shareAudioByTab: Record<SourceTab, boolean> = { screen: true, window: true };
  private isStarting = false;
  private sourceState: SourceLoadState = { status: 'loading' };
  private sourceRequest = 0;
  private nativeCapabilities: NativeScreenCapabilities | null = null;
  private readonly gameGuide = new GameCaptureGuideModal();
  private audience = this.createAudience(PUBLIC_AUDIENCE);
  private pickerCall: ScreenShareCall | null = null;
  private audioAttentionTimer: number | null = null;
  /** The call in which adding screens past the comfortable amount was already confirmed. */
  private extraScreensConfirmedFor: string | null = null;

  /** Who can watch, picked from the call's server; the call may end while the picker is open. */
  private createAudience(initial: ResourceAudience): ResourceAudiencePicker {
    return new ResourceAudiencePicker(() => this.pickerCall?.serverStore ?? null, 'share-audience', initial, 'adaptive',
      'audience', { texts: SCREEN_AUDIENCE_TEXTS, externalSwitch: true, className: 'share-audience-field' });
  }

  /** The picker's own switch and the audience field follow the audience and the start in flight. */
  private updateAudience(): void {
    const modal = this.modalEl;
    if (!modal) return;
    const privacy = modal.querySelector<HTMLInputElement>('#chk-private-share');
    if (privacy) {
      privacy.checked = this.audience.value().visibility === 'private';
      privacy.disabled = this.isStarting;
    }
    this.audience.setDisabled(modal, this.isStarting);
  }

  private readySources(): readonly DesktopSource[] {
    return this.sourceState.status === 'ready' ? this.sourceState.sources : [];
  }

  private captureKind(tab = this.activeTab) {
    return captureKindOf(tab, this.windowCaptureMethod);
  }

  private get selectionProbePending(): boolean {
    return this.nativeCapabilities?.requiresSelectionProbe === true;
  }

  private selectedSource(): DesktopSource | undefined {
    if (this.sourceState.status !== 'ready' || !supportsTab(this.nativeCapabilities, this.activeTab)) return undefined;
    return this.sourceState.sources.find(source => source.id === this.selectedSourceId
      && sourceMatchesTab(source, this.activeTab) && !videoService.getActiveSourceIds().has(source.id));
  }

  private captureContext(): CaptureContext {
    return {
      capabilities: this.nativeCapabilities,
      loading: this.sourceState.status === 'loading',
      ownWindow: this.selectedSource()?.isOwnWindow === true,
      unownedAudio: hasUnownedAudio(liveScreens()),
      profileAvailable: nativeScreenProfile(videoService.getProfile()) !== null,
    };
  }

  private usesNativeCapture(sourceId: string | undefined, audio: boolean, kind = this.captureKind()): boolean {
    return canCaptureNatively(sourceId, audio, kind, this.captureContext());
  }

  private captureUnavailableMessage(audio: boolean, kind = this.captureKind()): string {
    return captureUnavailableMessage(audio, kind, this.captureContext());
  }

  private updateCaptureInfo(): void {
    this.updateAudience();
    const source = this.selectedSource();
    if (!source && this.sourceState.status === 'ready') this.selectedSourceId = null;
    const refreshing = this.sourceState.status === 'loading';
    const refresh = this.modalEl?.querySelector<HTMLButtonElement>('#btn-refresh-sources') ?? null;
    setButtonLoading(refresh, refreshing);
    if (refresh) {
      refresh.disabled = this.isStarting || refreshing;
      refresh.setAttribute('aria-busy', String(refreshing));
    }
    this.updateTabs();
    this.updateCaptureMethods(source);
    const guide = this.modalEl?.querySelector<HTMLButtonElement>('#btn-game-capture-guide');
    if (guide) {
      guide.hidden = this.activeTab !== 'window';
      guide.disabled = this.isStarting;
    }
    const info = this.modalEl?.querySelector<HTMLElement>('#share-capture-info');
    if (!info) return;
    const audioInput = this.modalEl?.querySelector<HTMLInputElement>('#chk-share-audio');
    const ownWindow = source?.isOwnWindow === true;
    const permissionMuted = voiceStore.permissionMuted;
    if (audioInput) {
      audioInput.checked = !ownWindow && !permissionMuted && this.shareAudioByTab[this.activeTab];
      audioInput.disabled = this.isStarting || ownWindow || permissionMuted || hasUnownedAudio(liveScreens());
      audioInput.title = permissionMuted ? t('permissions.permissionMuted') : '';
      if (ownWindow) audioInput.setAttribute('aria-describedby', 'share-audio-warning');
      else audioInput.removeAttribute('aria-describedby');
    }
    const audio = audioInput?.checked ?? false;
    const audioWarning = this.modalEl?.querySelector<HTMLElement>('#share-audio-warning');
    if (audioWarning) {
      audioWarning.hidden = !ownWindow && !permissionMuted;
      audioWarning.textContent = ownWindow ? t('screenShare.ownWindowAudioUnavailable')
        : permissionMuted ? t('permissions.permissionMuted') : '';
    }
    const aspectInput = this.modalEl?.querySelector<HTMLInputElement>('#chk-preserve-aspect-ratio');
    if (aspectInput) aspectInput.disabled = this.isStarting;
    const occlusionTip = this.modalEl?.querySelector<HTMLElement>('#share-occlusion-tip');
    if (occlusionTip) {
      const engine = source?.type === 'window' ? source.occlusionEngine : undefined;
      occlusionTip.hidden = !engine;
      occlusionTip.textContent = engine ? t(`screenShare.occlusionTip.${engine}`) : '';
    }
    const audioText = this.modalEl?.querySelector('#share-audio-text');
    if (audioText) audioText.textContent = this.audioToggleLabel(this.activeTab);
    const native = this.usesNativeCapture(source?.id ?? (this.activeTab === 'screen' ? 'native-monitor:' : 'window:'), audio);
    const profile = native ? nativeScreenProfile(videoService.getProfile()) : null;
    info.hidden = profile !== null && this.selectionProbePending;
    info.textContent = info.hidden ? '' : profile ? t('screenShare.nativeBackend', {
      width: profile.width, height: profile.height, fps: profile.fps, bitrate: profile.maxBitrateKbps,
    }) : this.captureUnavailableMessage(audio);
    info.dataset.backend = native ? (this.selectionProbePending ? 'probe-pending' : 'native') : 'unavailable';
    this.modalEl?.querySelectorAll<HTMLButtonElement>('#btn-share, #btn-share-add')
      .forEach(button => {
        // A second audio share is explained by a toast on click (#253), not by
        // a dead button whose reason only showed up in a hover tooltip.
        button.disabled = this.isStarting || !source || !native || !this.audience.isValid();
        if (source && this.captureKind() === 'game') button.setAttribute('aria-describedby', 'share-game-tip');
        else button.removeAttribute('aria-describedby');
      });
    // Switching with several live shares first asks which one to replace.
    this.modalEl?.querySelector<HTMLButtonElement>('#btn-share')
      ?.setAttribute('aria-haspopup', voiceStore.screenShareIds.length > 1 ? 'menu' : 'false');
    this.modalEl?.querySelectorAll<HTMLElement>('.source-item').forEach(item => {
      const selected = item.dataset.sourceId === this.selectedSourceId;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
      item.setAttribute('aria-disabled', String(this.isStarting));
      item.tabIndex = this.isStarting ? -1 : 0;
    });
  }

  private updateTabs(): void {
    const available = SOURCE_TABS.filter(tab => supportsTab(this.nativeCapabilities, tab.id));
    const focusTab = available.find(tab => tab.id === this.activeTab) ?? available[0];
    const reasons = new Set<string>();
    for (const tab of SOURCE_TABS) {
      const button = this.modalEl?.querySelector<HTMLButtonElement>(`#share-tab-${tab.id}`);
      if (!button) continue;
      const supported = supportsTab(this.nativeCapabilities, tab.id);
      const selected = this.activeTab === tab.id;
      button.disabled = this.isStarting || !supported;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = !button.disabled && tab.id === focusTab?.id ? 0 : -1;
      const reason = supported ? '' : this.captureUnavailableMessage(false, tab.id === 'screen' ? 'monitor' : 'window');
      button.title = reason;
      if (supported) button.removeAttribute('aria-describedby');
      else button.setAttribute('aria-describedby', 'share-method-reasons');
      const status = button.querySelector<HTMLElement>('.share-tab-status');
      if (status) {
        status.hidden = supported;
        status.textContent = supported ? ''
          : !this.nativeCapabilities && this.sourceState.status === 'loading' ? t('common.loading') : t('screenShare.unavailable');
      }
      if (reason) reasons.add(reason);
    }
    const explanation = this.modalEl?.querySelector<HTMLElement>('#share-method-reasons');
    if (explanation) {
      explanation.textContent = [...reasons].join('\n');
      explanation.hidden = reasons.size === 0;
    }
    this.modalEl?.querySelector('#share-sources-panel')?.setAttribute('aria-labelledby', `share-tab-${this.activeTab}`);
  }

  private updateCaptureMethods(source: DesktopSource | undefined): void {
    const section = this.modalEl?.querySelector<HTMLElement>('#share-window-methods');
    if (!section) return;
    const visible = this.activeTab === 'window' && !!source;
    setSurfaceVisible(section, visible, 'panel');
    const label = section.querySelector<HTMLElement>('#share-method-label');
    if (label) label.textContent = source ? t('screenShare.captureMethodForWindow', { name: source.name }) : '';
    const methods = windowCaptureMethods(isMacPlatform());
    const available = methods.filter(method => supportsCaptureKind(this.nativeCapabilities, method.id));
    const focusMethod = available.find(method => method.id === this.windowCaptureMethod) ?? available[0];
    for (const method of methods) {
      const button = section.querySelector<HTMLButtonElement>(`#share-method-${method.id}`);
      if (!button) continue;
      const supported = supportsCaptureKind(this.nativeCapabilities, method.id);
      button.disabled = !visible || this.isStarting || !supported;
      button.setAttribute('aria-pressed', String(this.windowCaptureMethod === method.id));
      button.tabIndex = !button.disabled && method.id === focusMethod?.id ? 0 : -1;
      const reason = supported ? '' : this.captureUnavailableMessage(false, method.id);
      button.title = reason;
      button.setAttribute('aria-describedby', `share-method-${method.id}-description${reason ? ` share-method-${method.id}-status` : ''}`);
      const status = button.querySelector<HTMLElement>('.share-method-status');
      if (status) {
        status.textContent = reason;
        status.hidden = !reason;
      }
    }
    const tip = section.querySelector<HTMLElement>('#share-game-tip');
    if (tip) {
      tip.hidden = !visible || this.windowCaptureMethod !== 'game';
      tip.textContent = t('screenShare.gameCompatibility')
        + (supportsCaptureKind(this.nativeCapabilities, 'window') ? ` ${t('screenShare.gameWindowAlternative')}` : '');
    }
  }

  private audioToggleLabel(tab: SourceTab): string {
    if (hasUnownedAudio(liveScreens())) return t('screenShare.audioAlreadySharing');
    if (tab !== 'screen') {
      return t('screenShare.shareAppAudio');
    }
    return t('screenShare.shareAudio');
  }

  public async open(): Promise<void> {
    this.close();
    this.pickerCall = captureScreenShareCall();

    const alreadySharing = voiceStore.isScreenSharing;
    // A switch keeps the audience of the share it replaces.
    const retained = videoService.getNativeScreenCaptures().find(capture => capture.source.audience)?.source.audience;
    this.audience = this.createAudience(retained
      ? { visibility: 'private', userIds: [...retained.userIds], roleIds: [...retained.roleIds] } : PUBLIC_AUDIENCE);
    const audioAlreadyCaptured = hasUnownedAudio(liveScreens());
    const shareAudio = !audioAlreadyCaptured;
    this.shareAudioByTab = { screen: shareAudio, window: shareAudio };
    const methods = windowCaptureMethods(isMacPlatform());

    const shell = openModal({
      card: html`
      <div class="modal-card screen-share-picker-card" role="dialog" aria-modal="true" aria-labelledby="share-picker-title">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);">screen_share</span>
            <span id="share-picker-title">${alreadySharing ? t('screenShare.titleSwitch') : t('screenShare.title')}</span>
          </div>
          <button type="button" id="modal-close" class="modal-close-btn" data-modal-close aria-label="${t('common.close')}">&times;</button>
        </div>

        ${alreadySharing ? html`
          <div class="share-active-banner">
            <span class="live-pulse-dot"></span>
            <span>${t('screenShare.alreadySharingNotice')}</span>
          </div>
        ` : ''}

        <div class="share-source-toolbar">
          <div class="nav-tabs share-source-tabs" role="tablist" aria-label="${t('screenShare.sourceTypes')}">
            ${SOURCE_TABS.map(tab => html`
              <button type="button" id="share-tab-${tab.id}" class="tab-button ${this.activeTab === tab.id ? 'active' : ''}"
                role="tab" aria-selected="${this.activeTab === tab.id}" aria-controls="share-sources-panel" tabindex="-1" disabled>
                <span class="material-symbols-outlined md-16" aria-hidden="true">${tab.icon}</span>
                ${t(tab.label)}
                <span class="share-tab-status">${t('common.loading')}</span>
              </button>
            `)}
          </div>
          <button type="button" id="btn-refresh-sources" class="btn btn-secondary share-refresh-button"
            aria-label="${t('screenShare.refreshSourcesLabel')}" aria-controls="share-sources-panel" disabled>
            <span class="material-symbols-outlined md-18" aria-hidden="true">refresh</span>
            ${t('screenShare.refreshSources')}
          </button>
        </div>
        <p id="share-method-reasons" class="share-method-reasons" role="status"></p>

        <div id="share-sources-panel" role="tabpanel" aria-labelledby="share-tab-${this.activeTab}" aria-busy="true" tabindex="0"></div>
        <button type="button" id="btn-game-capture-guide" class="btn game-capture-guide-trigger"
          aria-haspopup="dialog" aria-expanded="false" ${this.activeTab === 'window' ? '' : 'hidden'}>
          <span class="material-symbols-outlined md-16" aria-hidden="true">help_outline</span>
          ${t('screenShare.gameGuideButton')}
        </button>
        <section id="share-window-methods" class="share-window-methods" hidden>
          <p id="share-method-label" class="share-method-label"></p>
          <div class="input-mode-cards share-capture-methods" role="group" aria-labelledby="share-method-label">
            ${methods.map(method => html`
              <button type="button" id="share-method-${method.id}" class="input-mode-card"
                aria-pressed="${this.windowCaptureMethod === method.id}" tabindex="-1" disabled>
                <span class="input-mode-card-title">
                  <span class="material-symbols-outlined md-18" aria-hidden="true">${method.icon}</span>
                  ${t(method.label)}
                </span>
                <span id="share-method-${method.id}-description" class="input-mode-card-description">${t(method.description)}</span>
                <span id="share-method-${method.id}-status" class="share-method-status" hidden></span>
              </button>
            `)}
          </div>
          <p id="share-game-tip" class="share-game-tip" hidden></p>
        </section>
        <div class="share-aspect-option">
          <div>
            <label id="share-aspect-label" for="chk-preserve-aspect-ratio">${t('screenShare.preserveAspectRatio')}</label>
            <label class="toggle-switch">
              <input id="chk-preserve-aspect-ratio" type="checkbox" role="switch" checked
                aria-labelledby="share-aspect-label" aria-describedby="share-aspect-description">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div id="share-aspect-description" class="audio-device-status">${t('screenShare.preserveAspectRatioDescription')}</div>
        </div>
        <p id="share-capture-info" class="share-game-tip" role="status" hidden></p>
        <p id="share-audio-warning" class="share-game-tip" role="status" hidden></p>
        <p id="share-occlusion-tip" class="share-game-tip" role="note" hidden></p>
        <div class="share-aspect-option">
          <div>
            <label id="share-private-label" for="chk-private-share">${t('screenShare.privateLabel')}</label>
            <label class="toggle-switch">
              <input id="chk-private-share" type="checkbox" role="switch" aria-labelledby="share-private-label"
                aria-describedby="share-private-description" aria-controls="share-audience" ${retained ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
          <p id="share-private-description" class="audio-device-status">${t('screenShare.privateDescription')}</p>
        </div>
        ${trustedHtml(this.audience.render())}

        <div class="modal-footer">
          <div id="share-audio-label" style="display: flex; align-items: center; gap: 8px; margin-right: auto; font-size: 0.85rem; color: var(--text-secondary); ${audioAlreadyCaptured ? 'opacity: 0.5;' : ''}">
            <span class="material-symbols-outlined md-16">volume_up</span>
            <label id="share-audio-text" for="chk-share-audio">${this.audioToggleLabel(this.activeTab)}</label>
            <label class="toggle-switch share-audio-toggle" style="margin-left: 4px;">
              <input type="checkbox" role="switch" id="chk-share-audio" aria-labelledby="share-audio-text" ${audioAlreadyCaptured ? 'disabled' : ''} ${shareAudio ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <button type="button" id="btn-cancel" class="btn btn-secondary" data-modal-close>${t('common.cancel')}</button>
          ${alreadySharing && voiceStore.canAddScreenShare(screenShareLimit(this.pickerCall)) ? html`
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
    `,
      onClose: () => this.teardown(shell),
    });
    this.shell = shell;
    this.modalEl = shell.element;
    const modal = shell.element;
    this.renderSources();
    this.attachEvents(shell);
    this.updateCaptureInfo();
    // Signal that the picker is now visible so the triggering button can clear
    // its loading state (loading should last only until the modal opens) (#48).
    appEvents.emit('modal.screenshare_picker_opened');
    if (this.modalEl === modal) await this.loadSources(modal);
  }

  private async loadSources(modal: HTMLElement, forceRefresh = false): Promise<void> {
    if (this.modalEl !== modal || this.isStarting) return;
    const request = ++this.sourceRequest;
    const isCurrent = (): boolean => this.modalEl === modal && this.sourceRequest === request;
    const refresh = modal.querySelector<HTMLButtonElement>('#btn-refresh-sources');
    const restoreRefreshFocus = document.activeElement === refresh;
    this.sourceState = { status: 'loading' };
    this.nativeCapabilities = null;
    this.renderSources();
    this.updateCaptureInfo();
    try {
      const capabilities = typeof window.api?.nativeScreenCommand === 'function'
        ? await webRtcManager.getNativeScreenCapabilities() : null;
      if (!isCurrent()) return;
      this.nativeCapabilities = capabilities;
      this.updateCaptureInfo();
      if (!SOURCE_TABS.some(tab => supportsTab(this.nativeCapabilities, tab.id))) {
        this.sourceState = { status: 'ready', sources: [] };
        this.renderSources();
        this.updateCaptureInfo();
        return;
      }
      if (!window.api?.getDesktopSources) throw new Error('Desktop source enumeration is unavailable');
      // macOS ties Screen Recording to the app's code signature. An ad-hoc
      // build changes it with every update, which invalidates the previous
      // grant while System Settings still shows it enabled, so enumeration
      // fails silently (#327). Surface the re-request flow before listing so
      // the user gets the actionable permission dialog instead of the generic
      // "could not load".
      if (typeof window.api?.ensureScreenPermission === 'function') {
        const permitted = await window.api.ensureScreenPermission();
        if (!isCurrent()) return;
        if (!permitted) {
          this.sourceState = { status: 'error' };
          this.renderSources();
          this.updateCaptureInfo();
          return;
        }
      }
      const sources = await window.api.getDesktopSources({ metadataOnly: true, refresh: forceRefresh });
      if (!isCurrent()) return;
      this.sourceState = { status: 'ready', sources };
      this.renderSources();
      this.updateCaptureInfo();
      void this.loadSourcePreviews(modal, request);
    } catch (error: unknown) {
      if (!isCurrent()) return;
      console.error('[ScreenShare] Could not load capture sources', error);
      this.sourceState = { status: 'error' };
      this.renderSources();
      this.updateCaptureInfo();
    } finally {
      if (isCurrent() && restoreRefreshFocus && document.activeElement === document.body) refresh?.focus();
    }
  }

  private async loadSourcePreviews(modal: HTMLElement, request: number): Promise<void> {
    if (this.sourceState.status !== 'ready') return;
    const sources = this.sourceState.sources;
    const isCurrent = (): boolean => this.modalEl === modal && this.sourceRequest === request
      && this.sourceState.status === 'ready' && !this.isStarting;
    // Sources stay selectable without previews; the failure is explained once per load.
    let failureReported = false;
    await Promise.all(SOURCE_TABS.map(async ({ id: type }) => {
      const pending = sources.filter(source => source.type === type && source.thumbnailState !== undefined
        && (source.thumbnailState === 'pending' || (type === 'window' && !source.appIconDataUrl)));
      for (let offset = 0; offset < pending.length; offset += 4) {
        if (!isCurrent()) return;
        const batch = pending.slice(offset, offset + 4);
        try {
          const previews = await window.api.getDesktopSourcePreviews({ type, sourceIds: batch.map(source => source.id) });
          if (!isCurrent()) return;
          const byId = new Map(previews.map(preview => [preview.id, preview]));
          for (const source of batch) {
            const preview = byId.get(source.id);
            source.appIconDataUrl = preview?.appIconDataUrl ?? source.appIconDataUrl;
            if (source.thumbnailState !== 'unavailable') {
              source.thumbnailDataUrl = preview?.thumbnailDataUrl ?? source.thumbnailDataUrl;
              source.thumbnailState = source.thumbnailDataUrl ? 'ready' : 'unavailable';
            }
          }
        } catch (error) {
          if (!isCurrent()) return;
          console.error('[ScreenShare] Could not load source previews', error);
          for (const source of batch) source.thumbnailState = 'unavailable';
          if (!failureReported) reportError(t('screenShare.previewsFailed'));
          failureReported = true;
        }
        if (!isCurrent()) return;
        const updated = new Map(batch.map(source => [source.id, source]));
        modal.querySelectorAll<HTMLElement>('.source-item').forEach(item => {
          const source = updated.get(item.dataset.sourceId ?? '');
          if (!source) return;
          const preview = item.querySelector<HTMLElement>('.source-preview');
          if (preview) preview.innerHTML = this.renderSourcePreview(source);
          const icon = item.querySelector<HTMLElement>('.source-icon');
          if (icon) icon.innerHTML = this.renderSourceIcon(source);
        });
      }
    }));
  }

  private sourceName(source: DesktopSource): string {
    return source.type === 'screen' && source.displayNumber !== undefined
      ? t('screenShare.screenNumber', { number: source.displayNumber }) : source.name;
  }

  private renderSourcePreview(source: DesktopSource): string {
    if (source.thumbnailDataUrl)
      return `<img class="source-thumbnail" src="${escapeHtml(source.thumbnailDataUrl)}" alt="${escapeHtml(this.sourceName(source))}">`;
    if (source.thumbnailState === 'pending')
      return `<div class="source-thumbnail source-thumbnail--loading skeleton" role="status"
        aria-label="${escapeHtml(t('screenShare.previewLoading'))}"></div>`;
    return `<div class="source-thumbnail source-thumbnail--minimized">
      <span class="material-symbols-outlined">${source.type === 'screen' ? 'desktop_windows' : 'web_asset'}</span>
      <span class="source-thumbnail-label">${escapeHtml(t('screenShare.previewUnavailable'))}</span>
    </div>`;
  }

  private renderSourceIcon(source: DesktopSource): string {
    return source.appIconDataUrl
      ? `<img class="source-app-icon" src="${escapeHtml(source.appIconDataUrl)}" alt="">`
      : `<span class="material-symbols-outlined source-app-icon-fallback">${source.type === 'screen' ? 'desktop_windows' : 'web_asset'}</span>`;
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
      return;
    }

    if (!supportsTab(this.nativeCapabilities, this.activeTab)) {
      panel.innerHTML = '';
      return;
    }
    const filtered = this.sourceState.sources.filter(source => sourceMatchesTab(source, this.activeTab));
    const activeSourceIds = videoService.getActiveSourceIds();
    const available = filtered.filter((s) => !activeSourceIds.has(s.id));

    if (available.length === 0) {
      panel.innerHTML = `
        <div style="padding: 24px; text-align: center; color: var(--text-muted);">
          ${escapeHtml(t(this.activeTab === 'screen' ? 'screenShare.noScreens' : 'screenShare.noWindows'))}
        </div>
      `;
      return;
    }

    panel.innerHTML = `
      <div class="screen-sources-grid">
        ${available.map((s) => {
          const name = escapeHtml(this.sourceName(s));
          return `
          <div class="source-item ${this.selectedSourceId === s.id ? 'selected' : ''}" data-source-id="${escapeHtml(s.id)}"
            role="button" tabindex="0" aria-label="${name}" aria-pressed="${this.selectedSourceId === s.id}">
            <div class="source-preview">${this.renderSourcePreview(s)}</div>
            <div class="source-name" title="${name}">
              <span class="source-icon">${this.renderSourceIcon(s)}</span>
              ${name}
            </div>
          </div>
        `;
        }).join('')}
      </div>
    `;
  }

  private selectSource(sourceId: string | undefined): boolean {
    if (this.isStarting || !sourceId || this.sourceState.status !== 'ready' || !supportsTab(this.nativeCapabilities, this.activeTab)) return false;
    if (!this.sourceState.sources.some(source => source.id === sourceId && sourceMatchesTab(source, this.activeTab))
      || videoService.getActiveSourceIds().has(sourceId)) return false;
    if (this.selectedSourceId !== sourceId) this.windowCaptureMethod = 'window';
    this.selectedSourceId = sourceId;
    this.updateCaptureInfo();
    return true;
  }

  private selectTab(tab: SourceTab): void {
    if (this.isStarting || !supportsTab(this.nativeCapabilities, tab) || this.activeTab === tab) return;
    const audio = this.modalEl?.querySelector<HTMLInputElement>('#chk-share-audio');
    if (audio && !this.selectedSource()?.isOwnWindow) this.shareAudioByTab[this.activeTab] = audio.checked;
    this.activeTab = tab;
    this.selectedSourceId = null;
    if (audio) audio.checked = this.shareAudioByTab[tab];
    this.renderSources();
    this.updateCaptureInfo();
  }

  private selectWindowCaptureMethod(method: WindowCaptureMethod): void {
    if (this.isStarting || this.activeTab !== 'window' || !supportsCaptureKind(this.nativeCapabilities, method)) return;
    if (this.selectedSource()) this.windowCaptureMethod = method;
    this.updateCaptureInfo();
  }

  private attachEvents(shell: ModalShell): void {
    const modal = shell.element;
    const options = { signal: shell.signal };
    modal.querySelector<HTMLInputElement>('#chk-private-share')?.addEventListener('change', event => {
      if (!this.isStarting && event.currentTarget instanceof HTMLInputElement) {
        this.audience.setPrivate(modal, event.currentTarget.checked);
        this.updateCaptureInfo();
      }
    }, options);
    this.audience.bind(shell.card, shell.signal, () => this.updateCaptureInfo());
    modal.querySelector('#btn-share')?.addEventListener('click', () => { void this.requestReplace(); }, options);
    modal.querySelector('#btn-share-add')?.addEventListener('click', () => { void this.startSharing('add'); }, options);
    modal.querySelector('#btn-refresh-sources')?.addEventListener('click', () => {
      if (!this.isStarting && this.sourceState.status !== 'loading') void this.loadSources(modal, true);
    }, options);
    const guide = modal.querySelector<HTMLButtonElement>('#btn-game-capture-guide');
    guide?.addEventListener('click', () => {
      if (!this.isStarting && this.activeTab === 'window') this.gameGuide.open(guide, modal);
    }, options);
    for (const tab of SOURCE_TABS) {
      const button = modal.querySelector<HTMLButtonElement>(`#share-tab-${tab.id}`);
      button?.addEventListener('click', () => this.selectTab(tab.id), options);
      button?.addEventListener('keydown', event => {
        if (this.isStarting || event.altKey || event.ctrlKey || event.metaKey) return;
        const available = SOURCE_TABS.filter(item => supportsTab(this.nativeCapabilities, item.id));
        const index = available.findIndex(item => item.id === tab.id);
        const step = index < 0 ? null : nextIndex(event.key, index, available.length, { orientation: 'horizontal' });
        if (step === null) return;
        const next = available[step];
        event.preventDefault();
        this.selectTab(next.id);
        modal.querySelector<HTMLButtonElement>(`#share-tab-${next.id}`)?.focus();
      }, options);
    }
    const methods = windowCaptureMethods(isMacPlatform());
    for (const method of methods) {
      const button = modal.querySelector<HTMLButtonElement>(`#share-method-${method.id}`);
      button?.addEventListener('click', () => this.selectWindowCaptureMethod(method.id), options);
      button?.addEventListener('keydown', event => {
        if (this.isStarting || event.altKey || event.ctrlKey || event.metaKey || !this.selectedSource()) return;
        const available = methods.filter(item => supportsCaptureKind(this.nativeCapabilities, item.id));
        const index = available.findIndex(item => item.id === method.id);
        if (index < 0) return;
        const step = event.key === 'Enter' || event.key === ' ' ? index
          : nextIndex(event.key, index, available.length, { orientation: 'both' });
        if (step === null) return;
        const next = available[step];
        event.preventDefault();
        this.selectWindowCaptureMethod(next.id);
        modal.querySelector<HTMLButtonElement>(`#share-method-${next.id}`)?.focus();
      }, options);
    }
    const panel = modal.querySelector<HTMLElement>('#share-sources-panel');
    const sourceId = (event: Event): string | undefined => {
      const item = event.target instanceof Element ? event.target.closest<HTMLElement>('.source-item') : null;
      return item && panel?.contains(item) ? item.dataset.sourceId : undefined;
    };
    panel?.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('[data-loading-retry]')) {
        if (!this.isStarting) void this.loadSources(modal, true);
        return;
      }
      this.selectSource(sourceId(event));
    }, options);
    panel?.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && this.selectSource(sourceId(event))) event.preventDefault();
    }, options);
    panel?.addEventListener('dblclick', event => {
      // A game hook requires the explicit confirmation control, not a source-list shortcut.
      if (this.selectSource(sourceId(event)) && this.captureKind() !== 'game') void this.requestReplace();
    }, options);
    modal.querySelector<HTMLInputElement>('#chk-share-audio')?.addEventListener('change', event => {
      if (event.currentTarget instanceof HTMLInputElement && !this.selectedSource()?.isOwnWindow)
        this.shareAudioByTab[this.activeTab] = event.currentTarget.checked;
      this.updateCaptureInfo();
    }, options);
  }

  /**
   * Switching the source replaces the only share directly. With several live
   * shares, the dropdown first asks which one to replace, with a preview of
   * each, instead of replacing all of them with this single source.
   */
  private async requestReplace(): Promise<void> {
    const modal = this.modalEl;
    const button = modal?.querySelector<HTMLButtonElement>('#btn-share');
    if (!modal || !button || button.disabled || this.isStarting || this.gameGuide.isOpen()) return;
    // Only shares with a live capture can be shown; fewer than two keeps the direct switch.
    if (voiceStore.screenShareIds.filter(shareId => videoService.getScreenStream(shareId) !== null).length < 2) {
      await this.startSharing('replace');
      return;
    }
    if (screenShareChooser.isOpenFor(button)) {
      screenShareChooser.close();
      return;
    }
    const selection = await screenShareChooser.choose(button, 'switch');
    if (this.modalEl !== modal || !selection || !('shareId' in selection)
      || !voiceStore.screenShareIds.includes(selection.shareId)) return;
    await this.startSharing('replace', selection.shareId);
  }

  /**
   * Past SCREEN_SHARE_LIMITS.comfortable each screen costs another capture, encoder and upload, so adding one
   * more asks first, once per call. Closing the picker dismisses the question.
   */
  private async confirmExtraScreen(limit: number): Promise<boolean> {
    const count = voiceStore.screenShareIds.length;
    const callKey = `${voiceStore.voiceSessionKey ?? ''}\n${voiceStore.currentVoiceChannelId ?? ''}`;
    if (count < SCREEN_SHARE_LIMITS.comfortable || this.extraScreensConfirmedFor === callKey) return true;
    const confirmed = await showConfirm({
      title: t('screenShare.extraScreensTitle'),
      message: t('screenShare.extraScreensMessage', { count: String(count), max: String(limit) }),
      confirmLabel: t('screenShare.extraScreensConfirm'),
      variant: 'warning',
      signal: this.shell?.signal,
    });
    if (confirmed) this.extraScreensConfirmedFor = callKey;
    return confirmed;
  }

  /**
   * Whole-screen audio replaces the applications' own audio, which it already contains (#253). Declining
   * keeps their audio and shares the screen silently.
   */
  private confirmAudioTakeover(shareIds: readonly string[]): Promise<boolean> {
    const names = shareIds.flatMap(shareId => videoService.getScreenShareLabel(shareId) ?? []);
    const apps = names.length ? new Intl.ListFormat(getLanguage(), { type: 'conjunction' }).format(names)
      : t('screenShare.replaceAppAudioUnnamed');
    return showConfirm({
      title: t('screenShare.replaceAppAudioTitle'),
      message: t('screenShare.replaceAppAudioMessage', { apps }),
      confirmLabel: t('screenShare.replaceAppAudioConfirm'),
      cancelLabel: t('screenShare.replaceAppAudioKeep'),
      variant: 'warning',
      signal: this.shell?.signal,
    });
  }

  /** Points at the audio switch that blocks the share, with the toast saying why. */
  private explainScreenAudioTaken(modal: HTMLElement, reason: AudioBlock): void {
    showErrorToast(t(reason === 'app' ? 'screenShare.appAudioTakenToast'
      : reason === 'mac' ? 'screenShare.audioTakenMacToast' : 'screenShare.audioTakenToast'), 6000);
    const toggle = modal.querySelector<HTMLElement>('.share-audio-toggle');
    if (!toggle) return;
    toggle.dataset.attention = '';
    modal.querySelector<HTMLInputElement>('#chk-share-audio')?.focus({ preventScroll: true });
    if (this.audioAttentionTimer !== null) window.clearTimeout(this.audioAttentionTimer);
    this.audioAttentionTimer = window.setTimeout(() => {
      this.audioAttentionTimer = null;
      delete toggle.dataset.attention;
    }, 2400);
  }

  /**
   * Starts the selected share through core/screenShareStart. The picker owns what the person sees: the
   * questions, the buttons while it starts and the error when it fails. 'replace' swaps the current source
   * (#264) — only `targetShareId` when given; 'add' broadcasts another screen up to screenShareLimit() (#253).
   */
  private async startSharing(mode: 'add' | 'replace', targetShareId?: string): Promise<void> {
    const shell = this.shell;
    if (this.isStarting || !shell || this.gameGuide.isOpen()) return;
    if (!this.audience.isValid()) {
      this.updateCaptureInfo();
      this.audience.showOptions();
      return;
    }
    const call = this.pickerCall ?? captureScreenShareCall();
    const limit = screenShareLimit(call);
    if (mode === 'add' && !voiceStore.canAddScreenShare(limit)) {
      await showAlert({
        title: t('screenShare.limitTitle'),
        message: t('screenShare.limitMessage', { max: String(limit) }),
        variant: 'warning',
      });
      return;
    }

    const modal = shell.element;
    const source = this.selectedSource();
    const sourceId = source?.id;
    const tab = this.activeTab;
    const captureKind = this.captureKind(tab);
    const audio = !voiceStore.permissionMuted && (modal.querySelector<HTMLInputElement>('#chk-share-audio')?.checked ?? false);
    const audioPlan = audio
      ? planAudio({ mode, targetShareId, kind: captureKind, source, sources: this.readySources() }, liveScreens(), isMacPlatform())
      : null;
    // Sound another share already carries is explained by a toast, and the switch is right there.
    if (audioPlan?.kind === 'blocked') {
      this.updateCaptureInfo();
      this.explainScreenAudioTaken(modal, audioPlan.reason);
      return;
    }
    const preserveAspectRatio = modal.querySelector<HTMLInputElement>('#chk-preserve-aspect-ratio')?.checked ?? true;
    const audience = this.audience.value();
    this.isStarting = true;
    this.updateCaptureInfo();
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
      if (!source || !sourceId) throw new ScreenShareUserError(t('screenShare.sourceUnavailable'));
      const outcome = await startScreenShare({
        mode, targetShareId, sourceId, label: this.sourceName(source), captureKind, audio,
        audioHandover: audioPlan
          ? { handedOver: audioPlan.handedOver, askTakeover: audioPlan.kind === 'ask' ? audioPlan.apps : [] } : null,
        macSystemMix: isMacPlatform() && sourceId.startsWith('window:'),
        preserveAspectRatio,
        audience: audience.visibility === 'private' ? { userIds: audience.userIds, roleIds: audience.roleIds } : undefined,
      }, {
        call,
        isOpen: () => this.shell === shell,
        isSelected: () => this.activeTab === tab && this.selectedSourceId === sourceId && this.captureKind() === captureKind,
        confirmExtraScreen: () => this.confirmExtraScreen(limit),
        confirmAudioTakeover: shareIds => this.confirmAudioTakeover(shareIds),
        confirmMacSystemAudio: () => showConfirm({
          title: t('screenShare.macSystemAudioWarnTitle'),
          message: t('screenShare.macSystemAudioWarnMessage'),
          confirmLabel: t('screenShare.macSystemAudioWarnConfirm'),
          variant: 'warning',
          signal: shell.signal,
        }),
        captureBlocked: shareAudio => this.usesNativeCapture(sourceId, shareAudio, captureKind)
          ? null : this.captureUnavailableMessage(shareAudio, captureKind),
      });
      if (outcome === 'published' && this.shell === shell) this.close();
    } catch (err) {
      if ((err instanceof Error && err.name === 'AbortError') || this.shell !== shell || !call.isCurrent()) {
        if (this.shell === shell) this.close();
        return;
      }
      await showAlert({
        title: t('screenShare.errorTitle'),
        message: screenShareFailureMessage(err, 'start'),
        variant: 'danger',
      });
    } finally {
      if (this.shell === shell) {
        this.isStarting = false;
        setButtonLoading(targetBtn, false);
        if (btnCancel) btnCancel.disabled = false;
        if (btnClose) btnClose.disabled = false;
        this.updateCaptureInfo();
        void this.loadSourcePreviews(modal, this.sourceRequest);
      }
    }
  }

  public close(): void {
    // The guide goes first, so its focus returns into a picker that is still open.
    this.gameGuide.close();
    this.shell?.close('api');
  }

  /** Runs once, as the picker starts to close by any way. */
  private teardown(shell: ModalShell): void {
    if (this.shell !== shell) return;
    this.gameGuide.close();
    if (screenShareChooser.isOpenWithin(shell.element)) screenShareChooser.close();
    if (this.audioAttentionTimer !== null) {
      window.clearTimeout(this.audioAttentionTimer);
      this.audioAttentionTimer = null;
    }
    this.sourceRequest++;
    this.sourceState = { status: 'loading' };
    this.nativeCapabilities = null;
    this.pickerCall = null;
    this.shell = null;
    this.modalEl = null;
    this.selectedSourceId = null;
    this.windowCaptureMethod = 'window';
    this.isStarting = false;
    // Callers (e.g. the screen-share button loading state) learn the picker is
    // no longer open, including on cancel (#48).
    void window.api.cancelDesktopSourcePreviews?.()
      .catch(error => console.error('[ScreenShare] Could not cancel source previews', error));
    appEvents.emit('modal.screenshare_picker_closed');
  }
}

export const screenSharePickerModal = new ScreenSharePickerModal();
