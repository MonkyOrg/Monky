export const PROTOCOL_VERSION = 6;

/**
 * Default size of the floating overlay window (#169). Shared so the renderer can
 * tell whether the user resized it away from the default — the "reset size"
 * control is only worth showing once the size actually changed (#543).
 */
export const OVERLAY_DEFAULT_WIDTH = 340;
export const OVERLAY_DEFAULT_HEIGHT = 240;

export const LIMITS = {
  MAX_MESSAGE_LENGTH: 2000,
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

export type QualityPresetType = 'ECONOMIC' | 'NORMAL' | 'HIGH' | 'GAMING' | 'ULTRA' | 'CUSTOM';

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

export const QUALITY_PRESETS: Record<Exclude<QualityPresetType, 'CUSTOM'>, QualityProfile> = {
  ECONOMIC: {
    name: 'Econômico',
    audioBitrateKbps: 24,
    cameraWidth: 640,
    cameraHeight: 360,
    cameraFps: 24,
    cameraBitrateKbps: 250,
    screenWidth: 854,
    screenHeight: 480,
    screenFps: 15,
    screenBitrateKbps: 900,
  },
  NORMAL: {
    name: 'Normal',
    audioBitrateKbps: 32,
    cameraWidth: 854,
    cameraHeight: 480,
    cameraFps: 30,
    cameraBitrateKbps: 450,
    screenWidth: 1280,
    screenHeight: 720,
    screenFps: 30,
    screenBitrateKbps: 2000,
  },
  HIGH: {
    name: 'Alta Qualidade',
    audioBitrateKbps: 48,
    cameraWidth: 1280,
    cameraHeight: 720,
    cameraFps: 30,
    cameraBitrateKbps: 600,
    screenWidth: 1920,
    screenHeight: 1080,
    screenFps: 30,
    screenBitrateKbps: 3500,
  },
  GAMING: {
    name: 'Gaming Mode',
    audioBitrateKbps: 28,
    cameraWidth: 640,
    cameraHeight: 360,
    cameraFps: 20,
    cameraBitrateKbps: 300,
    screenWidth: 1920,
    screenHeight: 1080,
    screenFps: 60,
    screenBitrateKbps: 6000,
  },
  ULTRA: {
    name: 'Ultra',
    audioBitrateKbps: 64,
    cameraWidth: 1920,
    cameraHeight: 1080,
    cameraFps: 60,
    cameraBitrateKbps: 4000,
    screenWidth: 1920,
    screenHeight: 1080,
    screenFps: 60,
    screenBitrateKbps: 8000,
  },
};

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
