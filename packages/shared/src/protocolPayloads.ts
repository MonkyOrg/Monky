/**
 * What each message of the protocol carries, by direction (SHARED-CLI-11).
 *
 * `MessageType` (protocol.ts) names a message; these maps name its payload.
 * Senders are held to them: the desktop client and the bot SDK when sending,
 * the server when sending, broadcasting or projecting a message. A type used
 * both ways appears in both maps, with the payload of each direction.
 *
 * Nothing here validates: a payload that arrives still goes through its zod
 * schema where the receiver checks one. Requests checked by a schema are typed
 * with its input (`z.input`), which is exactly what the receiver accepts.
 */
import type { z } from 'zod';
import type {
  AdminDeafenUserPayload, AdminKickVoicePayload, AdminMoveUserPayload, AdminMuteUserPayload, AdminVoiceRestrictionsGetPayload,
  AuthChallengePayload, AuthChallengeResponsePayload, AuthConnectPayload, AuthFailedPayload, AuthSuccessPayload,
  BotCommandMessagePayload, BotCreatedPayload, BotCreatePayload, BotInstalledPayload, BotInstallPayload, BotListResponsePayload,
  BotProfileUpdatedPayload, BotProfileUpdatePayload, BotRevokedPayload, BotRevokePayload, BotSettingsGetPayload,
  BotSettingsListResponsePayload, BotSettingsSnapshotPayload, BotSettingsUpdatePayload, CategoriesUpdatedPayload,
  CategoryCreatePayload, CategoryDeletePayload, CategoryReorderPayload, CategoryUpdatePayload, ChannelCreatedPayload,
  ChannelCreatePayload, ChannelDeletedPayload, ChannelDeletePayload, ChannelReorderPayload, ChannelsReorderedPayload,
  ChannelUpdatedPayload, ChannelUpdatePayload, ChatDeletePayload, ChatEditPayload, ChatHistoryPayload, ChatLoadHistoryPayload,
  ChatMentionsReadPayload, ChatMessageUpdatedPayload, ChatRequestUploadTokenPayload, ChatRestorePayload, ChatSendPayload,
  ChatUploadTokenPayload, CommandAutocompleteCancelPayload, CommandAutocompleteExecutionPayload, CommandAutocompletePayload,
  CommandAutocompleteResultPayload, CommandCancelPayload, CommandExecutionPayload, CommandFinishedPayload, CommandFinishPayload,
  CommandInvokedPayload, CommandInvokePayload, CommandPromptPayload, CommandPromptReceivedPayload, CommandRegisteredPayload,
  CommandRegisterPayload, CommandResponsePayload, CommandsListResponsePayload, CommandSoundDownloadCancelPayload,
  CommandSoundDownloadPayload, CommandSoundDownloadReceivedPayload, CommandSoundDownloadResultPayload, CommandSubmitPayload,
  DmRelayAckPayload, DmRelayDeliverPayload, DmRelaySendPayload, GameShareAnsweredPayload, GameShareClosedPayload,
  GameShareRequestedPayload, GameShareRequestPayload, GameShareRequestSentPayload, GameShareResponsePayload, MemberKickedPayload,
  MemberKickPayload, MessageType, RecentSoundRecordPayload, RoleAssignPayload, RoleCreatePayload, RoleDeletePayload,
  RolesListPayload, RoleUnassignPayload, RoleUpdatePayload, RtcDiagnosticsReportPayload, ServerErrorPayload,
  ServerInviteInfoPayload, ServerSettingsUpdatedPayload, ServerShutdownPayload, ServerUpdateSettingsPayload,
  SfuCloseWebRtcTransportPayload, SfuConnectWebRtcTransportPayload, SfuConsumedPayload, SfuConsumePayload,
  SfuConsumerClosedPayload, SfuConsumerSetPausedPayload, SfuCreateWebRtcTransportPayload, SfuGetProducersPayload,
  SfuGetRouterRtpCapabilitiesPayload, SfuNewProducerPayload, SfuProducedPayload, SfuProducePayload, SfuProducerClosedPayload,
  SfuProducerSetPausedPayload, SfuProducersListPayload, SfuRouterRtpCapabilitiesPayload, SfuWebRtcTransportCreatedPayload,
  SoundboardPlayedPayload, SoundboardPlayPayload, SoundboardStoppedPayload, SoundboardStopPayload, TurnInstallProgressPayload,
  UserChangeNicknamePayload, UserConnectionStatePayload, UserJoinedPayload, UserLeftPayload, UserUpdateActivityPayload,
  UserUpdateAvatarPayload, UserUpdateBrbPayload, UserUpdateCustomStatusPayload, UserUpdatedPayload,
  UserUpdateVisibilityPayload, VoiceAfkPayload, VoiceJoinPayload, VoiceLeavePayload, VoiceReconnectPayload,
  VoiceRestrictionsUpdatedPayload, VoiceStateChangedPayload, VoiceStateUpdatePayload, VoiceUserJoinedPayload,
  VoiceUserLeftPayload, ProtocolMessage,
} from './protocol.js';
import type { ChatMessage, WebRtcSignalPayload } from './models.js';
import type {
  CommunitySettingsUpdate, CommunitySnapshot, EventControl, EventInterestedList, EventInterestedListResult, EventSave,
  LiveActionCreate, LiveActionRecord, LiveActionSubmission, LiveActionUpdate,
  communityImageUploadResultSchema, communityImageUploadSchema, eventIdRequestSchema, eventInterestSchema, eventListSchema,
  eventResultSchema, eventStartedSchema, liveActionIdSchema, liveActionSubmitSchema,
} from './serverCommunity.js';
import type { ForumCreatePost, ForumDeletePost, ForumList, ForumListResult, ForumPostSaved, ForumUpdatePost } from './forum.js';
import type { MessageSearchPayload, MessageSearchResultPayload } from './messageSearch.js';
import type {
  BotSelector, BotSelectorCreate, BotSelectorPublic, BotSelectorRespondedPayload,
  botSelectorFinalizeSchema, botSelectorIdSchema, botSelectorListSchema, botSelectorRespondSchema, botSelectorUpdateSchema,
} from './botSelectors.js';
import type {
  BotScreen, BotScreenAction, BotScreenActionEvent, BotScreenCreate, BotScreenRemoved,
  botScreenListResultSchema, botScreenListSchema, botScreenRefSchema, botScreenUpdateSchema,
} from './botScreens.js';
import type {
  BotStorageInfo, BotStorageLevelEvent, BotStorageList, BotStorageListResult, BotStorageLimitUpdate, BotStorageObjectInfo,
  BotStoragePut, BotStorageUsage,
  botStorageClearSchema, botStorageDeletedSchema, botStorageGetResultSchema, botStorageInfoGetSchema, botStorageKeyRequestSchema,
  botStorageUsageRequestSchema,
} from './botStorage.js';
import type { BotVoiceContextRequest, BotVoiceContextResult } from './botVoice.js';
import type {
  LocalMediaSignal, LocalSourceRequest, LocalSourceResult, LocalTaskAccept, LocalTaskControl, LocalTaskEvent, LocalTaskOffer,
  LocalTaskRequest,
} from './localExecutionProtocol.js';
import type { NativePoll, NativePollCreate, NativePollEdit, NativePollVote, NativePollVoters, nativePollIdSchema } from './nativePolls.js';
import type {
  NativeLiveForm, NativeLiveFormCreate, NativeLiveFormResults, NativeLiveFormResultsRequest, NativeLiveFormSubmit,
  nativeLiveFormIdSchema,
} from './nativeLiveForms.js';
import type { RecentSoundDownload, RecentSoundEntry, RecentSoundsList } from './recentSounds.js';
import type { ServerAuditGetPayload, ServerAuditPagePayload } from './serverAudit.js';
import type { BotDiagnosticRequest, BotDiagnosticResult } from './botDiagnostics.js';
import type { BotPermissionsSnapshot, BotPermissionsUpdate, botPermissionsGetSchema } from './botPermissions.js';
import type { ChatReactionEventPayload, ChatReactionPayload } from './reactions.js';
import type { NativeScreenSignalPayload, ScreenViewersResult, nativeScreenSignalAckSchema, screenViewersRequestSchema } from './screenSharing.js';
import type {
  BotInstallPreview, CommandAudioPreviewExecutionPayload, CommandAudioPreviewPayload, CommandAudioPreviewResult,
  botInstallPreviewRequestSchema, botSettingsListSchema, commandAudioPreviewCancelSchema,
} from './botInteractions.js';
import type { ServerMonitorGetPayload, ServerMonitorSnapshotPayload } from './serverMonitor.js';

