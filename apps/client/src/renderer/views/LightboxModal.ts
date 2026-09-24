import { t } from '../i18n';
import { initializeCustomVideoPlayers } from '../utils/videoPlayer';
import { showAlert } from './Dialog';
import { playChatMedia } from '../core/ChatMediaOutput';
import { ImageClipboard } from '../utils/imageClipboard';

/**
 * Handler de download que o lightbox espera. Fica aqui porque todo mundo que
 * abre o visualizador precisa exatamente disto — o chat e o menu de contexto
 * mantinham a mesma dezena de linhas duplicada, cada uma com sua cópia do
 * aviso de falha (#406).
 */
export async function downloadLightboxFile(url: string, fileName: string): Promise<void> {
  if (!window.api?.downloadFile) return;
  const result = await window.api.downloadFile(url, fileName);
  if (!result.success && result.error) {
    await showAlert({
      title: t('chat.downloadFailedTitle'),
      message: t('chat.downloadFailedMessage', { error: result.error }),
      variant: 'danger',
    });
  }
}

export interface LightboxMedia {
  kind: 'image' | 'video';
  url: string;
  fileName: string;
  senderName: string;
  timestamp: string;
  source: HTMLElement;
}

export class LightboxModal {
  private closeCurrent: (() => void) | null = null;

