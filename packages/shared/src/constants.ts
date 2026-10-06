export const PROTOCOL_VERSION = 36;
export const ED25519_SPKI_PUBLIC_KEY_DER_PREFIX_HEX = '302a300506032b6570032100';
export const ED25519_SPKI_PUBLIC_KEY_DER_HEX_LENGTH = ED25519_SPKI_PUBLIC_KEY_DER_PREFIX_HEX.length + 64;

/**
 * Initial shell size; populated overlays size themselves from readable cards,
 * rather than dividing this rectangle among an arbitrary participant count.
 */
export const OVERLAY_DEFAULT_WIDTH = 514;
export const OVERLAY_DEFAULT_HEIGHT = 334;
export const OVERLAY_DEFAULT_CARD_WIDTH = 240;
export const OVERLAY_DEFAULT_CARD_HEIGHT = 135;
export const OVERLAY_MINIMALIST_CARD_HEIGHT = 36;

export const LIMITS = {
  MESSAGE_DELETE_UNDO_SECONDS: 60,
  MAX_MESSAGE_DELETE_UNDO_SECONDS: 86400,
  MAX_MESSAGE_LENGTH: 16000,
  // Game titles come from Steam's own manifests (#675); the cap only guards
  // against a tampered manifest, not against normal names.
  MAX_ACTIVITY_NAME_LENGTH: 128,
  // Steam caches app icons as 32x32 JPEGs, a couple of KB at most. The cap is
  // three orders of magnitude below MAX_AVATAR_SIZE on purpose: this field is
  // never a place to put bulk data, and the server has no maxPayload of its own.
  MAX_ACTIVITY_ICON_LENGTH: 32 * 1024,
  MAX_AVATAR_SIZE: 5 * 1024 * 1024, // 5 MB
  MAX_USERS_DEFAULT: 20,
  // Sentinel stored in `max_users` when the owner chose not to cap membership
  // (#403). The column is NOT NULL, so "no limit" needs a value rather than
  // NULL; 0 is safe because a server capped at zero members is meaningless.
  MAX_USERS_UNLIMITED: 0,
  MAX_PARTICIPANTS_PER_CHANNEL_DEFAULT: 10,
  MIN_NICKNAME_LENGTH: 2,
  MAX_NICKNAME_LENGTH: 32,
  MIN_CHANNEL_NAME_LENGTH: 2,
  MAX_CHANNEL_NAME_LENGTH: 50,
  MIN_PORT: 1024,
  MAX_PORT: 65535,
  DEFAULT_PORT: 3000,
  // Lowest Node.js major the server runs on, because mediasoup requires it
  // (#515). The published CLI declares the same floor in its `engines` field,
  // but npm only *warns* on a mismatch, so the runtime has to be able to check
  // it too: PM2 spawns the server with the daemon's Node, which can be older
  // than the one the operator installed (#522).
  MIN_NODE_MAJOR: 22,
  // Default UDP media port range for SFU (Selective Forwarding Unit) (#515)
  SFU_DEFAULT_MIN_PORT: 40000,
  // Stops one below the coturn relay range (49152-65535). The two allocate UDP
  // ports independently, so an overlap would let them race for the same port
  // and fail intermittently once both are enabled.
  SFU_DEFAULT_MAX_PORT: 49151,
  // coturn's listening port and relay range. They live here, and not only in
  // CoturnManager, so the SFU can check its own range against them without
  // depending on the TURN module.
  TURN_LISTENING_PORT: 3478,
  TURN_RELAY_MIN_PORT: 49152,
  TURN_RELAY_MAX_PORT: 65535,
  MAX_HISTORY_MESSAGES_INITIAL: 100,
  RATE_LIMIT_MAX_MESSAGES: 10,
  RATE_LIMIT_WINDOW_MS: 5000,
  /** Tentativas de autenticação por IP antes de o servidor parar de responder (#372). */
  RATE_LIMIT_MAX_AUTH_ATTEMPTS: 8,
  RATE_LIMIT_AUTH_WINDOW_MS: 60_000,
  /**
   * Teto de um frame de WebSocket. O maior payload legítimo é um avatar em
   * base64 (MAX_AVATAR_SIZE cresce ~33% na codificação), e o padrão da lib ws
   * são 100 MiB, que qualquer cliente não autenticado podia mandar (#372).
   */
  WS_MAX_PAYLOAD_BYTES: 8 * 1024 * 1024,
  DM_RELAY_MAX_ITEMS: 50,
  DM_RELAY_DATA_MAX_LENGTH: 65_536,
  DM_RELAY_FILE_DATA_MAX_LENGTH: 196_608,
  DM_RELAY_TOTAL_DATA_MAX_LENGTH: 6 * 1024 * 1024,
  DM_RELAY_RATE_ITEMS_PER_SECOND: 40,
  DM_RELAY_RATE_ITEMS_BURST: 200,
  DM_RELAY_RATE_BYTES_PER_SECOND: 1_572_864,
  DM_RELAY_RATE_BYTES_BURST: 6 * 1024 * 1024,
  DM_RELAY_FILE_BACKPRESSURE_BYTES: 8 * 1024 * 1024,
  HEARTBEAT_INTERVAL_MS: 5000,
  HEARTBEAT_TIMEOUT_MS: 35000,
  RECONNECT_GRACE_MS: 20000,
  // How long a shutdown waits for peers to answer the close frame before their
  // sockets are forcibly destroyed. Without a bound, a single unresponsive peer
  // (sleeping laptop, dropped Wi-Fi) holds the HTTP server open for the ws
  // library's internal 30s close timeout, freezing the host's UI (#333).
  SHUTDOWN_GRACE_MS: 1500,
  // Entries kept in the logger's in-memory ring buffer. It feeds the log view
  // of a hosted server, so it has to be bounded — a server running for days
  // would otherwise grow it without limit.
  LOG_BUFFER_SIZE: 500,
  // Concurrent devices a single identity may hold (#309). Without a cap, an
  // already-online identity could open unlimited connections and bypass
  // maxUsers, since capacity counts people rather than connections.
  MAX_SESSIONS_PER_USER: 3,
  /** Maximum bots a server can have, separate from member cap (#569). */
  MAX_BOTS_DEFAULT: 10,
  /** Bot token length in bytes (displayed as hex = 64 chars). */
  BOT_TOKEN_BYTES: 32,
  /** Max slash commands a single bot may register at once (#569). */
  MAX_COMMANDS_PER_BOT: 50,
  /** Max options (parameters) per slash command (#569). */
  MAX_OPTIONS_PER_COMMAND: 10,
  MAX_BOT_FORM_FIELDS: 10,
  MAX_BOT_FORM_CHOICES: 20,
  MAX_BOT_FORM_LIST_ITEMS: 20,
  MAX_LIVE_ACTION_IMAGES: 5,
  MAX_LIVE_ACTION_IMAGE_DATA_LENGTH: 7_000_000,
  MAX_BOT_SETTINGS_VALUES_BYTES: 16 * 1024,
  MAX_BOT_SETTINGS_DEFINITION_BYTES: 64 * 1024,
  MAX_BOT_SETTINGS_CATALOG: 1000,
  MAX_BOT_INVOCATIONS_PER_SESSION: 5,
  MAX_BOT_INVOCATIONS: 1000,
  BOT_INTERACTION_TIMEOUT_MS: 5 * 60 * 1000,
  /** Per response, not a limit on the accumulated search results. */
  MAX_BOT_AUTOCOMPLETE_CHOICES: 20,
  MAX_BOT_AUTOCOMPLETE_QUERY_LENGTH: 200,
  MAX_BOT_AUTOCOMPLETE_CURSOR_LENGTH: 512,
  MAX_BOT_AUTOCOMPLETE_REQUESTS: 1000,
  BOT_AUTOCOMPLETE_DEBOUNCE_MS: 700,
  BOT_AUTOCOMPLETE_THROTTLE_MS: 500,
  BOT_AUTOCOMPLETE_TIMEOUT_MS: 15_000,
  BOT_AUTOCOMPLETE_CHOICE_TTL_MS: 60_000,
  MAX_BOT_AUDIO_PREVIEW_BYTES: 256 * 1024,
  BOT_AUDIO_PREVIEW_MAX_DURATION_MS: 10_000,
  BOT_AUDIO_PREVIEW_TIMEOUT_MS: 30_000,
  MAX_BOT_AUDIO_PREVIEW_REQUESTS: 100,
  MAX_BOT_AUDIO_PREVIEW_HANDLERS: 4,
  MAX_SOUNDBOARD_FILE_SIZE: 3 * 1024 * 1024,
  RECENT_SOUND_CACHE_DEFAULT_LIMIT: 20,
  RECENT_SOUND_CACHE_MIN_LIMIT: 1,
  RECENT_SOUND_CACHE_MAX_LIMIT: 100,
  RECENT_SOUND_CACHE_MAX_BYTES: 256 * 1024 * 1024,
  RECENT_SOUND_DOWNLOAD_RATE_LIMIT: 10,
  RECENT_SOUND_DOWNLOAD_RATE_WINDOW_MS: 60_000,
  RECENT_SOUND_DOWNLOAD_TIMEOUT_MS: 120_000,
  BOT_SOUND_DOWNLOAD_TIMEOUT_MS: 120_000,
  // Chat attachments (#11). Both size limits are server-configurable; these are
  // only the initial defaults applied when a server is first created.
  MAX_ATTACHMENT_FILE_SIZE_DEFAULT: 50 * 1024 * 1024, // 50 MB per file
  MAX_ATTACHMENT_STORAGE_TOTAL_DEFAULT: 2 * 1024 * 1024 * 1024, // 2 GB total server budget
  MAX_ATTACHMENTS_PER_MESSAGE: 10,
  // FIFO eviction low-watermark: when the total budget is exceeded, prune oldest
  // attachments until usage drops to this fraction of the max (avoids per-upload churn).
  ATTACHMENT_EVICTION_LOW_WATERMARK: 0.9,
  // Short-lived token that authorizes an HTTP POST /attachments upload.
  UPLOAD_TOKEN_TTL_MS: 60000,
} as const;

