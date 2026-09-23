import { SHORTCUT_CODES, SHORTCUT_MODIFIERS, parseShortcutTokens, type ShortcutModifier } from '@monky/shared';
import { t } from '../i18n';

export interface ShortcutKeyCombo {
  accelerator: string;
  display: string;
}

export function shortcutIdentity(accelerator: string): string | null {
  const tokens = parseShortcutTokens(accelerator,
    typeof window !== 'undefined' && window.api?.platform === 'darwin' ? 'Meta' : 'Ctrl');
  return tokens ? [...tokens.modifiers, ...tokens.codes.map((code) => `code:${code}`)].join('+') : null;
}

function modifierForCode(code: string): ShortcutModifier | undefined {
  if (code.startsWith('Control')) return 'Ctrl';
  return SHORTCUT_MODIFIERS.find((modifier) => code.startsWith(modifier));
}

function heldKey(code: string, key = '', keyCode = 0): string {
  if (code && code !== 'Unidentified') return code;
  // keyCode is used only to pair DOM releases, never as a native hook keycode.
  return keyCode > 0 ? `logical:${keyCode}` : `key:${key.toUpperCase()}`;
}

/** Records one held chord, not a sequence. Commit only after every key is released. */
export class ShortcutCapture {
  private held = new Set<string>();
  private labels = new Map<string, string>();
  private releasing = false;
  private invalid = false;

  public keyDown(event: Pick<KeyboardEvent, 'code' | 'key' | 'repeat'>
    & Partial<Pick<KeyboardEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey' | 'keyCode'>>): ShortcutKeyCombo | null {
    if (event.repeat || this.releasing) return this.combo;
    let modifier = modifierForCode(event.code);
    this.held.add(heldKey(event.code, event.key, event.keyCode));
    let token = modifier ?? `code:${event.code}`;
    // Virtual/remote keyboards can deliver a valid key without a physical code.
    // Keep it logical (the legacy format), rather than guessing a US position.
    if (!event.code || event.code === 'Unidentified') {
      const logical = parseShortcutTokens(event.key);
      if (logical && logical.codes.length + logical.modifiers.length === 1) {
        modifier = logical.modifiers[0];
        token = modifier ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
      } else {
        this.invalid = true;
        return null;
      }
    } else if (!modifier && !Object.hasOwn(SHORTCUT_CODES, event.code)) {
      this.invalid = true;
      return null;
    }
    const label = modifier ?? (event.code === 'Space' || event.key === ' ' ? t('keybind.space')
      : event.code.startsWith('Numpad') ? `Num ${event.key}`
      : event.key === 'Dead' ? event.code : event.key.length === 1 ? event.key.toUpperCase() : event.key);
    this.labels.set(token, label);
    // AltGr can report Ctrl+Alt without delivering a separate Ctrl keydown.
    for (const [modifier, active] of [
      ['Ctrl', event.ctrlKey], ['Alt', event.altKey], ['Shift', event.shiftKey], ['Meta', event.metaKey],
    ] as const) {
      if (active) this.labels.set(modifier, modifier);
    }
    return this.combo;
  }

  public keyUp(code: string, key?: string, keyCode?: number): ShortcutKeyCombo | null {
    if (!this.held.delete(heldKey(code, key, keyCode))) return null;
    this.releasing = true;
    if (this.held.size > 0) return null;
    if (!this.invalid) return this.combo;
    this.labels.clear();
    this.releasing = false;
    this.invalid = false;
    return null;
  }

  public get combo(): ShortcutKeyCombo | null {
    if (this.invalid || !this.labels.size) return null;
    const keys = [...this.labels.keys()]
      .filter((token) => token !== '+' && !SHORTCUT_MODIFIERS.some((modifier) => modifier === token)).sort();
    // The legacy parser encodes a literal plus as the final "+" token.
    if (this.labels.has('+')) keys.push('+');
    const tokens = [
      ...SHORTCUT_MODIFIERS.filter((modifier) => this.labels.has(modifier)),
      ...keys,
    ];
    return {
      accelerator: tokens.join('+'),
      display: tokens.map((token) => this.labels.get(token)).join(' + '),
    };
  }
}

/** Owns all modal listeners, including cancellation when its parent is removed. */
let cancelActiveCapture: (() => void) | null = null;

export function captureShortcut(
  backdrop: Pick<HTMLElement, 'isConnected'>,
  preview: Pick<HTMLElement, 'textContent'> | null,
  onCaptured: (combo: ShortcutKeyCombo) => void,
  onCancel: () => void,
  owner: Pick<HTMLElement, 'isConnected'> = backdrop,
): () => void {
  cancelActiveCapture?.();
  cancelActiveCapture = onCancel;
  const capture = new ShortcutCapture();
  let closed = false;
  let ready = !window.api?.setShortcutCapture;
  const keyDown = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') { onCancel(); return; }
    if (!ready) return;
    const combo = capture.keyDown(event);
    if (preview) preview.textContent = combo?.display ?? t('keybinds.unsupportedKey');
  };
  const keyUp = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!ready) return;
    const combo = capture.keyUp(event.code, event.key, event.keyCode);
    if (combo) onCaptured(combo);
  };
  const blur = () => onCancel();
  const observer = new MutationObserver(() => {
    if (!backdrop.isConnected || !owner.isConnected) onCancel();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('keydown', keyDown, true);
  window.addEventListener('keyup', keyUp, true);
  window.addEventListener('blur', blur);
  if (window.api?.setShortcutCapture) {
    window.api.setShortcutCapture(true).then((ok) => {
      if (closed) return;
      ready = ok;
      if (!ok && preview) preview.textContent = t('keybinds.hookUnavailable');
    }).catch(() => {
      if (!closed && preview) preview.textContent = t('keybinds.hookUnavailable');
    });
  }
  return () => {
    if (closed) return;
    closed = true;
    if (cancelActiveCapture === onCancel) cancelActiveCapture = null;
    observer.disconnect();
    window.removeEventListener('keydown', keyDown, true);
    window.removeEventListener('keyup', keyUp, true);
    window.removeEventListener('blur', blur);
    void window.api?.setShortcutCapture?.(false).catch(() => {});
  };
}
