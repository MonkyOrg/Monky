import type { SoundboardEditTimes } from './ipc';

export const SOUNDBOARD_EDIT_SAMPLE_RATE = 48000;

/** Produces PCM24 WAV without gain normalization or channel mixing. */
export function encodeSoundboardEdit(channels: readonly Float32Array[], sampleRate: number, times: SoundboardEditTimes): {
  bytes: Uint8Array;
  duration: number;
} {
  const frames = channels[0]?.length ?? 0;
  if (sampleRate !== SOUNDBOARD_EDIT_SAMPLE_RATE || channels.length < 1 || channels.length > 2 ||
      !frames ||
      channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frames)) {
    throw new RangeError('unsupported');
  }
  const { start, end, fadeIn, fadeOut } = times;
  if (![start, end, fadeIn, fadeOut].every(Number.isFinite) || start < 0 || end <= start ||
      end > frames / sampleRate || fadeIn < 0 || fadeOut < 0 || fadeIn + fadeOut > end - start + 1e-9) {
    throw new RangeError('invalid_request');
  }
  const first = Math.round(start * sampleRate);
  const count = Math.round(end * sampleRate) - first;
  const dataSize = count * channels.length * 3;
  const paddedSize = dataSize + (dataSize & 1);
  if (count < 1) throw new RangeError('invalid_request');
  // RIFF chunk sizes are unsigned 32-bit integers, independent of network limits.
  if (36 + paddedSize > 0xffffffff) throw new RangeError('too_large');
  const bytes = new Uint8Array(44 + paddedSize);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) bytes[offset + index] = value.charCodeAt(index);
  };
  text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * 3, true); view.setUint16(32, channels.length * 3, true);
  view.setUint16(34, 24, true); text(36, 'data'); view.setUint32(40, dataSize, true);
  const inFrames = Math.round(fadeIn * sampleRate);
  const outFrames = Math.round(fadeOut * sampleRate);
  let offset = 44;
  for (let frame = 0; frame < count; frame++) {
    const gain = Math.min(1, inFrames > 0 ? frame / inFrames : 1, outFrames > 0 ? (count - 1 - frame) / outFrames : 1);
    for (const channel of channels) {
      const sample = channel[first + frame];
      if (!Number.isFinite(sample)) throw new RangeError('invalid_request');
      const scaled = Math.max(-1, Math.min(1, sample * gain));
      const value = Math.min(8388607, Math.round(scaled * 8388608));
      bytes[offset++] = value & 255;
      bytes[offset++] = (value >> 8) & 255;
      bytes[offset++] = (value >> 16) & 255;
    }
  }
  return { bytes, duration: count / sampleRate };
}
