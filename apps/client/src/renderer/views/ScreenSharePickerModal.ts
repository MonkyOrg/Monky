import type { DesktopSource, NativeScreenCapabilities, NativeScreenCaptureKind, ScreenShareAudience } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { getAvatarUrl } from '../utils/avatar';
import { isHexColor } from '../utils/colors';
import { appEvents } from '../core/EventBus';
import { screenAudioService } from '../core/ScreenAudioService';
import { captureScreenShareCall, notifyScreenShareState, stopLocalScreenShares } from '../core/screenShareControls';
import { videoService } from '../core/VideoService';
import { voiceStore, VoiceStore } from '../stores/voiceStore';
import { webRtcManager } from '../core/WebRtcManager';
import { setButtonLoading } from '../utils/buttonLoading';
import { renderLoadingError, renderLoadingSkeleton } from '../utils/loadingSkeleton';
import { showAlert, showConfirm } from './Dialog';
import { t } from '../i18n';
import { nativeScreenProfile } from '../core/webrtc/NativeScreenController';
import { GameCaptureGuideModal } from './GameCaptureGuideModal';

type SourceLoadState =
  | { status: 'loading' }
  | { status: 'ready'; sources: DesktopSource[] }
  | { status: 'error' };

const SOURCE_TABS = [
  { id: 'screen', label: 'screenShare.screensTab', icon: 'desktop_windows' },
  { id: 'window', label: 'screenShare.windowsTab', icon: 'web_asset' },
] as const;
type SourceTab = typeof SOURCE_TABS[number]['id'];

const WINDOW_CAPTURE_METHODS = [
  { id: 'window', label: 'screenShare.windowCapture', description: 'screenShare.windowCaptureDescription', icon: 'web_asset' },
  { id: 'game', label: 'screenShare.gameCapture', description: 'screenShare.gameCaptureDescription', icon: 'sports_esports' },
] as const;
type WindowCaptureMethod = typeof WINDOW_CAPTURE_METHODS[number]['id'];

export class ScreenSharePickerModal {
  private modalEl: HTMLElement | null = null;
  private selectedSourceId: string | null = null;
  private activeTab: SourceTab = 'window';
  private windowCaptureMethod: WindowCaptureMethod = 'window';
  private shareAudioByTab: Record<SourceTab, boolean> = { screen: true, window: true };
  private isStarting = false;
  private sourceState: SourceLoadState = { status: 'loading' };
  private sourceRequest = 0;
  private nativeCapabilities: NativeScreenCapabilities | null = null;
  private eventController: AbortController | null = null;
  private readonly gameGuide = new GameCaptureGuideModal();
  private privateShare = false;
  private audienceRendered = false;
  private audienceOpen = false;
  private audience: ScreenShareAudience = { userIds: [], roleIds: [] };
  private pickerCall: ReturnType<typeof captureScreenShareCall> | null = null;

  private audienceIsValid(): boolean {
    return !this.privateShare || this.audience.userIds.length + this.audience.roleIds.length > 0;
  }

