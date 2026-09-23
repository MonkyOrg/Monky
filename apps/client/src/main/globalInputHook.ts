import { uIOhook, UiohookKey, type UiohookKeyboardEvent, type UiohookMouseEvent } from 'uiohook-napi';
import type { IpcEvents, PttConfig, PttKeyBinding } from '@monky/shared';
import { SHORTCUT_MODIFIERS, type ShortcutModifier } from '@monky/shared';
import { parseAcceleratorToHotkey, type ParsedHotkey } from './shortcutParser';
import { windowsKeyboardLayout, type WindowsKeyboardLayout } from './windowsKeyboardLayout';
import type { ShortcutConfiguration } from './shortcutWorkerProtocol';
export { parseAcceleratorToHotkey } from './shortcutParser';

const KEYCODE_TO_NAME = new Map<number, string>(
  Object.entries(UiohookKey).map(([name, code]) => [code, name])
);
const MODIFIER_CODES: Record<ShortcutModifier, readonly number[]> = {
  Ctrl: [UiohookKey.Ctrl, UiohookKey.CtrlRight],
  Alt: [UiohookKey.Alt, UiohookKey.AltRight],
  Shift: [UiohookKey.Shift, UiohookKey.ShiftRight],
  Meta: [UiohookKey.Meta, UiohookKey.MetaRight],
};
const NUMPAD_CODES = new Map<number, number>([
  [UiohookKey.NumpadInsert, UiohookKey.Numpad0], [UiohookKey.NumpadEnd, UiohookKey.Numpad1],
  [UiohookKey.NumpadArrowDown, UiohookKey.Numpad2], [UiohookKey.NumpadPageDown, UiohookKey.Numpad3],
  [UiohookKey.NumpadArrowLeft, UiohookKey.Numpad4], [UiohookKey.NumpadArrowRight, UiohookKey.Numpad6],
  [UiohookKey.NumpadHome, UiohookKey.Numpad7], [UiohookKey.NumpadArrowUp, UiohookKey.Numpad8],
  [UiohookKey.NumpadPageUp, UiohookKey.Numpad9], [UiohookKey.NumpadDelete, UiohookKey.NumpadDecimal],
]);

interface PassiveHook {
  start(): void;
  stop(): void;
  on(event: 'keydown' | 'keyup', listener: (event: UiohookKeyboardEvent) => void): void;
  on(event: 'mousedown' | 'mouseup', listener: (event: UiohookMouseEvent) => void): void;
  removeListener(event: 'keydown' | 'keyup', listener: (event: UiohookKeyboardEvent) => void): void;
  removeListener(event: 'mousedown' | 'mouseup', listener: (event: UiohookMouseEvent) => void): void;
}

