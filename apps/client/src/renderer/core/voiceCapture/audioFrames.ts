/** Sample rate of transmitted voice and of every noise-suppression engine. */
export const VOICE_SAMPLE_RATE = 48000;
/** Block size the noise-suppression engines process (the Web Audio render quantum). */
export const VOICE_BLOCK_SIZE = 128;

/** Averages planar channels into one mono signal. */
export function downmix(planes: readonly Float32Array[], frames: number): Float32Array {
  if (planes.length === 1) return planes[0].length === frames ? planes[0] : planes[0].subarray(0, frames);
  const mono = new Float32Array(frames);
  for (const plane of planes) {
    for (let index = 0; index < frames; index++) mono[index] += plane[index];
  }
  const scale = 1 / Math.max(1, planes.length);
  for (let index = 0; index < frames; index++) mono[index] *= scale;
  return mono;
}

/** Converts a continuous signal to 48 kHz by linear interpolation, keeping phase across chunks. */
export class LinearResampler {
  private rate = VOICE_SAMPLE_RATE;
  // Position of the next output sample, where 0 is the last sample of the previous chunk.
  private position = 0;
  private last = 0;

  public process(input: Float32Array, rate: number): Float32Array {
    if (rate !== this.rate) {
      this.rate = rate;
      this.position = 1;
      this.last = 0;
    }
    if (rate === VOICE_SAMPLE_RATE || input.length === 0) return input;
    const step = rate / VOICE_SAMPLE_RATE;
    const count = Math.max(0, Math.ceil((input.length - this.position) / step));
    const output = new Float32Array(count);
    let position = this.position;
    for (let index = 0; index < count; index++) {
      const whole = Math.min(Math.floor(position), input.length - 1);
      const before = whole === 0 ? this.last : input[whole - 1];
      output[index] = before + (input[whole] - before) * (position - whole);
      position += step;
    }
    this.position = position - input.length;
    this.last = input[input.length - 1];
    return output;
  }
}

/** First-in first-out sample buffer that hands out fixed-size blocks. */
export class SampleQueue {
  private buffer = new Float32Array(VOICE_SAMPLE_RATE / 10);
  private size = 0;

  public get length(): number {
    return this.size;
  }

  public push(samples: Float32Array): void {
    const needed = this.size + samples.length;
    if (needed > this.buffer.length) {
      const grown = new Float32Array(Math.max(needed, this.buffer.length * 2));
      grown.set(this.buffer.subarray(0, this.size));
      this.buffer = grown;
    }
    this.buffer.set(samples, this.size);
    this.size = needed;
  }

  /** Moves the oldest `target.length` samples into `target`; false when not enough are queued. */
  public take(target: Float32Array): boolean {
    if (this.size < target.length) return false;
    target.set(this.buffer.subarray(0, target.length));
    this.buffer.copyWithin(0, target.length, this.size);
    this.size -= target.length;
    return true;
  }
}

/**
 * Timestamps output chunks by the samples already written, so they stay
 * monotonic across engine latency and microphone replacement.
 */
export class SampleTimeline {
  private origin: number | null = null;
  private written = 0;

  /** Returns the timestamp in microseconds of a chunk of `frames` samples. */
  public stamp(inputTimestamp: number, frames: number): number {
    this.origin ??= inputTimestamp;
    const timestamp = this.origin + Math.round(this.written * 1e6 / VOICE_SAMPLE_RATE);
    this.written += frames;
    return timestamp;
  }
}