/** A message with nothing to say besides its type. */
export type EmptyPayload = Record<string, never>;

/** Payload of each message a client sends, a person's app or a bot. */
export interface ClientToServerPayloads {
  // Connection
  [MessageType.AUTH_CONNECT]: AuthConnectPayload;
  [MessageType.AUTH_CHALLENGE_RESPONSE]: AuthChallengeResponsePayload;
  [MessageType.BOT_DIAGNOSTIC]: BotDiagnosticRequest;
  [MessageType.PING]: { timestamp: number };
  /** Answer of older bots to a PING; servers ignore it. */
  [MessageType.PONG]: { timestamp: number };
  [MessageType.USER_LOGOUT]: EmptyPayload;

  // Chat
  [MessageType.CHAT_SEND]: ChatSendPayload;
  [MessageType.CHAT_REACTION_ADD]: ChatReactionPayload;
  [MessageType.CHAT_REACTION_REMOVE]: ChatReactionPayload;
  [MessageType.CHAT_LOAD_HISTORY]: ChatLoadHistoryPayload;
  [MessageType.CHAT_MENTIONS_READ]: ChatMentionsReadPayload;
  [MessageType.CHAT_EDIT]: ChatEditPayload;
  [MessageType.CHAT_DELETE]: ChatDeletePayload;
  [MessageType.CHAT_RESTORE]: ChatRestorePayload;
  [MessageType.CHAT_REQUEST_UPLOAD_TOKEN]: ChatRequestUploadTokenPayload;
  [MessageType.CHAT_SEARCH]: MessageSearchPayload;
  [MessageType.POLL_CREATE]: NativePollCreate;
  [MessageType.POLL_VOTE]: NativePollVote;
  [MessageType.POLL_CLOSE]: z.input<typeof nativePollIdSchema>;
  [MessageType.POLL_VOTERS]: z.input<typeof nativePollIdSchema>;
  [MessageType.POLL_EDIT]: NativePollEdit;
  [MessageType.POLL_GET]: z.input<typeof nativePollIdSchema>;
  [MessageType.FORUM_LIST]: ForumList;
  [MessageType.FORUM_CREATE_POST]: ForumCreatePost;
  [MessageType.FORUM_UPDATE_POST]: ForumUpdatePost;
  [MessageType.FORUM_DELETE_POST]: ForumDeletePost;

