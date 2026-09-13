import { appEvents, type EventBus } from './EventBus';
import { sessionManager } from './SessionManager';
import { commandVoiceContextKey } from '../utils/botVoice';

/** Hidden channel drafts must lose stale choices too, even after leaving and rejoining the same room. */
export function bindBotVoiceCommandEvents(events: EventBus = appEvents): () => void {
  const refresh = (): void => {
    for (const session of sessionManager.getAll()) {
      session.chatStore.refreshVoiceCommandContexts((command) =>
        commandVoiceContextKey(command, session.client, session.serverStore));
    }
  };
  const unbind = [
    events.on('voice.channel_changed', refresh),
    events.on('session.voice_context_updated', refresh),
    events.on('participants.updated', refresh),
    events.on('server.updated', refresh),
    events.on('server.roles_updated', refresh),
  ];
  refresh();
  return () => { for (const remove of unbind) remove(); };
}
