import type { WebContents, WebFrameMain, Session } from 'electron';

const protectedFrames = new WeakSet<WebFrameMain>();

export function isBotScreenUrl(url: string): boolean {
  return /^(?:about:srcdoc(?:#|$)|monky-miniapp:)/i.test(url);
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

/** A miniapp may navigate its children, never the application or privileged URLs. */
export function bindBotScreenIsolation(contents: WebContents): void {
  const permittedNavigation = (url: string): boolean => {
    if (!isBotScreenWebUrl(url) || !URL.canParse(url) || !URL.canParse(contents.getURL())) return false;
    const application = new URL(contents.getURL());
    // In development the privileged renderer is served over HTTP, not file:.
    return !/^https?:$/.test(application.protocol) || new URL(url).origin !== application.origin;
  };
  contents.on('frame-created', (_event, { frame }) => { isBotScreenFrame(frame); });
  contents.on('will-frame-navigate', (event) => {
    if (isBotScreenFrame(event.initiator) && event.frame === contents.mainFrame) {
      event.preventDefault();
    } else if (isBotScreenFrame(event.frame) && !permittedNavigation(event.url)) {
      event.preventDefault();
    }
  });
  contents.on('will-redirect', (event) => {
    if (isBotScreenFrame(event.frame) && !permittedNavigation(event.url)) event.preventDefault();
  });
}

/** Register once per session (Electron only keeps the last webRequest listener). */
export function installBotScreenRequestGuard(session: Session): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    const miniapp = isBotScreenFrame(details.frame) || isBotScreenUrl(details.referrer);
    callback({ cancel: miniapp && !isBotScreenWebUrl(details.url) });
  });
}

function isBotScreenWebUrl(url: string): boolean {
  return /^(?:https?:|wss?:|blob:|data:|monky-miniapp:|about:blank(?:#|$)|about:srcdoc(?:#|$))/i.test(url);
}
