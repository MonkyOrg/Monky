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

/** Windows UI-thread only. A zero ratio removes the constraint; destruction also removes it. Dimensions are DIPs. */
export function setWindowResizeAspect(handle: Buffer, ratio: number, extraWidth: number, extraHeight: number): void;

export interface PacketCaptureOptions {
  /** Defaults to the host PID. Packet mode rejects another PID to prevent feedback. */
  excludePid?: number;
  /** Positive HWND; invalid/changed/self-tree targets fail, never fall back to global capture. */
  includeWindowId?: number;
  /** When a window was resolved by Main, reject reuse by another process. */
  expectedProcessId?: number;
}

export function isPacketCaptureSupported(): boolean;

export interface PacketCaptureFormat {
  encoding: 'float32-interleaved';
  /** Original WASAPI mix rate and every original channel; no resampling/downmix. */
  sampleRate: number;
  channels: number;
  channelMask: number | null;
  sourceBitsPerSample: number;
  sourceValidBitsPerSample: number;
}

export interface PacketCaptureError extends Error { code: string; }

export interface PacketCaptureSnapshot {
  sessionId: string | null;
  state: 'starting' | 'capturing' | 'closed' | 'failed';
  format: PacketCaptureFormat | null;
  capturedPackets: number;
  capturedFrames: number;
  deliveredPackets: number;
  /** Queued callbacks plus packets awaiting asynchronous consumer admission. */
  queuedPackets: number;
  overflowCount: number;
  maxQueuedPackets: number;
  maxPacketBytes: number;
  error: PacketCaptureError | null;
}

export interface AudioCapturePacket {
  type: 'packet';
  sessionId: string;
  format: PacketCaptureFormat;
  /** Owned Node Buffer containing little-endian float32 interleaved PCM. */
  pcm: Buffer;
  frames: number;
  /** Zero-based acquired packet and frame indices (including SILENT packets). */
  sequence: number;
  frameIndex: number;
  /** Unique session:generation; changes at gaps/resets and device-counter/QPC validity transitions. */
  epoch: string;
  /**
   * Optional first-frame stream/device position. This process-loopback capture
   * does not request it: null independently of valid QPC, never frameIndex.
   * TIMESTAMP_ERROR also invalidates any supplied device position.
   */
  devicePosition: number | null;
  /** Original WASAPI QPC100ns / 10, floored; null only with TIMESTAMP_ERROR, independent of devicePosition. */
  qpcTimestampUs: number | null;
  flags: { raw: number; silent: boolean; dataDiscontinuity: boolean; timestampError: boolean };
}

export type PacketCaptureEvent =
  | { type: 'ready'; sessionId: string; format: PacketCaptureFormat }
  | AudioCapturePacket
  | { type: 'error'; error: PacketCaptureError }
  | { type: 'closed'; snapshot: PacketCaptureSnapshot };

export interface PacketCaptureSession {
  /** Resolves only after actual WASAPI Start; rejects on startup failure/cancellation. */
  readonly ready: Promise<PacketCaptureSnapshot>;
  /** Resolves after native acquisition/TSFN drain; cancels admission waits, not RTC processing. */
  readonly closed: Promise<PacketCaptureSnapshot>;
  /** Idempotent, nonblocking; same promise as closed. Does not stop a legacy session. */
  stop(): Promise<PacketCaptureSnapshot>;
  snapshot(): PacketCaptureSnapshot;
  getStats(): PacketCaptureSnapshot;
}

/**
 * Explicit opt-in, exclusive with start(). Windows only; never invokes the
 * legacy resampler, microphone processing, platform ADM or output playback.
 * At most 32 PCM delivery/admission credits of at most 1 MiB each. A packet
 * callback may return a Promise<void> to retain its credit until admission/copy,
 * not native processing retirement. Synchronous return releases it immediately;
 * rejected acknowledgement fails with ERR_AUDIO_CALLBACK. Only packet events
 * use these acknowledgements; ready/error/closed delivery remains independent.
 * A full budget waits up to 500 ms, cancellable by Stop/cleanup, before failing
 * with ERR_AUDIO_OVERFLOW. Invalid options throw; startup/runtime failures emit
 * error then closed (startup also rejects ready). Call stop() or await closed.
 */
export function createPacketCapture(
  options: PacketCaptureOptions,
  onEvent: (event: PacketCaptureEvent) => void | Promise<void>
): PacketCaptureSession;

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
  /** Exact Win32 creation FILETIME, or null when process identity cannot be inspected. */
  processCreationTime100ns: string | null;
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

export interface NativeMonitorInfo {
  /** Win32 monitor device interface path (not an ordinal or Electron display ID). */
  deviceId: string;
  deviceName: string;
  name: string;
  /** Physical desktop pixels, including negative coordinates for secondary displays. */
  bounds: { x: number; y: number; width: number; height: number };
  isPrimary: boolean;
}

/** Metadata-only Windows enumeration. Throws if native identity inspection is unavailable. */
export function listMonitors(): NativeMonitorInfo[];
/** Returns null after disconnect. Changes of bounds/deviceName require explicit reselection. */
export function getMonitorState(deviceId: string): NativeMonitorInfo | null;

/**
 * Lists top-level windows with their raw Win32 attributes. Only implemented on
 * Windows, where the WGC capturer both leaks overlay/tool windows and omits
 * minimized ones (#560); other platforms return an empty array.
 */
export function listWindows(): NativeWindowInfo[];

export interface NativeWindowState {
  processId: number;
  processCreationTime100ns: string;
  isVisible: boolean;
  isIconic: boolean;
  isTopLevel: boolean;
}

/** Inspects the exact HWND even while hidden/minimized. Null means it is gone; inspection failures throw. */
export function getWindowState(hwnd: number): NativeWindowState | null;

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
