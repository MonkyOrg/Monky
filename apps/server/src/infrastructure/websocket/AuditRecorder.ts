import {
  EVERYONE_ROLE_ID,
  type ChannelCategory, type ChannelPermissionOverwrite, type ChannelSummary, type CommandValues, type RoleAssignPayload,
  type ServerAuditAction, type ServerAuditRef, type SlashCommand, type UserSummary,
} from '@monky/shared';
import type { BotService } from '../../application/services/BotService';
import type { ChannelService } from '../../application/services/ChannelService';
import type { PermissionService } from '../../application/services/PermissionService';
import type { RoleService } from '../../application/services/RoleService';
import { auditRef, type ServerAuditInput, type ServerAuditService } from '../../application/services/ServerAuditService';
import { channelTreeMoves, type AuditNames } from '../../application/services/serverAuditChanges';
import type { UserService } from '../../application/services/UserService';

/** A reorder from an outdated client can shuffle a whole list; past this, the rest is not itemized. */
const MAX_AUDITED_MOVES = 10;

/** Who did something: a member or a bot, by the connection it did it from. */
export interface AuditActor {
  user?: UserSummary;
  isBot?: boolean;
}

/** The channel list as one moment saw it, to find out afterwards what moved. */
export interface ChannelTree {
  channels: ChannelSummary[];
  categories: ChannelCategory[];
}

/** A role as the audit compares it. */
export interface AuditedRole {
  id: string;
  name: string;
  color: string | null;
  isDefault: boolean;
  permissions: number;
}

export interface AuditRecorderHost {
  readonly audit?: ServerAuditService;
  readonly users: UserService;
  readonly botService?: BotService;
  readonly channels: ChannelService;
  readonly roles: RoleService;
  readonly permissions: PermissionService;
}

/**
 * Writes what members and bots did to the audit log, naming everyone and
 * everything involved as they are called now. On a server without the audit
 * log it records nothing, and `enabled` lets a caller skip reading what it
 * would only compare for the log.
 */
export class AuditRecorder {
  constructor(private readonly host: AuditRecorderHost) {}

  get enabled(): boolean {
    return !!this.host.audit;
  }

  /** Records what a member or bot did; servers without the audit log ignore it. */
  record(actor: AuditActor, action: ServerAuditAction, input: Omit<ServerAuditInput, 'actor'> = {}): void {
    if (!this.host.audit || !actor.user) return;
    this.host.audit.record(action, {
      ...input,
      actor: auditRef.member({ ...actor.user, isBot: actor.isBot === true || actor.user.isBot === true }),
    });
  }

  /** A member or bot by id, with the name it has now. */
  async identity(id: string): Promise<ServerAuditRef> {
    const nickname = (await this.host.users.nicknames([id])).get(id);
    if (nickname !== undefined) return auditRef.user(id, nickname);
    const bot = await this.host.botService?.findById(id);
    return bot ? auditRef.bot(bot.id, bot.name) : auditRef.user(id, id);
  }

  async channel(channelId: string | null | undefined): Promise<ServerAuditRef | null> {
    if (!channelId) return null;
    const channel = await this.host.channels.getChannelSummary(channelId);
    return channel ? auditRef.channel(channel) : null;
  }

  /** Names of the roles, categories and people that changes to channel rules refer to. */
  async names(...withOverwrites: Array<{ permissionOverwrites?: readonly ChannelPermissionOverwrite[] } | null | undefined>): Promise<AuditNames> {
    const userIds = withOverwrites.flatMap((item) =>
      (item?.permissionOverwrites ?? []).flatMap((overwrite) => overwrite.userId !== undefined ? [overwrite.userId] : []));
    const [roles, categories, users] = await Promise.all([
      this.host.roles.listRoles(), this.host.channels.listCategories(), this.host.users.nicknames(userIds),
    ]);
    const roleNames = new Map(roles.map((role) => [role.id, role.name]));
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
    return {
      category: (id) => id ? categoryNames.get(id) ?? null : null,
      role: (id) => roleNames.get(id) ?? id,
      user: (id) => users.get(id) ?? id,
    };
  }

  /** A command and the options it was given; values stay out, since members type anything into them. */
  async command(actor: AuditActor, command: SlashCommand, channelId: string, options: CommandValues): Promise<void> {
    if (!this.host.audit) return;
    const provided = Object.keys(options);
    this.record(actor, 'bot.command', {
      target: auditRef.bot(command.botId, command.botName),
      related: { channel: await this.channel(channelId) },
      detail: `/${command.name}`,
      changes: provided.length ? [{ field: 'commandOptions', after: provided }] : [],
    });
  }

  async channelTree(): Promise<ChannelTree> {
    const [channels, categories] = await Promise.all([this.host.channels.listChannels(), this.host.channels.listCategories()]);
    return { channels, categories };
  }

  /** One entry per item that changed place; a drag records the dragged item, not everything it shifted. */
  recordTreeMoves(actor: AuditActor, before: ChannelTree, after: ChannelTree): void {
    for (const move of channelTreeMoves(before, after).slice(0, MAX_AUDITED_MOVES)) {
      this.record(actor, move.target.type === 'category' ? 'category.move' : 'channel.move', {
        target: move.target,
        related: { category: move.container },
        changes: [{ field: 'position', before: move.from, after: move.to }],
      });
    }
  }

  /** A role as the audit compares it; Everyone is the base every member has. */
  async role(roleId: string): Promise<AuditedRole | undefined> {
    if (roleId === EVERYONE_ROLE_ID) {
      return { id: EVERYONE_ROLE_ID, name: '@everyone', color: null, isDefault: false, permissions: await this.host.permissions.getEveryonePermissions() };
    }
    return (await this.host.roles.listRoles()).find((role) => role.id === roleId);
  }

  /** Assigning a role someone already has, or removing one they lack, changes nothing and is not recorded. */
  async roleAssignment(payload: RoleAssignPayload): Promise<{ held: boolean; role?: ServerAuditRef } | undefined> {
    if (!this.host.audit || typeof payload?.userId !== 'string' || typeof payload.roleId !== 'string') return undefined;
    const [roles, userRoles] = await Promise.all([this.host.roles.listRoles(), this.host.roles.listUserRoles()]);
    const role = roles.find((entry) => entry.id === payload.roleId);
    return {
      held: userRoles.some((entry) => entry.userId === payload.userId && entry.roleIds.includes(payload.roleId)),
      role: role ? auditRef.role(role) : undefined,
    };
  }
}
