import type {
  AuthSuccessPayload, ChatMessage, NativeScreenEvent, OverlayConfig, ScreenShareQuality, ServerDetails,
  ServerToClientPayloads, SoundboardPlayedPayload, UserActivity, UserSummary, VoiceMode,
} from '@monky/shared';
import type { SupportedLanguage } from '../i18n';
import type { VoiceBotScreensUpdated } from '../stores/botScreenStore';
import type { SavedServer } from '../stores/connectionStore';
import type { SettingsUpdate } from '../stores/settingsStore';
import type { CameraEffectError } from '../utils/cameraEffects';
import type { CommunityStartNotice } from './CommunityFeed';
import type { LocalExecutionTaskNotice } from './LocalExecutionController';
import type { ConnectionStatus, NetworkDisconnectedPayload, ServerShutdownNotice } from './NetworkClient';
import type { ScreenPictureInPictureRelease } from './ScreenPictureInPicture';
import type { SoundItem } from './SoundboardService';
import type { CameraState } from './VideoService';

/** `message.<TYPE>`: a message the server sent, as `NetworkClient` received it. */
export type ServerMessageEvents = {
  [K in keyof ServerToClientPayloads as `message.${K}`]: ServerToClientPayloads[K];
};

/** Why a native screen share stopped working, as the user is told. */
export type NativeScreenFailureNotice = Pick<Extract<NativeScreenEvent, { type: 'error' }>, 'reason' | 'code' | 'shareId'>;

/**
 * Every event of the app bus (`appEvents`) and what it carries (R-SHELL-8).
 *
 * A `void` event carries nothing: `appEvents.emit('voice.state_updated')`.
 * An emitter or a subscriber that disagrees with this map does not compile, so
 * a new event, or a new field in one, starts here.
 *
 * Server messages arrive typed by the protocol map (`ServerToClientPayloads`).
 * Nothing validates them on the way: a handler that does not trust the shape
 * takes `unknown` and checks it with the message's zod schema.
 *
 * The DM store keeps its own bus (`DmEvents`, in `stores/dmStore.ts`).
 */
export interface AppEvents extends ServerMessageEvents {
  /** A message type the protocol map leaves out (SERVER_STATE) or that is newer than this client. */
  [event: `message.${string}`]: unknown;

  // Connection and sessions
  'network.connected': AuthSuccessPayload;
  'network.disconnected': NetworkDisconnectedPayload;
  'network.disposed': void;
  'network.reconnecting': { attempt: number; delay: number };
  'network.server_shutdown': ServerShutdownNotice;
  'network.status': ConnectionStatus;
  'session.changed': { key: string | null };
  'session.connections_changed': void;
  'session.background_activity': { key: string };
  'session.voice_context_updated': { key: string };
  'navigation.home': void;
  'connection.saved_servers_changed': void;
  'connection.saved_server_online': SavedServer;
  'connection.manual_disconnect': { key: string };

  // Server on screen (serverStore, ParticipantManager)
  'server.updated': void;
  'server.meta_updated': ServerDetails;
  'server.members_updated': UserSummary[];
  'server.roles_updated': void;
  'server.commands_updated': void;
  'server.voice_restrictions_updated': void;
  'user.updated': UserSummary;
  'channel.selected': string;
  'participants.updated': void;
  'participants.speaking_changed': { sessionId: string; speaking: boolean };
  'community.updated': void;
  'community.event_started': CommunityStartNotice;

  // Chat (chatStore)
  'chat.message_added': ChatMessage;
  'chat.message_updated': ChatMessage;
  'chat.reactions_updated': ChatMessage;
  'chat.history_loaded': { channelId: string; messages?: ChatMessage[]; aroundMessageId?: string };
  'chat.message_edit_updated': { channelId: string };
  'chat.command_draft_updated': { channelId: string };
  'chat.bot_interaction_updated': { channelId: string; invocationId: string };
  'chat.commands_updated': void;
  'chat.mentions_updated': void;
  'chat.unread_updated': void;
  'chat.cleared': void;

