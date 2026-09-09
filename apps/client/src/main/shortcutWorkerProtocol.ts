import type { ActionShortcutBinding, IpcEvents, PttConfig, SoundboardShortcutBinding } from '@monky/shared';

export interface ShortcutConfiguration {
  actions: ActionShortcutBinding[];
  sounds: SoundboardShortcutBinding[];
  ptt: PttConfig;
  pttCapture: boolean;
  shortcutCapture: boolean;
}

export type ShortcutCommand =
  | 'setActionHotkeys' | 'setSoundboardHotkeys' | 'setPttConfig'
  | 'setShortcutCapture' | 'startCapture' | 'stopCapture';

export interface ShortcutOperation {
  command: ShortcutCommand;
  payload?: unknown;
}

export type ShortcutWorkerRequest =
  | { type: 'init'; configuration: ShortcutConfiguration | null }
  | { type: 'request'; id: number; operation: ShortcutOperation }
  | { type: 'shutdown' };

const EVENT_CHANNELS = [
  'shortcut:action-triggered', 'soundboard:shortcut-triggered',
  'ptt:captured', 'ptt:state-changed',
] as const satisfies readonly (keyof IpcEvents)[];

type ShortcutEventChannel = typeof EVENT_CHANNELS[number];

export function isShortcutEventChannel(channel: string): channel is ShortcutEventChannel {
  return EVENT_CHANNELS.some((value) => value === channel);
}

export type ShortcutWorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; ok: boolean; configuration: ShortcutConfiguration }
  | { type: 'event'; channel: ShortcutEventChannel; args: unknown[] };
