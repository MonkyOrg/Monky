import { z } from 'zod';
import { LIMITS } from './constants.js';
import { resolveBotLocale } from './botLocales.js';

const text = z.string().trim().min(1).max(LIMITS.MAX_MESSAGE_LENGTH);
export const botMessageLocalizationsSchema = z.object({
  'pt-BR': text.optional(),
  en: text.optional(),
}).strict().refine(value => value['pt-BR'] !== undefined || value.en !== undefined, 'Provide at least one message translation');
export type BotMessageLocalizations = z.infer<typeof botMessageLocalizationsSchema>;

export const botLocalizedMessageSchema = z.object({
  content: text,
  localizations: botMessageLocalizationsSchema.optional(),
}).strict();
export type BotLocalizedMessage = z.infer<typeof botLocalizedMessageSchema>;
export type BotMessageContent = string | BotLocalizedMessage;

export function normalizeBotMessageContent(value: BotMessageContent): BotLocalizedMessage {
  return botLocalizedMessageSchema.parse(typeof value === 'string' ? { content: value } : value);
}

/** Variants are bot-authored text, never machine translations of a user's message. */
export function getMessageText(
  message: BotLocalizedMessage & { isBot?: boolean; deletedAt?: number | null }, requestedLocale: unknown,
): string {
  if (message.deletedAt) return '';
  return (message.isBot ? message.localizations?.[resolveBotLocale(requestedLocale)] : undefined) ?? message.content;
}

export function botMessagePreviewLocalizations(localizations?: BotMessageLocalizations): BotMessageLocalizations | undefined {
  if (!localizations) return undefined;
  return {
    ...(localizations['pt-BR'] !== undefined ? { 'pt-BR': localizations['pt-BR'].slice(0, 200) } : {}),
    ...(localizations.en !== undefined ? { en: localizations.en.slice(0, 200) } : {}),
  };
}

export const botCommandContextSchema = z.object({
  invocationId: z.string().min(1).max(128),
  commandName: z.string().min(1).max(128),
  invokerId: z.string().min(1).max(128),
  invokerNickname: z.string().min(1).max(128),
  invokerAvatarUrl: z.string().nullable().optional(),
}).strict();
