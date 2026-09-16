import type { RendererBootstrapFailure } from '@monky/shared';

let reported = false;

/** Only the required startup path uses this boundary, not runtime rejections. */
export async function runFatalBootstrap(
  initialize: () => void | Promise<void>,
  phase: RendererBootstrapFailure['phase'],
): Promise<void> {
  try {
    await initialize();
  } catch (error: unknown) {
    if (reported) return;
    reported = true;
    const failure: RendererBootstrapFailure = {
      phase,
      errorName: error instanceof Error && typeof error.name === 'string' ? error.name.slice(0, 100) : 'Error',
      ...(error instanceof Error && typeof error.stack === 'string' ? { stack: error.stack.slice(0, 12000) } : {}),
    };
    // Main validates and strips messages, URLs and personal paths from stacks.
    // If the bridge itself is broken, Main's startup watchdog still works.
    try {
      if (!await window.api?.reportFatalBootstrap?.(failure)) {
        console.error('[Bootstrap] Fatal failure was not accepted; waiting for Main recovery');
      }
    } catch (reportError: unknown) {
      console.error('[Bootstrap] Could not notify Main about the fatal failure', reportError);
    }
  }
}
