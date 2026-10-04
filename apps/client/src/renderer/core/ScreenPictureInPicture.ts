import { Permission } from '@monky/shared';
import { appEvents } from './EventBus';
import { sessionManager } from './SessionManager';
import { voiceStore } from '../stores/voiceStore';
import { settingsStore } from '../stores/settingsStore';
import { showInfoToast } from '../views/CopyToast';
import { t } from '../i18n';

export interface ScreenPictureInPictureSource {
  sessionKey: string;
  channelId: string;
  publisherSessionId: string;
  shareId: string;
  stream: MediaStream;
}

interface Presentation {
  video: HTMLVideoElement;
  source: ScreenPictureInPictureSource;
  opening: boolean;
  automatic: boolean;
  returning: boolean;
  windowActive: boolean;
  focusedTileKeys: readonly string[];
  host: HTMLElement | null;
  dispose: Array<() => void>;
}

const PIP_LEAVE_SETTLE_MS = 150;

class ScreenPictureInPicture {
  private current: Presentation | null = null;

  private isAuthorized(source: ScreenPictureInPictureSource): boolean {
    const session = sessionManager.get(source.sessionKey);
    const participant = session?.participants.get(source.publisherSessionId);
    const localId = session?.serverStore.currentUser?.sessionId ?? session?.serverStore.currentUser?.id;
    const stream = source.shareId === 'legacy'
      ? participant?.remoteScreenStreams.values().next().value
      : participant?.remoteScreenStreams.get(source.shareId);
    return !!session && localId !== source.publisherSessionId
      && voiceStore.voiceSessionKey === source.sessionKey
      && voiceStore.currentVoiceChannelId === source.channelId
      && participant?.voiceState?.channelId === source.channelId
      && session.serverStore.hasPermission(Permission.VIEW_CHANNEL, source.channelId)
      && voiceStore.isWatchingScreen(source.publisherSessionId, source.shareId)
      && stream === source.stream;
  }

  public async open(
    video: HTMLVideoElement,
    source: ScreenPictureInPictureSource,
    automatic?: 'navigation' | 'window-inactive',
    focusedTileKeys: readonly string[] = [],
  ): Promise<void> {
    if (!this.isAuthorized(source)) {
      if (!automatic) throw new Error('The screen Picture-in-Picture source is no longer authorized.');
      return;
    }
    if (document.pictureInPictureElement === video) return;
    if (automatic && (!settingsStore.screenShareAutoPictureInPicture
      || this.current?.opening || document.pictureInPictureElement
      || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !source.stream.active)) return;
    if (this.current) this.retire(this.current);
    const entry: Presentation = {
      video, source, opening: true, automatic: !!automatic, returning: !!automatic,
      windowActive: automatic !== 'window-inactive',
      focusedTileKeys: [...focusedTileKeys], host: null, dispose: [],
    };
    this.current = entry;
    const requestId = crypto.randomUUID();
    video.dataset.monkyScreenPip = requestId;
    const invalidate = (): void => {
      if (this.current === entry && !this.isAuthorized(source)) this.close(true);
    };
    for (const event of ['voice.channel_changed', 'voice.screen_watch_changed', 'participants.updated',
      'session.voice_context_updated', 'server.updated', 'server.roles_updated', 'native_screen.updated']) {
      entry.dispose.push(appEvents.on(event, invalidate));
    }
    const ended = (): void => { if (this.current === entry) this.close(true); };
    for (const track of source.stream.getVideoTracks()) {
      track.addEventListener('ended', ended);
      entry.dispose.push(() => track.removeEventListener('ended', ended));
    }
    const left = (): void => this.left(entry);
    video.addEventListener('leavepictureinpicture', left);
    this.bindMediaSession(entry);
    entry.dispose.push(() => video.removeEventListener('leavepictureinpicture', left));
    const unbindInactive = window.api.onWindowInactive(() => { entry.windowActive = false; });
    const unbindActive = window.api.onWindowActive(() => {
      entry.windowActive = true;
      appEvents.emit('screen_pip.stage_return');
    });
    entry.dispose.push(unbindInactive, unbindActive);
    try {
      // Alt+Tab has no transient DOM activation. Main grants it only to this
      // owned video, rather than changing Chromium's global gesture policy.
      const opened = automatic
        ? await window.api.openScreenPictureInPicture(requestId, automatic === 'window-inactive')
        : await video.requestPictureInPicture().then(() => true);
      if (this.current !== entry) {
        if (document.pictureInPictureElement === video && this.current?.video !== video) {
          await document.exitPictureInPicture();
        }
        return;
      }
      entry.opening = false;
      if (!opened) {
        this.retire(entry);
        return;
      }
      if (!this.isAuthorized(source) || (automatic && !settingsStore.screenShareAutoPictureInPicture)) {
        this.close(!this.isAuthorized(source));
        return;
      }
      if (automatic) showInfoToast(t('stage.automaticPictureInPicture'), 7000);
    } catch (error) {
      if (this.current !== entry) return;
      this.retire(entry);
      throw error;
    }
  }

