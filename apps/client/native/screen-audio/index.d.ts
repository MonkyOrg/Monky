export interface ScreenAudioOptions {
  excludePid?: number;
  /**
   * Capture only the audio of the application owning this window.
   * On Windows it is the HWND (resolved to a process tree); on macOS it is the
   * CGWindowID (used as a ScreenCaptureKit window filter).
   */
  includeWindowId?: number;
  sampleRate?: number;
  channels?: number;
}

export interface StartResult {
  success: boolean;
  error?: string;
}

export interface StopResult {
  success: boolean;
}

export function isSupported(): boolean;

export function start(
  options: ScreenAudioOptions,
  callback: (buffer: Buffer) => void
): StartResult;

export function stop(): StopResult;

/** Returns the last error message from the capture thread (empty if none). */
export function getLastError(): string;

/** Returns the capture status: 0=idle, 1=starting, 2=capturing, 3=error */
export function getStatus(): number;

export interface WindowOwner {
  /** CGWindowID, matching the numeric part of Electron's `window:<id>:<n>` source id. */
  windowId: number;
  pid: number;
  /** Absolute path to the owning `.app` bundle. */
  bundlePath: string;
  appName: string;
}

/**
 * Lists visible windows with the application that owns them. Only implemented on
 * macOS, where Electron leaves `desktopCapturer`'s `appIcon` empty (#455); other
 * platforms return an empty array.
 */
export function listWindowOwners(): WindowOwner[];

export interface NativeWindowInfo {
  /** Decimal window handle, matching the numeric part of `window:<id>:<n>`. */
  hwnd: number;
  title: string;
  processId: number;
  /** Absolute path to the owning process image, for icon extraction. */
  processPath: string;
  /** Whether the window is currently minimized. */
  isIconic: boolean;
  isVisible: boolean;
  /** DWM cloaked window (hidden virtual-desktop/UWP shell windows). */
  isCloaked: boolean;
  isToolWindow: boolean;
  isLayered: boolean;
  isTransparent: boolean;
  isNoActivate: boolean;
  isAppWindow: boolean;
  /** Restored (non-minimized) width/height in pixels. */
  width: number;
  height: number;
}

/**
 * Lists top-level windows with their raw Win32 attributes. Only implemented on
 * Windows, where the WGC capturer both leaks overlay/tool windows and omits
 * minimized ones (#560); other platforms return an empty array.
 */
export function listWindows(): NativeWindowInfo[];

/**
 * Restores (un-minimizes) and foregrounds a window by handle so a capture can
 * start on it — the WGC capturer cannot start on a minimized window (#560).
 * Returns `true` when it actually un-minimized the window; only implemented on
 * Windows, returns `false` elsewhere.
 */
export function restoreWindow(hwnd: number): boolean;

export interface KeyboardLayoutSnapshot {
  id: string;
  scanCodeToVirtualKey: Record<string, number>;
  /** VkKeyScanEx: low byte VK, high byte Shift/Ctrl/Alt requirements. */
  characterToVirtualKey: Record<string, number>;
}

/** Windows foreground-thread layout; null if unchanged or native support is unavailable. */
export function getKeyboardLayout(previousId?: string, characters?: string): KeyboardLayoutSnapshot | null;
