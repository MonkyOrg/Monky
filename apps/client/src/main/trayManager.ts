import { BrowserWindow, Menu, NativeImage, nativeImage, Tray } from 'electron';
import path from 'path';
import { mt, type MainTranslationKey } from './i18n';

export interface VoiceStatus {
  inCall: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  /** Someone's screen share or an open miniapp. */
  isWatching: boolean;
  /** A soundboard sound of ours playing in the call. */
  isPlayingSound: boolean;
  /** Our camera or screen share is on. */
  isRecording: boolean;
}

/** Monkey pose drawn in the tray for each voice state (`build/tray/{pose}.*`). */
export type TrayPose = 'idle' | 'call' | 'talk' | 'mute' | 'deaf';

type InCallPose = Exclude<TrayPose, 'idle'> | 'call-mega' | 'talk-mega';

/**
 * Tray image (`build/tray/{icon}.*`): idle, or an in-call pose that may hold a
 * megaphone instead of the mic (`-mega`), wear 3D cinema glasses (`-3d`) and
 * have a REC frame (`-rec`).
 */
export type TrayIcon = 'idle' | `${InCallPose}${'' | '-3d'}${'' | '-rec'}`;

const TRAY_TOOLTIPS: Record<TrayPose, MainTranslationKey> = {
  idle: 'tray.tooltipIdle',
  call: 'tray.tooltipInCall',
  talk: 'tray.tooltipSpeaking',
  mute: 'tray.tooltipMuted',
  deaf: 'tray.tooltipDeafened',
};

/** Deafened wins over muted (deafening also silences the mic), and both win over speaking. */
export function trayPoseFor(status: VoiceStatus): TrayPose {
  if (!status.inCall) return 'idle';
  if (status.isDeafened) return 'deaf';
  if (status.isMuted) return 'mute';
  if (status.isSpeaking) return 'talk';
  return 'call';
}

/**
 * In a call the pose gains what is going on: a megaphone while our soundboard
 * plays (muted and deafened keep their hands on the mouth and ears), 3D glasses
 * while watching, and a REC frame while our camera or screen share is on.
 */
export function trayIconFor(status: VoiceStatus): TrayIcon {
  const pose = trayPoseFor(status);
  if (pose === 'idle') return pose;
  const base: InCallPose = status.isPlayingSound && (pose === 'call' || pose === 'talk') ? `${pose}-mega` : pose;
  return `${base}${status.isWatching ? '-3d' : ''}${status.isRecording ? '-rec' : ''}`;
}

const TRAY_ICON_DIR = path.join(__dirname, '../../build/tray');

/**
 * Windows asks for the exact small-icon size of the display scale (16px at
 * 100%, 24px at 150%, 32px at 200%...): from an .ico Electron loads that frame,
 * while a PNG would be one bitmap stretched to fit, and blurry. On macOS (and
 * Linux) Electron pairs `{icon}.png` (18px) with `{icon}@2x.png` (36px), so the
 * icon measures 18pt like the native menu-bar items and stays sharp on Retina.
 */
function loadTrayIcon(icon: TrayIcon): NativeImage {
  const file = path.join(TRAY_ICON_DIR, process.platform === 'win32' ? `${icon}.ico` : `${icon}.png`);
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) console.warn('[Tray] Could not load the tray icon:', file);
  return image;
}

export class TrayManager {
  private tray: Tray | null = null;
  private mainWindow: BrowserWindow;
  private onQuitApp: () => void;

  private voiceStatus: VoiceStatus = {
    inCall: false,
    isMuted: false,
    isDeafened: false,
    isSpeaking: false,
    isWatching: false,
    isPlayingSound: false,
    isRecording: false,
  };

  // Each image is loaded the first time it shows and then kept, so switching poses while speaking
  // only swaps already-decoded images, without loading every combination up front.
  private readonly icons = new Map<TrayIcon, NativeImage>();

  constructor(mainWindow: BrowserWindow, onQuitApp: () => void) {
    this.mainWindow = mainWindow;
    this.onQuitApp = onQuitApp;
    this.createTray();
  }

  private icon(icon: TrayIcon): NativeImage {
    let image = this.icons.get(icon);
    if (!image) {
      image = loadTrayIcon(icon);
      this.icons.set(icon, image);
    }
    return image;
  }

  private createTray(): void {
    this.tray = new Tray(this.icon('idle'));
    this.tray.setToolTip('Monky');

    // Single click / double click to restore window
    this.tray.on('click', () => {
      this.showWindow();
    });
    this.tray.on('double-click', () => {
      this.showWindow();
    });

    this.updateTray();
  }

  public showWindow(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore();
    }
    if (!this.mainWindow.isVisible()) {
      this.mainWindow.show();
    }
    this.mainWindow.focus();
  }

  public updateVoiceStatus(status: VoiceStatus): void {
    this.voiceStatus = { ...status };
    this.updateTray();
  }

  /**
   * Rebuilds the tooltip and context menu. The tray labels are built once per
   * update, so switching languages has to trigger a redraw explicitly (#16).
   */
  public refresh(): void {
    this.updateTray();
  }

  private updateTray(): void {
    if (!this.tray || this.tray.isDestroyed()) return;

    // 1. Pose and tooltip for the current voice state
    this.tray.setImage(this.icon(trayIconFor(this.voiceStatus)));
    this.tray.setToolTip(mt(TRAY_TOOLTIPS[trayPoseFor(this.voiceStatus)]));

    // 2. Build context menu
    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
      {
        label: mt('tray.open'),
        click: () => this.showWindow(),
      },
    ];

    if (this.voiceStatus.inCall) {
      menuTemplate.push({ type: 'separator' });

      // Mute / Unmute Microphone
      const isMuted = this.voiceStatus.isMuted;
      menuTemplate.push({
        label: isMuted ? mt('tray.unmuteMic') : mt('tray.muteMic'),
        click: () => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('tray:toggle-mute');
          }
        },
      });

      // Deafen / Undeafen Audio (mutes both audio & mic, same as app behavior)
      const isDeafened = this.voiceStatus.isDeafened;
      menuTemplate.push({
        label: isDeafened ? mt('tray.undeafen') : mt('tray.deafen'),
        click: () => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('tray:toggle-deafen');
          }
        },
      });
    }

    menuTemplate.push({ type: 'separator' });
    menuTemplate.push({
      label: mt('tray.quit'),
      click: () => {
        this.onQuitApp();
      },
    });

    const contextMenu = Menu.buildFromTemplate(menuTemplate);
    this.tray.setContextMenu(contextMenu);
  }

  public destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