  // Server, channels, roles and members
  [MessageType.CHANNEL_CREATE]: ChannelCreatePayload;
  [MessageType.CHANNEL_UPDATE]: ChannelUpdatePayload;
  [MessageType.CHANNEL_DELETE]: ChannelDeletePayload;
  [MessageType.CHANNEL_REORDER]: ChannelReorderPayload;
  [MessageType.CATEGORY_CREATE]: CategoryCreatePayload;
  [MessageType.CATEGORY_UPDATE]: CategoryUpdatePayload;
  [MessageType.CATEGORY_DELETE]: CategoryDeletePayload;
  [MessageType.CATEGORY_REORDER]: CategoryReorderPayload;
  [MessageType.USER_CHANGE_NICKNAME]: UserChangeNicknamePayload;
  [MessageType.USER_UPDATE_AVATAR]: UserUpdateAvatarPayload;
  [MessageType.USER_UPDATE_VISIBILITY]: UserUpdateVisibilityPayload;
  [MessageType.USER_UPDATE_ACTIVITY]: UserUpdateActivityPayload;
  [MessageType.USER_UPDATE_BRB]: UserUpdateBrbPayload;
  [MessageType.USER_UPDATE_CUSTOM_STATUS]: UserUpdateCustomStatusPayload;
  [MessageType.SERVER_UPDATE_SETTINGS]: ServerUpdateSettingsPayload;
  [MessageType.SERVER_GET_INVITE_INFO]: EmptyPayload;
  [MessageType.SERVER_MONITOR_GET]: ServerMonitorGetPayload;
  [MessageType.SERVER_AUDIT_GET]: ServerAuditGetPayload;
  [MessageType.ROLE_CREATE]: RoleCreatePayload;
  [MessageType.ROLE_UPDATE]: RoleUpdatePayload;
  [MessageType.ROLE_DELETE]: RoleDeletePayload;
  [MessageType.ROLE_ASSIGN]: RoleAssignPayload;
  [MessageType.ROLE_UNASSIGN]: RoleUnassignPayload;
  [MessageType.MEMBER_KICK]: MemberKickPayload;
  [MessageType.DM_RELAY_SEND]: DmRelaySendPayload;

  // Community, events and live actions
  [MessageType.COMMUNITY_GET]: z.input<typeof eventListSchema>;
  [MessageType.COMMUNITY_IMAGE_UPLOAD]: z.input<typeof communityImageUploadSchema>;
  [MessageType.COMMUNITY_UPDATE_SETTINGS]: CommunitySettingsUpdate;
  [MessageType.EVENT_SAVE]: EventSave;
  [MessageType.EVENT_GET]: z.input<typeof eventIdRequestSchema>;
  [MessageType.EVENT_GET_INTERESTED]: EventInterestedList;
  [MessageType.EVENT_CONTROL]: EventControl;
  [MessageType.EVENT_INTEREST]: z.input<typeof eventInterestSchema>;
  [MessageType.LIVE_ACTION_CREATE]: LiveActionCreate;
  [MessageType.LIVE_ACTION_UPDATE]: LiveActionUpdate;
  [MessageType.LIVE_ACTION_CLOSE]: z.input<typeof liveActionIdSchema>;
  [MessageType.LIVE_ACTION_LIST]: EmptyPayload;
  [MessageType.LIVE_ACTION_SUBMIT]: z.input<typeof liveActionSubmitSchema>;
  [MessageType.NATIVE_FORM_CREATE]: NativeLiveFormCreate;
  [MessageType.NATIVE_FORM_SUBMIT]: NativeLiveFormSubmit;
  [MessageType.NATIVE_FORM_CLOSE]: z.input<typeof nativeLiveFormIdSchema>;
  [MessageType.NATIVE_FORM_RESULTS]: NativeLiveFormResultsRequest;

