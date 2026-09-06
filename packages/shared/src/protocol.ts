import { AttachmentStorageInfo, ChannelSummary, ChannelType, ChatMessage, Role, ServerDetails, TurnAvailability, TurnInstallStage, UserRoleSummary, UserSummary, VoiceMode, VoiceParticipantState, WebRtcSignalPayload } from './models.js';

export enum ProtocolErrorCode {
  AUTH_INVALID_PASSWORD = 'AUTH_INVALID_PASSWORD',
  NICKNAME_ALREADY_EXISTS = 'NICKNAME_ALREADY_EXISTS',
  NICKNAME_INVALID = 'NICKNAME_INVALID',
  CHANNEL_NOT_FOUND = 'CHANNEL_NOT_FOUND',
  CHANNEL_FULL = 'CHANNEL_FULL',
  MESSAGE_TOO_LONG = 'MESSAGE_TOO_LONG',
  RATE_LIMITED = 'RATE_LIMITED',
  /**
   * Tentativas de conexão limitadas por IP (#372). Separado de RATE_LIMITED
   * porque o cliente traduz por código: reusar aquele mostraria "você está
   * enviando mensagens rápido demais" para quem nem entrou no servidor.
   */
  AUTH_RATE_LIMITED = 'AUTH_RATE_LIMITED',
  AVATAR_TOO_LARGE = 'AVATAR_TOO_LARGE',
  AVATAR_INVALID_TYPE = 'AVATAR_INVALID_TYPE',
  ATTACHMENT_TOO_LARGE = 'ATTACHMENT_TOO_LARGE',
  ATTACHMENT_INVALID_TYPE = 'ATTACHMENT_INVALID_TYPE',
  STORAGE_FULL = 'STORAGE_FULL',
  SERVER_FULL = 'SERVER_FULL',
  PROTOCOL_VERSION_UNSUPPORTED = 'PROTOCOL_VERSION_UNSUPPORTED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  BAD_REQUEST = 'BAD_REQUEST',
  /**
   * The relay cannot run on the host. Kept apart from BAD_REQUEST so the
   * client can explain what to do instead of showing a generic message (#429).
   */
  TURN_UNAVAILABLE = 'TURN_UNAVAILABLE',
  /**
   * The SFU cannot carry media on this host — typically a UDP range that is
   * blocked or already taken. Same intent as TURN_UNAVAILABLE: the switch is
   * refused with an actionable reason instead of being accepted and silently
   * degrading to P2P (#515).
   */
  SFU_UNAVAILABLE = 'SFU_UNAVAILABLE',
}

