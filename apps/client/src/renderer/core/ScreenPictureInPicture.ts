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
  publisherName: string;
  shareId: string;
  stream: MediaStream;
}

/** Focus a manual PiP took off its stage, returned when it ends without being brought back. */
export interface ScreenPictureInPictureRelease {
  sessionKey: string;
  channelId: string;
  tileKey: string;
}

interface Presentation {
  requestId: string;
  video: HTMLVideoElement;
  source: ScreenPictureInPictureSource;
  opening: boolean;
  automatic: boolean;
  returning: boolean;
  windowActive: boolean;
  focusedTileKeys: readonly string[];
  host: HTMLElement | null;
  window: Window | null;
  pipVideo: HTMLVideoElement | null;
  dispose: Array<() => void>;
}

// Must match SCREEN_PIP_FRAME_PREFIX in src/main/screenPictureInPictureWindow.ts.
const PIP_FRAME_PREFIX = 'monky-screen-pip-';

// Main sets --monky-pip-hover while the cursor is over the window: a draggable
// page never receives mouse hover itself.
const PIP_STYLE = `
:root { color-scheme: dark; }
html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
body { -webkit-app-region: drag; user-select: none; font-family: system-ui, sans-serif; }
video { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000; pointer-events: none; }
.shade {
  position: fixed; inset: 0 0 auto 0; height: 64px; pointer-events: none;
  background: linear-gradient(rgba(0, 0, 0, .65), rgba(0, 0, 0, 0));
  opacity: var(--monky-pip-hover, 0); transition: opacity .15s ease;
}
.controls {
  position: fixed; top: 8px; right: 8px; display: flex; gap: 6px; -webkit-app-region: no-drag;
  opacity: var(--monky-pip-hover, 0); transition: opacity .15s ease;
}
.controls:focus-within { opacity: 1; }
button {
  -webkit-app-region: no-drag; display: grid; place-items: center; width: 32px; height: 32px; padding: 0;
  border: 0; border-radius: 6px; background: rgba(18, 18, 22, .75); color: #fff; cursor: pointer;
}
button:hover { background: rgba(64, 64, 72, .92); }
button:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
@media (prefers-reduced-motion: reduce) { .shade, .controls { transition: none; } }
`;

const BACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/>'
  + '<path d="M16 9l-6 6M10 10v5h5"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/**
 * Monky's own Picture-in-Picture for watched screen broadcasts: a floating
 * popup that shows the same MediaStream and owns its buttons, so "back to
 * Monky" and close never depend on how Chromium reports its native window.
 */
class ScreenPictureInPicture {
  private current: Presentation | null = null;

  public isAvailable(): boolean {
    return typeof window.api?.openScreenPictureInPicture === 'function';
  }

