import { type AudioPreviewResult } from '@monky/shared';
import { fetchSoundAudio, nativeSoundTransport, SoundDownloadError, type SoundDownloadTransport } from './audioFetch';

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
