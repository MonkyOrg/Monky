import { randomUUID } from 'crypto';
import { promises as fs, type Stats } from 'fs';
import path from 'path';
import { botRegistrationSchema } from '@monky/shared';

const MAX_REGISTRATIONS = 1000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const registrationSchema = botRegistrationSchema.required({ serverId: true, serverUrl: true })
  .refine((registration) => {
    try {
      return !new URL(registration.serverUrl).hash;
    } catch {
      return false;
    }
  });

export type BotRegistration = ReturnType<typeof registrationSchema.parse>;

export class RegistrationStore {
  private records = new Map<string, BotRegistration>();
  private loading: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private filename: string | undefined;

  constructor(filename: string | undefined, private publicKey: string) {
    if (filename !== undefined) {
      if (!filename.trim()) throw new Error('registrationFile must not be empty.');
      this.filename = path.resolve(filename);
    }
  }

  get size(): number {
    return this.records.size;
  }

  get(serverId: string): BotRegistration | undefined {
    return this.records.get(serverId);
  }

  async load(): Promise<BotRegistration[]> {
    this.loading ??= this.read();
    await this.loading;
    return [...this.records.values()];
  }

  save(registration: BotRegistration): Promise<void> {
    const result = this.writes.then(async () => {
      await this.load();
      const parsed = registrationSchema.parse(registration);
      const next = new Map(this.records);
      next.set(parsed.serverId, parsed);
      if (next.size > MAX_REGISTRATIONS) throw new Error('The bot registration limit has been reached.');
      if (this.filename) {
        const contents = JSON.stringify({
          version: 1, publicKey: this.publicKey, registrations: [...next.values()],
        }) + '\n';
        if (Buffer.byteLength(contents) > MAX_FILE_BYTES) throw new Error('The bot registration file limit has been reached.');
        await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
        const temporary = `${this.filename}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, this.filename);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }
      this.records = next;
    });
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  flush(): Promise<void> {
    return this.writes;
  }

  private async read(): Promise<void> {
    if (!this.filename) return;
    let stat: Stats;
    try {
      stat = await fs.stat(this.filename);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      throw new Error('The bot registration file is invalid or too large.');
    }
    const contents = await fs.readFile(this.filename, 'utf8');
    let stored: unknown;
    try {
      stored = JSON.parse(contents);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error('The bot registration file contains invalid JSON. Restore its backup; it was not overwritten.');
    }
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored) ||
        !('version' in stored) || stored.version !== 1 ||
        !('publicKey' in stored) || !('registrations' in stored)) {
      throw new Error('The bot registration file has an unsupported format. It was not overwritten.');
    }
    if (stored.publicKey !== this.publicKey) {
      throw new Error('Saved registrations belong to a different bot identity. Restore the matching keys and registration file.');
    }
    const parsed = registrationSchema.array().max(MAX_REGISTRATIONS).safeParse(stored.registrations);
    if (!parsed.success || new Set(parsed.data.map((entry) => entry.serverId)).size !== parsed.data.length) {
      throw new Error('The bot registration file contains invalid or duplicate entries. It was not overwritten.');
    }
    this.records = new Map(parsed.data.map((entry) => [entry.serverId, entry]));
  }
}
