import {
  Permission, ProtocolErrorCode, canAccessChannel, hasPermission,
  type ChannelAccessRules, type ChannelSummary, type ChannelType,
} from '@monky/shared';
import type { ChannelAccessContext, ChannelAccessScope, ChannelService } from './ChannelService';
import type { UserService } from './UserService';

/**
 * Who may take part in a bot interaction in a channel: a person invoking a
 * command, answering a selector or using a miniapp, or the bot acting for one.
 * Every surface states its rule here, so a fix to it is made once (BOTS-8).
 */

/** Which check refused. */
export type BotAccessDenial = 'member' | 'channel' | 'interact';

export interface BotAccessRequirement {
  readonly channelTypes: readonly ChannelType[];
  /** The principal is a person, who must still be a member. A bot is judged by its approved capabilities. */
  readonly human: boolean;
  /** Without these the channel counts as unavailable, as it does without VIEW_CHANNEL. */
  readonly see: readonly Permission[];
  /** Needed to interact, on top of seeing the channel. */
  readonly interact: readonly Permission[];
  /** The channel must accept bot commands. */
  readonly commandsEnabled: boolean;
  /** The order the checks run in; the first refusal is the answer, as each surface always gave it. */
  readonly order: readonly BotAccessDenial[];
}

/** What the checks read about a principal and a channel. */
export interface BotAccessFacts {
  channel: ChannelSummary | null;
  /** The principal's permissions inside the channel (ChannelAccessScope.channelContext). */
  context: ChannelAccessContext;
  /** The channel's rules as they apply to the principal (ChannelService.rulesFor). */
  rules: ChannelAccessRules | null;
  isMember: boolean;
}

/** Why the principal may not take part, or undefined when they may. Reads nothing. */
export function evaluateBotChannelAccess(facts: BotAccessFacts, requirement: BotAccessRequirement): BotAccessDenial | undefined {
  const { channel, context, rules } = facts;
  const holds = (permissions: readonly Permission[]) => permissions.every((permission) => hasPermission(context.permissions, permission));
  for (const check of requirement.order) {
    if (check === 'member') {
      if (requirement.human && !facts.isMember) return 'member';
    } else if (check === 'channel') {
      if (!channel || !rules || !requirement.channelTypes.includes(channel.type) || !holds(requirement.see) ||
          !canAccessChannel(rules, context.permissions, context.roleIds, context.isBot === true, context.userId)) return 'channel';
    } else if ((requirement.commandsEnabled && !channel?.botCommandsEnabled) || !holds(requirement.interact)) {
      return 'interact';
    }
  }
  return undefined;
}

const TEXT_OR_VOICE: readonly ChannelType[] = ['TEXT', 'VOICE'];
const VOICE: readonly ChannelType[] = ['VOICE'];

const COMMAND_CALLER: BotAccessRequirement = {
  channelTypes: TEXT_OR_VOICE, human: true, see: [], interact: [Permission.SEND_MESSAGES, Permission.USE_BOT_COMMANDS],
  commandsEnabled: true, order: ['member', 'channel', 'interact'],
};

/**
 * The rule of each surface, kept as it was. They differ where the surfaces
 * always did, until the owner decides otherwise: a selector asks people for
 * READ_MESSAGES and a command does not, and acting on a miniapp needs
 * USE_BOT_COMMANDS alone where invoking a command also needs SEND_MESSAGES.
 */
export const BotAccess = {
  /** A person invoking a command, or still behind one. */
  commandCaller: COMMAND_CALLER,
  /** The voice room a command brings its bot into (to speak) or shows a miniapp in, for the person behind it. */
  voiceRoom(speak: boolean): BotAccessRequirement {
    return { channelTypes: VOICE, human: true, see: [], interact: speak ? [Permission.SPEAK] : [], commandsEnabled: false, order: ['channel', 'interact'] };
  },
  /** A selector: people see it with READ_MESSAGES and answer it with SEND_MESSAGES and USE_BOT_COMMANDS; its bot needs SEND_MESSAGES. */
  selector(human: boolean, interact: boolean, commandsEnabled: boolean): BotAccessRequirement {
    return {
      channelTypes: TEXT_OR_VOICE, human, see: human ? [Permission.READ_MESSAGES] : [],
      interact: !interact ? [] : human ? [Permission.SEND_MESSAGES, Permission.USE_BOT_COMMANDS] : [Permission.SEND_MESSAGES],
      commandsEnabled, order: ['channel', 'interact', 'member'],
    };
  },
  /** A miniapp, in a voice room: people act on it with USE_BOT_COMMANDS; its bot needs SEND_MESSAGES. */
  screen(human: boolean, interact: boolean): BotAccessRequirement {
    return {
      channelTypes: VOICE, human, see: [],
      interact: !interact ? [] : [human ? Permission.USE_BOT_COMMANDS : Permission.SEND_MESSAGES],
      commandsEnabled: false, order: ['channel', 'member', 'interact'],
    };
  },
};

