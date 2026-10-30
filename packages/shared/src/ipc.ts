/**
 * Contrato de Tipagem Unificado para IPC (Inter-Process Communication)
 * Define as mensagens e eventos trafegados entre o Main Process e o Renderer Process.
 */

import { z } from 'zod';
import type { ClientLogConfig, ClientLogEntry, LogEntry } from './logging.js';
import type { DevelopmentQaConfig, DevelopmentQaReport } from './developmentQa.js';
import type { SoundDownloadFailureReason, SoundDownloadRequest, SoundDownloadResult } from './soundDownloads.js';
import type { CommandAudioPreviewFailureReason, CommandAudioPreviewMimeType } from './botInteractions.js';
import type { ReleaseCompatibilityResult } from './releaseCompatibility.js';
import type { ServerInviteResult } from './serverInvites.js';
import type { EventCalendarExport, EventCalendarSaveResult } from './serverEventCalendar.js';
import type { HostingSkillId, HostingSkillSaveResult } from './hostingSkills.js';
import type { FileBatchDownloadRequest, FileBatchDownloadResult } from './fileDownloads.js';
import type { NativeScreenCommand, NativeScreenCommandResult, NativeScreenEvent, NativeScreenReply, BrowserOcclusionEngine } from './nativeScreenIpc.js';
import type { NativeScreenCaptureMode } from './screenSharing.js';
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
import type { UserActivity } from './models.js';
import type { DmEvent, DmExportMode, DmInvokeChannels } from './directMessages.js';
import {
  botDeviceStorageGrantSchema, botDeviceStorageScopeSchema,
  type BotDeviceStorageDocumentState, type BotDeviceStorageEntry, type BotDeviceStorageResponse,
} from './botStorage.js';

export interface RendererBootstrapFailure {
  phase: 'constructor' | 'initialization';
  errorName: string;
  /** Only sanitized app source locations survive validation in Main. */
  stack?: string;
}

export const EDITOR_COMMANDS = ['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll'] as const;
export type EditorCommand = typeof EDITOR_COMMANDS[number];
export const EDITOR_COMMAND_IPC = 'editor:command' satisfies keyof IpcInvokeChannels;

