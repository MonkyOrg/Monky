import { z } from 'zod';
import { LIMITS } from './constants.js';
import { selectionDescriptionSchema, selectionLabelSchema, type SelectionChoice } from './selection.js';
import type { CommandOption } from './models.js';

export const BOT_LOCALES = ['pt-BR', 'en'] as const;
export type BotLocale = typeof BOT_LOCALES[number];

export function normalizeBotLocale(value: unknown): BotLocale | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/_/g, '-').split(/[.@]/)[0].toLowerCase();
  if (/^pt(?:-[a-z0-9]{2,8})*$/.test(normalized)) return 'pt-BR';
  if (/^en(?:-[a-z0-9]{2,8})*$/.test(normalized)) return 'en';
  return undefined;
}

export const botLocaleSchema = z.enum(['pt-BR', 'en', 'en-US']).transform((locale): BotLocale =>
  locale === 'en-US' ? 'en' : locale);

export function resolveBotLocale(
  requested: unknown, supported: readonly BotLocale[] = BOT_LOCALES, fallback: BotLocale = 'pt-BR',
): BotLocale {
  const locale = normalizeBotLocale(requested);
  if (locale && supported.includes(locale)) return locale;
  return supported.includes(fallback) ? fallback : supported[0] ?? 'pt-BR';
}

export const botChoiceLocalizationSchema = z.object({
  label: selectionLabelSchema.optional(),
  description: selectionDescriptionSchema.optional(),
}).strict();
export const botFieldLocalizationSchema = botChoiceLocalizationSchema.extend({
  placeholder: z.string().max(150).optional(),
  choices: z.record(z.string().min(1).max(100), botChoiceLocalizationSchema)
    .refine((choices) => Object.keys(choices).length <= LIMITS.MAX_BOT_FORM_CHOICES).optional(),
}).strict();

const commandLocalizationSchema = z.object({
  description: selectionLabelSchema.optional(),
  options: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/)
    .refine((name) => !['__proto__', 'constructor', 'prototype'].includes(name)), botFieldLocalizationSchema)
    .refine((options) => Object.keys(options).length <= LIMITS.MAX_OPTIONS_PER_COMMAND).optional(),
}).strict();
export const commandLocalizationsSchema = z.object({
  'pt-BR': commandLocalizationSchema.optional(),
  en: commandLocalizationSchema.optional(),
}).strict();
export type CommandLocalizations = z.infer<typeof commandLocalizationsSchema>;
export type BotFieldLocalization = z.infer<typeof botFieldLocalizationSchema>;

export function localizeBotChoices(
  choices: SelectionChoice[], localized: BotFieldLocalization['choices'],
): SelectionChoice[] {
  return choices.map((choice) => {
    const text = localized && Object.hasOwn(localized, choice.value) ? localized[choice.value] : undefined;
    return {
      ...choice,
      label: text?.label ?? choice.label,
      description: text?.description ?? choice.description,
    };
  });
}

export function localizeCommand<T extends {
  description: string; options?: CommandOption[]; localizations?: CommandLocalizations;
}>(command: T, requested: unknown): T {
  const localized = command.localizations?.[resolveBotLocale(requested)];
  if (!localized) return command;
  return {
    ...command,
    description: localized.description ?? command.description,
    options: command.options?.map((option) => {
      const text = localized.options?.[option.name];
      if (!text) return option;
      return {
        ...option,
        label: text.label ?? option.label,
        description: text.description ?? option.description,
        placeholder: text.placeholder ?? option.placeholder,
        choices: option.choices ? localizeBotChoices(option.choices, text.choices) : undefined,
      };
    }),
  };
}
