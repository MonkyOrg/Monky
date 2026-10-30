import { stickerService } from '../../core/StickerService';
import { t } from '../../i18n';
import { serverStore } from '../../stores/serverStore';
import { settingsStore } from '../../stores/settingsStore';
import { getAttachmentUrl } from '../../utils/attachment';
import { withButtonLoading } from '../../utils/buttonLoading';
import { reportError } from '../../utils/feedback';
import { downloadFilesWithChoice, type DownloadableFile } from '../../utils/fileDownloads';
import { showSuccessToast } from '../CopyToast';
import { downloadLightboxFile, lightboxModal, type LightboxMedia } from '../LightboxModal';
import type { ChatContext } from './chatContext';

/** Media that share a message's carousel: downloading one of them offers all. */
interface CarouselMedia {
  key: string;
  files: DownloadableFile[];
  archiveName: string;
}

/** Copying images, the media viewer, downloads and sticker saving in one feed entry of a channel. */
export function bindChatMedia(element: HTMLElement, ctx: ChatContext): void {
  element.querySelectorAll<HTMLButtonElement>('.chat-attachment-copy').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const image = button.closest('.chat-inline-media')?.querySelector<HTMLImageElement>('.chat-attachment-image');
      if (image) void ctx.actions.copyAttachmentImage(image);
    });
  });
  element.querySelectorAll<HTMLElement>('.chat-inline-media[data-lightbox-kind="image"] .chat-attachment-image').forEach((img) => {
    img.addEventListener('click', () => {
      const source = img.closest<HTMLElement>('[data-lightbox-kind]');
      if (source) openLightbox(ctx, source);
    });
  });

  element.querySelectorAll<HTMLElement>('.chat-attachment-lightbox-trigger').forEach((button) => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const source = button.closest<HTMLElement>('[data-lightbox-kind]');
      if (source) openLightbox(ctx, source);
    });
  });

  element.querySelectorAll('.chat-attachment-file').forEach((chip) => {
    chip.addEventListener('click', () => {
      const url = chip.getAttribute('data-download-url');
      const name = chip.getAttribute('data-file-name') || 'attachment';
      if (url) void downloadLightboxFile(url, name);
    });
  });

  element.querySelectorAll<HTMLButtonElement>('.chat-attachment-download').forEach((button) => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = button.getAttribute('data-download-url');
      const name = button.getAttribute('data-file-name') || 'attachment';
      if (!url) return;
      const carousel = carouselMedia(ctx, button);
      void withButtonLoading(button, () => carousel
        ? downloadFilesWithChoice(carousel.files, carousel.archiveName, { url, fileName: name })
        : downloadLightboxFile(url, name));
    });
  });

  element.querySelectorAll('.chat-sticker-save').forEach((button) => {
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = button.getAttribute('data-sticker-url');
      const name = button.getAttribute('data-sticker-name') || 'sticker';
      if (url) void saveSticker(url, name);
    });
  });
}

/**
 * Copies a sticker somebody else sent into the local folder (#356 QA). Without
 * a folder configured there is nowhere to put it, so the picker is offered
 * instead of failing silently.
 */
async function saveSticker(url: string, fileName: string): Promise<void> {
  const attachmentUrl = getAttachmentUrl(url);
  if (!attachmentUrl) {
    reportError(t('chat.stickerSaveFailed'));
    return;
  }
  let result = await stickerService.saveFromUrl(attachmentUrl, fileName);

  // `no-folder` covers both "never picked one" and "the main process has not
  // seen the user confirm this folder in this run" — it only writes to folders
  // chosen through its own dialog. Either way, asking is the right answer.
  if (!result.ok && result.reason === 'no-folder') {
    const folder = await window.api?.selectStickersFolder?.();
    if (!folder) return;
    settingsStore.stickersFolderPath = folder;
    settingsStore.save();
    await stickerService.loadStickers(true);
    result = await stickerService.saveFromUrl(attachmentUrl, fileName);
  }

  if (result.ok) {
    showSuccessToast(t('chat.stickerSaved', { name: result.fileName ?? fileName }));
    return;
  }

  const reasonKey =
    result.reason === 'too-large'
      ? 'chat.stickerSaveTooLarge'
      : result.reason === 'bad-extension'
        ? 'chat.stickerSaveBadFormat'
        : 'chat.stickerSaveFailed';
  reportError(t(reasonKey));
}

function carouselMedia(ctx: ChatContext, element: HTMLElement): CarouselMedia | null {
  const carousel = element.closest<HTMLElement>('.chat-attachment-carousel');
  const key = element.closest<HTMLElement>('.chat-message-row')?.dataset.messageId;
  if (!carousel || !key) return null;
  const media = [...carousel.querySelectorAll<HTMLElement>('[data-lightbox-kind]')];
  const files = media.flatMap((node) => {
    const url = node.getAttribute('data-lightbox-url');
    return url ? [{ url, fileName: node.getAttribute('data-lightbox-name') || 'attachment' }] : [];
  });
  if (files.length < 2) return null;
  const channel = serverStore.getChannel(ctx.channelId ?? '')?.name ?? '';
  const sender = media[0].getAttribute('data-lightbox-sender') || '';
  return { key, files, archiveName: [channel, sender].filter(Boolean).join(' - ') || 'Monky' };
}

/** Opens the viewer on one media, letting the reader step through every other one in the feed. */
function openLightbox(ctx: ChatContext, source: HTMLElement): void {
  const feed = ctx.feed.list?.element;
  if (!feed) return;

  const items = Array.from(feed.querySelectorAll<HTMLElement>('[data-lightbox-kind]'))
    .map((node) => {
      const kind = node.getAttribute('data-lightbox-kind');
      const url = node.getAttribute('data-lightbox-url');
      const fileName = node.getAttribute('data-lightbox-name') || 'attachment';
      const senderName = node.getAttribute('data-lightbox-sender') || '';
      const timestamp = node.getAttribute('data-lightbox-timestamp') || '';
      if ((kind === 'image' || kind === 'video') && url) {
        const carousel = carouselMedia(ctx, node);
        const group = carousel ? { key: carousel.key, archiveName: carousel.archiveName } : undefined;
        return { kind, url, fileName, senderName, timestamp, source: node, group } as LightboxMedia;
      }
      return null;
    })
    .filter((item): item is LightboxMedia => item !== null);

  if (items.length === 0) return;
  const startIndex = items.findIndex((item) => item.source === source);
  if (startIndex >= 0) {
    lightboxModal.open(items, startIndex, (url, name) => downloadLightboxFile(url, name));
  }
}