export interface AppShutdownRequest {
  requestId: number;
  phase: 'native' | 'farewell';
}
export const APP_SHUTDOWN_EVENT = 'app:before-quit' satisfies keyof IpcEvents;
export const APP_SHUTDOWN_IPC = {
  acknowledge: 'app:leave-complete',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

export const DEVELOPMENT_QA_IPC = {
  config: 'development-qa:config',
  report: 'development-qa:report',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

export const SERVER_INVITE_IPC = {
  take: 'server-invite:take',
} as const satisfies Record<string, keyof IpcInvokeChannels>;
export const SERVER_INVITE_AVAILABLE = 'server-invite:available' satisfies keyof IpcEvents;

export const BOT_SCREEN_DOCUMENT_IPC = {
  create: 'bot-screen-document:create',
  remove: 'bot-screen-document:remove',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

export const BOT_SCREEN_PERMISSION_POLICY_VERSION = 2;
export const botScreenDocumentConsentSchema = z.object({
  policyVersion: z.literal(BOT_SCREEN_PERMISSION_POLICY_VERSION),
  serverKey: z.string().min(1).max(1024),
  botId: z.string().min(1).max(128),
  screenId: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(128),
  /** Present only when the server administrator allowed `device_storage` for this bot. */
  storage: z.object({ scope: botDeviceStorageScopeSchema, grant: botDeviceStorageGrantSchema }).strict().optional(),
}).strict().refine((consent) => !consent.storage || consent.storage.scope.botId === consent.botId, {
  message: 'Storage consent addresses another bot', path: ['storage'],
});
export type BotScreenDocumentConsent = z.infer<typeof botScreenDocumentConsentSchema>;

export const BOT_STORAGE_IPC = {
  documentState: 'bot-storage:document-state',
  documentRequest: 'bot-storage:document-request',
  list: 'bot-storage:list',
  get: 'bot-storage:get',
  setDecision: 'bot-storage:set-decision',
  setQuota: 'bot-storage:set-quota',
  clear: 'bot-storage:clear',
  forget: 'bot-storage:forget',
} as const satisfies Record<string, keyof IpcInvokeChannels>;
export const BOT_STORAGE_CHANGED = 'bot-storage:changed' satisfies keyof IpcEvents;

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
  isOwnWindow?: boolean;
  /** Owning process of a window, so two windows of one application are not both captured with sound (#253). */
  processId?: number;
  /**
   * Running parents of that process, nearest first. Windows captures an application's audio together
   * with the processes it started, so a launcher and the game it opened are not both captured with sound.
   */
  processAncestry?: number[];
  /** Browser engine that stops painting this window once other windows fully cover it, freezing its capture. */
  occlusionEngine?: BrowserOcclusionEngine;
  displayNumber?: number;
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
  thumbnailState?: 'pending' | 'ready' | 'unavailable';
}

export const desktopSourcesOptionsSchema = z.object({
  metadataOnly: z.boolean().optional(),
  refresh: z.boolean().optional(),
}).strict();
export type DesktopSourcesOptions = z.infer<typeof desktopSourcesOptionsSchema>;
export const desktopSourcePreviewsRequestSchema = z.object({
  type: z.enum(['screen', 'window']),
  sourceIds: z.array(z.string().min(1).max(512)).max(256)
    .refine(ids => new Set(ids).size === ids.length, 'Source identities must be unique'),
}).strict();
export type DesktopSourcePreviewsRequest = z.infer<typeof desktopSourcePreviewsRequestSchema>;
export type DesktopSourcePreview = Pick<DesktopSource, 'id' | 'thumbnailDataUrl' | 'appIconDataUrl'>;
export const DESKTOP_SOURCES_IPC = {
  list: 'screen-share:get-sources',
  previews: 'screen-share:get-previews',
  cancelPreviews: 'screen-share:cancel-previews',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

export interface ImageSelectionResult {
  fileName: string;
  mimeType: string;
  base64: string;
}

export interface RecentSoundSaveInput {
  fileName: string;
  mimeType: string;
  base64: string;
}

export interface RecentSoundSaveResult {
  success: boolean;
  canceled?: boolean;
  error?: string;
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

export type SoundboardFileFailure = 'invalid_request' | 'no_folder' | 'missing' | 'exists' | 'locked' | 'too_large' | 'unsupported' | 'io_failed'
  | 'source_changed' | 'encoder_unavailable' | 'encode_failed' | 'cleanup_failed';
export type SoundboardFileResult<T> = { status: 'ok'; value: T } | { status: 'failed'; reason: SoundboardFileFailure };
export interface SoundboardFileInput {
  folder: string;
  fileName: string;
}
export interface SoundboardRenameInput extends SoundboardFileInput { newFileName: string }
export interface SoundboardEditTimes { start: number; end: number; fadeIn: number; fadeOut: number }
export interface SoundboardEditInput extends SoundboardRenameInput, SoundboardEditTimes {
  sampleRate: number;
  channels: Float32Array[];
}
export interface SoundboardSavedFile { fileName: string; filePath: string; duration?: number }
export interface SoundboardEditorSource { bytes: Uint8Array; revision: string; overwriteAvailable: boolean }
export interface SoundboardOverwriteInput extends Omit<SoundboardEditInput, 'newFileName'> { revision: string }

export const SOUNDBOARD_FILES_IPC = {
  read: 'soundboard:edit-read',
  rename: 'soundboard:rename-file',
  delete: 'soundboard:delete-file',
  edit: 'soundboard:save-edited-copy',
  open: 'soundboard:open-editor',
  overwrite: 'soundboard:overwrite-audio',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

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

/**
 * Sound and sticker folders the renderer had configured before reading them
 * required a native confirmation. Only the main window's preload reports them,
 * once per document; Main adopts them on the first report of a profile only.
 */
export interface ConfiguredMediaFolders {
  soundboard?: string;
  stickers?: string;
}

export const MEDIA_FOLDERS_IPC = {
  adopt: 'media-folders:adopt-configured',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

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

/**
 * Call state the renderer reports to the system shell: the tray icon and menu,
 * and the call buttons on the Windows taskbar thumbnail.
 */
export const trayVoiceStatusSchema = z.object({
  inCall: z.boolean(),
  // Effective state, moderation included: what the tray icon shows.
  isMuted: z.boolean(),
  isDeafened: z.boolean(),
  isSpeaking: z.boolean(),
  // The person's own toggles, which the taskbar buttons switch, like the footer's.
  selfMuted: z.boolean(),
  selfDeafened: z.boolean(),
  // Why the microphone toggle does nothing, if it does not: a role that cannot speak, or the AFK channel.
  micLock: z.enum(['permission', 'afk']).nullable(),
  // Watching someone's screen share or an open miniapp: the tray monkey puts on 3D glasses.
  isWatching: z.boolean(),
  // A soundboard sound of the person's own playing in the call: the tray monkey holds a megaphone.
  isPlayingSound: z.boolean(),
  // The person's camera or screen share is on: the tray monkey gets a REC frame.
  isRecording: z.boolean(),
}).strict();
export type TrayVoiceStatus = z.infer<typeof trayVoiceStatusSchema>;

export interface UpdateCheckResult {
  ok: boolean;
  cancelled?: boolean;
  available?: boolean;
  version?: string;
  error?: string;
  compatibility?: ReleaseCompatibilityResult;
}

export const UPDATER_IPC = {
  setChannel: 'updater:set-channel',
  check: 'updater:check',
  download: 'updater:download',
  cancel: 'updater:cancel',
  preflight: 'updater:preflight',
  install: 'updater:install',
  outcome: 'updater:outcome',
  releaseNotes: 'updater:release-notes',
  releaseHistory: 'updater:release-history',
} as const satisfies Record<string, keyof IpcInvokeChannels>;

export interface UpdateSimpleResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface HostedUpdateServer {
  serverId: string | null;
  serverName: string;
  bots: { id: string; name: string; protocolVersion: number | null }[];
}

export interface HostedBotUpdateWarning {
  serverName: string;
  bots: { name: string; status: 'incompatible' | 'unknown' }[];
}

export interface UpdatePreflightResult extends UpdateSimpleResult {
  warnings?: HostedBotUpdateWarning[];
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

/** One published release in the changelog history, newest first. */
export interface ReleaseHistoryEntry {
  version: string;
  body: string;
  url: string;
  publishedAt: string | null;
}

/** A page of releases older than the one on screen (changelog lazy loading). */
export interface ReleaseHistoryResult {
  ok: boolean;
  entries?: ReleaseHistoryEntry[];
  hasMore?: boolean;
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
  categoryLocale?: 'pt-BR' | 'en';
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

/** One server hosted by this app. The port identifies it while it runs. */
export interface HostedServerInstance {
  port: number;
  /** Entry of "Meus Servidores" that owns it; null for the legacy flat data folder. */
  serverId: string | null;
}

/** Every server this app is hosting, sorted by port. */
export interface HostServerStatus {
  servers: HostedServerInstance[];
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
 * Why the identity file on this computer could not be opened (#490):
 * - `locked`: the system keychain (macOS Keychain, Windows DPAPI) did not
 *   unlock it, e.g. access denied or a file copied from another user;
 * - `corrupt`: the file is damaged or incomplete;
 * - `io`: the file could not be read right now, e.g. held by another program.
 */
export type IdentityUnreadableReason = 'locked' | 'corrupt' | 'io';

/**
 * The identity on this computer. When it is `unreadable` the file is kept as
 * it is: the app only replaces it when the user explicitly imports or creates
 * another identity, and even then the old file is set aside, not deleted.
 */
export type AppIdentityStatus =
  | { state: 'ready' }
  | { state: 'missing' }
  | { state: 'unreadable'; reason: IdentityUnreadableReason };

/**
 * Import result. `extras` carries the opaque servers/settings backup that may
 * have been exported alongside the identity (#472); only the renderer knows how
 * to read it.
 */
export interface AppIdentityImportResult extends AppIdentityResult {
  status: 'imported';
  extras?: string;
}

/**
 * The code belongs to another identity than the one this computer uses, and
 * nothing was written (#490). Importing again with `replace` set to this
 * `publicKey` switches to it; the identity in use is kept aside, not deleted.
 */
export interface AppIdentityReplaceRequest extends AppIdentityResult {
  status: 'confirm-replace';
}

export type AppIdentityImportOutcome = AppIdentityImportResult | AppIdentityReplaceRequest;

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

export interface OverlayCardSize {
  width: number;
  height: number;
}

export interface OverlayCardLayout {
  cardSize: OverlayCardSize;
  minimalistMode?: boolean;
  preserveAspectRatio?: boolean;
  width: number;
  height: number;
  resizeAspect?: {
    ratio: number;
    extraSize: OverlayCardSize;
  };
}

export interface OverlayConfig {
  mode: OverlayMode;
  layout: OverlayLayout;
  position: OverlayPosition;
  cardOpacity: number; // 0.2 a 1.0
  focusActiveSpeaker: boolean;
  autoOpenOnLeaveStage?: boolean;
  minimalistMode?: boolean;
  hideSelf?: boolean;
  hideStagePreviews?: boolean;
  hideInactiveParticipants?: boolean;
  preserveAspectRatio?: boolean;
  cardSize?: OverlayCardSize;
  minimalistCardSize?: OverlayCardSize;
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
  screenCaptureModes?: Record<string, NativeScreenCaptureMode>;
}

export interface OverlaySyncState {
  channelId: string | null;
  channelName: string;
  participants: OverlayParticipantState[];
  activeSpeakerSessionId: string | null;
  config: OverlayConfig;
}

const overlaySessionSchema = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const overlaySdpSchema = z.string().min(1).max(262_144);

/**
 * Negotiation of the local video link between the main window (offerer) and
 * the overlay (answerer). Every message names the main window's connection:
 * the overlay builds one connection per `session` and both sides drop what
 * belongs to a connection already replaced. `hello` asks an overlay that is
 * already running to negotiate a new connection; `ready` answers it, or, with
 * `session: null`, is the first word of an overlay that just started. `scale`
 * is the overlay's own pixel ratio, which sizes the video it is sent: the
 * overlay may sit on a display with another scale than the main window (R-MEDIA-2).
 */
export const overlaySignalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hello'), session: overlaySessionSchema }).strict(),
  z.object({ kind: z.literal('ready'), session: overlaySessionSchema.nullable() }).strict(),
  z.object({ kind: z.literal('offer'), session: overlaySessionSchema, sdp: overlaySdpSchema }).strict(),
  z.object({ kind: z.literal('answer'), session: overlaySessionSchema, sdp: overlaySdpSchema }).strict(),
  z.object({ kind: z.literal('scale'), session: overlaySessionSchema, pixelRatio: z.number().finite().min(0.25).max(8) }).strict(),
]);
export type OverlaySignal = z.infer<typeof overlaySignalSchema>;

export const overlaySignalPayloadSchema = z.object({
  target: z.enum(['main', 'overlay']),
  signal: overlaySignalSchema,
}).strict();
export type OverlaySignalPayload = z.infer<typeof overlaySignalPayloadSchema>;

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
  setSinkId: {
    request: { epoch: number; sinkId: string };
    result: { epoch: number; sinkId: string };
  };
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
  'native-screen:texture-port': import('./nativeScreenIpc.js').NativeScreenTextureChannelInfo;
}

export const NATIVE_SCREEN_TEXTURE_IPC = {
  port: 'native-screen:texture-port',
} as const satisfies Record<string, keyof IpcPortEvents>;

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
 *
 * Os canais das DMs ficam em `DmInvokeChannels` (directMessages.ts), junto do
 * resto do contrato delas, e entram aqui por herança.
 */
export interface IpcInvokeChannels extends DmInvokeChannels {
  'bot-screen-document:create': { args: [html: string, consent: BotScreenDocumentConsent]; returnType: string };
  'bot-screen-document:remove': { args: [url: string]; returnType: void };
  'bot-storage:document-state': { args: [url: string]; returnType: BotDeviceStorageDocumentState };
  'bot-storage:document-request': { args: [url: string, request: unknown]; returnType: BotDeviceStorageResponse };
  'bot-storage:list': { args: []; returnType: BotDeviceStorageEntry[] };
  'bot-storage:get': { args: [scope: unknown]; returnType: BotDeviceStorageEntry };
  'bot-storage:set-decision': { args: [input: unknown]; returnType: BotDeviceStorageEntry };
  'bot-storage:set-quota': { args: [input: unknown]; returnType: BotDeviceStorageEntry };
  'bot-storage:clear': { args: [scopeId: string]; returnType: void };
  'bot-storage:forget': { args: [scopeId: string]; returnType: void };
  'editor:command': { args: [command: EditorCommand]; returnType: { success: boolean } };
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
  'screen-pip:open': { args: [requestId: string, requireInactive: boolean, aspectRatio: number]; returnType: boolean };
  /** "Voltar ao Monky": brings the main window back from minimized or the tray. */
  'screen-pip:return': { args: []; returnType: void };
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
  'overlay:layout-cards': { args: [layout: OverlayCardLayout]; returnType: OverlayBounds };
  'overlay:send-signal': { args: [payload: OverlaySignalPayload]; returnType: void };
  'overlay:send-sync-state': { args: [state: OverlaySyncState]; returnType: void };

  // Presença de jogo (#675)
  'game-presence:set-enabled': { args: [enabled: boolean]; returnType: void };
  'game-presence:get-current': { args: []; returnType: UserActivity | null };
  /** Window source ids of the running game, for sharing it from the suggestion (#763). */
  'game-share:find-windows': { args: []; returnType: string[] };
  /** Seconds since the last keyboard or mouse input anywhere in the system, for the AFK channel. */
  'system:get-idle-seconds': { args: []; returnType: number };

  // Sistema / App
  'app:set-language': { args: [language: string]; returnType: void };
  'app:get-version': { args: []; returnType: string };
  'app:open-external': { args: [url: string]; returnType: { success: boolean } };
  'app:get-auto-start': { args: []; returnType: boolean };
  'app:set-auto-start': { args: [enabled: boolean]; returnType: void };
  'app:set-minimize-to-tray': { args: [enabled: boolean]; returnType: void };
  'app:download-file': { args: [url: string, fileName: string]; returnType: { success: boolean; error?: string } };
  'app:download-files': { args: [request: FileBatchDownloadRequest]; returnType: FileBatchDownloadResult };
  'app:save-csv-file': { args: [content: string, fileName: string]; returnType: { success: boolean; error?: string } };
  'app:save-recent-sound': { args: [input: RecentSoundSaveInput]; returnType: RecentSoundSaveResult };
  'community:save-event-calendar': { args: [input: EventCalendarExport]; returnType: EventCalendarSaveResult };
  'onboarding:save-hosting-skill': { args: [id: HostingSkillId]; returnType: HostingSkillSaveResult };
  // Ack do renderer ao 'app:before-quit': confirma que ja saiu das chamadas (#458)
  'app:leave-complete': { args: [request: AppShutdownRequest]; returnType: void };

  // Identidade
  'identity:status': { args: []; returnType: AppIdentityStatus };
  // Cria uma identidade quando não há uma legível; um arquivo ilegível é guardado à parte antes
  'identity:create': { args: []; returnType: AppIdentityResult };
  'identity:get': { args: []; returnType: AppIdentityResult };
  'identity:get-client-id': { args: []; returnType: string };
  'identity:sign-challenge': { args: [nonceHex: string]; returnType: string };
  'identity:export': { args: [password: string, extras?: string, dmMode?: DmExportMode]; returnType: string };
  'identity:import': {
    args: [exportedIdentity: string, password: string, replace?: string];
    returnType: AppIdentityImportOutcome;
  };
  // Sair: apaga a identidade, amigos e DMs deste computador e reinicia o app
  'identity:logout': { args: []; returnType: { success: boolean; error?: string } };

  // Backup de servidores salvos e configuracoes (#472)
  'backup:save-file': { args: [contents: string, suggestedName: string]; returnType: BackupSaveResult };
  'backup:open-file': { args: []; returnType: BackupOpenResult };
  'backup:encrypt': { args: [contents: string, password: string]; returnType: BackupCryptoResult };
  'backup:decrypt': { args: [payload: string, password: string]; returnType: BackupCryptoResult };

  // Servidor Local
  'server-host:start': { args: [options: HostServerOptions]; returnType: { success: boolean; error?: string } };
  'server-host:stop': { args: [port: number]; returnType: { success: boolean } };
  'server-host:status': { args: []; returnType: HostServerStatus };
  'server-host:logs': { args: [port: number]; returnType: LogEntry[] };
  'server-host:clear-logs': { args: [port: number]; returnType: void };
  'server-host:stats': { args: [port: number]; returnType: ServerStats | null };
  'server-host:delete-data': { args: [serverId: string]; returnType: { success: boolean; error?: string } };

  // LAN Discovery
  'lan:start': { args: []; returnType: void };
  'lan:stop': { args: []; returnType: void };

  // Captura de Tela
  'screen-share:ensure-permission': { args: []; returnType: boolean };
  'screen-share:get-sources': { args: [options?: DesktopSourcesOptions]; returnType: DesktopSource[] };
  'screen-share:get-previews': { args: [request: DesktopSourcePreviewsRequest]; returnType: DesktopSourcePreview[] };
  'screen-share:cancel-previews': { args: []; returnType: void };
  'screen-share:prepare-window': { args: [string]; returnType: boolean };

  // Diálogos Nativos
  'dialog:select-image': { args: []; returnType: ImageSelectionResult | null };
  'dialog:select-images': { args: [maxFiles: number]; returnType: ImageSelectionResult[] };
  'dialog:select-sound-file': { args: []; returnType: string | null };
  'dialog:select-soundboard-folder': { args: []; returnType: string | null };
  'dialog:select-stickers-folder': { args: []; returnType: string | null };

  // Soundboard
  'soundboard:default-folder': { args: []; returnType: string | null };
  // userAction: set by the preload during a direct user action; only then may Main ask,
  // natively, to confirm a configured folder this profile never confirmed (D4).
  'soundboard:list-sounds': { args: [folderPath: string, userAction?: boolean]; returnType: SoundboardSoundEntry[] };
  'soundboard:read-sound': { args: [filePath: string]; returnType: SoundboardSoundData | null };
  'soundboard:edit-read': { args: [input: SoundboardFileInput]; returnType: SoundboardFileResult<Uint8Array> };
  'soundboard:rename-file': { args: [input: SoundboardRenameInput]; returnType: SoundboardFileResult<SoundboardSavedFile> };
  'soundboard:delete-file': { args: [input: SoundboardFileInput]; returnType: SoundboardFileResult<null> };
  'soundboard:save-edited-copy': { args: [input: SoundboardEditInput]; returnType: SoundboardFileResult<SoundboardSavedFile> };
  'soundboard:open-editor': { args: [input: SoundboardFileInput]; returnType: SoundboardFileResult<SoundboardEditorSource> };
  'soundboard:overwrite-audio': { args: [input: SoundboardOverwriteInput]; returnType: SoundboardFileResult<SoundboardSavedFile> };
  'soundboard:download-availability': { args: [configuredFolder: string]; returnType: SoundboardDownloadAvailability };
  'soundboard:confirm-download-folder': { args: [configuredFolder: string]; returnType: boolean };
  'soundboard:authorize-download': { args: [input: SoundboardDownloadAuthorization]; returnType: SoundboardDownloadPermit };
  'soundboard:download-sound': { args: [input: SoundboardDownloadInput]; returnType: SoundDownloadResult };
  'soundboard:cancel-download': { args: [key: SoundboardDownloadCancellation]; returnType: boolean };
  'media-folders:adopt-configured': { args: [folders: ConfiguredMediaFolders]; returnType: void };
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
  'stickers:list': { args: [folderPath: string, userAction?: boolean]; returnType: StickerEntry[] };
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

  // Bandeja do Sistema (Tray)
  'tray:update-voice-status': { args: [status: TrayVoiceStatus]; returnType: void };

  // Atualizador
  'updater:set-channel': { args: [allowBeta: boolean]; returnType: UpdateSimpleResult };
  'updater:check': { args: [requestId?: string]; returnType: UpdateCheckResult };
  'updater:download': { args: [expectedVersion?: string, requestId?: string]; returnType: UpdateSimpleResult };
  'updater:cancel': { args: [requestId: string]; returnType: UpdateSimpleResult };
  'updater:preflight': { args: [version: string, requestId: string]; returnType: UpdatePreflightResult };
  'updater:install': { args: []; returnType: UpdateSimpleResult };
  'updater:outcome': { args: []; returnType: UpdateOutcome | null };
  'updater:release-notes': { args: [tag?: string]; returnType: ReleaseNotesResult };
  'updater:release-history': { args: [page: number, before?: string]; returnType: ReleaseHistoryResult };

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
  'window:inactive': [];
  'window:active': [];
  'native-screen:event': [event: NativeScreenEvent];
  'server-invite:available': [];
  // Pedido de despedida antes do processo morrer: o renderer sai das chamadas e
  // avisa os servidores enquanto ainda esta vivo (#458)
  'app:before-quit': [request: AppShutdownRequest];
  'lan:found': [server: DiscoveredLanServer];
  'lan:lost': [server: DiscoveredLanServer];
  'soundboard:shortcut-triggered': [soundName: string];
  'soundboard:download-progress': [progress: SoundboardDownloadProgress];
  'local-execution:changed': [snapshot: LocalExecutionSnapshot];
  'local-execution:task-failed': [failure: LocalTaskFailureEvent];
  /** Usage, preference or grants of one bot's storage on this computer changed. */
  'bot-storage:changed': [scopeId: string];
  'local-preparation-dialog:changed': [state: LocalPreparationDialogState];
  'shortcut:action-triggered': [action: string];
  'ptt:state-changed': [active: boolean];
  'ptt:captured': [binding: PttKeyBinding];
  // Comandos de chamada vindos do sistema: menu da bandeja e miniatura da barra de tarefas (Windows).
  'tray:toggle-mute': [];
  'tray:toggle-deafen': [];
  'tray:leave-call': [];
  'updater:progress': [percent: number];
  'updater:downloaded': [info: { manual: boolean }];
  'updater:error': [message: string];
  'server-host:log': [port: number, entry: LogEntry];
  'server-host:status-changed': [status: HostServerStatus];

  /** Jogo detectado mudou — `null` quando nada está rodando (#675). */
  'game-presence:changed': [activity: UserActivity | null];

  // Eventos de Sobreposição (Overlay) (#169)
  'overlay:state-changed': [isOpen: boolean];
  'overlay:config-updated': [config: OverlayConfig];
  'overlay:hover-changed': [hovered: boolean, point?: { x: number; y: number }];
  'overlay:resize-state-changed': [resizing: boolean];
  'overlay:signal-received': [signal: OverlaySignal];
  'overlay:sync-state-received': [state: OverlaySyncState];
  'overlay:close-requested': [];

  // Mensagens diretas (#743)
  'dm:event': [event: DmEvent];
}

/**
 * Mensagens Renderer -> Main sem resposta (ipcRenderer.send / ipcMain.on).
 */
export interface IpcSendChannels {
  /** The renderer painted its first frame: the window may be revealed. */
  'app:renderer-ready': [];
}
export const APP_RENDERER_READY = 'app:renderer-ready' satisfies keyof IpcSendChannels;

export type IpcInvokeChannel = keyof IpcInvokeChannels;
export type IpcEventChannel = keyof IpcEvents;
export type IpcSendChannel = keyof IpcSendChannels;

/** A bridge method that is exactly one invoke channel: its arguments, then its answer. */
export type IpcInvoker<C extends IpcInvokeChannel> =
  (...args: IpcInvokeChannels[C]['args']) => Promise<IpcInvokeChannels[C]['returnType']>;

/** A bridge method that listens to one Main -> renderer event; the result stops listening. */
export type IpcSubscriber<E extends IpcEventChannel> = (callback: (...args: IpcEvents[E]) => void) => () => void;
