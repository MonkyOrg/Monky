import { escapeHtml } from '../utils/html';
import { t } from '../i18n';
import { showAlert } from './Dialog';

let nextId = 0;

export function normalizeEditorLinkAddress(address: string): string | null {
  const raw = address.trim();
  if (!raw) return null;
  const explicit = /^https?:/i.test(raw);
  if (!explicit && /^[a-z][a-z\d+.-]*:\/\//i.test(raw)) return null;
  try {
    const url = new URL(explicit ? raw : `https://${raw}`);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    if (!explicit && (url.username || url.password || !url.hostname.includes('.')
      || raw.startsWith('/') || raw.includes('\\')
      || !url.hostname.split('.').every(label => /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label)))) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function showLinkPopover(
  trigger: HTMLElement, selected: string, signal: AbortSignal, address = '',
): Promise<[string, string] | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    const id = `chat-link-${++nextId}`;
    const panel = document.createElement('form');
    panel.className = 'chat-link-popover';
    panel.id = id;
    panel.noValidate = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('chat.formatLink'));
    panel.innerHTML = `<strong>${t('chat.formatLink')}</strong>
      ${[t('chat.formatLinkLabel'), t('chat.formatLinkUrl')].map((label, index) => `
        <label class="dialog-text-field" for="${id}-${index}">${escapeHtml(label)}
          <input class="input-field" id="${id}-${index}" data-link-input type="text" autocomplete="off" spellcheck="false"
            aria-describedby="${id}-${index}-error">
          <span class="dialog-input-error" id="${id}-${index}-error" role="alert" hidden></span>
        </label>`).join('')}
      <div class="chat-link-actions">
        <button type="button" class="btn btn-secondary" data-action="cancel">${t('common.cancel')}</button>
        <button type="submit" class="btn btn-primary" data-action="confirm">${t('common.confirm')}</button>
      </div>`;
    const inputs = [...panel.querySelectorAll<HTMLInputElement>('[data-link-input]')];
    const errors = [...panel.querySelectorAll<HTMLElement>('.dialog-input-error')];
    inputs[0].value = selected;
    inputs[1].value = address;
    const lifetime = new AbortController();
    const options = { signal: lifetime.signal };
    let submitted = false;
    let closed = false;
    const position = () => {
      if (!trigger.isConnected) { close(null, false); return; }
      const anchor = trigger.getBoundingClientRect();
      panel.style.maxHeight = `${Math.max(120, innerHeight - 16)}px`;
      panel.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - panel.offsetWidth - 8))}px`;
      panel.style.top = `${Math.max(8, anchor.top - panel.offsetHeight - 8)}px`;
    };
    const observer = new ResizeObserver(position);
    const close = (result: [string, string] | null, focus = true) => {
      if (closed) return;
      closed = true;
      lifetime.abort();
      observer.disconnect();
      signal.removeEventListener('abort', abort);
      panel.remove();
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-controls');
      if (focus && trigger.isConnected) trigger.focus();
      resolve(result);
    };
    const abort = () => close(null, false);
    const validate = () => {
      const address = normalizeEditorLinkAddress(inputs[1].value);
      const messages = [inputs[0].value.trim() ? '' : t('chat.formatLinkTextRequired'),
        address ? '' : t('chat.formatLinkInvalid')];
      messages.forEach((message, index) => {
        errors[index].textContent = message;
        errors[index].hidden = !message;
        inputs[index].setAttribute('aria-invalid', String(!!message));
      });
      position();
      return messages.every(message => !message) ? address : null;
    };
    panel.addEventListener('submit', event => {
      event.preventDefault();
      submitted = true;
      const address = validate();
      if (address) close([inputs[0].value, address]);
      else inputs.find(input => input.getAttribute('aria-invalid') === 'true')?.focus();
    }, options);
    panel.addEventListener('input', () => { if (submitted) validate(); }, options);
    panel.querySelector('[data-action="cancel"]')!.addEventListener('click', () => close(null), options);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(null);
    }, { ...options, capture: true });
    document.addEventListener('pointerdown', event => {
      if (event.target instanceof Node && !panel.contains(event.target)) close(null, false);
    }, { ...options, capture: true });
    document.addEventListener('focusin', event => {
      if (event.target instanceof Node && !panel.contains(event.target) && event.target !== trigger) close(null, false);
    }, options);
    window.addEventListener('resize', position, options);
    window.addEventListener('scroll', position, { ...options, capture: true });
    signal.addEventListener('abort', abort, { once: true });
    document.body.append(panel);
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', id);
    observer.observe(panel);
    position();
    inputs[selected ? 1 : 0].focus();
  });
}

type LinkEditor = HTMLElement & {
  value: string; selectionStart: number; selectionEnd: number; maxLength: number; readOnly: boolean; disabled: boolean;
  insertText(text: string, from: number, to: number): void;
  setSelectionRange(from: number, to: number): void;
};

export async function editEditorLink(
  editor: LinkEditor, trigger: HTMLElement, signal: AbortSignal,
  from = editor.selectionStart, to = editor.selectionEnd, label = editor.value.slice(from, to), address = '',
): Promise<void> {
  const original = editor.value;
  const values = await showLinkPopover(trigger, label, signal, address);
  if (!values || signal.aborted || !editor.isConnected) return;
  if (editor.value !== original || editor.readOnly || editor.disabled) {
    void showAlert({ message: t('chat.formatLinkChanged'), variant: 'warning' });
    return;
  }
  const display = values[0].replace(/[\\[\]]/g, '\\$&');
  const url = values[1].replace(/\(/g, '%28').replace(/\)/g, '%29');
  const text = `[${display}](${url})`;
  if (editor.maxLength >= 0 && original.length - (to - from) + text.length > editor.maxLength) {
    void showAlert({ message: t('chat.messageTooLong', { max: editor.maxLength }), variant: 'danger' });
    return;
  }
  editor.insertText(text, from, to);
  editor.setSelectionRange(from + text.length, from + text.length);
  editor.focus();
}
