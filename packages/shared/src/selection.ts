import { z } from 'zod';
import { soundDownloadFileNameSchema } from './soundDownloads.js';

export const AUDIO_PREVIEW_MAX_DURATION_MS = 60 * 60 * 1000;

export const selectionLabelSchema = z.string().trim().min(1).max(100);
export const selectionDescriptionSchema = z.string().max(500);

export const audioPreviewUrlSchema = z.string().url().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port;
  } catch {
    return false;
  }
});

export const audioPreviewSourceSchema = z.object({
  url: audioPreviewUrlSchema,
  fileName: soundDownloadFileNameSchema.optional(),
  durationMs: z.number().int().positive().max(AUDIO_PREVIEW_MAX_DURATION_MS).optional(),
}).strict();

export const createSelectionChoiceSchema = (value: z.ZodType<string>) => z.object({
  label: selectionLabelSchema,
  value,
  description: selectionDescriptionSchema.optional(),
  audio: audioPreviewSourceSchema.optional(),
}).strict();

export const selectionChoiceSchema = createSelectionChoiceSchema(
  z.string().min(1).max(100).refine((value) => value.trim().length > 0)
);
export const selectionChoicesSchema = z.array(selectionChoiceSchema);

export type AudioPreviewSource = z.infer<typeof audioPreviewSourceSchema>;
export type SelectionChoice = z.infer<typeof selectionChoiceSchema>;
