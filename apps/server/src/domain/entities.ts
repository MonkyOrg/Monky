import { ChannelType, UserStatus, VoiceMode } from '@monky/shared';

export interface ServerRecord {
  id: string;
  name: string;
  passwordHash: string;
  createdAt: number;
  maxUsers: number;
  ownerUserId?: string | null;
  allowSoundboard?: boolean;
  /** Whether `@todos` / `@everyone` pings the whole channel (#464). */
  allowEveryoneMention?: boolean;
  allowMessageEdit?: boolean;
  /**
   * Whether role badges in the member list are shown to everyone (#530).
   * When off, a badge is only visible to members who hold that same role.
   */
  showRoleBadgesToEveryone?: boolean;
  /** Voice mode ('p2p' | 'sfu') (#515). */
  voiceMode?: VoiceMode;
  iconPath?: string | null;
  // Attachment storage limits in bytes (#11); null → shared defaults.
  maxAttachmentFileBytes?: number | null;
  maxAttachmentStorageBytes?: number | null;
  /** Whether the built-in TURN relay should run alongside the server (#425). */
  turnEnabled?: boolean;
  /** Maximum number of bots allowed on this server (#569). */
  maxBots?: number;
  /**
   * Shared secret backing TURN's REST-API credentials (#425).
   *
   * Never leaves the server: clients only ever receive values derived from it.
   * Null until the relay is enabled for the first time.
   */
  turnSecret?: string | null;
}

export interface UserRecord {
  id: string;
  clientId: string;
  publicKey: string | null;
  nickname: string;
  avatarPath: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface ChannelRecord {
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  position: number;
  createdAt: number;
  maxParticipants: number;
  /** Private channels (#384). */
  isPrivate: boolean;
  /** Roles allowed in, loaded from `channel_allowed_roles`. */
  allowedRoleIds: string[];
}

export interface MessageRecord {
  id: string;
  channelId: string;
  userId: string;
  content: string;
  createdAt: number;
  isSystem?: boolean;
  /** Set when the author rewrote the message (#504). */
  editedAt?: number | null;
  /** Set when the message was deleted; its content is blanked at the same time (#504). */
  deletedAt?: number | null;
}

export interface MentionRecord {
  id: string;
  userId: string;
  channelId: string;
  messageId: string;
  createdAt: number;
}

// A file attached to a chat message (#11). `messageId` is null while the upload
// is pending (before the message is sent). `filename` is the on-disk name, empty
// once the row has been evicted by the FIFO storage cleanup.
export interface AttachmentRecord {
  id: string;
  messageId: string | null;
  channelId: string;
  userId: string;
  kind: 'image' | 'video' | 'file';
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  evicted?: boolean;
  createdAt: number;
}

export interface RoleRecord {
  id: string;
  name: string;
  color: string | null;
  position: number;
  permissions: number;
  isDefault: boolean;
  createdAt: number;
}

export interface UserRoleRecord {
  userId: string;
  roleId: string;
}

/** A bot account registered on the server (#569). */
export interface BotRecord {
  id: string;
  /** Human-readable name shown in the member list. */
  name: string;
  /** Token hash (bcrypt or sha256-hex); the plain token is never stored. */
  tokenHash: string;
  avatarPath: string | null;
  /** The public key bound on first connection (TOFU). Null until bound. */
  boundPublicKey: string | null;
  /** The user who created this bot. */
  createdByUserId: string;
  createdAt: number;
}
