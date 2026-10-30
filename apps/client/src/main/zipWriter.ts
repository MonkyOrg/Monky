import fs from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * ZIP archives written by the main process: a deflated archive built in memory
 * (hosting skills) and a stored one streamed from disk (batch downloads). Both
 * share the same headers. There is no ZIP64, so offsets and sizes stay under 4 GiB.
 */

const ZIP_LIMIT = 0xffffffff;
const UTF8_NAMES = 0x0800;
const VERSION = 20;
const STORE = 0;
const DEFLATE = 8;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;

export class ZipTooLargeError extends Error {
  constructor() {
    super('The ZIP archive would exceed 4 GiB.');
    this.name = 'ZipTooLargeError';
  }
}

interface DosStamp { time: number; date: number }

/** MS-DOS time and date of an entry; ZIP cannot represent years before 1980. */
function dosDateTime(date: Date): DosStamp {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

interface ZipEntry {
  name: Buffer;
  method: typeof STORE | typeof DEFLATE;
  crc: number;
  compressedSize: number;
  size: number;
  /** Where the entry's local header starts. */
  offset: number;
}

function localHeader(entry: ZipEntry, stamp: DosStamp): Buffer {
  const header = Buffer.alloc(LOCAL_HEADER_BYTES);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(UTF8_NAMES, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(stamp.time, 10);
  header.writeUInt16LE(stamp.date, 12);
  header.writeUInt32LE(entry.crc >>> 0, 14);
  header.writeUInt32LE(entry.compressedSize, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  return header;
}

function centralHeader(entry: ZipEntry, stamp: DosStamp): Buffer {
  const header = Buffer.alloc(CENTRAL_HEADER_BYTES);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(VERSION, 4);
  header.writeUInt16LE(VERSION, 6);
  header.writeUInt16LE(UTF8_NAMES, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(stamp.time, 12);
  header.writeUInt16LE(stamp.date, 14);
  header.writeUInt32LE(entry.crc >>> 0, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

/** Central directory, `entries` long, followed by the end record. */
function centralDirectory(entries: ZipEntry[], stamp: DosStamp, offset: number): Buffer {
  const directory = Buffer.concat(entries.flatMap((entry) => [centralHeader(entry, stamp), entry.name]));
  if (offset + directory.length + END_RECORD_BYTES > ZIP_LIMIT) throw new ZipTooLargeError();
  const end = Buffer.alloc(END_RECORD_BYTES);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([directory, end]);
}

/** A deflated archive built in memory, for a few small files such as a skill. */
export function createZip(files: { path: string; data: Buffer }[], modified = new Date()): Buffer {
  const stamp = dosDateTime(modified);
  const records: Buffer[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (const file of files) {
    const compressed = deflateRawSync(file.data);
    const entry: ZipEntry = {
      name: Buffer.from(file.path, 'utf8'), method: DEFLATE, crc: crc32(file.data),
      compressedSize: compressed.length, size: file.data.length, offset,
    };
    records.push(localHeader(entry, stamp), entry.name, compressed);
    entries.push(entry);
    offset += LOCAL_HEADER_BYTES + entry.name.length + compressed.length;
  }
  return Buffer.concat([...records, centralDirectory(entries, stamp, offset)]);
}

/**
 * Writes the files uncompressed (STORE) into `destination`: photos and videos
 * are already compressed, and streaming each file keeps a large batch out of
 * memory. The archive is assembled in a temporary file and only then takes the
 * destination's place, so a failure never leaves a partial ZIP behind.
 */
export async function writeStoredZip(files: { name: string; filePath: string }[], destination: string): Promise<void> {
  const stamp = dosDateTime(new Date());
  const temporary = `${destination}.downloading`;
  const output = await fs.promises.open(temporary, 'w');
  const entries: ZipEntry[] = [];
  let offset = 0;
  try {
    for (const file of files) {
      const name = Buffer.from(file.name, 'utf8');
      const { size } = await fs.promises.stat(file.filePath);
      const dataStart = offset + LOCAL_HEADER_BYTES + name.length;
      if (dataStart + size > ZIP_LIMIT) throw new ZipTooLargeError();
      let crc = 0;
      let position = dataStart;
      for await (const chunk of fs.createReadStream(file.filePath)) {
        if (!Buffer.isBuffer(chunk)) continue;
        crc = crc32(chunk, crc);
        await output.write(chunk, 0, chunk.length, position);
        position += chunk.length;
      }
      if (position - dataStart !== size) throw new Error('File changed while archiving');
      // The header goes in last, once the checksum of the streamed data is known.
      const entry: ZipEntry = { name, method: STORE, crc, compressedSize: size, size, offset };
      await output.write(Buffer.concat([localHeader(entry, stamp), name]), 0, LOCAL_HEADER_BYTES + name.length, offset);
      entries.push(entry);
      offset = position;
    }
    const tail = centralDirectory(entries, stamp, offset);
    await output.write(tail, 0, tail.length, offset);
    await output.close();
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    await output.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