export function formatKeyDisplay(name: string): string {
  const overrides: Record<string, string> = {
    Space: 'Espaço', Escape: 'Esc', Control: 'Ctrl', ControlRight: 'Ctrl Direito',
    CtrlRight: 'Ctrl Direito', AltRight: 'Alt Gr', ShiftRight: 'Shift Direito',
    CapsLock: 'Caps Lock', ArrowUp: 'Seta Cima', ArrowDown: 'Seta Baixo',
    ArrowLeft: 'Seta Esquerda', ArrowRight: 'Seta Direita', PageUp: 'Page Up', PageDown: 'Page Down',
  };
  return overrides[name] || name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPttConfig(value: unknown): value is PttConfig {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return false;
  if (value.key === null) return true;
  const key = value.key;
  if (!isRecord(key) || typeof key.code !== 'string' || typeof key.display !== 'string') return false;
  if (key.keyType === 'mouse') return Number.isInteger(key.mouseButton) && Number(key.mouseButton) > 0 && Number(key.mouseButton) <= 5;
  return key.keyType === 'keyboard' && (
    (typeof key.keyCode === 'number' && Number.isInteger(key.keyCode) && key.keyCode > 0 && key.keyCode <= 0xffff)
    || (key.keyCode === undefined && [...KEYCODE_TO_NAME.values()].includes(key.code))
  );
}

/** A single passive observer shared by PTT, actions and soundboard. Never reserves keys. */
export class GlobalInputHook {
  private mainWindow: { isDestroyed(): boolean; webContents: { send(channel: string, ...args: unknown[]): void } } | null = null;
  private isHookRunning = false;
  private isCapturing = false;
  private isShortcutCapturing = false;
  private isPttActive = false;
  private pttConfig: PttConfig = { enabled: false, key: null };
  private listenersRegistered = false;
  private actionHotkeys: ParsedHotkey[] = [];
  private soundboardHotkeys: ParsedHotkey[] = [];
  private actionBindings: Array<{ id: string; accelerator: string }> = [];
  private soundboardBindings: Array<{ id: string; accelerator: string }> = [];
  private pressedKeys = new Set<number>();
  private modifiers = new Set<ShortcutModifier>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private layoutId: string | null = null;
  private readonly onKeyDown = (event: UiohookKeyboardEvent) => this.handleKeyDown(event);
  private readonly onKeyUp = (event: UiohookKeyboardEvent) => this.handleKeyUp(event);
  private readonly onMouseDown = (event: UiohookMouseEvent) => this.handleMouseDown(Number(event.button));
  private readonly onMouseUp = (event: UiohookMouseEvent) => this.handleMouseUp(Number(event.button));

  public constructor(
    private readonly hook: PassiveHook = uIOhook,
    private readonly layout: WindowsKeyboardLayout | null = windowsKeyboardLayout,
  ) {}

  public init(mainWindow: NonNullable<GlobalInputHook['mainWindow']>): void {
    this.mainWindow = mainWindow;
    this.layout?.refresh();
    if (!this.listenersRegistered) {
      this.hook.on('keydown', this.onKeyDown);
      this.hook.on('keyup', this.onKeyUp);
      this.hook.on('mousedown', this.onMouseDown);
      this.hook.on('mouseup', this.onMouseUp);
      this.listenersRegistered = true;
    }
    this.ensureHookState();
  }

  private ensureHookState(): boolean {
    const shouldRun = this.listenersRegistered && (
      this.isCapturing || this.isShortcutCapturing || this.pttConfig.enabled
      || this.actionBindings.length > 0 || this.soundboardBindings.length > 0
    );
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (shouldRun === this.isHookRunning) return true;
    try {
      if (shouldRun) this.hook.start();
      else this.hook.stop();
      this.isHookRunning = shouldRun;
      this.resetPressedState();
      return true;
    } catch (error) {
      console.warn('[GlobalInputHook] Native hook state change failed:', error);
      // Registration reports failure rather than pretending it worked. Retry the
      // latest desired state, not a stale config captured by an earlier caller.
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.ensureHookState();
      }, 1000);
      this.retryTimer.unref();
      return false;
    }
  }

  private resetPressedState(): void {
    this.pressedKeys.clear();
    this.modifiers.clear();
    for (const hotkey of [...this.actionHotkeys, ...this.soundboardHotkeys]) hotkey.active = false;
    this.releasePtt();
  }

  private releasePtt(): void {
    if (!this.isPttActive) return;
    this.isPttActive = false;
    this.emit('ptt:state-changed', false);
  }

  public setPttConfig(config: unknown): boolean {
    if (!isPttConfig(config)) return false;
    const key = config.key;
    const normalized: PttConfig = { enabled: config.enabled, key: key ? {
      code: key.code, display: key.display, keyType: key.keyType,
      ...(key.keyType === 'keyboard' ? { keyCode: key.keyCode } : { mouseButton: key.mouseButton }),
    } : null };
    if (JSON.stringify(normalized) !== JSON.stringify(this.pttConfig)) this.releasePtt();
    this.pttConfig = normalized;
    return this.ensureHookState();
  }

  public startCapture(): boolean {
    this.isCapturing = true;
    this.releasePtt();
    return this.ensureHookState();
  }

  public stopCapture(): boolean {
    this.isCapturing = false;
    return this.ensureHookState();
  }

  public setShortcutCapture(active: unknown): boolean {
    if (typeof active !== 'boolean') return false;
    this.isShortcutCapturing = active;
    this.releasePtt();
    this.armHeldHotkeys();
    this.layout?.refresh();
    return this.ensureHookState() && (!active || this.layout === null || this.layout.available);
  }

  public setActionHotkeys(shortcuts: unknown): boolean {
    const parsed = this.parseHotkeys(shortcuts, 'action');
    if (!parsed) return false;
    this.actionHotkeys = parsed.hotkeys;
    this.actionBindings = parsed.bindings;
    this.armHeldHotkeys();
    return this.ensureHookState() && parsed.allSupported;
  }

  public setSoundboardHotkeys(shortcuts: unknown): boolean {
    const parsed = this.parseHotkeys(shortcuts, 'soundName');
    if (!parsed) return false;
    this.soundboardHotkeys = parsed.hotkeys;
    this.soundboardBindings = parsed.bindings;
    this.armHeldHotkeys();
    return this.ensureHookState() && parsed.allSupported;
  }

  public getConfiguration(): ShortcutConfiguration {
    return {
      actions: this.actionBindings.map(({ id, accelerator }) => ({ action: id, accelerator })),
      sounds: this.soundboardBindings.map(({ id, accelerator }) => ({ soundName: id, accelerator })),
      ptt: this.pttConfig,
      pttCapture: this.isCapturing,
      shortcutCapture: this.isShortcutCapturing,
    };
  }

  private parseHotkeys(list: unknown, idKey: 'action' | 'soundName'): {
    hotkeys: ParsedHotkey[]; bindings: Array<{ id: string; accelerator: string }>; allSupported: boolean;
  } | null {
    if (!Array.isArray(list)) return null;
    const parsed: ParsedHotkey[] = [];
    const bindings: Array<{ id: string; accelerator: string }> = [];
    let allSupported = true;
    for (const item of list) {
      if (!isRecord(item) || typeof item[idKey] !== 'string' || !item[idKey]
        || typeof item.accelerator !== 'string') return null;
      bindings.push({ id: item[idKey], accelerator: item.accelerator });
      const hotkey = parseAcceleratorToHotkey(item[idKey], item.accelerator, this.layout);
      if (!hotkey) allSupported = false;
      else parsed.push(hotkey);
    }
    return { hotkeys: parsed, bindings, allSupported };
  }

  private refreshLayout(): void {
    this.layout?.refresh();
    const id = this.layout?.id ?? null;
    if (id === this.layoutId) return;
    this.layoutId = id;
    const reparse = (bindings: Array<{ id: string; accelerator: string }>) => bindings.flatMap((binding) => {
      const hotkey = parseAcceleratorToHotkey(binding.id, binding.accelerator, this.layout);
      return hotkey ? [hotkey] : [];
    });
    this.actionHotkeys = reparse(this.actionBindings);
    this.soundboardHotkeys = reparse(this.soundboardBindings);
    // Old virtual codes no longer describe the same physical keys after an
    // input-language change. Require a fresh press instead of carrying a latch.
    this.resetPressedState();
  }

  private requiredKeysHeld(hotkey: ParsedHotkey): boolean {
    return hotkey.keyCodes.every((code) => this.pressedKeys.has(code))
      && [...hotkey.modifiers].every((modifier) => this.modifiers.has(modifier));
  }

  private armHeldHotkeys(): void {
    for (const hotkey of [...this.actionHotkeys, ...this.soundboardHotkeys]) {
      hotkey.active = this.requiredKeysHeld(hotkey);
    }
  }

  private updateModifiers(event: UiohookKeyboardEvent): void {
    const flags: Record<ShortcutModifier, boolean> = {
      Ctrl: event.ctrlKey, Alt: event.altKey, Shift: event.shiftKey, Meta: event.metaKey,
    };
    for (const modifier of SHORTCUT_MODIFIERS) {
      if (flags[modifier]) this.modifiers.add(modifier);
      else {
        this.modifiers.delete(modifier);
        for (const code of MODIFIER_CODES[modifier]) this.pressedKeys.delete(code);
      }
    }
  }

  private matchHotkeys(fireCode: number | null): void {
    const match = (hotkey: ParsedHotkey, channel: 'shortcut:action-triggered' | 'soundboard:shortcut-triggered') => {
      if (!this.requiredKeysHeld(hotkey)) {
        hotkey.active = false;
        return;
      }
      if (fireCode === null || hotkey.active || this.modifiers.size !== hotkey.modifiers.size) return;
      if (!hotkey.keyCodes.includes(fireCode)
        && ![...hotkey.modifiers].some((modifier) => MODIFIER_CODES[modifier].includes(fireCode))) return;
      hotkey.active = true;
      this.emit(channel, hotkey.id);
    };
    for (const hotkey of this.actionHotkeys) match(hotkey, 'shortcut:action-triggered');
    for (const hotkey of this.soundboardHotkeys) match(hotkey, 'soundboard:shortcut-triggered');
  }

  private handleKeyDown(event: UiohookKeyboardEvent): void {
    if (!this.isHookRunning) return;
    this.refreshLayout();
    const keycode = NUMPAD_CODES.get(event.keycode) ?? event.keycode;
    const keyName = KEYCODE_TO_NAME.get(event.keycode) || `Key_${event.keycode}`;
    const isRepeat = this.pressedKeys.has(keycode);
    this.updateModifiers(event);
    this.pressedKeys.add(keycode);
    if (this.isCapturing) {
      this.isCapturing = false;
      this.emit('ptt:captured', {
        code: keyName, display: formatKeyDisplay(keyName), keyType: 'keyboard', keyCode: event.keycode,
      });
      this.ensureHookState();
      return;
    }
    if (this.isShortcutCapturing) return;
    const key = this.pttConfig.key;
    if (!isRepeat && this.pttConfig.enabled && key?.keyType === 'keyboard'
      && ((key.keyCode !== undefined && (NUMPAD_CODES.get(key.keyCode) ?? key.keyCode) === keycode)
        || key.code === keyName) && !this.isPttActive) {
      this.isPttActive = true;
      this.emit('ptt:state-changed', true);
    }
    this.matchHotkeys(isRepeat ? null : keycode);
  }

  private handleKeyUp(event: UiohookKeyboardEvent): void {
    if (!this.isHookRunning) return;
    this.pressedKeys.delete(NUMPAD_CODES.get(event.keycode) ?? event.keycode);
    this.updateModifiers(event);
    const key = this.pttConfig.key;
    if (key?.keyType === 'keyboard'
      && ((key.keyCode !== undefined && (NUMPAD_CODES.get(key.keyCode) ?? key.keyCode) === (NUMPAD_CODES.get(event.keycode) ?? event.keycode))
        || key.code === KEYCODE_TO_NAME.get(event.keycode))) this.releasePtt();
    // Releases only rearm; removing an extra modifier never toggles a held key.
    this.matchHotkeys(null);
  }

  private handleMouseDown(button: number): void {
    if (!this.isHookRunning || !Number.isInteger(button) || button < 1 || button > 5) return;
    if (this.isCapturing) {
      this.isCapturing = false;
      const buttonNames: Record<number, string> = {
        1: 'Mouse 1 (Esquerdo)', 2: 'Mouse 2 (Direito)', 3: 'Mouse 3 (Scroll)',
        4: 'Mouse 4 (Lateral Traseiro)', 5: 'Mouse 5 (Lateral Frontal)',
      };
      const binding: PttKeyBinding = { code: `Mouse${button}`, display: buttonNames[button], keyType: 'mouse', mouseButton: button };
      this.emit('ptt:captured', binding);
      this.ensureHookState();
      return;
    }
    if (this.isShortcutCapturing) return;
    const key = this.pttConfig.key;
    if (this.pttConfig.enabled && key?.keyType === 'mouse' && key.mouseButton === button && !this.isPttActive) {
      this.isPttActive = true;
      this.emit('ptt:state-changed', true);
    }
  }

  private handleMouseUp(button: number): void {
    if (this.pttConfig.key?.keyType === 'mouse' && this.pttConfig.key.mouseButton === button) this.releasePtt();
  }

  private emit<C extends keyof IpcEvents>(channel: C, ...args: IpcEvents[C]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.webContents.send(channel, ...args);
  }

  public destroy(): void {
    this.isCapturing = false;
    this.isShortcutCapturing = false;
    this.resetPressedState();
    this.pttConfig = { enabled: false, key: null };
    this.actionHotkeys = [];
    this.soundboardHotkeys = [];
    this.actionBindings = [];
    this.soundboardBindings = [];
    if (this.listenersRegistered) {
      this.hook.removeListener('keydown', this.onKeyDown);
      this.hook.removeListener('keyup', this.onKeyUp);
      this.hook.removeListener('mousedown', this.onMouseDown);
      this.hook.removeListener('mouseup', this.onMouseUp);
      this.listenersRegistered = false;
    }
    this.ensureHookState();
    this.mainWindow = null;
  }
}

export const globalInputHook = new GlobalInputHook();
