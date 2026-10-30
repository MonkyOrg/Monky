import type {
  NativeScreenVideoProfile, ScreenCodecPreference, ScreenEncodingAvailability, ScreenEncodingMode, ScreenEncodingStrategy,
} from '@monky/shared';

export interface ScreenEncodingRequest {
  readonly video: NativeScreenVideoProfile;
  readonly mode: ScreenEncodingMode;
  readonly codec: ScreenCodecPreference;
  readonly strategy: ScreenEncodingStrategy;
  /** Whether a software request also reports hardware availability, as Settings asks. */
  readonly inspectHardware: boolean;
}

interface Entry {
  readonly availability: ScreenEncodingAvailability;
  readonly displayGeneration: number;
  readonly expiresAt: number;
}

const MAXIMUM_ENTRIES = 32;
// Failures another encoder discovery could explain: the encoder itself, its runtime or its driver.
const ENCODER_FAILURE = /^ERR_(SCREEN_CAPTURE_(ENCODER_[A-Z_]+|AMF_[A-Z_]+|NVENC_[A-Z_]+|NO_ENCODER|SOFTWARE_UNAVAILABLE)|MAC_(VIDEO|AV1)_[A-Z_]+)$/u;
// The vendor's SDK refused the device or the codec before any encoder was initialized: its runtime is
// missing, or the GPU lacks that codec (AMF answers AV1 on a Vega with a generic failure). A passing
// cause there, a lost device or every NVENC session taken, also fails that vendor's other candidates
// in the same discovery, so the encoder chosen after such a refusal is not a matter of luck.
const VENDOR_REFUSALS: ReadonlySet<string> = new Set(['ERR_SCREEN_CAPTURE_AMF_UNAVAILABLE', 'ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE']);

function isVendorRefusal(error: unknown): boolean {
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' && VENDOR_REFUSALS.has(code);
}

/** Whether a capture failed because of its encoder, anywhere in its AggregateError/cause chain. */
export function isScreenEncoderFailure(error: unknown): boolean {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  while (pending.length && seen.size < 12) {
    const current = pending.shift();
    if (seen.has(current) || typeof current !== 'object' || current === null) continue;
    seen.add(current);
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string' && ENCODER_FAILURE.test(code)) return true;
    if (current instanceof AggregateError) {
      const nested: readonly unknown[] = current.errors;
      pending.push(...nested.slice(0, 8));
    }
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
  }
  return false;
}

/**
 * What encoder discovery proved, so starting a share or changing its quality does not start one helper
 * process per candidate encoder again (up to five, in series). It keeps a selection its encoder proved
 * and a positive "unsupported", never a result shaped by a driver error: discovery errors are thrown,
 * not returned, and a hardware error reported beside a software choice is not kept. A selection that
 * automatic discovery reached past a better encoder that failed to initialize is not kept either, since
 * that failure may pass. Entries expire after `ttlMs` and when the displays change, since an adapter may
 * have appeared or gone; the owner also forgets them when an encoder fails to start, when its document
 * is retired and when the user asks to verify the encoders again. Remembering a selection never skips
 * the probe of the selected source.
 */
export class ScreenEncodingCache {
  private readonly entries = new Map<string, Entry>();
  private readonly remembered = new WeakSet<ScreenEncodingAvailability>();

  constructor(private readonly ttlMs = 10 * 60_000, private readonly now: () => number = () => Date.now()) {}

  get(request: ScreenEncodingRequest, displayGeneration: number): ScreenEncodingAvailability | null {
    const key = cacheKey(request), entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.displayGeneration !== displayGeneration || entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    const availability = structuredClone(entry.availability);
    this.remembered.add(availability);
    return availability;
  }

  /**
   * Replaces what is remembered for a request with what its discovery just proved. `skipped` are the
   * failures of the better encoders that automatic discovery passed over before choosing.
   */
  set(request: ScreenEncodingRequest, displayGeneration: number, availability: ScreenEncodingAvailability,
    skipped: readonly unknown[] = []): void {
    const key = cacheKey(request);
    this.entries.delete(key);
    if (availability.hardware.error || !skipped.every(isVendorRefusal)) return;
    const oldest = this.entries.keys().next().value;
    if (this.entries.size >= MAXIMUM_ENTRIES && oldest !== undefined) this.entries.delete(oldest);
    this.entries.set(key, { availability: structuredClone(availability), displayGeneration,
      expiresAt: this.now() + this.ttlMs });
  }

  forget(request: ScreenEncodingRequest): void {
    this.entries.delete(cacheKey(request));
  }

  /** Whether this availability came from memory instead of a discovery that just ran. */
  isRemembered(availability: ScreenEncodingAvailability): boolean {
    return this.remembered.has(availability);
  }

  clear(): void {
    this.entries.clear();
  }
}

function cacheKey({ video, mode, codec, strategy, inspectHardware }: ScreenEncodingRequest): string {
  // Automatic discovery ignores dormant manual fields, and hardware discovery always inspects hardware.
  const automatic = strategy === 'automatic';
  return JSON.stringify([strategy, automatic ? 'hardware' : mode, automatic ? 'auto' : codec,
    automatic || mode === 'hardware' || inspectHardware, video.width, video.height, video.fps, video.maxBitrateKbps]);
}