  private updateAudience(): void {
    const modal = this.modalEl;
    if (!modal) return;
    const section = modal.querySelector<HTMLElement>('#share-audience');
    if (section) section.hidden = !this.privateShare;
    const privacy = modal.querySelector<HTMLInputElement>('#chk-private-share');
    if (privacy) { privacy.checked = this.privateShare; privacy.disabled = this.isStarting; }
    if (!this.privateShare || this.isStarting) this.audienceOpen = false;
    const trigger = modal.querySelector<HTMLButtonElement>('#share-audience-toggle');
    if (trigger) {
      trigger.disabled = this.isStarting;
      trigger.setAttribute('aria-expanded', String(this.audienceOpen));
    }
    const popup = modal.querySelector<HTMLElement>('#share-audience-popup');
    if (popup) popup.hidden = !this.audienceOpen;
    if (!this.privateShare) return;
    if (!this.audienceRendered) {
      const choices = modal.querySelector<HTMLElement>('.share-audience-options');
      if (choices) choices.innerHTML = this.audienceOptions();
      this.audienceRendered = true;
    }
    const search = modal.querySelector<HTMLInputElement>('#share-audience-search');
    if (search) search.disabled = this.isStarting;
    const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
    const query = normalize((search?.value ?? '').trim());
    const candidates = modal.querySelectorAll<HTMLButtonElement>('[data-audience-id]');
    const selectedOptions: HTMLButtonElement[] = [];
    let visible = 0;
    candidates.forEach(button => {
      const kind = button.dataset.audienceKind === 'role' ? 'roleIds' : 'userIds';
      const selected = this.audience[kind].includes(button.dataset.audienceId ?? '');
      button.setAttribute('aria-selected', String(selected));
      button.classList.toggle('selected', selected);
      button.disabled = this.isStarting || (!selected && this.audience[kind].length >= (kind === 'userIds' ? 256 : 128));
      button.hidden = !normalize(button.dataset.audienceName ?? '').includes(query);
      if (selected) selectedOptions.push(button);
      if (!button.hidden) visible++;
    });
    for (const group of modal.querySelectorAll<HTMLElement>('.share-audience-group')) {
      group.hidden = ![...group.querySelectorAll<HTMLButtonElement>('[data-audience-id]')].some(button => !button.hidden);
    }
    const summary = modal.querySelector<HTMLElement>('#share-audience-summary');
    if (summary) {
      const content = selectedOptions.length
        ? selectedOptions.slice(0, 2).map(button =>
          `<span class="share-audience-chip">${button.querySelector('.share-audience-identity')?.innerHTML ?? ''}</span>`).join('')
          + (selectedOptions.length > 2
            ? `<span class="share-audience-more" aria-label="${escapeHtml(t('screenShare.privateMore', { count: selectedOptions.length - 2 }))}">+${selectedOptions.length - 2}</span>` : '')
        : `<span class="share-audience-placeholder">${escapeHtml(t('screenShare.privateChoose'))}</span>`;
      if (summary.innerHTML !== content) summary.innerHTML = content;
    }
    const empty = modal.querySelector<HTMLElement>('#share-audience-no-results');
    if (empty) empty.hidden = visible > 0;
    const status = modal.querySelector<HTMLElement>('#share-audience-status');
    if (status) status.textContent = this.audienceIsValid()
      ? t('screenShare.privateSelected', { count: this.audience.userIds.length + this.audience.roleIds.length })
      : t('screenShare.privateEmpty');
  }

  private setAudienceOpen(open: boolean): void {
    if (this.isStarting || !this.privateShare) return;
    this.audienceOpen = open;
    this.updateAudience();
    if (open) this.modalEl?.querySelector<HTMLInputElement>('#share-audience-search')?.focus();
  }

  private audienceOptions(): string {
    const serverStore = this.pickerCall?.serverStore;
    const options = (kind: 'role' | 'user', values: { id: string; name: string; color?: string | null; avatarUrl?: string | null }[]) => [...values]
      .sort((a, b) => a.name.localeCompare(b.name)).map(value => `
        <button type="button" class="share-audience-option" data-audience-kind="${kind}"
          data-audience-id="${escapeHtml(value.id)}" data-audience-name="${escapeHtml(value.name)}"
          role="option" aria-selected="false" tabindex="-1">
          <span class="share-audience-identity">
            ${kind === 'role'
              ? `<span class="share-audience-role" style="--role-color: ${isHexColor(value.color) ? value.color : 'var(--text-muted)'}" aria-hidden="true"></span>`
              : `<img class="share-audience-avatar" src="${escapeHtml(getAvatarUrl(value.avatarUrl))}" alt="" data-fallback="avatar" loading="lazy" decoding="async">`}
            <span class="share-audience-name">${escapeHtml(value.name)}</span>
          </span>
          <span class="material-symbols-outlined md-18 share-audience-check" aria-hidden="true">check</span>
        </button>`).join('');
    const members = [...(serverStore?.knownMembers.values() ?? [])]
      .filter(user => user.id !== serverStore?.currentUser?.id && !user.isBot)
      .map(user => ({ id: user.id, name: user.nickname, avatarUrl: user.avatarUrl }));
    return `<div class="share-audience-group" role="group" aria-labelledby="share-audience-roles">
        <h4 id="share-audience-roles">${escapeHtml(t('screenShare.privateRoles'))}</h4>
        ${options('role', serverStore?.roles ?? [])}
      </div><div class="share-audience-group" role="group" aria-labelledby="share-audience-users">
        <h4 id="share-audience-users">${escapeHtml(t('screenShare.privateUsers'))}</h4>
        ${options('user', members)}
      </div>`;
  }

  private hasScreenAudio(): boolean {
    return voiceStore.screenAudioShareId !== null || screenAudioService.getIsCapturing();
  }

  private canReplaceScreenAudio(): boolean {
    return voiceStore.screenAudioShareId !== null
      && voiceStore.screenShareIds.includes(voiceStore.screenAudioShareId);
  }

  private captureKind(tab = this.activeTab): NativeScreenCaptureKind {
    return tab === 'screen' ? 'monitor' : this.windowCaptureMethod;
  }

