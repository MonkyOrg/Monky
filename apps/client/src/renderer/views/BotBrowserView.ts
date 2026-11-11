import { MINIAPP_BROWSER_COLOR_KEYS, type BotScreen, type BotScreenBeforeCloseReason, type BotScreenCloseReason,
  type MiniappBrowserAppearance, type MiniappBrowserBounds, type MiniappBrowserOpen, type MiniappBrowserOwnerCommand } from '@monky/shared';
import { t, type SupportedLanguage } from '../i18n';
import '../styles/miniappBrowser.css';

/** A stage invitation owns the native view; all browsing data stays in the native session. */
export class BotBrowserView {
  readonly element = document.createElement('div');
  readonly asksBeforeClose = false;
  private retired = false;
  private visible: boolean;
  private stopClosed: () => void;
  private lifecycle = new AbortController();
  private resize = new ResizeObserver(() => this.syncPlacement());
  private mutations = new MutationObserver(() => { this.syncPlacement(); this.syncAppearance(); });
  private animationFrame: number | null = null;
  private lastPlacement = '';
  private lastAppearance = '';
  readonly ready: Promise<void>;
  get signal(): AbortSignal { return this.lifecycle.signal; }

  constructor(input: MiniappBrowserOpen, onClosed: () => void, private onError: (error: unknown) => void, visible: boolean) {
    this.input = input;
    this.visible = visible;
    this.element.className = 'miniapp-browser-tile';
    this.element.textContent = t('browser.opened');
    this.stopClosed = window.api.onMiniappBrowserClosed(requestId => {
      if (requestId !== this.input.requestId || this.retired) return;
      this.dispose();
      onClosed();
    });
    document.addEventListener('visibilitychange', () => this.setVisible(this.visible), { signal: this.lifecycle.signal });
    window.addEventListener('resize', () => this.syncPlacement(), { signal: this.lifecycle.signal });
    document.addEventListener('scroll', () => this.syncPlacement(), { signal: this.lifecycle.signal, capture: true });
    document.addEventListener('fullscreenchange', () => this.syncPlacement(), { signal: this.lifecycle.signal });
    this.resize.observe(this.element);
    this.mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'open', 'inert', 'aria-hidden', 'data-ui-closing'] });
    this.ready = window.api.openMiniappBrowser(input).then(() => {
      if (!this.retired) { this.lastPlacement = ''; this.lastAppearance = ''; this.setVisible(this.visible); this.syncAppearance(); }
      else throw new DOMException('Browser retired during opening.', 'AbortError');
    });
    void this.ready.catch(error => { if (!this.retired) { this.retire('revoked'); onError(error); } });
    this.setVisible(visible);
  }

  private input: MiniappBrowserOpen;

  async capture(): Promise<MediaStream> {
    await this.ready;
    if (this.retired) throw new DOMException('Browser capture was cancelled.', 'AbortError');
    const sourceId = await window.api.captureMiniappBrowser(this.input.requestId);
    if (this.retired) throw new DOMException('Browser capture was cancelled.', 'AbortError');
    interface TabConstraints extends MediaTrackConstraints {
      mandatory: { chromeMediaSource: 'tab'; chromeMediaSourceId: string; maxFrameRate: number };
    }
    const video: TabConstraints = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: sourceId, maxFrameRate: 30 } };
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    if (this.retired) {
      stream.getTracks().forEach(track => track.stop());
      throw new DOMException('Browser retired during capture.', 'AbortError');
    }
    return stream;
  }

  broadcasting(): void {
    if (!this.retired) this.command({ requestId: this.input.requestId, action: 'broadcasting', active: true });
  }

  private syncAppearance(): void {
    if (this.retired || !this.element.isConnected) return;
    const style = getComputedStyle(this.element);
    const colors: MiniappBrowserAppearance['colors'] = {};
    for (const key of MINIAPP_BROWSER_COLOR_KEYS) {
      const color = style.getPropertyValue(key).trim();
      if (color) colors[key] = color;
    }
    const appearance = { fontFamily: style.fontFamily, colors };
    const signature = JSON.stringify(appearance);
    if (signature === this.lastAppearance) return;
    this.lastAppearance = signature;
    this.command({ requestId: this.input.requestId, action: 'appearance', appearance });
  }

  private syncPlacement(): void {
    if (this.retired) return;
    const rect = this.element.getBoundingClientRect();
    const bounds: MiniappBrowserBounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
    let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
    let visible = this.visible && document.visibilityState === 'visible' && this.element.isConnected
      && this.element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    for (let parent = this.element.parentElement; parent; parent = parent.parentElement) {
      if (parent.inert || parent.hasAttribute('data-ui-closing')) visible = false;
      const style = getComputedStyle(parent);
      if (Number.parseFloat(style.opacity) < 1) visible = false;
      if (style.overflowX === 'visible' && style.overflowY === 'visible') {
        if (parent === document.fullscreenElement) break;
        continue;
      }
      const box = parent.getBoundingClientRect();
      const scaleX = parent.offsetWidth ? box.width / parent.offsetWidth : 1;
      const scaleY = parent.offsetHeight ? box.height / parent.offsetHeight : 1;
      if (style.overflowX !== 'visible') {
        const x = box.left + parent.clientLeft * scaleX;
        left = Math.max(left, x); right = Math.min(right, x + parent.clientWidth * scaleX);
      }
      if (style.overflowY !== 'visible') {
        const y = box.top + parent.clientTop * scaleY;
        top = Math.max(top, y); bottom = Math.min(bottom, y + parent.clientHeight * scaleY);
      }
      if (parent === document.fullscreenElement) break;
    }
    const clip = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    visible = visible && clip.width > 0 && clip.height > 0;
    // Native child views cannot be covered by DOM layers: yield to Monky's dialogs and popups.
    if (visible) for (const layer of document.querySelectorAll<HTMLElement>(
      '[popover]:popover-open, .modal-backdrop, [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [role="alert"], .chat-copy-toast, .stage-volume-popup',
    )) {
      if (layer.contains(this.element) || this.element.contains(layer)
        || !layer.checkVisibility({ checkOpacity: !layer.matches('.modal-backdrop,[data-ui-closing]'), checkVisibilityCSS: true })) continue;
      const box = layer.getBoundingClientRect();
      if (box.width > 0 && box.height > 0 && box.left < right && box.right > left && box.top < bottom && box.bottom > top) {
        visible = false;
        break;
      }
    }
    const placement = { requestId: this.input.requestId, action: 'placement' as const, bounds, clip, visible };
    const signature = JSON.stringify(placement);
    if (signature !== this.lastPlacement) { this.lastPlacement = signature; this.command(placement); }
    if (this.visible && document.visibilityState === 'visible' && this.animationFrame === null) {
      this.animationFrame = requestAnimationFrame(() => { this.animationFrame = null; this.syncPlacement(); });
    }
  }

  private command(command: MiniappBrowserOwnerCommand): void {
    void window.api.miniappBrowserCommand(command).catch(error => {
      console.error('[Miniapp browser] Lifecycle command failed.', error);
      if (!this.retired) { this.retire('revoked'); this.onError(error); }
    });
  }

  setLocale(locale: SupportedLanguage): void {
    this.element.textContent = t('browser.opened');
    if (!this.retired) this.command({ requestId: this.input.requestId, action: 'locale', locale });
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!this.retired) this.command({
      requestId: this.input.requestId, action: 'visibility', visible: visible && document.visibilityState === 'visible',
    });
    this.syncPlacement();
  }
  setVolume(volume: number): void {
    if (!this.retired) this.command({ requestId: this.input.requestId, action: 'volume', volume });
  }
  update(_screen: BotScreen): void {}
  requestBeforeClose(_reason: BotScreenBeforeCloseReason): Promise<boolean> { return Promise.resolve(!this.retired); }
  forceClose(): void { this.retire('leave'); }
  retire(_reason: BotScreenCloseReason): void {
    if (this.retired) return;
    this.dispose();
    this.command({ requestId: this.input.requestId, action: 'close' });
  }
  private dispose(): void {
    this.retired = true;
    this.lifecycle.abort();
    this.resize.disconnect();
    this.mutations.disconnect();
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.stopClosed();
    this.element.remove();
  }
}
