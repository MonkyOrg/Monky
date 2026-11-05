import fs from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  ZIP_DEFLATE, ZIP_LIMIT, ZIP_LOCAL_HEADER_BYTES, ZIP_STORE, ZipTooLargeError, zipCentralDirectory, zipDosDateTime, zipLocalHeader,
  type ZipEntry,
} from '@monky/shared';

export { ZipTooLargeError } from '@monky/shared';

/**
 * ZIP archives written by the main process: a deflated archive built in memory
 * (hosting skills) and a stored one streamed from disk (batch downloads). The
 * headers are the shared ones the web version also writes (`@monky/shared`).
 */
/** A deflated archive built in memory, for a few small files such as a skill. */
export function createZip(files: { path: string; data: Buffer }[], modified = new Date()): Buffer {
  const stamp = zipDosDateTime(modified);
  const records: Uint8Array[] = [];
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (const file of files) {
    const compressed = deflateRawSync(file.data);
    const entry: ZipEntry = {
      name: Buffer.from(file.path, 'utf8'), method: ZIP_DEFLATE, crc: crc32(file.data),
      compressedSize: compressed.length, size: file.data.length, offset,
    };
    records.push(zipLocalHeader(entry, stamp), entry.name, compressed);
    entries.push(entry);
    offset += ZIP_LOCAL_HEADER_BYTES + entry.name.length + compressed.length;
  }
  return Buffer.concat([...records, zipCentralDirectory(entries, stamp, offset)]);
}

/**
 * Writes the files uncompressed (STORE) into `destination`: photos and videos
 * are already compressed, and streaming each file keeps a large batch out of
 * memory. The archive is assembled in a temporary file and only then takes the
 * destination's place, so a failure never leaves a partial ZIP behind.
 */
export async function writeStoredZip(files: { name: string; filePath: string }[], destination: string): Promise<void> {
  const stamp = zipDosDateTime(new Date());
  const temporary = `${destination}.downloading`;
  const output = await fs.promises.open(temporary, 'w');
  const entries: ZipEntry[] = [];
  let offset = 0;
  try {
    for (const file of files) {
      const name = Buffer.from(file.name, 'utf8');
      const { size } = await fs.promises.stat(file.filePath);
      const dataStart = offset + ZIP_LOCAL_HEADER_BYTES + name.length;
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
      const entry: ZipEntry = { name, method: ZIP_STORE, crc, compressedSize: size, size, offset };
      await output.write(Buffer.concat([zipLocalHeader(entry, stamp), name]), 0, ZIP_LOCAL_HEADER_BYTES + name.length, offset);
      entries.push(entry);
      offset = position;
    }
    const tail = zipCentralDirectory(entries, stamp, offset);
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
