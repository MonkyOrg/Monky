import { z } from 'zod';

export const REACTION_LIMITS = {
  MAX_EMOJI_LENGTH: 64,
  MAX_PER_MESSAGE: 500,
  MAX_DISTINCT_EMOJI: 20,
} as const;

const emojiSequence = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)$/u;

/** One Unicode emoji, including flags, skin tones and joined families. */
export const reactionEmojiSchema = z.string().max(REACTION_LIMITS.MAX_EMOJI_LENGTH)
  .regex(emojiSequence, 'Expected a single emoji');

export const chatReactionSchema = z.object({
  channelId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(128),
  emoji: reactionEmojiSchema,
}).strict();

export interface ReactionUser {
  userId: string;
  userNickname: string;
}

export interface MessageReaction {
  emoji: string;
  users: ReactionUser[];
}

export type ChatReactionPayload = z.infer<typeof chatReactionSchema>;

export const chatReactionEventSchema = chatReactionSchema.extend({
  userId: z.string().min(1).max(128),
  userNickname: z.string().min(1).max(128),
});

export type ChatReactionEventPayload = z.infer<typeof chatReactionEventSchema>;

/** An acknowledged, persistent plain-text bot post. */
export const botChatMessageSchema = z.object({
  id: z.string().min(1).max(128),
  channelId: z.string().min(1).max(128),
  userId: z.string().min(1).max(128),
  userNickname: z.string(),
  userAvatarUrl: z.string().nullable().optional(),
  content: z.string(),
  createdAt: z.number().finite(),
  isSystem: z.boolean().optional(),
  isBot: z.boolean().optional(),
});
