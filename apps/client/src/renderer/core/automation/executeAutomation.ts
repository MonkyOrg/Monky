import {
  AUTOMATION_TOOLS, AutomationError, MessageType, Permission, ProtocolErrorCode, communitySnapshotSchema, eventResultSchema, messageLengthLimitFor,
  type AutomationData, type AutomationGrant, type AutomationRequest, type AutomationResult,
  type ChatHistoryPayload, type ChatMessage,
} from '@monky/shared';
import { sessionManager, type ServerSession } from '../SessionManager';
import { BoundRequests, SessionBinding } from '../sessionBinding';
import { accessSignature } from '../../stores/serverStore';
import { voiceStore } from '../../stores/voiceStore';
import { isVoiceAdmissionPending, joinCallOnSession, leaveCurrentCall } from '../serverConnection';
import { ProtocolRequestError, RequestTimeoutError } from '../NetworkClient';
import { saveCommunityEvent } from '../communityEvents';

function authorized(grant: AutomationGrant): ServerSession[] {
  return sessionManager.getAll().filter(session => !!session.serverStore.currentUser && !!session.serverStore.serverDetails
    && grant.serverIds.includes(session.serverStore.serverDetails.id));
}

function connected(grant: AutomationGrant): ServerSession[] {
  return authorized(grant).filter(session => session.client.getStatus() === 'CONNECTED');
}

function currentCall(grant: AutomationGrant) {
  const session = authorized(grant).find(item => item.key === voiceStore.voiceSessionKey);
  return AUTOMATION_TOOLS.get_call_state.output.parse({ call: session && voiceStore.currentVoiceChannelId ? {
    sessionRef: session.client.getConnectionId(), channelId: voiceStore.currentVoiceChannelId,
    isMuted: voiceStore.isMuted, health: voiceStore.isConnecting ? 'connecting' : voiceStore.isReconnecting ? 'reconnecting' : 'connected',
  } : null });
}