export enum MessageType {
  // Client -> Server
  AUTH_CONNECT = 'AUTH_CONNECT',
  AUTH_CHALLENGE_RESPONSE = 'AUTH_CHALLENGE_RESPONSE',
  CHAT_SEND = 'CHAT_SEND',
  CHAT_LOAD_HISTORY = 'CHAT_LOAD_HISTORY',
  CHAT_MENTIONS_READ = 'CHAT_MENTIONS_READ',
  /** Client -> server: rewrite the content of a message the caller wrote (#504). */
  CHAT_EDIT = 'CHAT_EDIT',
  /** Client -> server: delete a message (own, or anyone's with MANAGE_SERVER) (#504). */
  CHAT_DELETE = 'CHAT_DELETE',
  CHAT_REQUEST_UPLOAD_TOKEN = 'CHAT_REQUEST_UPLOAD_TOKEN',
  CHANNEL_CREATE = 'CHANNEL_CREATE',
  CHANNEL_UPDATE = 'CHANNEL_UPDATE',
  CHANNEL_DELETE = 'CHANNEL_DELETE',
  CHANNEL_REORDER = 'CHANNEL_REORDER',
  USER_CHANGE_NICKNAME = 'USER_CHANGE_NICKNAME',
  USER_UPDATE_AVATAR = 'USER_UPDATE_AVATAR',
  SERVER_UPDATE_SETTINGS = 'SERVER_UPDATE_SETTINGS',
  ROLE_CREATE = 'ROLE_CREATE',
  ROLE_UPDATE = 'ROLE_UPDATE',
  ROLE_DELETE = 'ROLE_DELETE',
  ROLE_ASSIGN = 'ROLE_ASSIGN',
  ROLE_UNASSIGN = 'ROLE_UNASSIGN',
  VOICE_JOIN = 'VOICE_JOIN',
  VOICE_LEAVE = 'VOICE_LEAVE',
  VOICE_STATE_UPDATE = 'VOICE_STATE_UPDATE',
  ADMIN_MUTE_USER = 'ADMIN_MUTE_USER',
  ADMIN_DEAFEN_USER = 'ADMIN_DEAFEN_USER',
  ADMIN_KICK_VOICE = 'ADMIN_KICK_VOICE',
  ADMIN_MOVE_USER = 'ADMIN_MOVE_USER',
  MEMBER_KICK = 'MEMBER_KICK',
  RTC_SIGNAL = 'RTC_SIGNAL',
  RTC_DIAGNOSTICS_REPORT = 'RTC_DIAGNOSTICS_REPORT',
  PING = 'PING',
  USER_LOGOUT = 'USER_LOGOUT',
  SOUNDBOARD_PLAY = 'SOUNDBOARD_PLAY',
  /**
   * Client -> server, when the person who triggered a sound stops it. The audio
   * is broadcast once and then played by each listener on their own, so a stop
   * has to travel the same way or only the sender would fall silent (#499).
   */
  SOUNDBOARD_STOP = 'SOUNDBOARD_STOP',
  SERVER_GET_INVITE_INFO = 'SERVER_GET_INVITE_INFO',

  // SFU Client <-> Server Messages (#515)
  SFU_GET_ROUTER_RTP_CAPABILITIES = 'SFU_GET_ROUTER_RTP_CAPABILITIES',
  SFU_ROUTER_RTP_CAPABILITIES = 'SFU_ROUTER_RTP_CAPABILITIES',
  SFU_CREATE_WEBRTC_TRANSPORT = 'SFU_CREATE_WEBRTC_TRANSPORT',
  SFU_WEBRTC_TRANSPORT_CREATED = 'SFU_WEBRTC_TRANSPORT_CREATED',
  SFU_CONNECT_WEBRTC_TRANSPORT = 'SFU_CONNECT_WEBRTC_TRANSPORT',
  SFU_WEBRTC_TRANSPORT_CONNECTED = 'SFU_WEBRTC_TRANSPORT_CONNECTED',
  SFU_PRODUCE = 'SFU_PRODUCE',
  SFU_PRODUCED = 'SFU_PRODUCED',
  SFU_CONSUME = 'SFU_CONSUME',
  SFU_CONSUMED = 'SFU_CONSUMED',
  SFU_PRODUCER_CLOSED = 'SFU_PRODUCER_CLOSED',
  SFU_CONSUMER_CLOSED = 'SFU_CONSUMER_CLOSED',
  SFU_CONSUMER_SET_PAUSED = 'SFU_CONSUMER_SET_PAUSED',
  SFU_NEW_PRODUCER = 'SFU_NEW_PRODUCER',
  SFU_GET_PRODUCERS = 'SFU_GET_PRODUCERS',
  SFU_PRODUCERS_LIST = 'SFU_PRODUCERS_LIST',