export const RECONNECT_DELAYS_MS = [1000, 2000, 3000, 5000] as const;

/**
 * Tokens that mention everyone in a channel (#464).
 *
 * Both languages are always accepted, not just the sender's: a message written
 * in one language has to reach the person reading the app in the other.
 * `EVERYONE_MENTION_TOKENS[0]` is the canonical form suggested by the composer.
 */
export const EVERYONE_MENTION_TOKENS = ['todos', 'everyone'] as const;

/** True when the text contains an `@todos` / `@everyone` token. */
export function hasEveryoneMention(content: string): boolean {
  const lower = content.toLowerCase();
  return EVERYONE_MENTION_TOKENS.some((token) => {
    let index = lower.indexOf(`@${token}`);
    while (index !== -1) {
      // The token must not be a prefix of a longer word, otherwise "@todosaqui"
      // (or a nickname starting with "todos") would ping the whole channel.
      const after = lower[index + token.length + 1];
      if (after === undefined || !/[\p{L}\p{N}_-]/u.test(after)) return true;
      index = lower.indexOf(`@${token}`, index + 1);
    }
    return false;
  });
}

export type QualityPresetType = 'ECONOMIC' | 'NORMAL' | 'HIGH' | 'GAMING' | 'QHD' | 'UHD' | 'UHD120' | 'CUSTOM';