  public isPresenting(video: HTMLVideoElement): boolean {
    return this.current?.video === video && (this.current.opening || !!this.current.window);
  }

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
    if (this.isPresenting(video)) return;
    if (automatic && (!settingsStore.screenShareAutoPictureInPicture
      || this.current?.opening || this.current?.window
      || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !source.stream.active)) return;
    const previous = this.current;
    const entry: Presentation = {
      requestId: crypto.randomUUID(), video, source, opening: true, automatic: !!automatic, returning: !!automatic,
      windowActive: automatic !== 'window-inactive',
      focusedTileKeys: [...focusedTileKeys], host: null, window: null, pipVideo: null, dispose: [],
    };
    // Current first: the stage rerenders while the previous one retires and
    // must already retain this video instead of releasing it.
    this.current = entry;
    if (previous) this.retire(previous);
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
    const unbindInactive = window.api.onWindowInactive(() => { entry.windowActive = false; });
    const unbindActive = window.api.onWindowActive(() => {
      entry.windowActive = true;
      appEvents.emit('screen_pip.stage_return');
    });
    entry.dispose.push(unbindInactive, unbindActive);
    try {
      const aspectRatio = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
      // Main authorizes exactly this popup; the automatic one only while
      // Monky is still minimized or hidden to the tray.
      const opened = await window.api.openScreenPictureInPicture(
        entry.requestId, automatic === 'window-inactive', aspectRatio);
      if (this.current !== entry) return;
      entry.opening = false;
      if (!opened) {
        this.retire(entry);
        return;
      }
      if (!this.isAuthorized(source) || (automatic && !settingsStore.screenShareAutoPictureInPicture)) {
        this.close(!this.isAuthorized(source));
        return;
      }
      if (!this.present(entry)) throw new Error('The screen Picture-in-Picture window could not be opened.');
      if (automatic) showInfoToast(t('stage.automaticPictureInPicture'), 7000);
    } catch (error) {
      if (this.current !== entry) return;
      this.retire(entry);
      throw error;
    }
  }

  /** Only automatic PiP returns by itself; a manual one stays until it is brought back or closed. */
  public markStageLeft(sessionKey: string | null, channelId: string | null): void {
    const entry = this.current;
    if (entry?.automatic && entry.source.sessionKey === sessionKey && entry.source.channelId === channelId) {
      entry.returning = true;
    }
  }

  /** Tile key of the broadcast a manual PiP has taken off this stage, if any. */
  public getStageExclusiveTileKey(sessionKey: string | null, channelId: string | null): string | null {
    const entry = this.current;
    if (!entry || !this.isExclusive(entry)
      || entry.source.sessionKey !== sessionKey || entry.source.channelId !== channelId) return null;
    return tileKeyOf(entry);
  }

  /** Brings the manual PiP broadcast back to the call stage and closes the window. */
  public returnToStage(): void {
    if (this.current) this.handBack(this.current);
  }

  public getStageReturn(
    sessionKey: string | null, channelId: string | null,
  ): Pick<Presentation, 'video' | 'source' | 'focusedTileKeys' | 'automatic'> | null {
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

  /**
   * The stage element keeps playing hidden while the popup is up, so
   * returning to the call swaps it back without a black frame.
   */
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
    if (stopVideo || entry.host) {
      entry.video.pause();
      entry.video.srcObject = null;
    }
    this.retire(entry);
  }

  private present(entry: Presentation): boolean {
    const child = window.open('', `${PIP_FRAME_PREFIX}${entry.requestId}`, 'popup');
    if (!child) return false;
    entry.window = child;
    const doc = child.document;
    doc.documentElement.lang = document.documentElement.lang;
    doc.title = t('stage.pictureInPictureWindowTitle', { name: entry.source.publisherName });
    const style = doc.createElement('style');
    style.textContent = PIP_STYLE;
    doc.head.append(style);
    const video = doc.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.disablePictureInPicture = true;
    video.srcObject = entry.source.stream;
    entry.pipVideo = video;
    const shade = doc.createElement('div');
    shade.className = 'shade';
    const controls = doc.createElement('div');
    controls.className = 'controls';
    const back = this.createButton(doc, 'back', t('stage.pictureInPictureReturn'), BACK_ICON);
    const close = this.createButton(doc, 'close', t('common.close'), CLOSE_ICON);
    back.addEventListener('click', () => this.returnToCall(entry));
    close.addEventListener('click', () => this.dismiss(entry));
    controls.append(back, close);
    doc.body.append(video, shade, controls);
    void video.play().catch(() => {});
    // Alt+F4 or the system closing the popup ends the presentation too.
    child.addEventListener('pagehide', () => {
      if (entry.window === child) this.dismiss(entry);
    });
    if (!entry.automatic) appEvents.emit('screen_pip.updated');
    return true;
  }

  private isExclusive(entry: Presentation): boolean {
    return !entry.automatic && !!entry.window && !entry.returning;
  }

  /** Closing a manual PiP returns its broadcast to the stage; automatic PiP only closes. */
  private dismiss(entry: Presentation): void {
    if (this.current !== entry) return;
    if (entry.automatic) this.close();
    else this.handBack(entry);
  }

  private handBack(entry: Presentation): void {
    if (this.current !== entry) return;
    entry.returning = true;
    entry.windowActive = true;
    appEvents.emit('screen_pip.stage_return');
    // Whatever the stage could not take back must not linger in the background.
    if (this.current === entry) this.close();
  }

  private createButton(doc: Document, action: string, label: string, icon: string): HTMLButtonElement {
    const button = doc.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    return button;
  }

  private returnToCall(entry: Presentation): void {
    if (this.current !== entry) return;
    entry.returning = true;
    entry.windowActive = true;
    void window.api.returnFromScreenPictureInPicture().catch(error => {
      console.warn('[ScreenPictureInPicture] Could not bring Monky forward:', error);
    });
    appEvents.emit('screen_pip.return_to_call', { sessionKey: entry.source.sessionKey, channelId: entry.source.channelId });
    // Whatever the stage could not take back must not linger in the background.
    if (this.current === entry) this.close();
  }

  private retire(entry: Presentation): void {
    entry.dispose.forEach(dispose => dispose());
    entry.dispose = [];
    const child = entry.window;
    const tookStage = !entry.automatic && !!child;
    const tileKey = tileKeyOf(entry);
    // Ended without being brought back (source switch, watch stopped, replaced):
    // the stage still owes this broadcast the focus the PiP took from it.
    const release: ScreenPictureInPictureRelease | undefined = tookStage && !entry.returning
      && entry.focusedTileKeys.includes(tileKey)
      ? { sessionKey: entry.source.sessionKey, channelId: entry.source.channelId, tileKey }
      : undefined;
    entry.window = null;
    if (entry.pipVideo) {
      // Revoked media is blanked synchronously, before the popup finishes closing.
      entry.pipVideo.pause();
      entry.pipVideo.srcObject = null;
      entry.pipVideo = null;
    }
    if (child && !child.closed) child.close();
    if (entry.host) {
      entry.video.pause();
      entry.video.srcObject = null;
      entry.host.remove();
    }
    if (this.current === entry) this.current = null;
    if (tookStage) appEvents.emit('screen_pip.updated', release);
  }
}

function tileKeyOf(entry: Presentation): string {
  return `${entry.source.publisherSessionId}:screen:${entry.source.shareId}`;
}

export const screenPictureInPicture = new ScreenPictureInPicture();
