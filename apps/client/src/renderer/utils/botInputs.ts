import {
  validateBotFormValues,
  validateCommandOptions,
  type BotCommandMessagePayload,
  type BotCommandContext,
  type BotForm,
  type BotFormField,
  type BotFormValues,
  type BotInputError,
  type BotInputResult,
  type ChatMessage,
  type CommandValues,
  type SlashCommand,
  type UserSummary,
} from '@monky/shared';
import { t, type TranslationKey } from '../i18n';

export type BotInputField = BotFormField | {
  type: 'user';
  name: string;
  label: string;
  description?: string;
  required?: boolean;
  placeholder?: string;
};

export function commandInputFields(command: SlashCommand): BotInputField[] {
  return (command.options ?? []).map((option): BotInputField => {
    const base = { name: option.name, label: option.description, required: option.required };
    if (option.type === 'boolean') return { ...base, type: 'boolean' };
    if (option.type === 'integer') {
      return { ...base, type: 'integer', min: option.min, max: option.max, placeholder: option.placeholder };
    }
    if (option.type === 'user') return { ...base, type: 'user', placeholder: option.placeholder };
    if (option.choices) return { ...base, type: 'select', choices: option.choices, placeholder: option.placeholder };
    return { ...base, type: 'text', placeholder: option.placeholder, multiline: true };
  });
}

export function visibleCommandFields(command: SlashCommand, optionalNames: string[]): BotInputField[] {
  const fields = commandInputFields(command);
  return [
    ...fields.filter((field) => field.required),
    ...fields.filter((field) => !field.required && optionalNames.includes(field.name)),
  ];
}

export function visibleCommandValues(command: SlashCommand, values: BotFormValues, optionalNames: string[]): BotFormValues {
  const visible: BotFormValues = {};
  for (const field of visibleCommandFields(command, optionalNames)) {
    const value = values[field.name];
    if (value !== undefined) visible[field.name] = value;
  }
  return visible;
}

export function initialBotInputValues(fields: BotInputField[]): BotFormValues {
  const values: BotFormValues = {};
  for (const field of fields) {
    const value = 'defaultValue' in field ? field.defaultValue : undefined;
    if (value !== undefined) values[field.name] = Array.isArray(value) ? [...value] : value;
    else if (field.type === 'boolean' && field.required) values[field.name] = false;
  }
  return values;
}

/** Keep raw input while editing; convert only whole decimal integers at submission. */
export function convertBotInputValues(fields: BotInputField[], inputs: BotFormValues): BotFormValues {
  const values: BotFormValues = { ...inputs };
  for (const field of fields) {
    const value = values[field.name];
    if (field.type === 'integer' && typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
      const number = Number(value);
      if (Number.isSafeInteger(number)) values[field.name] = number;
    }
  }
  return values;
}

export function commandValuesFromInputs(
  command: SlashCommand,
  inputs: BotFormValues,
  members: Pick<UserSummary, 'id'>[]
): BotInputResult<CommandValues> {
  const result = validateCommandOptions(
    command.options ?? [],
    convertBotInputValues(commandInputFields(command), inputs)
  );
  if (!result.success) return result;
  for (const option of command.options ?? []) {
    const value = result.values[option.name];
    if (option.type === 'user' && value !== undefined && !members.some((member) => member.id === value)) {
      return { success: false, field: option.name, reason: 'choice' };
    }
  }
  return result;
}

export function formValuesFromInputs(form: BotForm, inputs: BotFormValues): BotInputResult<BotFormValues> {
  return validateBotFormValues(form, convertBotInputValues(form.fields, inputs));
}

export type TypedCommand =
  | { kind: 'chat' }
  | { kind: 'unavailable' }
  | { kind: 'ambiguous'; commands: SlashCommand[]; text: string }
  | { kind: 'command'; command: SlashCommand; text: string };

export function parseTypedCommand(text: string, commands: SlashCommand[]): TypedCommand {
  const match = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(text.trimStart());
  if (!match) return { kind: 'chat' };
  const matches = commands.filter((command) => command.name === match[1].toLowerCase());
  if (matches.length === 0) return { kind: 'unavailable' };
  const input = match[2] ?? '';
  if (matches.length > 1) return { kind: 'ambiguous', commands: matches, text: input };
  return { kind: 'command', command: matches[0], text: input };
}

export function seedCommandInputs(command: SlashCommand, text = ''): BotFormValues {
  const fields = commandInputFields(command);
  const values = initialBotInputValues(fields);
  const first = fields[0];
  if (first && text.length > 0) {
    // Free text belongs to the first named field, including every space/comma.
    values[first.name] = first.type === 'boolean' && /^(true|false)$/i.test(text.trim())
      ? text.trim().toLowerCase() === 'true'
      : text;
  }
  return values;
}

const INPUT_ERROR_KEYS: Record<BotInputError, TranslationKey> = {
  required: 'botChat.validationRequired',
  type: 'botChat.validationType',
  choice: 'botChat.validationChoice',
  min: 'botChat.validationMin',
  max: 'botChat.validationMax',
  duplicate: 'botChat.validationDuplicate',
  unknown: 'botChat.validationUnknown',
};

export function botInputError(fields: BotInputField[], fieldName: string, reason: BotInputError): string {
  const field = fields.find((entry) => entry.name === fieldName);
  return t('botChat.validationField', {
    field: field?.label ?? t('botChat.parameters'),
    message: t(INPUT_ERROR_KEYS[reason]),
  });
}

export function botRequestError(error: unknown): string {
  if (error instanceof Error && error.message && !error.message.includes('Timeout')) return error.message;
  return t('botChat.requestFailed');
}

export function botCommandMessage(payload: BotCommandMessagePayload): ChatMessage {
  return {
    id: payload.messageId,
    channelId: payload.channelId,
    userId: payload.botId,
    userNickname: payload.botName,
    userAvatarUrl: payload.botAvatarUrl,
    content: payload.content,
    createdAt: payload.createdAt,
    isBot: true,
    isEphemeral: payload.ephemeral,
    botCommand: {
      invocationId: payload.invocationId,
      commandName: payload.commandName,
      invokerId: payload.invokerId,
      invokerNickname: payload.invokerNickname,
      invokerAvatarUrl: payload.invokerAvatarUrl,
    },
  };
}

export function formatCommandContext(context: BotCommandContext): string {
  return t('botChat.usedCommand', { nickname: context.invokerNickname, command: context.commandName });
}
