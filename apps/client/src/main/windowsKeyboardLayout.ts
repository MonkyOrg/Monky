import { getKeyboardLayout, type KeyboardLayoutSnapshot } from '@monky/screen-audio';
import { UiohookKey } from 'uiohook-napi';
import type { ShortcutModifier } from '@monky/shared';

const VK_TO_HOOK: Readonly<Record<number, number>> = (() => {
  const keys: Record<number, number> = {};
  const hookKeys: Readonly<Record<string, number>> = UiohookKey;
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') keys[letter.charCodeAt(0)] = hookKeys[letter];
  for (let digit = 0; digit <= 9; digit++) keys[0x30 + digit] = hookKeys[String(digit)];
  // libuiohook Windows input_helper.c maps VK_OEM_* slots to these constants.
  // The glyph and physical location of those slots are NOT fixed across layouts.
  Object.assign(keys, {
    0xba: UiohookKey.Semicolon, 0xbb: UiohookKey.Equal, 0xbc: UiohookKey.Comma,
    0xbd: UiohookKey.Minus, 0xbe: UiohookKey.Period, 0xbf: UiohookKey.Slash,
    0xc0: UiohookKey.Backquote, 0xdb: UiohookKey.BracketLeft, 0xdc: UiohookKey.Backslash,
    0xdd: UiohookKey.BracketRight, 0xde: UiohookKey.Quote, 0xdf: 0x007d,
    // VK_OEM_102 emits libuiohook's VC_LESSER_GREATER, not its physical scan 0x56.
    0xe2: 0x0e46,
    0x20: UiohookKey.Space,
  });
  return keys;
})();

const LAYOUT_KEYS = new Set([
  'Semicolon', 'Equal', 'Comma', 'Minus', 'Period', 'Slash', 'Backquote',
  'BracketLeft', 'BracketRight', 'Backslash', 'Quote', 'IntlBackslash',
]);

export class WindowsKeyboardLayout {
  private snapshot: KeyboardLayoutSnapshot | null = null;
  private characters = new Set<string>();

  public constructor(private readonly readLayout: typeof getKeyboardLayout = getKeyboardLayout) {}

  public get available(): boolean { return this.snapshot !== null; }
  public get id(): string | null { return this.snapshot?.id ?? null; }

  public refresh(force = false): boolean {
    const next = this.readLayout(force ? '' : this.snapshot?.id ?? '', [...this.characters].join(''));
    if (!next) return false;
    const changed = this.snapshot?.id !== next.id;
    this.snapshot = next;
    return changed;
  }

  public resolve(physicalCode: string, fallbackCode: number, legacyKey: string | undefined, modifiers: readonly ShortcutModifier[]): number | null {
    if (legacyKey?.length === 1) {
      // Previous recorders uppercased labels even without Shift.
      const character = legacyKey.toLowerCase();
      if (!this.characters.has(character)) {
        this.characters.add(character);
        this.refresh(true);
      }
      const key = this.snapshot?.characterToVirtualKey[character];
      if (key === undefined) return null;
      const required = key >> 8;
      if ((required & ~7) !== 0
        || ((required & 1) !== 0 && !modifiers.includes('Shift'))
        || ((required & 2) !== 0 && !modifiers.includes('Ctrl'))
        || ((required & 4) !== 0 && !modifiers.includes('Alt'))) return null;
      return VK_TO_HOOK[key & 0xff] ?? null;
    }
    // Named legacy accelerators are logical keys. Non-printing physical keys
    // (including F13+, whose uiohook constants are not Windows scan codes) do
    // not use the layout-dependent OEM/letter translation.
    if (legacyKey || (!/^Key[A-Z]$|^Digit[0-9]$/.test(physicalCode) && !LAYOUT_KEYS.has(physicalCode))) return fallbackCode;
    const vk = this.snapshot?.scanCodeToVirtualKey[String(fallbackCode)];
    return vk === undefined ? null : VK_TO_HOOK[vk] ?? null;
  }
}

export const windowsKeyboardLayout = process.platform === 'win32' ? new WindowsKeyboardLayout() : null;
