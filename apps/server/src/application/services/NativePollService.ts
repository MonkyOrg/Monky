import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  NATIVE_POLL_VOTER_PREVIEW_LIMIT,
  ProtocolErrorCode,
  nativePollCreateSchema,
  nativePollEditSchema,
  nativePollSchema,
  nativePollVotersSchema,
  planNativePollEdit,
  projectResourceAudience,
  type NativePoll,
  type NativePollCreate,
  type NativePollEdit,
  type NativePollEditPlan,
  type NativePollVoter,
  type NativePollVoters,
} from '@monky/shared';
import type { MessageRecord, NativePollRecord, NativePollVoterRecord } from '../../domain/entities';
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
    private readonly avatarUrl: (avatarPath: string | null) => string | null =
      avatarPath => avatarPath ? `/avatars/${basename(avatarPath)}` : null,
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
        existing.anonymousVotes === (parsed.anonymousVotes ?? false) &&
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
      anonymousVotes: parsed.anonymousVotes ?? false,
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

  /** `optionIds` is the member's complete answer set; an empty set withdraws the vote. */
  vote(userId: string, id: string, optionIds: string[], now = Date.now()): NativePollRecord {
    const before = this.get(id);
    if (before.closedAt !== null || (before.closesAt !== null && before.closesAt <= now)) {
      this.repository.closeExpired(now);
      throw new NativePollError('Poll is closed.');
    }
    if (new Set(optionIds).size !== optionIds.length ||
        optionIds.some(optionId => !before.options.some(option => option.id === optionId))) {
      throw new NativePollError('Poll option not found.');
    }
    if (!before.allowMultiple && optionIds.length > 1) throw new NativePollError('This poll accepts one answer.');
    const previous = this.repository.votesForUser(id, userId);
    if (previous.length > 0 && !before.allowChange &&
        (previous.length !== optionIds.length || previous.some(optionId => !optionIds.includes(optionId)))) {
      throw new NativePollError('This vote can no longer be changed.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    return this.repository.vote(id, userId, optionIds, now) ?? this.get(id);
  }

  /**
   * Changes an open poll. Votes follow `planNativePollEdit`: answers whose votes
   * are discarded receive a new id, so a stale selection can never match them.
   */
  edit(userId: string, input: NativePollEdit, now = Date.now()): NativePollRecord {
    const parsed = nativePollEditSchema.parse(input);
    const before = this.get(parsed.id);
    if (before.closedAt !== null || (before.closesAt !== null && before.closesAt <= now)) {
      this.repository.closeExpired(now);
      throw new NativePollError('Poll is closed.');
    }
    const known = new Set(before.options.map(option => option.id));
    if (parsed.options.some(option => option.id !== undefined && !known.has(option.id))) {
      throw new NativePollError('The poll changed. Reload before editing.', ProtocolErrorCode.COMMUNITY_CONFLICT);
    }
    const closesAt = parsed.durationMinutes === undefined ? before.closesAt
      : parsed.durationMinutes === null ? null : now + parsed.durationMinutes * 60_000;
    if (closesAt === null && parsed.maxVoters === null) throw new NativePollError('A duration or voter limit is required.');
    const keptImages = parsed.images.flatMap(image => image.startsWith('/avatars/') ? [image.slice('/avatars/'.length)] : []);
    if (keptImages.some(path => !before.imagePaths.includes(path))) throw new NativePollError('Poll image is unavailable.');

    const plan = planNativePollEdit(before, parsed);
    if (before.revision !== parsed.expectedRevision && this.editDiscardsVotes(before, plan, parsed.maxVoters)) {
      throw new NativePollError('Votes changed while the poll was being edited.', ProtocolErrorCode.COMMUNITY_CONFLICT);
    }
    const relabeled = new Set(plan.relabeledOptionIds);
    const options = parsed.options.map(option => ({
      id: option.id !== undefined && plan.resetAll === null && !relabeled.has(option.id) ? option.id : randomUUID(),
      label: option.label,
      emoji: option.emoji,
    }));
    let added: string[];
    try {
      added = this.media.consume(parsed.images.filter(image => !image.startsWith('/avatars/')), userId, before.channelId);
    } catch (error) {
      throw error instanceof NativePollError ? error :
        new NativePollError(error instanceof Error ? error.message : 'Poll images are unavailable.');
    }
    let next = 0;
    const imagePaths = parsed.images.map(image => image.startsWith('/avatars/') ? image.slice('/avatars/'.length) : added[next++]);
    let edited: NativePollRecord | undefined;
    try {
      edited = this.repository.edit({
        ...before,
        question: parsed.question,
        options,
        allowMultiple: parsed.allowMultiple,
        anonymousVotes: parsed.anonymousVotes,
        imagePaths,
        closesAt,
        maxVoters: parsed.maxVoters,
        liveAction: parsed.liveAction,
        audience: parsed.audience,
      }, plan.singleAnswer, now);
    } finally {
      if (!edited) this.media.delete(added);
    }
    if (!edited) throw new NativePollError('Poll is closed.');
    this.media.delete(before.imagePaths.filter(path => !imagePaths.includes(path)));
    return edited;
  }

  /** Whether saving now would discard a vote or close the poll; the editor reviewed an older state. */
  private editDiscardsVotes(poll: NativePollRecord, plan: NativePollEditPlan, maxVoters: number | null): boolean {
    const counts = this.repository.voteCounts(poll.id);
    const voters = this.repository.voterCount(poll.id);
    const answers = [...counts.values()].reduce((sum, count) => sum + count, 0);
    if (plan.resetAll) return voters > 0;
    return [...plan.relabeledOptionIds, ...plan.removedOptionIds].some(id => (counts.get(id) ?? 0) > 0) ||
      (plan.singleAnswer && answers > voters) ||
      (maxVoters !== null && voters >= maxVoters);
  }

  publicPoll(record: NativePollRecord, userId?: string, revealAudience = false): NativePoll {
    const counts = this.repository.voteCounts(record.id);
    const voters = record.anonymousVotes
      ? undefined : this.repository.votersByOption(record.id, NATIVE_POLL_VOTER_PREVIEW_LIMIT);
    const options = record.options.map(option => ({
      ...option,
      votes: counts.get(option.id) ?? 0,
      ...(voters ? { voters: (voters.get(option.id) ?? []).map(voter => this.publicVoter(voter)) } : {}),
    }));
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

  /** Complete voter list; anonymous polls never reveal who voted, not even to their creator. */
  voters(record: NativePollRecord): NativePollVoters {
    if (record.anonymousVotes) throw new NativePollError('Votes in this poll are anonymous.', ProtocolErrorCode.PERMISSION_DENIED);
    const voters = this.repository.votersByOption(record.id);
    return nativePollVotersSchema.parse({
      id: record.id,
      options: record.options.map(option => ({
        id: option.id,
        voters: (voters.get(option.id) ?? []).map(voter => this.publicVoter(voter)),
      })),
    });
  }

  private publicVoter(voter: NativePollVoterRecord): NativePollVoter {
    return { userId: voter.userId, userNickname: voter.nickname, userAvatarUrl: this.avatarUrl(voter.avatarPath) };
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
