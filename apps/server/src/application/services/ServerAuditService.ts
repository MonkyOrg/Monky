import {
  SERVER_AUDIT_ACTIONS, SERVER_AUDIT_ACTIVITY_ACTIONS, SERVER_AUDIT_LIMITS, serverAuditEntrySchema, serverAuditPageSchema,
  type ServerAuditAction, type ServerAuditChange, type ServerAuditEntry, type ServerAuditGetRequest,
  type ServerAuditPagePayload, type ServerAuditRef, type ServerAuditValue,
} from '@monky/shared';
import type { IServerAuditRepository } from '../../domain/repositories';
import { Logger } from '../../infrastructure/logger/Logger';
import type { RateLimiter } from '../../infrastructure/security/RateLimiter';

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = SERVER_AUDIT_LIMITS.RETENTION_DAYS * DAY_MS;
/** Pruning runs at startup and every this many entries, so the table stays bounded without a timer. */
const PRUNE_EVERY = 100;
const ACTIVITY_ACTIONS = new Set<ServerAuditAction>(SERVER_AUDIT_ACTIVITY_ACTIONS);

export interface ServerAuditInput {
  /** Null only when the server acts on its own. */
  actor: ServerAuditRef | null;
  target?: ServerAuditRef | null;
  related?: Record<string, ServerAuditRef | null | undefined>;
  changes?: readonly ServerAuditChange[];
  detail?: string | null;
}

/**
 * References carry the name as it was when the action happened: the audit
 * keeps telling what was done even after the channel, role or member is gone.
 */
export const auditRef = {
  member: (user: { id: string; nickname: string; isBot?: boolean }): ServerAuditRef =>
    ({ type: user.isBot ? 'bot' : 'user', id: user.id, name: user.nickname }),
  user: (id: string, name: string): ServerAuditRef => ({ type: 'user', id, name }),
  bot: (id: string, name: string): ServerAuditRef => ({ type: 'bot', id, name }),
  channel: (channel: { id: string; name: string }): ServerAuditRef => ({ type: 'channel', id: channel.id, name: channel.name }),
  category: (category: { id: string; name: string }): ServerAuditRef => ({ type: 'category', id: category.id, name: category.name }),
  role: (role: { id: string; name: string }): ServerAuditRef => ({ type: 'role', id: role.id, name: role.name }),
  of: (type: string, id: string, name: string): ServerAuditRef => ({ type, id, name }),
};

function sameValue(a: ServerAuditValue | undefined, b: ServerAuditValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => value === b[index]);
  return a === b;
}

/** One change per field whose value differs; equal fields are left out. */
export function auditDiff(fields: ReadonlyArray<readonly [string, ServerAuditValue | undefined, ServerAuditValue | undefined]>): ServerAuditChange[] {
  return fields.flatMap(([field, before, after]) => sameValue(before, after) ? [] : [{
    field,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  }]);
}

/** Lowercase without accents, so "acao" finds "Ação". */
export function normalizeAuditSearch(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clampRef(ref: ServerAuditRef): ServerAuditRef {
  return { type: ref.type, id: ref.id, name: clamp(ref.name, SERVER_AUDIT_LIMITS.MAX_NAME_LENGTH) };
}

function clampValue(value: ServerAuditValue): ServerAuditValue {
  if (typeof value === 'string') return clamp(value, SERVER_AUDIT_LIMITS.MAX_VALUE_LENGTH);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.slice(0, SERVER_AUDIT_LIMITS.MAX_LIST_ITEMS).map((item) => clamp(item, SERVER_AUDIT_LIMITS.MAX_NAME_LENGTH));
  }
  return value;
}

function clampChange(change: ServerAuditChange): ServerAuditChange {
  return {
    field: change.field,
    ...(change.before !== undefined ? { before: clampValue(change.before) } : {}),
    ...(change.after !== undefined ? { after: clampValue(change.after) } : {}),
  };
}

export class ServerAuditService {
  private recordedSincePrune = 0;

