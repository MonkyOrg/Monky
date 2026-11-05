import { PUBLIC_AUDIENCE, screenFormatSchema, type ScreenFormat, type ResourceAudience } from '@monky/shared';
import { html, trustedHtml } from '../../utils/html';
import { appEvents } from '../../core/EventBus';
import { captureScreenShareCall, screenShareLimit, type ScreenShareCall } from '../../core/screenShareControls';
import { startScreenShare } from '../../core/screenShareStart';
import { videoService } from '../../core/VideoService';
import { webRtcManager } from '../../core/WebRtcManager';
import { nativeScreenProfile } from '../../core/webrtc/NativeScreenController';
import { voiceStore } from '../../stores/voiceStore';
import { setButtonLoading } from '../../utils/buttonLoading';
import { openModal, type ModalShell } from '../../utils/modalShell';
import { renderChoiceCards, renderSwitch, selectChoiceCard } from '../../utils/formControls';
import { screenFormatChoice } from './screenFormatChoices';
import { settingsStore } from '../../stores/settingsStore';
import { ScreenShareUserError, screenShareFailureMessage } from '../../utils/screenShareFailure';
import { t } from '../../i18n';
import { showAlert } from '../Dialog';
import { showErrorToast } from '../CopyToast';
import { screenShareChooser } from '../ScreenShareChooser';
import { ResourceAudiencePicker, type AudienceTexts } from '../ResourceAudiencePicker';
import { hasUnownedAudio, planBrowserAudio, type LiveScreens } from './captureRules';
import { confirmExtraScreen } from './extraScreens';
import { isDesktopOnly, setDesktopOnly } from '../../utils/desktopOnly';

const SCREEN_AUDIENCE_TEXTS: AudienceTexts = {
  private: 'screenShare.privateLabel', description: 'screenShare.privateDescription', who: 'screenShare.privateAudience',
  search: 'screenShare.privateSearch', choose: 'screenShare.privateChoose', noResults: 'screenShare.privateNoResults',
  empty: 'screenShare.privateEmpty', selected: 'screenShare.privateSelected', roles: 'screenShare.privateRoles',
  members: 'screenShare.privateUsers', more: 'screenShare.privateMore',
};


function liveScreens(): LiveScreens {
  return {
    shareIds: voiceStore.screenShareIds,
    audioShareIds: voiceStore.screenAudioShareIds,
    capture: shareId => videoService.getNativeScreenCapture(shareId),
  };
}

/**
 * Screen sharing where the browser chooses what to share (#858). The app keeps its own choices, sound and
 * who can watch, and the share button opens the browser's dialog directly: it only opens on a click, and
 * lists the tabs, windows and screens the app cannot see. The rest of the start is the desktop's.
 */
export class BrowserScreenSharePicker {
  private shell: ModalShell | null = null;
  private call: ScreenShareCall | null = null;
  private audience = this.createAudience(PUBLIC_AUDIENCE);
  private captureAudio = false;
  /** What the browser captures is known: the sound row shows, working or locked. */
  private capabilitiesKnown = false;
  private available = false;
  /** The formats this browser can share in, the compatible one first. */
  private formats: readonly ScreenFormat[] = [];
  private starting = false;

  private createAudience(initial: ResourceAudience): ResourceAudiencePicker {
    return new ResourceAudiencePicker(() => this.call?.serverStore ?? null, 'share-audience', initial, 'adaptive',
      'audience', { texts: SCREEN_AUDIENCE_TEXTS, externalSwitch: true, className: 'share-audience-field' });
  }

