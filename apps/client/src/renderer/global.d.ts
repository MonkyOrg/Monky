/// <reference types="vite/client" />

import type { PlatformApi } from './platform/api';

declare global {
  /** Version of the app being built (apps/client/package.json), set by Vite. */
  const __MONKY_VERSION__: string;
  /** Where the web version opens bot miniapps (vite.config.ts). */
  const __MONKY_MINIAPPS_URL__: string;

  interface Window {
    api: PlatformApi;
    /** Chrome and Edge only: an always-on-top window for a document (#858). */
    documentPictureInPicture?: {
      requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
    };
    /** Console helper that prints the voice engine status (`debugVoice()` in DevTools). */
    debugVoice?: () => unknown;
  }

  // Chromium supports these output-routing APIs before our DOM typings.
  interface AudioContextOptions {
    sinkId?: string | { type: 'none' };
  }

  interface AudioContext {
    readonly sinkId: string | { type: 'none' };
    setSinkId?(sinkId: string): Promise<void>;
  }

  // Chromium caps an encoding's resolution (RTCResolutionRestriction) before our DOM typings.
  interface RTCRtpEncodingParameters {
    scaleResolutionDownTo?: { maxWidth: number; maxHeight: number };
  }
}

declare module '*.mp3' {
  const src: string;
  export default src;
}

declare module 'highlight.js/lib/core' {
  import { HLJSApi } from 'highlight.js';
  const hljs: HLJSApi;
  export default hljs;
}

declare module 'highlight.js/lib/languages/*' {
  import { LanguageFn } from 'highlight.js';
  const language: LanguageFn;
  export default language;
}

export {};