  public markStageLeft(
    sessionKey: string | null, channelId: string | null, reason: 'navigation' | 'window-inactive',
  ): void {
    const entry = this.current;
    if (entry?.source.sessionKey === sessionKey && entry.source.channelId === channelId
      && (reason === 'navigation' || entry.automatic)) {
      entry.returning = true;
    }
  }

  public getStageReturn(
    sessionKey: string | null, channelId: string | null,
  ): Pick<Presentation, 'video' | 'source' | 'focusedTileKeys'> | null {
    const entry = this.current;
    if (!entry || !entry.returning || !entry.windowActive
      || entry.source.sessionKey !== sessionKey || entry.source.channelId !== channelId) return null;
    if (!this.isAuthorized(entry.source)) {
      this.close(true);
      return null;
    }
    return entry;
  }

  public restoreToStage(video: HTMLVideoElement, target: HTMLVideoElement): boolean {
    const entry = this.current;
    if (!entry || entry.video !== video
      || this.getStageReturn(entry.source.sessionKey, entry.source.channelId) !== entry
      || !target.isConnected || target.srcObject !== entry.source.stream) return false;
    if (target !== video) {
      // Move the playing element back; do not restart the receiver or its tracks.
      video.id = target.id;
      video.className = target.className;
      video.style.cssText = target.style.cssText;
      target.pause();
      target.srcObject = null;
      target.replaceWith(video);
    }
    entry.host?.remove();
    entry.host = null;
    this.close();
    return true;
  }

  /** The receiver owns the tracks; only the presentation outlives the stage. */
  public retain(video: HTMLVideoElement): boolean {
    const entry = this.current;
    if (!entry || entry.video !== video) return false;
    if (!this.isAuthorized(entry.source)) {
      this.close(true);
      return false;
    }
    const host = document.createElement('div');
    host.className = 'screen-pip-host';
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    document.body.append(host);
    video.removeAttribute('id');
    host.append(video);
    entry.host = host;
    return true;
  }

  public close(stopVideo = false): void {
    const entry = this.current;
    if (!entry) return;
    // Revoked media is blanked synchronously, before Chromium closes its window.
    if (stopVideo || entry.host) {
      entry.video.pause();
      entry.video.srcObject = null;
    }
    if (document.pictureInPictureElement === entry.video) {
      void document.exitPictureInPicture().catch(error => {
        console.warn('[ScreenPictureInPicture] Could not close the presentation:', error);
      });
    }
    this.retire(entry);
  }

  /**
   * Chromium pauses the video when the PiP close button is used only while
   * the page handles media pause; "back to tab" never pauses. Without these
   * handlers both buttons produce the same leave event.
   */
  private bindMediaSession(entry: Presentation): void {
    const session = navigator.mediaSession;
    if (!session) return;
    const actions = ['play', 'pause'] as const;
    try {
      session.setActionHandler('play', () => { void entry.video.play().catch(() => {}); });
      session.setActionHandler('pause', () => entry.video.pause());
    } catch {
      return;
    }
    entry.dispose.push(() => {
      for (const action of actions) {
        try { session.setActionHandler(action, null); } catch { /* unsupported action */ }
      }
    });
  }

  private left(entry: Presentation): void {
    if (entry.opening) {
      this.retire(entry);
      return;
    }
    // The close button's pause is delivered separately from the leave event.
    window.setTimeout(() => this.settleLeave(entry), PIP_LEAVE_SETTLE_MS);
  }

  private settleLeave(entry: Presentation): void {
    if (this.current !== entry || document.pictureInPictureElement === entry.video) return;
    if (entry.video.paused) {
      // The close button paused the shared element; a stage that still shows
      // it keeps the broadcast live.
      if (!entry.host && entry.video.isConnected && entry.video.srcObject) {
        void entry.video.play().catch(() => {});
      }
      this.retire(entry);
      return;
    }
    entry.returning = true;
    entry.windowActive = true;
    void window.api.returnFromScreenPictureInPicture().catch(error => {
      console.warn('[ScreenPictureInPicture] Could not bring Monky forward:', error);
    });
    appEvents.emit('screen_pip.return_to_call', { sessionKey: entry.source.sessionKey, channelId: entry.source.channelId });
    // Whatever the stage could not take back must not linger in the background.
    if (this.current === entry) this.retire(entry);
  }

  private retire(entry: Presentation): void {
    entry.dispose.forEach(dispose => dispose());
    entry.dispose = [];
    delete entry.video.dataset.monkyScreenPip;
    if (entry.host) {
      entry.video.pause();
      entry.video.srcObject = null;
      entry.host.remove();
    }
    if (this.current === entry) this.current = null;
  }
}

export const screenPictureInPicture = new ScreenPictureInPicture();
