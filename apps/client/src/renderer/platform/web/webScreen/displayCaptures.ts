import { BROWSER_SCREEN_CAPTURE_PREFIX, type NativeScreenVideoProfile } from '@monky/shared';
import type { BrowserDisplayCapture } from '../../api';

/** Options of getDisplayMedia that the DOM typings of this TypeScript version do not list yet. */
interface ScreenCaptureOptions extends DisplayMediaStreamOptions {
  selfBrowserSurface?: 'include' | 'exclude';
  systemAudio?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
  monitorTypeSurfaces?: 'include' | 'exclude';
}

/** A browser capture the app holds while some share uses it. */
export interface DisplayCapture extends BrowserDisplayCapture {
  readonly video: MediaStreamTrack;
  readonly audioTrack: MediaStreamTrack | null;
  ended: boolean;
}

/**
 * The captures the browser's own dialog handed over (#858). The app cannot reopen a capture without a
 * click, so one outlives the screen call that first used it: the share releases it when it ends, the
 * browser's own "Stop sharing" ends it, and so does leaving the page.
 */
export class DisplayCaptures {
  private readonly captures = new Map<string, DisplayCapture>();
  private readonly endedListeners = new Set<(capture: DisplayCapture) => void>();
  private readonly releaseOnPageHide = (): void => this.releaseAll();
  private listening = false;

  public async capture(request: { audio: boolean; video: NativeScreenVideoProfile }): Promise<BrowserDisplayCapture | null> {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser cannot share its screen.');
    const options: ScreenCaptureOptions = {
      video: {
        width: { max: request.video.width }, height: { max: request.video.height },
        frameRate: { ideal: request.video.fps, max: request.video.fps },
      },
      audio: request.audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      // The app's own tab would show the call inside itself, and its sound would echo it.
      selfBrowserSurface: 'exclude',
      systemAudio: request.audio ? 'include' : 'exclude',
      surfaceSwitching: 'exclude',
      monitorTypeSurfaces: 'include',
    };
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getDisplayMedia(options); }
    catch (error) {
      if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) return null;
      throw error;
    }
    const [video] = stream.getVideoTracks();
    if (!video) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('The browser shared no picture.');
    }
    video.contentHint = 'detail';
    const audioTrack = request.audio ? stream.getAudioTracks()[0] ?? null : null;
    for (const track of stream.getAudioTracks()) if (track !== audioTrack) track.stop();
    const surface = video.getSettings().displaySurface;
    const capture: DisplayCapture = {
      sourceId: `${BROWSER_SCREEN_CAPTURE_PREFIX}${crypto.randomUUID()}`,
      label: video.label, captureKind: surface === 'monitor' ? 'monitor' : 'window', audio: audioTrack !== null,
      video, audioTrack, ended: false,
    };
    video.addEventListener('ended', () => this.end(capture), { once: true });
    this.captures.set(capture.sourceId, capture);
    if (!this.listening) {
      this.listening = true;
      window.addEventListener('pagehide', this.releaseOnPageHide);
    }
    return { sourceId: capture.sourceId, label: capture.label, captureKind: capture.captureKind, audio: capture.audio };
  }

  public get(sourceId: string): DisplayCapture | undefined {
    return this.captures.get(sourceId);
  }

  /** Called once for each capture the browser ended on its own (its "Stop sharing" bar, a closed tab). */
  public onEnded(listener: (capture: DisplayCapture) => void): () => void {
    this.endedListeners.add(listener);
    return () => { this.endedListeners.delete(listener); };
  }

  private end(capture: DisplayCapture): void {
    if (capture.ended) return;
    this.release(capture.sourceId);
    for (const listener of [...this.endedListeners]) {
      try { listener(capture); }
      catch (error) { console.error('[WebScreen] Capture end observer failed:', error); }
    }
  }

  public release(sourceId: string): void {
    const capture = this.captures.get(sourceId);
    if (!capture) return;
    capture.ended = true;
    this.captures.delete(sourceId);
    capture.video.stop();
    capture.audioTrack?.stop();
    if (!this.captures.size && this.listening) {
      this.listening = false;
      window.removeEventListener('pagehide', this.releaseOnPageHide);
    }
  }

  public releaseAll(): void {
    for (const sourceId of [...this.captures.keys()]) this.release(sourceId);
  }
}
