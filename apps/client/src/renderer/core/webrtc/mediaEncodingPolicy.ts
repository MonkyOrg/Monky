import type { QualityPresetType, QualityProfile } from '@monky/shared';

export type OutboundMediaKind = 'audio' | 'camera' | 'screen';

export interface MediaEncodingPolicy {
  encoding: Pick<RTCRtpEncodingParameters, 'maxBitrate' | 'maxFramerate'>;
  degradationPreference?: RTCDegradationPreference;
}

/** Per sender/producer, not a total upload budget across P2P destinations. */
export function getMediaEncodingPolicy(
  kind: OutboundMediaKind,
  preset: QualityPresetType,
  profile: Readonly<QualityProfile>,
): MediaEncodingPolicy {
  if (kind === 'audio') return { encoding: { maxBitrate: profile.audioBitrateKbps * 1000 } };
  const screen = kind === 'screen';
  return {
    encoding: {
      maxBitrate: (screen ? profile.screenBitrateKbps : profile.cameraBitrateKbps) * 1000,
      maxFramerate: screen ? profile.screenFps : profile.cameraFps,
    },
    degradationPreference: preset === 'GAMING' ? 'maintain-framerate' : 'maintain-resolution',
  };
}

export function applyMediaEncodingPolicy(
  parameters: RTCRtpSendParameters,
  policy: MediaEncodingPolicy,
): boolean {
  // Encodings belong to negotiation; never manufacture a new one in setParameters().
  if (!parameters.encodings.length) return false;
  Object.assign(parameters.encodings[0], policy.encoding);
  if (policy.degradationPreference) parameters.degradationPreference = policy.degradationPreference;
  return true;
}
