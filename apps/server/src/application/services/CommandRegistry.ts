import { LIMITS, SlashCommand, CommandOption } from '@monky/shared';
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
    raw: Array<{ name: string; description: string; options?: CommandOption[] }>
  ): number {
    // First, clear existing commands from this bot.
    this.clearBot(botId);

    const toRegister = raw.slice(0, LIMITS.MAX_COMMANDS_PER_BOT);
    for (const cmd of toRegister) {
      const name = cmd.name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!name || name.length > 32) continue;

      const options = (cmd.options || []).slice(0, LIMITS.MAX_OPTIONS_PER_COMMAND);
      const command: SlashCommand = {
        name,
        description: cmd.description.substring(0, 100),
        botId,
        botName,
        options,
      };
      this.commands.set(`${botId}:${name}`, command);
    }

    Logger.info('BOT', `Bot "${botName}" registered ${toRegister.length} command(s).`);
    return toRegister.length;
  }

  /** Removes all commands registered by a bot (e.g. on disconnect). */
  clearBot(botId: string): void {
    for (const [key] of this.commands) {
      if (key.startsWith(`${botId}:`)) {
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
    return this.commands.get(`${botId}:${commandName.toLowerCase()}`);
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