  public open(): void {
    this.shell?.close('api');
    this.call = captureScreenShareCall();
    const alreadySharing = voiceStore.isScreenSharing;
    const retained = videoService.getNativeScreenCaptures().find(capture => capture.source.audience)?.source.audience;
    this.audience = this.createAudience(retained
      ? { visibility: 'private', userIds: [...retained.userIds], roleIds: [...retained.roleIds] } : PUBLIC_AUDIENCE);
    const profile = nativeScreenProfile(videoService.getProfile());
    const canAdd = alreadySharing && voiceStore.canAddScreenShare(screenShareLimit(this.call));
    const shell = openModal({
      card: html`
      <div class="modal-card screen-share-picker-card" role="dialog" aria-modal="true" aria-labelledby="share-picker-title"
        aria-describedby="share-browser-description">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);" aria-hidden="true">screen_share</span>
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
        <p id="share-browser-description" class="audio-device-status">${t('screenShare.browserPickerDescription')}</p>
        <p id="share-capture-info" class="share-game-tip" role="status">${profile ? t('screenShare.browserProfile', {
          width: profile.width, height: profile.height, fps: profile.fps, bitrate: profile.maxBitrateKbps,
        }) : t('screenShare.nativeProfileChangeBlocked')}</p>
        <div id="share-browser-format" class="share-aspect-option" hidden>
          <div><span id="share-format-label">${t('screenShare.format')}</span></div>
          <div id="share-format-cards"></div>
        </div>
        <div id="share-browser-audio" class="share-aspect-option" hidden>
          <div>
            <label id="share-audio-text" for="chk-share-audio">${t('screenShare.browserAudio')}</label>
            ${renderSwitch({ id: 'chk-share-audio', labelledBy: 'share-audio-text', describedBy: 'share-audio-description',
              checked: !hasUnownedAudio(liveScreens()), className: 'share-audio-toggle' })}
          </div>
          <p id="share-audio-description" class="audio-device-status">${t('screenShare.browserAudioDescription')}</p>
        </div>
        <div class="share-aspect-option">
          <div>
            <label id="share-private-label" for="chk-private-share">${t('screenShare.privateLabel')}</label>
            ${renderSwitch({ id: 'chk-private-share', labelledBy: 'share-private-label', describedBy: 'share-private-description',
              checked: !!retained, attributes: html`aria-controls="share-audience"` })}
          </div>
          <p id="share-private-description" class="audio-device-status">${t('screenShare.privateDescription')}</p>
        </div>
        ${trustedHtml(this.audience.render())}
        <div class="modal-footer">
          <button type="button" id="btn-cancel" class="btn btn-secondary" data-modal-close>${t('common.cancel')}</button>
          ${canAdd ? html`
            <button type="button" id="btn-share-add" class="btn btn-secondary" disabled>
              <span class="material-symbols-outlined md-16" style="margin-right: 4px;" aria-hidden="true">add_to_queue</span>
              ${t('screenShare.confirmAdd')}
            </button>
          ` : ''}
          <button type="button" id="btn-share" class="btn btn-primary" disabled>
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;" aria-hidden="true">present_to_all</span>
            ${alreadySharing ? t('screenShare.confirmSwitch') : t('screenShare.confirm')}
          </button>
        </div>
      </div>
    `,
      initialFocus: '#btn-cancel',
      onClose: () => this.teardown(shell),
    });
    this.shell = shell;
    const modal = shell.element;
    const options = { signal: shell.signal };
    modal.querySelector<HTMLInputElement>('#chk-private-share')?.addEventListener('change', event => {
      if (!this.starting && event.currentTarget instanceof HTMLInputElement) {
        this.audience.setPrivate(modal, event.currentTarget.checked);
        this.update();
      }
    }, options);
    this.audience.bind(shell.card, shell.signal, () => this.update());
    modal.querySelector('#btn-share')?.addEventListener('click', () => { void this.requestReplace(); }, options);
    modal.querySelector('#btn-share-add')?.addEventListener('click', () => { void this.start('add'); }, options);
    modal.querySelector('#share-format-cards')?.addEventListener('click', event => {
      const card = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-screen-format]') : null;
      const format = screenFormatSchema.safeParse(card?.dataset.screenFormat);
      if (!card || this.starting || !format.success || !this.formats.includes(format.data)) return;
      settingsStore.setScreenFormat(format.data);
      selectChoiceCard(modal, 'data-screen-format', format.data);
    }, options);
    this.update();
    appEvents.emit('modal.screenshare_picker_opened');
    void webRtcManager.getNativeScreenCapabilities().then(capabilities => {
      if (this.shell !== shell) return;
      this.available = capabilities.capture && profile !== null;
      this.captureAudio = capabilities.captureAudio;
      this.formats = capabilities.browserFormats ?? [];
      this.capabilitiesKnown = true;
      const info = modal.querySelector<HTMLElement>('#share-capture-info');
      if (info && !capabilities.capture) info.textContent = t('screenShare.browserUnavailable');
      this.renderFormats(modal);
      this.update();
    }, (error: unknown) => {
      console.error('[ScreenShare] Browser capture capabilities are unavailable:', error);
      const info = modal.querySelector<HTMLElement>('#share-capture-info');
      if (this.shell === shell && info) info.textContent = t('screenShare.browserUnavailable');
    });
  }

  /** The compatible format by default; a better one only where this browser encodes it (#858). */
  private renderFormats(modal: HTMLElement): void {
    const section = modal.querySelector<HTMLElement>('#share-browser-format');
    const cards = modal.querySelector<HTMLElement>('#share-format-cards');
    if (!section || !cards) return;
    // A single format leaves nothing to choose.
    section.hidden = this.formats.length < 2;
    if (!this.formats.length) return;
    if (!this.formats.includes(settingsStore.screenFormat)) settingsStore.setScreenFormat(this.formats[0]);
    if (section.hidden) return;
    cards.innerHTML = renderChoiceCards({
      id: 'share-format-choice', label: t('screenShare.format'), attribute: 'data-screen-format',
      selected: settingsStore.screenFormat, choices: this.formats.map(screenFormatChoice),
    }).toString();
  }

  /** The controls follow the start in flight, the audience and the sound another share already carries. */
  private update(): void {
    const modal = this.shell?.element;
    if (!modal) return;
    const privacy = modal.querySelector<HTMLInputElement>('#chk-private-share');
    if (privacy) {
      privacy.checked = this.audience.value().visibility === 'private';
      privacy.disabled = this.starting;
    }
    this.audience.setDisabled(modal, this.starting);
    // A browser that captures no sound shows the row as the desktop has it, locked (#858).
    const audioLocked = this.capabilitiesKnown && !this.captureAudio && isDesktopOnly('nativeScreenAudio');
    const audioRow = modal.querySelector<HTMLElement>('#share-browser-audio');
    if (audioRow) {
      audioRow.hidden = !this.captureAudio && !audioLocked;
      setDesktopOnly(audioRow, audioLocked ? 'screenAudio' : null, audioRow.querySelector<HTMLElement>(':scope > div') ?? audioRow);
    }
    const audio = modal.querySelector<HTMLInputElement>('#chk-share-audio');
    // Sound still being set up for another share belongs to nobody yet; any other case is explained on click.
    const taken = hasUnownedAudio(liveScreens());
    if (audio && audioLocked) {
      audio.disabled = false;
      audio.checked = false;
      audio.title = '';
    } else if (audio) {
      audio.disabled = this.starting || voiceStore.permissionMuted || taken;
      if (audio.disabled && !this.starting) audio.checked = false;
      audio.title = voiceStore.permissionMuted ? t('permissions.permissionMuted') : taken ? t('screenShare.audioAlreadySharing') : '';
    }
    modal.querySelectorAll<HTMLButtonElement>('#btn-share, #btn-share-add').forEach(button => {
      button.disabled = this.starting || !this.available || !this.audience.isValid();
    });
    modal.querySelectorAll<HTMLButtonElement>('[data-screen-format]').forEach(card => { card.disabled = this.starting; });
    modal.querySelector<HTMLButtonElement>('#btn-share')
      ?.setAttribute('aria-haspopup', voiceStore.screenShareIds.length > 1 ? 'menu' : 'false');
  }

  /** Switching with several live shares first asks which one the new capture replaces. */
  private async requestReplace(): Promise<void> {
    const shell = this.shell;
    const button = shell?.element.querySelector<HTMLButtonElement>('#btn-share');
    if (!shell || !button || button.disabled || this.starting) return;
    if (voiceStore.screenShareIds.filter(shareId => videoService.getScreenStream(shareId) !== null).length < 2) {
      await this.start('replace');
      return;
    }
    if (screenShareChooser.isOpenFor(button)) {
      screenShareChooser.close();
      return;
    }
    const selection = await screenShareChooser.choose(button, 'switch');
    if (this.shell !== shell || !selection || !('shareId' in selection)
      || !voiceStore.screenShareIds.includes(selection.shareId)) return;
    await this.start('replace', selection.shareId);
  }

  private async start(mode: 'add' | 'replace', targetShareId?: string): Promise<void> {
    const shell = this.shell;
    if (!shell || this.starting) return;
    const modal = shell.element;
    if (!this.audience.isValid()) {
      this.update();
      this.audience.showOptions();
      return;
    }
    const call = this.call ?? captureScreenShareCall();
    const limit = screenShareLimit(call);
    if (mode === 'add' && !voiceStore.canAddScreenShare(limit)) {
      await showAlert({ title: t('screenShare.limitTitle'), message: t('screenShare.limitMessage', { max: String(limit) }),
        variant: 'warning' });
      return;
    }
    const plan = planBrowserAudio({ mode, targetShareId }, liveScreens());
    const wantsAudio = this.captureAudio && !voiceStore.permissionMuted
      && (modal.querySelector<HTMLInputElement>('#chk-share-audio')?.checked ?? false);
    // Another share keeps its sound: the switch is right there to share this one silently.
    if (wantsAudio && plan.kind === 'blocked') {
      showErrorToast(t('screenShare.browserAudioTakenToast'), 6000);
      modal.querySelector<HTMLInputElement>('#chk-share-audio')?.focus({ preventScroll: true });
      return;
    }
    const audience = this.audience.value();
    const button = modal.querySelector<HTMLButtonElement>(mode === 'add' ? '#btn-share-add' : '#btn-share');
    this.starting = true;
    this.update();
    setButtonLoading(button, true);
    let sourceId: string | null = null;
    try {
      // The browser's dialog comes after every question of the app, still inside the click that asked for it.
      if (mode === 'add' && !await confirmExtraScreen(limit, shell.signal)) return;
      if (this.shell !== shell) return;
      const profile = nativeScreenProfile(videoService.getProfile());
      if (!profile) throw new ScreenShareUserError(t('screenShare.nativeProfileChangeBlocked'));
      const capture = await window.api.captureDisplay({ audio: wantsAudio, video: profile });
      if (!capture) return;
      sourceId = capture.sourceId;
      if (this.shell !== shell || !call.isCurrent()) return;
      const audio = wantsAudio && capture.audio;
      const outcome = await startScreenShare({
        mode, targetShareId, sourceId: capture.sourceId, label: capture.label, captureKind: capture.captureKind, audio,
        audioHandover: audio && plan.kind === 'free' ? { handedOver: plan.handedOver, askTakeover: [] } : null,
        macSystemMix: false, preserveAspectRatio: true,
        audience: audience.visibility === 'private' ? { userIds: audience.userIds, roleIds: audience.roleIds } : undefined,
      }, {
        call,
        isOpen: () => this.shell === shell,
        isSelected: () => true,
        confirmExtraScreen: () => Promise.resolve(true),
        confirmAudioTakeover: () => Promise.resolve(false),
        confirmMacSystemAudio: () => Promise.resolve(true),
        captureBlocked: () => null,
      });
      if (outcome === 'published' && this.shell === shell) this.close();
    } catch (error) {
      if ((error instanceof Error && error.name === 'AbortError') || this.shell !== shell || !call.isCurrent()) {
        if (this.shell === shell) this.close();
        return;
      }
      await showAlert({ title: t('screenShare.errorTitle'), message: screenShareFailureMessage(error, 'start'), variant: 'danger' });
    } finally {
      // A capture that never went on air is not kept: the browser would keep showing it as shared.
      if (sourceId && !videoService.getActiveSourceIds().has(sourceId)) window.api.releaseScreenCapture(sourceId);
      if (this.shell === shell) {
        this.starting = false;
        setButtonLoading(button, false);
        this.update();
      }
    }
  }

  public close(): void {
    this.shell?.close('api');
  }

  private teardown(shell: ModalShell): void {
    if (this.shell !== shell) return;
    if (screenShareChooser.isOpenWithin(shell.element)) screenShareChooser.close();
    this.shell = null;
    this.call = null;
    this.starting = false;
    this.available = false;
    this.formats = [];
    this.captureAudio = false;
    this.capabilitiesKnown = false;
    appEvents.emit('modal.screenshare_picker_closed');
  }
}

export const browserScreenSharePicker = new BrowserScreenSharePicker();
