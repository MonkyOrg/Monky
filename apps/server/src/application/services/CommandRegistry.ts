import { SlashCommand, commandRegisterSchema } from '@monky/shared';
import { Logger } from '../../infrastructure/logger/Logger';

/**
 * In-memory registry of slash commands from connected bots (#569).
 *
 * Commands live only while the bot is online: disconnecting a bot clears its
 * registrations. This keeps the registry always consistent with what can
 * actually be invoked. Persistent discovery (showing commands of offline bots)
 * is deferred to Phase 2.
 */
export class CommandRegistry {
  /** All registered commands keyed by `botId:commandName`. */
  private commands = new Map<string, SlashCommand>();

  /**
   * Registers (or replaces) a bot's command set.
   * Returns the count of commands actually registered.
   */
  register(
    botId: string,
    botName: string,
    raw: unknown,
    botAvatarUrl?: string | null
  ): number {
    // Validate the whole replacement before touching the existing set. Silently
    // sanitizing names can collapse different commands into the same key.
    const { commands } = commandRegisterSchema.parse({ commands: raw });
    this.clearBot(botId);

    for (const cmd of commands) {
      const command: SlashCommand = {
        ...cmd,
        botId,
        botName,
        botAvatarUrl,
      };
      this.commands.set(`${botId}:${cmd.name}`, command);
    }

    Logger.info('BOT', `Bot "${botName}" registered ${commands.length} command(s).`);
    return commands.length;
  }

  updateBotIdentity(botId: string, botName: string, botAvatarUrl?: string | null): void {
    for (const command of this.commands.values()) {
      if (command.botId !== botId) continue;
      command.botName = botName;
      command.botAvatarUrl = botAvatarUrl;
    }
  }

  /** Removes all commands registered by a bot (e.g. on disconnect). */
  clearBot(botId: string): void {
    for (const [key, command] of this.commands) {
      if (command.botId === botId) {
        this.commands.delete(key);
      }
    }
  }

  /** All currently registered commands, for the client dropup. */
  listAll(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  /** Find a specific command by name and bot id. */
  find(botId: string, commandName: string): SlashCommand | undefined {
    return this.commands.get(`${botId}:${commandName}`);
  }

  /**
   * Find all commands matching a name (across bots).
   * Used when the user picks from the dropup — multiple bots may register `/play`.
   */
  findByName(commandName: string): SlashCommand[] {
    const name = commandName.toLowerCase();
    const result: SlashCommand[] = [];
    for (const cmd of this.commands.values()) {
      if (cmd.name === name) result.push(cmd);
    }
    return result;
  }
}
