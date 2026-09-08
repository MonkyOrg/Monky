import type { VoiceConnectionHealth } from './models.js';

export function aggregateTransportHealth(states: readonly string[]): VoiceConnectionHealth {
  if (states.some((s) => s === 'failed' || s === 'closed')) return 'failed';
  if (states.includes('disconnected')) return 'reconnecting';
  if (states.includes('connecting')) return 'connecting';
  // Mediasoup leaves an unused direction new until its first produce/consume.
  return states.includes('connected') ? 'connected' : 'connecting';
}
