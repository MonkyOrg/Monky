import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { LIMITS } from '@monky/shared';
import { MediaError, aborted } from './errors';
import { capture, captureBytes, bounded, cancellable, safeDiagnostic, terminate } from './process';
import { OggOpusParser } from './ogg';
import { createPersistentInput, type AudioRequest, type PersistentInput } from './persistent-http';
import { checkMediaTools, youtubeExtractorArgs, type MediaToolPaths } from './toolChecks';

export const MUSIC_PREVIEW_DURATION_MS = 10_000;

export interface Track {
  id: string;
  title: string;
  url: string;
  duration: number;
}
export interface ResolvedTrack extends Track { audioUrl: string }
export interface AudioStream {
  /** Encoded Opus packets, 48 kHz stereo, 20 ms each. Consumption supplies backpressure. */
  frames: AsyncIterable<Uint8Array>;
  readonly recoveryMode?: 'persistent';
  markFrameAdvanced?(): void;
  setPaused?(paused: boolean): void;
  close(): Promise<void>;
}
/** Retrying is reported during stalls; recovered means the full stream passed EOF validation. */
export type SourceRecoveryNotice =
  | { type: 'retrying'; attempt: number; maxAttempts: number; byteOffset: number; delayMs: number; emittedDurationMs: number }
  | { type: 'recovered'; attempts: number; expectedDurationMs: number; emittedDurationMs: number };
export interface SourceRecoveryOptions {
  /** Opt in to bounded seekable HTTP recovery. Honor signal; notice delivery is limited to five seconds. */
  onRecovery(notice: SourceRecoveryNotice, signal: AbortSignal): void | Promise<void>;
}
export interface PersistentSourceOptions {
  mode: 'persistent';
  /** Call markFrameAdvanced after consumed playback, not when buffering a delivered decoder frame. */
  progress?: 'playback';
}
export type SourceOpenOptions = SourceRecoveryOptions | PersistentSourceOptions;
export interface MusicSource {
  check(signal: AbortSignal): Promise<void>;
  search(query: string, signal: AbortSignal): Promise<Track[]>;
  resolve(url: string, signal: AbortSignal): Promise<ResolvedTrack>;
  preview(url: string, signal: AbortSignal): Promise<Uint8Array>;
  /** Supply a playback lifetime signal, independent of a completed inclusion/search/preview request. */
  open(track: ResolvedTrack, signal: AbortSignal, options?: SourceOpenOptions): Promise<AudioStream>;
}

export interface YouTubeSourceDependencies {
  capture?: typeof capture;
  captureBytes?: typeof captureBytes;
  request?: AudioRequest;
}

export const MAX_SOURCE_RECOVERIES = 2;

export class IncompleteAudioError extends MediaError {
  constructor(readonly expectedDurationMs: number, readonly emittedDurationMs: number) {
    super('unavailable', `Audio source ended early: emitted ${emittedDurationMs} ms of ${expectedDurationMs} ms expected.`);
    this.name = 'IncompleteAudioError';
  }
}

function durationMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new MediaError('unsupported');
  return Math.round(seconds * 1000);
}

function requireCompleteAudio(expectedMs: number, packets: number): void {
  // Provider duration can be rounded; cap that allowance for very short clips.
  const toleranceMs = Math.min(1000, expectedMs / 10);
  const emittedMs = packets * 20;
  if (!packets || emittedMs + toleranceMs < expectedMs) throw new IncompleteAudioError(expectedMs, emittedMs);
}