export interface QualityProfile {
  name: string;
  audioBitrateKbps: number;
  cameraWidth: number;
  cameraHeight: number;
  cameraFps: number;
  cameraBitrateKbps: number;
  screenWidth: number;
  screenHeight: number;
  screenFps: number;
  screenBitrateKbps: number;
}

/**
 * Ladder from the lightest to the heaviest profile: every step raises the screen
 * without lowering camera or audio, and none drops below 30 FPS. Ceilings sit
 * above streaming norms because capture encoders emit an IDR every second.
 * 4K120 needs H264 level 6.0 or AV1; unsupported encoders lower the FPS first.
 */
export const QUALITY_PRESETS: Record<Exclude<QualityPresetType, 'CUSTOM'>, QualityProfile> = {
  ECONOMIC: {
    name: 'Leve',
    audioBitrateKbps: 24,
    cameraWidth: 640,
    cameraHeight: 360,
    cameraFps: 30,
    cameraBitrateKbps: 300,
    screenWidth: 640,
    screenHeight: 360,
    screenFps: 30,
    screenBitrateKbps: 700,
  },
  NORMAL: {
    name: 'Padrão',
    audioBitrateKbps: 32,
    cameraWidth: 854,
    cameraHeight: 480,
    cameraFps: 30,
    cameraBitrateKbps: 500,
    screenWidth: 1280,
    screenHeight: 720,
    screenFps: 30,
    screenBitrateKbps: 2500,
  },
  HIGH: {
    name: 'Nítido',
    audioBitrateKbps: 48,
    cameraWidth: 1280,
    cameraHeight: 720,
    cameraFps: 30,
    cameraBitrateKbps: 1000,
    screenWidth: 1920,
    screenHeight: 1080,
    screenFps: 30,
    screenBitrateKbps: 4500,
  },
  GAMING: {
    name: 'Fluido',
    audioBitrateKbps: 64,
    cameraWidth: 1920,
    cameraHeight: 1080,
    cameraFps: 30,
    cameraBitrateKbps: 2000,
    screenWidth: 1920,
    screenHeight: 1080,
    screenFps: 60,
    screenBitrateKbps: 8000,
  },
  QHD: {
    name: 'Ultra',
    audioBitrateKbps: 64,
    cameraWidth: 1920,
    cameraHeight: 1080,
    cameraFps: 30,
    cameraBitrateKbps: 2000,
    screenWidth: 2560,
    screenHeight: 1440,
    screenFps: 60,
    screenBitrateKbps: 12000,
  },
  UHD: {
    name: 'Cinema',
    audioBitrateKbps: 64,
    cameraWidth: 1920,
    cameraHeight: 1080,
    cameraFps: 30,
    cameraBitrateKbps: 2000,
    screenWidth: 3840,
    screenHeight: 2160,
    screenFps: 60,
    screenBitrateKbps: 25000,
  },
  UHD120: {
    name: 'Extremo',
    audioBitrateKbps: 64,
    cameraWidth: 1920,
    cameraHeight: 1080,
    cameraFps: 30,
    cameraBitrateKbps: 2000,
    screenWidth: 3840,
    screenHeight: 2160,
    screenFps: 120,
    screenBitrateKbps: 40000,
  },
};

/** Named profiles from 60 FPS up favour motion: smooth frame rate and hardware-friendly codecs. */
export function isMotionQualityPreset(preset: QualityPresetType): boolean {
  return preset !== 'CUSTOM' && (QUALITY_PRESETS[preset]?.screenFps ?? 0) >= 60;
}

/** Saved settings from before 1440p/4K: the old ULTRA id was the 1080p60 tier now called Fluido (GAMING). */
export function restoreQualityPreset(value: unknown): QualityPresetType {
  if (value === 'ULTRA') return 'GAMING';
  if (value === 'CUSTOM' || isNamedQualityPreset(value)) return value;
  return 'NORMAL';
}

function isNamedQualityPreset(value: unknown): value is Exclude<QualityPresetType, 'CUSTOM'> {
  return typeof value === 'string' && Object.hasOwn(QUALITY_PRESETS, value);
}

export const DEFAULT_CUSTOM_PROFILE: QualityProfile = {
  name: 'Personalizado',
  audioBitrateKbps: 32,
  cameraWidth: 1280,
  cameraHeight: 720,
  cameraFps: 30,
  cameraBitrateKbps: 500,
  screenWidth: 1920,
  screenHeight: 1080,
  screenFps: 30,
  screenBitrateKbps: 3000,
};
