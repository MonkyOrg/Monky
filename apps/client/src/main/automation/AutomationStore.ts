import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AutomationError, automationAuditSchema, automationConnectionSchema,
  type AutomationConnection, type AutomationMutation, type AutomationSnapshot,
} from '@monky/shared';
import { writeFileAtomicSync } from '../atomicFile';

const storedConnection = automationConnectionSchema.extend({ tokenHash: z.string().regex(/^[a-f0-9]{64}$/) });
const configSchema = z.object({
  enabled: z.boolean(), port: z.number().int().min(0).max(65535),
  connections: z.array(storedConnection).max(32), audit: z.array(automationAuditSchema).max(100),
}).strict();

export class AutomationStore {
  private config: z.infer<typeof configSchema> = { enabled: false, port: 0, connections: [], audit: [] };
  readonly file: string;
  loadError: 'storage_failed' | null = null;

  constructor(profile: string) {
    this.file = join(profile, 'automation.json');
    if (existsSync(this.file)) {
      try { this.config = configSchema.parse(JSON.parse(readFileSync(this.file, 'utf8'))); }
      catch { this.loadError = 'storage_failed'; }
    }
  }

  get enabled(): boolean { return this.config.enabled; }
  get port(): number { return this.config.port; }

  snapshot(): Pick<AutomationSnapshot, 'enabled' | 'connections' | 'audit'> {
    return {
      enabled: this.enabled,
      connections: this.config.connections.map(connection => automationConnectionSchema.strip().parse(connection)),
      audit: structuredClone(this.config.audit),
    };
  }

  authenticate(token: string): AutomationConnection | undefined {
    const digest = createHash('sha256').update(token).digest();
    const connection = this.config.connections.find(item => timingSafeEqual(Buffer.from(item.tokenHash, 'hex'), digest));
    return connection ? automationConnectionSchema.strip().parse(connection) : undefined;
  }

  get(id: string): AutomationConnection | undefined {
    const connection = this.config.connections.find(item => item.id === id);
    return connection ? automationConnectionSchema.strip().parse(connection) : undefined;
  }

  setPort(port: number): void { this.save({ ...this.config, port }); }

  mutate(input: AutomationMutation): { id?: string; token?: string } {
    if (input.action === 'enable') {
      this.save({ ...this.config, enabled: input.enabled });
      return {};
    }
    if (input.action === 'change_port') {
      this.setPort(0);
      return {};
    }
    if (input.action === 'revoke') {
      this.save({ ...this.config, connections: this.config.connections.filter(item => item.id !== input.id) });
      return { id: input.id };
    }
    const previous = input.action === 'rotate'
      ? this.config.connections.find(item => item.id === input.id)
      : input.connection.id ? this.config.connections.find(item => item.id === input.connection.id) : undefined;
    if ((input.action === 'rotate' || input.connection.id) && !previous) throw new AutomationError('invalid_input');
    if (!previous && this.config.connections.length >= 32) throw new AutomationError('invalid_input');
    const connection = input.action === 'save' ? input.connection : previous;
    if (!connection) throw new AutomationError('invalid_input');
    const id = previous?.id ?? randomUUID();
    const token = !previous || input.action === 'rotate' ? randomBytes(32).toString('base64url') : undefined;
    const tokenHash = token ? createHash('sha256').update(token).digest('hex') : previous?.tokenHash;
    if (!tokenHash) throw new AutomationError('invalid_input');
    const next = { ...connection, id, tokenHash };
    this.save({ ...this.config, connections: [...this.config.connections.filter(item => item.id !== id), next] });
    return { id, token };
  }

  record(entry: z.infer<typeof automationAuditSchema>): void {
    this.save({ ...this.config, audit: [...this.config.audit.slice(-99), entry] });
  }

  private save(config: z.infer<typeof configSchema>): void {
    try { writeFileAtomicSync(this.file, JSON.stringify(configSchema.parse(config))); }
    catch { throw new AutomationError('storage_failed'); }
    this.config = config;
    this.loadError = null;
  }
}
