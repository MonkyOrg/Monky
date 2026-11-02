import fs from 'fs';
import path from 'path';
import { LIMITS } from '@monky/shared';
import { writeAtomically } from '../lifecycle/serverLock';

/**
 * The SFU media port a server used last, kept in its data directory.
 *
 * The server reads it to bind the same port again after a restart, so the
 * firewall rule keeps working; the CLI reads it to tell the operator which
 * port to open, since it runs in another process.
 */
const SFU_PORT_FILE = 'sfu-port.json';

export function readSfuMediaPort(dataDir: string): number | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(dataDir, SFU_PORT_FILE), 'utf8'));
    const port = value !== null && typeof value === 'object' && 'port' in value ? value.port : undefined;
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export function writeSfuMediaPort(dataDir: string, port: number): void {
  writeAtomically(path.join(dataDir, SFU_PORT_FILE), `${JSON.stringify({ port })}\n`);
}

/**
 * The port the SFU of this data directory uses or will try first: the one it
 * used last when still inside the range, else the first of the range.
 */
export function expectedSfuMediaPort(
  dataDir: string | undefined, minPort: number = LIMITS.SFU_DEFAULT_MIN_PORT, maxPort: number = LIMITS.SFU_DEFAULT_MAX_PORT,
): number {
  const last = dataDir ? readSfuMediaPort(dataDir) : null;
  return last !== null && last >= minPort && last <= maxPort ? last : minPort;
}
