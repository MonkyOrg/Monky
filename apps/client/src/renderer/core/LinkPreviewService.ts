import { escapeHtml } from '../utils/html';
import { LruCache, parseServerInviteLink } from '@monky/shared';

export interface LinkPreviewData {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
  embedType?: 'youtube' | 'spotify';
  embedUrl?: string;
}

export class LinkPreviewService {
  private cache = new LruCache<string, LinkPreviewData | null>(200, 1000 * 60 * 60);
  private pendingRequests = new Map<string, Promise<LinkPreviewData | null>>();

  public normalizeUrl(url: string | null | undefined): string | null {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return null;
    }
  }

  public getHostname(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
      return url;
    }
  }

  public async fetch(url: string): Promise<LinkPreviewData | null> {
    if (this.cache.has(url)) {
      return this.cache.get(url) ?? null;
    }

    const pending = this.pendingRequests.get(url);
    if (pending) {
      return pending;
    }

    if (!window.api?.fetchLinkPreview) return null;

    const request = window.api
      .fetchLinkPreview(url)
      .catch(() => null)
      .then((preview: LinkPreviewData | null) => {
        this.cache.set(url, preview);
        const normalizedPreviewUrl = this.normalizeUrl(preview?.url);
        if (normalizedPreviewUrl && normalizedPreviewUrl !== url) {
          this.cache.set(normalizedPreviewUrl, preview);
        }
        this.pendingRequests.delete(url);
        return preview;
      });

    this.pendingRequests.set(url, request);
    return request;
  }

  public renderSkeleton(): string {
    return `
      <div class="chat-link-preview chat-link-preview--loading" aria-hidden="true">
        <div class="chat-link-preview-main">
          <div class="chat-link-preview-site">
            <span class="chat-link-preview-site-icon chat-link-preview-skeleton-block"></span>
            <span class="chat-link-preview-skeleton-line chat-link-preview-skeleton-line--site"></span>
          </div>
          <span class="chat-link-preview-skeleton-line chat-link-preview-skeleton-line--title"></span>
          <span class="chat-link-preview-skeleton-line chat-link-preview-skeleton-line--text"></span>
          <span class="chat-link-preview-skeleton-line chat-link-preview-skeleton-line--text chat-link-preview-skeleton-line--short"></span>
        </div>
        <div class="chat-link-preview-media chat-link-preview-skeleton-block"></div>
      </div>
    `;
  }

  public renderCard(preview: LinkPreviewData): string {
    const normalizedUrl = this.normalizeUrl(preview.url) ?? preview.url;
    const hostname = this.getHostname(normalizedUrl);
    const siteLabel = escapeHtml((preview.siteName || hostname || normalizedUrl).trim());
    const title = escapeHtml((preview.title || preview.siteName || hostname || normalizedUrl).trim());
    const description = preview.description ? escapeHtml(preview.description.trim()) : '';
    const isEmbed = Boolean(preview.embedType && preview.embedUrl);
    const faviconHtml = preview.favicon
      ? `<img class="chat-link-preview-favicon" src="${escapeHtml(preview.favicon)}" alt="" loading="lazy">`
      : `<span class="material-symbols-outlined md-16">${isEmbed ? 'play_circle' : 'public'}</span>`;
    const thumbHtml = preview.image
      ? `
        <div class="chat-link-preview-media">
          <img class="chat-link-preview-thumb" src="${escapeHtml(preview.image)}" alt="" loading="lazy">
          ${isEmbed ? `
            <div class="chat-link-preview-play-overlay">
              <span class="material-symbols-outlined">play_circle</span>
            </div>
          ` : ''}
        </div>
      `
      : '';

    return `
      <button
        type="button"
        class="chat-link-preview${preview.image ? '' : ' chat-link-preview--no-image'}${isEmbed ? ' chat-link-preview--embed' : ''}"
        title="${escapeHtml(normalizedUrl)}"
        data-preview-url="${escapeHtml(normalizedUrl)}"
        ${isEmbed ? `data-embed-url="${escapeHtml(preview.embedUrl || '')}" data-embed-type="${escapeHtml(preview.embedType || '')}"` : ''}
      >
        <div class="chat-link-preview-main">
          <div class="chat-link-preview-site">
            <span class="chat-link-preview-site-icon${preview.favicon ? '' : ' chat-link-preview-site-icon--fallback'}">
              ${faviconHtml}
            </span>
            <span class="chat-link-preview-site-label">${siteLabel}</span>
          </div>
          <span class="chat-link-preview-title">${title}</span>
          ${description ? `<span class="chat-link-preview-description">${description}</span>` : ''}
        </div>
        ${thumbHtml}
      </button>
    `;
  }

  public initializePreviews(feed: HTMLElement): void {
    if (!window.api?.fetchLinkPreview) return;

    feed.querySelectorAll<HTMLElement>('.chat-link-previews').forEach((container) => {
      const row = container.closest('.chat-message-row') as HTMLElement | null;
      if (!row) {
        container.remove();
        return;
      }

      const urls = this.collectPreviewUrls(row);
      if (urls.length === 0) {
        container.remove();
        return;
      }

      container.innerHTML = '';
      for (const url of urls) {
        const slot = document.createElement('div');
        slot.className = 'chat-link-preview-slot';
        slot.innerHTML = this.renderSkeleton();
        container.appendChild(slot);
        void this.populatePreview(url, slot);
      }
    });
  }

  private collectPreviewUrls(row: HTMLElement): string[] {
    const attachmentUrls = new Set<string>();
    row.querySelectorAll<HTMLElement>('[data-download-url], [data-lightbox-url]').forEach((element) => {
      const rawUrl = element.getAttribute('data-download-url') || element.getAttribute('data-lightbox-url');
      const normalized = this.normalizeUrl(rawUrl);
      if (normalized) {
        attachmentUrls.add(normalized);
      }
    });

    const seen = new Set<string>();
    const urls: string[] = [];
    row.querySelectorAll<HTMLAnchorElement>('.chat-message-text .md-link[data-external-link]').forEach((link) => {
      const rawUrl = link.getAttribute('data-external-link');
      // Invitations get their own card; the docs page behind them is the same for every server.
      if (parseServerInviteLink(rawUrl).ok) return;
      const normalized = this.normalizeUrl(rawUrl);
      if (!normalized || seen.has(normalized) || attachmentUrls.has(normalized)) {
        return;
      }

      seen.add(normalized);
      urls.push(normalized);
    });

    return urls;
  }

  private async populatePreview(url: string, slot: HTMLElement): Promise<void> {
    const preview = await this.fetch(url);
    if (!slot.isConnected) return;

    const parent = slot.parentElement;
    if (!preview) {
      slot.remove();
      if (parent && parent.childElementCount === 0) {
        parent.remove();
      }
      return;
    }

    slot.innerHTML = this.renderCard(preview);

    const card = slot.querySelector<HTMLElement>('.chat-link-preview');
    card?.addEventListener('click', (event) => {
      const embedUrl = card.getAttribute('data-embed-url');
      const embedType = card.getAttribute('data-embed-type');

      if (embedUrl && embedType) {
        event.preventDefault();
        event.stopPropagation();

        const iframe = document.createElement('iframe');
        iframe.src = embedUrl;
        iframe.className = 'chat-embed-iframe';
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
        iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
        iframe.setAttribute('allowfullscreen', '');

        if (embedType === 'spotify') {
          iframe.style.height = '152px';
        } else {
          iframe.style.aspectRatio = '16/9';
        }

        const container = document.createElement('div');
        container.className = 'chat-embed-container';
        container.appendChild(iframe);
        card.replaceWith(container);
        return;
      }

      const externalUrl = card.getAttribute('data-preview-url') || card.getAttribute('title') || preview.url;
      void window.api.openExternal(externalUrl);
    });

    const favicon = slot.querySelector<HTMLImageElement>('.chat-link-preview-favicon');
    favicon?.addEventListener('error', () => {
      const iconWrap = favicon.parentElement;
      if (!iconWrap) return;
      iconWrap.classList.add('chat-link-preview-site-icon--fallback');
      iconWrap.innerHTML = '<span class="material-symbols-outlined md-16">public</span>';
    });

    const thumb = slot.querySelector<HTMLImageElement>('.chat-link-preview-thumb');
    thumb?.addEventListener('error', () => {
      thumb.closest('.chat-link-preview-media')?.remove();
      card?.classList.add('chat-link-preview--no-image');
    });
  }
}

export const linkPreviewService = new LinkPreviewService();