  // Voice, screens and their media
  [MessageType.VOICE_JOIN]: VoiceJoinPayload;
  [MessageType.VOICE_RECONNECT]: VoiceReconnectPayload;
  [MessageType.VOICE_LEAVE]: VoiceLeavePayload;
  [MessageType.VOICE_STATE_UPDATE]: VoiceStateUpdatePayload;
  [MessageType.VOICE_AFK]: VoiceAfkPayload;
  [MessageType.ADMIN_MUTE_USER]: AdminMuteUserPayload;
  [MessageType.ADMIN_DEAFEN_USER]: AdminDeafenUserPayload;
  [MessageType.ADMIN_GET_VOICE_RESTRICTIONS]: AdminVoiceRestrictionsGetPayload;
  [MessageType.ADMIN_KICK_VOICE]: AdminKickVoicePayload;
  [MessageType.ADMIN_MOVE_USER]: AdminMoveUserPayload;
  [MessageType.RTC_SIGNAL]: WebRtcSignalPayload;
  [MessageType.RTC_DIAGNOSTICS_REPORT]: RtcDiagnosticsReportPayload;
  [MessageType.NATIVE_SCREEN_SIGNAL]: NativeScreenSignalPayload;
  [MessageType.SCREEN_VIEWERS_GET]: z.input<typeof screenViewersRequestSchema>;
  [MessageType.SOUNDBOARD_PLAY]: SoundboardPlayPayload;
  [MessageType.SOUNDBOARD_STOP]: SoundboardStopPayload;
  [MessageType.RECENT_SOUND_RECORD]: RecentSoundRecordPayload;
  [MessageType.RECENT_SOUNDS_LIST]: EmptyPayload;
  [MessageType.RECENT_SOUND_DOWNLOAD]: { id: string };
  [MessageType.GAME_SHARE_REQUEST]: GameShareRequestPayload;
  [MessageType.GAME_SHARE_RESPONSE]: GameShareResponsePayload;
  [MessageType.SFU_GET_ROUTER_RTP_CAPABILITIES]: SfuGetRouterRtpCapabilitiesPayload;
  [MessageType.SFU_CREATE_WEBRTC_TRANSPORT]: SfuCreateWebRtcTransportPayload;
  [MessageType.SFU_CONNECT_WEBRTC_TRANSPORT]: SfuConnectWebRtcTransportPayload;
  [MessageType.SFU_CLOSE_WEBRTC_TRANSPORT]: SfuCloseWebRtcTransportPayload;
  [MessageType.SFU_PRODUCE]: SfuProducePayload;
  [MessageType.SFU_CONSUME]: SfuConsumePayload;
  [MessageType.SFU_PRODUCER_CLOSED]: SfuProducerClosedPayload;
  [MessageType.SFU_PRODUCER_SET_PAUSED]: SfuProducerSetPausedPayload;
  [MessageType.SFU_CONSUMER_CLOSED]: SfuConsumerClosedPayload;
  [MessageType.SFU_CONSUMER_SET_PAUSED]: SfuConsumerSetPausedPayload;
  [MessageType.SFU_GET_PRODUCERS]: SfuGetProducersPayload;

  // Bots: administration
  [MessageType.BOT_CREATE]: BotCreatePayload;
  [MessageType.BOT_LIST]: EmptyPayload;
  [MessageType.BOT_REVOKE]: BotRevokePayload;
  [MessageType.BOT_UPDATE_PROFILE]: BotProfileUpdatePayload;
  [MessageType.BOT_SETTINGS_LIST]: z.input<typeof botSettingsListSchema>;
  [MessageType.BOT_SETTINGS_GET]: BotSettingsGetPayload;
  [MessageType.BOT_SETTINGS_UPDATE]: BotSettingsUpdatePayload;
  [MessageType.BOT_PERMISSIONS_GET]: z.input<typeof botPermissionsGetSchema>;
  [MessageType.BOT_PERMISSIONS_UPDATE]: BotPermissionsUpdate;
  [MessageType.BOT_INSTALL_PREVIEW]: z.input<typeof botInstallPreviewRequestSchema>;
  [MessageType.BOT_INSTALL]: BotInstallPayload;
  [MessageType.BOT_STORAGE_INFO_GET]: z.input<typeof botStorageInfoGetSchema>;
  [MessageType.BOT_STORAGE_LIMIT_UPDATE]: BotStorageLimitUpdate;
  [MessageType.BOT_STORAGE_CLEAR]: z.input<typeof botStorageClearSchema>;

