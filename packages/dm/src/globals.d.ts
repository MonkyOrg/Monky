/**
 * What the engine needs from its host, besides the crypto and storage it is
 * handed: timers, the console and text encoding. Both Node and browsers have
 * them; the package compiles without the DOM or Node typings, so nothing else
 * of either can slip in and break the other platform.
 */
declare global {
  type DmTimer = { unref?: () => unknown };
  function setTimeout(callback: () => void, ms?: number): DmTimer;
  function clearTimeout(timer: DmTimer | null | undefined): void;
  const console: {
    log(...data: unknown[]): void;
    warn(...data: unknown[]): void;
    error(...data: unknown[]): void;
  };
  class TextEncoder {
    encode(input?: string): Uint8Array;
  }
  class TextDecoder {
    constructor(label?: string, options?: { fatal?: boolean });
    decode(input?: Uint8Array): string;
  }
  function atob(data: string): string;
  function btoa(data: string): string;
}

export {};
