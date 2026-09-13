import {
  LIMITS, commandAudioPreviewBase64Schema, commandAudioPreviewMimeSchema, type AudioPreviewResult,
} from '@monky/shared';
import { fetchSoundAudio, nativeSoundTransport, SoundDownloadError, type SoundDownloadTransport } from './audioFetch';
import { isSoundAudio, isSoundFileName, isSoundMime, soundFileNameForMime } from './soundAudioValidation';

interface ActivePreview {
  requestId: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requestId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

export class AudioPreviews {
  private active = new Map<number, ActivePreview>();

  constructor(
    private transport: SoundDownloadTransport = nativeSoundTransport,
    private timeoutMs = 30_000
  ) {}

  public async load(owner: number, input: unknown): Promise<AudioPreviewResult> {
    if (record(input) && ('audioBase64' in input || 'mimeType' in input)) return this.loadBytes(owner, input);
    if (!record(input) || !requestId(input.requestId) ||
        Object.keys(input).some((key) => !['requestId', 'url', 'fileName'].includes(key)) ||
        typeof input.url !== 'string' || input.url.length > 2048 ||
        (input.fileName !== undefined && typeof input.fileName !== 'string')) {
      return { status: 'failed', reason: 'invalid_request' };
    }
    if (this.active.get(owner)?.requestId === input.requestId) {
      return { status: 'failed', reason: 'invalid_request' };
    }
    this.cancelOwner(owner);
    const controller = new AbortController();
    const preview: ActivePreview = {
      requestId: input.requestId,
      controller,
      timer: setTimeout(() => controller.abort(new SoundDownloadError('timeout')), this.timeoutMs),
    };
    this.active.set(owner, preview);
    try {
      const result = await fetchSoundAudio({
        url: input.url, ...(typeof input.fileName === 'string' ? { fileName: input.fileName } : {}),
      }, controller.signal, this.transport);
      controller.signal.throwIfAborted();
      if (this.active.get(owner) !== preview) return { status: 'cancelled' };
      return { status: 'ready', data: new Uint8Array(result.bytes), mimeType: result.mimeType };
    } catch (error) {
      if (controller.signal.aborted) {
        return controller.signal.reason instanceof SoundDownloadError
          ? { status: 'failed', reason: controller.signal.reason.reason } : { status: 'cancelled' };
      }
      return { status: 'failed', reason: error instanceof SoundDownloadError ? error.reason : 'network_error' };
    } finally {
      clearTimeout(preview.timer);
      if (this.active.get(owner) === preview) this.active.delete(owner);
    }
  }

  private loadBytes(owner: number, input: Record<string, unknown>): AudioPreviewResult {
    if (!requestId(input.requestId) || Object.keys(input).some((key) =>
      !['requestId', 'audioBase64', 'mimeType', 'fileName'].includes(key)) ||
        this.active.get(owner)?.requestId === input.requestId) {
      return { status: 'failed', reason: 'invalid_request' };
    }
    if (typeof input.audioBase64 === 'string') {
      const padding = input.audioBase64.endsWith('==') ? 2 : input.audioBase64.endsWith('=') ? 1 : 0;
      if (input.audioBase64.length / 4 * 3 - padding > LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES) {
        return { status: 'failed', reason: 'too_large' };
      }
    }
    const data = commandAudioPreviewBase64Schema.safeParse(input.audioBase64);
    if (!data.success) return { status: 'failed', reason: 'invalid_request' };
    const mime = commandAudioPreviewMimeSchema.safeParse(input.mimeType);
    if (!mime.success) return { status: 'failed', reason: 'unsupported_audio' };
    const fileName = input.fileName ?? soundFileNameForMime(mime.data);
    if (!isSoundFileName(fileName)) return { status: 'failed', reason: 'invalid_file_name' };
    const bytes = Buffer.from(data.data, 'base64');
    if (!isSoundMime(fileName, mime.data) || !isSoundAudio(bytes, fileName)) {
      return { status: 'failed', reason: 'unsupported_audio' };
    }
    this.cancelOwner(owner);
    return { status: 'ready', data: new Uint8Array(bytes), mimeType: mime.data };
  }

  public cancel(owner: number, input: unknown): boolean {
    if (!record(input) || Object.keys(input).length !== 1 || !requestId(input.requestId)) return false;
    if (this.active.get(owner)?.requestId !== input.requestId) return false;
    this.cancelOwner(owner);
    return true;
  }

  public cancelOwner(owner: number): void {
    const preview = this.active.get(owner);
    if (!preview) return;
    this.active.delete(owner);
    clearTimeout(preview.timer);
    preview.controller.abort();
  }
}