const ID = /^[a-zA-Z0-9_-]{11}$/;
const VIDEO_HOSTS = new Set(['youtu.be', 'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
export function videoUrl(input: string): string {
  if (typeof input !== 'string' || /[\\\u0000-\u001f\u007f]/.test(input)) throw new MediaError('unsupported');
  const value = input.trim();
  // Inspect the authority before URL normalizes empty userinfo or default ports away.
  const host = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1]?.toLowerCase();
  if (!host || !VIDEO_HOSTS.has(host)) throw new MediaError('unsupported');
  let url: URL;
  try { url = new URL(value); }
  catch (error: unknown) {
    if (error instanceof TypeError) throw new MediaError('unsupported');
    throw error;
  }
  let id: string | undefined;
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else {
    if (url.pathname === '/watch') {
      const videos = url.searchParams.getAll('v');
      if (videos.length === 1) id = videos[0];
    } else {
      const match = url.pathname.match(/^\/(?:shorts|embed)\/([a-zA-Z0-9_-]{11})$/);
      id = match?.[1];
    }
  }
  if (!id || id.length !== 11 || !ID.test(id)) throw new MediaError('unsupported');
  // Playlist/radio context must never reach the single-video extractor.
  return `https://www.youtube.com/watch?v=${id}`;
}

export function musicInput(input: unknown): { kind: 'url' | 'search'; value: string } {
  if (typeof input !== 'string' || !input.trim() || input.length > LIMITS.MAX_BOT_AUTOCOMPLETE_QUERY_LENGTH) throw new MediaError('input');
  const value = input.trim();
  if (/https?:\/\//i.test(value) || /^(?:\w+:|www\.|(?:[\w-]+\.)+(?:com|be|org|net|io)(?:\/|$))/i.test(value)) {
    return { kind: 'url', value: videoUrl(value) };
  }
  return { kind: 'search', value };
}

export function audioUrl(input: unknown): string {
  if (typeof input !== 'string') throw new MediaError('unavailable', 'yt-dlp did not return an audio URL.');
  let url: URL;
  try { url = new URL(input); }
  catch (error: unknown) {
    if (error instanceof TypeError) throw new MediaError('unavailable', 'yt-dlp returned an invalid audio URL.');
    throw error;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !/^[a-zA-Z0-9-]+\.googlevideo\.com$/.test(url.hostname) || url.pathname !== '/videoplayback') {
    throw new MediaError('unavailable', 'The audio URL is not an authorized HTTPS googlevideo videoplayback endpoint.');
  }
  return url.href;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new MediaError('unavailable', 'yt-dlp returned an invalid metadata object.');
  }
  return value;
}

function metadata(json: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(json); }
  catch (error: unknown) {
    if (error instanceof SyntaxError) throw new MediaError('unavailable', 'yt-dlp returned invalid metadata JSON.');
    throw error;
  }
  return record(value);
}

export function parseTrack(value: unknown, requirePublic = false): Track {
  const data = record(value);
  if (typeof data.id !== 'string' || data.id.length !== 11 || !ID.test(data.id) || typeof data.title !== 'string' ||
      typeof data.duration !== 'number' || !Number.isFinite(data.duration) || data.duration <= 0 ||
      data.duration > 3600 || data.is_live === true || data.was_live === true ||
      (data.live_status !== undefined && data.live_status !== null && data.live_status !== 'not_live') ||
      (data.availability !== undefined && data.availability !== null && data.availability !== 'public') ||
      (requirePublic && data.age_limit !== undefined && data.age_limit !== 0)) {
    throw new MediaError('unsupported', 'Video metadata did not satisfy the public, individual, non-live, unrestricted, up-to-one-hour policy.');
  }
  return {
    id: data.id, title: data.title.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 150),
    duration: data.duration, url: `https://www.youtube.com/watch?v=${data.id}`,
  };
}

export class YouTubeSource implements MusicSource {
  private readonly paths: MediaToolPaths;
  private readonly run: typeof capture;
  private readonly runBytes: typeof captureBytes;
  private readonly request: AudioRequest | undefined;

  constructor(paths: MediaToolPaths, dependencies: YouTubeSourceDependencies = {}) {
    if (!paths || typeof paths !== 'object') throw new MediaError('tools', 'Explicit media executable paths are required.');
    const tools = { node: paths.node, ytDlp: paths.ytDlp, ffmpeg: paths.ffmpeg };
    if (Object.values(tools).some(executable => typeof executable !== 'string' || !executable.trim() || executable.includes('\0'))) {
      throw new MediaError('tools', 'Explicit Node.js, yt-dlp and FFmpeg executable paths are required.');
    }
    this.paths = tools;
    this.run = dependencies.capture ?? capture;
    this.runBytes = dependencies.captureBytes ?? captureBytes;
    this.request = dependencies.request;
  }

  private extractorArgs(): string[] {
    return youtubeExtractorArgs(this.paths.node);
  }

  async check(signal: AbortSignal): Promise<void> {
    await checkMediaTools(this.paths, signal, this.run);
  }

