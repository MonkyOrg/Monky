import { randomUUID } from 'node:crypto';
import {
  ProtocolErrorCode,
  nativePollCreateSchema,
  nativePollSchema,
  projectResourceAudience,
  type NativePoll,
  type NativePollCreate,
} from '@monky/shared';
import type { MessageRecord, NativePollRecord } from '../../domain/entities';
import type { INativePollRepository } from '../../domain/repositories';

export class NativePollError extends Error {
  constructor(message: string, readonly code = ProtocolErrorCode.BAD_REQUEST) { super(message); }
}

export class NativePollService {
  constructor(
    readonly repository: INativePollRepository,
    private readonly media: {
      consume(refs: string[], userId: string, channelId: string): string[];
      delete(paths: string[]): void;
    } = {
      consume: refs => {
        if (refs.length > 0) throw new NativePollError('Poll images are unavailable.');
        return [];
      },
      delete: () => undefined,
    },
    private readonly access: {
      canView(userId: string, poll: NativePollRecord): Promise<boolean>;
      canRevealAudience(userId: string, poll: NativePollRecord): Promise<boolean>;
    } = {
      canView: async () => true,
      canRevealAudience: async () => false,
    },
  ) {}

  create(userId: string, input: NativePollCreate, now = Date.now()): { poll: NativePollRecord; created: boolean } {
    const parsed = nativePollCreateSchema.parse(input);
    const messageId = parsed.clientMessageId ?? randomUUID();
    const existing = this.repository.findByMessageId(messageId);
    if (existing) {
      const durationMinutes = existing.closesAt === null ? undefined :
        Math.round((existing.closesAt - existing.createdAt) / 60_000);
      const same = existing.creatorUserId === userId &&
        existing.channelId === parsed.channelId &&
        existing.question === parsed.question &&
        existing.allowMultiple === (parsed.allowMultiple ?? false) &&
        existing.imagePaths.length === (parsed.imageAssetRefs?.length ?? 0) &&
        durationMinutes === parsed.durationMinutes &&
        existing.maxVoters === (parsed.maxVoters ?? null) &&
        existing.liveAction === (parsed.liveAction ?? false) &&
        JSON.stringify(existing.audience) === JSON.stringify(parsed.audience) &&
        JSON.stringify(existing.options.map(({ label, emoji }) => ({ label, emoji }))) === JSON.stringify(parsed.options);
      if (!same) throw new NativePollError('Message identifier already used.');
      return { poll: existing, created: false };
    }
    if (this.repository.messageExists(messageId)) throw new NativePollError('Message identifier already used.');
    let imagePaths: string[];
    try {
      imagePaths = this.media.consume(parsed.imageAssetRefs ?? [], userId, parsed.channelId);
    } catch (error) {
      throw error instanceof NativePollError ? error :
        new NativePollError(error instanceof Error ? error.message : 'Poll images are unavailable.');
    }
    const poll: NativePollRecord = {
      id: randomUUID(),
      messageId,
      channelId: parsed.channelId,
      creatorUserId: userId,
      question: parsed.question,
      allowMultiple: parsed.allowMultiple ?? false,
      imagePaths,
      options: parsed.options.map(option => ({ id: randomUUID(), ...option })),
      allowChange: true,
      closesAt: parsed.durationMinutes === undefined ? null : now + parsed.durationMinutes * 60_000,
      maxVoters: parsed.maxVoters ?? null,
      closedAt: null,
      liveAction: parsed.liveAction ?? false,
      createdAt: now,
      revision: 0,
      audience: parsed.audience,
    };
    const message: MessageRecord = {
      id: messageId,
      channelId: parsed.channelId,
      userId,
      content: parsed.question,
      createdAt: now,
      isSystem: false,
    };
    try {
      return this.repository.createWithMessage(poll, message);
    } catch (error) {
      this.media.delete(imagePaths);
      throw error;
    }
  }

  get(id: string): NativePollRecord {
    const poll = this.repository.findById(id);
    if (!poll) throw new NativePollError('Poll not found.', ProtocolErrorCode.PERMISSION_DENIED);
    return poll;
  }

  vote(userId: string, id: string, optionIds: string[], now = Date.now()): NativePollRecord {
    const before = this.get(id);
    if (before.closedAt !== null || (before.closesAt !== null && before.closesAt <= now)) {
      this.repository.closeExpired(now);
      throw new NativePollError('Poll is closed.');
    }
    if (optionIds.length === 0 || new Set(optionIds).size !== optionIds.length ||
        optionIds.some(optionId => !before.options.some(option => option.id === optionId))) {
      throw new NativePollError('Poll option not found.');
    }
    if (!before.allowMultiple && optionIds.length !== 1) throw new NativePollError('This poll accepts one answer.');
    const previous = this.repository.votesForUser(id, userId);
    if (previous.length > 0 && !before.allowChange &&
        (previous.length !== optionIds.length || previous.some(optionId => !optionIds.includes(optionId)))) {
      throw new NativePollError('This vote can no longer be changed.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    return this.repository.vote(id, userId, optionIds, now) ?? this.get(id);
  }

  publicPoll(record: NativePollRecord, userId?: string, revealAudience = false): NativePoll {
    const counts = this.repository.voteCounts(record.id);
    const options = record.options.map(option => ({ ...option, votes: counts.get(option.id) ?? 0 }));
    const { imagePaths, ...publicRecord } = record;
    return nativePollSchema.parse({
      ...publicRecord,
      imageUrls: imagePaths.map(path => `/avatars/${path}`),
      options,
      totalVotes: this.repository.voterCount(record.id),
      myVoteOptionIds: userId ? this.repository.votesForUser(record.id, userId) : null,
      audience: projectResourceAudience(record.audience, revealAudience),
    });
  }

  async canView(userId: string, poll: NativePollRecord): Promise<boolean> {
    return this.access.canView(userId, poll);
  }

  async publicPollForUser(record: NativePollRecord, userId: string): Promise<NativePoll> {
    return this.publicPoll(record, userId, await this.access.canRevealAudience(userId, record));
  }

  async pollsForMessages(messageIds: string[], userId?: string): Promise<Map<string, NativePoll>> {
    const result = new Map<string, NativePoll>();
    for (const poll of this.repository.findByMessageIds(messageIds)) {
      if (userId && !await this.canView(userId, poll)) continue;
      result.set(poll.messageId, userId ? await this.publicPollForUser(poll, userId) : this.publicPoll(poll));
    }
    return result;
  }

  activeLiveActions(userId: string, now = Date.now()): NativePoll[] {
    return this.repository.listActiveLiveActions(now).map(poll => this.publicPoll(poll, userId));
  }

  advance(now = Date.now()): NativePoll[] {
    return this.repository.closeExpired(now).map(poll => this.publicPoll(poll));
  }

  close(id: string, now = Date.now()): NativePollRecord {
    const poll = this.get(id);
    if (poll.closedAt !== null) return poll;
    return this.repository.closeById(id, now) ?? this.get(id);
  }

  closeForMessage(messageId: string, now = Date.now()): NativePoll | undefined {
    const poll = this.repository.closeByMessageId(messageId, now);
    return poll ? this.publicPoll(poll) : undefined;
  }

  deleteForMessages(messageIds: string[]): void {
    const polls = this.repository.findByMessageIds(messageIds);
    this.media.delete(polls.flatMap(poll => poll.imagePaths));
    this.repository.deleteByMessageIds(messageIds);
  }
}
