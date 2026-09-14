import { MessageType, botScreenSchema, botScreenRemovedSchema, botScreenListResultSchema } from '@monky/shared';
import { appEvents, type EventBus } from './EventBus';
import { botScreenStore, getActiveBotScreenStore } from '../stores/botScreenStore';
import type { ConnectionStatus } from './NetworkClient';
import { getBotVoiceContext, type BotVoiceContext } from '../utils/botVoice';

/** Capture the call's bundle before any async work; the visible text server may differ. */
export function bindBotScreenEvents(events: EventBus = appEvents): () => void {
  let context: BotVoiceContext | null = null;
  let connectionId: string | null = null;
  let generation = 0;
  let destroyed = false;
  let request: { context: BotVoiceContext; id: string } | null = null;
  let reload = false;

  const cancelLoad = (): void => {
    const pending = request;
    request = null;
    reload = false;
    if (pending) pending.context.session.client.cancelRequest(pending.id);
  };

  const load = async (): Promise<void> => {
    if (destroyed || !context) return;
    if (request) { reload = true; return; }
    const captured = context;
    const store = captured.session.botScreenStore;
    const version = store.version;
    const epoch = generation;
    const pending = { context: captured, id: crypto.randomUUID() };
    request = pending;
    try {
      const result = botScreenListResultSchema.parse(await captured.session.client.sendRequest<unknown>(
        MessageType.BOT_SCREEN_LIST, { channelId: captured.channelId }, pending.id,
      ));
      if (destroyed || epoch !== generation || request !== pending) return;
      const current = getBotVoiceContext();
      if (current?.session !== captured.session || current.channelId !== captured.channelId ||
          current.user.sessionId !== captured.user.sessionId || result.channelId !== captured.channelId) return;
      // A pushed snapshot can overtake the list response. Never roll it back.
      if (version !== store.version) { reload = true; return; }
      store.replace(captured.channelId, result.screens);
      store.setLoadFailed(false);
    } catch (error: unknown) {
      if (destroyed || epoch !== generation || request !== pending) return;
      console.warn('[Bot screens] Could not load the voice channel miniapps.', error);
      store.setLoadFailed(true);
    } finally {
      if (request === pending) {
        request = null;
        const retry = reload;
        reload = false;
        if (retry) void load();
      }
    }
  };

  const syncVoiceContext = (): void => {
    if (destroyed) return;
    const next = getBotVoiceContext();
    const nextConnection = next?.session.client.getConnectionId() ?? null;
    if (next?.session === context?.session && next?.channelId === context?.channelId &&
        next?.user.sessionId === context?.user.sessionId && nextConnection === connectionId) return;
    generation++;
    cancelLoad();
    const previous = context;
    context = next;
    connectionId = nextConnection;
    previous?.session.botScreenStore.clear();
    if (context) void load();
  };

  const unbind = [
    events.on(`message.${MessageType.BOT_SCREEN_SNAPSHOT}`, (payload: unknown) => {
      const parsed = botScreenSchema.safeParse(payload);
      const voice = getBotVoiceContext();
      if (parsed.success && voice?.session.botScreenStore === getActiveBotScreenStore() &&
          parsed.data.channelId === voice.channelId) botScreenStore.upsert(parsed.data);
    }),
    events.on(`message.${MessageType.BOT_SCREEN_REMOVED}`, (payload: unknown) => {
      const parsed = botScreenRemovedSchema.safeParse(payload);
      if (parsed.success) botScreenStore.remove(parsed.data);
    }),
    events.on('network.status', (status: ConnectionStatus) => {
      if (status !== 'CONNECTED') botScreenStore.clear();
    }),
    events.on('voice.channel_changed', syncVoiceContext),
    events.on('participants.updated', syncVoiceContext),
    events.on('server.updated', syncVoiceContext),
    events.on('server.roles_updated', syncVoiceContext),
    events.on('session.voice_context_updated', syncVoiceContext),
    events.on('voice.bot_screens_reload', () => { syncVoiceContext(); void load(); }),
  ];
  syncVoiceContext();
  return () => {
    destroyed = true;
    generation++;
    cancelLoad();
    for (const remove of unbind) remove();
  };
}
