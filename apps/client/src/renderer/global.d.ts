/// <reference types="vite/client" />

import { ElectronApi } from '../preload/preload';

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