  async search(query: string, signal: AbortSignal): Promise<Track[]> {
    aborted(signal);
    const input = musicInput(query);
    if (input.kind !== 'search') throw new MediaError('input');
    const json = await this.run(this.paths.ytDlp, [
      ...this.extractorArgs(), '--skip-download', '--flat-playlist',
      '--dump-single-json', '--playlist-end', '8', '--socket-timeout', '10', '--retries', '1',
      '--', `ytsearch8:${input.value}`,
    ], signal);
    aborted(signal);
    const data = metadata(json);
    if (!Array.isArray(data.entries)) throw new MediaError('unavailable', 'yt-dlp search returned no entries array.');
    const seen = new Set<string>();
    return data.entries.slice(0, 8).flatMap((entry: unknown) => {
      try {
        const track = parseTrack(entry);
        if (seen.has(track.id)) return [];
        seen.add(track.id);
        return [track];
      } catch (error: unknown) {
        if (error instanceof MediaError && error.code === 'unsupported') return [];
        throw error;
      }
    });
  }

  async resolve(url: string, signal: AbortSignal): Promise<ResolvedTrack> {
    aborted(signal);
    const canonical = videoUrl(url);
    const json = await this.run(this.paths.ytDlp, [
      ...this.extractorArgs(), '--skip-download', '--no-playlist', '--dump-single-json',
      '--socket-timeout', '10', '--retries', '1', '--format', 'bestaudio[protocol=https]',
      '--', canonical,
    ], signal);
    aborted(signal);
    const data = metadata(json);
    const track = parseTrack(data, true);
    if (track.url !== canonical) throw new MediaError('unsupported', 'Resolved video ID did not match the selected public video.');
    return { ...track, audioUrl: audioUrl(data.url) };
  }

  private transcodeArgs(track: ResolvedTrack, durationSeconds: number, recover = false): string[] {
    // Without -xerror, FFmpeg can finalize partial audio after a demux failure with exit code zero.
    return [
      '-hide_banner', '-loglevel', recover ? 'repeat+level+warning' : 'error', '-nostdin', '-xerror',
      '-protocol_whitelist', 'https,tls,tcp,crypto', '-rw_timeout', '15000000',
      ...(recover ? ['-reconnect', '1', '-reconnect_at_eof', '0', '-reconnect_streamed', '0', '-reconnect_delay_max', '2'] : []),
      '-i', audioUrl(track.audioUrl), '-vn', '-map', '0:a:0', '-t', String(durationSeconds),
      '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '96k', '-frame_duration', '20',
      '-application', 'audio', '-f', 'ogg', '-page_duration', '20000', 'pipe:1',
    ];
  }

  async preview(url: string, signal: AbortSignal): Promise<Uint8Array> {
    aborted(signal);
    const canonical = videoUrl(url);
    await this.check(signal);
    aborted(signal);
    const track = await this.resolve(canonical, signal);
    aborted(signal);
    const expectedMs = Math.min(durationMs(track.duration), MUSIC_PREVIEW_DURATION_MS);
    const bytes = await this.runBytes(this.paths.ffmpeg,
      this.transcodeArgs(track, MUSIC_PREVIEW_DURATION_MS / 1000),
      signal, 20_000, LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES, { rejectStderr: true });
    aborted(signal);
    const parser = new OggOpusParser();
    const packets = parser.push(bytes);
    parser.finish();
    requireCompleteAudio(expectedMs, packets.length);
    return bytes;
  }

  private persistentInput(url: string, signal: AbortSignal): Promise<PersistentInput> {
    return createPersistentInput(url, signal, audioUrl, this.request);
  }

