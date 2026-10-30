import type { UserSummary } from '@monky/shared';
import { appEvents } from '../../core/EventBus';
import { selectNoiseSuppression } from '../../core/AudioDeviceService';
import { currentPresenceStatus, publishedCustomStatus, sessionManager, type PresenceStatus } from '../../core/SessionManager';
import { showHome } from '../../core/serverConnection';
import { getVoiceControlModeration, leaveCall, toggleAudioDeafen, toggleMicrophoneMute } from '../../core/voiceControls';
import { webRtcManager } from '../../core/WebRtcManager';
import { serverStore } from '../../stores/serverStore';
import { settingsStore } from '../../stores/settingsStore';
import { voiceStore } from '../../stores/voiceStore';
import { getAvatarUrl } from '../../utils/avatar';
import { setButtonLoading, withButtonLoading } from '../../utils/buttonLoading';
import { reportError } from '../../utils/feedback';
import { captureHostedServerLeaveState, promptShutdownAfterLeave } from '../../utils/hostedServer';
import { html, trustedHtml, type SafeHtml } from '../../utils/html';
import { customStatusDotStyle, customStatusLabel } from '../../utils/presenceTag';
import { voiceConnectionIndicator } from '../../utils/voiceConnection';
import { renderAudioStateIcon, updateAudioStateIcon } from '../AudioStateIcon';
import { bindAudioDevicePopovers } from '../AudioDevicePopover';
import { contextMenu } from '../ContextMenu';
import { customStatusModal } from '../CustomStatusModal';
import { showAlert, showConfirm } from '../Dialog';
import { bindFooterControlsMotion } from '../FooterControlsMotion';
import { bindPttIndicators, renderMicrophoneButton } from '../PttIndicator';
import { noiseSuppressionToggleTitle } from '../settings/NoiseSuppressionControl';
import { settingsModal } from '../SettingsModal';
import { soundboardModal } from '../SoundboardModal';
import { userContextMenu } from '../UserContextMenu';
import { t } from '../../i18n';

/** Who the card shows. */
export interface UserCardProfile {
  readonly nickname: string;
  readonly avatarUrl: string | null | undefined;
  /** In a server, the card offers to disconnect from it; Home has no server to leave. */
  readonly server?: string;
}

export interface UserControlBarHost {
  /** The layout the bar is drawn in. */
  readonly root: HTMLElement;
  /** The camera of the call; a stage on screen redraws its own tile. */
  toggleCamera(): Promise<void>;
}

function presenceIndicator(): { className: PresenceStatus; label: string; style: string } {
  const status = currentPresenceStatus();
  const custom = publishedCustomStatus();
  if (custom) return { className: status, label: customStatusLabel(custom), style: customStatusDotStyle(custom) };
  const label = status === 'invisible' ? t('main.statusInvisible') : status === 'brb' ? t('main.statusBrb') : t('main.statusOnline');
  return { className: status, label, style: '' };
}

/** The status dot on the user card; clicking it chooses online, "Volto já", the custom status or invisible. */
function renderPresenceDot(): SafeHtml {
  const { className, label, style } = presenceIndicator();
  return html`<button type="button" id="main-user-status-dot" class="status-indicator status-indicator-button ${className}"
    ${style ? html`style="${style}"` : ''} aria-haspopup="menu" aria-expanded="false"
    aria-label="${t('main.changeStatusAria', { status: label })}"
    title="${t('main.changeStatus')}"></button>`;
}

/**
 * The card at the bottom of the sidebar, the same in a server and on Home:
 * who the user is and their status, microphone, headphones, camera, screen,
 * soundboard and settings, and the voice connection row while in a call (#60).
 * Above them sit the slots of the call notices.
 */
export class UserControlBar {
  private unbindPing: (() => void) | null = null;
  /** Measures the floating card so the server rail can reserve room for it (#473). */
  private cardObserver: ResizeObserver | null = null;

  constructor(private readonly host: UserControlBarHost) {}

