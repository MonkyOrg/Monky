import type { NetworkClient } from '../../core/NetworkClient';
import type { ChatStore } from '../../stores/chatStore';
import type { ServerStore } from '../../stores/serverStore';
import type { ChatCommands } from './ChatCommands';
import type { ChatComposerController } from './ChatComposerController';
import type { ChatFeedController } from './ChatFeedController';
import type { ChatMessageActions } from './ChatMessageActions';
import type { MentionDropup } from './MentionDropup';

/**
 * What the parts of a channel chat share (R-CHAT-10): the session the view
 * belongs to, the channel on screen and each other. The ChatView builds the
 * parts once and hands itself to each of them as this context.
 */
export interface ChatContext {
  readonly container: HTMLElement;
  /** The stores and connection of the server the view was created for, not the one on screen now. */
  readonly store: ChatStore;
  readonly client: NetworkClient;
  readonly server: ServerStore;
  /** The channel on screen. */
  readonly channelId: string | null;
  /** Whether the view's server is still the one on screen. */
  isCurrentSession(): boolean;
  readonly feed: ChatFeedController;
  readonly composer: ChatComposerController;
  readonly actions: ChatMessageActions;
  readonly commands: ChatCommands;
  readonly mentions: MentionDropup;
}