  async open(track: ResolvedTrack, signal: AbortSignal, options?: SourceOpenOptions): Promise<AudioStream> {
    aborted(signal);
    let recovery: SourceRecoveryOptions | undefined;
    let persistent = false;
    let playbackProgress = false;
    if (options !== undefined) {
      if (!options || typeof options !== 'object') throw new MediaError('input', 'Invalid source recovery options.');
      if ('mode' in options) {
        if (options.mode !== 'persistent' || 'onRecovery' in options) throw new MediaError('input', 'Invalid persistent source options.');
        if (options.progress !== undefined && options.progress !== 'playback') throw new MediaError('input', 'Invalid source progress mode.');
        persistent = true;
        playbackProgress = options.progress === 'playback';
      } else {
        if (typeof options.onRecovery !== 'function') throw new MediaError('input', 'Source recovery requires an explicit notice callback.');
        recovery = options;
      }
    }
    const expectedMs = durationMs(track.duration);
    const args = this.transcodeArgs(track, 3600, recovery !== undefined);
    const input = persistent ? await this.persistentInput(audioUrl(track.audioUrl), signal) : undefined;
    if (input) {
      args[args.indexOf('-i') + 1] = input.url;
      args[args.indexOf('-protocol_whitelist') + 1] = 'http,tcp';
      // The private input owns bounded HTTPS operations; its open response can wait through outages.
      args[args.indexOf('-rw_timeout') + 1] = '0';
    }
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      aborted(signal);
      child = spawn(this.paths.ffmpeg, args,
        { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error: unknown) {
      await input?.close();
      throw error;
    }
    let failure: MediaError | undefined;
    let stderrBytes = 0;
    let diagnostic = '';
    let hasDiagnostic = false;
    let lines = '';
    let protocolError = false;
    let otherError = false;
    let attempts = 0;
    let packets = 0;
    const notices: SourceRecoveryNotice[] = [];
    const noticeSignal = new AbortController();
    let wakeNotices: (() => void) | undefined;
    const lineReceived = (raw: string): void => {
      const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trim();
      if (!line) return;
      const retry = /^\[https? @ [^\]]+\]\s+\[warning\]\s+Will reconnect at (\d+) in (\d+) second/.exec(line);
      if (retry) {
        const byteOffset = Number(retry[1]);
        const delayMs = Number(retry[2]) * 1000;
        if (!Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(delayMs) || delayMs > 2000) {
          failure ??= new MediaError('unavailable', 'Invalid HTTP source recovery diagnostic.');
          void terminate(child);
        } else if (byteOffset === 0 && packets > 0) {
          failure ??= new MediaError('unavailable', 'Refusing to restart HTTP audio from byte zero after playback advanced.');
          void terminate(child);
        } else if (++attempts > MAX_SOURCE_RECOVERIES) {
          failure ??= new MediaError('unavailable', `HTTP source exceeded ${MAX_SOURCE_RECOVERIES} resume attempts after ${packets * 20} ms.`);
          void terminate(child);
        } else notices.push({ type: 'retrying', attempt: attempts, maxAttempts: MAX_SOURCE_RECOVERIES,
          byteOffset, delayMs, emittedDurationMs: packets * 20 });
      } else if (/\breconnect\b/i.test(line)) {
        failure ??= new MediaError('unavailable', 'Unsupported HTTP source recovery diagnostic.');
        void terminate(child);
      } else if (/\[(?:error|fatal|panic)\]/.test(line)) {
        if (/^\[(?:https?|tls|tcp) @ [^\]]+\]/.test(line)) protocolError = true;
        else otherError = true;
      } else if (!/\[warning\]/.test(line)) otherError = true;
      if (notices.length || failure) wakeNotices?.();
    };
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      const text = chunk.toString('utf8');
      hasDiagnostic ||= !!text.trim();
      diagnostic = (diagnostic + text).slice(0, 4096);
      if (stderrBytes > 65536) {
        failure ??= new MediaError('unavailable', 'FFmpeg produced excessive error output.');
        void terminate(child);
        return;
      }
      if (recovery) {
        lines += text;
        let end: number;
        while ((end = lines.indexOf('\n')) !== -1) {
          lineReceived(lines.slice(0, end));
          lines = lines.slice(end + 1);
        }
      }
    });
    child.once('error', () => { failure ??= new MediaError('tools', 'FFmpeg could not be started.'); });
    const exit = new Promise<void>((resolve) => child.once('close', (code) => {
      if (recovery) lineReceived(lines);
      lines = '';
      if (code !== 0) failure ??= new MediaError('unavailable',
        safeDiagnostic(`FFmpeg exited with code ${code}. ${diagnostic}`));
      else if (recovery ? (otherError || (protocolError && !attempts)) : hasDiagnostic) failure ??= new MediaError('unavailable',
        safeDiagnostic(`FFmpeg reported audio input or encoding errors. ${diagnostic}`));
      resolve();
    }));
    const cancel = (): void => {
      failure ??= new MediaError('cancelled');
      noticeSignal.abort();
      clearTimeout(lifetime);
      child.stdout.destroy();
      void terminate(child);
    };
    signal.addEventListener('abort', cancel, { once: true });
    const lifetime = persistent ? undefined : setTimeout(() => {
      failure ??= new MediaError('timeout', 'Audio source exceeded its two-hour lifetime limit.');
      void terminate(child);
    }, 2 * 60 * 60 * 1000);
    let closed = false;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      closed = true;
      noticeSignal.abort();
      clearTimeout(lifetime);
      signal.removeEventListener('abort', cancel);
      child.stdout.destroy();
      await Promise.all([terminate(child), input?.close()]);
    })();
    const active = (): void => {
      aborted(signal);
      if (closed) throw new MediaError('cancelled');
      if (input?.failure) throw input.failure;
      if (failure) throw failure;
    };
    const reportNotices = async (): Promise<void> => {
      if (!recovery) return;
      while (notices.length) {
        aborted(signal);
        if (closed) throw new MediaError('cancelled');
        const notice = notices.shift();
        if (!notice) break;
        try {
          await bounded(Promise.resolve().then(() => {
            aborted(noticeSignal.signal);
            return recovery.onRecovery(notice, noticeSignal.signal);
          }), noticeSignal.signal, 5000);
        } catch (error: unknown) {
          notices.length = 0;
          if (noticeSignal.signal.aborted) throw new MediaError('cancelled');
          throw new MediaError('unavailable', safeDiagnostic(`Could not report source recovery: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    };
    if (signal.aborted) cancel();
    const parser = new OggOpusParser();
    const frames = (async function* (): AsyncGenerator<Uint8Array> {
      const reader = child.stdout[Symbol.asyncIterator]();
      const nextChunk = async () => {
        if (input) {
          const reading = new AbortController();
          const cancelRead = (): void => reading.abort();
          let stalled = false;
          signal.addEventListener('abort', cancelRead, { once: true });
          if (signal.aborted) cancelRead();
          // One subscription per read, even across an unlimited number of watchdog ticks.
          const watchdog = setInterval(() => {
            if (!input.waitingForData()) { stalled = true; reading.abort(); }
          }, 30_000);
          try {
            return await cancellable(reader.next(), reading.signal);
          } catch (error: unknown) {
            active();
            if (stalled) throw new MediaError('timeout');
            throw error;
          } finally {
            clearInterval(watchdog);
            signal.removeEventListener('abort', cancelRead);
          }
        }
        if (!recovery) return bounded(reader.next(), signal, 30_000);
        const reading = bounded(reader.next(), signal, 30_000).then(
          (next) => ({ next }), (error: unknown) => ({ error }),
        );
        for (;;) {
          if (notices.length) await reportNotices();
          active();
          const notified = new Promise<null>((resolve) => { wakeNotices = () => resolve(null); });
          try {
            // Keep the same read/deadline while reporting retries during an input stall.
            const result = await Promise.race([reading, notified]);
            if (result !== null) {
              if ('error' in result) throw result.error;
              return result.next;
            }
          } finally { wakeNotices = undefined; }
        }
      };
      try {
        for (;;) {
          if (notices.length) await reportNotices();
          active();
          const next = await nextChunk();
          if (notices.length) await reportNotices();
          active();
          if (next.done) break;
          if (!Buffer.isBuffer(next.value)) throw new MediaError('unavailable', 'Invalid decoded audio data.');
          for (const packet of parser.push(next.value)) {
            if (notices.length) await reportNotices();
            active();
            packets++;
            if (!playbackProgress) input?.markAudioProgress();
            yield packet;
          }
        }
        await bounded(exit, signal, 5000);
        if (notices.length) await reportNotices();
        active();
        parser.finish();
        requireCompleteAudio(expectedMs, packets);
        if (attempts) {
          notices.push({ type: 'recovered', attempts, expectedDurationMs: expectedMs, emittedDurationMs: packets * 20 });
          await reportNotices();
          active();
        }
      } catch (error: unknown) {
        if (signal.aborted || closed) throw new MediaError('cancelled');
        if (input?.failure) throw input.failure;
        if (notices.length) await reportNotices();
        if (failure) throw failure;
        if (error instanceof MediaError && error.code === 'timeout') throw new MediaError('timeout',
          safeDiagnostic(`Decoded audio stalled after ${packets * 20} ms of ${expectedMs} ms expected. ${diagnostic}`));
        throw error;
      } finally { await close(); }
    })();
    return { frames, close, ...(input ? {
      recoveryMode: 'persistent' as const,
      markFrameAdvanced: () => { active(); input.markAudioProgress(); },
      setPaused: (paused: boolean) => input.setPaused(paused),
    } : {}) };
  }
}
