import { NATIVE_SCREEN_AUDIO_IPC } from './ipc.js';
import type {
  NativeScreenAudioOutputConfig,
  NativeScreenAudioPortInfo,
  NativeScreenAudioPortMessage,
  NativeScreenAudioPortScope,
} from './ipc.js';

export { NATIVE_SCREEN_AUDIO_IPC };

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const positive = (value: unknown): value is number => integer(value) && value > 0;

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;

const text = (value: unknown, maximum: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0)
  && !value.includes('\0');

const epochRecord = (value: unknown, epoch: number): value is Record<string, unknown> =>
  isRecord(value) && value.epoch === epoch;

export function isNativeScreenAudioOutputConfig(value: unknown): value is NativeScreenAudioOutputConfig {
  return isRecord(value) && keys(value, ['epoch', 'sinkId', 'sampleRate', 'channels'])
    && positive(value.epoch) && text(value.sinkId, 512, true)
    && value.sampleRate === 48000 && value.channels === 2;
}

export function isNativeScreenAudioPortScope(value: unknown): value is NativeScreenAudioPortScope {
  return isRecord(value) && keys(value, ['portId', 'epoch'])
    && text(value.portId, 128) && positive(value.epoch);
}

export function isNativeScreenAudioPortInfo(value: unknown): value is NativeScreenAudioPortInfo {
  return isRecord(value) && keys(value, ['version', 'sessionId', 'portId', 'output'])
    && value.version === 1 && text(value.sessionId, 128) && text(value.portId, 128)
    && isNativeScreenAudioOutputConfig(value.output);
}

function errorData(value: unknown): boolean {
  return isRecord(value) && keys(value, ['code', 'message'])
    && text(value.code, 128) && text(value.message, 4096);
}

function rpcData(value: unknown, method: unknown, epoch: number, result: boolean): boolean {
  if (!epochRecord(value, epoch)) return false;
  switch (method) {
    case 'configure':
      return result
        ? keys(value, ['epoch', 'sampleRate', 'channels']) && value.sampleRate === 48000 && value.channels === 2
        : isNativeScreenAudioOutputConfig(value);
    case 'probe':
      return positive(value.probeId) && (result
        ? keys(value, ['epoch', 'probeId', 'rtcBeforeUs', 'rtcAfterUs'])
          && integer(value.rtcBeforeUs) && integer(value.rtcAfterUs)
          && value.rtcAfterUs >= value.rtcBeforeUs && value.rtcAfterUs - value.rtcBeforeUs <= 20000
        : keys(value, ['epoch', 'probeId']));
    case 'calibrate':
      return result
        ? keys(value, ['epoch', 'calibrationId', 'offsetUs', 'uncertaintyUs'])
          && positive(value.calibrationId) && finite(value.offsetUs)
          && finite(value.uncertaintyUs) && value.uncertaintyUs >= 0 && value.uncertaintyUs <= 20000
        : keys(value, ['epoch', 'probeId', 'rendererBeforeUs', 'rendererAfterUs'])
          && positive(value.probeId) && integer(value.rendererBeforeUs) && integer(value.rendererAfterUs)
          && value.rendererAfterUs >= value.rendererBeforeUs
          && value.rendererAfterUs - value.rendererBeforeUs <= 8000;
    case 'stop':
      return result ? keys(value, ['epoch', 'stopped']) && value.stopped === true : keys(value, ['epoch']);
    default:
      return false;
  }
}

function feedbackData(value: Record<string, unknown>): boolean {
  if (value.available === false) return keys(value, ['epoch', 'available']);
  return value.available === true
    && keys(value, ['epoch', 'available', 'clockEpoch', 'calibrationId', 'atPerformanceTimeUs',
      'estimatedPlayoutFrame', 'confirmedPcmEnd', 'feedbackAgeUs', 'outputClockAgeUs'])
    && positive(value.clockEpoch) && positive(value.calibrationId) && integer(value.atPerformanceTimeUs)
    && finite(value.estimatedPlayoutFrame) && integer(value.confirmedPcmEnd)
    && value.estimatedPlayoutFrame <= value.confirmedPcmEnd
    && integer(value.feedbackAgeUs) && value.feedbackAgeUs <= 200000
    && integer(value.outputClockAgeUs) && value.outputClockAgeUs <= 200000;
}

function pcmData(value: Record<string, unknown>): boolean {
  if (!keys(value, ['epoch', 'sequence', 'firstPlayoutFrame', 'frames', 'sampleRate', 'channels', 'samples'])
    || !integer(value.sequence) || !Number.isSafeInteger(value.sequence + 1)
    || !integer(value.firstPlayoutFrame) || !Number.isSafeInteger(value.firstPlayoutFrame + 480)
    || value.frames !== 480 || value.sampleRate !== 48000 || value.channels !== 2
    || !(value.samples instanceof Float32Array) || value.samples.length !== 960
    || !(value.samples.buffer instanceof ArrayBuffer) || value.samples.byteOffset !== 0
    || value.samples.buffer.byteLength !== 3840) return false;
  return value.samples.every(Number.isFinite);
}

function eventData(value: unknown, event: unknown, epoch: number): boolean {
  if (event === 'error') return errorData(value);
  if (!epochRecord(value, epoch)) return false;
  switch (event) {
    case 'ready':
      return isNativeScreenAudioOutputConfig(value);
    case 'disposed':
      return keys(value, ['epoch', 'stopped']) && value.stopped === true;
    case 'pcm':
      return pcmData(value);
    case 'credits':
      return keys(value, ['epoch', 'grantSequence', 'frames'])
        && positive(value.grantSequence) && (value.frames === 480 || value.frames === 960);
    case 'feedback':
      return feedbackData(value);
    default:
      return false;
  }
}

export function isNativeScreenAudioPortMessage(
  value: unknown,
  scope: NativeScreenAudioPortScope,
  sender: 'main' | 'renderer',
): value is NativeScreenAudioPortMessage {
  if (!isNativeScreenAudioPortScope(scope) || (sender !== 'main' && sender !== 'renderer')
    || !isRecord(value) || value.portId !== scope.portId || value.epoch !== scope.epoch) return false;
  if (value.type === 'request') {
    return keys(value, ['type', 'portId', 'epoch', 'id', 'method', 'data'])
      && positive(value.id) && (sender === 'main' ? value.method === 'stop' : value.method !== 'stop')
      && rpcData(value.data, value.method, scope.epoch, false);
  }
  if (value.type === 'response') {
    if (!positive(value.id) || typeof value.method !== 'string'
      || !['configure', 'probe', 'calibrate', 'stop'].includes(value.method)
      || (sender === 'renderer' ? value.method !== 'stop' : value.method === 'stop')) return false;
    return value.ok === true
      ? keys(value, ['type', 'portId', 'epoch', 'id', 'method', 'ok', 'data'])
        && rpcData(value.data, value.method, scope.epoch, true)
      : value.ok === false && keys(value, ['type', 'portId', 'epoch', 'id', 'method', 'ok', 'error'])
        && errorData(value.error);
  }
  if (value.type === 'event') {
    return keys(value, ['type', 'portId', 'epoch', 'event', 'data'])
      && (sender === 'main' ? value.event === 'pcm' || value.event === 'error' : value.event !== 'pcm')
      && eventData(value.data, value.event, scope.epoch);
  }
  return false;
}
