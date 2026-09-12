import path from 'node:path';

const MIME_TYPES: Readonly<Record<string, readonly string[]>> = {
  '.mp3': ['audio/mpeg', 'audio/mp3'],
  '.wav': ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  '.ogg': ['audio/ogg', 'application/ogg'],
  '.m4a': ['audio/mp4', 'audio/x-m4a', 'audio/m4a'],
  '.aac': ['audio/aac', 'audio/aacp', 'audio/x-aac'],
  '.webm': ['audio/webm'],
};

export function isSoundFileName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && Buffer.byteLength(value) <= 255 &&
    value === value.trim() && !value.startsWith('.') &&
    !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(value) && !/[. ]$/.test(value) &&
    !/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:[. ]|$)/i.test(value) &&
    value !== '.' && value !== '..' && !!MIME_TYPES[path.extname(value).toLowerCase()];
}

export function isSoundMime(fileName: string, contentType: string): boolean {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  return MIME_TYPES[path.extname(fileName).toLowerCase()]?.includes(mime) ?? false;
}

export function soundMimeType(fileName: string): string | undefined {
  return MIME_TYPES[path.extname(fileName).toLowerCase()]?.[0];
}

export function soundFileNameForMime(contentType: string): string | undefined {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase();
  const extension = Object.keys(MIME_TYPES).find((candidate) => MIME_TYPES[candidate].includes(mime));
  return extension ? `preview${extension}` : undefined;
}

function mp3FrameLength(bytes: Buffer, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  const header = bytes.readUInt32BE(offset);
  const version = (header >>> 19) & 3;
  const layer = (header >>> 17) & 3;
  const bitrate = (header >>> 12) & 15;
  const rate = (header >>> 10) & 3;
  if ((header >>> 21) !== 0x7ff || version === 1 || layer !== 1 || !bitrate || bitrate === 15 || rate === 3) return 0;
  const rates = [44100, 48000, 32000];
  const bitrates = version === 3
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const sampleRate = rates[rate] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  return Math.floor((version === 3 ? 144 : 72) * bitrates[bitrate] * 1000 / sampleRate) + ((header >>> 9) & 1);
}

function isMp3(bytes: Buffer): boolean {
  let offset = 0;
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') {
    if (bytes.length < 10 || bytes[3] < 2 || bytes[3] > 4 || bytes.subarray(6, 10).some((byte) => byte > 127)) return false;
    offset = 10 + (bytes[6] * 0x200000 + bytes[7] * 0x4000 + bytes[8] * 0x80 + bytes[9]);
    if (bytes[3] === 4 && (bytes[5] & 0x10)) offset += 10;
  }
  // An ID3 tag alone is not audio. Require consecutive complete MPEG frames.
  const first = mp3FrameLength(bytes, offset);
  const second = first ? mp3FrameLength(bytes, offset + first) : 0;
  return first > 0 && second > 0 && offset + first + second <= bytes.length;
}

function isAac(bytes: Buffer): boolean {
  let offset = 0;
  for (let frame = 0; frame < 2; frame++) {
    if (offset + 7 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf6) !== 0xf0 ||
        ((bytes[offset + 2] >> 2) & 15) >= 13) return false;
    const size = ((bytes[offset + 3] & 3) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5);
    if (size < (bytes[offset + 1] & 1 ? 7 : 9) || offset + size > bytes.length) return false;
    offset += size;
  }
  return true;
}

function isWav(bytes: Buffer): boolean {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let format = false;
  let audio = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) return false;
    if (name === 'fmt ') {
      if (size < 16) return false;
      const encoding = bytes.readUInt16LE(start);
      const channels = bytes.readUInt16LE(start + 2);
      format = [1, 3, 0xfffe].includes(encoding) && channels > 0 && channels <= 32 &&
        bytes.readUInt32LE(start + 4) > 0 && bytes.readUInt16LE(start + 12) > 0;
      if (encoding === 0xfffe && size < 40) return false;
    }
    if (name === 'data' && size > 0) audio = true;
    offset = start + size + (size & 1);
  }
  return format && audio;
}

function isOgg(bytes: Buffer): boolean {
  let offset = 0;
  let pages = 0;
  let codec = false;
  while (offset + 27 <= bytes.length) {
    if (bytes.toString('ascii', offset, offset + 4) !== 'OggS' || bytes[offset + 4] !== 0) return false;
    const segments = bytes[offset + 26];
    const start = offset + 27 + segments;
    if (start > bytes.length) return false;
    const length = bytes.subarray(offset + 27, start).reduce((sum, size) => sum + size, 0);
    if (start + length > bytes.length) return false;
    if (pages === 0) codec = (length >= 19 && bytes.toString('ascii', start, start + 8) === 'OpusHead') ||
      (length >= 30 && bytes[start] === 1 && bytes.toString('ascii', start + 1, start + 7) === 'vorbis');
    offset = start + length;
    pages++;
  }
  return codec && pages >= 2 && offset === bytes.length;
}

