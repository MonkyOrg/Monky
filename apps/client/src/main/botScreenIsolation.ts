import type { WebContents, WebFrameMain, Session } from 'electron';

const protectedFrames = new WeakSet<WebFrameMain>();

export function isBotScreenUrl(url: string): boolean {
  return /^about:srcdoc(?:#|$)/i.test(url);
}

export function isBotScreenFrame(frame: WebFrameMain | null | undefined): boolean {
  try {
    for (let current = frame; current; current = current.parent) {
      if (protectedFrames.has(current) || isBotScreenUrl(current.url) || current.name.startsWith('monky-bot-screen-')) {
        if (frame) protectedFrames.add(frame);
        return true;
      }
    }
    return false;
  } catch { return true; }
}

/** CSP does not restrict a document's own navigation. Enforce that boundary in Electron too. */
export function bindBotScreenIsolation(contents: WebContents): void {
  contents.on('frame-created', (_event, { frame }) => { isBotScreenFrame(frame); });
  contents.on('will-frame-navigate', (event) => {
    if (isBotScreenFrame(event.initiator) ||
        (isBotScreenFrame(event.frame) && !isBotScreenUrl(event.url))) event.preventDefault();
  });
  contents.on('will-redirect', (event) => {
    if (isBotScreenFrame(event.initiator) || isBotScreenFrame(event.frame)) event.preventDefault();
  });
}

/** Register once per session (Electron only keeps the last webRequest listener). */
export function installBotScreenRequestGuard(session: Session): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: isBotScreenFrame(details.frame) || isBotScreenUrl(details.referrer) });
  });
}
