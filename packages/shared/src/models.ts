export type ChannelType = 'VOICE' | 'TEXT';

export type VoiceMode = 'p2p' | 'sfu';

export interface SfuTransportOptions {
  id: string;
  iceParameters: any;
  iceCandidates: any[];
  dtlsParameters: any;
  sctpParameters?: any;
}

export interface SfuProducerData {
  id: string;
  kind: 'audio' | 'video';
  rtpParameters: any;
  type?: string;
  paused?: boolean;
  appData: Record<string, any>;
}

export interface SfuConsumerData {
  id: string;
  producerId: string;
  kind: 'audio' | 'video';
  rtpParameters: any;
  type?: string;
  producerAppData: Record<string, any>;
  producerSessionId: string;
}

export type UserStatus = 'ONLINE' | 'IDLE' | 'VOICE' | 'DISCONNECTED';

export interface UserSummary {
  id: string;
  clientId: string;
  nickname: string;
  avatarUrl?: string | null;
  status: UserStatus;
  joinedAt: number;
  /**
   * Identifies one live connection of this user, as `userId:deviceId` (#309).
   * The same person may be signed in from several devices at once, so anything
   * that addresses a *connection* (voice participants, WebRTC peers, presence)
   * keys off this instead of `id`. Absent on offline/known-member records,
   * which describe a person rather than a connection.
   */
  sessionId?: string;
  /** When this particular connection came up, used to order a user's devices (#309). */
  connectedAt?: number;
  /**
   * True when this user has "appear offline" active (#561). Only sent to the
   * user themselves so they can see their own visibility status; other clients
   * never receive this flag (they simply see status 'DISCONNECTED').
   */
  invisible?: boolean;
  /** True when this account is a bot created via the bot management API (#569). */
  isBot?: boolean;
}

export interface ChannelSummary {
  botCommandsEnabled: boolean;
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  position: number;
  createdAt: number;
  maxParticipants?: number;
  /**
   * Restricts the channel to members holding one of `allowedRoleIds` (#384).
   * The server never sends a channel the recipient cannot access, so receiving
   * one already means it is visible to you — this flag only drives the UI badge
   * and the editing form.
   */
  isPrivate: boolean;
  /**
   * Roles allowed into a private channel. Empty on public channels, and also
   * valid on a private one, where it means "managers only".
   */
  allowedRoleIds: string[];
}

export type AttachmentKind = 'image' | 'video' | 'file';

// A single file attached to a chat message (#11). The binary itself lives on the
// host's disk (server-data/attachments) and is served over HTTP; only this small
// metadata record travels over the WebSocket / is stored in the DB.
export interface AttachmentMeta {
  id: string;
  messageId: string;
  kind: AttachmentKind;
  // HTTP path served by the host (e.g. /attachments/<file>). Null when the file
  // has been evicted by the FIFO storage cleanup — the UI shows a placeholder.
  url: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  // True when the file was pruned to reclaim disk space; the message row stays.
  evicted?: boolean;
  createdAt: number;
}