  constructor(
    public readonly serverId: string,
    private readonly repository: IServerAuditRepository,
    private readonly rateLimiter: RateLimiter,
    private readonly now: () => number = Date.now,
  ) {
    this.prune();
  }

  /**
   * Never throws: the action already happened, and failing to describe it must
   * not turn a successful change into an error for whoever made it.
   */
  public record(action: ServerAuditAction, input: ServerAuditInput): void {
    try {
      const related: Record<string, ServerAuditRef> = {};
      for (const [key, ref] of Object.entries(input.related ?? {})) if (ref) related[key] = clampRef(ref);
      const entry: Omit<ServerAuditEntry, 'id'> = {
        createdAt: this.now(),
        action,
        actor: input.actor ? clampRef(input.actor) : null,
        target: input.target ? clampRef(input.target) : null,
        related,
        changes: (input.changes ?? []).slice(0, SERVER_AUDIT_LIMITS.MAX_CHANGES).map(clampChange),
        detail: input.detail ? clamp(input.detail, SERVER_AUDIT_LIMITS.MAX_DETAIL_LENGTH) : null,
      };
      if (!serverAuditEntrySchema.safeParse({ ...entry, id: 1 }).success) {
        Logger.warn('DATABASE', `Discarded an invalid audit entry for ${action}.`);
        return;
      }
      // Repeating a cheap action only fills that person's share; it never floods the log.
      if (ACTIVITY_ACTIONS.has(action) && entry.actor && !this.rateLimiter.checkLimit(
        `server-audit-activity:${entry.actor.id}`, SERVER_AUDIT_LIMITS.ACTIVITY_ENTRIES_PER_MINUTE, 60_000,
      )) return;
      const searchText = normalizeAuditSearch([
        entry.actor?.name, entry.target?.name, ...Object.values(related).map((ref) => ref.name), entry.detail,
      ].filter(Boolean).join('\n'));
      this.repository.append(entry, SERVER_AUDIT_ACTIONS[action], searchText);
      if (++this.recordedSincePrune >= PRUNE_EVERY) this.prune();
    } catch (error) {
      Logger.error('DATABASE', `Could not record the audit entry for ${action}.`, error);
    }
  }

  public allowRequest(userId: string): boolean {
    return this.rateLimiter.checkLimit(
      `server-audit:${userId}`, SERVER_AUDIT_LIMITS.REQUESTS_PER_WINDOW, SERVER_AUDIT_LIMITS.RATE_WINDOW_MS,
    ) && this.rateLimiter.checkLimit('server-audit:global', SERVER_AUDIT_LIMITS.TOTAL_REQUESTS_PER_SECOND, 1000);
  }

  public list(request: ServerAuditGetRequest): ServerAuditPagePayload {
    const limit = request.limit ?? SERVER_AUDIT_LIMITS.PAGE_SIZE;
    const search = request.query ? normalizeAuditSearch(request.query) : '';
    const rows = this.repository.list({
      before: request.before,
      after: request.after,
      category: request.category,
      search: search || undefined,
      createdSince: this.now() - RETENTION_MS,
      limit: limit + 1,
    });
    return serverAuditPageSchema.parse({
      serverId: this.serverId,
      entries: rows.slice(0, limit),
      hasMore: rows.length > limit,
      retentionDays: SERVER_AUDIT_LIMITS.RETENTION_DAYS,
    });
  }

  private prune(): void {
    this.recordedSincePrune = 0;
    try {
      this.repository.prune(
        this.now() - RETENTION_MS, SERVER_AUDIT_ACTIVITY_ACTIONS,
        SERVER_AUDIT_LIMITS.MAX_ACTIVITY_ENTRIES, SERVER_AUDIT_LIMITS.MAX_ENTRIES - SERVER_AUDIT_LIMITS.MAX_ACTIVITY_ENTRIES,
      );
    } catch (error) {
      Logger.error('DATABASE', 'Could not prune the audit log.', error);
    }
  }
}
