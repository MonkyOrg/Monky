/**
 * Contrato de Tipagem Unificado para IPC (Inter-Process Communication)
 * Define as mensagens e eventos trafegados entre o Main Process e o Renderer Process.
 */

import type { ClientLogConfig, ClientLogEntry, LogEntry } from './logging.js';
import type { DevelopmentQaConfig, DevelopmentQaReport } from './developmentQa.js';
import type { SoundDownloadFailureReason, SoundDownloadRequest, SoundDownloadResult } from './soundDownloads.js';
import type { CommandAudioPreviewFailureReason, CommandAudioPreviewMimeType } from './botInteractions.js';
import type { ReleaseCompatibilityResult } from './releaseCompatibility.js';
import type { ServerInviteResult } from './serverInvites.js';
import type { NativeScreenCommand, NativeScreenCommandResult, NativeScreenEvent, NativeScreenReply } from './nativeScreenIpc.js';
import type {
  LocalExecutionMutationResult,
  LocalExecutionSnapshot,
  LocalPermissionChange,
  LocalToolId,
  LocalPreparationInput,
  LocalPreparationResult,
  LocalTaskStartInput,
  LocalTaskStartResult,
  LocalFrameReadInput,
  LocalFrameReadResult,
  LocalFrameProgress,
  LocalRequestCancellation,
  LocalTaskPause,
  LocalConnectionState,
  LocalTaskFailureEvent,
} from './localExecution.js';

export interface RendererBootstrapFailure {
  phase: 'constructor' | 'initialization';
  errorName: string;
  /** Only sanitized app source locations survive validation in Main. */
  stack?: string;
}