// Server attachment-storage limits and current usage, surfaced in the server
// settings UI so the host can see and adjust how much disk chat files may use.
export interface AttachmentStorageInfo {
  usedBytes: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export interface BotCommandContext {
  invocationId: string;
  commandName: string;
  invokerId: string;
  invokerNickname: string;
  invokerAvatarUrl?: string | null;
}

/** Resolved by the server from the original, never supplied by the sender. */
export interface MessageReply {
  messageId: string;
  userNickname: string;
  content: string;
  deleted: boolean;
  hasAttachments: boolean;
}

export interface ChatMessage {
  reply?: MessageReply;
  reactions?: import('./reactions.js').MessageReaction[];
  id: string;
  channelId: string;
  userId: string;
  userNickname: string;
  userAvatarUrl?: string | null;
  content: string;
  createdAt: number;
  isSystem?: boolean;
  // Files attached to this message (#11). Omitted/empty for plain text messages.
  attachments?: AttachmentMeta[];
  /** When the author last edited the message, so the UI can mark it (#504). */
  editedAt?: number | null;
  /**
   * When the message was deleted (#504). A deleted message keeps its row and
   * arrives with an empty `content` and no attachments: the client draws a
   * "message deleted" placeholder instead of making the message vanish, which
   * would silently rewrite the conversation for everyone reading it.
   */
  deletedAt?: number | null;
  /**
   * True when this message is only visible to the invoking user (#569).
   * Ephemeral messages are not persisted and disappear on reconnect.
   */
  isEphemeral?: boolean;
  isBot?: boolean;
  /** Server-authenticated attribution; private argument values are never included. */
  botCommand?: BotCommandContext;
}

export interface Role {
  id: string;
  name: string;
  color: string | null;
  position: number;
  permissions: number;
  isDefault: boolean;
}

export interface UserRoleSummary {
  userId: string;
  roleIds: string[];
}

export type VoiceConnectionHealth = 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface VoiceRosterParticipant {
  user: UserSummary;
  voiceState: VoiceParticipantState;
}

export interface VoiceRestrictions {
  serverMuted: boolean;
  serverDeafened: boolean;
}

export interface VoiceParticipantState extends VoiceRestrictions {
  /** The connection this state belongs to (#309). Unique per device. */
  sessionId: string;
  userId: string;
  channelId: string;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isSharingScreenAudio: boolean;
  /** SFU transport health, measured by the server rather than signaling presence. */
  connectionHealth?: VoiceConnectionHealth;
  /**
   * IDs of the screen shares this participant is currently broadcasting (#253).
   * Each entry is the MediaStream id announced over `screen-video-meta`, so
   * receivers can key tiles and streams per share instead of per user.
   * `isScreenSharing` stays as the derived flag (`length > 0`) and remains the
   * source of truth for clients that predate this field.
   */
  screenShareIds?: string[];
}

/** CPU and RAM of the machine hosting the server, as measured by the server. */
export interface HostSpecs {
  cpuCores: number;
  ramTotalGb: number;
}

// ── Bot & slash command types (#569) ──────────────────────────────────────

/** Option type for a slash command parameter. */
export type CommandOptionType = 'string' | 'integer' | 'boolean' | 'user';

/** One option (parameter) a slash command accepts. */
export interface CommandOption {
  name: string;
  description: string;
  type: CommandOptionType;
  required?: boolean;
  placeholder?: string;
  choices?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
}

/** A registered slash command. */
export interface SlashCommand {
  /** Unique per bot; the command name without the leading `/`. */
  name: string;
  description: string;
  /** The bot that owns this command (`UserSummary.id`). */
  botId: string;
  /** Display-friendly bot name for the command dropup. */
  botName: string;
  botAvatarUrl?: string | null;
  options?: CommandOption[];
}

/** A bot account visible in the management UI. */
export interface BotInfo {
  id: string;
  name: string;
  avatarUrl?: string | null;
  createdAt: number;
  createdByUserId: string;
  /** Whether TOFU binding is complete (first connection done). */
  bound: boolean;
  online: boolean;
}

// ── End bot types ─────────────────────────────────────────────────────────

export interface ServerDetails {
  id: string;
  name: string;
  createdAt: number;
  maxUsers: number;
  hasPassword?: boolean;
  allowSoundboard?: boolean;
  /** Whether `@todos` / `@everyone` mentions the whole channel (#464). */
  allowEveryoneMention?: boolean;
  /**
   * Whether members may edit their own messages (#504). Deleting is always
   * allowed: this switch is about rewriting history, not about taking it back.
   */
  allowMessageEdit?: boolean;
  /**
   * Whether role badges in the member list are visible to everyone (#530).
   * When false, each badge is only rendered for members holding that role.
   */
  showRoleBadgesToEveryone?: boolean;
  /** Maximum number of bots the server allows (#569). */
  maxBots?: number;
  /**
   * Voice and video topology mode (#515).
   * - 'p2p': Direct full-mesh WebRTC connections between participants.
   * - 'sfu': Centralized Selective Forwarding Unit media routing via the server.
   */
  voiceMode?: VoiceMode;
  /**
   * CPU and RAM of the machine actually running the server (#515).
   *
   * The capacity estimator used to read `navigator.hardwareConcurrency` and
   * `navigator.deviceMemory` in the renderer, which describes the admin's
   * desktop — not the VPS being administered — and is capped at 8 GB by the
   * Device Memory spec, so it reported "8 GB" for every host. Optional because
   * an older server simply will not send it.
   */
  hostSpecs?: HostSpecs;
  iconUrl?: string | null;
  channels: ChannelSummary[];
  /** One entry per live connection: a user signed in from two devices appears twice (#309). */
  members: UserSummary[];
  // All users who have ever connected (online + offline), used to allow
  // mentioning users that are not currently in the server (#14). Offline users
  // carry status 'DISCONNECTED'. Optional for backward compatibility.
  knownMembers?: UserSummary[];
  // Channel ids in which the current user has unread @-mentions, so that a user
  // mentioned while offline sees the red @ badge when they reconnect (#14).
  mentionedChannelIds?: string[];
  voiceStates: Record<string, VoiceParticipantState>; // key = sessionId (#309)
  roles?: Role[];
  userRoles?: UserRoleSummary[];
  ownerId?: string | null;
  myPermissions?: number;
  // Attachment-storage limits + current usage for the settings UI (#11).
  attachmentStorage?: AttachmentStorageInfo;
  /**
   * Whether the host is relaying media through its own TURN server (#425).
   *
   * Purely informational for the settings UI: the credentials clients actually
   * dial live in `AuthSuccessPayload.iceServers`, never here, because they are
   * per-user and short-lived.
   */
  turnEnabled?: boolean;

