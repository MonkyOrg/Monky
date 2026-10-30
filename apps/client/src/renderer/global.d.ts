/// <reference types="vite/client" />

import type { ElectronApi } from '../preload/api';

declare global {
  interface Window {
    api: ElectronApi;
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
