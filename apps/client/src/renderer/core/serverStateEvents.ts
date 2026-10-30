import {
  MessageType,
  Permission,
  type AuthSuccessPayload,
  type CategoriesUpdatedPayload,
  type ChannelCreatedPayload,
  type ChannelDeletedPayload,
  type ChannelUpdatedPayload,
  type ChannelsReorderedPayload,
  type MemberKickedPayload,
  type RolesListPayload,
  type ServerSettingsUpdatedPayload,
  type UserConnectionStatePayload,
  type UserJoinedPayload,
  type UserLeftPayload,
  type UserUpdatedPayload,
} from '@monky/shared';
import { appEvents } from './EventBus';
import { networkClient } from './NetworkClient';
import { participantManager } from './ParticipantManager';
import { sessionManager } from './SessionManager';
import { currentEventOrigin, emitOutsideRouting, isForegroundEvent } from './sessionRouting';
import { eventOwnsCall } from './callScope';
import { syncSavedServer } from './savedServerSync';
import type { VoiceModeReconnect } from './VoiceModeReconnect';
import { webRtcManager } from './WebRtcManager';
import { chatStore } from '../stores/chatStore';
import { serverStore } from '../stores/serverStore';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { t } from '../i18n';

export interface ServerStateHost {
  /** Told about every settings change: switching the voice mode moves the call (#515). */
  readonly reconnect: Pick<VoiceModeReconnect, 'settingsUpdated'>;
}

/**
 * Fills the stores of the server that just signed this user in: the server,
 * its members and who is in each voice room. The stores resolve to that
 * server while its event is handled, in the background too (#400).
 */
export function hydrateServerSession(payload: AuthSuccessPayload): void {
  chatStore.setCommandUsageScope({ serverId: payload.server.id, callerId: payload.currentUser.id });
  serverStore.setServerDetails(payload.server, payload.currentUser);
  serverStore.updateVoiceRestrictions(payload.currentUser.id, payload.voiceRestrictions);
  // Seed unread @-mention badges, including mentions received while this
  // user was offline (#14).
  chatStore.setMentions(payload.server.mentionedChannelIds ?? []);
  participantManager.clear();
  participantManager.setUsers(payload.server.members);
  const knownVoiceUsers = new Map(payload.server.knownMembers?.map((user) => [user.id, user]));
  for (const state of Object.values(payload.server.voiceStates)) {
    // Invisible users are absent from the online member list, but their
    // physical voice session still exists and can still carry media.
    if (!participantManager.get(state.sessionId)) {
      const user = knownVoiceUsers.get(state.userId);
      if (user) participantManager.addUser({ ...user, sessionId: state.sessionId });
    }
    participantManager.updateVoiceState(state);
  }
}

/**
 * Applies an access change to the chat: a channel that can no longer be read
 * leaves the chat, and one where the member can no longer write or use bots
 * finishes the commands still running there. Without channels, every channel
 * of the server is checked.
 */
export function reconcileChannelAccess(channelIds?: readonly string[]): void {
  const ids = channelIds ?? (serverStore.serverDetails?.channels ?? []).map((channel) => channel.id);
  for (const channelId of ids) {
    if (!serverStore.hasPermission(Permission.READ_MESSAGES, channelId)) chatStore.revokeChannel(channelId);
    else if (!serverStore.hasPermission(Permission.SEND_MESSAGES, channelId)
      || !serverStore.hasPermission(Permission.USE_BOT_COMMANDS, channelId)) chatStore.finishChannelInvocations(channelId);
  }
}