  // Bots: commands and interactions
  [MessageType.COMMAND_REGISTER]: CommandRegisterPayload;
  [MessageType.COMMANDS_LIST]: EmptyPayload;
  [MessageType.COMMAND_AUTOCOMPLETE]: CommandAutocompletePayload;
  [MessageType.COMMAND_AUTOCOMPLETE_RESULT]: CommandAutocompleteResultPayload;
  [MessageType.COMMAND_AUTOCOMPLETE_CANCEL]: CommandAutocompleteCancelPayload;
  [MessageType.COMMAND_AUDIO_PREVIEW]: CommandAudioPreviewPayload;
  [MessageType.COMMAND_AUDIO_PREVIEW_RESULT]: CommandAudioPreviewResult;
  [MessageType.COMMAND_AUDIO_PREVIEW_CANCEL]: z.input<typeof commandAudioPreviewCancelSchema>;
  [MessageType.COMMAND_INVOKE]: CommandInvokePayload;
  [MessageType.COMMAND_PROMPT]: CommandPromptPayload;
  [MessageType.COMMAND_SOUND_DOWNLOAD]: CommandSoundDownloadPayload;
  [MessageType.COMMAND_SOUND_DOWNLOAD_RESULT]: CommandSoundDownloadResultPayload;
  [MessageType.COMMAND_SUBMIT]: CommandSubmitPayload;
  [MessageType.COMMAND_CANCEL]: CommandCancelPayload;
  [MessageType.COMMAND_FINISH]: CommandFinishPayload;
  [MessageType.COMMAND_RESPONSE]: CommandResponsePayload;
  [MessageType.BOT_VOICE_CONTEXT]: BotVoiceContextRequest;
  [MessageType.SELECTOR_CREATE]: BotSelectorCreate;
  [MessageType.SELECTOR_LIST]: z.input<typeof botSelectorListSchema>;
  [MessageType.SELECTOR_UPDATE]: z.input<typeof botSelectorUpdateSchema>;
  [MessageType.SELECTOR_CLOSE]: z.input<typeof botSelectorIdSchema>;
  [MessageType.SELECTOR_RESPOND]: z.input<typeof botSelectorRespondSchema>;
  [MessageType.SELECTOR_FINALIZE]: z.input<typeof botSelectorFinalizeSchema>;
  [MessageType.BOT_SCREEN_CREATE]: BotScreenCreate;
  [MessageType.BOT_SCREEN_UPDATE]: z.input<typeof botScreenUpdateSchema>;
  [MessageType.BOT_SCREEN_CLOSE]: z.input<typeof botScreenRefSchema>;
  [MessageType.BOT_SCREEN_END]: z.input<typeof botScreenRefSchema>;
  [MessageType.BOT_SCREEN_LIST]: z.input<typeof botScreenListSchema>;
  [MessageType.BOT_SCREEN_ACTION]: BotScreenAction;
  [MessageType.BOT_STORAGE_PUT]: BotStoragePut;
  [MessageType.BOT_STORAGE_GET]: z.input<typeof botStorageKeyRequestSchema>;
  [MessageType.BOT_STORAGE_DELETE]: z.input<typeof botStorageKeyRequestSchema>;
  [MessageType.BOT_STORAGE_LIST]: BotStorageList;
  [MessageType.BOT_STORAGE_USAGE]: z.input<typeof botStorageUsageRequestSchema>;

  // Local execution
  [MessageType.BOT_LOCAL_SOURCE_REQUEST]: LocalSourceRequest;
  [MessageType.BOT_LOCAL_TASK_REQUEST]: LocalTaskRequest;
  [MessageType.BOT_LOCAL_TASK_ACCEPT]: LocalTaskAccept;
  [MessageType.BOT_LOCAL_TASK_CONTROL]: LocalTaskControl;
  [MessageType.BOT_LOCAL_TASK_EVENT]: LocalTaskEvent;
  [MessageType.BOT_LOCAL_MEDIA_SIGNAL]: LocalMediaSignal;
}

