import type { ParticipantViewModel } from '../core/ParticipantManager';
import { sessionManager } from '../core/SessionManager';
import { getActiveServerStore, type ServerStore } from '../stores/serverStore';
import { voiceStore } from '../stores/voiceStore';

export function isParticipantSpeaking(
  participant: ParticipantViewModel | undefined,
  displayedServer: ServerStore = getActiveServerStore(),
): boolean {
  const channelId = voiceStore.currentVoiceChannelId;
  const call = voiceStore.voiceSessionKey ? sessionManager.get(voiceStore.voiceSessionKey) : undefined;
  const localSessionId = call?.serverStore.currentUser?.sessionId;
  const sessionId = participant?.user.sessionId;
  if (!participant || !channelId || !call || !localSessionId || !sessionId ||
      call.serverStore !== displayedServer || call.participants.get(sessionId) !== participant ||
      call.participants.get(localSessionId)?.voiceState?.channelId !== channelId ||
      participant.voiceState?.channelId !== channelId || participant.voiceState.sessionId !== sessionId ||
      voiceStore.getEffectiveDeafened()) return false;

  const local = sessionId === localSessionId;
  const state = local ? voiceStore : participant.voiceState;
  return (local ? voiceStore.isSpeaking : participant.isSpeaking) &&
    !state.isMuted && !state.isDeafened && !state.serverMuted && !state.serverDeafened;
}

export function voiceConnectionIndicator(ping: number | null, reconnecting = false, connecting = false) {
  if (reconnecting) return { quality: 'reconnecting', icon: 'signal_wifi_bad' } as const;
  if (connecting) return { quality: 'connecting', icon: 'sync' } as const;
  if (ping === null || !Number.isFinite(ping) || ping < 0) {
    return { quality: 'unknown', icon: 'rss_feed' } as const;
  }
  // Match the existing call-stage RTT thresholds.
  if (ping < 50) return { quality: 'good', icon: 'rss_feed' } as const;
  if (ping < 120) return { quality: 'medium', icon: 'rss_feed' } as const;
  return { quality: 'bad', icon: 'rss_feed' } as const;
}

export function participantConnectionIndicators(p: ParticipantViewModel, isSfu: boolean, isLocal: boolean) {
  if (isSfu) {
    const health = p.voiceState?.connectionHealth ?? 'connecting';
    return { isPeerFailed: health === 'failed', isConnecting: health === 'connecting' || health === 'reconnecting', isRelayed: false };
  }
  const isPeerFailed = !isLocal && (p.peerConnectionFailed ?? false);
  const isConnecting = !isLocal && !isPeerFailed && (p.isConnecting ?? false);
  return { isPeerFailed, isConnecting, isRelayed: !isLocal && !isPeerFailed && !isConnecting && (p.isRelayed ?? false) };
}
