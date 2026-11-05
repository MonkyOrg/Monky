import type { ImageSelectionResult } from '@monky/shared';

/**
 * Files on the web version (#858): a download replaces the save dialog and an
 * `<input type="file">` the open dialog. A browser does not tell whether the
 * person kept the download, so a started download counts as saved.
 */

export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // The download has started from the click; the URL only has to outlive it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function saveText(contents: string, fileName: string, type = 'text/plain'): void {
  saveBlob(new Blob([contents], { type }), fileName);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

/** Opens the browser's file picker; resolves with no files when the person cancels it. */
export function pickFiles(options: { accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (options.accept) input.accept = options.accept;
    input.multiple = options.multiple ?? false;
    input.style.display = 'none';
    const finish = (files: File[]): void => {
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => finish([]), { once: true });
    document.body.append(input);
    input.click();
  });
}

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp';

/** Same shape as the desktop dialog: `base64` is a data URL. */
export async function readImageSelection(file: File): Promise<ImageSelectionResult> {
  const mimeType = file.type || 'image/png';
  const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
  return { fileName: file.name, mimeType, base64: `data:${mimeType};base64,${base64}` };
}
