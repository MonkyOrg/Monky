import { normalizeAudioOutputId } from '../utils/audioPreferences';

type AudioOutputSink = HTMLMediaElement | AudioContext;
const pending = new WeakMap<AudioOutputSink, Promise<void>>();

export function setAudioOutputSink(target: AudioOutputSink, deviceId: string): Promise<void> {
  const sinkId = normalizeAudioOutputId(deviceId);
  const apply = async () => {
    if (typeof target.setSinkId !== 'function') {
      if (sinkId) throw new Error('Audio output selection is unavailable');
      return;
    }
    if (target.sinkId !== sinkId) await target.setSinkId(sinkId);
  };
  // Serialize initial routing, live changes and rollback on each individual sink.
  const change = (pending.get(target) ?? Promise.resolve()).then(apply, apply);
  pending.set(target, change);
  return change;
}
