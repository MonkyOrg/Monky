import { ProtocolErrorCode, canAccessChannel, type SlashCommand, type UserSummary } from '@monky/shared';
import type { NetworkClient } from '../core/NetworkClient';
import { sessionManager, type ServerSession } from '../core/SessionManager';
import type { ServerStore } from '../stores/serverStore';
import { voiceStore } from '../stores/voiceStore';

export interface BotVoiceContext {
  session: ServerSession;
  channelId: string;
  user: UserSummary;
}

/** The account may be in voice on another device. Only this connection counts. */
export function getBotVoiceContext(): BotVoiceContext | null {
  const channelId = voiceStore.currentVoiceChannelId;
  const key = voiceStore.voiceSessionKey;
  const session = key ? sessionManager.get(key) : undefined;
  const user = session?.serverStore.currentUser;
  if (!channelId || !session || session.client.getStatus() !== 'CONNECTED' || !user?.sessionId) return null;
  if (session.participants.get(user.sessionId)?.voiceState?.channelId !== channelId) return null;
  const channel = session.serverStore.getChannel(channelId);
  if (!channel || channel.type !== 'VOICE' ||
      !canAccessChannel(channel, session.serverStore.myPermissions, session.serverStore.getUserRoleIds(user.id))) return null;
  return { session, channelId, user };
}

export function commandVoiceError(
  command: Pick<SlashCommand, 'botId' | 'voiceRequirement'>, client: NetworkClient, server: ServerStore,
): ProtocolErrorCode | undefined {
  if (!command.voiceRequirement) return;
  const context = getBotVoiceContext();
  if (!context || context.session.client !== client || context.session.serverStore !== server) {
    return ProtocolErrorCode.BOT_VOICE_REQUIRED;
  }
  if (command.voiceRequirement === 'same-bot-channel' &&
      context.session.participants.getSessionsOfUser(command.botId)
        .some((participant) => participant.voiceState && participant.voiceState.channelId !== context.channelId)) {
    return ProtocolErrorCode.BOT_VOICE_CHANNEL_MISMATCH;
  }
}

/** Choices/previews are bound to the room and connection that authorized them. */
export function commandVoiceContextKey(command: Pick<SlashCommand, 'botId' | 'voiceRequirement'>, client: NetworkClient, server: ServerStore): string {
  if (!command.voiceRequirement) return '';
  const context = getBotVoiceContext();
  if (!context || context.session.client !== client || context.session.serverStore !== server) return `outside-voice:${command.voiceRequirement}`;
  // Joining the caller's room is part of playback, not a change of authorization.
  const otherBotRooms = command.voiceRequirement === 'same-bot-channel'
    ? context.session.participants.getSessionsOfUser(command.botId)
      .flatMap((participant) => participant.voiceState ? [participant.voiceState.channelId] : [])
      .filter((channelId) => channelId !== context.channelId).sort()
    : [];
  return JSON.stringify([command.voiceRequirement, client.sessionKey, client.getConnectionId(), context.user.sessionId, context.channelId, otherBotRooms]);
}
