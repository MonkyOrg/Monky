import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { WebContents } from 'electron';
import type { MiniappBrowserAppearance, MiniappBrowserOpen } from '@monky/shared';
import { browserHomeMessages } from '../renderer/i18n/locales/browserHome';

const font = readFileSync(createRequire(__filename).resolve('@fontsource/inter/files/inter-latin-400-normal.woff2')).toString('base64');

/** Paint only the app-created blank document, never a visited page or a privileged URL. */
export async function renderMiniappBrowserHome(
  contents: WebContents, locale: MiniappBrowserOpen['locale'], appearance: MiniappBrowserAppearance | null,
): Promise<void> {
  const input = { locale, messages: browserHomeMessages[locale], appearance, font };
  await contents.executeJavaScript(`(${paintHome.toString()})(${JSON.stringify(input)})`);
}

function paintHome(input: {
  locale: string; messages: typeof browserHomeMessages.en; appearance: MiniappBrowserAppearance | null; font: string;
}): void {
  if (location.href !== 'about:blank') return;
  const root = document.documentElement;
  root.lang = input.locale;
  if (!document.querySelector('[data-miniapp-browser-home]')) {
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";
    const style = document.createElement('style');
    style.textContent = `
      @font-face { font-family: Inter; font-style: normal; font-weight: 400;
        src: url(data:font/woff2;base64,${input.font}) format('woff2'); }
      * { box-sizing: border-box; }
      html { min-height: 100%; background: #0b0e14; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
        background: var(--bg-primary, var(--bg-sidebar, #11151c));
        color: var(--text-primary, #f0f3f6);
        font: 14px/1.6 var(--font-main, Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); }
      main { width: min(100%, 560px); padding: 32px; text-align: center;
        background: var(--bg-card, #1c232d); border: 1px solid var(--border-color, #262c36); border-radius: 12px; }
      .mark { display: grid; place-items: center; width: 64px; height: 64px; margin: 0 auto 20px;
        border-radius: 16px; background: var(--accent-primary, #5865f2); color: #fff; }
      svg { width: 32px; height: 32px; }
      h1 { margin: 0 0 12px; font-size: 24px; line-height: 1.3; }
      p { margin: 0; color: var(--text-secondary, #9da7b3); overflow-wrap: anywhere; }
      .privacy { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--border-color, #262c36); font-size: 12px; }
    `;
    document.head.replaceChildren(policy, style);
    const home = document.createElement('main');
    home.dataset.miniappBrowserHome = '';
    home.setAttribute('aria-labelledby', 'browser-home-title');
    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.5');
    const globe = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    globe.setAttribute('d', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z');
    icon.append(globe);
    mark.append(icon);
    const title = document.createElement('h1'), hint = document.createElement('p'), privacy = document.createElement('p');
    title.id = 'browser-home-title';
    hint.id = 'browser-home-hint';
    privacy.className = 'privacy';
    home.append(mark, title, hint, privacy);
    document.body.replaceChildren(home);
  }
  if (input.appearance) {
    root.style.setProperty('--font-main', input.appearance.fontFamily);
    for (const [key, value] of Object.entries(input.appearance.colors)) {
      if (value !== undefined) root.style.setProperty(key, value);
    }
  }
  document.title = input.messages['browser.homeTitle'];
  document.querySelector('#browser-home-title')!.textContent = input.messages['browser.homeTitle'];
  document.querySelector('#browser-home-hint')!.textContent = input.messages['browser.homeHint'];
  document.querySelector('.privacy')!.textContent = input.messages['browser.privacy'];
}