  /**
   * Whether this host can actually run the relay, so the UI can disable the
   * toggle instead of letting the operator switch on something impossible
   * (#429).
   *
   * Absent means the server predates the relay feature: an older build simply
   * ignores `turnEnabled`, so the toggle would appear to do nothing at all.
   * That is why availability is reported as a present-or-absent object rather
   * than a boolean — `undefined` is meaningful here.
   *
   * The reason travels as a code, not as prose, because the server has no idea
   * which language the person reading the screen uses.
   */
  turnAvailability?: TurnAvailability;
}

export type TurnUnavailableReason = 'unsupported-platform' | 'not-installed';

export interface TurnAvailability {
  supported: boolean;
  reason?: TurnUnavailableReason;
  /**
   * The host is missing coturn but the server can install it on its own when
   * the relay is switched on (#431). Only meaningful with `not-installed`:
   * without it the operator has to run the script by hand.
   */
  autoInstallable?: boolean;
}

/**
 * Which part of the coturn installation is running (#438).
 *
 * A code rather than a sentence: the server does not know the language of
 * whoever is watching the progress bar.
 */
export type TurnInstallStage = 'refreshing' | 'installing' | 'configuring';

export interface WebRtcSignalPayload {
  /** Peers are addressed per connection, not per person (#309). */
  targetSessionId: string;
  fromSessionId: string;
  signalType: 'offer' | 'answer' | 'candidate' | 'user-left' | 'screen-audio-meta' | 'screen-video-meta';
  sdp?: any; // RTCSessionDescriptionInit
  candidate?: any; // RTCIceCandidateInit
  streamId?: string; // For screen-audio-meta/screen-video-meta: the MediaStream ID of the screen track
}

export interface BandwidthSettings {
  maxUploadKbps: number;
  maxDownloadKbps: number;
  qualityPreset: 'ECONOMIC' | 'NORMAL' | 'HIGH' | 'GAMING' | 'ULTRA';
}