  // Server -> Client
  AUTH_CHALLENGE = 'AUTH_CHALLENGE',
  AUTH_SUCCESS = 'AUTH_SUCCESS',
  AUTH_FAILED = 'AUTH_FAILED',
  SERVER_STATE = 'SERVER_STATE',
  ROLES_LIST = 'ROLES_LIST',
  SERVER_SETTINGS_UPDATED = 'SERVER_SETTINGS_UPDATED',
  /**
   * Server -> client, while coturn is being installed (#438). Purely
   * informational: a client that does not know it simply ignores it.
   */
  TURN_INSTALL_PROGRESS = 'TURN_INSTALL_PROGRESS',
  SERVER_INVITE_INFO = 'SERVER_INVITE_INFO',
  SERVER_SHUTDOWN = 'SERVER_SHUTDOWN',
  USER_JOINED = 'USER_JOINED',
  USER_LEFT = 'USER_LEFT',
  MEMBER_KICKED = 'MEMBER_KICKED',
  USER_UPDATED = 'USER_UPDATED',
  USER_CONNECTION_STATE = 'USER_CONNECTION_STATE',
  CHANNEL_CREATED = 'CHANNEL_CREATED',
  CHANNEL_UPDATED = 'CHANNEL_UPDATED',
  CHANNEL_DELETED = 'CHANNEL_DELETED',
  CHANNELS_REORDERED = 'CHANNELS_REORDERED',
  CHAT_MESSAGE = 'CHAT_MESSAGE',
  CHAT_HISTORY = 'CHAT_HISTORY',
  /** Server -> clients: an existing message was edited or deleted (#504). */
  CHAT_MESSAGE_UPDATED = 'CHAT_MESSAGE_UPDATED',
  CHAT_UPLOAD_TOKEN = 'CHAT_UPLOAD_TOKEN',
  VOICE_USER_JOINED = 'VOICE_USER_JOINED',
  VOICE_USER_LEFT = 'VOICE_USER_LEFT',
  VOICE_STATE_CHANGED = 'VOICE_STATE_CHANGED',
  SOUNDBOARD_PLAYED = 'SOUNDBOARD_PLAYED',
  /** Server -> clients in the channel: drop this user's ongoing sound (#499). */
  SOUNDBOARD_STOPPED = 'SOUNDBOARD_STOPPED',
  SERVER_ERROR = 'SERVER_ERROR',
  PONG = 'PONG',
}

export interface ProtocolMessage<T = any> {
  type: MessageType;
  requestId?: string;
  payload: T;
}

// Client Payloads
export interface AuthConnectPayload {
  protocolVersion: number;
  publicKey: string;
  nickname: string;
  password?: string;
  /**
   * Random id persisted per installation, letting the server tell "the same
   * device reconnecting" (replace the stale socket) from "another device of the
   * same person" (keep both) (#309).
   */
  deviceId?: string;
}

export interface AuthChallengePayload {
  nonce: string;
}

export interface AuthChallengeResponsePayload {
  signature: string;
}

export interface AuthFailedPayload {
  code?: ProtocolErrorCode;
  message: string;
}

export interface ChatSendPayload {
  channelId: string;
  content: string;
  // Ids of files already uploaded via POST /attachments to be linked to this
  // message (#11). `content` may be empty when the message is only attachments.
  attachmentIds?: string[];
}

// Client asks the server for a short-lived token authorizing an HTTP upload (#11).
export interface ChatRequestUploadTokenPayload {
  channelId: string;
}

// Server reply carrying the short-lived upload token and its expiry (#11).
export interface ChatUploadTokenPayload {
  token: string;
  expiresAt: number;
}

export interface ChatLoadHistoryPayload {
  channelId: string;
  beforeTimestamp?: number;
  limit?: number;
}

// Sent when the user opens a text channel, clearing any unread @-mentions for
// that user in that channel on the server so they are not re-delivered (#14).
export interface ChatMentionsReadPayload {
  channelId: string;
}

export interface ChannelCreatePayload {
  name: string;
  type: 'VOICE' | 'TEXT';
  maxParticipants?: number;
  isPrivate?: boolean;
  allowedRoleIds?: string[];
}

/**
 * Edits an existing channel (#384). Every field but `channelId` is optional and
 * only the ones present are changed, so the caller can flip privacy without
 * resending the name.
 */
