import { MessageType } from '@monky/shared';
import { appEvents } from './EventBus';
import { clientLog } from './ClientLogService';
import {
  createNetworkClient,
  setActiveNetworkClient,
  type NetworkClient,
} from './NetworkClient';
import {
  createParticipantManager,
  setActiveParticipantManager,
  type ParticipantManager,
} from './ParticipantManager';
import { silentBus } from './activeProxy';
import { setEventOrigin, setForegroundContext, setSessionEventRouter, isForegroundEvent, currentEventOrigin } from './sessionRouting';
import {
  createChatStore,
  setActiveChatStore,
  type ChatStore,
} from '../stores/chatStore';
import {
  createServerStore,
  setActiveServerStore,
  type ServerStore,
} from '../stores/serverStore';

/**
 * Everything that belongs to one server: its connection plus the state built
 * from it. Voice is deliberately absent — microphone, camera and peers are
 * physical resources the machine has only one of, so they stay global and
 * follow the user to whichever server they join a voice channel on (#400).
 */
export interface ServerSession {
  key: string;
  client: NetworkClient;
  serverStore: ServerStore;
  chatStore: ChatStore;
  participants: ParticipantManager;
  /** Credentials kept so the rail can show the session and reconnect it. */
  host: string;
  port: number;
  nickname: string;
  password?: string;
}

export function sessionKeyFor(host: string, port: number): string {
  const cleanHost = host.trim().replace(/^wss?:\/\//, '');
  return `ws://${cleanHost}:${port}`;
}

/**
 * Keeps one live connection per server and decides which one the UI is looking
 * at.
 *
 * The views were written against single global stores, so rather than rewriting
 * every call site the manager swaps which instance those globals resolve to.
 * Sessions that are not on screen keep receiving and storing their own data,
 * but through a silent bus, so nothing they do repaints the current view.
 */
export class SessionManager {
  private sessions: Map<string, ServerSession> = new Map();
  private activeKey: string | null = null;
  /** Session the global proxies currently resolve to — not always the visible
   * one, since `route()` borrows them while a background event is handled. */
  private installedBundle: ServerSession | null = null;

  public install(): void {
    setSessionEventRouter((sessionKey, event, emit) => this.route(sessionKey, event, emit));
  }

  public getActive(): ServerSession | null {
    return this.activeKey ? this.sessions.get(this.activeKey) ?? null : null;
  }

  public getActiveKey(): string | null {
    return this.activeKey;
  }

  public get(key: string): ServerSession | undefined {
    return this.sessions.get(key);
  }

  public getAll(): ServerSession[] {
    return Array.from(this.sessions.values());
  }

  public setAppearOffline(appearOffline: boolean): void {
    for (const session of this.sessions.values()) {
      const user = session.serverStore.currentUser;
      if (user) session.serverStore.updateCurrentUser({ ...user, invisible: appearOffline });
      if (session.client.getStatus() === 'CONNECTED') {
        session.client.send(MessageType.USER_UPDATE_VISIBILITY, { appearOffline });
      }
    }
  }

  public has(key: string): boolean {
    return this.sessions.has(key);
  }

  /** Sessions kept alive in the background, i.e. everything but the visible one. */
  public getBackground(): ServerSession[] {
    return this.getAll().filter((session) => session.key !== this.activeKey);
  }

  public create(host: string, port: number, nickname: string, password?: string): ServerSession {
    const key = sessionKeyFor(host, port);
    const existing = this.sessions.get(key);
    if (existing) {
      clientLog.info('CONNECTION', `Reusing existing session for ${host}:${port}`);
      existing.nickname = nickname;
      existing.password = password;
      return existing;
    }

    clientLog.info('CONNECTION', `Creating new session for ${host}:${port}`);
    const client = createNetworkClient();
    client.sessionKey = key;
    const session: ServerSession = {
      key,
      client,
      serverStore: createServerStore(),
      chatStore: createChatStore(),
      participants: createParticipantManager(),
      host,
      port,
      nickname,
      password,
    };
    this.mute(session);
    this.sessions.set(key, session);
    return session;
  }

  /**
   * Points the global stores at `key`. The previously visible session is not
   * torn down: it keeps its socket and its data, muted, ready to be shown again.
   */
  public activate(key: string): void {
    const session = this.sessions.get(key);
    if (!session || this.activeKey === key) return;
    clientLog.info('CONNECTION', `Activating session: ${key}`);

    const previous = this.getActive();
    if (previous) this.mute(previous);

    this.activeKey = key;
    session.serverStore.bus = appEvents;
    session.chatStore.bus = appEvents;
    session.participants.bus = appEvents;

    this.applyBundle(session);

    appEvents.emit('session.changed', { key });
  }

  /** Drops a session for good, closing its socket and discarding its state. */
  public remove(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    clientLog.info('CONNECTION', `Removing session: ${key}`);
    const wasActive = this.activeKey === key;
    session.client.dispose();
    this.sessions.delete(key);
    // The disconnect above may have already handed the screen to another
    // session, and clearing the key then would undo it.
    if (wasActive && this.activeKey === key) {
      this.activeKey = null;
      appEvents.emit('session.changed', { key: null });
    }
  }

  public removeAll(): void {
    clientLog.info('CONNECTION', `Removing all sessions (${this.sessions.size} active)`);
    // Background first: closing the visible one is what sends the user back to
    // the connection screen, so it has to be the last thing to happen.
    for (const session of this.getBackground()) this.remove(session.key);
    if (this.activeKey) this.remove(this.activeKey);
  }

  /** Points the global proxies at a session's bundle of state. */
  private applyBundle(session: ServerSession | null): void {
    if (!session) return;
    this.installedBundle = session;
    setActiveNetworkClient(session.client);
    setActiveServerStore(session.serverStore);
    setActiveChatStore(session.chatStore);
    setActiveParticipantManager(session.participants);
  }

  private mute(session: ServerSession): void {
    session.serverStore.bus = silentBus;
    session.chatStore.bus = silentBus;
    session.participants.bus = silentBus;
  }

  /**
   * Runs an emit with the stores temporarily pointing at the session the event
   * came from, so a background server writes into its own bundle instead of the
   * visible one. Restoring afterwards must be unconditional: handlers throw, and
   * leaving the globals pointing at a background server would corrupt the view.
   *
   * Restoring the *previous* values rather than fixed ones is what makes this
   * reentrant. Handlers do re-enter it — `sessionManager.remove()` disposes a
   * client, which emits its own status change — and restoring `true`/`null`
   * there would tell the outer handler it was dealing with the visible server.
   */
  private route(sessionKey: string, event: string, emit: () => void): void {
    const session = sessionKey ? this.sessions.get(sessionKey) : undefined;
    const previousForeground = isForegroundEvent();
    const previousOrigin = currentEventOrigin();

    if (!session || session.key === this.activeKey) {
      setEventOrigin(sessionKey || this.activeKey);
      try {
        emit();
      } finally {
        setEventOrigin(previousOrigin);
      }
      return;
    }

    const previousBundle = this.installedBundle ?? this.getActive();
    this.applyBundle(session);
    setForegroundContext(false);
    setEventOrigin(session.key);
    try {
      emit();
    } finally {
      setForegroundContext(previousForeground);
      setEventOrigin(previousOrigin);
      this.applyBundle(previousBundle);
    }

    // The background bundle notified nobody, so the rail is told separately
    // that this server now has something worth a badge (#400).
    if (event === `message.${MessageType.CHAT_MESSAGE}`) {
      appEvents.emit('session.background_activity', { key: session.key });
    }
  }
}

export const sessionManager = new SessionManager();