/** Payload of each message the server sends to a person's app or a bot. */
export interface ServerToClientPayloads {
  // Connection
  [MessageType.AUTH_CHALLENGE]: AuthChallengePayload;
  [MessageType.AUTH_SUCCESS]: AuthSuccessPayload;
  [MessageType.AUTH_FAILED]: AuthFailedPayload;
  [MessageType.BOT_DIAGNOSTIC_RESULT]: BotDiagnosticResult;
  [MessageType.PONG]: { timestamp: number };
  [MessageType.SERVER_ERROR]: ServerErrorPayload;
  [MessageType.SERVER_SHUTDOWN]: ServerShutdownPayload;

  // Chat
  [MessageType.CHAT_MESSAGE]: ChatMessage;
  [MessageType.CHAT_HISTORY]: ChatHistoryPayload;
  [MessageType.CHAT_MESSAGE_UPDATED]: ChatMessageUpdatedPayload;
  [MessageType.CHAT_UPLOAD_TOKEN]: ChatUploadTokenPayload;
  [MessageType.CHAT_REACTION_ADDED]: ChatReactionEventPayload;
  [MessageType.CHAT_REACTION_REMOVED]: ChatReactionEventPayload;
  [MessageType.CHAT_SEARCH_RESULTS]: MessageSearchResultPayload;
  [MessageType.POLL_UPDATED]: NativePoll;
  [MessageType.POLL_VOTERS_RESULT]: NativePollVoters;
  [MessageType.FORUM_LIST_RESULT]: ForumListResult;
  [MessageType.FORUM_POST_SAVED]: ForumPostSaved;

  // Server, channels, roles and members
  [MessageType.SERVER_SETTINGS_UPDATED]: ServerSettingsUpdatedPayload;
  [MessageType.SERVER_INVITE_INFO]: ServerInviteInfoPayload;
  [MessageType.SERVER_MONITOR_SNAPSHOT]: ServerMonitorSnapshotPayload;
  [MessageType.SERVER_AUDIT_PAGE]: ServerAuditPagePayload;
  [MessageType.TURN_INSTALL_PROGRESS]: TurnInstallProgressPayload;
  [MessageType.ROLES_LIST]: RolesListPayload;
  [MessageType.USER_JOINED]: UserJoinedPayload;
  [MessageType.USER_LEFT]: UserLeftPayload;
  [MessageType.USER_UPDATED]: UserUpdatedPayload;
  [MessageType.USER_CONNECTION_STATE]: UserConnectionStatePayload;
  [MessageType.MEMBER_KICKED]: MemberKickedPayload;
  [MessageType.CHANNEL_CREATED]: ChannelCreatedPayload;
  [MessageType.CHANNEL_UPDATED]: ChannelUpdatedPayload;
  [MessageType.CHANNEL_DELETED]: ChannelDeletedPayload;
  [MessageType.CHANNELS_REORDERED]: ChannelsReorderedPayload;
  [MessageType.CATEGORIES_UPDATED]: CategoriesUpdatedPayload;
  [MessageType.DM_RELAY_ACK]: DmRelayAckPayload;
  [MessageType.DM_RELAY_DELIVER]: DmRelayDeliverPayload;

  // Community, events and live actions
  /** Peers without `native-live-forms` receive it without the forms. */
  [MessageType.COMMUNITY_SNAPSHOT]: CommunitySnapshot | Omit<CommunitySnapshot, 'nativeForms'>;
  [MessageType.COMMUNITY_IMAGE_UPLOAD]: z.infer<typeof communityImageUploadResultSchema>;
  [MessageType.COMMUNITY_ACK]: EmptyPayload;
  [MessageType.EVENT_SAVED]: z.infer<typeof eventResultSchema>;
  [MessageType.EVENT_STARTED]: z.infer<typeof eventStartedSchema>;
  [MessageType.EVENT_INTERESTED_LIST]: EventInterestedListResult;
  [MessageType.LIVE_ACTION_SNAPSHOT]: LiveActionRecord;
  [MessageType.LIVE_ACTION_LIST_RESULT]: { liveActions: LiveActionRecord[] };
  [MessageType.LIVE_ACTION_SUBMITTED]: LiveActionSubmission;
  [MessageType.NATIVE_FORM_SNAPSHOT]: NativeLiveForm;
  [MessageType.NATIVE_FORM_RESULTS_RESULT]: NativeLiveFormResults;

