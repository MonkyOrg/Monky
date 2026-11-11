import type { IpcInvoker, IpcSubscriber, MiniappBrowserControl, MiniappBrowserState } from '@monky/shared';
import { MINIAPP_BROWSER_CHROME_HEIGHT } from '@monky/shared';
import { setLanguage, t, type TranslationKey } from './i18n';
import { reportError } from './utils/feedback';
import { animateEnter } from './utils/surfaceMotion';
import './styles/theme.css';
import './styles/miniappBrowser.css';

declare global {
  interface Window {
    miniappBrowser: {
      control: IpcInvoker<'miniapp-browser:control'>;
      onState: IpcSubscriber<'miniapp-browser:state'>;
      onFocusAddress: IpcSubscriber<'miniapp-browser:focus-address'>;
    };
  }
}

const lifecycle = new AbortController();
document.body.classList.add('miniapp-browser-controls');
document.body.style.setProperty('--miniapp-browser-chrome-height', `${MINIAPP_BROWSER_CHROME_HEIGHT}px`);
const toolbar = document.createElement('form');
toolbar.className = 'miniapp-browser-toolbar';
toolbar.noValidate = true;
const address = document.createElement('input');
address.type = 'text';
address.className = 'input-field';
address.autocomplete = 'off';
address.spellcheck = false;
address.maxLength = 8192;
const privacy = document.createElement('p');
privacy.className = 'miniapp-browser-privacy';
const controls: Array<{ button: HTMLButtonElement; key: TranslationKey }> = [];
const button = (icon: string, key: TranslationKey, action?: Exclude<MiniappBrowserControl['action'], 'navigate'>): HTMLButtonElement => {
  const element = document.createElement('button');
  element.type = action ? 'button' : 'submit';
  element.className = 'btn btn-secondary';
  const glyph = document.createElement('span');
  glyph.className = 'material-symbols-outlined md-18';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = icon;
  element.append(glyph);
  controls.push({ button: element, key });
  if (action) element.addEventListener('click', () => { void command({ action }); }, { signal: lifecycle.signal });
  return element;
};
const back = button('arrow_back', 'browser.back', 'back');
const forward = button('arrow_forward', 'browser.forward', 'forward');
const reload = button('refresh', 'browser.reload', 'reload');
const stop = button('stop', 'browser.stop', 'stop');
const go = button('arrow_forward', 'browser.go');
toolbar.append(back, forward, reload, stop, address, go);
document.querySelector('#app')!.append(toolbar, privacy);
animateEnter(toolbar, 'view');
let lastFailureId = -1;
const failures: Record<NonNullable<MiniappBrowserState['failure']>, TranslationKey> = {
  'invalid-url': 'browser.invalidUrl', 'navigation-failed': 'browser.navigationFailed',
  'permission-denied': 'browser.permissionDenied', 'popup-denied': 'browser.popupDenied', 'download-denied': 'browser.downloadDenied',
  'broadcast-unavailable': 'browser.broadcastFailed',
};
const render = (state: MiniappBrowserState): void => {
  if (state.appearance) {
    document.documentElement.style.setProperty('--font-main', state.appearance.fontFamily);
    for (const [key, value] of Object.entries(state.appearance.colors)) {
      if (value !== undefined) document.documentElement.style.setProperty(key, value);
    }
  }
  setLanguage(state.locale);
  document.title = t('desktopOnly.feature.miniappBrowser');
  for (const control of controls) {
    control.button.title = t(control.key);
    control.button.setAttribute('aria-label', t(control.key));
  }
  address.placeholder = t('browser.address');
  address.setAttribute('aria-label', t('browser.address'));
  privacy.textContent = t(state.broadcasting ? 'browser.broadcasting' : 'browser.broadcastStarting');
  privacy.setAttribute('role', 'status');
  address.disabled = !state.broadcasting;
  go.disabled = !state.broadcasting;
  if (document.activeElement !== address) address.value = state.url;
  back.disabled = !state.canGoBack;
  forward.disabled = !state.canGoForward;
  stop.disabled = !state.loading;
  stop.hidden = !state.loading;
  reload.hidden = state.loading;
  toolbar.setAttribute('aria-busy', String(state.loading));
  if (state.failure && state.failureId !== lastFailureId) reportError(t(failures[state.failure]),
    state.failure === 'invalid-url' ? { field: address, focus: true } : {});
  lastFailureId = state.failureId;
};
const command = async (input: MiniappBrowserControl): Promise<void> => {
  try {
    const state = await window.miniappBrowser.control(input);
    if (!lifecycle.signal.aborted && state) render(state);
  } catch (error: unknown) {
    if (!lifecycle.signal.aborted) {
      console.error('[Miniapp browser] Control failed.', error);
      reportError(t('browser.navigationFailed'));
    }
  }
};
toolbar.addEventListener('submit', event => {
  event.preventDefault();
  address.blur();
  void command({ action: 'navigate', url: address.value.trim() });
}, { signal: lifecycle.signal });
window.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    address.focus();
    address.select();
  }
}, { signal: lifecycle.signal });
const stopState = window.miniappBrowser.onState(render);
const stopFocus = window.miniappBrowser.onFocusAddress(() => { address.focus(); address.select(); });
window.addEventListener('beforeunload', () => { lifecycle.abort(); stopState(); stopFocus(); }, { once: true });
void command({ action: 'state' });