  public markup(profile: UserCardProfile): SafeHtml {
    const moderation = getVoiceControlModeration();
    const deafenTitle = [t(voiceStore.isDeafened ? 'main.undeafen' : 'main.deafen'), moderation.deafenReason].filter(Boolean).join('. ');
    return html`
      <div class="user-control-bar">
        <div id="soundboard-players-slot" class="sb-notice-slot"></div>
        <div id="screenshare-notice-slot"></div>
        <div id="bot-screen-background-slot"></div>
        <div id="overlay-notice-slot"></div>
        <div id="game-share-notice-slot"></div>
        <div id="voice-connection-row-slot"></div>
        <div class="user-media-bar" id="user-media-bar">
          <div class="audio-control-group camera-control-group">
            <button id="media-btn-camera" class="btn btn-icon media-bar-btn-lg ${voiceStore.isCameraOn ? 'broadcasting-pulse active' : ''}" title="${t('main.toggleCamera')}">
              <span class="material-symbols-outlined md-18">${voiceStore.isCameraOn ? 'videocam_off' : 'videocam'}</span>
            </button>
            <button type="button" class="audio-device-trigger" data-audio-device="camera" aria-label="${t('cameraEffects.quickOptions')}" title="${t('cameraEffects.quickOptions')}">
              <span class="material-symbols-outlined md-14" aria-hidden="true">keyboard_arrow_up</span>
            </button>
          </div>
          <button id="media-btn-screen" class="btn btn-icon media-bar-btn-lg ${voiceStore.isScreenSharing ? 'broadcasting-pulse active' : ''}" title="${t('main.shareScreen')}">
            <span class="material-symbols-outlined md-18">${voiceStore.isScreenSharing ? 'stop_screen_share' : 'screen_share'}</span>
          </button>
          <button id="media-btn-soundboard" class="btn btn-icon media-bar-btn-lg" title="${t('main.openSoundboard')}">
            <span class="material-symbols-outlined md-18">music_note</span>
          </button>
        </div>
        <div class="user-control-main">
          <div id="user-profile-btn" class="user-profile-summary" title="${t('main.profileSettings')}">
            <div class="user-avatar-container">
              <img id="main-user-avatar" class="user-avatar-main ${voiceStore.isSpeaking ? 'speaking' : ''}" src="${getAvatarUrl(profile.avatarUrl)}" data-fallback="avatar">
              ${renderPresenceDot()}
            </div>
            <div class="user-info-text">
              <span id="main-user-name" class="user-name-display">${profile.nickname}</span>
              <span id="main-user-status-text" class="user-status-text">${presenceIndicator().label}</span>
            </div>
          </div>
          <div class="user-quick-actions">
            <div class="audio-control-group">
              ${trustedHtml(renderMicrophoneButton())}
              <button type="button" class="audio-device-trigger" data-audio-device="input" aria-label="${t('settings.microphone')}" title="${t('settings.microphone')}">
                <span class="material-symbols-outlined md-14" aria-hidden="true">keyboard_arrow_up</span>
              </button>
            </div>
            <div class="audio-control-group">
              <button id="bar-btn-deafen" class="btn btn-icon ${voiceStore.isDeafened ? 'danger-active' : ''}" aria-pressed="${voiceStore.isDeafened}" title="${deafenTitle}">
                ${trustedHtml(renderAudioStateIcon(voiceStore.isDeafened ? 'headset_off' : 'headphones', moderation.serverDeafened))}
              </button>
              <button type="button" class="audio-device-trigger" data-audio-device="output" aria-label="${t('settings.outputDevice')}" title="${t('settings.outputDevice')}">
                <span class="material-symbols-outlined md-14" aria-hidden="true">keyboard_arrow_up</span>
              </button>
            </div>
            <button id="bar-btn-settings" class="btn btn-icon" title="${t('connection.settingsTitle')}">
              <span class="material-symbols-outlined md-18">settings</span>
            </button>
            ${profile.server === undefined ? '' : html`<button id="bar-btn-disconnect" class="btn btn-icon" style="color: var(--danger);" title="${t('main.disconnectFrom', { name: profile.server })}">
              <span class="material-symbols-outlined md-18">logout</span>
            </button>`}
          </div>
        </div>
      </div>`;
  }