  // Voice, screens and their media
  [MessageType.VOICE_USER_JOINED]: VoiceUserJoinedPayload;
  [MessageType.VOICE_RECONNECTED]: VoiceUserJoinedPayload;
  [MessageType.VOICE_USER_LEFT]: VoiceUserLeftPayload;
  [MessageType.VOICE_STATE_CHANGED]: VoiceStateChangedPayload;
  [MessageType.VOICE_RESTRICTIONS_UPDATED]: VoiceRestrictionsUpdatedPayload;
  [MessageType.ADMIN_KICK_VOICE]: AdminKickVoicePayload;
  [MessageType.ADMIN_MOVE_USER]: AdminMoveUserPayload;
  [MessageType.RTC_SIGNAL]: WebRtcSignalPayload;
  [MessageType.NATIVE_SCREEN_SIGNAL]: NativeScreenSignalPayload;
  [MessageType.NATIVE_SCREEN_SIGNAL_ACK]: z.infer<typeof nativeScreenSignalAckSchema>;
  [MessageType.SCREEN_VIEWERS_RESULT]: ScreenViewersResult;
  [MessageType.SOUNDBOARD_PLAYED]: SoundboardPlayedPayload;
  [MessageType.SOUNDBOARD_STOPPED]: SoundboardStoppedPayload;
  [MessageType.RECENT_SOUND_ADDED]: RecentSoundEntry;
  [MessageType.RECENT_SOUNDS_RESULT]: RecentSoundsList;
  [MessageType.RECENT_SOUND_DATA]: RecentSoundDownload;
  [MessageType.GAME_SHARE_REQUEST_SENT]: GameShareRequestSentPayload;
  [MessageType.GAME_SHARE_REQUESTED]: GameShareRequestedPayload;
  [MessageType.GAME_SHARE_ANSWERED]: GameShareAnsweredPayload;
  [MessageType.GAME_SHARE_CLOSED]: GameShareClosedPayload;
  [MessageType.SFU_ROUTER_RTP_CAPABILITIES]: SfuRouterRtpCapabilitiesPayload;
  [MessageType.SFU_WEBRTC_TRANSPORT_CREATED]: SfuWebRtcTransportCreatedPayload;
  [MessageType.SFU_WEBRTC_TRANSPORT_CONNECTED]: { channelId: string; transportId: string };
  [MessageType.SFU_WEBRTC_TRANSPORT_CLOSED]: SfuCloseWebRtcTransportPayload;
  [MessageType.SFU_PRODUCED]: SfuProducedPayload;
  [MessageType.SFU_CONSUMED]: SfuConsumedPayload;
  [MessageType.SFU_PRODUCER_CLOSED]: SfuProducerClosedPayload;
  [MessageType.SFU_PRODUCER_SET_PAUSED]: SfuProducerSetPausedPayload;
  [MessageType.SFU_CONSUMER_CLOSED]: SfuConsumerClosedPayload;
  [MessageType.SFU_CONSUMER_SET_PAUSED]: SfuConsumerSetPausedPayload;
  [MessageType.SFU_NEW_PRODUCER]: SfuNewProducerPayload;
  [MessageType.SFU_PRODUCERS_LIST]: SfuProducersListPayload;

  // Bots: administration
  [MessageType.BOT_CREATED]: BotCreatedPayload;
  [MessageType.BOT_LIST_RESPONSE]: BotListResponsePayload;
  [MessageType.BOT_REVOKED]: BotRevokedPayload;
  [MessageType.BOT_PROFILE_UPDATED]: BotProfileUpdatedPayload;
  [MessageType.BOT_SETTINGS_LIST_RESPONSE]: BotSettingsListResponsePayload;
  [MessageType.BOT_SETTINGS_SNAPSHOT]: BotSettingsSnapshotPayload;
  [MessageType.BOT_PERMISSIONS_SNAPSHOT]: BotPermissionsSnapshot;
  [MessageType.BOT_INSTALL_PREVIEW_RESULT]: BotInstallPreview;
  [MessageType.BOT_INSTALLED]: BotInstalledPayload;
  [MessageType.BOT_STORAGE_INFO]: BotStorageInfo;
  [MessageType.BOT_STORAGE_LEVEL]: BotStorageLevelEvent;