function isM4a(bytes: Buffer): boolean {
  let brand = false;
  let soundTrack = false;
  let codec = false;
  let audio = false;
  const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
  const walk = (start: number, end: number, depth: number): boolean => {
    if (depth > 8) return false;
    for (let offset = start; offset < end;) {
      if (offset + 8 > end) return false;
      let size = bytes.readUInt32BE(offset);
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) return false;
        const large = bytes.readBigUInt64BE(offset + 8);
        if (large > BigInt(bytes.length)) return false;
        size = Number(large);
        header = 16;
      }
      if (size === 0) size = end - offset;
      if (size < header || offset + size > end) return false;
      const data = bytes.subarray(offset + header, offset + size);
      if (type === 'ftyp' && data.length >= 8) {
        brand = ['M4A ', 'M4B ', 'isom', 'iso2', 'mp41', 'mp42'].some((value) => data.includes(Buffer.from(value)));
      }
      if (type === 'hdlr' && data.length >= 12 && data.toString('ascii', 8, 12) === 'soun') soundTrack = true;
      if (type === 'stsd') codec = codec || ['mp4a', 'alac', 'Opus', 'fLaC'].some((value) => data.includes(Buffer.from(value)));
      if (type === 'mdat' && data.length > 0) audio = true;
      if (containers.has(type) && !walk(offset + header, offset + size, depth + 1)) return false;
      offset += size;
    }
    return true;
  };
  return walk(0, bytes.length, 0) && brand && soundTrack && codec && audio;
}

function isWebm(bytes: Buffer): boolean {
  let docType = false;
  let audioTrack = false;
  let cluster = false;
  const readVint = (offset: number, id: boolean): { value: number; length: number; unknown: boolean } | null => {
    if (offset >= bytes.length || bytes[offset] === 0) return null;
    let length = 1;
    let marker = 0x80;
    while (!(bytes[offset] & marker)) { length++; marker >>= 1; }
    if (length > (id ? 4 : 8) || offset + length > bytes.length) return null;
    let value = id ? bytes[offset] : bytes[offset] & (marker - 1);
    let unknown = !id && value === marker - 1;
    for (let index = 1; index < length; index++) {
      value = value * 256 + bytes[offset + index];
      unknown = unknown && bytes[offset + index] === 255;
    }
    if (!unknown && !Number.isSafeInteger(value)) return null;
    return { value, length, unknown };
  };
  const containers = new Set([0x1a45dfa3, 0x18538067, 0x1654ae6b, 0xae]);
  const walk = (start: number, end: number, depth: number): boolean => {
    if (depth > 6) return false;
    let type = 0;
    let codec = false;
    for (let offset = start; offset < end;) {
      const id = readVint(offset, true);
      const size = id && readVint(offset + id.length, false);
      if (!id || !size) return false;
      const content = offset + id.length + size.length;
      const next = size.unknown ? end : content + size.value;
      if (next > end || next < content) return false;
      if (id.value === 0x4282) docType = bytes.toString('ascii', content, next) === 'webm';
      if (id.value === 0x83 && next - content === 1) type = bytes[content];
      if (id.value === 0x86) codec = ['A_OPUS', 'A_VORBIS'].includes(bytes.toString('ascii', content, next));
      if (id.value === 0x1f43b675 && next > content) cluster = true;
      if (containers.has(id.value) && !walk(content, next, depth + 1)) return false;
      offset = next;
    }
    if (type === 2 && codec) audioTrack = true;
    return true;
  };
  return bytes.length > 4 && bytes.readUInt32BE(0) === 0x1a45dfa3 &&
    walk(0, bytes.length, 0) && docType && audioTrack && cluster;
}

export function isSoundAudio(bytes: Buffer, fileName: string): boolean {
  switch (path.extname(fileName).toLowerCase()) {
    case '.mp3': return isMp3(bytes);
    case '.wav': return isWav(bytes);
    case '.ogg': return isOgg(bytes);
    case '.m4a': return isM4a(bytes);
    case '.aac': return isAac(bytes);
    case '.webm': return isWebm(bytes);
    default: return false;
  }
}
