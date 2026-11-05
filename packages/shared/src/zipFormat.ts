/**
 * The ZIP format the app writes (#858): the desktop streams batch downloads to
 * disk and the web version builds them in memory, with the same headers. There
 * is no ZIP64, so offsets and sizes stay under 4 GiB.
 */
export const ZIP_LIMIT = 0xffffffff;
export const ZIP_STORE = 0;
export const ZIP_DEFLATE = 8;
export const ZIP_LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
const UTF8_NAMES = 0x0800;
const VERSION = 20;

export class ZipTooLargeError extends Error {
  constructor() {
    super('The ZIP archive would exceed 4 GiB.');
    this.name = 'ZipTooLargeError';
  }
}

export interface ZipDosStamp { time: number; date: number }

/** MS-DOS time and date of an entry; ZIP cannot represent years before 1980. */
export function zipDosDateTime(date: Date): ZipDosStamp {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export interface ZipEntry {
  /** UTF-8 bytes of the entry's path. */
  name: Uint8Array;
  method: typeof ZIP_STORE | typeof ZIP_DEFLATE;
  crc: number;
  compressedSize: number;
  size: number;
  /** Where the entry's local header starts. */
  offset: number;
}

export function zipLocalHeader(entry: ZipEntry, stamp: ZipDosStamp): Uint8Array {
  const header = new Uint8Array(ZIP_LOCAL_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, UTF8_NAMES, true);
  view.setUint16(8, entry.method, true);
  view.setUint16(10, stamp.time, true);
  view.setUint16(12, stamp.date, true);
  view.setUint32(14, entry.crc >>> 0, true);
  view.setUint32(18, entry.compressedSize, true);
  view.setUint32(22, entry.size, true);
  view.setUint16(26, entry.name.length, true);
  return header;
}

function centralHeader(entry: ZipEntry, stamp: ZipDosStamp): Uint8Array {
  const header = new Uint8Array(CENTRAL_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, VERSION, true);
  view.setUint16(8, UTF8_NAMES, true);
  view.setUint16(10, entry.method, true);
  view.setUint16(12, stamp.time, true);
  view.setUint16(14, stamp.date, true);
  view.setUint32(16, entry.crc >>> 0, true);
  view.setUint32(20, entry.compressedSize, true);
  view.setUint32(24, entry.size, true);
  view.setUint16(28, entry.name.length, true);
  view.setUint32(42, entry.offset, true);
  return header;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Central directory, `entries` long, followed by the end record, for an archive whose entries end at `offset`. */
export function zipCentralDirectory(entries: readonly ZipEntry[], stamp: ZipDosStamp, offset: number): Uint8Array {
  const directory = concat(entries.flatMap((entry) => [centralHeader(entry, stamp), entry.name]));
  if (offset + directory.length + END_RECORD_BYTES > ZIP_LIMIT) throw new ZipTooLargeError();
  const end = new Uint8Array(END_RECORD_BYTES);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, directory.length, true);
  view.setUint32(16, offset, true);
  return concat([directory, end]);
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (IEEE), continuing from `previous` like zlib's. */
export function zipCrc32(bytes: Uint8Array, previous = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = ~previous >>> 0;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}

/** An uncompressed (STORE) archive of files already in memory, as the parts of the file in order. */
export function storedZipParts(files: ReadonlyArray<{ name: string; data: Uint8Array }>, modified = new Date()): Uint8Array[] {
  const stamp = zipDosDateTime(modified);
  const parts: Uint8Array[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    if (offset + ZIP_LOCAL_HEADER_BYTES + name.length + file.data.length > ZIP_LIMIT) throw new ZipTooLargeError();
    const entry: ZipEntry = {
      name, method: ZIP_STORE, crc: zipCrc32(file.data), compressedSize: file.data.length, size: file.data.length, offset,
    };
    parts.push(zipLocalHeader(entry, stamp), name, file.data);
    entries.push(entry);
    offset += ZIP_LOCAL_HEADER_BYTES + name.length + file.data.length;
  }
  parts.push(zipCentralDirectory(entries, stamp, offset));
  return parts;
}
