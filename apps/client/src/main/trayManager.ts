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
}

/** Monkey pose drawn in the tray for each voice state (`build/tray/{pose}.*`). */
export type TrayPose = 'idle' | 'call' | 'talk' | 'mute' | 'deaf';

/** Tray image: a pose, or an in-call pose wearing 3D cinema glasses (`build/tray/{pose}-3d.*`). */
export type TrayIcon = TrayPose | `${Exclude<TrayPose, 'idle'>}-3d`;

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

/** While watching, the monkey keeps the pose and puts on 3D glasses. Watching only happens in a call. */
export function trayIconFor(status: VoiceStatus): TrayIcon {
  const pose = trayPoseFor(status);
  return pose !== 'idle' && status.isWatching ? `${pose}-3d` : pose;
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
  };

  // Loaded once: switching poses while speaking only swaps already-decoded images.
  private readonly icons: Record<TrayIcon, NativeImage>;

  constructor(mainWindow: BrowserWindow, onQuitApp: () => void) {
    this.mainWindow = mainWindow;
    this.onQuitApp = onQuitApp;
    this.icons = {
      idle: loadTrayIcon('idle'),
      call: loadTrayIcon('call'),
      talk: loadTrayIcon('talk'),
      mute: loadTrayIcon('mute'),
      deaf: loadTrayIcon('deaf'),
      'call-3d': loadTrayIcon('call-3d'),
      'talk-3d': loadTrayIcon('talk-3d'),
      'mute-3d': loadTrayIcon('mute-3d'),
      'deaf-3d': loadTrayIcon('deaf-3d'),
    };
    this.createTray();
  }

  private createTray(): void {
    this.tray = new Tray(this.icons.idle);
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
    this.tray.setImage(this.icons[trayIconFor(this.voiceStatus)]);
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