  public open(
    items: LightboxMedia[],
    startIndex: number,
    onDownload: (url: string, fileName: string) => Promise<void>
  ): () => void {
    if (items.length === 0) return () => {};
    this.close();

    let currentIndex = Math.max(0, Math.min(startIndex, items.length - 1));
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let dragging = false;
    let pointerId: number | null = null;
    let dragStartX = 0;
    let dragStartY = 0;
    let startPanX = 0;
    let startPanY = 0;
    let currentImage: HTMLImageElement | null = null;
    let fittedWidth = 0;
    let fittedHeight = 0;
    let currentLightboxVideo: HTMLVideoElement | null = null;
    let currentInlineVideo: HTMLVideoElement | null = null;
    let resumeInlineVideoOnClose = false;
    const imageClipboard = new ImageClipboard();

    const overlay = document.createElement('div');
    overlay.className = 'attachment-lightbox';
    overlay.innerHTML = `
      <div class="lightbox-toolbar">
        <div class="lightbox-meta">
          <div class="lightbox-counter-row">
            <span class="lightbox-counter"></span>
            <span class="lightbox-zoom-indicator" hidden></span>
          </div>
          <div class="lightbox-caption"></div>
          <div class="lightbox-meta-details"></div>
        </div>
        <div class="lightbox-actions">
          <button type="button" class="lightbox-btn lightbox-copy" title="${t('chat.copyImage')}" aria-label="${t('chat.copyImage')}">
            <span class="material-symbols-outlined">content_copy</span>
          </button>
          <button type="button" class="lightbox-btn lightbox-download" title="${t('common.download')}">
            <span class="material-symbols-outlined">download</span>
          </button>
          <button type="button" class="lightbox-btn lightbox-close" title="${t('common.close')}">
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
      </div>
      <button type="button" class="lightbox-nav lightbox-nav--prev" title="${t('common.previous')}">
        <span class="material-symbols-outlined md-28">chevron_left</span>
      </button>
      <div class="lightbox-stage">
        <div class="lightbox-media-frame"></div>
      </div>
      <button type="button" class="lightbox-nav lightbox-nav--next" title="${t('common.next')}">
        <span class="material-symbols-outlined md-28">chevron_right</span>
      </button>
    `;

    const stage = overlay.querySelector('.lightbox-stage') as HTMLElement | null;
    const frame = overlay.querySelector('.lightbox-media-frame') as HTMLElement | null;
    const counter = overlay.querySelector('.lightbox-counter') as HTMLElement | null;
    const caption = overlay.querySelector('.lightbox-caption') as HTMLElement | null;
    const metaDetails = overlay.querySelector('.lightbox-meta-details') as HTMLElement | null;
    const zoomIndicator = overlay.querySelector('.lightbox-zoom-indicator') as HTMLElement | null;
    const prevButton = overlay.querySelector('.lightbox-nav--prev') as HTMLButtonElement | null;
    const nextButton = overlay.querySelector('.lightbox-nav--next') as HTMLButtonElement | null;
    const downloadButton = overlay.querySelector('.lightbox-download') as HTMLButtonElement | null;
    const copyButton = overlay.querySelector<HTMLButtonElement>('.lightbox-copy');
    const closeButton = overlay.querySelector('.lightbox-close') as HTMLButtonElement | null;
    if (!stage || !frame || !counter || !caption || !metaDetails || !zoomIndicator || !prevButton || !nextButton || !downloadButton || !copyButton || !closeButton) {
      return () => {};
    }

    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

    const updateZoomIndicator = () => {
      if (!currentImage) {
        zoomIndicator.hidden = true;
        return;
      }
      const actualScale = getActualScale();
      const percent = Math.round((zoom / actualScale) * 100);
      zoomIndicator.hidden = false;
      zoomIndicator.innerText = `${percent}%`;
      zoomIndicator.title = `${t('common.zoom')}: ${percent}%`;
    };

    const clampPan = () => {
      if (!currentImage || zoom <= 1) {
        panX = 0;
        panY = 0;
        return;
      }
      const maxX = Math.max(0, (fittedWidth * zoom - overlay.clientWidth) / 2);
      const maxY = Math.max(0, (fittedHeight * zoom - overlay.clientHeight) / 2);
      panX = clamp(panX, -maxX, maxX);
      panY = clamp(panY, -maxY, maxY);
    };

    const updateImageTransform = () => {
      if (!currentImage) {
        zoomIndicator.hidden = true;
        stage.classList.remove('is-pannable', 'is-dragging');
        return;
      }
      clampPan();
      frame.style.width = `${fittedWidth * zoom}px`;
      frame.style.height = `${fittedHeight * zoom}px`;
      frame.style.transform = `translate(${panX}px, ${panY}px)`;
      const pannable = fittedWidth * zoom > overlay.clientWidth || fittedHeight * zoom > overlay.clientHeight;
      currentImage.style.cursor = pannable ? (dragging ? 'grabbing' : 'grab') : 'zoom-in';
      stage.classList.toggle('is-pannable', pannable);
      stage.classList.toggle('is-dragging', dragging);
      updateZoomIndicator();
    };

    const fitImage = () => {
      if (!currentImage?.naturalWidth || !currentImage.naturalHeight || !stage.clientWidth || !stage.clientHeight) return;
      const fit = Math.min(1, stage.clientWidth / currentImage.naturalWidth, stage.clientHeight / currentImage.naturalHeight);
      fittedWidth = currentImage.naturalWidth * fit;
      fittedHeight = currentImage.naturalHeight * fit;
      updateImageTransform();
    };
    const resizeObserver = new ResizeObserver(fitImage);
    resizeObserver.observe(stage);

    const resetZoom = () => {
      zoom = 1;
      panX = 0;
      panY = 0;
      dragging = false;
      pointerId = null;
      updateImageTransform();
    };

    const syncCurrentVideoBackToInline = (options?: { resume?: boolean }) => {
      if (!currentLightboxVideo || !currentInlineVideo) return;
      currentLightboxVideo.pause();
      if (Number.isFinite(currentLightboxVideo.currentTime)) {
        const nextTime = Math.max(0, currentLightboxVideo.currentTime);
        currentInlineVideo.currentTime = nextTime;
      }
      currentInlineVideo.pause();
      if (options?.resume && resumeInlineVideoOnClose) {
        void playChatMedia(currentInlineVideo).catch((error: unknown) => {
          console.warn('[Lightbox] Could not resume inline media:', error);
        });
      }
      currentLightboxVideo = null;
      currentInlineVideo = null;
      resumeInlineVideoOnClose = false;
    };

    const getActualScale = () => {
      if (!currentImage) return 1;
      return Math.max(currentImage.naturalWidth / (fittedWidth || 1), currentImage.naturalHeight / (fittedHeight || 1), 1);
    };

    const setZoom = (nextZoom: number) => {
      zoom = clamp(nextZoom, 1, 8);
      if (zoom <= 1) {
        panX = 0;
        panY = 0;
      }
      updateImageTransform();
    };

    const releaseDrag = () => {
      if (currentImage && pointerId !== null && currentImage.hasPointerCapture(pointerId)) {
        currentImage.releasePointerCapture(pointerId);
      }
      pointerId = null;
      dragging = false;
      updateImageTransform();
    };

    const navigate = (direction: number) => {
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= items.length) return;
      currentIndex = nextIndex;
      renderCurrent();
    };

