import type { AuthSuccessPayload, VoiceReconnectPayload, VoiceUserJoinedPayload } from '@monky/shared';
import { MessageType } from '@monky/shared';
import { networkClient, RequestTimeoutError, type NetworkClient } from './NetworkClient';
import { sessionManager, sessionKeyFor, type ServerSession } from './SessionManager';
import { webRtcManager } from './WebRtcManager';
import { voiceStore } from '../stores/voiceStore';
import { clientLog } from './ClientLogService';
import { audioProcessor } from './AudioProcessor';
import { appEvents } from './EventBus';
import { t } from '../i18n';
import { videoService } from './VideoService';
import { screenAudioService } from './ScreenAudioService';

interface ClientIdentity {
  publicKey: string;
  clientId: string;
}

interface VoiceReconnectAdmission {
  transitionId: string;
  isCurrent: () => boolean;
}

let voiceAdmissionGeneration = 0;
let serverNavigationGeneration = 0;
const pendingServerOpens = new Map<string, {
  session: ServerSession;
  previous: ServerSession | null;
  promise: Promise<AuthSuccessPayload>;
}>();
const pendingVoiceAdmissions = new WeakMap<NetworkClient, Promise<void>>();
let activeVoiceAdmission: { generation: number; sessionKey: string; channelId: string } | null = null;

export function isVoiceAdmissionPending(sessionKey: string, channelId: string): boolean {
  return activeVoiceAdmission?.sessionKey === sessionKey && activeVoiceAdmission.channelId === channelId;
}