  private supportsCaptureKind(kind: NativeScreenCaptureKind): boolean {
    const capabilities = this.nativeCapabilities;
    return !!capabilities && (capabilities.capture === true || capabilities.requiresSelectionProbe === true)
      && (capabilities.captureKinds ?? (capabilities.capture === true ? ['window'] : [])).includes(kind);
  }

  private supportsTab(tab: SourceTab): boolean {
    return tab === 'screen' ? this.supportsCaptureKind('monitor')
      : this.supportsCaptureKind('window') || this.supportsCaptureKind('game');
  }

  private get selectionProbePending(): boolean {
    return this.nativeCapabilities?.requiresSelectionProbe === true;
  }

  private sourceMatchesTab(source: DesktopSource, tab = this.activeTab): boolean {
    const type = tab === 'screen' ? 'screen' : 'window';
    return source.type === type && source.id.startsWith(tab === 'screen' ? 'native-monitor:' : 'window:');
  }

  private selectedSource(): DesktopSource | undefined {
    if (this.sourceState.status !== 'ready' || !this.supportsTab(this.activeTab)) return undefined;
    return this.sourceState.sources.find(source => source.id === this.selectedSourceId
      && this.sourceMatchesTab(source) && !videoService.getActiveSourceIds().has(source.id));
  }

  private usesNativeCapture(sourceId: string | undefined, audio: boolean, kind = this.captureKind(), mode: 'add' | 'replace' = 'replace'): boolean {
    return !!sourceId?.startsWith(kind === 'monitor' ? 'native-monitor:' : 'window:') && this.supportsCaptureKind(kind)
      && (!audio || !this.selectedSource()?.isOwnWindow)
      && (!audio || (this.nativeCapabilities?.captureAudio === true
        && (!this.hasScreenAudio() || (mode === 'replace' && this.canReplaceScreenAudio()))))
      && nativeScreenProfile(videoService.getProfile()) !== null;
  }

