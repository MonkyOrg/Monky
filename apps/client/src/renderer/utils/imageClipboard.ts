import { LIMITS } from '@monky/shared';
import { t } from '../i18n';
import { showAlert } from '../views/Dialog';
import { showCopyToast } from '../views/CopyToast';

async function imagePng(source: string, signal: AbortSignal): Promise<Blob> {
  const url = new URL(source);
  if (!['http:', 'https:', 'blob:', 'data:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Unsupported clipboard image address');
  }
  const response = await fetch(url.href, { signal, credentials: 'omit' });
  const mimeType = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
  const maxBytes = LIMITS.MAX_ATTACHMENT_FILE_SIZE_DEFAULT;
  if (!response.ok || !mimeType.startsWith('image/') || !response.body) {
    throw new Error('Clipboard image is unavailable');
  }
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Clipboard image is too large');
  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Clipboard image is too large');
      chunks.push(new Uint8Array(value).buffer);
    }
  } finally {
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const bitmap = await createImageBitmap(new Blob(chunks, { type: mimeType }));
  const canvas = document.createElement('canvas');
  try {
    signal.throwIfAborted();
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 64 * 1024 * 1024) {
      throw new Error('Clipboard image dimensions are too large');
    }
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Clipboard image conversion is unavailable');
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode clipboard image')), 'image/png');
    });
    signal.throwIfAborted();
    if (png.size > maxBytes) throw new Error('Clipboard image is too large');
    return png;
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function writeImageClipboard(source: string, signal: AbortSignal): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem !== 'function') {
    throw new Error('Image clipboard access is unavailable');
  }
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(15_000)]);
  try {
    requestSignal.throwIfAborted();
    const png = imagePng(source, requestSignal);
    // Start the clipboard request in the originating gesture, not after a network round trip.
    await Promise.all([png, Promise.resolve().then(() => {
      requestSignal.throwIfAborted();
      return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    })]);
    requestSignal.throwIfAborted();
  } finally {
    controller.abort();
  }
}

export class ImageClipboard {
  private pending: AbortController | null = null;
  private clearFeedback: (() => void) | null = null;

  public async copy(source: string): Promise<void> {
    this.cancel();
    const controller = new AbortController();
    this.pending = controller;
    try {
      await writeImageClipboard(source, controller.signal);
      if (this.pending === controller) this.clearFeedback = showCopyToast(t('chat.imageCopied'));
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      console.warn('[ImageClipboard] Could not copy the image:', error);
      if (this.pending === controller) void showAlert({ message: t('chat.copyImageFailed'), variant: 'danger' });
    } finally {
      controller.abort();
      if (this.pending === controller) this.pending = null;
    }
  }

  public cancel(): void {
    this.pending?.abort();
    this.pending = null;
    this.clearFeedback?.();
    this.clearFeedback = null;
  }
}
