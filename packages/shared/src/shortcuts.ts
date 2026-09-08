/** Physical DOM codes and their libuiohook names; labels remain layout-specific. */
export const SHORTCUT_CODES: Readonly<Record<string, string>> = (() => {
  const codes: Record<string, string> = {};
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') codes[`Key${letter}`] = letter;
  for (let digit = 0; digit <= 9; digit++) {
    codes[`Digit${digit}`] = String(digit);
    codes[`Numpad${digit}`] = `Numpad${digit}`;
  }
  for (let f = 1; f <= 24; f++) codes[`F${f}`] = `F${f}`;
  for (const name of [
    'Space', 'Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
    'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'CapsLock', 'NumLock', 'ScrollLock', 'PrintScreen', 'Semicolon', 'Equal', 'Comma',
    'Minus', 'Period', 'Slash', 'Backquote', 'BracketLeft', 'BracketRight',
    'Backslash', 'Quote', 'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply',
    'NumpadDivide', 'NumpadDecimal', 'NumpadEnter',
  ]) codes[name] = name;
  // libuiohook exposes this ISO keycode but uiohook-napi omits its named constant.
  codes.IntlBackslash = 'IntlBackslash';
  return codes;
})();

export const SHORTCUT_MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
export type ShortcutModifier = typeof SHORTCUT_MODIFIERS[number];

export interface ShortcutTokens {
  codes: string[];
  modifiers: ShortcutModifier[];
  legacyKeys: Record<string, string>;
}

const LEGACY_KEYS: Readonly<Record<string, string>> = {
  ' ': 'Space', Return: 'Enter', Del: 'Delete', Esc: 'Escape',
  Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
  ';': 'Semicolon', ':': 'Semicolon', '=': 'Equal', '+': 'Equal',
  ',': 'Comma', '-': 'Minus', '_': 'Minus', '.': 'Period', '/': 'Slash',
  '?': 'Slash', '`': 'Backquote', '~': 'Backquote',
  '[': 'BracketLeft', '{': 'BracketLeft', '\\': 'Backslash', '|': 'Backslash',
  ']': 'BracketRight', '}': 'BracketRight', "'": 'Quote', '"': 'Quote',
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7',
  '*': '8', '(': '9', ')': '0',
  // Compatibility with Spanish recordings made before physical-code capture.
  'º': 'Backquote', 'ª': 'Backquote', 'Ñ': 'Semicolon', 'ñ': 'Semicolon',
  numadd: 'NumpadAdd', numsub: 'NumpadSubtract', nummult: 'NumpadMultiply',
  numdiv: 'NumpadDivide', numdec: 'NumpadDecimal', numenter: 'NumpadEnter',
};

/** Reads old accelerators and new physical chords without dropping unknown keys. */
export function parseShortcutTokens(
  accelerator: string,
  commandOrControl: 'Ctrl' | 'Meta' = 'Ctrl',
): ShortcutTokens | null {
  if (!accelerator) return null;
  const parts = accelerator === '+' ? ['+']
    : accelerator.endsWith('++') ? [...accelerator.slice(0, -2).split('+'), '+']
    : accelerator.split('+');
  const modifiers = new Set<ShortcutModifier>();
  const codes = new Set<string>();
  const legacyKeys: Record<string, string> = {};
  for (const token of parts) {
    if (['CommandOrControl', 'CmdOrCtrl'].includes(token)) modifiers.add(commandOrControl);
    else if (['Control', 'Ctrl'].includes(token)) modifiers.add('Ctrl');
    else if (['Alt', 'Option', 'AltGr'].includes(token)) modifiers.add('Alt');
    else if (token === 'Shift') modifiers.add('Shift');
    else if (['Super', 'Meta', 'Command', 'Cmd'].includes(token)) modifiers.add('Meta');
    else {
      let code: string | undefined;
      if (token.startsWith('code:')) {
        const physical = token.slice(5);
        if (Object.hasOwn(SHORTCUT_CODES, physical)) code = physical;
      } else {
        const name = LEGACY_KEYS[token] ?? (/^num[0-9]$/.test(token)
          ? `Numpad${token.slice(3)}` : /^[a-z]$/i.test(token) ? token.toUpperCase() : token);
        code = Object.keys(SHORTCUT_CODES).find((physical) => SHORTCUT_CODES[physical] === name);
      }
      if (!code) return null;
      if (!token.startsWith('code:')) legacyKeys[code] = token;
      codes.add(code);
    }
  }
  return { codes: [...codes].sort(), modifiers: SHORTCUT_MODIFIERS.filter((modifier) => modifiers.has(modifier)), legacyKeys };
}