export interface ChannelUpdatePayload {
  channelId: string;
  name?: string;
  maxParticipants?: number;
  isPrivate?: boolean;
  allowedRoleIds?: string[];
}

export interface ChannelDeletePayload {
  channelId: string;
}

/**
 * Reorders the channels of one kind (#471).
 *
 * The whole list is sent rather than a single "move this one here": the client
 * already knows the order it is showing, and sending it whole means the server
 * never has to guess what the other positions became.
 */
export interface ChannelReorderPayload {
  type: ChannelType;
  /** Every channel of that type, in the order they should appear. */
  orderedIds: string[];
}

/**
 * The new positions, broadcast after a reorder (#471). Only the channels the
 * recipient can already see are included, so a private channel is not revealed
 * by its position alone.
 */
export interface ChannelsReorderedPayload {
  positions: Array<{ channelId: string; position: number }>;
}

export interface UserChangeNicknamePayload {
  newNickname: string;
}

export interface UserUpdateAvatarPayload {
  avatarBase64: string | null; // Data URL, pure base64, or null to remove
  mimeType?: string;
}

export interface ServerUpdateSettingsPayload {
  name?: string;
  password?: string | null; // null or empty string removes the password
  allowSoundboard?: boolean;
  /** Enables or disables the `@todos` / `@everyone` mention (#464). */
  allowEveryoneMention?: boolean;
  /** Enables or disables editing of already-sent messages (#504). */
  allowMessageEdit?: boolean;
  /** Shows role badges to every member, or only to who holds the role (#530). */
  showRoleBadgesToEveryone?: boolean;
  iconBase64?: string | null; // Data URL, pure base64, or null to remove
  // Attachment storage limits in bytes (#11).
  maxAttachmentFileBytes?: number;
  maxAttachmentStorageBytes?: number;
  // Membership cap counted in registered members, or LIMITS.MAX_USERS_UNLIMITED
  // to remove the cap entirely (#403).
  maxUsers?: number;
  /** Voice topology mode: 'p2p' (mesh) or 'sfu' (selective forwarding unit) (#515). */
  voiceMode?: VoiceMode;
  /** Turn the host's TURN relay on or off (#425). Linux-only; see CoturnManager. */
  turnEnabled?: boolean;
}

export interface RoleCreatePayload {
  name: string;
  color?: string | null;
  permissions: number;
  position?: number;
  isDefault?: boolean;
}

export interface RoleUpdatePayload {
  roleId: string;
  name?: string;
  color?: string | null;
  permissions?: number;
  position?: number;
  isDefault?: boolean;
}

export interface RoleDeletePayload {
  roleId: string;
}

export interface RoleAssignPayload {
  userId: string;
  roleId: string;
}

export interface RoleUnassignPayload {
  userId: string;
  roleId: string;
}

export interface ChatEditPayload {
  channelId: string;
  messageId: string;
  content: string;
}

export interface ChatDeletePayload {
  channelId: string;
  messageId: string;
}

export interface SoundboardPlayPayload {
  channelId: string;
  soundName: string;
  audioBase64: string;
  mimeType?: string;
}

export interface SoundboardStopPayload {
  channelId: string;
}

export interface VoiceJoinPayload {
  channelId: string;
  isMuted?: boolean;
  isDeafened?: boolean;
}

export interface VoiceLeavePayload {
  channelId: string;
}

export interface VoiceStateUpdatePayload {
  isMuted?: boolean;
  isDeafened?: boolean;
  isSpeaking?: boolean;
  isCameraOn?: boolean;
  isScreenSharing?: boolean;
  isSharingScreenAudio?: boolean;
  /** See VoiceParticipantState.screenShareIds (#253). */
  screenShareIds?: string[];
}

export interface AdminMuteUserPayload {
  targetSessionId: string;
  muted: boolean;
}

export interface AdminDeafenUserPayload {
  targetSessionId: string;
  deafened: boolean;
}

