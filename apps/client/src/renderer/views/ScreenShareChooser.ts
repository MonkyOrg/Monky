import type { NativeScreenCaptureKind } from '@monky/shared';
import { appEvents } from '../core/EventBus';
import { screenAudioService } from '../core/ScreenAudioService';
import { stopLocalScreenShares } from '../core/screenShareControls';
import { videoService } from '../core/VideoService';
import { t } from '../i18n';
import { voiceStore } from '../stores/voiceStore';
import { animateEnter, ownSurface, positionAnchoredSurface, removeWithMotion } from '../utils/surfaceMotion';

export type ScreenSharePurpose = 'stop' | 'switch';
export type ScreenShareSelection = { readonly all: true } | { readonly shareId: string };

const KIND_ICONS: Readonly<Record<NativeScreenCaptureKind, string>> = {
  monitor: 'desktop_windows', window: 'web_asset', game: 'sports_esports',
};
const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

/**
 * Dropdown that asks which local screen share a control acts on, showing a
 * live preview of each one. With several shares, "stop" or "switch source"
 * is ambiguous: acting on all of them at once used to stop both screens when
 * the user only meant one.
 */
class ScreenShareChooser {
  private surface: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private resolve: ((selection: ScreenShareSelection | null) => void) | null = null;
  private readonly teardown: Array<() => void> = [];

  public isOpenFor(anchor: HTMLElement): boolean {
    return this.surface !== null && this.anchor === anchor;
  }

  /** Whether the open dropdown was opened from inside `root`, e.g. a modal that is closing. */
  public isOpenWithin(root: HTMLElement): boolean {
    return this.surface !== null && this.anchor !== null && root.contains(this.anchor);
  }

  /** Resolves with the picked share, every share (stop only) or null when dismissed. */
  public choose(anchor: HTMLElement, purpose: ScreenSharePurpose): Promise<ScreenShareSelection | null> {
    this.close();
    const shareIds = listedScreenShares();
    if (shareIds.length === 0) return Promise.resolve(null);
    const result = new Promise<ScreenShareSelection | null>(resolve => { this.resolve = resolve; });
    const surface = this.render(shareIds, purpose);
    document.body.appendChild(surface);
    this.surface = surface;
    this.anchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    positionAnchoredSurface(surface, anchor, {
      matchWidth: false, maxHeight: 440, minimumHeight: surface.scrollHeight,
    });
    this.teardown.push(ownSurface(surface, anchor));
    animateEnter(surface, 'popover');
    this.bindDismiss(surface, anchor, shareIds);
    surface.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    return result;
  }

  public close(): void {
    this.finish(null, false);
  }

  private finish(selection: ScreenShareSelection | null, restoreFocus: boolean): void {
    const { surface, anchor, resolve } = this;
    this.surface = null;
    this.anchor = null;
    this.resolve = null;
    for (const off of this.teardown.splice(0)) off();
    if (surface) {
      // The previews let go of the shares' streams right away; only the box animates out.
      for (const video of surface.querySelectorAll('video')) {
        video.pause();
        video.srcObject = null;
      }
      removeWithMotion(surface, 'popover');
    }
    anchor?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
    resolve?.(selection);
  }

  private render(shareIds: readonly string[], purpose: ScreenSharePurpose): HTMLElement {
    const surface = document.createElement('div');
    surface.className = 'screen-share-chooser';
    surface.dataset.purpose = purpose;
    surface.setAttribute('role', 'menu');
    const title = t(purpose === 'stop' ? 'screenShare.chooseStopTitle' : 'screenShare.chooseSwitchTitle');
    surface.setAttribute('aria-label', title);
    const heading = document.createElement('div');
    heading.className = 'screen-share-chooser-title';
    heading.setAttribute('aria-hidden', 'true');
    heading.textContent = title;
    surface.append(heading, ...shareIds.map((shareId, index) => this.renderShare(shareId, index, purpose)));
    if (purpose === 'stop') {
      const separator = document.createElement('div');
      separator.className = 'screen-share-chooser-separator';
      separator.setAttribute('role', 'separator');
      const all = this.menuItem('screen-share-choice screen-share-choice--all');
      all.append(icon('stop_screen_share', 'md-18'), text('span', '', t('screenShare.stopAllScreens')));
      all.addEventListener('click', event => this.finish({ all: true }, event.detail === 0));
      surface.append(separator, all);
    }
    return surface;
  }

