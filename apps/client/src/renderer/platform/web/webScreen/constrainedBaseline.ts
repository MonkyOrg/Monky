import { runsOnWebKit } from '../../../utils/browserEngine';

/**
 * Makes a keyframe's Baseline SPS declare the Constrained Baseline it is; true when a byte changed.
 *
 * WebKit encodes screens with VideoToolbox, whose Baseline SPS leaves constraint_set1 clear although the stream
 * has no slice groups or redundant pictures (Constrained Baseline, H.264 A.2.1), which is what the connection
 * negotiated (`42e0xx`). The desktop admits only the negotiated profile and dropped every frame, so an iPhone's
 * screen loaded forever there. The desktop's own Baseline encoders are declared the same way
 * (`NormalizeConstrainedBaseline`): constraint_set1 set, constraint_set4/5 (meaningless for Baseline) cleared. The
 * flag byte follows profile_idc, never zero, so no emulation prevention depends on it.
 *
 * Self-contained: the worker runs this function's source text.
 */
export function declareConstrainedBaseline(bytes: Uint8Array): boolean {
  let zeros = 0;
  for (let index = 0; index + 3 < bytes.length; index++) {
    const byte = bytes[index];
    if (byte === 0) {
      zeros++;
      continue;
    }
    if (byte === 1 && zeros >= 2 && (bytes[index + 1] & 0x1f) === 7) {
      if (bytes[index + 2] !== 66) return false;
      const declared = (bytes[index + 3] | 0x40) & ~0x0c;
      if (declared === bytes[index + 3]) return false;
      bytes[index + 3] = declared;
      return true;
    }
    zeros = 0;
  }
  return false;
}

/** The worker's body: passes every encoded frame on, declaring the keyframes' SPS. Self-contained, like the above. */
function transformKeyframes(declare: (bytes: Uint8Array) => boolean): void {
  interface EncodedFrame { readonly type?: string; data: ArrayBuffer }
  interface TransformEvent extends Event {
    readonly transformer: { readonly readable: ReadableStream<EncodedFrame>; readonly writable: WritableStream<EncodedFrame> };
  }
  const isTransformEvent = (event: Event): event is TransformEvent => 'transformer' in event;
  self.addEventListener('rtctransform', event => {
    if (!isTransformEvent(event)) return;
    const { readable, writable } = event.transformer;
    readable.pipeThrough(new TransformStream<EncodedFrame, EncodedFrame>({
      transform(frame, controller) {
        if (frame.type === 'key') {
          const bytes = new Uint8Array(frame.data);
          if (declare(bytes)) frame.data = bytes.buffer;
        }
        controller.enqueue(frame);
      },
    })).pipeTo(writable).catch(() => {});
  });
}

let workerUrl: string | null = null;

/**
 * Declares Constrained Baseline on what `sender` encodes, where the encoder omits it (WebKit). Returns the release,
 * or null when nothing needed or could run: the frames then go out as encoded.
 */
export function declareConstrainedBaselineOn(sender: RTCRtpSender): (() => void) | null {
  if (!runsOnWebKit() || typeof RTCRtpScriptTransform !== 'function' || typeof Worker !== 'function') return null;
  workerUrl ??= URL.createObjectURL(new Blob(
    [`(${transformKeyframes})(${declareConstrainedBaseline});`], { type: 'text/javascript' }));
  let worker: Worker | null = null;
  try {
    worker = new Worker(workerUrl);
    // A worker that never starts would hold every frame: the sender then sends them unchanged.
    worker.onerror = () => {
      sender.transform = null;
      worker?.terminate();
    };
    sender.transform = new RTCRtpScriptTransform(worker);
  } catch (error) {
    worker?.terminate();
    console.warn('[screen] Could not declare Constrained Baseline on the screen video:', error);
    return null;
  }
  const started = worker;
  return () => started.terminate();
}
