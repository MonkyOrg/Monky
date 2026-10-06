import { z } from 'zod';
import { LIMITS } from './constants.js';
import { communityImageAssetRefSchema, communityImageUrlSchema } from './communityImages.js';

export const botCarouselFormatSchema = z.enum(['banner', 'landscape', 'square', 'portrait']);
export const botCarouselFitSchema = z.enum(['cover', 'contain']);
export const botCarouselSizeSchema = z.enum(['compact', 'regular', 'wide']);

export const botCarouselPresentationSchema = z.object({
  format: botCarouselFormatSchema.optional(),
  fit: botCarouselFitSchema.optional(),
  size: botCarouselSizeSchema.optional(),
}).strict();

const componentBase = {
  type: z.literal('carousel'),
  label: z.string().trim().min(1).max(200).optional(),
  presentation: botCarouselPresentationSchema.optional(),
};

export const botCarouselInputSchema = z.object({
  ...componentBase,
  imageAssetRefs: z.array(communityImageAssetRefSchema).min(1).max(LIMITS.MAX_LIVE_ACTION_IMAGES),
}).strict();

export const botCarouselComponentSchema = z.object({
  ...componentBase,
  imageUrls: z.array(communityImageUrlSchema).min(1).max(LIMITS.MAX_LIVE_ACTION_IMAGES),
}).strict();

export const botMessageComponentInputSchema = z.discriminatedUnion('type', [botCarouselInputSchema]);
export const botMessageComponentSchema = z.discriminatedUnion('type', [botCarouselComponentSchema]);

export type BotCarouselFormat = z.infer<typeof botCarouselFormatSchema>;
export type BotCarouselFit = z.infer<typeof botCarouselFitSchema>;
export type BotCarouselSize = z.infer<typeof botCarouselSizeSchema>;
export type BotCarouselPresentation = z.infer<typeof botCarouselPresentationSchema>;
export type BotCarouselInput = z.infer<typeof botCarouselInputSchema>;
export type BotCarouselComponent = z.infer<typeof botCarouselComponentSchema>;
export type BotMessageComponentInput = z.infer<typeof botMessageComponentInputSchema>;
export type BotMessageComponent = z.infer<typeof botMessageComponentSchema>;

export const DEFAULT_BOT_CAROUSEL_PRESENTATION = {
  format: 'banner',
  fit: 'cover',
  size: 'regular',
} as const satisfies Required<BotCarouselPresentation>;

export function resolveBotCarouselPresentation(
  presentation?: BotCarouselPresentation,
): Required<BotCarouselPresentation> {
  return { ...DEFAULT_BOT_CAROUSEL_PRESENTATION, ...presentation };
}
