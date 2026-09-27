import { participantManager } from '../core/ParticipantManager';
import { webRtcManager } from '../core/WebRtcManager';
import { serverStore } from '../stores/serverStore';
import { t } from '../i18n';
import { getAvatarUrl } from '../utils/avatar';
import { escapeHtml } from '../utils/html';

/** Refreshes only the audience badge, never the live video or its card. */
export class ScreenViewersView {
  private readonly events = new AbortController();
  private timer?: number;
  private hoverTimer?: number;
  private pinned = false;
  private failed = false;
  private signature = '';
  private readonly button: HTMLButtonElement;
  private readonly popup: HTMLDivElement;

  constructor(private readonly root: HTMLElement) {
    const id = `screen-viewers-${crypto.randomUUID()}`;
    root.innerHTML = `<button type="button" class="stage-viewers-button" aria-expanded="false"
      aria-controls="${id}" aria-haspopup="dialog"></button>
      <div id="${id}" class="stage-viewers-popup" popover="manual" role="dialog" tabindex="0"></div>`;
    this.button = root.querySelector('button')!;
    this.popup = root.querySelector('div')!;
    this.paint(null);
    const options = { signal: this.events.signal };
    const cancelHover = () => window.clearTimeout(this.hoverTimer);
    const closeSoon = () => {
      cancelHover();
      this.hoverTimer = window.setTimeout(() => { if (!this.pinned) this.close(); }, 160);
    };
    this.button.addEventListener('pointerenter', () => { cancelHover(); this.open(); }, options);
    this.button.addEventListener('pointerleave', closeSoon, options);
    this.popup.addEventListener('pointerenter', cancelHover, options);
    this.popup.addEventListener('pointerleave', closeSoon, options);
    this.button.addEventListener('click', event => {
      this.pinned = !this.pinned;
      if (this.pinned) {
        this.open();
        if (event.detail === 0) this.popup.focus();
      } else this.close();
    }, options);
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        this.close(); this.button.focus();
      } else if (event.key === 'ArrowDown' && event.target === this.button) {
        event.preventDefault(); this.pinned = true; this.open(); this.popup.focus();
      }
    }, options);
    for (const type of ['click', 'dblclick', 'pointerdown', 'wheel', 'contextmenu']) {
      root.addEventListener(type, event => event.stopPropagation(), options);
    }
    document.addEventListener('pointerdown', event => {
      if (event.target instanceof Node && !root.contains(event.target)) this.close();
    }, { ...options, capture: true });
    root.addEventListener('focusout', event => {
      if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) this.close();
    }, options);
    window.addEventListener('resize', () => this.position(), options);
    document.addEventListener('scroll', () => this.position(), { ...options, capture: true });
    void this.refresh();
  }

  private open(): void {
    if (!this.root.isConnected || this.events.signal.aborted) return;
    this.popup.showPopover();
    this.button.setAttribute('aria-expanded', 'true');
    this.position();
  }

  private close(): void {
    this.pinned = false;
    this.popup.hidePopover();
    this.button.setAttribute('aria-expanded', 'false');
  }

  private position(): void {
    if (!this.popup.matches(':popover-open')) return;
    const anchor = this.button.getBoundingClientRect();
    const bounds = this.popup.getBoundingClientRect();
    this.popup.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8))}px`;
    this.popup.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, innerHeight - bounds.height - 8))}px`;
  }

  private paint(ids: string[] | null, unavailable = false): void {
    const localId = serverStore.currentUser?.sessionId;
    const viewers = [...new Set(ids ?? [])].map(id => {
      const participant = participantManager.get(id);
      return { id, name: participant ? participantManager.displayName(participant) : t('stage.viewerUnknown'),
        avatar: getAvatarUrl(participant?.user.avatarUrl) };
    }).sort((a, b) => Number(b.id === localId) - Number(a.id === localId) || a.name.localeCompare(b.name));
    const self = viewers.some(viewer => viewer.id === localId);
    const summary = ids === null ? t(unavailable ? 'stage.viewersUnavailable' : 'stage.viewersLoading')
      : self ? viewers.length === 1 ? t('stage.viewersOnlyYou')
        : t(viewers.length === 2 ? 'stage.viewersYouAndOne' : 'stage.viewersYouAndMore', { count: viewers.length - 1 })
        : viewers.length === 0 ? t('stage.viewersEmpty')
          : t(viewers.length === 1 ? 'stage.viewersOne' : 'stage.viewersMany', { count: viewers.length });
    const compactSummary = viewers.length > 0 ? t('stage.viewersWatching') : summary;
    const signature = JSON.stringify([viewers, summary, compactSummary]);
    if (signature === this.signature) return;
    this.signature = signature;
    const avatar = (viewer: typeof viewers[number]) =>
      `<img src="${escapeHtml(viewer.avatar)}" alt="" data-fallback="avatar">`;
    this.button.setAttribute('aria-label', summary);
    this.button.innerHTML = `<span class="material-symbols-outlined md-16" aria-hidden="true">visibility</span>
      <span class="stage-viewers-avatars" aria-hidden="true">${viewers.slice(0, 2).map(avatar).join('')}</span>
      ${viewers.length > 2 ? `<span class="stage-viewers-more" aria-hidden="true">+${viewers.length - 2}</span>` : ''}
      <span class="stage-viewers-summary">${escapeHtml(compactSummary)}</span>`;
    this.popup.setAttribute('aria-label', summary);
    this.popup.innerHTML = `<strong>${escapeHtml(summary)}</strong>
      <ul>${viewers.map(viewer => `<li>${avatar(viewer)}
        <span>${escapeHtml(viewer.name)}${viewer.id === localId ? ` (${escapeHtml(t('common.you'))})` : ''}</span></li>`).join('')}</ul>`;
    this.position();
  }

  private async refresh(): Promise<void> {
    try {
      const ids = await webRtcManager.getScreenViewers(this.root.dataset.publisher!, this.root.dataset.share!);
      if (this.events.signal.aborted) return;
      this.failed = false;
      this.paint(ids);
    } catch (error) {
      if (this.events.signal.aborted) return;
      if (!this.failed && !(error instanceof DOMException && error.name === 'AbortError'))
        console.warn('[ScreenViewers] Could not refresh screen viewers:', error);
      this.failed = true;
      this.paint(null, true);
    } finally {
      if (!this.events.signal.aborted) this.timer = window.setTimeout(() => void this.refresh(), 2000);
    }
  }

  public destroy(): void {
    this.events.abort();
    window.clearTimeout(this.timer);
    window.clearTimeout(this.hoverTimer);
    this.close();
  }
}