export const DEVELOPMENT_QA_IPC = {
  config: 'development-qa:config',
  report: 'development-qa:report',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

export const SERVER_INVITE_IPC = {
  take: 'server-invite:take',
} as const satisfies Record<string, keyof IpcInvokeChannels>;
export const SERVER_INVITE_AVAILABLE = 'server-invite:available' satisfies keyof IpcEvents;

export type CrashRecoveryActionResult =
  | { ok: true; copied?: boolean }
  | { ok: false; reason: 'unavailable' | 'open-failed' | 'copy-failed' | 'restart-failed'; copied?: boolean };

export const CRASH_RECOVERY_IPC = {
  bootstrapFailed: 'crash-recovery:bootstrap-failed',
  ready: 'crash-recovery:ready',
  report: 'crash-recovery:report',
  copy: 'crash-recovery:copy',
  reopen: 'crash-recovery:reopen',
  close: 'crash-recovery:close',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

export interface DesktopSource {
  id: string;
  name: string;
  type: 'screen' | 'window';
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
}

export interface ImageSelectionResult {
  fileName: string;
  mimeType: string;
  base64: string;
}

export interface SoundboardSoundEntry {
  name: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  ext: string;
}

export interface SoundboardSoundData {
  fileName: string;
  soundName: string;
  mimeType: string;
  base64: string;
  dataUrl: string;
  sizeBytes: number;
}

export interface SoundboardDownloadKey {
  connectionId: string;
  invocationId: string;
  downloadId: string;
}

export interface SoundboardDownloadAuthorization {
  connectionId: string;
  invocationId: string;
  configuredFolder: string;
  expiresAt: number;
}

export type SoundboardDownloadAvailability = 'ready' | 'no_folder' | 'confirmation_required' | 'unavailable';

export type SoundboardDownloadPermit =
  | { status: 'authorized'; token: string }
  | { status: 'failed'; reason: 'no_folder' | 'invalid_request' | 'write_failed' };

export interface SoundboardDownloadInput extends SoundboardDownloadKey, SoundDownloadRequest {
  token: string;
  expiresAt: number;
}

export interface SoundboardDownloadProgress extends SoundboardDownloadKey {
  receivedBytes: number;
  totalBytes?: number;
}

export type SoundboardDownloadCancellation = Omit<SoundboardDownloadKey, 'downloadId'> & { downloadId?: string };

export const SOUND_DOWNLOAD_IPC = {
  defaultFolder: 'soundboard:default-folder',
  availability: 'soundboard:download-availability',
  confirmFolder: 'soundboard:confirm-download-folder',
  authorize: 'soundboard:authorize-download',
  download: 'soundboard:download-sound',
  cancel: 'soundboard:cancel-download',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

export const SOUND_DOWNLOAD_PROGRESS = 'soundboard:download-progress' satisfies keyof IpcEvents;

export type AudioPreviewInput = {
  requestId: string;
  fileName?: string;
} & (
  | { url: string; audioBase64?: never; mimeType?: never }
  | { audioBase64: string; mimeType: CommandAudioPreviewMimeType; url?: never }
);

export interface AudioPreviewCancellation {
  requestId: string;
}

export type AudioPreviewFailureReason = SoundDownloadFailureReason | CommandAudioPreviewFailureReason;

export type AudioPreviewResult =
  | { status: 'ready'; data: Uint8Array; mimeType: string }
  | { status: 'cancelled' }
  | { status: 'failed'; reason: AudioPreviewFailureReason };

export const AUDIO_PREVIEW_IPC = {
  load: 'audio-preview:load',
  cancel: 'audio-preview:cancel',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

export const LOCAL_EXECUTION_IPC = {
  getState: 'local-execution:get-state',
  setPermission: 'local-execution:set-permission',
  removeTool: 'local-execution:remove-tool',
  clearCache: 'local-execution:clear-cache',
  cancelTask: 'local-execution:cancel-task',
  prepare: 'local-execution:prepare',
  startTask: 'local-execution:start-task',
  readFrames: 'local-execution:read-frames',
  acknowledgeFrames: 'local-execution:acknowledge-frames',
  cancelRequest: 'local-execution:cancel-request',
  setPaused: 'local-execution:set-paused',
  setConnection: 'local-execution:set-connection',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

export const LOCAL_EXECUTION_CHANGED = 'local-execution:changed' satisfies keyof IpcEvents;
export const LOCAL_EXECUTION_TASK_FAILED = 'local-execution:task-failed' satisfies keyof IpcEvents;

export type LocalPreparationDialogAction = 'deny' | 'connection' | 'always' | 'confirm' | 'retry' | 'cancel' | 'close';

export interface LocalPreparationDialogState {
  phase: 'consent' | 'installing' | 'cancelling' | 'failed' | 'complete';
  title: string;
  status: string;
  detail: string;
  storage: string;
  progress: number | null;
  tools: Array<{
    id: LocalToolId;
    status: string;
    size: string;
    ready: boolean;
    active: boolean;
  }>;
}

export const LOCAL_PREPARATION_DIALOG_IPC = {
  state: 'local-preparation-dialog:state',
  action: 'local-preparation-dialog:action',
} as const satisfies Record<string, keyof IpcInvokeChannels>;
export const LOCAL_PREPARATION_DIALOG_CHANGED = 'local-preparation-dialog:changed' satisfies keyof IpcEvents;

/** One custom sticker image found in the user's stickers folder (#356). */
export interface StickerEntry {
  name: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  ext: string;
  mimeType: string;
  /**
   * True when the file is above the size the picker is willing to decode. It is
   * still listed (dimmed, with an explanation) instead of vanishing silently,
   * which is what made a large GIF look like it had simply been ignored.
   */
  tooLarge?: boolean;
}

/**
 * The bytes of a single sticker. Read on demand (when a tile scrolls into view
 * or the sticker is sent) so a large folder never loads entirely into memory.
 */
export interface StickerData {
  fileName: string;
  mimeType: string;
  dataUrl: string;
  sizeBytes: number;
}

/**
 * Outcome of saving a sticker somebody else sent into the local folder. The
 * failure reason is a code (not a message) so the renderer owns the wording and
 * keeps it translatable.
 */
export interface StickerSaveResult {
  ok: boolean;
  fileName?: string;
  reason?: 'no-folder' | 'bad-extension' | 'too-large' | 'write-failed';
}

export interface SoundboardShortcutBinding {
  soundName: string;
  /** Legacy accelerator or "+"-joined physical code tokens (e.g. Ctrl+code:KeyQ+code:KeyW). */
  accelerator: string;
}

export interface ActionShortcutBinding {
  action: string;
  /** Same local chord encoding as SoundboardShortcutBinding; never sent over WebSocket. */
  accelerator: string;
}

export const SHORTCUT_IPC = {
  registerActions: 'shortcuts:register-actions',
  registerSoundboard: 'soundboard:register-shortcuts',
  setCapture: 'shortcuts:set-capture',
  setPttConfig: 'ptt:set-config',
  startPttCapture: 'ptt:start-capture',
  stopPttCapture: 'ptt:stop-capture',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

export interface PttKeyBinding {
  code: string;
  display: string;
  keyType: 'keyboard' | 'mouse';
  keyCode?: number;
  mouseButton?: number;
}

export interface PttConfig {
  enabled: boolean;
  key: PttKeyBinding | null;
}

export interface LinkPreviewData {
  url: string;
  title: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
  embedType?: 'youtube' | 'spotify';
  embedUrl?: string;
}

export interface ServerProbeResult {
  reachable: boolean;
  reason: 'online' | 'refused' | 'timeout' | 'unreachable';
}

export interface ScreenAudioDiagnostics {
  nativeModuleLoaded: boolean;
  platformSupported: boolean;
  osVersion: string;
  pid: number;
  captureStatus?: number;
  lastError?: string;
}

export interface TrayVoiceStatus {
  inCall: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
}

export interface UpdateCheckResult {
  ok: boolean;
  available?: boolean;
  version?: string;
  error?: string;
  compatibility?: ReleaseCompatibilityResult;
}

export const UPDATER_IPC = {
  setChannel: 'updater:set-channel',
  check: 'updater:check',
  download: 'updater:download',
  install: 'updater:install',
  outcome: 'updater:outcome',
  releaseNotes: 'updater:release-notes',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

export interface UpdateSimpleResult {
  ok: boolean;
  error?: string;
}

/**
 * Result of the update install that ran between two launches (#498). Reported
 * once, on the first launch after the installer took over.
 */
export type UpdateOutcome =
  | { status: 'success'; version: string; fromVersion: string }
  | { status: 'failed'; version: string };

/**
 * Release notes for a version, fetched from the GitHub Releases API so the
 * client can show an in-app changelog after updating and on demand (#547).
 */
export interface ReleaseNotesResult {
  ok: boolean;
  /** Clean version the notes belong to (e.g. "8.2.8" or "8.2.8-beta"). */
  version?: string;
  /** Raw markdown body of the GitHub release. */
  body?: string;
  /** URL of the release page, for a "view on GitHub" link. */
  url?: string;
  error?: string;
}

export interface DiscoveredLanServer {
  host: string;
  port: number;
  serverName: string;
  version: string;
}

export interface HostServerOptions {
  port: number;
  serverName: string;
  password?: string;
  initialVoiceChannel?: string;
  initialTextChannel?: string;
  /** Id of the entry in "Meus Servidores" that owns this instance (#333). */
  serverId?: string;
  /**
   * Member cap chosen when the server was created (#403). Only applies on the
   * very first boot, when the database is seeded; restarts ignore it.
   */
  maxUsers?: number;
  /**
   * Voice mode ('p2p' | 'sfu') chosen when the server was created (#515).
   */
  voiceMode?: 'p2p' | 'sfu';
}

/**
 * Snapshot of a locally hosted server, shown to whoever is running it.
 * Deliberately cheap to produce: it is polled by the UI.
 */
export interface ServerStats {
  serverName: string;
  port: number;
  dataDir: string;
  /** Epoch ms of the last successful start, or null when stopped. */
  startedAt: number | null;
  uptimeMs: number;
  /** People currently connected, not sessions — one person may use several devices. */
  onlineUsers: number;
  maxUsers: number;
  members: number;
  channels: number;
  messages: number;
}

export interface AppIdentityResult {
  publicKey: string;
  clientId: string;
}

/**
 * Import result. `extras` carries the opaque servers/settings backup that may
 * have been exported alongside the identity (#472); only the renderer knows how
 * to read it.
 */
export interface AppIdentityImportResult extends AppIdentityResult {
  extras?: string;
}

export interface BackupSaveResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

export interface BackupOpenResult {
  success: boolean;
  contents?: string;
  error?: string;
}

/** Result of sealing a backup with the user's password (#472). */
export interface BackupCryptoResult {
  success: boolean;
  payload?: string;
  contents?: string;
  error?: string;
}

export interface OverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OverlayMode = 'cameras-only' | 'cameras-and-screens';
export type OverlayLayout = 'grid' | 'vertical' | 'horizontal';
export type OverlayPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'custom';

export interface OverlayConfig {
  mode: OverlayMode;
  layout: OverlayLayout;
  position: OverlayPosition;
  cardOpacity: number; // 0.2 a 1.0
  focusActiveSpeaker: boolean;
  autoOpenOnLeaveStage?: boolean;
  minimalistMode?: boolean;
  hideSelf?: boolean;
  bounds?: OverlayBounds;
}

export interface OverlayParticipantState {
  sessionId: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  isSpeaking: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  serverMuted?: boolean;
  serverDeafened?: boolean;
  isCameraOn: boolean;
  screenShareIds: string[];
  isLocal: boolean;
  videoSlotIndex?: number;
  screenSlotIndexes?: Record<string, number>;
}

export interface OverlaySyncState {
  channelId: string | null;
  channelName: string;
  participants: OverlayParticipantState[];
  activeSpeakerSessionId: string | null;
  config: OverlayConfig;
}

export interface OverlaySignalPayload {
  target: 'main' | 'overlay';
  signal: string; // JSON com Offer/Answer/Candidate
}

export interface NativeScreenAudioOutputConfig {
  epoch: number;
  sinkId: string;
  sampleRate: 48000;
  channels: 2;
}

export interface NativeScreenAudioClockProbeRequest {
  epoch: number;
  probeId: number;
}

export interface NativeScreenAudioClockProbe extends NativeScreenAudioClockProbeRequest {
  rtcBeforeUs: number;
  rtcAfterUs: number;
}

export interface NativeScreenAudioCalibrationRequest extends NativeScreenAudioClockProbeRequest {
  rendererBeforeUs: number;
  rendererAfterUs: number;
}

export interface NativeScreenAudioCalibration {
  epoch: number;
  calibrationId: number;
  offsetUs: number;
  uncertaintyUs: number;
}

export type NativeScreenAudioFeedback =
  | { epoch: number; available: false }
  | {
    epoch: number;
    available: true;
    clockEpoch: number;
    calibrationId: number;
    atPerformanceTimeUs: number;
    estimatedPlayoutFrame: number;
    confirmedPcmEnd: number;
    feedbackAgeUs: number;
    outputClockAgeUs: number;
  };

export interface NativeScreenAudioCredits {
  epoch: number;
  grantSequence: number;
  frames: 480 | 960;
}

export interface NativeScreenAudioPcmPacket {
  epoch: number;
  sequence: number;
  firstPlayoutFrame: number;
  frames: 480;
  sampleRate: 48000;
  channels: 2;
  samples: Float32Array;
}

export interface NativeScreenAudioError {
  code: string;
  message: string;
}

export interface NativeScreenAudioRpc {
  configure: {
    request: NativeScreenAudioOutputConfig;
    result: Omit<NativeScreenAudioOutputConfig, 'sinkId'>;
  };
  probe: {
    request: NativeScreenAudioClockProbeRequest;
    result: NativeScreenAudioClockProbe;
  };
  calibrate: {
    request: NativeScreenAudioCalibrationRequest;
    result: NativeScreenAudioCalibration;
  };
  stop: {
    request: { epoch: number };
    result: { epoch: number; stopped: true };
  };
}

export interface NativeScreenAudioPortEvents {
  ready: NativeScreenAudioOutputConfig;
  disposed: NativeScreenAudioRpc['stop']['result'];
  pcm: NativeScreenAudioPcmPacket;
  credits: NativeScreenAudioCredits;
  feedback: NativeScreenAudioFeedback;
  error: NativeScreenAudioError;
}

export interface NativeScreenAudioPortScope {
  portId: string;
  epoch: number;
}

export interface NativeScreenAudioPortInfo {
  version: 1;
  sessionId: string;
  portId: string;
  output: NativeScreenAudioOutputConfig;
}

export type NativeScreenAudioRequest = {
  [Method in keyof NativeScreenAudioRpc]: {
    type: 'request';
    id: number;
    method: Method;
    data: NativeScreenAudioRpc[Method]['request'];
  };
}[keyof NativeScreenAudioRpc] & NativeScreenAudioPortScope;

export type NativeScreenAudioResponse = {
  [Method in keyof NativeScreenAudioRpc]: {
    type: 'response';
    id: number;
    method: Method;
  } & (
    | { ok: true; data: NativeScreenAudioRpc[Method]['result'] }
    | { ok: false; error: NativeScreenAudioError }
  );
}[keyof NativeScreenAudioRpc] & NativeScreenAudioPortScope;

export type NativeScreenAudioPortEvent = {
  [Event in keyof NativeScreenAudioPortEvents]: {
    type: 'event';
    event: Event;
    data: NativeScreenAudioPortEvents[Event];
  };
}[keyof NativeScreenAudioPortEvents] & NativeScreenAudioPortScope;

export type NativeScreenAudioPortMessage =
  | NativeScreenAudioRequest
  | NativeScreenAudioResponse
  | NativeScreenAudioPortEvent;

// These channels transfer one private MessagePort, not a renderer-facing invoke API.
export interface IpcPortEvents {
  'native-screen:audio-output-port': NativeScreenAudioPortInfo;
  'native-screen:preview-port': import('./nativeScreenIpc.js').NativeScreenPreviewInfo;
}

export const NATIVE_SCREEN_PREVIEW_IPC = {
  port: 'native-screen:preview-port',
} as const satisfies Record<string, keyof IpcPortEvents>;

export const NATIVE_SCREEN_AUDIO_IPC = {
  outputPort: 'native-screen:audio-output-port',
} as const satisfies Record<string, keyof IpcPortEvents>;

export const NATIVE_SCREEN_IPC = {
  invoke: 'native-screen:invoke',
  reply: 'native-screen:reply',
} as const satisfies Record<string, keyof IpcInvokeChannels>;
export const NATIVE_SCREEN_EVENT = 'native-screen:event' satisfies keyof IpcEvents;

/**
 * Mapeamento de Canais Bidirecionais (Invoke / Handle)
 */
export interface IpcInvokeChannels {
  'native-screen:invoke': { args: [command: NativeScreenCommand]; returnType: NativeScreenCommandResult };
  'native-screen:reply': { args: [reply: NativeScreenReply]; returnType: void };
  'server-invite:take': { args: []; returnType: ServerInviteResult | null };
  'development-qa:config': { args: []; returnType: DevelopmentQaConfig | null };
  'development-qa:report': { args: [report: DevelopmentQaReport]; returnType: boolean };
  // Local fatal-failure recovery, not a client/server protocol change (#454).
  'crash-recovery:bootstrap-failed': { args: [failure: RendererBootstrapFailure]; returnType: boolean };
  'crash-recovery:ready': { args: []; returnType: boolean };
  'crash-recovery:report': { args: []; returnType: CrashRecoveryActionResult };
  'crash-recovery:copy': { args: []; returnType: CrashRecoveryActionResult };
  'crash-recovery:reopen': { args: []; returnType: CrashRecoveryActionResult };
  'crash-recovery:close': { args: []; returnType: boolean };
  // Janela
  'window:minimize': { args: []; returnType: void };
  'window:maximize': { args: []; returnType: void };
  'window:toggle-maximize': { args: []; returnType: void };
  'window:set-in-server': { args: [inServer: boolean]; returnType: void };
  'window:fit-home-content': { args: [contentHeight: number]; returnType: void };
  'window:close': { args: []; returnType: void };

  // Sobreposição de Tela (Overlay) (#169)
  'overlay:open': { args: [config: OverlayConfig]; returnType: { success: boolean } };
  'overlay:close': { args: []; returnType: { success: boolean } };
  'overlay:is-open': { args: []; returnType: boolean };
  'overlay:get-config': { args: []; returnType: OverlayConfig | null };
  'overlay:set-config': { args: [config: Partial<OverlayConfig>]; returnType: void };
  'overlay:save-bounds': { args: [bounds: OverlayBounds]; returnType: void };
  'overlay:reset-bounds': { args: []; returnType: void };
  'overlay:send-signal': { args: [payload: OverlaySignalPayload]; returnType: void };
  'overlay:send-sync-state': { args: [state: OverlaySyncState]; returnType: void };

  // Sistema / App
  'app:set-language': { args: [language: string]; returnType: void };
  'app:get-version': { args: []; returnType: string };
  'app:open-external': { args: [url: string]; returnType: { success: boolean } };
  'app:get-auto-start': { args: []; returnType: boolean };
  'app:set-auto-start': { args: [enabled: boolean]; returnType: void };
  'app:set-minimize-to-tray': { args: [enabled: boolean]; returnType: void };
  'app:download-file': { args: [url: string, fileName: string]; returnType: { success: boolean; error?: string } };
  // Ack do renderer ao 'app:before-quit': confirma que ja saiu das chamadas (#458)
  'app:leave-complete': { args: []; returnType: void };

  // Identidade
  'identity:has': { args: []; returnType: boolean };
  'identity:get': { args: []; returnType: AppIdentityResult };
  'identity:get-client-id': { args: []; returnType: string };
  'identity:sign-challenge': { args: [nonceHex: string]; returnType: string };
  'identity:export': { args: [password: string, extras?: string]; returnType: string };
  'identity:import': { args: [exportedIdentity: string, password: string]; returnType: AppIdentityImportResult };

  // Backup de servidores salvos e configuracoes (#472)
  'backup:save-file': { args: [contents: string, suggestedName: string]; returnType: BackupSaveResult };
  'backup:open-file': { args: []; returnType: BackupOpenResult };
  'backup:encrypt': { args: [contents: string, password: string]; returnType: BackupCryptoResult };
  'backup:decrypt': { args: [payload: string, password: string]; returnType: BackupCryptoResult };

  // Servidor Local
  'server-host:start': { args: [options: HostServerOptions]; returnType: { success: boolean; error?: string } };
  'server-host:stop': { args: []; returnType: { success: boolean } };
  'server-host:status': { args: []; returnType: { isRunning: boolean; port: number | null; serverId: string | null } };
  'server-host:logs': { args: []; returnType: LogEntry[] };
  'server-host:clear-logs': { args: []; returnType: void };
  'server-host:stats': { args: []; returnType: ServerStats | null };
  'server-host:delete-data': { args: [serverId: string]; returnType: { success: boolean; error?: string } };

  // LAN Discovery
  'lan:start': { args: []; returnType: void };
  'lan:stop': { args: []; returnType: void };

  // Captura de Tela
  'screen-share:ensure-permission': { args: []; returnType: boolean };
  'screen-share:get-sources': { args: []; returnType: DesktopSource[] };
  'screen-share:prepare-window': { args: [string]; returnType: boolean };

  // Diálogos Nativos
  'dialog:select-image': { args: []; returnType: ImageSelectionResult | null };
  'dialog:select-sound-file': { args: []; returnType: string | null };
  'dialog:select-soundboard-folder': { args: []; returnType: string | null };
  'dialog:select-stickers-folder': { args: []; returnType: string | null };

  // Soundboard
  'soundboard:default-folder': { args: []; returnType: string | null };
  'soundboard:list-sounds': { args: [folderPath: string]; returnType: SoundboardSoundEntry[] };
  'soundboard:read-sound': { args: [filePath: string]; returnType: SoundboardSoundData | null };
  'soundboard:download-availability': { args: [configuredFolder: string]; returnType: SoundboardDownloadAvailability };
  'soundboard:confirm-download-folder': { args: [configuredFolder: string]; returnType: boolean };
  'soundboard:authorize-download': { args: [input: SoundboardDownloadAuthorization]; returnType: SoundboardDownloadPermit };
  'soundboard:download-sound': { args: [input: SoundboardDownloadInput]; returnType: SoundDownloadResult };
  'soundboard:cancel-download': { args: [key: SoundboardDownloadCancellation]; returnType: boolean };
  'audio-preview:load': { args: [input: AudioPreviewInput]; returnType: AudioPreviewResult };
  'audio-preview:cancel': { args: [input: AudioPreviewCancellation]; returnType: boolean };
  'soundboard:register-shortcuts': { args: [shortcuts: SoundboardShortcutBinding[]]; returnType: boolean };

  'local-execution:get-state': { args: []; returnType: LocalExecutionSnapshot };
  'local-execution:set-permission': { args: [input: LocalPermissionChange]; returnType: LocalExecutionMutationResult };
  'local-execution:remove-tool': { args: [tool: LocalToolId]; returnType: LocalExecutionMutationResult };
  'local-execution:clear-cache': { args: []; returnType: LocalExecutionMutationResult };
  'local-execution:cancel-task': { args: [taskId: string]; returnType: LocalExecutionMutationResult };
  'local-execution:prepare': { args: [input: LocalPreparationInput]; returnType: LocalPreparationResult };
  'local-execution:start-task': { args: [input: LocalTaskStartInput]; returnType: LocalTaskStartResult };
  'local-execution:read-frames': { args: [input: LocalFrameReadInput]; returnType: LocalFrameReadResult };
  'local-execution:acknowledge-frames': { args: [input: LocalFrameProgress]; returnType: LocalExecutionMutationResult };
  'local-execution:cancel-request': { args: [input: LocalRequestCancellation]; returnType: LocalExecutionMutationResult };
  'local-execution:set-paused': { args: [input: LocalTaskPause]; returnType: LocalExecutionMutationResult };
  'local-execution:set-connection': { args: [input: LocalConnectionState]; returnType: LocalExecutionMutationResult };
  'local-preparation-dialog:state': { args: []; returnType: LocalPreparationDialogState };
  'local-preparation-dialog:action': { args: [action: LocalPreparationDialogAction]; returnType: void };

  // Figurinhas do chat (#356)
  'stickers:list': { args: [folderPath: string]; returnType: StickerEntry[] };
  'stickers:read': { args: [filePath: string]; returnType: StickerData | null };
  'stickers:save': {
    args: [folderPath: string, fileName: string, bytes: Uint8Array];
    returnType: StickerSaveResult;
  };

  // Atalhos Globais (Keybinds)
  'shortcuts:register-actions': { args: [shortcuts: ActionShortcutBinding[]]; returnType: boolean };
  'shortcuts:set-capture': { args: [active: boolean]; returnType: boolean };

  // Push to Talk (PTT) (#186)
  'ptt:set-config': { args: [config: PttConfig]; returnType: boolean };
  'ptt:start-capture': { args: []; returnType: boolean };
  'ptt:stop-capture': { args: []; returnType: boolean };

  // Link Preview
  'link-preview:fetch': { args: [url: string]; returnType: LinkPreviewData | null };

  // Rede
  'net:probe-server': { args: [host: string, port: number]; returnType: ServerProbeResult };

  // Áudio da Tela (Nativo)
  'screen-audio:is-supported': { args: []; returnType: boolean };
  'screen-audio:diagnose': { args: []; returnType: ScreenAudioDiagnostics };
  'screen-audio:start': { args: [sourceId?: string]; returnType: { success: boolean; error?: string } };
  'screen-audio:stop': { args: []; returnType: { success: boolean } };

  // Bandeja do Sistema (Tray)
  'tray:update-voice-status': { args: [status: TrayVoiceStatus]; returnType: void };

  // Atualizador
  'updater:set-channel': { args: [allowBeta: boolean]; returnType: UpdateSimpleResult };
  'updater:check': { args: []; returnType: UpdateCheckResult };
  'updater:download': { args: [expectedVersion?: string]; returnType: UpdateSimpleResult };
  'updater:install': { args: []; returnType: UpdateSimpleResult };
  'updater:outcome': { args: []; returnType: UpdateOutcome | null };
  'updater:release-notes': { args: [tag?: string]; returnType: ReleaseNotesResult };

  // Client Logging (#444)
  'client-log:write': { args: [entry: ClientLogEntry]; returnType: void };
  'client-log:get-config': { args: []; returnType: ClientLogConfig };
  'client-log:set-config': { args: [config: Partial<ClientLogConfig>]; returnType: void };
  'client-log:export': { args: []; returnType: { success: boolean; filePath?: string; error?: string } };
  'client-log:get-size': { args: []; returnType: number };
  'client-log:clear': { args: []; returnType: void };
}

/**
 * Mapeamento de Eventos Unidirecionais (Main -> Renderer via webContents.send)
 */
export interface IpcEvents {
  'native-screen:event': [event: NativeScreenEvent];
  'server-invite:available': [];
  // Pedido de despedida antes do processo morrer: o renderer sai das chamadas e
  // avisa os servidores enquanto ainda esta vivo (#458)
  'app:before-quit': [];
  'lan:found': [server: DiscoveredLanServer];
  'lan:lost': [server: DiscoveredLanServer];
  'soundboard:shortcut-triggered': [soundName: string];
  'soundboard:download-progress': [progress: SoundboardDownloadProgress];
  'local-execution:changed': [snapshot: LocalExecutionSnapshot];
  'local-execution:task-failed': [failure: LocalTaskFailureEvent];
  'local-preparation-dialog:changed': [state: LocalPreparationDialogState];
  'shortcut:action-triggered': [action: string];
  'ptt:state-changed': [active: boolean];
  'ptt:captured': [binding: PttKeyBinding];
  'screen-audio:frame': [buffer: ArrayBuffer | Uint8Array];
  /** Falha assincrona da captura nativa (dispositivo caiu, stream derrubado pelo sistema). */
  'screen-audio:error': [message: string];
  'tray:toggle-mute': [];
  'tray:toggle-deafen': [];
  'updater:progress': [percent: number];
  'updater:downloaded': [info: { manual: boolean }];
  'updater:error': [message: string];
  'server-host:log': [entry: LogEntry];
  'server-host:status-changed': [status: { isRunning: boolean; port: number | null; serverId: string | null }];

  // Eventos de Sobreposição (Overlay) (#169)
  'overlay:state-changed': [isOpen: boolean];
  'overlay:config-updated': [config: OverlayConfig];
  'overlay:signal-received': [signal: string];
  'overlay:sync-state-received': [state: OverlaySyncState];
  'overlay:close-requested': [];
}

export type IpcInvokeChannel = keyof IpcInvokeChannels;
export type IpcEventChannel = keyof IpcEvents;
