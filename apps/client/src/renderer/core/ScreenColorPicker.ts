import { isHexColor } from '../utils/colors';

export type ScreenColorPickerErrorCode = 'unsupported' | 'permission' | 'capture' | 'busy';

export class ScreenColorPickerError extends Error {
  constructor(public readonly code: ScreenColorPickerErrorCode, options?: ErrorOptions) {
    super(`Screen color picker: ${code}`, options);
    this.name = 'ScreenColorPickerError';
  }
}

interface NativeEyeDropper {
  open(options: { signal: AbortSignal }): Promise<{ sRGBHex: string }>;
}

declare global {
  interface Window {
    EyeDropper?: new () => NativeEyeDropper;
  }
}

let activeRequest: object | null = null;

export function isScreenColorPickerAvailable(): boolean {
  return typeof window !== 'undefined'
    && window.isSecureContext
    && typeof window.EyeDropper === 'function';
}

function pickerError(error: unknown): ScreenColorPickerError {
  const name = error instanceof Error ? error.name : '';
  const code = name === 'NotAllowedError' || name === 'SecurityError' ? 'permission'
    : name === 'NotSupportedError' ? 'unsupported'
      : name === 'InvalidStateError' ? 'busy' : 'capture';
  return new ScreenColorPickerError(code, { cause: error });
}

/**
 * Electron 34.2 implements WebContents::OpenEyeDropper with Chromium's native
 * magnifier. Keep capture, DPI mapping, Escape and image lifetime in Chromium;
 * the app only receives the chosen sRGB color.
 */
export function pickScreenColor(signal: AbortSignal): Promise<string | null> {
  if (signal.aborted) return Promise.resolve(null);
  if (!isScreenColorPickerAvailable() || !window.EyeDropper) {
    return Promise.reject(new ScreenColorPickerError('unsupported'));
  }
  if (activeRequest) return Promise.reject(new ScreenColorPickerError('busy'));
  // Aura reports an unfocused owner as AbortError, indistinguishable from Escape.
  // Reject it before opening rather than silently treating it as user cancellation.
  if (!document.hasFocus()) return Promise.reject(new ScreenColorPickerError('permission'));

  const EyeDropper = window.EyeDropper;
  const request = {};
  const controller = new AbortController();
  activeRequest = request;

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', cancel);
      window.removeEventListener('pagehide', cancel);
      if (activeRequest === request) activeRequest = null;
    };
    const complete = (color: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(color);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(pickerError(error));
    };
    const cancel = () => {
      if (settled) return;
      controller.abort();
      complete(null);
    };
    const failed = (error: unknown) => {
      if (settled) return;
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        complete(null);
      } else {
        fail(error);
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    window.addEventListener('pagehide', cancel, { once: true });

    try {
      // No await before open: Chromium must receive the button's user activation.
      new EyeDropper().open({ signal: controller.signal }).then(result => {
        if (settled) return;
        if (!result || !isHexColor(result.sRGBHex)) {
          fail(new Error('The native screen color picker returned an invalid color'));
          return;
        }
        complete(result.sRGBHex.toLowerCase());
      }, failed);
    } catch (error) {
      failed(error);
    }
  });
}
