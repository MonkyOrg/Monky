import {
  ProtocolErrorCode, botSettingsDefinitionSchema, botSettingsListResponseSchema,
  botSettingsSnapshotSchema, botSettingsUpdateSchema, resolveBotSettingsValues,
  type BotFormValues, type BotInfo, type BotSettingsContext, type BotSettingsDefinition,
  type BotSettingsListResponse, type BotSettingsSnapshot, type BotSettingsSummary,
  type BotSettingsUpdatePayload, type BotServerSettingsSnapshot,
} from '@monky/shared';
import type { BotSettingsRecord } from '../../domain/entities';
import type { IBotSettingsRepository } from '../../domain/repositories';

export class BotSettingsError extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string) { super(message); }
}

export class BotSettingsService {
  constructor(private repository: IBotSettingsRepository) {}

  register(botId: string, input: BotSettingsDefinition | undefined, downloadsSound: boolean): BotServerSettingsSnapshot {
    const parsed = botSettingsDefinitionSchema.safeParse(input ?? {});
    if (!parsed.success) throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID, parsed.error.message);
    const definition = parsed.data;
    return this.repository.transaction(() => {
      const previous = this.require(botId);
      const incompatible: string[] = [];
      for (const [name, value] of Object.entries(previous.serverOverrides)) {
        const before = previous.definition.server?.fields.find((field) => field.name === name);
        const after = definition.server?.fields.find((field) => field.name === name);
        if (!before || !after || before.type !== after.type ||
            !resolveBotSettingsValues({ title: 'Settings', fields: [after] }, { [name]: value }).success) {
          incompatible.push(name);
        }
      }
      if (incompatible.length) {
        throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID,
          `Incompatible shared overrides: ${incompatible.join(', ')}. Reset these fields using the previous settings form before retrying registration.`);
      }
      const next: BotSettingsRecord = {
        ...previous, definition, downloadsSound,
        schemaRevision: JSON.stringify(previous.definition) === JSON.stringify(definition)
          ? previous.schemaRevision : this.increment(previous.schemaRevision),
      };
      if (!this.sameValues(this.serverSnapshot(previous).values, this.serverSnapshot(next).values)) {
        next.revision = this.increment(previous.revision);
      }
      this.repository.save(next);
      return this.serverSnapshot(next);
    });
  }

  update(input: BotSettingsUpdatePayload): BotServerSettingsSnapshot {
    const parsed = botSettingsUpdateSchema.safeParse(input);
    if (!parsed.success) throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID, 'Invalid shared settings patch.');
    return this.repository.transaction(() => {
      const previous = this.require(parsed.data.botId);
      if (previous.schemaRevision !== parsed.data.schemaRevision || previous.revision !== parsed.data.expectedRevision) {
        throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_CONFLICT, 'Settings changed. Reload before saving again.');
      }
      const form = previous.definition.server;
      if (!form) throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID, 'This bot declares no shared settings.');
      const overrides = { ...previous.serverOverrides };
      for (const [name, value] of Object.entries(parsed.data.patch)) {
        if (!form.fields.some((field) => field.name === name)) {
          throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID, `Invalid settings field: ${name} (unknown).`);
        }
        if (value === null) delete overrides[name];
        else overrides[name] = value;
      }
      const validated = resolveBotSettingsValues(form, overrides);
      if (!validated.success) {
        throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID,
          `Invalid settings field: ${validated.field} (${validated.reason}).`);
      }
      for (const name of Object.keys(overrides)) {
        if (Object.hasOwn(validated.values, name)) overrides[name] = validated.values[name];
      }
      if (this.sameValues(previous.serverOverrides, overrides)) return this.serverSnapshot(previous);
      const next = { ...previous, serverOverrides: overrides, revision: this.increment(previous.revision) };
      this.repository.save(next);
      return this.serverSnapshot(next);
    });
  }

  list(bots: BotInfo[], canConfigure: boolean): BotSettingsListResponse {
    const summaries: BotSettingsSummary[] = [];
    for (const bot of bots) {
      if (bot.profilePending) continue;
      const record = this.repository.findById(bot.id);
      // A bot may be revoked while the asynchronous identity list is being read.
      if (record) summaries.push(this.summary(bot, record, canConfigure));
    }
    return botSettingsListResponseSchema.parse({ bots: summaries });
  }

  snapshot(bot: BotInfo, canConfigure: boolean, owningBot = false): BotSettingsSnapshot {
    if (bot.profilePending) {
      throw new BotSettingsError(ProtocolErrorCode.BAD_REQUEST, 'This bot link is awaiting the bot identity.');
    }
    const record = this.require(bot.id);
    const readServer = canConfigure || owningBot;
    return botSettingsSnapshotSchema.parse({
      bot: this.summary(bot, record, canConfigure),
      definition: {
        ...(record.definition.user ? { user: record.definition.user } : {}),
        ...(readServer && record.definition.server ? { server: record.definition.server } : {}),
      },
      ...(readServer && record.definition.server ? { server: this.serverSnapshot(record) } : {}),
    });
  }

  context(botId: string, userSettings: unknown): BotSettingsContext | undefined {
    const record = this.require(botId);
    const user = resolveBotSettingsValues(record.definition.user, userSettings);
    if (!user.success) {
      throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID,
        `Invalid individual preference: ${user.field} (${user.reason}). Review or reset saved preferences.`);
    }
    if (!record.definition.server && !record.definition.user) return undefined;
    return {
      schemaRevision: record.schemaRevision, serverRevision: record.revision,
      server: this.serverSnapshot(record).values, user: user.values,
    };
  }

  private summary(bot: BotInfo, record: BotSettingsRecord, canConfigure: boolean): BotSettingsSummary {
    return {
      botId: bot.id, name: bot.name, avatarUrl: bot.avatarUrl, online: bot.online,
      capabilities: { downloadsSound: record.downloadsSound },
      schemaRevision: record.schemaRevision, revision: record.revision,
      hasServerSettings: !!record.definition.server, hasUserSettings: !!record.definition.user, canConfigure,
    };
  }

  private serverSnapshot(record: BotSettingsRecord): BotServerSettingsSnapshot {
    const resolved = resolveBotSettingsValues(record.definition.server, record.serverOverrides);
    if (!resolved.success) {
      throw new BotSettingsError(ProtocolErrorCode.BOT_SETTINGS_INVALID,
        `Invalid stored shared settings: ${resolved.field} (${resolved.reason}).`);
    }
    return { schemaRevision: record.schemaRevision, revision: record.revision, values: resolved.values };
  }

  private require(botId: string): BotSettingsRecord {
    const record = this.repository.findById(botId);
    if (!record) throw new BotSettingsError(ProtocolErrorCode.BAD_REQUEST, 'Bot not found.');
    return record;
  }

  private sameValues(left: BotFormValues, right: BotFormValues): boolean {
    const ordered = (values: BotFormValues) => Object.keys(values).sort().map((key) => [key, values[key]]);
    return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
  }

  private increment(revision: number): number {
    if (!Number.isSafeInteger(revision + 1)) throw new Error('Bot settings revision limit reached.');
    return revision + 1;
  }
}
