import type { WorkletNoiseSuppressionMode } from '../../utils/audioPreferences';

/** Assets of one noise-suppression engine, loaded by the window and run inside the worker. */
export interface SuppressionAssets {
  mode: WorkletNoiseSuppressionMode;
  scriptUrl: string;
  wasmBinary: ArrayBuffer;
}

export type VoiceCaptureRequest =
  // `output` carries the transmitted voice; `level` the same voice before the volume, for the meter.
  | { type: 'init'; readable: ReadableStream<AudioData>; output: WritableStream<AudioData>; level: WritableStream<AudioData>; gain: number }
  | { type: 'input'; readable: ReadableStream<AudioData> }
  // `assets: null` prepares direct passthrough (browser suppression or none).
  | { type: 'prepare'; id: number; assets: SuppressionAssets | null }
  | { type: 'commit'; id: number }
  | { type: 'discard'; id: number }
  | { type: 'gain'; value: number }
  | { type: 'dispose' };

export type VoiceCaptureResponse =
  | { type: 'prepared'; id: number }
  | { type: 'prepare-failed'; id: number; message: string }
  | { type: 'failed'; message: string };
