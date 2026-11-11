import { z } from 'zod';

const reference = z.string().min(1).max(256);
export const MAX_IDENTITY_BAN_DURATION_SECONDS = 315_360_000;
export const identityBanSchema = z.object({
  targetUserId: reference,
  reason: z.string().trim().min(1).max(1000),
  showReason: z.boolean(),
  /** Null is permanent; a relative duration cannot expire while the form is open. */
  durationSeconds: z.number().int().min(1).max(MAX_IDENTITY_BAN_DURATION_SECONDS).nullable(),
}).strict();
export type IdentityBanRequest = z.infer<typeof identityBanSchema>;
export const identityUnbanSchema = z.object({ publicKey: reference, banId: z.number().int().positive().optional() }).strict();
export type IdentityUnbanRequest = z.infer<typeof identityUnbanSchema>;
export const IDENTITY_BAN_HISTORY_PAGE_SIZE = 50;
export const identityBanHistoryRequestSchema = z.object({
  scope: z.enum(['active', 'all']),
  beforeId: z.number().int().positive().optional(),
}).strict();
export type IdentityBanHistoryRequest = z.infer<typeof identityBanHistoryRequestSchema>;
const moderatorSchema = z.object({ id: reference, nickname: reference }).strict();
export type IdentityBanModerator = z.infer<typeof moderatorSchema>;
export const identityBanHistoryEntrySchema = z.object({
  id: z.number().int().positive(),
  publicKey: reference,
  nickname: reference,
  reason: z.string().min(1).max(1000),
  showReason: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative().nullable(),
  createdBy: moderatorSchema.nullable(),
  endedAt: z.number().int().nonnegative().nullable(),
  endedBy: moderatorSchema.nullable(),
  status: z.enum(['active', 'expired', 'revoked', 'replaced']),
}).strict();
export type IdentityBanHistoryEntry = z.infer<typeof identityBanHistoryEntrySchema>;
export const identityBanHistoryPageSchema = z.object({
  entries: z.array(identityBanHistoryEntrySchema).max(IDENTITY_BAN_HISTORY_PAGE_SIZE),
  nextCursor: z.number().int().positive().nullable(),
}).strict();
export type IdentityBanHistoryPage = z.infer<typeof identityBanHistoryPageSchema>;
export const identityBanNoticeSchema = z.object({
  expiresAt: z.number().int().nonnegative().nullable(),
  reason: z.string().min(1).max(1000).optional(),
}).strict();
export type IdentityBanNotice = z.infer<typeof identityBanNoticeSchema>;
export interface IdentityBanSummary {
  publicKey: string;
  nickname: string;
  reason: string;
  showReason: boolean;
  createdAt: number;
  expiresAt: number | null;
}
export interface OwnIdentitySession {
  sessionId: string;
  /** Opaque installation id, only ever sent back to this same identity. */
  deviceId: string;
  connectedAt: number;
  current: boolean;
}
export const identitySessionDisconnectSchema = z.object({ sessionId: reference }).strict();
export type IdentitySessionDisconnect = z.infer<typeof identitySessionDisconnectSchema>;