  /** Binds the controls drawn by `markup`; binding again first drops the previous listeners. */
  public bind(): () => void {
    const controller = new AbortController();
    const { signal } = controller;
    const root = this.host.root;
    const find = (id: string): HTMLElement | null => root.querySelector<HTMLElement>(`#${id}`);
    const unbind = [
      bindPttIndicators(root),
      bindAudioDevicePopovers(root),
      bindFooterControlsMotion(root),
      () => controller.abort(),
    ];

    const profile = find('user-profile-btn');
    profile?.addEventListener('click', () => withButtonLoading(profile, () => settingsModal.open()), { signal });
    profile?.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (serverStore.currentUser) userContextMenu.open(event.clientX, event.clientY, serverStore.currentUser);
    }, { signal });
    const statusDot = find('main-user-status-dot');
    statusDot?.addEventListener('click', (event) => {
      // The dot sits inside the profile button: it chooses a status instead.
      event.stopPropagation();
      if (contextMenu.isOpenFor(statusDot)) {
        contextMenu.close();
        return;
      }
      const box = statusDot.getBoundingClientRect();
      const current = currentPresenceStatus();
      const option = (status: PresenceStatus, icon: string, label: string) => ({
        label, icon, iconClass: `presence-menu-icon presence-menu-icon--${status}`, checked: current === status,
        onClick: () => sessionManager.setPresenceStatus(status),
      });
      const saved = settingsStore.customStatus;
      contextMenu.open(box.left, box.top, [
        option('online', 'circle', t('main.statusOnline')),
        option('brb', 'schedule', t('main.statusBrb')),
        ...saved ? [{ ...option('custom', 'circle', customStatusLabel(saved)), iconColor: saved.color }] : [],
        option('invisible', 'visibility_off', t('main.statusInvisible')),
        { label: t(saved ? 'customStatus.edit' : 'customStatus.set'), icon: 'edit', onClick: () => customStatusModal.open() },
      ], statusDot);
    }, { signal });
    const settings = find('bar-btn-settings');
    settings?.addEventListener('click', () => withButtonLoading(settings, () => settingsModal.open()), { signal });
    find('bar-btn-mic')?.addEventListener('click', toggleMicrophoneMute, { signal });
    find('bar-btn-deafen')?.addEventListener('click', toggleAudioDeafen, { signal });
    find('bar-btn-disconnect')?.addEventListener('click', () => { void this.disconnect(); }, { signal });

    const camera = find('media-btn-camera');
    camera?.addEventListener('click', async () => {
      if (!this.ensureInVoiceChannel() || camera.dataset.loading === '1') return;
      setButtonLoading(camera, true);
      try {
        await this.host.toggleCamera();
      } finally {
        setButtonLoading(camera, false);
      }
    }, { signal });
    const screen = find('media-btn-screen');
    screen?.addEventListener('click', () => {
      if (!this.ensureInVoiceChannel() || screen.dataset.loading === '1') return;
      // Show loading until the picker modal is actually open (#48).
      setButtonLoading(screen, true);
      window.setTimeout(() => setButtonLoading(screen, false), 10000);
      appEvents.emit('modal.open_screenshare_picker');
    }, { signal });
    const clearScreenLoading = () => {
      if (screen) setButtonLoading(screen, false);
    };
    find('media-btn-soundboard')?.addEventListener('click', () => soundboardModal.open(), { signal });

    unbind.push(
      appEvents.on('modal.screenshare_picker_opened', clearScreenLoading),
      appEvents.on('modal.screenshare_picker_closed', clearScreenLoading),
      appEvents.on('settings.updated', () => this.syncSettings()),
      // Repaint the voice row when the call flips in/out of reconnecting so the
      // icon, colour and status text track the live state (#553).
      appEvents.on('voice.connection_changed', () => this.updateVoiceConnectionRow()),
      appEvents.on('server.voice_restrictions_updated', () => this.updateDeafenControl()),
    );
    return () => unbind.forEach(off => off());
  }

  /** The avatar's speaking ring. */
  public showSpeaking(): void {
    this.host.root.querySelector('#main-user-avatar')?.classList.toggle('speaking', voiceStore.isSpeaking);
  }

  /** A new name or picture of the user, from another device or the settings. */
  public showUser(user: UserSummary): void {
    const avatar = this.host.root.querySelector<HTMLImageElement>('#main-user-avatar');
    const name = this.host.root.querySelector<HTMLElement>('#main-user-name');
    if (avatar) avatar.src = getAvatarUrl(user.avatarUrl);
    if (name) name.innerText = user.nickname;
  }

  /** The controls that follow the call: headphones, camera and screen. */
  public syncMediaControls(): void {
    this.updateDeafenControl();
    const media = (id: string, active: boolean, icon: string) => {
      const button = this.host.root.querySelector<HTMLElement>(`#${id}`);
      if (!button) return;
      button.className = `btn btn-icon media-bar-btn-lg ${active ? 'broadcasting-pulse active' : ''}`;
      const glyph = button.querySelector(':scope > .material-symbols-outlined');
      if (glyph && glyph.textContent !== icon) glyph.textContent = icon;
    };
    media('media-btn-camera', voiceStore.isCameraOn, voiceStore.isCameraOn ? 'videocam_off' : 'videocam');
    media('media-btn-screen', voiceStore.isScreenSharing, voiceStore.isScreenSharing ? 'stop_screen_share' : 'screen_share');
  }

  /**
   * Builds (or clears) the voice-connection row shown only while the user is
   * in a voice channel: channel name, ping and a leave button (#60).
   */
  public updateVoiceConnectionRow(): void {
    const slot = this.host.root.querySelector<HTMLElement>('#voice-connection-row-slot');
    if (!slot) return;

    const session = voiceStore.voiceSessionKey ? sessionManager.get(voiceStore.voiceSessionKey) : undefined;
    const vc = session?.serverStore.getChannel(voiceStore.currentVoiceChannelId ?? '');
    if (!voiceStore.currentVoiceChannelId || !vc) {
      slot.innerHTML = '';
      this.stopPing();
      return;
    }

    const reconnecting = voiceStore.isReconnecting;
    const connecting = voiceStore.isConnecting;
    const connectionClass = reconnecting ? 'reconnecting' : connecting ? 'connecting' : '';
    const serverName = sessionManager.isHome() ? '' : session?.serverStore.serverDetails?.name ?? '';
    const { quality, icon } = voiceConnectionIndicator(null, reconnecting, connecting);
    const statusText = reconnecting ? t('main.reconnecting') : connecting ? t('main.connecting') : t('main.voiceConnected');
    const noiseMode = settingsStore.noiseSuppressionMode;
    const noiseEnabled = noiseMode !== 'off';
    const noiseTitle = noiseSuppressionToggleTitle(noiseMode);

    slot.innerHTML = String(html`
      <div class="voice-connection-row ${connectionClass}" id="voice-connection-row">
        <div class="voice-conn-info">
          <span class="material-symbols-outlined md-16 voice-conn-signal ${quality}" aria-hidden="true">${icon}</span>
          <div class="voice-conn-text">
            <span class="voice-conn-status" role="status">${statusText}</span>
            <span class="voice-conn-channel" id="sidebar-voice-channel">${vc.name}</span>
            ${serverName ? html`<span class="voice-conn-server">${serverName}</span>` : ''}
          </div>
          <span class="voice-conn-ping" id="sidebar-voice-ping" title="${t('main.averagePing')}">-- ms</span>
        </div>
        <div class="voice-conn-actions">
          <div class="audio-control-group noise-control-group">
            <button type="button" id="sidebar-btn-rnnoise" class="btn btn-icon voice-conn-rnnoise ${noiseEnabled ? 'rnnoise-active' : ''}" title="${noiseTitle}" aria-label="${noiseTitle}" aria-pressed="${noiseEnabled}">
              <span class="material-symbols-outlined md-18">graphic_eq</span>
            </button>
            <button type="button" class="audio-device-trigger" data-audio-device="noise" aria-label="${t('audioNoise.quickOptions')}" title="${t('audioNoise.quickOptions')}">
              <span class="material-symbols-outlined md-14" aria-hidden="true">keyboard_arrow_up</span>
            </button>
          </div>
          <button id="sidebar-btn-leave-voice" class="btn btn-icon voice-conn-leave" title="${t('main.leaveCall')}">
            <span class="material-symbols-outlined md-18">call_end</span>
          </button>
        </div>
      </div>
    `);

    const btnRnnoise = slot.querySelector<HTMLButtonElement>('#sidebar-btn-rnnoise');
    btnRnnoise?.addEventListener('click', async () => {
      if (btnRnnoise.disabled) return;
      btnRnnoise.disabled = true;
      try {
        const currentMode = settingsStore.noiseSuppressionMode;
        await selectNoiseSuppression(currentMode === 'off' ? settingsStore.lastNoiseSuppressionMode : 'off');
      } catch (error: unknown) {
        reportError(t('audioNoise.selectionFailed'), { log: 'AUDIO', error });
      } finally {
        btnRnnoise.disabled = false;
      }
    });

    slot.querySelector('#sidebar-btn-leave-voice')?.addEventListener('click', leaveCall);

    this.startPing();
  }

  /**
   * Keeps the server rail clear of the floating user card (#473).
   *
   * The card overlaps the bottom of the rail, so without reserving room the
   * last servers in a long list would sit behind it, unreachable. The height is
   * measured instead of hardcoded because it changes with the screen-share
   * notice and the voice connection row.
   */
  public observeHeight(): void {
    this.cardObserver?.disconnect();
    this.cardObserver = null;

    const layout = this.host.root.querySelector<HTMLElement>('.main-layout');
    const card = this.host.root.querySelector<HTMLElement>('.user-control-bar');
    if (!layout || !card) return;

    const apply = () => {
      layout.style.setProperty('--user-card-height', `${Math.ceil(card.getBoundingClientRect().height)}px`);
    };
    apply();

    if (typeof ResizeObserver === 'undefined') return;
    this.cardObserver = new ResizeObserver(apply);
    this.cardObserver.observe(card);
  }

  public stopPing(): void {
    this.unbindPing?.();
    this.unbindPing = null;
  }

  public destroy(): void {
    this.stopPing();
    this.cardObserver?.disconnect();
    this.cardObserver = null;
  }

  private startPing(): void {
    this.stopPing();
    const update = () => {
      const pingEl = this.host.root.querySelector<HTMLElement>('#sidebar-voice-ping');
      if (!pingEl) return;
      const isSfu = webRtcManager.isSfuMode();
      const channelId = voiceStore.currentVoiceChannelId;
      const sessionKey = voiceStore.voiceSessionKey;
      const participants = (sessionKey ? sessionManager.get(sessionKey)?.participants.getInVoiceChannel(channelId ?? '') : undefined) ?? [];
      // An idle call has no media flowing, so there is no ping to measure yet.
      const pending = voiceStore.isConnecting || voiceStore.isReconnecting || voiceStore.isIdle;
      const avg = pending ? null : participants.length <= 1 && !isSfu ? 0 : webRtcManager.getCallPing();
      pingEl.textContent = avg !== null ? `${avg} ms` : '-- ms';
      const { quality, icon } = voiceConnectionIndicator(avg, voiceStore.isReconnecting, voiceStore.isConnecting);
      const signal = this.host.root.querySelector<HTMLElement>('.voice-conn-signal');
      if (signal) {
        signal.textContent = icon;
        signal.className = `material-symbols-outlined md-16 voice-conn-signal ${quality}`;
      }
      const label = voiceStore.isReconnecting ? t('main.reconnecting')
        : voiceStore.isConnecting ? t('main.connecting')
        : quality === 'good' ? t('stage.qualityExcellent')
        : quality === 'medium' ? t('stage.qualityGood')
        : quality === 'bad' ? t('stage.qualityPoor') : t('stage.pingCalculating');
      const info = this.host.root.querySelector<HTMLElement>('.voice-conn-info');
      if (info) info.title = voiceStore.isReconnecting ? t('main.reconnectingTitle')
        : voiceStore.isConnecting ? t('main.connectingTitle')
        : voiceStore.isIdle ? t('main.voiceIdleTitle')
        : `${isSfu ? 'SFU' : 'P2P'} · ${pingEl.textContent} · ${label}`;
    };
    update();
    // The call measures its links once for every view showing the ping (R-VOICEUI-7).
    this.unbindPing = appEvents.on('voice.ping_updated', update);
  }

  private updateDeafenControl(): void {
    const button = this.host.root.querySelector<HTMLElement>('#bar-btn-deafen');
    if (!button) return;
    const moderation = getVoiceControlModeration();
    button.className = `btn btn-icon ${voiceStore.isDeafened ? 'danger-active' : ''}`;
    button.setAttribute('aria-pressed', String(voiceStore.isDeafened));
    button.title = [t(voiceStore.isDeafened ? 'main.undeafen' : 'main.deafen'), moderation.deafenReason].filter(Boolean).join('. ');
    updateAudioStateIcon(button, voiceStore.isDeafened ? 'headset_off' : 'headphones', moderation.serverDeafened);
  }

  /** The noise switch of the voice row and the presence status follow the settings (#561). */
  private syncSettings(): void {
    const btnRnnoise = this.host.root.querySelector<HTMLElement>('#sidebar-btn-rnnoise');
    if (btnRnnoise) {
      const mode = settingsStore.noiseSuppressionMode;
      const enabled = mode !== 'off';
      const title = noiseSuppressionToggleTitle(mode);
      btnRnnoise.className = `btn btn-icon voice-conn-rnnoise ${enabled ? 'rnnoise-active' : ''}`;
      btnRnnoise.setAttribute('title', title);
      btnRnnoise.setAttribute('aria-label', title);
      btnRnnoise.setAttribute('aria-pressed', String(enabled));
    }
    const dot = this.host.root.querySelector<HTMLElement>('#main-user-status-dot');
    const presence = presenceIndicator();
    if (dot) {
      dot.className = `status-indicator status-indicator-button ${presence.className}`;
      dot.setAttribute('style', presence.style);
      dot.setAttribute('aria-label', t('main.changeStatusAria', { status: presence.label }));
    }
    const statusText = this.host.root.querySelector<HTMLElement>('#main-user-status-text');
    if (statusText) statusText.textContent = presence.label;
  }

  private ensureInVoiceChannel(): boolean {
    if (voiceStore.currentVoiceChannelId) return true;
    void showAlert({
      title: t('main.joinVoiceFirstTitle'),
      message: t('main.joinVoiceFirstMessage'),
      variant: 'warning',
    });
    return false;
  }

  /** Leaves the server on screen, after asking; the call, if it is elsewhere, goes on (#400). */
  private async disconnect(): Promise<void> {
    const session = sessionManager.getActive();
    if (!session) return;
    const confirmed = await showConfirm({
      title: t('main.disconnect'),
      message: t('main.disconnectServerMessage', { name: session.serverStore.serverDetails?.name ?? session.host }),
      confirmLabel: t('main.disconnect'),
      variant: 'danger',
    });
    if (!confirmed || sessionManager.get(session.key) !== session) return;
    // Captured before the socket closes: afterwards there is no way to tell
    // whether this user was hosting the server they just left (#334).
    const leaveState = await captureHostedServerLeaveState(session.client.getCurrentServerUrl());
    appEvents.emit('connection.manual_disconnect', { key: session.key });
    // Microphone and peer mesh are shared by every session (#400): tearing
    // them down while the call lives on another server would kill the audio
    // and still leave the user listed in that server's voice channel.
    session.client.disconnect();
    const next = sessionManager.getAll().find(candidate => candidate.client.getStatus() === 'CONNECTED');
    if (next) sessionManager.activate(next.key);
    else showHome();
    if (leaveState) await promptShutdownAfterLeave(leaveState);
  }
}
