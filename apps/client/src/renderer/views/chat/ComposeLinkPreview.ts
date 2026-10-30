import { linkPreviewService } from '../../core/LinkPreviewService';
import { t } from '../../i18n';
import { escapeHtml } from '../../utils/html';
import { setSurfaceVisible } from '../../utils/surfaceVisibility';
import type { MarkdownInput } from '../MarkdownInput';
import { renderComposeServerInvite, serverInviteFromLink } from '../ServerInviteCard';

/**
 * The card previewing the first link of a message while it is written: the
 * server an invitation leads to, or the page a link points at.
 */
export class ComposeLinkPreview {
  /** The link on display; `__dismissed__` once the reader closed its card. */
  private url = '';
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private pasteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly element: HTMLElement | null,
    private readonly input: MarkdownInput | null,
    /** A command form in place of the text box hides the preview. */
    private readonly commandSelected: () => boolean,
  ) {}

  /** Typing waits for a pause before looking the link up; a paste shows it almost at once. */
  public schedule(after: 'typing' | 'paste'): void {
    if (after === 'typing') {
      if (this.typingTimer) clearTimeout(this.typingTimer);
      this.typingTimer = setTimeout(() => this.update(), 500);
    } else {
      if (this.pasteTimer) clearTimeout(this.pasteTimer);
      this.pasteTimer = setTimeout(() => this.update(), 100);
    }
  }

  public update(): void {
    const { input, element } = this;
    if (!input || !element || !input.isConnected) return;
    if (this.commandSelected()) {
      setSurfaceVisible(element, false);
      return;
    }
    const urlMatch = input.value.match(/(https?:\/\/[^\s<]+)/);
    const url = urlMatch ? urlMatch[1] : '';
    if (url === this.url) return;
    this.url = url;
    if (!url) {
      setSurfaceVisible(element, false, 'panel', undefined, () => element.replaceChildren());
      return;
    }
    const bindDismiss = () => {
      element.querySelector('.compose-link-preview-dismiss')?.addEventListener('click', (event) => {
        event.stopPropagation();
        setSurfaceVisible(element, false, 'panel', undefined, () => element.replaceChildren());
        this.url = '__dismissed__';
      });
    };
    // The docs page could only describe a generic invitation; the link itself names the server.
    const invite = serverInviteFromLink(url);
    if (invite) {
      element.innerHTML = `
        <div class="compose-link-preview-card compose-link-preview-card--invite">
          ${renderComposeServerInvite(invite)}
          <button type="button" class="compose-link-preview-dismiss" title="${t('common.close')}" aria-label="${t('common.close')}">
            <span class="material-symbols-outlined md-16">close</span>
          </button>
        </div>
      `;
      setSurfaceVisible(element, true, 'panel', 'block');
      bindDismiss();
      return;
    }
    linkPreviewService.fetch(url).then((data) => {
      if (!data || this.url !== url) return;
      const imgHtml = data.image ? `<img class="compose-link-preview-img" src="${escapeHtml(data.image)}" alt="">` : '';
      element.innerHTML = `
        <div class="compose-link-preview-card" data-external-link="${escapeHtml(url)}" role="button" tabindex="0">
          <div class="compose-link-preview-text">
            <div class="compose-link-preview-site">${escapeHtml(data.siteName || new URL(url).hostname)}</div>
            <div class="compose-link-preview-title">${escapeHtml(data.title || url)}</div>
            ${data.description ? `<div class="compose-link-preview-desc">${escapeHtml(data.description)}</div>` : ''}
          </div>
          ${imgHtml}
          <button type="button" class="compose-link-preview-dismiss" title="${t('common.close')}">
            <span class="material-symbols-outlined md-16">close</span>
          </button>
        </div>
      `;
      const openPreviewLink = () => {
        if (window.api?.openExternal) {
          window.api.openExternal(url);
        }
      };
      setSurfaceVisible(element, true, 'panel', 'block');
      const card = element.querySelector<HTMLElement>('.compose-link-preview-card');
      card?.addEventListener('click', openPreviewLink);
      card?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPreviewLink();
        }
      });
      bindDismiss();
    }).catch(() => { /* silent */ });
  }

  /** Puts the card away and forgets its link, so the next update starts over (a message sent, an edit begun or ended). */
  public reset(): void {
    const { element } = this;
    if (!element) return;
    setSurfaceVisible(element, false, 'panel', undefined, () => element.replaceChildren());
    this.url = '';
  }

  /** Hides the card without forgetting its link, while a command form takes the text box's place. */
  public hide(): void {
    if (this.element) setSurfaceVisible(this.element, false);
  }

  public destroy(): void {
    if (this.typingTimer) clearTimeout(this.typingTimer);
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
  }
}