/** Members, roles, channels and settings of every connected server. */
export function bindServerStateEvents(host: ServerStateHost): () => void {
  const unbind = [
    appEvents.on(`message.${MessageType.SERVER_SETTINGS_UPDATED}`, (payload: ServerSettingsUpdatedPayload) => {
      serverStore.applySettings(payload);
      serverStore.setTurnAvailability(payload.turnAvailability);
      const origin = currentEventOrigin();
      if (!origin) return;
      const session = sessionManager.get(origin);
      if (session) syncSavedServer(session, payload);
      host.reconnect.settingsUpdated(origin, payload);
      if (voiceStore.voiceSessionKey === origin) void webRtcManager.handleVoiceModeUpdate();
    }),

    appEvents.on(`message.${MessageType.USER_JOINED}`, (payload: UserJoinedPayload) => {
      serverStore.addMember(payload.user);
      participantManager.addUser(payload.user);
    }),

    appEvents.on(`message.${MessageType.ROLES_LIST}`, (payload: RolesListPayload) => {
      serverStore.updateRoles(payload.roles, payload.userRoles, payload.everyonePermissions);
      reconcileChannelAccess();
    }),

    appEvents.on(`message.${MessageType.USER_LEFT}`, (payload: UserLeftPayload) => {
      if (payload.sessionId) {
        participantManager.removeUser(payload.sessionId);
        // Peers belong to the call, which may live on another server (#400).
        if (eventOwnsCall()) webRtcManager.removePeer(payload.sessionId);
      }
      // Only drop the member row once the person has no device left online (#309).
      if (participantManager.getSessionsOfUser(payload.userId).length === 0) {
        if (serverStore.knownMembers.get(payload.userId)?.isBot) chatStore.finishBotInvocations(payload.userId);
        serverStore.removeMember(payload.userId);
      }
    }),

    appEvents.on(`message.${MessageType.MEMBER_KICKED}`, (payload: MemberKickedPayload) => {
      if (payload.userId === serverStore.currentUser?.id) {
        // We were removed from the server: return home with a notice. Being
        // kicked from a server we are not looking at only closes that session.
        if (isForegroundEvent()) {
          appEvents.emit('network.server_shutdown', { reason: t('app.kickedFromServerMessage') });
        }
        networkClient.disconnect('server');
        return;
      }
      serverStore.removeMemberCompletely(payload.userId);
      // A kick takes every device of that person down at once (#309).
      for (const session of participantManager.getSessionsOfUser(payload.userId)) {
        const key = session.user.sessionId || session.user.id;
        participantManager.removeUser(key);
        if (eventOwnsCall()) webRtcManager.removePeer(key);
      }
    }),

    appEvents.on(`message.${MessageType.USER_CONNECTION_STATE}`, (payload: UserConnectionStatePayload) => {
      // Reflect other users' temporary connection loss / recovery (#44).
      if (payload.sessionId) {
        participantManager.setReconnecting(payload.sessionId, payload.status === 'reconnecting');
      }
    }),

    appEvents.on(`message.${MessageType.USER_UPDATED}`, (payload: UserUpdatedPayload) => {
      serverStore.updateMember(payload.user);
      participantManager.updateUser(payload.user);
      if (payload.user.id !== serverStore.currentUser?.id) return;
      serverStore.updateCurrentUser(payload.user);
      const invisible = payload.user.invisible;
      // Another device changed the status: only servers that know "Volto já"
      // say anything about it, so the others must not clear it here.
      const brb = serverStore.serverDetails?.protocol?.features.includes('user-brb') ? payload.user.brb === true : undefined;
      if (typeof invisible !== 'boolean' && brb === undefined) return;
      emitOutsideRouting(() => {
        let changed = false;
        if (typeof invisible === 'boolean' && settingsStore.appearOffline !== invisible) {
          settingsStore.appearOffline = invisible;
          changed = true;
        }
        if (brb !== undefined && !settingsStore.appearOffline && settingsStore.brb !== brb) {
          settingsStore.brb = brb;
          changed = true;
        }
        if (changed) settingsStore.save();
      });
    }),

    appEvents.on(`message.${MessageType.CHANNEL_CREATED}`, (payload: ChannelCreatedPayload) => {
      serverStore.addChannel(payload.channel);
    }),

    appEvents.on(`message.${MessageType.CHANNEL_DELETED}`, (payload: ChannelDeletedPayload) => {
      serverStore.removeChannel(payload.channelId);
      chatStore.revokeChannel(payload.channelId);
    }),

    appEvents.on(`message.${MessageType.CHANNEL_UPDATED}`, (payload: ChannelUpdatedPayload) => {
      serverStore.updateChannel(payload.channel);
      reconcileChannelAccess([payload.channel.id]);
    }),

    appEvents.on(`message.${MessageType.CHANNELS_REORDERED}`, (payload: ChannelsReorderedPayload) => {
      serverStore.applyChannelPositions(payload.positions);
    }),

    appEvents.on(`message.${MessageType.CATEGORIES_UPDATED}`, (payload: CategoriesUpdatedPayload) => {
      serverStore.setCategories(payload.categories);
      reconcileChannelAccess();
    }),
  ];
  return () => unbind.forEach(off => off());
}
