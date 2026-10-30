import { silentBus } from './activeProxy';
import { createNetworkClient, networkClient, type NetworkClient } from './NetworkClient';
import { createParticipantManager, participantManager, type ParticipantManager } from './ParticipantManager';
import { sessionManager } from './SessionManager';
import { currentEventOrigin } from './sessionRouting';
import { createServerStore, serverStore, type ServerStore } from '../stores/serverStore';
import { voiceStore } from '../stores/voiceStore';

/** What a call uses from the server hosting it. */
export interface CallServer {
  readonly client: NetworkClient;
  readonly participants: ParticipantManager;
  readonly serverStore: ServerStore;
}

/** The server on screen, through the global proxies: what answers before any session exists. */
const visibleServer: CallServer = { client: networkClient, participants: participantManager, serverStore };

let closedServer: CallServer | null = null;

/**
 * Stands in for the server of a call whose session is gone: a connection that
 * never opens, so everything sent through it is dropped as on any closed
 * socket, and a roster that knows nobody. Its stores talk on the silent bus.
 */
function closedCallServer(): CallServer {
  if (!closedServer) {
    const participants = createParticipantManager();
    const store = createServerStore();
    participants.bus = silentBus;
    store.bus = silentBus;
    closedServer = { client: createNetworkClient(), participants, serverStore: store };
  }
  return closedServer;
}

/**
 * The server hosting the current call, by one rule everywhere (#400, R-VOICE-8).
 *
 * A call names its server session, and the user may be browsing another server
 * meanwhile. Once that session is gone the answer is null — never the server on
 * screen, which would carry the call's offers, candidates and state updates to
 * a server where nobody is in the call. Without a call, the server on screen
 * answers.
 */
export function callServer(): CallServer | null {
  const key = voiceStore.voiceSessionKey;
  if (key) return sessionManager.get(key) ?? null;
  return sessionManager.getActive() ?? visibleServer;
}

/**
 * The same server, for code that only talks to it. A call whose server is gone
 * gets a closed connection: sends are dropped and requests fail, exactly as
 * while its socket is down, and nothing reaches the server on screen.
 */
export function callServerOrClosed(): CallServer {
  return callServer() ?? closedCallServer();
}

/** Connection of the server hosting the current call — see `callServerOrClosed`. */
export function callClient(): NetworkClient {
  return callServerOrClosed().client;
}

/**
 * Whether the server event being handled came from the server hosting the call.
 *
 * Voice, microphone and peer connections are global — there is only one of
 * each machine-wide — so handlers that touch them must ignore events from the
 * other connected servers (#400).
 */
export function eventOwnsCall(): boolean {
  const voiceKey = voiceStore.voiceSessionKey;
  if (!voiceKey) return true;
  const origin = currentEventOrigin();
  return !origin || origin === voiceKey;
}

/**
 * The call as it was when an operation began. Signalling, publications and
 * queries outlive their await; checking `isCurrent()` afterwards keeps a late
 * result away from the call that replaced this one.
 */
export interface CallScope {
  readonly sessionKey: string | null;
  readonly channelId: string | null;
  /** Null once the call's server session is gone. */
  readonly server: CallServer | null;
  /** Still the same room, on the same server session, with the same sign-in. */
  isCurrent(): boolean;
}

export function captureCall(): CallScope {
  const sessionKey = voiceStore.voiceSessionKey;
  const channelId = voiceStore.currentVoiceChannelId;
  const server = callServer();
  // A reconnection keeps the session object but signs in again: a new call.
  const sessionId = server?.serverStore.currentUser?.sessionId;
  return {
    sessionKey,
    channelId,
    server,
    isCurrent: () => channelId !== null && server !== null
      && voiceStore.currentVoiceChannelId === channelId && voiceStore.voiceSessionKey === sessionKey
      && callServer() === server && server.serverStore.currentUser?.sessionId === sessionId,
  };
}