export function getServerSessionForAddress(host: string, port: number): ServerSession | undefined {
  const canonicalHost = (value: string) => {
    return value.trim().replace(/^wss?:\/\//i, '').replace(/^\[(.+)\]$/, '$1').toLowerCase();
  };
  const normalizedHost = canonicalHost(host);
  return sessionManager.get(sessionKeyFor(host, port)) ?? sessionManager.getAll()
    .find(session => session.port === port && canonicalHost(session.host) === normalizedHost);
}

export function assertServerBrowseAvailable(host: string, port: number): void {
  const session = getServerSessionForAddress(host, port);
  const key = session?.key ?? sessionKeyFor(host, port);
  if (voiceStore.voiceSessionKey === key && session?.client.getStatus() !== 'CONNECTED') {
    throw new Error(t('navigation.sessionReconnecting'));
  }
}

export function captureServerBrowseIntent(): () => boolean {
  const generation = serverNavigationGeneration;
  const previous = sessionManager.getActive();
  return () => generation === serverNavigationGeneration && sessionManager.getActive() === previous;
}

/**
 * Connects to a server and puts it on screen, keeping every server already
 * connected alive in the background (#400).
 *
 * Before this, entering a server tore the previous connection down, which
 * dropped the call and every unread message with it. Now walking into another
 * server is like opening another window on it: the previous one stays
 * connected, still receiving messages, and coming back to it is instant.
 */
export async function openServerSession(
  host: string,
  port: number,
  identity: ClientIdentity,
  nickname: string,
  password?: string
): Promise<AuthSuccessPayload> {
  clientLog.info('CONNECTION', `Opening server session: ${host}:${port}`, { nickname });
  const existing = getServerSessionForAddress(host, port);
  const key = existing?.key ?? sessionKeyFor(host, port);
  if (existing?.client.getStatus() === 'CONNECTED') {
    const { serverDetails, currentUser, voiceRestrictions } = existing.serverStore;
    if (!serverDetails || !currentUser) throw new Error(t('navigation.sessionNotReady'));
    serverNavigationGeneration++;
    sessionManager.activate(key);
    // Browsing an existing session is not another authentication handshake.
    return { server: serverDetails, currentUser, voiceRestrictions };
  }
  if (voiceStore.voiceSessionKey === key) {
    // Its own recovery owns the socket and voice admission. A navigation click
    // must not replace either while that call is reconnecting.
    assertServerBrowseAvailable(host, port);
  }

  const generation = ++serverNavigationGeneration;
  const pending = pendingServerOpens.get(key);
  const reusable = pending && pending.session === existing ? pending : undefined;
  const active = sessionManager.getActive();
  const activeAttempt = active ? pendingServerOpens.get(active.key) : undefined;
  const previous = active && active.client.getStatus() !== 'CONNECTED' && activeAttempt?.session === active
    ? activeAttempt.previous
    : active;
  const session = reusable?.session
    ?? sessionManager.create(existing?.host ?? host, existing?.port ?? port, nickname, password);
  sessionManager.activate(session.key);
  const operation = reusable ?? {
    session,
    previous,
    promise: session.client.connect(session.host, session.port, identity, nickname, password),
  };
  pendingServerOpens.set(key, operation);

  try {
    return await operation.promise;
  } catch (err) {
    clientLog.error('CONNECTION', `Failed to open session ${host}:${port}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    // Only dispose our failed attempt, never a replacement or the call's socket.
    if (sessionManager.get(key) === session && voiceStore.voiceSessionKey !== key
      && session.client.getStatus() !== 'CONNECTED') {
      sessionManager.remove(key);
    }
    // A late failure must not take the screen back from a newer navigation.
    if (generation === serverNavigationGeneration) {
      const previousSurvives = previous && sessionManager.get(previous.key) === previous
        && (previous.client.getStatus() === 'CONNECTED' || previous.serverStore.serverDetails);
      const fallback = previousSurvives ? previous : sessionManager.getAll()
        .find(candidate => candidate.client.getStatus() === 'CONNECTED');
      if (fallback) sessionManager.activate(fallback.key);
    }
    throw err;
  } finally {
    if (pendingServerOpens.get(key) === operation) pendingServerOpens.delete(key);
  }
}

/**
 * Connection of the server hosting the current call.
 *
 * Leaving a call has to talk to the server the call is on, which is not
 * necessarily the one on screen (#400) — the user may have walked over to
 * another server while still talking.
 */
export function callClient(): NetworkClient {
  const key = voiceStore.voiceSessionKey;
  const session = key ? sessionManager.get(key) : undefined;
  return session ? session.client : networkClient;
}

/**
 * Rejoins a captured server session, even when another server is on screen.
 * Admission and moderation must be confirmed before acquiring/publishing the
 * microphone; async continuations never resolve the visible server's proxies.
 */
export async function rejoinCallOnSession(
  sessionKey: string,
  channelId: string,
  reconnect?: VoiceReconnectAdmission
): Promise<void> {
  if (!reconnect && voiceStore.voiceSessionKey !== sessionKey) return;
  try {
    await joinCallOnSession(sessionKey, channelId, reconnect);
  } catch (error) {
    if (reconnect) throw error;
    if (error instanceof Error && error.name === 'AbortError') return;
    appEvents.emit('voice.rejoin_failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Initial joins, moves and reconnects share one admission boundary. A requested
 * channel is only an intention until its own correlated response is accepted.
 */
export async function joinCallOnSession(
  sessionKey: string,
  channelId: string,
  reconnect?: VoiceReconnectAdmission
): Promise<void> {
  clientLog.info('CONNECTION', `Requesting voice admission on session ${sessionKey}`, { channelId });
  const session = sessionManager.get(sessionKey);
  if (!session || session.client.getStatus() !== 'CONNECTED') throw new Error(t('voiceReconnect.unavailable'));
  const mySessionId = session.serverStore.currentUser?.sessionId;
  const myUserId = session.serverStore.currentUser?.id;
  if (!mySessionId || !myUserId) throw new Error(t('voiceReconnect.invalidResponse'));
  const cancelled = () => new DOMException('Voice admission was cancelled', 'AbortError');
  if (reconnect && (!reconnect.isCurrent() || voiceStore.voiceSessionKey !== sessionKey
    || voiceStore.currentVoiceChannelId !== channelId)) throw cancelled();

  const previousKey = voiceStore.voiceSessionKey;
  const previousChannelId = voiceStore.currentVoiceChannelId;
  const changingChannel = previousKey !== sessionKey || previousChannelId !== channelId;
  if (!reconnect) appEvents.emit('voice.join_requested');
  const generation = ++voiceAdmissionGeneration;
  const ownsSession = () => sessionManager.get(sessionKey) === session
    && session.client.getStatus() === 'CONNECTED'
    && session.serverStore.currentUser?.sessionId === mySessionId;
  const isCurrent = () => generation === voiceAdmissionGeneration && ownsSession()
    && voiceStore.voiceSessionKey === sessionKey
    && voiceStore.currentVoiceChannelId === channelId
    && (!reconnect || reconnect.isCurrent());
  const assertCurrent = () => {
    if (!isCurrent()) throw cancelled();
  };

  // Stop the old physical input before clearing server A's restrictions for B.
  // Store/UI/PTT updates cannot reopen an ended track, and incoming peer
  // announcements cannot publish anything while the transports are suspended.
  audioProcessor.setMuted(true);
  audioProcessor.stopMicrophone();
  webRtcManager.suspendForVoiceReconnect(true);
  const stoppedScreenAudio = changingChannel ? screenAudioService.stop() : null;
  if (changingChannel) {
    videoService.stopScreenShare();
    webRtcManager.clearLocalScreenTracks();
    voiceStore.setScreenSharing(false);
    if (previousKey && previousKey !== sessionKey && previousChannelId) {
      sessionManager.get(previousKey)?.client.send(MessageType.VOICE_LEAVE, { channelId: previousChannelId });
    }
  }
  voiceStore.setChannel(channelId, sessionKey);
  voiceStore.setConnectionHealth('connecting');
  activeVoiceAdmission = { generation, sessionKey, channelId };

  try {
    if (stoppedScreenAudio) await stoppedScreenAudio;
    assertCurrent();
    // Two requests on one socket must not race the server's async admission.
    // Other servers remain independent, and a superseded queued join never
    // reaches the wire. Cleanup of a late admission precedes its successor.
    const preceding = pendingVoiceAdmissions.get(session.client);
    const admission = (async () => {
      if (preceding) await preceding;
      assertCurrent();
      const payload = { channelId, isMuted: voiceStore.isMuted, isDeafened: voiceStore.isDeafened };
      try {
        const joined = await session.client.sendRequest<VoiceUserJoinedPayload>(
          reconnect ? MessageType.VOICE_RECONNECT : MessageType.VOICE_JOIN,
          reconnect ? { ...payload, transitionId: reconnect.transitionId } satisfies VoiceReconnectPayload : payload
        );
        assertCurrent();
        if (joined.sessionId !== mySessionId || joined.userId !== myUserId || joined.channelId !== channelId
          || joined.voiceState?.sessionId !== mySessionId || joined.voiceState.userId !== myUserId
          || joined.voiceState.channelId !== channelId || typeof joined.voiceState.serverMuted !== 'boolean'
          || typeof joined.voiceState.serverDeafened !== 'boolean' || !Array.isArray(joined.participants)) {
          throw new Error(t('voiceReconnect.invalidResponse'));
        }
        return joined;
      } catch (error) {
        if (!isCurrent()) {
          if (ownsSession()) session.client.send(MessageType.VOICE_LEAVE, { channelId });
          throw cancelled();
        }
        if (error instanceof RequestTimeoutError) {
          throw new Error(t(reconnect ? 'voiceReconnect.timeout' : 'voiceJoin.timeout'));
        }
        throw error;
      }
    })();
    const settled = admission.then(() => {}, () => {});
    pendingVoiceAdmissions.set(session.client, settled);
    void settled.then(() => {
      if (pendingVoiceAdmissions.get(session.client) === settled) pendingVoiceAdmissions.delete(session.client);
    });
    const joined = await admission;
    assertCurrent();
    if (joined.participants) session.participants.reconcileVoiceChannel(channelId, joined.participants);
    session.participants.updateVoiceState({
      ...joined.voiceState, isMuted: voiceStore.isMuted, isDeafened: voiceStore.isDeafened,
    });
    voiceStore.setServerMuted(joined.voiceState.serverMuted);
    voiceStore.setServerDeafened(joined.voiceState.serverDeafened);
    if (joined.voiceState.isMuted !== voiceStore.isMuted || joined.voiceState.isDeafened !== voiceStore.isDeafened) {
      session.client.send(MessageType.VOICE_STATE_UPDATE, {
        isMuted: voiceStore.isMuted, isDeafened: voiceStore.isDeafened,
      });
    }
    audioProcessor.setMuted(voiceStore.getEffectiveMuted());
    audioProcessor.setDeafened(voiceStore.getEffectiveDeafened());
    webRtcManager.setDeafened(voiceStore.getEffectiveDeafened());
    webRtcManager.setCurrentSessionId(mySessionId);

    let audioTrack: MediaStreamTrack | null = null;
    let microphoneError: Error | null = null;
    try {
      const stream = await audioProcessor.startMicrophone();
      if (!isCurrent()) {
        stream.getTracks().forEach((track) => track.stop());
        assertCurrent();
      }
      audioTrack = stream.getAudioTracks()[0] ?? null;
      if (!audioTrack || audioTrack.readyState !== 'live') throw new Error(t('voiceJoin.noAudioTrack'));
    } catch (error) {
      assertCurrent();
      if (error instanceof Error && error.name === 'AbortError') {
        // A device selection can supersede capture without cancelling admission.
        audioTrack = audioProcessor.getLocalAudioStream()?.getAudioTracks().find(track => track.readyState === 'live') ?? null;
      } else {
        audioTrack = null;
        audioProcessor.stopMicrophone();
        microphoneError = error instanceof Error ? error : new Error(String(error));
        clientLog.warn('AUDIO', 'Admitted to voice without a microphone', { error: microphoneError.message });
      }
    }
    webRtcManager.resumeAfterVoiceReconnect();
    await webRtcManager.setLocalAudioTrack(audioTrack);
    assertCurrent();
    if (webRtcManager.isSfuMode()) {
      await webRtcManager.initSfuForCurrentChannel();
    } else {
      for (const peer of session.participants.getInVoiceChannel(channelId)) {
        assertCurrent();
        if (session.serverStore.isMySession(peer.user.sessionId)) continue;
        await webRtcManager.connectToPeer(peer.user.sessionId || peer.user.id, true);
      }
      voiceStore.setReconnecting(false);
    }
    assertCurrent();
    if (microphoneError) appEvents.emit('voice.microphone_failed', { error: microphoneError.message });
    if (reconnect) appEvents.emit('voice.mode_switched', { mode: 'p2p' });
  } catch (error) {
    if (!isCurrent()) throw cancelled();
    if (reconnect) throw error;
    session.client.send(MessageType.VOICE_LEAVE, { channelId });
    audioProcessor.stopMicrophone();
    const stopAudio = screenAudioService.stop();
    videoService.stopCamera();
    videoService.stopScreenShare();
    webRtcManager.clearLocalScreenTracks();
    webRtcManager.closeAllPeers();
    voiceStore.reset();
    await stopAudio.catch((stopError: unknown) => {
      clientLog.error('AUDIO', 'Failed to stop screen audio after rejected admission', {
        error: stopError instanceof Error ? stopError.message : String(stopError),
      });
    });
    if (generation !== voiceAdmissionGeneration) throw cancelled();
    throw error;
  } finally {
    if (activeVoiceAdmission?.generation === generation) activeVoiceAdmission = null;
  }
}

/**
 * Brings an already-connected server back on screen without touching the
 * network: its socket and state were kept while it was in the background.
 *
 * A session that is merely present but not connected (it dropped and is
 * retrying) is refused, so the caller falls back to a real connection attempt
 * instead of showing an empty server.
 */
export function showServerSession(key: string): boolean {
  const session = sessionManager.get(key);
  if (!session || session.client.getStatus() !== 'CONNECTED') {
    clientLog.warn('CONNECTION', `Cannot show session ${key} — not connected`);
    return false;
  }
  clientLog.info('CONNECTION', `Showing server session: ${key}`);
  serverNavigationGeneration++;
  sessionManager.activate(key);
  return true;
}
