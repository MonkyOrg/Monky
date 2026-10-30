import { isMotionQualityPreset, type QualityPresetType, type QualityProfile } from '@monky/shared';

export type OutboundMediaKind = 'audio' | 'camera';

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
  return {
    encoding: { maxBitrate: profile.cameraBitrateKbps * 1000, maxFramerate: profile.cameraFps },
    degradationPreference: isMotionQualityPreset(preset) ? 'maintain-framerate' : 'maintain-resolution',
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
