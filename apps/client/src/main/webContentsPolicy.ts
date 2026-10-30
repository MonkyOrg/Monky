import type { App, WebContents } from 'electron';

/**
 * Navigation and window policy for every WebContents Monky creates (E-MAIN-1).
 *
 * The guards used to be added window by window, and the windows that missed
 * them — the overlay and the update splash — could be steered to a remote page
 * that kept the window's preload, or open an Electron window showing remote
 * content. Installed once, before the first window exists, it denies by default:
 * - `<webview>` tags are never attached;
 * - `window.open` is refused (the main window replaces this handler with its
 *   own, which allows Picture-in-Picture and sends links to the browser);
 * - the top frame may only reload its own document; leaving it is cancelled.
 */
export function installWebContentsPolicy(app: Pick<App, 'on' | 'removeListener'>): () => void {
  const secure = (_event: Electron.Event, contents: WebContents): void => {
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => {
      if (event.url !== contents.getURL()) event.preventDefault();
    });
  };
  app.on('web-contents-created', secure);
  return () => { app.removeListener('web-contents-created', secure); };
}