export interface AdminKickVoicePayload {
  targetSessionId: string;
}

export interface AdminMoveUserPayload {
  targetSessionId: string;
  channelId: string;
}

export interface MemberKickPayload {
  targetUserId: string;
}

export interface MemberKickedPayload {
  userId: string;
  nickname: string;
}

/** Sent by a client when all P2P recovery attempts with a peer are exhausted. */
export interface RtcDiagnosticsReportPayload {
  targetSessionId: string;
  /** Why recovery was abandoned (e.g. 'ice_failed', 'watchdog_timeout'). */
  reason: string;
  iceGatheringState: string;
  signalingState: string;
  iceRestartAttempts: number;
  hardReconnectAttempts: number;
  localCandidate: RtcCandidateInfo | null;
  remoteCandidate: RtcCandidateInfo | null;
}

export interface RtcCandidateInfo {
  type: string;
  address?: string;
  port?: number;
  protocol?: string;
}

// Server Responses & Broadcast Payloads

/**
 * One ICE server the client should dial, shaped exactly like the browser's
 * `RTCIceServer` so it can be handed to `RTCPeerConnection` untouched (#425).
 *
 * TURN entries carry ephemeral credentials derived per user, so this is
 * deliberately sent in `AUTH_SUCCESS` (addressed to one client) rather than in
 * `ServerDetails`, which is broadcast.
 */
export interface IceServerConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface AuthSuccessPayload {
  server: ServerDetails;
  currentUser: UserSummary;
  roles?: Role[];
  userRoles?: UserRoleSummary[];
  ownerId?: string | null;
  myPermissions?: number;
  /**
   * STUN/TURN servers for this client's WebRTC connections (#425).
   *
   * Optional: servers released before TURN support omit it, and clients fall
   * back to their built-in STUN list, which is the previous behaviour.
   */
  iceServers?: IceServerConfig[];
}

export interface ServerErrorPayload {
  code: ProtocolErrorCode;
  message: string;
  requestId?: string;
  /**
   * Protocol version the server speaks, sent with
   * `PROTOCOL_VERSION_UNSUPPORTED` so the client can say *who* is outdated
   * instead of a generic "incompatible" message (#355). Optional because
   * servers released before this change never send it.
   */
  serverProtocolVersion?: number;
}

export interface ServerSettingsUpdatedPayload {
  name: string;
  hasPassword: boolean;
  allowSoundboard?: boolean;
  /** Current state of the `@todos` / `@everyone` mention (#464). */
  allowEveryoneMention?: boolean;
  /** Current state of the message-editing switch (#504). */
  allowMessageEdit?: boolean;
  /** Current state of the role badge visibility switch (#530). */
  showRoleBadgesToEveryone?: boolean;
  /** Current state of the voice/video topology mode ('p2p' | 'sfu') (#515). */
  voiceMode?: VoiceMode;
  iconUrl?: string | null;
  // Current attachment-storage limits + usage, so the settings UI stays in sync (#11).
  attachmentStorage?: AttachmentStorageInfo;
  // Membership cap in registered members; LIMITS.MAX_USERS_UNLIMITED means none (#403).
  maxUsers?: number;
  /** Current state of the host's TURN relay (#425). */
  turnEnabled?: boolean;
  /**
   * Relay availability as it stands *after* this update (#438).
   *
   * Switching the relay on can install coturn, which changes the answer to
   * "can this host relay?". Without sending it back, clients would keep the
   * availability from login and go on offering to install what is already
   * installed.
   */
  turnAvailability?: TurnAvailability;
}

/** Progress of an automatic coturn installation (#438). */
export interface TurnInstallProgressPayload {
  /** Steps already finished. */
  completed: number;
  total: number;
  /** Whole percent, so the client does not have to compute it. */
  percent: number;
  stage: TurnInstallStage;
}

/** The message in its state after the edit or deletion (#504). */
export interface ChatMessageUpdatedPayload {
  message: ChatMessage;
}

