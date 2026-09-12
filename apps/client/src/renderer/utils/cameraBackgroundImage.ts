import { CAMERA_EFFECT_LIMITS, CameraEffectError, fitCameraEffectSize, cameraOperationCancelled } from './cameraEffects';

export interface CameraBackgroundImage {
  readonly id: string;
  readonly name: string;
  readonly blob: Blob;
}

export function cameraImageDimensions(bytes: Uint8Array, mime: string): { width: number; height: number } {
  let width = 0;
  let height = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === 'image/png' && bytes.length >= 24
    && view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a
    && view.getUint32(12) === 0x49484452) {
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (mime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > bytes.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)
        && length >= 7) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (mime === 'image/webp' && bytes.length >= 30
    && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunk = view.getUint32(offset);
      const length = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (start + length > bytes.length) break;
      if (chunk === 0x56503858 && length >= 10) {
        width = 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16);
        height = 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16);
        break;
      }
      if (chunk === 0x5650384c && length >= 5 && bytes[start] === 0x2f) {
        width = 1 + bytes[start + 1] + ((bytes[start + 2] & 0x3f) << 8);
        height = 1 + (bytes[start + 2] >> 6) + (bytes[start + 3] << 2) + ((bytes[start + 4] & 0x0f) << 10);
        break;
      }
      if (chunk === 0x56503820 && length >= 10
        && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
        width = view.getUint16(start + 6, true) & 0x3fff;
        height = view.getUint16(start + 8, true) & 0x3fff;
        break;
      }
      offset = start + length + (length & 1);
    }
  }
  if (!width || !height) throw new CameraEffectError('imageType');
  if (width > CAMERA_EFFECT_LIMITS.maxImageDimension || height > CAMERA_EFFECT_LIMITS.maxImageDimension
    || width * height > CAMERA_EFFECT_LIMITS.maxImagePixels) {
    throw new CameraEffectError('imageSize');
  }
  return { width, height };
}

export async function prepareCameraBackground(file: File, signal?: AbortSignal): Promise<CameraBackgroundImage> {
  if (signal?.aborted) throw cameraOperationCancelled();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new CameraEffectError('imageType');
  if (!file.size || file.size > CAMERA_EFFECT_LIMITS.maxImageBytes) throw new CameraEffectError('imageSize');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dimensions = cameraImageDimensions(bytes, file.type);
  if (signal?.aborted) throw cameraOperationCancelled();
  let bitmap: ImageBitmap | null = null;
  let canvas: OffscreenCanvas | null = null;
  try {
    bitmap = await createImageBitmap(file, { resizeWidth: Math.min(1280, dimensions.width) });
    if (signal?.aborted) throw cameraOperationCancelled();
    const size = fitCameraEffectSize(bitmap.width, bitmap.height);
    canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new CameraEffectError('unsupported');
    context.fillStyle = '#000000';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
    if (signal?.aborted) throw cameraOperationCancelled();
    if (!blob.size || blob.size > CAMERA_EFFECT_LIMITS.maxStoredImageBytes) throw new CameraEffectError('imageSize');
    return { id: crypto.randomUUID(), name: file.name.slice(0, 160), blob };
  } catch (error) {
    if (error instanceof CameraEffectError || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new CameraEffectError('imageDecode', { cause: error });
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

export async function validateStoredCameraBackground(image: CameraBackgroundImage): Promise<void> {
  const dimensions = cameraImageDimensions(new Uint8Array(await image.blob.arrayBuffer()), image.blob.type);
  if (dimensions.width > CAMERA_EFFECT_LIMITS.maxWidth || dimensions.height > CAMERA_EFFECT_LIMITS.maxHeight) {
    throw new CameraEffectError('imageSize');
  }
}
