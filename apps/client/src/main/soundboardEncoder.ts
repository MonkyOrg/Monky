import { spawn } from 'node:child_process';
import { isSoundAudio } from './soundAudioValidation';

const CODECS: Readonly<Record<string, readonly string[]>> = {
  '.mp3': ['-c:a', 'libmp3lame', '-q:a', '2', '-f', 'mp3'],
  '.ogg': ['-c:a', 'libvorbis', '-q:a', '6', '-f', 'ogg'],
  '.aac': ['-c:a', 'aac', '-b:a', '192k', '-f', 'adts'],
  '.m4a': ['-c:a', 'aac', '-b:a', '192k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4'],
  '.webm': ['-c:a', 'libopus', '-b:a', '192k', '-f', 'webm'],
};

export function supportsSoundboardEncoding(extension: string): boolean { return extension in CODECS; }

export interface SoundboardEncoder {
  available(): Promise<boolean>;
  encode(bytes: Uint8Array, extension: string, duration: number, channels: number): Promise<{ bytes: Uint8Array; duration: number }>;
}

/** Executable comes only from the profile's verified LocalTools provider, never PATH. */
export function createSoundboardEncoder(resolve: () => Promise<string | null>): SoundboardEncoder {
  async function run(executable: string, input: Uint8Array, args: readonly string[], decodedLimit?: number): Promise<{ bytes: Buffer; size: number }> {
    return new Promise((resolveOutput, reject) => {
      const child = spawn(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
        '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-map', '0:a:0', '-vn', '-sn', '-dn', ...args, 'pipe:1'],
      { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let size = 0, failed = false, diagnostic = '';
      const fail = () => { failed = true; child.kill(); };
      const timer = setTimeout(fail, 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        timer.refresh();
        size += chunk.length;
        if (decodedLimit !== undefined) {
          if (size > decodedLimit) fail();
        } else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
      child.stdin.on('error', () => { failed = true; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        if (failed || code !== 0 || size === 0) reject(new Error('encode_failed', {
          cause: new Error(diagnostic || `FFmpeg exited with code ${code}; output bytes: ${size}; interrupted: ${failed}`),
        }));
        else {
          try { resolveOutput({ bytes: Buffer.concat(chunks, decodedLimit === undefined ? size : 0), size }); }
          catch (error: unknown) { reject(error); }
        }
      });
      child.stdin.end(input);
    });
  }
  return {
    async available() { return (await resolve()) !== null; },
    async encode(bytes, extension, expectedDuration, channels) {
      const executable = await resolve();
      const codec = CODECS[extension];
      if (!executable) throw new Error('encoder_unavailable');
      if (!codec) throw new Error('unsupported');
      const encoded = await run(executable, bytes, ['-ar', '48000', ...codec]);
      if (!isSoundAudio(encoded.bytes, `edited${extension}`)) throw new Error('encode_failed');
      // Report actual decoded duration, including codec padding, rather than pretending container bytes are PCM.
      const decoded = await run(executable, encoded.bytes, ['-ar', '48000', '-c:a', 'pcm_f32le', '-f', 'f32le'],
        Math.ceil((expectedDuration + 0.25) * 48000) * channels * 4);
      const duration = decoded.size / (48000 * channels * 4);
      if (!Number.isInteger(decoded.size / (channels * 4)) || Math.abs(duration - expectedDuration) > 0.25) {
        throw new Error('encode_failed');
      }
      return { bytes: encoded.bytes, duration };
    },
  };
}
