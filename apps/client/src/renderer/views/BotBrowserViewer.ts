import type { BotScreen, BotScreenBeforeCloseReason, BotScreenCloseReason } from '@monky/shared';
import { webRtcManager } from '../core/WebRtcManager';
import type { BrowserMiniappMediaHandle } from '../core/webrtc/BrowserMiniappMedia';
import { t, type SupportedLanguage } from '../i18n';

/** A participant sees only received pixels, with no URL bar or control of the host's site. */
export class BotBrowserViewer {
  readonly element = document.createElement('video');
  readonly asksBeforeClose = false;
  private readonly lifecycle = new AbortController();
  private media: BrowserMiniappMediaHandle | null = null;

  constructor(screen: Extract<BotScreen, { kind: 'browser' }>, onError: (error: unknown) => void, onClosed: () => void) {
    this.element.className = 'miniapp-browser-viewer';
    this.element.autoplay = true;
    this.element.muted = true;
    this.element.playsInline = true;
    this.element.setAttribute('aria-label', t('browser.viewer'));
    this.element.addEventListener('playing', () => webRtcManager.browserMiniappMedia.playing(screen), { signal: this.lifecycle.signal });
    void webRtcManager.browserMiniappMedia.watch(screen, stream => {
      if (this.lifecycle.signal.aborted) { stream.getTracks().forEach(track => track.stop()); return; }
      this.element.srcObject = stream;
      void this.element.play().catch(error => { if (!this.lifecycle.signal.aborted) onError(error); });
    }, onError, this.lifecycle.signal, onClosed).then(media => {
      if (this.lifecycle.signal.aborted) media.close();
      else this.media = media;
    }).catch(error => { if (!this.lifecycle.signal.aborted) onError(error); });
  }

  setLocale(_locale: SupportedLanguage): void { this.element.setAttribute('aria-label', t('browser.viewer')); }
  setVisible(_visible: boolean): void {}
  setVolume(_volume: number): void {}
  update(_screen: BotScreen): void {}
  requestBeforeClose(_reason: BotScreenBeforeCloseReason): Promise<boolean> { return Promise.resolve(!this.lifecycle.signal.aborted); }
  forceClose(): void { this.retire('leave'); }
  retire(_reason: BotScreenCloseReason): void {
    this.lifecycle.abort();
    this.media?.close();
    this.media = null;
    this.element.pause();
    this.element.srcObject = null;
    this.element.remove();
  }
}