  private captureUnavailableMessage(audio: boolean, kind = this.captureKind(), mode: 'add' | 'replace' = 'replace'): string {
    if (audio && this.selectedSource()?.isOwnWindow) return t('screenShare.ownWindowAudioUnavailable');
    const capabilities = this.nativeCapabilities;
    if (!capabilities && this.sourceState.status === 'loading') return t('common.loading');
    if (!capabilities || (!capabilities.capture && capabilities.requiresSelectionProbe !== true)) {
      if (capabilities?.reason === 'encoder') return t('screenShare.nativeEncoderUnavailable');
      return t(capabilities?.reason === 'runtime' ? 'screenShare.nativeUnavailable' : 'screenShare.platformSoon');
    }
    if (!this.supportsCaptureKind(kind)) {
      return t('screenShare.captureMethodUnavailable', {
        method: t(kind === 'monitor' ? 'screenShare.screensTab'
          : kind === 'window' ? 'screenShare.windowCapture' : 'screenShare.gameCapture'),
      });
    }
    if (audio && this.hasScreenAudio() && (mode === 'add' || !this.canReplaceScreenAudio()))
      return t('screenShare.audioAlreadySharing');
    if (audio && !capabilities.captureAudio) return t('screenShare.nativeAudioUnavailable');
    return t('screenShare.nativeProfileChangeBlocked');
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
    if (audioInput) {
      audioInput.checked = !ownWindow && this.shareAudioByTab[this.activeTab];
      audioInput.disabled = this.isStarting || ownWindow || (this.hasScreenAudio() && !this.canReplaceScreenAudio());
      if (ownWindow) audioInput.setAttribute('aria-describedby', 'share-audio-warning');
      else audioInput.removeAttribute('aria-describedby');
    }
    const audio = audioInput?.checked ?? false;
    const audioWarning = this.modalEl?.querySelector<HTMLElement>('#share-audio-warning');
    if (audioWarning) {
      audioWarning.hidden = !ownWindow;
      audioWarning.textContent = ownWindow ? t('screenShare.ownWindowAudioUnavailable') : '';
    }
    const aspectInput = this.modalEl?.querySelector<HTMLInputElement>('#chk-preserve-aspect-ratio');
    if (aspectInput) aspectInput.disabled = this.isStarting;
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
        button.disabled = this.isStarting || !source || !native || !this.audienceIsValid();
        if (button.id === 'btn-share-add' && audio && this.hasScreenAudio()) {
          button.disabled = true;
          button.title = t('screenShare.audioAlreadySharing');
        } else button.removeAttribute('title');
        if (source && this.captureKind() === 'game') button.setAttribute('aria-describedby', 'share-game-tip');
        else button.removeAttribute('aria-describedby');
      });
    this.modalEl?.querySelectorAll<HTMLElement>('.source-item').forEach(item => {
      const selected = item.dataset.sourceId === this.selectedSourceId;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
      item.setAttribute('aria-disabled', String(this.isStarting));
      item.tabIndex = this.isStarting ? -1 : 0;
    });
  }

  private updateTabs(): void {
    const available = SOURCE_TABS.filter(tab => this.supportsTab(tab.id));
    const focusTab = available.find(tab => tab.id === this.activeTab) ?? available[0];
    const reasons = new Set<string>();
    for (const tab of SOURCE_TABS) {
      const button = this.modalEl?.querySelector<HTMLButtonElement>(`#share-tab-${tab.id}`);
      if (!button) continue;
      const supported = this.supportsTab(tab.id);
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
    section.hidden = !visible;
    const label = section.querySelector<HTMLElement>('#share-method-label');
    if (label) label.textContent = source ? t('screenShare.captureMethodForWindow', { name: source.name }) : '';
    const available = WINDOW_CAPTURE_METHODS.filter(method => this.supportsCaptureKind(method.id));
    const focusMethod = available.find(method => method.id === this.windowCaptureMethod) ?? available[0];
    for (const method of WINDOW_CAPTURE_METHODS) {
      const button = section.querySelector<HTMLButtonElement>(`#share-method-${method.id}`);
      if (!button) continue;
      const supported = this.supportsCaptureKind(method.id);
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
        + (this.supportsCaptureKind('window') ? ` ${t('screenShare.gameWindowAlternative')}` : '');
    }
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
  private audioToggleLabel(tab: SourceTab): string {
    if (this.hasScreenAudio() && !this.canReplaceScreenAudio()) return t('screenShare.audioAlreadySharing');
    if (tab !== 'screen') {
      return this.isMac
        ? t('screenShare.shareAudioMacWindow')
        : t('screenShare.shareAppAudio');
    }
    return t('screenShare.shareAudio');
  }

  public async open(): Promise<void> {
    this.close();
    this.pickerCall = captureScreenShareCall();

    const alreadySharing = voiceStore.isScreenSharing;
    this.audienceRendered = false;
    this.audienceOpen = false;
    const retained = videoService.getNativeScreenCaptures().find(capture => capture.source.audience)?.source.audience;
    this.privateShare = retained !== undefined;
    this.audience = { userIds: [...(retained?.userIds ?? [])], roleIds: [...(retained?.roleIds ?? [])] };
    const audioAlreadyCaptured = this.hasScreenAudio() && !this.canReplaceScreenAudio();
    const shareAudio = !audioAlreadyCaptured && !screenAudioService.getIsTestTone();
    this.shareAudioByTab = { screen: shareAudio, window: shareAudio };

    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal-backdrop';
    this.modalEl.innerHTML = `
      <div class="modal-card screen-share-picker-card" role="dialog" aria-modal="true" aria-labelledby="share-picker-title">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);">screen_share</span>
            <span id="share-picker-title">${escapeHtml(alreadySharing ? t('screenShare.titleSwitch') : t('screenShare.title'))}</span>
          </div>
          <button type="button" id="modal-close" class="modal-close-btn" aria-label="${escapeHtml(t('common.close'))}">&times;</button>
        </div>

        ${alreadySharing ? `
          <div class="share-active-banner">
            <span class="live-pulse-dot"></span>
            <span>${t('screenShare.alreadySharingNotice')}</span>
          </div>
        ` : ''}

        <div class="share-source-toolbar">
          <div class="nav-tabs share-source-tabs" role="tablist" aria-label="${escapeHtml(t('screenShare.sourceTypes'))}">
            ${SOURCE_TABS.map(tab => `
              <button type="button" id="share-tab-${tab.id}" class="tab-button ${this.activeTab === tab.id ? 'active' : ''}"
                role="tab" aria-selected="${this.activeTab === tab.id}" aria-controls="share-sources-panel" tabindex="-1" disabled>
                <span class="material-symbols-outlined md-16" aria-hidden="true">${tab.icon}</span>
                ${escapeHtml(t(tab.label))}
                <span class="share-tab-status">${escapeHtml(t('common.loading'))}</span>
              </button>
            `).join('')}
          </div>
          <button type="button" id="btn-refresh-sources" class="btn btn-secondary share-refresh-button"
            aria-label="${escapeHtml(t('screenShare.refreshSourcesLabel'))}" aria-controls="share-sources-panel" disabled>
            <span class="material-symbols-outlined md-18" aria-hidden="true">refresh</span>
            ${escapeHtml(t('screenShare.refreshSources'))}
          </button>
        </div>
        <p id="share-method-reasons" class="share-method-reasons" role="status"></p>
        <p id="share-preview-error" class="share-method-reasons" role="status" hidden></p>

        <div id="share-sources-panel" role="tabpanel" aria-labelledby="share-tab-${this.activeTab}" aria-busy="true" tabindex="0"></div>
        <button type="button" id="btn-game-capture-guide" class="btn game-capture-guide-trigger"
          aria-haspopup="dialog" aria-expanded="false" ${this.activeTab === 'window' ? '' : 'hidden'}>
          <span class="material-symbols-outlined md-16" aria-hidden="true">help_outline</span>
          ${escapeHtml(t('screenShare.gameGuideButton'))}
        </button>
        <section id="share-window-methods" class="share-window-methods" hidden>
          <p id="share-method-label" class="share-method-label"></p>
          <div class="input-mode-cards share-capture-methods" role="group" aria-labelledby="share-method-label">
            ${WINDOW_CAPTURE_METHODS.map(method => `
              <button type="button" id="share-method-${method.id}" class="input-mode-card"
                aria-pressed="${this.windowCaptureMethod === method.id}" tabindex="-1" disabled>
                <span class="input-mode-card-title">
                  <span class="material-symbols-outlined md-18" aria-hidden="true">${method.icon}</span>
                  ${escapeHtml(t(method.label))}
                </span>
                <span id="share-method-${method.id}-description" class="input-mode-card-description">${escapeHtml(t(method.description))}</span>
                <span id="share-method-${method.id}-status" class="share-method-status" hidden></span>
              </button>
            `).join('')}
          </div>
          <p id="share-game-tip" class="share-game-tip" hidden></p>
        </section>
        <div class="share-aspect-option">
          <div>
            <label id="share-aspect-label" for="chk-preserve-aspect-ratio">${escapeHtml(t('screenShare.preserveAspectRatio'))}</label>
            <label class="toggle-switch">
              <input id="chk-preserve-aspect-ratio" type="checkbox" role="switch" checked
                aria-labelledby="share-aspect-label" aria-describedby="share-aspect-description">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div id="share-aspect-description" class="audio-device-status">${escapeHtml(t('screenShare.preserveAspectRatioDescription'))}</div>
        </div>
        <p id="share-capture-info" class="share-game-tip" role="status" hidden></p>
        <p id="share-audio-warning" class="share-game-tip" role="status" hidden></p>
        <div class="share-aspect-option">
          <div>
            <label id="share-private-label" for="chk-private-share">${escapeHtml(t('screenShare.privateLabel'))}</label>
            <label class="toggle-switch">
              <input id="chk-private-share" type="checkbox" role="switch" aria-labelledby="share-private-label"
                aria-describedby="share-private-description" aria-controls="share-audience">
              <span class="toggle-slider"></span>
            </label>
          </div>
          <p id="share-private-description" class="audio-device-status">${escapeHtml(t('screenShare.privateDescription'))}</p>
        </div>
        <section id="share-audience" class="share-audience" aria-labelledby="share-private-label" hidden>
          <label class="share-audience-label" for="share-audience-toggle">${escapeHtml(t('screenShare.privateAudience'))}</label>
          <div class="share-audience-picker">
            <button type="button" id="share-audience-toggle" class="share-audience-trigger" aria-haspopup="listbox"
              aria-expanded="false" aria-controls="share-audience-options" aria-describedby="share-audience-status">
              <span id="share-audience-summary"></span>
              <span class="material-symbols-outlined md-20 share-audience-chevron" aria-hidden="true">expand_more</span>
            </button>
            <div id="share-audience-popup" class="share-audience-popup" hidden>
              <div class="share-audience-search">
                <span class="material-symbols-outlined md-18" aria-hidden="true">search</span>
                <input id="share-audience-search" type="search" autocomplete="off"
                  aria-label="${escapeHtml(t('screenShare.privateSearch'))}"
                  placeholder="${escapeHtml(t('screenShare.privateSearch'))}" aria-controls="share-audience-options">
              </div>
              <div id="share-audience-options" class="share-audience-options" role="listbox"
                aria-multiselectable="true" aria-label="${escapeHtml(t('screenShare.privateAudience'))}"></div>
              <p id="share-audience-no-results" role="status" hidden>${escapeHtml(t('screenShare.privateNoResults'))}</p>
            </div>
          </div>
          <p id="share-audience-status" class="audio-device-status" role="status" aria-live="polite"></p>
        </section>

        <div class="modal-footer">
          <div id="share-audio-label" style="display: flex; align-items: center; gap: 8px; margin-right: auto; font-size: 0.85rem; color: var(--text-secondary); ${audioAlreadyCaptured ? 'opacity: 0.5;' : ''}">
            <span class="material-symbols-outlined md-16">volume_up</span>
            <label id="share-audio-text" for="chk-share-audio">${escapeHtml(this.audioToggleLabel(this.activeTab))}</label>
            <label class="toggle-switch" style="margin-left: 4px;">
              <input type="checkbox" id="chk-share-audio" aria-labelledby="share-audio-text" ${audioAlreadyCaptured ? 'disabled' : ''} ${shareAudio ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>
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
    const previewError = modal.querySelector<HTMLElement>('#share-preview-error');
    if (previewError) { previewError.hidden = true; previewError.textContent = ''; }
    this.renderSources();
    this.updateCaptureInfo();
    try {
      const capabilities = typeof window.api?.nativeScreenCommand === 'function'
        ? await webRtcManager.getNativeScreenCapabilities() : null;
      if (!isCurrent()) return;
      this.nativeCapabilities = capabilities;
      this.updateCaptureInfo();
      if (!SOURCE_TABS.some(tab => this.supportsTab(tab.id))) {
        this.sourceState = { status: 'ready', sources: [] };
        this.renderSources();
        this.updateCaptureInfo();
        return;
      }
      if (!window.api?.getDesktopSources) throw new Error('Desktop source enumeration is unavailable');
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
          const note = modal.querySelector<HTMLElement>('#share-preview-error');
          if (note) { note.textContent = t('screenShare.previewsFailed'); note.hidden = false; }
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

    if (!this.supportsTab(this.activeTab)) {
      panel.innerHTML = '';
      return;
    }
    const filtered = this.sourceState.sources.filter(source => this.sourceMatchesTab(source));
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
    if (this.isStarting || !sourceId || this.sourceState.status !== 'ready' || !this.supportsTab(this.activeTab)) return false;
    if (!this.sourceState.sources.some(source => source.id === sourceId && this.sourceMatchesTab(source))
      || videoService.getActiveSourceIds().has(sourceId)) return false;
    if (this.selectedSourceId !== sourceId) this.windowCaptureMethod = 'window';
    this.selectedSourceId = sourceId;
    this.updateCaptureInfo();
    return true;
  }

  private selectTab(tab: SourceTab): void {
    if (this.isStarting || !this.supportsTab(tab) || this.activeTab === tab) return;
    const audio = this.modalEl?.querySelector<HTMLInputElement>('#chk-share-audio');
    if (audio && !this.selectedSource()?.isOwnWindow) this.shareAudioByTab[this.activeTab] = audio.checked;
    this.activeTab = tab;
    this.selectedSourceId = null;
    if (audio) audio.checked = this.shareAudioByTab[tab];
    this.renderSources();
    this.updateCaptureInfo();
  }

  private selectWindowCaptureMethod(method: WindowCaptureMethod): void {
    if (this.isStarting || this.activeTab !== 'window' || !this.supportsCaptureKind(method)) return;
    if (this.selectedSource()) this.windowCaptureMethod = method;
    this.updateCaptureInfo();
  }

  private attachEvents(): void {
    if (!this.modalEl) return;
    const modal = this.modalEl;
    this.eventController?.abort();
    this.eventController = new AbortController();
    const options = { signal: this.eventController.signal };
    modal.querySelector<HTMLInputElement>('#chk-private-share')?.addEventListener('change', event => {
      if (!this.isStarting && event.currentTarget instanceof HTMLInputElement) {
        this.privateShare = event.currentTarget.checked;
        this.updateCaptureInfo();
      }
    }, options);
    modal.querySelector('#share-audience-search')?.addEventListener('input', () => this.updateAudience(), options);
    modal.querySelector('#share-audience-toggle')?.addEventListener('click', () => this.setAudienceOpen(!this.audienceOpen), options);
    const closeAudienceOutside = (event: Event) => {
      if (this.audienceOpen && event.target instanceof Element
          && !modal.querySelector('.share-audience-picker')?.contains(event.target)) this.setAudienceOpen(false);
    };
    modal.addEventListener('pointerdown', closeAudienceOutside, options);
    modal.addEventListener('focusin', closeAudienceOutside, options);
    modal.querySelector('#share-audience')?.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-audience-id]') : null;
      if (!button || button.disabled || this.isStarting) return;
      const id = button.dataset.audienceId;
      if (!id) return;
      const kind = button.dataset.audienceKind === 'role' ? 'roleIds' : 'userIds';
      const values = this.audience[kind];
      this.audience[kind] = values.includes(id) ? values.filter(value => value !== id) : [...values, id];
      this.updateCaptureInfo();
    }, options);
    modal.querySelector<HTMLElement>('#share-audience')?.addEventListener('keydown', event => {
      if (this.isStarting || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'Escape' && this.audienceOpen) {
        event.preventDefault();
        this.setAudienceOpen(false);
        modal.querySelector<HTMLButtonElement>('#share-audience-toggle')?.focus();
        return;
      }
      if (!this.audienceOpen) {
        if (event.target === modal.querySelector('#share-audience-toggle')
            && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          this.setAudienceOpen(true);
        }
        return;
      }
      const buttons = [...modal.querySelectorAll<HTMLButtonElement>('[data-audience-id]')]
        .filter(button => !button.hidden && !button.disabled);
      if (!buttons.length) return;
      const index = buttons.findIndex(button => button === event.target);
      let next: HTMLButtonElement | undefined;
      if (event.key === 'ArrowDown') next = buttons[(index + 1) % buttons.length];
      else if (event.key === 'ArrowUp') next = index < 0 ? buttons[buttons.length - 1] : buttons[(index - 1 + buttons.length) % buttons.length];
      else if (index >= 0 && event.key === 'Home') next = buttons[0];
      else if (index >= 0 && event.key === 'End') next = buttons[buttons.length - 1];
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    }, options);
    modal.querySelector('#modal-close')?.addEventListener('click', () => this.close(), options);
    modal.querySelector('#btn-cancel')?.addEventListener('click', () => this.close(), options);
    modal.addEventListener('mousedown', event => { if (event.target === modal) this.close(); }, options);
    modal.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); this.close(); }
    }, options);
    modal.querySelector('#btn-share')?.addEventListener('click', () => { void this.startSharing('replace'); }, options);
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
        const available = SOURCE_TABS.filter(item => this.supportsTab(item.id));
        const index = available.findIndex(item => item.id === tab.id);
        if (index < 0) return;
        let next: typeof available[number] | undefined;
        if (event.key === 'ArrowRight') next = available[(index + 1) % available.length];
        else if (event.key === 'ArrowLeft') next = available[(index + available.length - 1) % available.length];
        else if (event.key === 'Home') next = available[0];
        else if (event.key === 'End') next = available[available.length - 1];
        if (!next) return;
        event.preventDefault();
        this.selectTab(next.id);
        modal.querySelector<HTMLButtonElement>(`#share-tab-${next.id}`)?.focus();
      }, options);
    }
    for (const method of WINDOW_CAPTURE_METHODS) {
      const button = modal.querySelector<HTMLButtonElement>(`#share-method-${method.id}`);
      button?.addEventListener('click', () => this.selectWindowCaptureMethod(method.id), options);
      button?.addEventListener('keydown', event => {
        if (this.isStarting || event.altKey || event.ctrlKey || event.metaKey || !this.selectedSource()) return;
        const available = WINDOW_CAPTURE_METHODS.filter(item => this.supportsCaptureKind(item.id));
        const index = available.findIndex(item => item.id === method.id);
        if (index < 0) return;
        let next: typeof available[number] | undefined;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = available[(index + 1) % available.length];
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = available[(index + available.length - 1) % available.length];
        else if (event.key === 'Home') next = available[0];
        else if (event.key === 'End') next = available[available.length - 1];
        else if (event.key === 'Enter' || event.key === ' ') next = method;
        if (!next) return;
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
      if (this.selectSource(sourceId(event)) && this.captureKind() !== 'game') void this.startSharing('replace');
    }, options);
    modal.querySelector<HTMLInputElement>('#chk-share-audio')?.addEventListener('change', event => {
      if (event.currentTarget instanceof HTMLInputElement && !this.selectedSource()?.isOwnWindow)
        this.shareAudioByTab[this.activeTab] = event.currentTarget.checked;
      this.updateCaptureInfo();
    }, options);
  }

  /**
   * Starts a screen share. 'replace' keeps the historical behaviour of swapping
   * the current source (#264); 'add' broadcasts an extra screen alongside the
   * existing ones, up to VoiceStore.MAX_SCREEN_SHARES (#253).
   */
  private async startSharing(mode: 'add' | 'replace'): Promise<void> {
    if (this.isStarting || !this.modalEl || this.gameGuide.isOpen()) return;
    if (!this.audienceIsValid()) {
      this.updateCaptureInfo();
      this.setAudienceOpen(true);
      return;
    }
    if (mode === 'add' && !voiceStore.canAddScreenShare()) {
      await showAlert({
        title: t('screenShare.limitTitle'),
        message: t('screenShare.limitMessage', { max: String(VoiceStore.MAX_SCREEN_SHARES) }),
        variant: 'warning',
      });
      return;
    }

    const modal = this.modalEl;
    const source = this.selectedSource();
    const sourceId = source?.id;
    const tab = this.activeTab;
    const captureKind = this.captureKind(tab);
    const shareAudio = modal.querySelector<HTMLInputElement>('#chk-share-audio')?.checked ?? false;
    const preserveAspectRatio = modal.querySelector<HTMLInputElement>('#chk-preserve-aspect-ratio')?.checked ?? true;
    const call = this.pickerCall ?? captureScreenShareCall();
    let stream: MediaStream | null = null;
    let published = false;
    let retiringPrevious = false;
    const assertCurrent = () => {
      if (this.modalEl !== modal || !call.isCurrent()
        || (stream && (videoService.getScreenStream(stream.id) !== stream
          || (!videoService.getNativeScreenCapture(stream.id) && stream.getVideoTracks()[0]?.readyState !== 'live')))) {
        throw new DOMException('Screen share was cancelled', 'AbortError');
      }
    };
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
      if (!source || !sourceId) throw new Error(t('screenShare.sourceUnavailable'));
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
      await window.api.cancelDesktopSourcePreviews?.();
      assertCurrent();
      const native = this.usesNativeCapture(sourceId, shareAudio, captureKind, mode);
      if (!native) throw new Error(this.captureUnavailableMessage(shareAudio, captureKind, mode));
      // Prepare the selection before retiring existing shares. Audible
      // replacements defer preview until the previous PCM owner is closed.
      const previousShareIds = mode === 'replace' ? [...voiceStore.screenShareIds] : [];
      const previousAudioId = shareAudio && mode === 'replace' && this.canReplaceScreenAudio()
        ? voiceStore.screenAudioShareId : null;
      const retirePrevious = async (): Promise<void> => {
        assertCurrent();
        retiringPrevious = true;
        await stopLocalScreenShares(screenAudioService, { shareIds: previousShareIds, notify: false });
        assertCurrent();
      };
      if (native && sourceId) {
        const restored = tab !== 'screen' && await window.api.prepareScreenShareWindow(sourceId);
        if (restored) await new Promise(resolve => setTimeout(resolve, 350));
        assertCurrent();
        stream = await webRtcManager.startNativeScreenShare(sourceId, shareAudio, source.thumbnailDataUrl,
          () => this.modalEl === modal && call.isCurrent() && this.activeTab === tab
            && this.selectedSourceId === sourceId && this.captureKind() === captureKind,
          captureKind, preserveAspectRatio,
          previousAudioId ? {
            ...(videoService.getNativeScreenCapture(previousAudioId) ? { shareId: previousAudioId } : {}),
            retirePrevious,
          } : undefined, this.privateShare ? { userIds: [...this.audience.userIds], roleIds: [...this.audience.roleIds] } : undefined);
      } else stream = await videoService.startScreenShare(sourceId);
      assertCurrent();
      if (!native) webRtcManager.assertScreenShareSupported();
      if (previousShareIds.length > 0 && !retiringPrevious) await retirePrevious();

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
      if (retiringPrevious && !published) notifyScreenShareState(call);
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
        if (btnCancel) btnCancel.disabled = false;
        if (btnClose) btnClose.disabled = false;
        this.updateCaptureInfo();
        void this.loadSourcePreviews(modal, this.sourceRequest);
      }
    }
  }


  public close(): void {
    this.gameGuide.close(false);
    this.sourceRequest++;
    this.eventController?.abort();
    this.eventController = null;
    this.sourceState = { status: 'loading' };
    this.nativeCapabilities = null;
    this.pickerCall = null;
    const wasOpen = this.modalEl !== null;
    if (this.modalEl) {
      if (this.isStarting) videoService.cancelPendingScreenShare();
      this.modalEl.remove();
      this.modalEl = null;
      this.selectedSourceId = null;
      this.windowCaptureMethod = 'window';
      this.isStarting = false;
    }
    // Let callers (e.g. the screen-share button loading state) know the picker
    // is no longer open, including on cancel (#48). Only emit when something was
    // actually open, otherwise the close() call at the start of open() would
    // instantly clear the button loading before the picker even appears.
    if (wasOpen) {
      void window.api.cancelDesktopSourcePreviews?.()
        .catch(error => console.error('[ScreenShare] Could not cancel source previews', error));
      appEvents.emit('modal.screenshare_picker_closed');
    }
  }
}

export const screenSharePickerModal = new ScreenSharePickerModal();
