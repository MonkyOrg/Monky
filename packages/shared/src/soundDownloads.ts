import { z } from 'zod';
import { LIMITS } from './constants.js';

const identifier = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative().safe();
const avatarUrl = z.string().max(2048).nullable().optional();

export const SOUNDBOARD_AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm'] as const;

export const soundDownloadUrlSchema = z.string().url().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
});

export const soundDownloadFileNameSchema = z.string().min(1).max(128).refine((value) =>
  value === value.trim() &&
  !value.startsWith('.') && !value.endsWith('.') &&
  !/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(value) &&
  !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|$)/i.test(value) &&
  SOUNDBOARD_AUDIO_EXTENSIONS.some((extension) => value.toLowerCase().endsWith(extension))
);

export const soundDownloadRequestSchema = z.object({
  url: soundDownloadUrlSchema,
  fileName: soundDownloadFileNameSchema,
  title: z.string().trim().min(1).max(100),
}).strict();

export const soundDownloadFailureReasonSchema = z.enum([
  'no_folder', 'invalid_request', 'invalid_url', 'blocked_url', 'invalid_file_name',
  'unsupported_audio', 'too_large', 'http_error', 'network_error', 'write_failed', 'timeout',
]);

export const soundDownloadResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('downloaded') }).strict(),
  z.object({ status: z.literal('exists') }).strict(),
  z.object({ status: z.literal('failed'), reason: soundDownloadFailureReasonSchema }).strict(),
  z.object({ status: z.literal('cancelled') }).strict(),
]);

export type SoundDownloadRequest = z.infer<typeof soundDownloadRequestSchema>;
export type SoundDownloadFailureReason = z.infer<typeof soundDownloadFailureReasonSchema>;
export type SoundDownloadResult = z.infer<typeof soundDownloadResultSchema>;

export const commandSoundDownloadSchema = soundDownloadRequestSchema.extend({
  invocationId: identifier,
});

export const commandSoundDownloadReceivedSchema = commandSoundDownloadSchema.extend({
  downloadId: identifier,
  channelId: identifier,
  botId: identifier,
  botName: z.string().min(1).max(LIMITS.MAX_NICKNAME_LENGTH),
  botAvatarUrl: avatarUrl,
  commandName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  invokerId: identifier,
  invokerNickname: z.string().min(1).max(LIMITS.MAX_NICKNAME_LENGTH),
  invokerAvatarUrl: avatarUrl,
  createdAt: timestamp,
  expiresAt: timestamp,
}).refine((payload) => payload.expiresAt >= payload.createdAt);

export const commandSoundDownloadCancelSchema = z.object({
  invocationId: identifier,
  downloadId: identifier,
}).strict();

export const commandSoundDownloadResultSchema = commandSoundDownloadCancelSchema.extend({
  result: soundDownloadResultSchema,
});