  // Call (voiceStore, WebRtcManager, serverConnection)
  'voice.state_updated': void;
  'voice.channel_changed': string | null;
  'voice.call_ended': void;
  'voice.connection_changed': void;
  'voice.reconnecting_changed': boolean;
  'voice.speaking_changed': boolean;
  'voice.join_requested': void;
  'voice.rejoin_failed': { error: string };
  'voice.microphone_failed': { error: string };
  'voice.microphone_updated': void;
  'voice.mode_switched': { mode: VoiceMode };
  'voice.ping_updated': number | null;
  'voice.screen_watch_changed': { sessionId: string; shareId: string; watching: boolean };
  'voice.screen_watch_handoff': { sessionId: string; fromShareId: string; shareId: string };
  'voice.screen_quality_changed': { sessionId: string; shareId: string; quality: ScreenShareQuality };
  'voice.screen_audio_mute_changed': { sessionId: string; muted: boolean };
  'voice.miniapp_mute_changed': { botId: string; muted: boolean };
  'voice.bot_screens_updated': VoiceBotScreensUpdated;
  'voice.bot_screens_reload': void;
  'sfu.reconnecting': { reason: string };
  'sfu.reconnected': void;
  'remote.peer_degraded': { sessionId: string };
  'remote.peer_failed': { sessionId: string };
  'remote.peer_recovered': { sessionId: string };
  'user_volume.changed': { sessionId: string; volume: number };
  'screen_audio_volume.changed': { sessionId: string; volume: number };
  'miniapp_volume.changed': { botId: string; volume: number };

  // Local media (AudioProcessor, VideoService, CameraPublication)
  'local.speaking': boolean;
  'local.muted': boolean;
  'local.deafened': boolean;
  'local.camera_started': MediaStream;
  'local.camera_replaced': { stream: MediaStream; previousStream: MediaStream };
  'local.camera_stopped': void;
  'local.screen_started': { shareId: string; stream: MediaStream };
  'local.screen_stopped': string;
  /** The shared window was closed or the system stopped the capture; carries the share id. */
  'local.screen_ended_externally': string;
  'audio.processing_error': void;
  'camera.state_changed': CameraState;
  'camera.effects_error': CameraEffectError;
  'camera.publication_failed': unknown;
  'camera.error_notice': unknown;

  // Screen sharing and its picture-in-picture
  'native_screen.updated': void;
  'native_screen.capture_fallback': { shareId: string };
  'native_screen.source_failed': NativeScreenFailureNotice;
  'modal.open_screenshare_picker': void;
  'modal.screenshare_picker_opened': void;
  'modal.screenshare_picker_closed': void;
  'screen_pip.updated': ScreenPictureInPictureRelease | undefined;
  'screen_pip.stage_return': void;
  'screen_pip.return_to_call': { sessionKey: string; channelId: string };
  'stage.visibility_changed': boolean;
  'stage.bot_screens_changed': void;
  'game_presence.changed': UserActivity | null;
  'game_share.live_changed': boolean;
  'game_share.request_changed': void;

  // Soundboard (SoundboardService)
  'soundboard.sounds_loading': void;
  'soundboard.sounds_loaded': SoundItem[];
  'soundboard.loading_changed': void;
  'soundboard.played': SoundboardPlayedPayload;
  'soundboard.playback_started': { userId: string; userName: string | undefined; soundName: string; duration: number };
  'soundboard.playback_progress': {
    userId: string; userName: string | undefined; soundName: string; currentTime: number; duration: number; percent: number;
  };
  'soundboard.playback_changed': { userId: string };
  /** One playback finished; with no `userId`, every playback was stopped at once. */
  'soundboard.playback_ended': { userId?: string; soundName?: string; ended?: boolean; failed?: boolean };
  'soundboard.intensity': number | null;

  // Bots and local execution
  'bot.preferences_updated': { scope: string; customChanged: boolean };
  'bot.screens_updated': { channelId: string | null };
  'localExecution.task_failed': LocalExecutionTaskNotice;
  'localExecution.permission_revoked': { sessionKey: string; botId: string };

  // App shell
  'settings.updated': SettingsUpdate;
  'overlay_settings.updated': OverlayConfig;
  'overlay.state_changed': boolean;
  'i18n.language_changed': SupportedLanguage;
  'dm.open': string;
  'keybind.toggle_mute': void;
  'keybind.toggle_deafen': void;
  'keybind.toggle_camera': void;
  'keybind.toggle_screen_share': void;
  'keybind.toggle_soundboard_mute': void;
  'keybind.stop_soundboard': void;
}
