import { execFile } from 'child_process';
import { BrowserWindow, NativeImage, nativeImage, nativeTheme, screen } from 'electron';
import type { IpcEventChannel, TrayVoiceStatus } from '@monky/shared';
import { mt } from './i18n';
import { sendEvent, windowContents } from './ipc/registry';
import { TASKBAR_ICON_MASKS, type TaskbarGlyph } from './taskbarCallIcons';

type CallAction = Extract<IpcEventChannel, 'tray:toggle-mute' | 'tray:toggle-deafen' | 'tray:leave-call'>;
type Rgb = readonly [red: number, green: number, blue: number];

export interface CallButton {
  glyph: TaskbarGlyph;
  danger: boolean;
  tooltip: string;
  action: CallAction;
  disabled: boolean;
}

/** The app's `--danger`, which also marks the muted and hang-up controls inside Monky. */
const DANGER: Rgb = [0xf2, 0x3f, 0x43];
/** Windows' own glyph colours on a dark and on a light taskbar. */
const ON_DARK_TASKBAR: Rgb = [0xff, 0xff, 0xff];
const ON_LIGHT_TASKBAR: Rgb = [0x1a, 0x1a, 0x1a];
/** Thumbnail toolbar icons follow the small-icon metric: 16 px at 100 % scale. */
const SMALL_ICON_SIZE = 16;
const PERSONALIZE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

/**
 * Buttons for a call state, in toolbar order: the microphone and headphones the
 * footer shows, then hanging up. None outside a call.
 */
export function describeCallButtons(status: TrayVoiceStatus): CallButton[] {
  if (!status.inCall) return [];
  // As in the footer, deafening silences the microphone too.
  const micOff = status.selfMuted || status.selfDeafened;
  return [
    {
      glyph: micOff ? 'mic_off' : 'mic',
      danger: micOff,
      tooltip: status.micLock === 'afk' ? mt('taskbar.micAfk')
        : status.micLock === 'permission' ? mt('taskbar.micLocked')
        : mt(status.selfMuted ? 'tray.unmuteMic' : 'tray.muteMic'),
      action: 'tray:toggle-mute',
      disabled: status.micLock !== null,
    },
    {
      glyph: status.selfDeafened ? 'headset_off' : 'headphones',
      danger: status.selfDeafened,
      tooltip: mt(status.selfDeafened ? 'tray.undeafen' : 'tray.deafen'),
      action: 'tray:toggle-deafen',
      disabled: false,
    },
    { glyph: 'call_end', danger: true, tooltip: mt('taskbar.leaveCall'), action: 'tray:leave-call', disabled: false },
  ];
}

/** Paints a white mask in one colour, in the premultiplied BGRA layout Skia uses on Windows. */
export function tintMask(mask: Buffer, [red, green, blue]: Rgb): Buffer {
  const pixels = Buffer.alloc(mask.length);
  for (let offset = 0; offset < mask.length; offset += 4) {
    const alpha = mask[offset + 3];
    pixels[offset] = Math.round((blue * alpha) / 255);
    pixels[offset + 1] = Math.round((green * alpha) / 255);
    pixels[offset + 2] = Math.round((red * alpha) / 255);
    pixels[offset + 3] = alpha;
  }
  return pixels;
}

/**
 * Mute, deafen and hang-up buttons on the window's thumbnail in the Windows
 * taskbar while a call is on, so the call can be handled without bringing
 * Monky to the front. The renderer still owns the call: a click only forwards
 * the same command the tray menu sends.
 */
export class TaskbarCallControls {
  private status: TrayVoiceStatus | null = null;
  /** What the toolbar shows; empty means no buttons, which is how a window starts. */
  private shownKey = '';
  private darkTaskbar = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  private themeReported = false;
  private disposed = false;
  private readonly icons = new Map<string, NativeImage>();

  constructor(private readonly window: BrowserWindow) {
    nativeTheme.on('updated', this.onThemeUpdated);
    screen.on('display-metrics-changed', this.render);
    window.once('closed', () => this.dispose());
    void readDarkTaskbar().then((dark) => {
      // A theme event during the read already brought a newer answer.
      if (dark === null || this.themeReported || this.disposed) return;
      this.darkTaskbar = dark;
      this.render();
    });
  }

  public update(status: TrayVoiceStatus): void {
    this.status = status;
    this.render();
  }

  /** Tooltips come from the main-process language, so switching it needs a redraw. */
  public refresh(): void {
    this.render();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    nativeTheme.removeListener('updated', this.onThemeUpdated);
    screen.removeListener('display-metrics-changed', this.render);
    if (this.shownKey && !this.window.isDestroyed()) this.window.setThumbarButtons([]);
    this.shownKey = '';
  }

  private readonly onThemeUpdated = (): void => {
    this.themeReported = true;
    this.darkTaskbar = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
    this.render();
  };

  private readonly render = (): void => {
    if (this.disposed || this.window.isDestroyed()) return;
    const buttons = this.status ? describeCallButtons(this.status) : [];
    const size = Math.round(SMALL_ICON_SIZE * screen.getPrimaryDisplay().scaleFactor);
    const neutral = this.darkTaskbar ? ON_DARK_TASKBAR : ON_LIGHT_TASKBAR;
    const key = buttons.length ? JSON.stringify({ buttons, size, neutral }) : '';
    // The status also follows who is speaking, which never changes the buttons.
    if (key === this.shownKey) return;
    this.shownKey = key;
    // Hiding the window in the tray drops its taskbar button and these buttons
    // with it; Electron adds the last set back when the button returns.
    this.window.setThumbarButtons(buttons.map((button) => ({
      icon: this.icon(button.glyph, button.danger ? DANGER : neutral, size),
      tooltip: button.tooltip,
      // Electron rejects the whole toolbar over a flag it does not know, the
      // default 'enabled' included, so only actual modifiers are listed.
      flags: button.disabled ? ['disabled'] : [],
      click: () => {
        sendEvent(windowContents(this.window), button.action);
      },
    })));
  };

  private icon(glyph: TaskbarGlyph, color: Rgb, size: number): NativeImage {
    const key = `${glyph}:${color.join(',')}:${size}`;
    let icon = this.icons.get(key);
    if (!icon) {
      // Windows draws the 1x bitmap it receives, so it is made at the exact pixel size.
      const mask = nativeImage.createFromDataURL(`data:image/png;base64,${TASKBAR_ICON_MASKS[glyph]}`)
        .resize({ width: size, height: size, quality: 'best' });
      icon = nativeImage.createFromBitmap(tintMask(mask.toBitmap(), color), { width: size, height: size });
      this.icons.set(key, icon);
    }
    return icon;
  }
}

/**
 * Whether the taskbar is dark. Electron only reads that after Windows reports
 * a theme change and answers with the apps' theme until then, but the two can
 * differ: a dark taskbar with light apps was Windows 10's default.
 */
function readDarkTaskbar(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', PERSONALIZE_KEY, '/v', 'SystemUsesLightTheme'], { windowsHide: true, timeout: 5_000 },
      (error, stdout) => {
        const value = error ? undefined : /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout)?.[1];
        resolve(value === undefined ? null : Number.parseInt(value, 16) === 0);
      });
  });
}
