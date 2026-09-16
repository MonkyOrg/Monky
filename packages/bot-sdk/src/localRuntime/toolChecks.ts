import { MediaError, aborted, type MediaErrorCode } from './errors';
import { capture, safeDiagnostic } from './process';

/** Explicit executable locations; this module never resolves environment or home-directory defaults. */
export interface MediaToolPaths {
  readonly node: string;
  readonly ytDlp: string;
  readonly ffmpeg: string;
}

export type MediaTool = keyof MediaToolPaths;

export const MEDIA_TOOL_NAMES: Readonly<Record<MediaTool, string>> = {
  node: 'Node.js', ytDlp: 'yt-dlp', ffmpeg: 'FFmpeg/libopus',
};

// Standalone yt-dlp unpacks on startup; native cold starts can exceed five seconds on busy hosts.
const CHECK_TIMEOUT_MS: Readonly<Record<MediaTool, number>> = { node: 5000, ytDlp: 30_000, ffmpeg: 15_000 };

export class MediaToolError extends MediaError {
  constructor(
    readonly tool: MediaTool, readonly executable: string, code: MediaErrorCode, detail: string,
  ) {
    super(code, `${MEDIA_TOOL_NAMES[tool]}: ${safeDiagnostic(detail)}`);
    this.name = 'MediaToolError';
  }
}

export function youtubeExtractorArgs(node: string): string[] {
  return [
    '--ignore-config', '--no-cache-dir', '--no-plugin-dirs',
    '--no-js-runtimes', '--js-runtimes', `node:${node}`, '--no-remote-components',
  ];
}

/** Return the executable's compact version only after its required capabilities pass. */
export async function checkMediaTool(
  tool: MediaTool, paths: MediaToolPaths, signal: AbortSignal, run: typeof capture = capture,
): Promise<string> {
  aborted(signal);
  const timeoutMs = CHECK_TIMEOUT_MS[tool];
  try {
    if (tool === 'node') {
      const version = (await run(paths.node, ['--version'], signal, timeoutMs, 65536)).trim();
      aborted(signal);
      const major = version.length <= 128 ? /^v(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.exec(version)?.[1] : undefined;
      if (!major) throw new MediaError('runtime', 'The executable did not return a valid Node.js version.');
      if (Number(major) < 22) throw new MediaError('runtime', `Node.js 22+ required; received ${version}.`);
      return version;
    }
    if (tool === 'ytDlp') {
      const version = (await run(paths.ytDlp, [...youtubeExtractorArgs(paths.node), '--version'], signal, timeoutMs, 65536)).trim();
      aborted(signal);
      if (version.length > 128 || !/^\d{4}\.\d{2}\.\d{2}(?:[.+-][0-9A-Za-z.-]+)?$/.test(version)) {
        throw new MediaError('tools', 'The executable did not return a valid yt-dlp version.');
      }
      return version;
    }
    const output = await run(paths.ffmpeg, ['-version'], signal, timeoutMs, 65536);
    aborted(signal);
    const firstLine = output.trim().split(/\r?\n/, 1)[0];
    const version = /^ffmpeg version ([0-9A-Za-z][0-9A-Za-z._+-]*)(?:[ \t]|$)/.exec(firstLine)?.[1];
    if (!version || version.length > 128) {
      throw new MediaError('tools', 'The executable did not return a valid FFmpeg version.');
    }
    const encoders = await run(paths.ffmpeg, ['-hide_banner', '-encoders'], signal, timeoutMs, 131072);
    aborted(signal);
    if (!/^\s*A[A-Z.]{5}\s+libopus(?:\s|$)/m.test(encoders)) {
      throw new MediaError('tools', 'The executable does not provide the libopus encoder.');
    }
    return version;
  } catch (error: unknown) {
    if (signal.aborted) throw new MediaError('cancelled');
    const original = error instanceof MediaError ? error : undefined;
    const code = original && ['busy', 'timeout', 'runtime', 'cancelled'].includes(original.code)
      ? original.code : tool === 'node' ? 'runtime' : 'tools';
    throw new MediaToolError(tool, paths[tool], code, original?.detail ||
      (code === 'timeout' ? `The executable check timed out (process limit: ${timeoutMs} ms).`
        : error instanceof Error ? error.message : 'The executable could not be checked.'));
  }
}

export async function checkMediaTools(
  paths: MediaToolPaths, signal: AbortSignal, run: typeof capture = capture,
): Promise<void> {
  for (const tool of ['node', 'ytDlp', 'ffmpeg'] as const) await checkMediaTool(tool, paths, signal, run);
}
