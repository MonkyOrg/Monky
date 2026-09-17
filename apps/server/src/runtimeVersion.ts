import fs from 'node:fs';
import path from 'node:path';
import { isReleaseVersion } from '@monky/shared';

export function resolveServerVersion(override?: string): string {
  if (override !== undefined) {
    if (!isReleaseVersion(override)) throw new Error('Invalid server runtime version.');
    return override;
  }
  const manifest: unknown = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !('name' in manifest) || manifest.name !== '@monky/server' ||
      !('version' in manifest) || !isReleaseVersion(manifest.version)) {
    throw new Error('The server package does not contain a valid runtime version.');
  }
  return manifest.version;
}
