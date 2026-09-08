import type { SlashCommand } from '@monky/shared';

export const COMMAND_USAGE_STORAGE_KEY = 'monky_bot_command_usage_v1';
export const MAX_COMMAND_USAGE_SCOPES = 20;
export const MAX_COMMAND_USAGE_ENTRIES = 100;
const MAX_USAGE_COUNT = 1_000_000;

export interface CommandUsage {
  botId: string;
  commandName: string;
  count: number;
  lastUsedAt: number;
}

export interface CommandUsageStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CommandUsageScope {
  serverId: string;
  callerId: string;
}

interface ScopedUsage extends CommandUsageScope {
  commands: CommandUsage[];
}

export interface CommandGroup {
  id: string;
  kind: 'frequent' | 'bot';
  botName?: string;
  botAvatarUrl?: string | null;
  commands: SlashCommand[];
}

export function commandKey(command: Pick<SlashCommand, 'botId' | 'name'>): string {
  return JSON.stringify([command.botId, command.name]);
}

function usageKey(usage: CommandUsage): string {
  return commandKey({ botId: usage.botId, name: usage.commandName });
}

function scopeKey(scope: CommandUsageScope): string {
  return JSON.stringify([scope.serverId, scope.callerId]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storageOrDefault(storage?: CommandUsageStorage): CommandUsageStorage | undefined {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function recentFirst(a: CommandUsage, b: CommandUsage): number {
  return b.lastUsedAt - a.lastUsedAt || b.count - a.count || usageKey(a).localeCompare(usageKey(b));
}

function readAllUsage(storage?: CommandUsageStorage): ScopedUsage[] {
  try {
    const text = storageOrDefault(storage)?.getItem(COMMAND_USAGE_STORAGE_KEY);
    if (!text || text.length > 1_000_000) return [];
    const input: unknown = JSON.parse(text);
    if (!Array.isArray(input)) return [];
    const scopes = new Map<string, ScopedUsage>();
    for (const entry of input.slice(0, MAX_COMMAND_USAGE_SCOPES)) {
      if (!isRecord(entry) || typeof entry.serverId !== 'string' || !entry.serverId ||
          entry.serverId.length > 128 || typeof entry.callerId !== 'string' || !entry.callerId ||
          entry.callerId.length > 128 || !Array.isArray(entry.commands)) continue;
      const commands = new Map<string, CommandUsage>();
      for (const item of entry.commands.slice(0, MAX_COMMAND_USAGE_ENTRIES)) {
        if (!isRecord(item) || typeof item.botId !== 'string' || !item.botId || item.botId.length > 128 ||
            typeof item.commandName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(item.commandName) ||
            typeof item.count !== 'number' || !Number.isSafeInteger(item.count) || item.count < 1 ||
            typeof item.lastUsedAt !== 'number' || !Number.isSafeInteger(item.lastUsedAt) || item.lastUsedAt < 0) continue;
        const usage: CommandUsage = {
          botId: item.botId, commandName: item.commandName,
          count: Math.min(item.count, MAX_USAGE_COUNT), lastUsedAt: item.lastUsedAt,
        };
        commands.set(usageKey(usage), usage);
      }
      const scope = { serverId: entry.serverId, callerId: entry.callerId };
      if (commands.size) scopes.set(scopeKey(scope), { ...scope, commands: [...commands.values()] });
    }
    return [...scopes.values()];
  } catch {
    return [];
  }
}

export function readCommandUsage(scope: CommandUsageScope, storage?: CommandUsageStorage): CommandUsage[] {
  return readAllUsage(storage).find((entry) =>
    entry.serverId === scope.serverId && entry.callerId === scope.callerId)?.commands ?? [];
}

export function writeCommandUsage(scope: CommandUsageScope, usage: CommandUsage[], storage?: CommandUsageStorage): void {
  const { serverId, callerId } = scope;
  if (!serverId || serverId.length > 128 || !callerId || callerId.length > 128) return;
  // Whitelist metadata here: drafts and invocation arguments never reach storage.
  const commands = usage.slice().sort(recentFirst).slice(0, MAX_COMMAND_USAGE_ENTRIES)
    .map(({ botId, commandName, count, lastUsedAt }) => ({ botId, commandName, count, lastUsedAt }));
  const scopes = readAllUsage(storage).filter((entry) => scopeKey(entry) !== scopeKey(scope));
  if (commands.length) scopes.push({ serverId, callerId, commands });
  const latest = (entry: ScopedUsage) => Math.max(0, ...entry.commands.map((command) => command.lastUsedAt));
  scopes.sort((a, b) => latest(b) - latest(a) || scopeKey(a).localeCompare(scopeKey(b)));
  try {
    storageOrDefault(storage)?.setItem(
      COMMAND_USAGE_STORAGE_KEY,
      JSON.stringify(scopes.slice(0, MAX_COMMAND_USAGE_SCOPES))
    );
  } catch {
    // Quota/private-browsing failures must not prevent invoking commands.
  }
}

export function incrementCommandUsage(usage: CommandUsage[], command: SlashCommand, now: number): CommandUsage[] {
  const key = commandKey(command);
  const previous = usage.find((entry) => usageKey(entry) === key);
  return [
    ...usage.filter((entry) => usageKey(entry) !== key),
    {
      botId: command.botId,
      commandName: command.name,
      count: Math.min((previous?.count ?? 0) + 1, MAX_USAGE_COUNT),
      lastUsedAt: now,
    },
  ].sort(recentFirst).slice(0, MAX_COMMAND_USAGE_ENTRIES);
}

export function groupCommands(
  commands: SlashCommand[],
  usage: CommandUsage[],
  locale = 'pt-BR',
  includeEmptyFrequent = true
): CommandGroup[] {
  if (commands.length === 0) return [];
  const catalog = new Map(commands.map((command) => [commandKey(command), command]));
  // Registry snapshots contain online bots only; filter display, not retained usage.
  const frequent = usage
    .filter((entry) => catalog.has(usageKey(entry)))
    .sort((a, b) => b.count - a.count || recentFirst(a, b))
    .slice(0, 5)
    .flatMap((entry) => {
      const command = catalog.get(usageKey(entry));
      return command ? [command] : [];
    });
  const byBot = new Map<string, CommandGroup>();
  for (const command of catalog.values()) {
    let group = byBot.get(command.botId);
    if (!group) {
      group = { id: `bot:${command.botId}`, kind: 'bot', botName: command.botName, botAvatarUrl: command.botAvatarUrl, commands: [] };
      byBot.set(command.botId, group);
    }
    group.commands.push(command);
  }
  const groups = [...byBot.values()].sort((a, b) =>
    (a.botName ?? '').localeCompare(b.botName ?? '', locale, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
  for (const group of groups) group.commands.sort((a, b) => a.name.localeCompare(b.name, locale));
  if (frequent.length || includeEmptyFrequent) groups.unshift({ id: 'frequent', kind: 'frequent', commands: frequent });
  return groups;
}
