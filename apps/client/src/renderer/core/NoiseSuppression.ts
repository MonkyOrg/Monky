import {
  GtcrnWorkletNode, RnnoiseWorkletNode, SpeexWorkletNode, loadGtcrn, loadRnnoise, loadSpeex,
} from '@sapphi-red/web-noise-suppressor';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import speexWorkletUrl from '@sapphi-red/web-noise-suppressor/speexWorklet.js?url';
import speexWasmUrl from '@sapphi-red/web-noise-suppressor/speex.wasm?url';
import gtcrnWorkletUrl from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import gtcrnWasmUrl from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import type { NoiseSuppressionMode, WorkletNoiseSuppressionMode } from '../utils/audioPreferences';

export type NoiseSuppressorNode = RnnoiseWorkletNode | SpeexWorkletNode | GtcrnWorkletNode;

const binaries = new Map<WorkletNoiseSuppressionMode, Promise<ArrayBuffer>>();
const modules = new WeakMap<AudioContext, Map<WorkletNoiseSuppressionMode, Promise<void>>>();
const workletUrls: Record<WorkletNoiseSuppressionMode, string> = {
  rnnoise: rnnoiseWorkletUrl,
  speex: speexWorkletUrl,
  gtcrn: gtcrnWorkletUrl,
};

async function loadBinary(mode: WorkletNoiseSuppressionMode): Promise<ArrayBuffer> {
  const binary = mode === 'rnnoise'
    ? await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl })
    : mode === 'speex'
      ? await loadSpeex({ url: speexWasmUrl })
      : await loadGtcrn({ url: gtcrnWasmUrl });
  // Reject missing/corrupt assets and unsupported SIMD before changing the live graph.
  await WebAssembly.compile(binary);
  return binary;
}

export async function createNoiseSuppressor(context: AudioContext, mode: NoiseSuppressionMode): Promise<NoiseSuppressorNode | null> {
  if (mode === 'browser' || mode === 'off') return null;
  if (!context.audioWorklet) throw new Error('AudioWorklet is required for noise suppression');
  let binary = binaries.get(mode);
  if (!binary) {
    binary = loadBinary(mode).catch((error: unknown) => {
      binaries.delete(mode);
      throw error;
    });
    binaries.set(mode, binary);
  }
  let contextModules = modules.get(context);
  if (!contextModules) {
    contextModules = new Map();
    modules.set(context, contextModules);
  }
  let module = contextModules.get(mode);
  if (!module) {
    const registered = contextModules;
    module = context.audioWorklet.addModule(workletUrls[mode]).catch((error: unknown) => {
      registered.delete(mode);
      throw error;
    });
    contextModules.set(mode, module);
  }
  const [wasmBinary] = await Promise.all([binary, module]);
  if (context.state === 'closed') throw new DOMException('Audio processing was cancelled', 'AbortError');
  const options = { maxChannels: 1, wasmBinary };
  switch (mode) {
    case 'rnnoise': return new RnnoiseWorkletNode(context, options);
    case 'speex': return new SpeexWorkletNode(context, options);
    case 'gtcrn': return new GtcrnWorkletNode(context, options);
  }
}

export function destroyNoiseSuppressor(node: NoiseSuppressorNode | null): void {
  if (!node) return;
  node.onprocessorerror = null;
  node.disconnect();
  node.destroy();
  node.port.close();
}
