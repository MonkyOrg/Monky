import { isDeepStrictEqual } from 'util';
import {
  MessageType, botPermissionsSnapshotSchema, botSettingsContextSchema, botSettingsDefinitionSchema,
  botSettingsSnapshotSchema, commandRegisteredSchema, resolveBotSettingsValues, validateBotFormValues,
  type BotForm, type BotFormValues, type BotPermissions, type BotServerSettingsSnapshot, type BotSettingsContext,
  type BotSettingsDefinition,
} from '@monky/shared';
import type { IncomingMessage, ServerConnection } from './connection';
import { freezeData, immutableCopy } from './immutable';

function checkedSettingsValues(
  form: BotForm | undefined, values: BotFormValues, scope: 'server' | 'user'
): BotFormValues {
  // Server contexts are already resolved: never fill defaults or discard explicit
  // empty optional values in the exposed data. Normalized values only aid comparisons.
  const result = form ? validateBotFormValues(form, values) : resolveBotSettingsValues(undefined, values);
  if (!result.success) {
    throw new Error(`Invalid bot ${scope} settings: ${result.field} (${result.reason}).`);
  }
  return result.values;
}

export interface SettingsSyncEvents {
  permissionsChanged(permissions: BotPermissions, context: { readonly serverId: string }): void;
  settingsChanged(snapshot: BotServerSettingsSnapshot, context: { readonly serverId: string }): void;
  error(error: unknown, conn: ServerConnection): void;
}

/**
 * The bot's settings declaration, plus each server's permissions and shared
 * values kept in step with the snapshots that server sends. Interactions run
 * with a settings context checked against those values.
 */
export class SettingsSync {
  private declared: BotSettingsDefinition | undefined;

  constructor(private readonly events: SettingsSyncEvents) {}

  get definition(): BotSettingsDefinition | undefined {
    return this.declared;
  }

  declare(definition: BotSettingsDefinition): void {
    this.declared = immutableCopy(botSettingsDefinitionSchema.parse(definition));
  }

  handle(conn: ServerConnection, msg: IncomingMessage): boolean {
    switch (msg.type) {
      case MessageType.COMMAND_REGISTERED: {
        const parsed = commandRegisteredSchema.safeParse(msg.payload);
        if (!parsed.success) {
          this.events.error(new Error('The server sent an invalid bot settings registration acknowledgement.'), conn);
          return true;
        }
        try {
          this.updateServerSettings(conn, parsed.data.settings);
          if (parsed.data.permissions) this.updatePermissions(conn, parsed.data.permissions);
        } catch (error) {
          this.events.error(error, conn);
        }
        return true;
      }
      case MessageType.BOT_PERMISSIONS_SNAPSHOT: {
        const parsed = botPermissionsSnapshotSchema.safeParse(msg.payload);
        if (!parsed.success || parsed.data.botId !== conn.botId) {
          this.events.error(new Error('Invalid bot permission snapshot.'), conn);
          return true;
        }
        this.updatePermissions(conn, parsed.data.permissions);
        return true;
      }
      case MessageType.BOT_SETTINGS_SNAPSHOT: {
        const parsed = botSettingsSnapshotSchema.safeParse(msg.payload);
        if (!parsed.success) {
          this.events.error(new Error('The server sent an invalid bot settings snapshot.'), conn);
          return true;
        }
        const snapshot = parsed.data;
        if (conn.botId !== null && snapshot.bot.botId !== conn.botId) {
          this.events.error(new Error('The settings snapshot belongs to another bot.'), conn);
          return true;
        }
        if (JSON.stringify(snapshot.definition) !== JSON.stringify(this.declared ?? {}) ||
            snapshot.bot.hasServerSettings !== !!this.declared?.server) {
          this.events.error(new Error('The settings snapshot does not match the bot settings declaration.'), conn);
          return true;
        }
        try {
          this.updateServerSettings(conn, snapshot.server ?? {
            schemaRevision: snapshot.bot.schemaRevision, revision: snapshot.bot.revision, values: {},
          });
          if (snapshot.bot.permissions) this.updatePermissions(conn, snapshot.bot.permissions);
        } catch (error) {
          this.events.error(error, conn);
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** The frozen settings one interaction runs with; throws when the server's context does not add up. */
  capture(conn: ServerConnection, input: BotSettingsContext | undefined): BotSettingsContext {
    if (!conn.connected || conn.disposed) throw new Error('Bot settings arrived before authentication.');
    const current = conn.serverSettings;
    const configured = !!(this.declared?.server || this.declared?.user);
    if (input === undefined) {
      if (configured) throw new Error('The server omitted the bot settings context.');
      return immutableCopy({
        schemaRevision: current?.schemaRevision ?? 0, serverRevision: current?.revision ?? 0, server: {}, user: {},
      });
    }
    const parsed = botSettingsContextSchema.safeParse(input);
    if (!parsed.success) throw new Error('The server sent an invalid bot settings context.');
    const context = parsed.data;
    const values = checkedSettingsValues(this.declared?.server, context.server, 'server');
    checkedSettingsValues(this.declared?.user, context.user, 'user');
    if (configured && !current) throw new Error('The bot settings context arrived before settings were hydrated.');
    if (current) {
      if (context.schemaRevision !== current.schemaRevision || context.serverRevision !== current.revision) {
        throw new Error('The bot settings context has stale or inconsistent revisions.');
      }
      if (!isDeepStrictEqual(values, checkedSettingsValues(this.declared?.server, current.values, 'server'))) {
        throw new Error('The bot settings context does not match the shared server values.');
      }
    }
    return immutableCopy(context);
  }

  private updatePermissions(conn: ServerConnection, permissions: BotPermissions): void {
    if (!conn.connected || conn.disposed) {
      this.events.error(new Error('Bot permissions arrived before authentication.'), conn);
      return;
    }
    const current = conn.permissions;
    if (current && (permissions.revision < current.revision ||
        (permissions.revision === current.revision && !isDeepStrictEqual(current, permissions)))) {
      this.events.error(new Error('The server sent a stale or conflicting bot permission snapshot.'), conn);
      return;
    }
    if (current && isDeepStrictEqual(current, permissions)) return;
    conn.permissions = freezeData(structuredClone(permissions));
    this.events.permissionsChanged(immutableCopy(permissions), immutableCopy({ serverId: conn.serverId }));
  }

  private updateServerSettings(conn: ServerConnection, snapshot: BotServerSettingsSnapshot): void {
    if (!conn.connected || conn.disposed) throw new Error('Bot settings arrived before authentication.');
    const values = checkedSettingsValues(this.declared?.server, snapshot.values, 'server');
    const current = conn.serverSettings;
    if (current) {
      if (snapshot.schemaRevision < current.schemaRevision || snapshot.revision < current.revision) {
        throw new Error('The server sent a stale bot settings snapshot.');
      }
      if (snapshot.schemaRevision === current.schemaRevision && snapshot.revision === current.revision) {
        if (!isDeepStrictEqual(values, checkedSettingsValues(this.declared?.server, current.values, 'server'))) {
          throw new Error('The server sent conflicting values for the same bot settings revision.');
        }
        return;
      }
    }
    conn.serverSettings = immutableCopy(snapshot);
    this.events.settingsChanged(immutableCopy(snapshot), Object.freeze({ serverId: conn.serverId }));
  }
}