  // Bots: commands and interactions
  [MessageType.COMMAND_REGISTERED]: CommandRegisteredPayload;
  [MessageType.COMMANDS_LIST_RESPONSE]: CommandsListResponsePayload;
  [MessageType.COMMAND_AUTOCOMPLETE]: CommandAutocompleteExecutionPayload;
  [MessageType.COMMAND_AUTOCOMPLETE_RESULT]: CommandAutocompleteResultPayload;
  [MessageType.COMMAND_AUTOCOMPLETE_CANCEL]: CommandAutocompleteCancelPayload;
  [MessageType.COMMAND_AUDIO_PREVIEW]: CommandAudioPreviewExecutionPayload;
  [MessageType.COMMAND_AUDIO_PREVIEW_RESULT]: CommandAudioPreviewResult;
  [MessageType.COMMAND_AUDIO_PREVIEW_CANCEL]: z.infer<typeof commandAudioPreviewCancelSchema>;
  [MessageType.COMMAND_INVOKE]: CommandExecutionPayload;
  [MessageType.COMMAND_INVOKED]: CommandInvokedPayload;
  [MessageType.COMMAND_PROMPT]: CommandPromptReceivedPayload;
  [MessageType.COMMAND_SOUND_DOWNLOAD]: CommandSoundDownloadReceivedPayload;
  [MessageType.COMMAND_SOUND_DOWNLOAD_RESULT]: CommandSoundDownloadResultPayload;
  [MessageType.COMMAND_SOUND_DOWNLOAD_CANCEL]: CommandSoundDownloadCancelPayload;
  [MessageType.COMMAND_SUBMITTED]: CommandSubmitPayload;
  [MessageType.COMMAND_FINISHED]: CommandFinishedPayload;
  [MessageType.COMMAND_RESPONSE]: BotCommandMessagePayload;
  [MessageType.BOT_VOICE_CONTEXT_RESULT]: BotVoiceContextResult;
  [MessageType.SELECTOR_SNAPSHOT]: BotSelector | BotSelectorPublic;
  [MessageType.SELECTOR_LIST_RESULT]: { selectors: Array<BotSelector | BotSelectorPublic> };
  [MessageType.SELECTOR_RESPONDED]: BotSelectorRespondedPayload;
  [MessageType.BOT_SCREEN_SNAPSHOT]: BotScreen;
  [MessageType.BOT_SCREEN_LIST_RESULT]: z.infer<typeof botScreenListResultSchema>;
  [MessageType.BOT_SCREEN_ACTION_EVENT]: BotScreenActionEvent;
  [MessageType.BOT_SCREEN_REMOVED]: BotScreenRemoved;
  [MessageType.BOT_STORAGE_SAVED]: BotStorageObjectInfo;
  [MessageType.BOT_STORAGE_GET_RESULT]: z.infer<typeof botStorageGetResultSchema>;
  [MessageType.BOT_STORAGE_DELETED]: z.infer<typeof botStorageDeletedSchema>;
  [MessageType.BOT_STORAGE_LIST_RESULT]: BotStorageListResult;
  [MessageType.BOT_STORAGE_USAGE_RESULT]: BotStorageUsage;

  // Local execution
  [MessageType.BOT_LOCAL_SOURCE_RESULT]: LocalSourceResult;
  [MessageType.BOT_LOCAL_TASK_OFFER]: LocalTaskOffer;
  [MessageType.BOT_LOCAL_TASK_CONTROL]: LocalTaskControl;
  [MessageType.BOT_LOCAL_TASK_EVENT]: LocalTaskEvent;
  [MessageType.BOT_LOCAL_MEDIA_SIGNAL]: LocalMediaSignal;
}

export type ClientMessageType = keyof ClientToServerPayloads;
export type ServerMessageType = keyof ServerToClientPayloads;

/** One message a client sends, as it travels: its type names its payload. */
export type ClientMessage<K extends ClientMessageType = ClientMessageType> =
  { [T in K]: { type: T; requestId?: string; payload: ClientToServerPayloads[T] } }[K];

/** One message the server sends, as it travels: its type names its payload. */
export type ServerMessage<K extends ServerMessageType = ServerMessageType> =
  { [T in K]: { type: T; requestId?: string; payload: ServerToClientPayloads[T] } }[K];

/**
 * `[type, payload]` of a message a client sends, for senders that take them
 * as separate arguments: TypeScript checks the payload against the type.
 */
export type ClientMessageArgs = { [K in ClientMessageType]: [type: K, payload: ClientToServerPayloads[K]] }[ClientMessageType];

/** `[type, payload]` of a message the server sends. */
export type ServerMessageArgs = { [K in ServerMessageType]: [type: K, payload: ServerToClientPayloads[K]] }[ServerMessageType];

/**
 * Builds a server message from its type and payload. TypeScript cannot follow
 * that the type and the payload of separate arguments belong together, so the
 * implementation is untyped; the signature is what callers are held to.
 */
export function serverMessage(...message: [...ServerMessageArgs, requestId?: string]): ServerMessage;
export function serverMessage(type: MessageType, payload: unknown, requestId?: string): ProtocolMessage<unknown> {
  return { type, payload, requestId };
}

/** Builds a client message from its type and payload, held to the payload of its type like `serverMessage`. */
export function clientMessage(...message: [...ClientMessageArgs, requestId?: string]): ClientMessage;
export function clientMessage(type: MessageType, payload: unknown, requestId?: string): ProtocolMessage<unknown> {
  return { type, payload, requestId };
}
