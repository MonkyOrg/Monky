import type { ParticipantViewModel } from '../core/ParticipantManager';

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
