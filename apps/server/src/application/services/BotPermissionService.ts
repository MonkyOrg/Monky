import {
  Permission, ProtocolErrorCode, botCapabilitiesSchema, botPermissionsUpdateSchema,
  type BotCapability, type BotPermissions, type BotPermissionsUpdate,
} from '@monky/shared';
import type { IBotPermissionRepository } from '../../domain/repositories';
import { ServiceError } from '../errors';

export class BotPermissionError extends ServiceError {}

/**
 * Bot capability grants. They are checked on every bot message, every channel
 * check (a member who is not a bot is told apart here) and every broadcast of
 * commands or settings, so they are kept in memory, read once (BOTS-5). Only
 * this service writes them, and BotService reports every bot it adds or deletes
 * through `refresh`. The memory belongs to this instance: another instance over
 * the same database does not see these writes.
 */
export class BotPermissionService {
  private states?: Map<string, BotPermissions>;

  constructor(private readonly repository: IBotPermissionRepository) {}

  get(botId: string): BotPermissions | undefined { return this.cached().get(botId); }

  /** Rereads one bot after its row was created or deleted. */
  refresh(botId: string): void {
    if (!this.states) return;
    const state = this.repository.findById(botId);
    if (state) this.states.set(botId, frozen(state));
    else this.states.delete(botId);
  }

  allows(botId: string, ...capabilities: BotCapability[]): boolean {
    const state = this.get(botId);
    return !!state && capabilities.every((capability) =>
      state.requested?.includes(capability) && state.granted.includes(capability));
  }

  getChannelPermissions(botId: string): number | undefined {
    const state = this.get(botId);
    if (!state) return undefined;
    const channelCapabilities = [
      ['read_messages', Permission.READ_MESSAGES],
      ['send_messages', Permission.SEND_MESSAGES],
      ['publish_voice', Permission.SPEAK],
      ['receive_voice', Permission.SPEAK],
    ] as const;
    return channelCapabilities.reduce((permissions, [capability, flag]) =>
      state.requested?.includes(capability) && state.granted.includes(capability) ? permissions | flag : permissions, Permission.VIEW_CHANNEL);
  }

  declare(botId: string, input: BotCapability[]): { permissions: BotPermissions; changed: boolean } {
    const requested = botCapabilitiesSchema.parse(input);
    const result = this.repository.transaction(() => {
      const previous = this.require(botId);
      if (JSON.stringify(previous.requested) === JSON.stringify(requested)) return { permissions: previous, changed: false };
      const permissions: BotPermissions = {
        requested,
        // An updated bot retains only previously approved, still-requested access.
        granted: previous.granted.filter((capability) => requested.includes(capability)),
        revision: this.increment(previous.revision), reviewRequired: true, reviewedBy: null, reviewedAt: null,
      };
      this.repository.save(botId, permissions);
      return { permissions, changed: true };
    });
    // Only once committed: a failed save leaves the previous state in place.
    if (result.changed) this.remember(botId, result.permissions);
    return result;
  }

  approve(userId: string, input: BotPermissionsUpdate): BotPermissions {
    const parsed = botPermissionsUpdateSchema.parse(input);
    const permissions = this.repository.transaction(() => {
      const previous = this.require(parsed.botId);
      if (previous.revision !== parsed.expectedRevision) {
        throw new BotPermissionError(ProtocolErrorCode.BOT_PERMISSIONS_CONFLICT, 'Bot permissions changed. Reload before reviewing again.');
      }
      if (previous.requested === null || parsed.granted.some((capability) => !previous.requested?.includes(capability))) {
        throw new BotPermissionError(ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED, 'Approve only capabilities declared by this bot.');
      }
      const next: BotPermissions = {
        ...previous, granted: parsed.granted, revision: this.increment(previous.revision),
        reviewRequired: false, reviewedBy: userId, reviewedAt: Date.now(),
      };
      this.repository.save(parsed.botId, next);
      return next;
    });
    this.remember(parsed.botId, permissions);
    return permissions;
  }

  private cached(): Map<string, BotPermissions> {
    if (!this.states) {
      this.states = new Map();
      for (const [botId, state] of this.repository.listAll()) this.states.set(botId, frozen(state));
    }
    return this.states;
  }

  private remember(botId: string, permissions: BotPermissions): void {
    this.cached().set(botId, frozen(permissions));
  }

  /** Writes compare revisions against the stored state, never against memory. */
  private require(botId: string): BotPermissions {
    const state = this.repository.findById(botId);
    if (!state) throw new BotPermissionError(ProtocolErrorCode.BAD_REQUEST, 'Bot not found.');
    return state;
  }

  private increment(revision: number): number {
    if (!Number.isSafeInteger(revision + 1)) throw new Error('Bot permission revision limit reached.');
    return revision + 1;
  }
}

/** Cached states are shared by every caller, so none of them may change one. */
function frozen(state: BotPermissions): BotPermissions {
  if (state.requested) Object.freeze(state.requested);
  Object.freeze(state.granted);
  return Object.freeze(state);
}