/** How selectors and miniapps word a refusal. Miniapps answer a lost membership with PERMISSION_DENIED instead. */
export const BOT_ACCESS_REFUSALS: Readonly<Record<BotAccessDenial, { code: ProtocolErrorCode; message: string }>> = {
  channel: { code: ProtocolErrorCode.CHANNEL_NOT_FOUND, message: 'Channel is unavailable.' },
  interact: { code: ProtocolErrorCode.PERMISSION_DENIED, message: 'Bot interactions are not permitted in this channel.' },
  member: { code: ProtocolErrorCode.UNAUTHORIZED, message: 'Membership is required.' },
};

/** The reads a series of checks shares while access stays the same (BOTS-3). */
export interface BotAccessReads {
  readonly key: string | null;
  readonly scope: ChannelAccessScope;
  readonly members: Map<string, Promise<boolean>>;
}

/** Reads what the policy needs, once per channel and member within a fan-out, and asks it. */
export class BotAccessGate {
  constructor(
    private readonly channels: Pick<ChannelService, 'accessScope' | 'rulesFor'>,
    private readonly users: Pick<UserService, 'isMember'>,
  ) {}

  /** Fresh reads, for one check or for a fan-out under `key`. */
  reads(key: string | null = null): BotAccessReads {
    return { key, scope: this.channels.accessScope(), members: new Map() };
  }

  /**
   * The reads one fan-out shares: reaching every recipient reads the channel
   * and each member once while `key()` holds, and afresh once it moves. A null
   * key, while a change is under way, is never shared (BOTS-3).
   */
  fanOut(key: () => string | null): () => BotAccessReads {
    let shared: BotAccessReads | undefined;
    return () => {
      const current = key();
      if (!shared || current === null || shared.key !== current) shared = this.reads(current);
      return shared;
    };
  }

  /** Why `userId` may not take part in a bot interaction in `channelId`, if anything. */
  async check(
    userId: string, channelId: string, requirement: BotAccessRequirement, reads: BotAccessReads = this.reads(),
  ): Promise<BotAccessDenial | undefined> {
    const [channel, context] = await Promise.all([reads.scope.channel(channelId), reads.scope.channelContext(userId, channelId)]);
    const isMember = requirement.human && requirement.order.includes('member') ? await this.isMember(reads, userId) : true;
    return evaluateBotChannelAccess({ channel, context, rules: channel && this.channels.rulesFor(channel, context), isMember }, requirement);
  }

  private isMember(reads: BotAccessReads, userId: string): Promise<boolean> {
    let member = reads.members.get(userId);
    if (!member) {
      member = this.users.isMember(userId);
      reads.members.set(userId, member);
    }
    return member;
  }
}

export interface StableAccess<T> {
  /** The access versions; null while a change is under way. */
  version(): string | null;
  check(): Promise<void>;
  /** Runs right after a check that no access change crossed. */
  use(): T;
  /** A refusal that may have come from the change that crossed the check, worth checking again. */
  isRefusal(error: unknown): boolean;
  /** What to throw when access would not hold still. */
  busy(): Error;
  /** What else must still hold for `use` to run; checked like the versions. */
  current?(): boolean;
}

/**
 * Checks, then uses what the check allowed, with no access change in between.
 * When the versions move during the check it runs again, a refusal included,
 * up to eight times; while a role write is pending it stops at once. Either
 * way it ends with `busy`, never looping without end (BOTS-8).
 */
export async function withStableAccess<T>(access: StableAccess<T>, attempts = 8): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const version = access.version();
    if (version === null) break;
    const unchanged = () => version === access.version();
    try {
      await access.check();
    } catch (error: unknown) {
      if (access.isRefusal(error) && !unchanged()) continue;
      throw error;
    }
    if (unchanged() && (access.current?.() ?? true)) return access.use();
  }
  throw access.busy();
}
