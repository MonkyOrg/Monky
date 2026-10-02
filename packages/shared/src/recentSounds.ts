import { z } from 'zod';
import { LIMITS } from './constants.js';

export const recentSoundMimeTypeSchema = z.enum([
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/webm',
]);

export const recentSoundEntrySchema = z.object({
  id: z.string().uuid(),
  soundName: z.string().min(1).max(100),
  mimeType: recentSoundMimeTypeSchema,
  sizeBytes: z.number().int().positive().max(LIMITS.MAX_SOUNDBOARD_FILE_SIZE),
  playedAt: z.number().int().nonnegative(),
  userId: z.string().min(1).max(128),
  userName: z.string().min(1).max(100),
}).strict();

export const recentSoundsListSchema = z.object({
  enabled: z.boolean(),
  limit: z.number().int()
    .min(LIMITS.RECENT_SOUND_CACHE_MIN_LIMIT)
    .max(LIMITS.RECENT_SOUND_CACHE_MAX_LIMIT),
  items: z.array(recentSoundEntrySchema).max(LIMITS.RECENT_SOUND_CACHE_MAX_LIMIT),
}).strict();

export const recentSoundDownloadSchema = recentSoundEntrySchema.extend({
  audioBase64: z.string().min(1).max(Math.ceil(LIMITS.MAX_SOUNDBOARD_FILE_SIZE / 3) * 4 + 8),
}).strict();

export type RecentSoundMimeType = z.infer<typeof recentSoundMimeTypeSchema>;
export type RecentSoundEntry = z.infer<typeof recentSoundEntrySchema>;
export type RecentSoundsList = z.infer<typeof recentSoundsListSchema>;
export type RecentSoundDownload = z.infer<typeof recentSoundDownloadSchema>;
