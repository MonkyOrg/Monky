import { UiohookKey } from 'uiohook-napi';
import { SHORTCUT_CODES, parseShortcutTokens, type ShortcutModifier } from '@monky/shared';
import { windowsKeyboardLayout, type WindowsKeyboardLayout } from './windowsKeyboardLayout';

export interface ParsedHotkey {
  id: string;
  keyCodes: number[];
  modifiers: Set<ShortcutModifier>;
  active: boolean;
}

const codes: Readonly<Record<string, number>> = { ...UiohookKey, IntlBackslash: 0x0056 };
export function parseAcceleratorToHotkey(
  id: string, accelerator: string, layout: WindowsKeyboardLayout | null = windowsKeyboardLayout,
): ParsedHotkey | null {
  layout?.refresh();
  const tokens = parseShortcutTokens(accelerator, process.platform === 'darwin' ? 'Meta' : 'Ctrl');
  if (!tokens) return null;
  const keyCodes: number[] = [];
  for (const physical of tokens.codes) {
    const fallback = codes[SHORTCUT_CODES[physical]];
    const code = layout ? layout.resolve(physical, fallback, tokens.legacyKeys[physical], tokens.modifiers) : fallback;
    if (typeof code !== 'number') return null;
    // The hook cannot distinguish two physical keys collapsed into one VK by a
    // layout. Reject that chord rather than firing it after just one key.
    if (keyCodes.includes(code)) return null;
    keyCodes.push(code);
  }
  return { id, keyCodes, modifiers: new Set(tokens.modifiers), active: false };
}