export interface SoundboardPlayedPayload {
  channelId: string;
  userId: string;
  userName: string;
  soundName: string;
  audioBase64: string;
  mimeType?: string;
}

export interface SoundboardStoppedPayload {
  channelId: string;
  userId: string;
}

export interface ServerShutdownPayload {
  reason?: string;
}

export interface UserJoinedPayload {
  user: UserSummary;
}

export interface UserLeftPayload {
  userId: string;
  /** The connection that went away; the person may still be online elsewhere (#309). */
  sessionId?: string;
  nickname: string;
}

export interface UserConnectionStatePayload {
  userId: string;
  sessionId?: string;
  nickname: string;
  status: 'reconnecting' | 'online';
}

export interface UserUpdatedPayload {
  user: UserSummary;
}

export interface ChannelCreatedPayload {
  channel: ChannelSummary;
}

export interface ChannelUpdatedPayload {
  channel: ChannelSummary;
}

export interface ChannelDeletedPayload {
  channelId: string;
}

export interface ChatHistoryPayload {
  channelId: string;
  messages: ChatMessage[];
}

export interface VoiceUserJoinedPayload {
  channelId: string;
  userId: string;
  sessionId: string;
  voiceState: VoiceParticipantState;
}

export interface VoiceUserLeftPayload {
  channelId: string;
  userId: string;
  sessionId: string;
}

export interface VoiceStateChangedPayload {
  voiceState: VoiceParticipantState;
}

export interface RolesListPayload {
  roles: Role[];
  userRoles: UserRoleSummary[];
}

export interface ServerNetworkInterface {
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  type: 'public' | 'lan' | 'vpn' | 'loopback';
  description: string;
}

export interface ServerInviteInfoPayload {
  port: number;
  serverName: string;
  publicIp?: string | null;
  networkInterfaces: ServerNetworkInterface[];
}

// SFU Payloads (#515)
export interface SfuGetRouterRtpCapabilitiesPayload {
  channelId: string;
}

export interface SfuRouterRtpCapabilitiesPayload {
  channelId: string;
  rtpCapabilities: any;
}

export interface SfuCreateWebRtcTransportPayload {
  channelId: string;
  direction: 'send' | 'recv';
}

export interface SfuWebRtcTransportCreatedPayload {
  channelId: string;
  direction: 'send' | 'recv';
  transportOptions: {
    id: string;
    iceParameters: any;
    iceCandidates: any[];
    dtlsParameters: any;
    sctpParameters?: any;
  };
}

export interface SfuConnectWebRtcTransportPayload {
  channelId: string;
  transportId: string;
  dtlsParameters: any;
}

export interface SfuProducePayload {
  channelId: string;
  transportId: string;
  kind: 'audio' | 'video';
  rtpParameters: any;
  appData?: Record<string, any>;
}

export interface SfuProducedPayload {
  channelId: string;
  id: string;
}

export interface SfuConsumePayload {
  channelId: string;
  transportId: string;
  producerId: string;
  rtpCapabilities: any;
}

export interface SfuConsumedPayload {
  channelId: string;
  id: string;
  producerId: string;
  kind: 'audio' | 'video';
  rtpParameters: any;
  producerSessionId: string;
  appData: Record<string, any>;
}

export interface SfuProducerClosedPayload {
  channelId: string;
  producerId: string;
}

export interface SfuConsumerClosedPayload {
  channelId: string;
  consumerId: string;
}

export interface SfuConsumerSetPausedPayload {
  channelId: string;
  consumerId: string;
  paused: boolean;
}

export interface SfuNewProducerPayload {
  channelId: string;
  producerId: string;
  producerSessionId: string;
  kind: 'audio' | 'video';
  appData: Record<string, any>;
}

export interface SfuGetProducersPayload {
  channelId: string;
}

export interface SfuProducersListPayload {
  channelId: string;
  producers: SfuNewProducerPayload[];
}