  private renderShare(shareId: string, index: number, purpose: ScreenSharePurpose): HTMLButtonElement {
    const name = videoService.getScreenShareLabel(shareId) ?? t('screenShare.screenNumber', { number: index + 1 });
    const withAudio = voiceStore.screenAudioShareIds.includes(shareId);
    const button = this.menuItem('screen-share-choice');
    button.dataset.shareId = shareId;
    const action = t(purpose === 'stop' ? 'screenShare.chooseStopItem' : 'screenShare.chooseSwitchItem', { name });
    button.setAttribute('aria-label', `${action}, ${t(withAudio ? 'screenShare.withAudio' : 'screenShare.withoutAudio')}`);
    const details = text('span', 'screen-share-choice-text', '');
    const label = text('span', 'screen-share-choice-name', name);
    label.title = name;
    const meta = text('span', 'screen-share-choice-meta', '');
    if (withAudio) meta.dataset.audio = '';
    meta.append(icon(withAudio ? 'volume_up' : 'volume_off', 'md-14'),
      text('span', '', t(withAudio ? 'screenShare.withAudio' : 'screenShare.withoutAudio')));
    details.append(label, meta);
    button.append(this.renderPreview(shareId), details,
      icon(purpose === 'stop' ? 'stop_circle' : 'swap_horiz', 'md-20 screen-share-choice-action'));
    button.addEventListener('click', event => this.finish({ shareId }, event.detail === 0));
    return button;
  }

  private renderPreview(shareId: string): HTMLElement {
    const frame = text('span', 'screen-share-choice-preview', '');
    const stream = videoService.getScreenStream(shareId);
    if (stream?.getVideoTracks().some(track => track.readyState === 'live')) {
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('aria-hidden', 'true');
      video.srcObject = stream;
      frame.append(video);
      void video.play().catch(() => {});
    } else {
      frame.dataset.unavailable = '';
      frame.title = t('screenShare.previewUnavailable');
      frame.append(icon(KIND_ICONS[this.kindOf(shareId)], 'md-24'));
    }
    return frame;
  }

  private kindOf(shareId: string): NativeScreenCaptureKind {
    const native = videoService.getNativeScreenCapture(shareId);
    if (native?.captureKind) return native.captureKind;
    const sourceId = native?.desktopSourceId ?? videoService.getScreenSourceId(shareId);
    return sourceId?.startsWith('window:') ? 'window' : 'monitor';
  }

  private menuItem(className: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.tabIndex = -1;
    button.setAttribute('role', 'menuitem');
    return button;
  }

  private bindDismiss(surface: HTMLElement, anchor: HTMLElement, shareIds: readonly string[]): void {
    const dismiss = () => this.finish(null, false);
    const outside = (event: Event) => {
      // The trigger toggles the dropdown itself, so pressing it must not reopen it.
      if (event.target instanceof Node && !surface.contains(event.target) && !anchor.contains(event.target)) dismiss();
    };
    const scrolled = (event: Event) => {
      if (!(event.target instanceof Node && surface.contains(event.target))) dismiss();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.finish(null, true);
        return;
      }
      if (event.key === 'Tab') {
        dismiss();
        return;
      }
      if (!NAVIGATION_KEYS.has(event.key)) return;
      event.preventDefault();
      const items = [...surface.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const current = items.findIndex(item => item === document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
    };
    const sharesChanged = (shareId: unknown) => {
      if (typeof shareId !== 'string' || shareIds.includes(shareId)) dismiss();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scrolled, true);
    this.teardown.push(
      () => {
        document.removeEventListener('pointerdown', outside, true);
        window.removeEventListener('keydown', keydown, true);
        window.removeEventListener('resize', dismiss);
        window.removeEventListener('scroll', scrolled, true);
      },
      // A list that no longer matches the live shares would act on the wrong one.
      appEvents.on('local.screen_stopped', sharesChanged),
      appEvents.on('local.screen_started', dismiss),
      appEvents.on('voice.channel_changed', dismiss),
    );
  }
}

function icon(name: string, size: string): HTMLElement {
  const element = text('span', `material-symbols-outlined ${size}`, name);
  element.setAttribute('aria-hidden', 'true');
  return element;
}

function text(tag: 'span' | 'div', className: string, content: string): HTMLElement {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = content;
  return element;
}

export const screenShareChooser = new ScreenShareChooser();

/** Local shares that can be told apart: ids whose capture stream is still live. */
export function listedScreenShares(): string[] {
  return voiceStore.screenShareIds.filter(shareId => videoService.getScreenStream(shareId) !== null);
}

/**
 * Which shares a stop control ends. A single share stops right away, as
 * before; with several, the user picks one (or all) from the dropdown. A stop
 * control must never be a no-op, so anything short of two listable shares
 * stops everything.
 */
export function chooseSharesToStop(anchor: HTMLElement): Promise<ScreenShareSelection | null> {
  if (listedScreenShares().length < 2) return Promise.resolve({ all: true });
  return screenShareChooser.choose(anchor, 'stop');
}

export function stopChosenShares(selection: ScreenShareSelection): Promise<void> {
  return stopLocalScreenShares(screenAudioService, 'shareId' in selection ? { shareIds: [selection.shareId] } : {});
}