/** A ServerSession contains passwords: only explicitly projected DTOs cross this boundary. */
export async function executeAutomation(request: AutomationRequest, signal: AbortSignal): Promise<AutomationResult> {
  const { command, grant } = request;
  let target: ServerSession | undefined;
  const requests = new BoundRequests({ cancelRequest: id => target?.client.cancelRequest(id) ?? false });
  const cancel = (): void => requests.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw new AutomationError('cancelled');
    if (!grant.capabilities.includes(AUTOMATION_TOOLS[command.tool].capability)) throw new AutomationError('not_authorized');
    const sessions = connected(grant);
    if (command.tool === 'get_state') return { ok: true, data: { connectedServers: sessions.length } };
    if (command.tool === 'list_servers') return { ok: true, data: { servers: sessions.flatMap(session => {
      const server = session.serverStore.serverDetails;
      return server ? [{ sessionRef: session.client.getConnectionId(), serverId: server.id, name: server.name, nickname: session.nickname }] : [];
    }) } };
    if (command.tool === 'get_call_state') return { ok: true, data: currentCall(grant) };
    target = (command.tool === 'leave_call' ? authorized(grant) : sessions)
      .find(session => session.client.getConnectionId() === command.args.sessionRef);
    if (!target) throw new AutomationError('disconnected');
    const session = target;
    // Leaving owns local resources and must remain possible during network recovery.
    if (command.tool === 'leave_call') {
      if (voiceStore.currentVoiceChannelId && (voiceStore.voiceSessionKey !== session.key || voiceStore.currentVoiceChannelId !== command.args.channelId)) {
        throw new AutomationError('call_conflict');
      }
      if (voiceStore.currentVoiceChannelId) leaveCurrentCall();
      return { ok: true, data: { left: true } };
    }
    const store = session.serverStore;
    const client = session.client;
    const binding = new SessionBinding(client, store, () => sessionManager.get(session.key) === session);
    const access = accessSignature(store);
    const ensureCurrent = (): void => {
      if (signal.aborted) throw new AutomationError('cancelled');
      if (binding.failure()) throw new AutomationError('disconnected');
      if (accessSignature(store) !== access) throw new AutomationError('not_authorized');
    };
    const requirePermission = (permission: Permission, channelId?: string): void => {
      if (!store.hasPermission(permission, channelId)) throw new AutomationError('not_authorized');
    };
    let data: AutomationData;
    switch (command.tool) {
      case 'list_channels':
        data = { channels: (store.serverDetails?.channels ?? []).map(({ id, name, type }) => ({ id, name, type })) };
        break;
      case 'list_members':
        data = { members: store.getMembersInDisplayOrder().map(({ id, nickname, status }) => ({ id, nickname, status: status ?? 'OFFLINE' })) };
        break;
      case 'read_messages': {
        requirePermission(Permission.READ_MESSAGES, command.args.channelId);
        const { channelId, limit, beforeTimestamp } = command.args;
        const result = await requests.send(id => client.sendRequest<ChatHistoryPayload>(MessageType.CHAT_LOAD_HISTORY, { channelId, limit, beforeTimestamp }, id));
        ensureCurrent();
        data = AUTOMATION_TOOLS.read_messages.output.parse({
          messages: result.messages.map(({ id, userId, content, createdAt }) => ({ id, userId, content, createdAt })),
          nextBeforeTimestamp: result.messages.length === limit ? Math.min(...result.messages.map(message => message.createdAt)) : null,
        });
        break;
      }
      case 'send_message': {
        requirePermission(Permission.SEND_MESSAGES, command.args.channelId);
        if (!store.serverDetails?.protocol?.features.includes('chat-delivery')) throw new AutomationError('feature_unavailable');
        const { channelId, content, clientMessageId } = command.args;
        const max = messageLengthLimitFor(store.serverDetails);
        if (max > 0 && content.length > max) throw new AutomationError('invalid_input');
        const result = await requests.send(id => client.sendRequest<ChatMessage>(MessageType.CHAT_SEND, { channelId, content, clientMessageId }, id));
        ensureCurrent();
        if (result.channelId !== channelId || result.id !== clientMessageId) throw new AutomationError('failed');
        if (store.hasPermission(Permission.READ_MESSAGES, channelId)) session.chatStore.addMessage(result);
        data = AUTOMATION_TOOLS.send_message.output.parse({ message: {
          id: result.id, userId: result.userId, content: result.content, createdAt: result.createdAt,
        } });
        break;
      }
      case 'list_events': {
        if (!store.serverDetails?.protocol?.features.includes('server-community')) throw new AutomationError('feature_unavailable');
        const snapshot = communitySnapshotSchema.parse(await requests.send(id => client.sendRequest(MessageType.COMMUNITY_GET, {}, id)));
        data = AUTOMATION_TOOLS.list_events.output.parse({ events: snapshot.events.filter(event => event.status === 'scheduled' || event.status === 'active') });
        break;
      }
      case 'create_event': {
        requirePermission(Permission.MANAGE_EVENTS);
        if (!store.serverDetails?.protocol?.features.includes('server-community')) throw new AutomationError('feature_unavailable');
        const event = await requests.send(id => saveCommunityEvent(client, { ...command.args.event, repeat: 'none' }, id));
        data = AUTOMATION_TOOLS.create_event.output.parse(eventResultSchema.parse(event));
        break;
      }
      case 'join_call': {
        const channelId = command.args.channelId;
        if (!store.serverDetails?.channels.some(channel => channel.id === channelId && channel.type === 'VOICE')) throw new AutomationError('invalid_input');
        requirePermission(Permission.VIEW_CHANNEL, channelId);
        if (voiceStore.currentVoiceChannelId) {
          if (voiceStore.voiceSessionKey !== session.key || voiceStore.currentVoiceChannelId !== channelId) throw new AutomationError('call_conflict');
          if (isVoiceAdmissionPending(session.key, channelId)) throw new AutomationError('call_conflict');
        } else {
          await joinCallOnSession(session.key, channelId, undefined, undefined, { signal, deferMicrophone: true });
        }
        data = currentCall(grant);
        break;
      }
    }
    ensureCurrent();
    return { ok: true, data };
  } catch (error) {
    if (signal.aborted) return { ok: false, code: 'cancelled' };
    if (error instanceof AutomationError) return { ok: false, code: error.code };
    if (error instanceof RequestTimeoutError) return { ok: false, code: AUTOMATION_TOOLS[command.tool].capability === 'read' ? 'disconnected' : 'unknown_outcome' };
    if (error instanceof ProtocolRequestError) return { ok: false, code: error.code === ProtocolErrorCode.PERMISSION_DENIED ? 'not_authorized'
      : error.code === ProtocolErrorCode.BAD_REQUEST ? 'invalid_input' : 'failed' };
    return { ok: false, code: 'failed' };
  } finally {
    signal.removeEventListener('abort', cancel);
    requests.cancel();
  }
}