    const renderCurrent = () => {
      imageClipboard.cancel();
      syncCurrentVideoBackToInline();
      releaseDrag();
      resetZoom();
      frame.innerHTML = '';
      currentImage = null;
      fittedWidth = fittedHeight = 0;
      for (const property of ['width', 'height', 'transform']) frame.style.removeProperty(property);
      const item = items[currentIndex];
      frame.classList.toggle('lightbox-media-frame--image', item.kind === 'image');

      counter.innerText = `${currentIndex + 1} / ${items.length}`;
      caption.innerText = item.fileName;
      const metaLine = [item.senderName, item.timestamp].filter(Boolean).join(' • ');
      metaDetails.innerText = metaLine;
      metaDetails.hidden = metaLine.length === 0;
      prevButton.disabled = currentIndex === 0;
      nextButton.disabled = currentIndex === items.length - 1;
      zoomIndicator.hidden = item.kind !== 'image';
      copyButton.hidden = item.kind !== 'image';

      if (item.kind === 'image') {
        const img = document.createElement('img');
        img.className = 'lightbox-media lightbox-media--image';
        img.src = item.url;
        img.alt = item.fileName;
        img.draggable = false;
        img.addEventListener('load', () => {
          if (currentImage === img && overlay.isConnected) fitImage();
        });
        img.addEventListener(
          'wheel',
          (e) => {
            e.preventDefault();
            if (e.deltaY === 0 || !fittedWidth) return;
            setZoom(zoom + (e.deltaY < 0 ? 0.2 : -0.2));
          },
          { passive: false },
        );
        img.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          setZoom(zoom > 1.01 ? 1 : getActualScale());
        });
        img.addEventListener('pointerdown', (e) => {
          if (!stage.classList.contains('is-pannable')) return;
          e.preventDefault();
          e.stopPropagation();
          pointerId = e.pointerId;
          dragging = true;
          dragStartX = e.clientX;
          dragStartY = e.clientY;
          startPanX = panX;
          startPanY = panY;
          img.setPointerCapture(e.pointerId);
          updateImageTransform();
        });
        img.addEventListener('pointermove', (e) => {
          if (!dragging || pointerId !== e.pointerId) return;
          panX = startPanX + (e.clientX - dragStartX);
          panY = startPanY + (e.clientY - dragStartY);
          updateImageTransform();
        });
        img.addEventListener('pointerup', releaseDrag);
        img.addEventListener('pointercancel', releaseDrag);
        currentImage = img;
        frame.appendChild(img);
        fitImage();
      } else {
        const player = document.createElement('div');
        player.className = 'chat-video-player chat-video-player--lightbox';
        const video = document.createElement('video');
        video.className = 'chat-attachment-video chat-attachment-video--lightbox';
        video.src = item.url;
        video.preload = 'metadata';
        video.playsInline = true;
        const inlineVideo = item.source.querySelector('video') as HTMLVideoElement | null;
        const startTime = inlineVideo && Number.isFinite(inlineVideo.currentTime) ? inlineVideo.currentTime : 0;
        const shouldResumePlayback = !!inlineVideo && !inlineVideo.paused && !inlineVideo.ended;
        inlineVideo?.pause();
        if (inlineVideo) {
          video.volume = inlineVideo.volume;
          video.muted = inlineVideo.muted;
        }
        player.appendChild(video);
        frame.appendChild(player);
        initializeCustomVideoPlayers(frame);
        currentLightboxVideo = video;
        currentInlineVideo = inlineVideo;
        resumeInlineVideoOnClose = shouldResumePlayback;
        const applyStartTime = () => {
          const duration = Number.isFinite(video.duration) ? video.duration : 0;
          const nextTime = duration > 0 ? Math.min(startTime, Math.max(duration - 0.05, 0)) : startTime;
          if (nextTime > 0) {
            try {
              video.currentTime = nextTime;
            } catch {
              // Ignore seek failures until metadata becomes available.
            }
          }
          if (shouldResumePlayback) {
            void playChatMedia(video).catch((error: unknown) => {
              console.warn('[Lightbox] Could not play media:', error);
            });
          }
        };
        if (video.readyState >= 1) {
          applyStartTime();
        } else {
          video.addEventListener('loadedmetadata', applyStartTime, { once: true });
        }
      }
    };

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isFormField = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;

      if (!isFormField && currentImage && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
        e.preventDefault();
        e.stopPropagation();
        void imageClipboard.copy(items[currentIndex].url);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (!isFormField && e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        navigate(-1);
      } else if (!isFormField && e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        navigate(1);
      }
    };

    const close = () => {
      imageClipboard.cancel();
      syncCurrentVideoBackToInline({ resume: true });
      releaseDrag();
      if (document.fullscreenElement && overlay.contains(document.fullscreenElement)) {
        void document.exitFullscreen().catch(() => undefined);
      }
      document.removeEventListener('keydown', onKey, true);
      resizeObserver.disconnect();
      currentImage = null;
      overlay.remove();
      if (this.closeCurrent === close) this.closeCurrent = null;
    };

    this.closeCurrent = close;
    copyButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = items[currentIndex];
      if (current.kind === 'image') void imageClipboard.copy(current.url);
    });
    closeButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    });
    downloadButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const current = items[currentIndex];
      void onDownload(current.url, current.fileName);
    });
    prevButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigate(-1);
    });
    nextButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      navigate(1);
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target === stage || e.target === frame) close();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    renderCurrent();

    return close;
  }

  public close(): void {
    if (this.closeCurrent) {
      this.closeCurrent();
      this.closeCurrent = null;
    }
  }
}

export const lightboxModal = new LightboxModal();
