import {
  ProtocolErrorCode, botCapabilitiesSchema, botPermissionsUpdateSchema,
  type BotCapability, type BotPermissions, type BotPermissionsUpdate,
} from '@monky/shared';
import type { IBotPermissionRepository } from '../../domain/repositories';

export class BotPermissionError extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string) { super(message); }
}

export class BotPermissionService {
  constructor(private readonly repository: IBotPermissionRepository) {}

  get(botId: string): BotPermissions | undefined { return this.repository.findById(botId); }

  allows(botId: string, ...capabilities: BotCapability[]): boolean {
    const state = this.get(botId);
    return !!state && capabilities.every((capability) =>
      state.requested?.includes(capability) && state.granted.includes(capability));
  }

  declare(botId: string, input: BotCapability[]): { permissions: BotPermissions; changed: boolean } {
    const requested = botCapabilitiesSchema.parse(input);
    return this.repository.transaction(() => {
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
  }

  approve(userId: string, input: BotPermissionsUpdate): BotPermissions {
    const parsed = botPermissionsUpdateSchema.parse(input);
    return this.repository.transaction(() => {
      const previous = this.require(parsed.botId);
      if (previous.revision !== parsed.expectedRevision) {
        throw new BotPermissionError(ProtocolErrorCode.BOT_PERMISSIONS_CONFLICT, 'Bot permissions changed. Reload before reviewing again.');
      }
      if (previous.requested === null || parsed.granted.some((capability) => !previous.requested?.includes(capability))) {
        throw new BotPermissionError(ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED, 'Approve only capabilities declared by this bot.');
      }
      const permissions: BotPermissions = {
        ...previous, granted: parsed.granted, revision: this.increment(previous.revision),
        reviewRequired: false, reviewedBy: userId, reviewedAt: Date.now(),
      };
      this.repository.save(parsed.botId, permissions);
      return permissions;
    });
  }

  private require(botId: string): BotPermissions {
    const state = this.get(botId);
    if (!state) throw new BotPermissionError(ProtocolErrorCode.BAD_REQUEST, 'Bot not found.');
    return state;
  }

  private increment(revision: number): number {
    if (!Number.isSafeInteger(revision + 1)) throw new Error('Bot permission revision limit reached.');
    return revision + 1;
  }
}
