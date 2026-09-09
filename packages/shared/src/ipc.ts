/**
 * Contrato de Tipagem Unificado para IPC (Inter-Process Communication)
 * Define as mensagens e eventos trafegados entre o Main Process e o Renderer Process.
 */

import type { ClientLogConfig, ClientLogEntry, LogEntry } from './logging.js';

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
}

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

/**
 * Mapeamento de Canais Bidirecionais (Invoke / Handle)
 */
export interface IpcInvokeChannels {
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
  'soundboard:list-sounds': { args: [folderPath: string]; returnType: SoundboardSoundEntry[] };
  'soundboard:read-sound': { args: [filePath: string]; returnType: SoundboardSoundData | null };
  'soundboard:register-shortcuts': { args: [shortcuts: SoundboardShortcutBinding[]]; returnType: boolean };

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
  'updater:download': { args: [allowBeta: boolean]; returnType: UpdateSimpleResult };
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
  // Pedido de despedida antes do processo morrer: o renderer sai das chamadas e
  // avisa os servidores enquanto ainda esta vivo (#458)
  'app:before-quit': [];
  'lan:found': [server: DiscoveredLanServer];
  'lan:lost': [server: DiscoveredLanServer];
  'soundboard:shortcut-triggered': [soundName: string];
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
