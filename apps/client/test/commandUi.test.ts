import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCommandPresentation, localizeCommand, type BotCommandMessagePayload, type BotPermissions, type BotSettingsSummary, type SlashCommand, type UserSummary } from '@monky/shared';
import { createChatStore } from '../src/renderer/stores/chatStore';
import { createServerStore, setActiveServerStore } from '../src/renderer/stores/serverStore';
import { EventBus } from '../src/renderer/core/EventBus';
import {
  COMMAND_USAGE_STORAGE_KEY, MAX_COMMAND_USAGE_ENTRIES, MAX_COMMAND_USAGE_SCOPES,
  filterCommands, findCommandsByInputName, groupCommands, incrementCommandUsage, readCommandUsage, writeCommandUsage,
  type CommandUsage, type CommandUsageStorage,
} from '../src/renderer/utils/commandCatalog';
import {
  botCommandMessage, commandInputFields, commandValuesFromInputs, formatCommandContext,
  parseTypedCommand, visibleCommandFields, visibleCommandValues,
} from '../src/renderer/utils/botInputs';
import { renderCommandCatalog, renderCommandParameters, renderEmptyCommandCatalog } from '../src/renderer/views/commandCatalog';
import { commandParameterChoices, commandParameterError, renderCompactCommand, renderParameterChoices } from '../src/renderer/views/commandComposer';
import { renderBotCommandContext } from '../src/renderer/views/botResponse';
import { renderBotFields } from '../src/renderer/views/botFields';
import { renderBotInvocation } from '../src/renderer/views/BotChatView';
import { getLanguage, setLanguage, t } from '../src/renderer/i18n';
import { commandPreviewVolumeScope, type SelectionChoice } from '../src/renderer/utils/selectionChoices';
import { translateProtocolError } from '../src/renderer/i18n/protocolErrors';

class MemoryUsageStorage implements CommandUsageStorage {
  public values = new Map<string, string>();
  public getItem(key: string): string | null { return this.values.get(key) ?? null; }
  public setItem(key: string, value: string): void { this.values.set(key, value); }
}

const command: SlashCommand = {
  name: 'play',
  description: 'Choose what to play',
  botId: 'music-bot',
  botName: 'Music Bot',
  options: [
    { name: 'song', description: 'Song title', type: 'string', required: true, placeholder: 'Enter the full title' },
    { name: 'count', description: 'Repeat count', type: 'integer', required: true, min: 0, max: 10 },
    { name: 'private', description: 'Private playback', type: 'boolean' },
    { name: 'member', description: 'Member', type: 'user' },
    { name: 'mode', description: 'Playback mode', type: 'string', choices: [{ label: 'In order', value: 'ordered' }, { label: 'Shuffle', value: 'shuffle' }] },
  ],
};
const otherBot: SlashCommand = { ...command, botId: 'second-music-bot', botName: 'Music Bot' };
const member: UserSummary = {
  id: 'member-one', clientId: 'member-client', nickname: 'Alice', status: 'ONLINE', joinedAt: 1,
  avatarUrl: 'http://127.0.0.1:9900/avatars/alice.png',
};

test('per-bot command metadata is localized for display without translating submitted identifiers', (context) => {
  const previousLanguage = getLanguage();
  context.after(() => setLanguage(previousLanguage));
  setLanguage('en');
  const localized: SlashCommand = {
    ...command,
    localizations: { 'pt-BR': {
      name: 'tocar', aliases: ['musica'],
      description: 'Escolha a música',
      options: {
        song: { label: 'Música', description: 'Título da música', placeholder: 'Digite o título' },
        mode: { label: 'Modo', choices: { shuffle: { label: 'Aleatório' } } },
      },
    } },
  };
  const original = structuredClone(localized);
  const catalog = renderCommandCatalog(groupCommands([localized, { ...localized, botId: 'english-bot' }], [], 'pt-BR', false), 0,
    () => undefined, (entry) => entry.botId === localized.botId ? 'pt-BR' : 'en');
  assert.ok(catalog.includes('Escolha a música'));
  assert.ok(catalog.includes('Choose what to play'));
  assert.ok(catalog.includes('/play'));
  assert.ok(catalog.includes('/tocar'));
  assert.ok(catalog.includes('data-command-name="play"'));
  assert.ok(!catalog.includes('data-command-name="tocar"'));
  assert.ok(catalog.includes('Música'));
  const store = createChatStore();
  store.selectCommand('channel', localized);
  const draft = store.getCommandDraft('channel');
  assert.ok(draft);
  const translated = localizeCommand(draft.command, 'pt-BR');
  const markup = renderCompactCommand(draft, 'channel', [member], true, true, undefined, 'pt-BR');
  assert.match(markup, /data-field-name="song"/);
  assert.match(markup, /name="song"/);
  assert.match(markup, /data-command-name="play"/);
  assert.ok(markup.includes('<strong>/tocar</strong>'));
  assert.ok(markup.includes('>Música</label>'));
  assert.ok(markup.includes('placeholder="Digite o título"'));
  const choices = commandInputFields(translated).find((field) => field.name === 'mode');
  assert.ok(choices);
  assert.deepEqual(commandParameterChoices(choices, [member]).map(({ value, label }) => ({ value, label })), [
    { value: 'ordered', label: 'In order' }, { value: 'shuffle', label: 'Aleatório' },
  ]);
  assert.deepEqual(commandValuesFromInputs(translated, { song: 'Private song', count: 1, mode: 'shuffle' }, [member]),
    { success: true, values: { song: 'Private song', count: 1, mode: 'shuffle' } });
  assert.deepEqual(localized, original);
  assert.deepEqual(draft.command, original);
});

test('catalog filtering and sorting use each bot locale while frequency and IDs remain canonical', () => {
  const first: SlashCommand = {
    ...command, name: 'able', localizations: { 'pt-BR': { name: 'zulu', aliases: ['musica'] }, en: { aliases: ['audio'] } },
  };
  const last: SlashCommand = {
    ...command, name: 'zebra', localizations: { 'pt-BR': { name: 'alpha' } },
  };
  const commands = [first, last, { ...first, botId: 'english' }, { ...last, botId: 'english' }];
  const localeFor = (entry: SlashCommand) => entry.botId === 'english' ? 'en' as const : 'pt-BR' as const;
  const groups = groupCommands(commands, [
    { botId: first.botId, commandName: first.name, count: 10, lastUsedAt: 1 },
  ], 'en', true, localeFor);
  assert.deepEqual(groups.find((group) => group.id === `bot:${command.botId}`)?.commands.map((entry) => entry.name), ['zebra', 'able']);
  assert.deepEqual(groups.find((group) => group.id === 'bot:english')?.commands.map((entry) => entry.name), ['able', 'zebra']);
  assert.equal(groups[0].commands[0], first);
  assert.deepEqual(filterCommands(commands, 'MUSICa', localeFor), [first]);
  assert.deepEqual(filterCommands(commands, 'aud', localeFor), [commands[2]]);
  assert.deepEqual(filterCommands(commands, 'zul', localeFor), [first]);
  assert.deepEqual(filterCommands(commands, 'abl', localeFor), [first, commands[2]]);
  assert.deepEqual(filterCommands(commands, 'Music Bot', localeFor), commands);
  assert.deepEqual(filterCommands(commands, 'unavailable', localeFor), []);
});

test('slash input accepts only canonical and selected-locale names while preserving cross-bot ambiguity', () => {
  const localized: SlashCommand = {
    ...command, localizations: {
      'pt-BR': { name: 'tocar', aliases: ['musica'] }, en: { name: 'listen', aliases: ['audio'] },
    },
  };
  const duplicate: SlashCommand = { ...localized, botId: 'duplicate' };
  const localeFor = (entry: SlashCommand) => entry.botId === 'duplicate' ? 'en' as const : 'pt-BR' as const;
  for (const input of ['play', 'TOCAR', 'musica']) {
    assert.deepEqual(parseTypedCommand(`/${input} Keep  spaces,\nand lines`, [localized], localeFor), {
      kind: 'command', command: localized, text: 'Keep  spaces,\nand lines',
    });
  }
  assert.deepEqual(parseTypedCommand('/audio', [localized], localeFor), { kind: 'unavailable' });
  assert.deepEqual(parseTypedCommand('/listen', [localized], localeFor), { kind: 'unavailable' });
  assert.deepEqual(parseTypedCommand('/audio Selected', [localized, duplicate], localeFor), {
    kind: 'command', command: duplicate, text: 'Selected',
  });
  assert.deepEqual(parseTypedCommand('/play Input', [localized, duplicate], localeFor), {
    kind: 'ambiguous', commands: [localized, duplicate], text: 'Input',
  });
  assert.deepEqual(parseTypedCommand('/musica Input', [localized, duplicate], () => 'pt-BR'), {
    kind: 'ambiguous', commands: [localized, duplicate], text: 'Input',
  });
  const otherCanonical = { ...duplicate, name: 'tocar', localizations: undefined };
  assert.deepEqual(findCommandsByInputName([localized, otherCanonical], 'tocar', () => 'pt-BR'), [localized, otherCanonical]);
});

test('stale same-bot aliases cannot shadow a canonical name regardless of registry ordering', () => {
  const canonical = { ...command, name: 'stop' };
  const shadow: SlashCommand = { ...command, localizations: { 'pt-BR': { name: 'stop', aliases: ['halt'] } } };
  for (const commands of [[shadow, canonical], [canonical, shadow]]) {
    assert.deepEqual(parseTypedCommand('/stop', commands, () => 'pt-BR'), { kind: 'command', command: canonical, text: '' });
  }
  const aliasCollision: SlashCommand = { ...canonical, localizations: { 'pt-BR': { aliases: ['halt'] } } };
  assert.deepEqual(parseTypedCommand('/halt', [shadow, aliasCollision], () => 'pt-BR'), {
    kind: 'ambiguous', commands: [shadow, aliasCollision], text: '',
  });
});

test('rendering another locale preserves selected canonical command, optional fields and entered values', () => {
  const localized: SlashCommand = {
    ...command, localizations: {
      'pt-BR': { name: 'tocar', options: { song: { label: 'Música' }, mode: { label: 'Modo', choices: { shuffle: { label: 'Aleatório' } } } } },
      en: { name: 'listen', options: { song: { label: 'Song' }, mode: { label: 'Mode' } } },
    },
  };
  const store = createChatStore();
  store.selectCommand('channel', localized);
  store.setCommandOptionVisible('channel', 'mode', true);
  store.setCommandValues('channel', { song: 'Never translate this value', count: '2', mode: 'shuffle' });
  const draft = store.getCommandDraft('channel');
  assert.ok(draft);
  const original = structuredClone(draft);
  for (const locale of ['pt-BR', 'en'] as const) {
    const markup = renderCompactCommand(draft, 'channel', [member], true, true, undefined, locale);
    assert.ok(markup.includes(`<strong>/${locale === 'en' ? 'listen' : 'tocar'}</strong>`));
    assert.ok(markup.includes('Never translate this value'));
    assert.match(markup, /data-command-name="play"/);
    assert.match(markup, /data-field-name="mode"/);
    assert.ok(markup.includes(locale === 'en' ? 'Shuffle' : 'Aleatório'));
    assert.deepEqual(commandValuesFromInputs(draft.command, draft.values, [member]), {
      success: true, values: { song: 'Never translate this value', count: 2, mode: 'shuffle' },
    });
  }
  assert.deepEqual(draft, original);
});

test('legacy command options keep compact identifier labels when no display label is declared', () => {
  const store = createChatStore();
  const legacy: SlashCommand = {
    ...command,
    options: [{ name: 'song', description: 'Search for a song using its title or URL.', type: 'string', required: true }],
    localizations: { 'pt-BR': { options: { song: { description: 'Pesquise uma música pelo título ou URL.' } } } },
  };
  store.selectCommand('channel', legacy);
  const draft = store.getCommandDraft('channel');
  assert.ok(draft);
  const markup = renderCompactCommand(draft, 'channel', [member], true, true, undefined, 'pt-BR');
  assert.ok(markup.includes('>song</label>'));
  assert.match(markup, /aria-label="song: Pesquise uma música/);
  assert.ok(markup.includes('Pesquise uma música pelo título ou URL.'));
  assert.ok(!markup.includes('>Pesquise uma música pelo título ou URL.</label>'));
});

test('voice denial explains catalog and composer gating without disabling editing or unrelated commands', () => {
  const store = createChatStore();
  const music = { ...command, voiceRequirement: 'same-bot-channel' as const };
  store.setCommands([music]);
  store.selectCommand('channel', music);
  const draft = store.getCommandDraft('channel')!;
  for (const locale of ['pt-BR', 'en'] as const) {
    setLanguage(locale);
    const required = translateProtocolError('BOT_VOICE_REQUIRED');
    const mismatch = translateProtocolError('BOT_VOICE_CHANNEL_MISMATCH');
    assert.match(required, locale === 'en' ? /voice channel.*device/i : /canal de voz.*dispositivo/i);
    assert.match(mismatch, locale === 'en' ? /already in another voice channel/i : /já está em outro canal de voz/i);
    const markup = renderCompactCommand(draft, 'channel', [member], true, true, mismatch);
    assert.ok(markup.includes(mismatch));
    assert.match(markup, /class="btn btn-primary bot-command-run" disabled/);
    assert.doesNotMatch(markup, /data-bot-input[^>]*disabled/);
    assert.doesNotMatch(markup, /data-bot-action="cancel-command"[^>]*disabled/);
    const catalog = renderCommandCatalog(groupCommands([music, { ...command, name: 'utility' }], [], locale), 0,
      (entry) => entry.voiceRequirement ? required : undefined);
    assert.equal(catalog.match(/aria-disabled="true"/g)?.length, 1);
  }
  setLanguage('pt-BR');
});

test('changing voice context clears selected opaque choices while preserving editable queries and utility drafts', () => {
  const store = createChatStore();
  const music: SlashCommand = {
    ...command, voiceRequirement: 'same-bot-channel',
    options: [{ name: 'track', description: 'Track', type: 'string', required: true, autocomplete: true }],
  };
  store.selectCommand('voice-command', music, 'query');
  store.setCommandVoiceContext('voice-command', 'first-room');
  store.selectCommandChoice('voice-command', 'track', { label: 'Generated fixture', value: 'opaque-id' });
  assert.equal(store.setCommandVoiceContext('voice-command', 'first-room'), false);
  assert.equal(store.getCommandDraft('voice-command')?.values.track, 'opaque-id');
  assert.equal(store.setCommandVoiceContext('voice-command', 'other-room'), true);
  assert.deepEqual(store.getCommandDraft('voice-command')?.autocomplete.track, { query: 'Generated fixture' });
  assert.equal(store.getCommandDraft('voice-command')?.values.track, undefined);
  store.selectCommand('utility', { ...music, voiceRequirement: undefined });
  store.selectCommandChoice('utility', 'track', { label: 'Fixture', value: 'other-id' });
  assert.equal(store.setCommandVoiceContext('utility', 'outside-voice'), false);
  assert.equal(store.getCommandDraft('utility')?.values.track, 'other-id');
});

function usageStore(storage: CommandUsageStorage, serverId: string, commands = [command, otherBot], callerId = member.id) {
  const store = createChatStore(storage);
  store.bus = new EventBus();
  store.setCommandUsageScope({ serverId, callerId });
  store.setCommands(commands);
  return store;
}

function ack(store: ReturnType<typeof createChatStore>, id: string, selected = command, now = Date.now()): void {
  store.acknowledgeCommand({ invocationId: id, channelId: 'channel', botId: selected.botId, commandName: selected.name }, selected, now);
}

test('frequency records successful ACKs only, deduplicates them and never persists arguments', () => {
  const storage = new MemoryUsageStorage();
  const store = usageStore(storage, 'stable-server');
  store.selectCommand('channel', command, 'SECRET PRIVATE SONG TITLE');
  const draft = store.getCommandDraft('channel');
  assert.ok(draft);
  assert.equal(commandValuesFromInputs(command, draft.values, []).success, false);
  store.setCommandPending('channel', draft, true);
  store.setCommandPending('channel', draft, false, 'Rejected invalid options');
  assert.deepEqual(store.getCommandUsage(), []);
  store.clearCommand('channel');
  assert.deepEqual(store.getCommandUsage(), []);
  assert.equal(storage.getItem(COMMAND_USAGE_STORAGE_KEY), null);
  ack(store, 'successful-one', command, 1000);
  ack(store, 'successful-one', command, 2000);
  assert.deepEqual(store.getCommandUsage(), [{ botId: command.botId, commandName: command.name, count: 1, lastUsedAt: 1000 }]);
  const persisted = storage.getItem(COMMAND_USAGE_STORAGE_KEY);
  assert.ok(persisted);
  assert.equal(persisted.includes('SECRET'), false);
  assert.equal(persisted.includes('values'), false);
  assert.equal(persisted.includes('Music Bot'), false);
  assert.deepEqual(JSON.parse(persisted), [{
    serverId: 'stable-server',
    callerId: member.id,
    commands: [{ botId: command.botId, commandName: command.name, count: 1, lastUsedAt: 1000 }],
  }]);
});

test('a prompt arriving before the ACK does not count as successful command usage', () => {
  const storage = new MemoryUsageStorage();
  const store = usageStore(storage, 'stable-server');
  store.receivePrompt({
    invocationId: 'early-prompt', interactionId: 'step', channelId: 'channel',
    botId: command.botId, botName: command.botName, expiresAt: Date.now() + 60_000,
    form: { title: 'Question', fields: [{ name: 'answer', label: 'Answer', type: 'text' }] },
  });
  assert.deepEqual(store.getCommandUsage(), []);
  ack(store, 'early-prompt');
  assert.equal(store.getCommandUsage()[0]?.count, 1);
  assert.equal(store.getInvocation('early-prompt')?.commandName, command.name);
  assert.equal(store.getInvocation('early-prompt')?.forms.length, 1);
});

test('usage is isolated by stable server, survives reconnects and merges two aliases of that server', () => {
  const storage = new MemoryUsageStorage();
  const first = usageStore(storage, 'server-a');
  const alias = usageStore(storage, 'server-a');
  const other = usageStore(storage, 'server-b');
  ack(first, 'a-one', command, 1000);
  ack(alias, 'alias-two', command, 2000);
  assert.equal(first.getCommandUsage()[0]?.count, 2);
  assert.deepEqual(other.getCommandUsage(), []);
  first.setCommands([]);
  first.clear();
  first.setCommandUsageScope({ serverId: 'server-a', callerId: member.id });
  first.setCommands([command, otherBot]);
  assert.equal(first.getCommandUsage()[0]?.count, 2);
  ack(other, 'b-one', otherBot, 3000);
  assert.equal(other.getCommandUsage()[0]?.botId, otherBot.botId);
  assert.equal(first.getCommandUsage().length, 1);
  const reloaded = usageStore(storage, 'server-a');
  assert.equal(reloaded.getCommandUsage()[0]?.count, 2);
});

test('frequency remains private to the authenticated identity across imports and scope changes', () => {
  const storage = new MemoryUsageStorage();
  const first = usageStore(storage, 'server');
  const imported = usageStore(storage, 'server', [command, otherBot], 'imported-identity');
  ack(first, 'first-caller', command, 1000);
  assert.deepEqual(imported.getCommandUsage(), []);
  ack(imported, 'imported-caller', otherBot, 2000);
  assert.deepEqual(first.getCommandUsage().map((entry) => entry.botId), [command.botId]);
  assert.deepEqual(imported.getCommandUsage().map((entry) => entry.botId), [otherBot.botId]);
  first.setCommandUsageScope({ serverId: 'server', callerId: 'imported-identity' });
  assert.deepEqual(first.getCommandUsage(), imported.getCommandUsage());
  first.setCommandUsageScope({ serverId: 'server', callerId: member.id });
  assert.deepEqual(first.getCommandUsage().map((entry) => entry.botId), [command.botId]);
  first.setCommands([otherBot]);
  assert.deepEqual(first.getCommandUsage().map((entry) => entry.botId), [command.botId]);
  assert.deepEqual(groupCommands(first.getCommands(), first.getCommandUsage())[0].commands, []);
  const reloaded = usageStore(storage, 'server', [command, otherBot], 'imported-identity');
  assert.equal(reloaded.getCommandUsage()[0]?.count, 1);
  assert.equal(reloaded.getCommandUsage()[0]?.botId, otherBot.botId);
});

test('unscoped legacy usage and unauthenticated ACKs are never assigned to a caller', () => {
  const storage = new MemoryUsageStorage();
  storage.setItem(COMMAND_USAGE_STORAGE_KEY, JSON.stringify([{
    serverId: 'server',
    commands: [{ botId: command.botId, commandName: command.name, count: 9, lastUsedAt: 1000 }],
  }]));
  assert.deepEqual(readCommandUsage({ serverId: 'server', callerId: member.id }, storage), []);
  const store = createChatStore(storage);
  store.bus = new EventBus();
  store.setCommands([command]);
  ack(store, 'unscoped', command, 2000);
  assert.deepEqual(store.getCommandUsage(), []);
  store.setCommandUsageScope({ serverId: 'server', callerId: member.id });
  ack(store, 'unscoped', command, 2500);
  assert.deepEqual(store.getCommandUsage(), []);
  ack(store, 'scoped', command, 3000);
  assert.equal(store.getCommandUsage()[0]?.count, 1);
  assert.deepEqual(readCommandUsage({ serverId: 'server', callerId: 'other-identity' }, storage), []);
});

test('unavailable commands are hidden without deleting counts or confusing duplicate bot command names', () => {
  const storage = new MemoryUsageStorage();
  const store = usageStore(storage, 'server');
  ack(store, 'first', command, 1000);
  ack(store, 'second', otherBot, 2000);
  store.setCommands([otherBot]);
  assert.deepEqual(groupCommands(store.getCommands(), store.getCommandUsage())[0].commands.map((entry) => entry.botId), [otherBot.botId]);
  assert.deepEqual(store.getCommandUsage().map((entry) => entry.botId).sort(), [command.botId, otherBot.botId].sort());
  assert.deepEqual(readCommandUsage({ serverId: 'server', callerId: member.id }, storage).map((entry) => entry.botId).sort(),
    [command.botId, otherBot.botId].sort());
  ack(store, 'unknown', { ...command, name: 'removed-command' }, 3000);
  assert.equal(store.getCommandUsage().length, 2);
});

test('frequency survives bot disconnects, other command ACKs and empty startup snapshots before restoration', () => {
  const storage = new MemoryUsageStorage();
  const store = usageStore(storage, 'server');
  store.selectCommand('channel', command, 'SECRET ARGUMENT MUST NOT PERSIST');
  ack(store, 'first', command, 1000);
  ack(store, 'second', command, 2000);
  store.finishBotInvocations(command.botId);
  assert.equal(store.getCommandUsage().find((entry) => entry.botId === command.botId)?.count, 2);
  assert.deepEqual(groupCommands(store.getCommands(), store.getCommandUsage())[0].commands, []);
  ack(store, 'other-bot-while-offline', otherBot, 3000);
  assert.equal(store.getCommandUsage().find((entry) => entry.botId === command.botId)?.count, 2);
  const persisted = storage.getItem(COMMAND_USAGE_STORAGE_KEY);
  assert.ok(persisted && !persisted.includes('SECRET'));
  store.setCommands([]);
  const reloaded = usageStore(storage, 'server', []);
  assert.equal(storage.getItem(COMMAND_USAGE_STORAGE_KEY), persisted);
  assert.deepEqual(groupCommands(reloaded.getCommands(), reloaded.getCommandUsage()), []);
  reloaded.setCommands([command, otherBot]);
  assert.deepEqual(groupCommands(reloaded.getCommands(), reloaded.getCommandUsage())[0].commands.map((entry) => entry.botId),
    [command.botId, otherBot.botId]);
  ack(reloaded, 'restored', command, 4000);
  assert.equal(reloaded.getCommandUsage().find((entry) => entry.botId === command.botId)?.count, 3);
});

test('persisted usage is bounded and corrupted storage cannot interrupt commands', () => {
  const storage = new MemoryUsageStorage();
  storage.setItem(COMMAND_USAGE_STORAGE_KEY, '{invalid json');
  assert.deepEqual(readCommandUsage({ serverId: 'server', callerId: member.id }, storage), []);
  let usage: CommandUsage[] = [];
  for (let index = 0; index < MAX_COMMAND_USAGE_ENTRIES + 30; index++) {
    usage = incrementCommandUsage(usage, { ...command, name: `cmd-${index}` }, index);
  }
  assert.equal(usage.length, MAX_COMMAND_USAGE_ENTRIES);
  assert.equal(usage.some((entry) => entry.commandName === 'cmd-0'), false);
  for (let index = 0; index < MAX_COMMAND_USAGE_SCOPES + 5; index++) {
    writeCommandUsage({ serverId: `server-${index}`, callerId: member.id },
      usage.map((entry) => ({ ...entry, lastUsedAt: entry.lastUsedAt + index * 1000 })), storage);
  }
  const persisted: unknown = JSON.parse(storage.getItem(COMMAND_USAGE_STORAGE_KEY) ?? '[]');
  assert.ok(Array.isArray(persisted));
  assert.equal(persisted.length, MAX_COMMAND_USAGE_SCOPES);
  assert.deepEqual(readCommandUsage({ serverId: 'server-0', callerId: member.id }, storage), []);
  const sharedDesktop = new MemoryUsageStorage();
  for (let index = 0; index < MAX_COMMAND_USAGE_SCOPES + 5; index++) {
    writeCommandUsage({ serverId: 'same-server', callerId: `identity-${index}` },
      usage.map((entry) => ({ ...entry, lastUsedAt: entry.lastUsedAt + index * 1000 })), sharedDesktop);
  }
  const profiles: unknown = JSON.parse(sharedDesktop.getItem(COMMAND_USAGE_STORAGE_KEY) ?? '[]');
  assert.ok(Array.isArray(profiles));
  assert.equal(profiles.length, MAX_COMMAND_USAGE_SCOPES);
  assert.deepEqual(readCommandUsage({ serverId: 'same-server', callerId: 'identity-0' }, sharedDesktop), []);
  const failingStorage: CommandUsageStorage = {
    getItem: () => { throw new Error('Storage unavailable'); },
    setItem: () => { throw new Error('Quota exceeded'); },
  };
  const store = usageStore(failingStorage, 'server');
  assert.doesNotThrow(() => ack(store, 'successful'));
  assert.equal(store.getCommandUsage()[0]?.count, 1);
});

test('frequency sorts by real count then recency, with separate groups for identical bot names', () => {
  const third = { ...command, name: 'ping' };
  const usage: CommandUsage[] = [
    { botId: command.botId, commandName: command.name, count: 3, lastUsedAt: 1000 },
    { botId: otherBot.botId, commandName: otherBot.name, count: 3, lastUsedAt: 2000 },
    { botId: third.botId, commandName: third.name, count: 1, lastUsedAt: 3000 },
  ];
  const groups = groupCommands([command, otherBot, third], usage);
  assert.equal(groups[0].kind, 'frequent');
  assert.deepEqual(groups[0].commands.map((entry) => [entry.botId, entry.name]), [
    [otherBot.botId, otherBot.name], [command.botId, command.name], [third.botId, third.name],
  ]);
  assert.equal(groups.filter((group) => group.kind === 'bot').length, 2);
  assert.notEqual(groups[1].id, groups[2].id);
  assert.equal(groups[1].botName, groups[2].botName);
  assert.equal(groupCommands([command], [])[0].commands.length, 0);
  assert.equal(groupCommands([command], [], 'en', false)[0].kind, 'bot');
});

test('command discovery renders avatars, grouped rows, required chips and an honest empty frequency state', () => {
  setLanguage('pt-BR');
  const html = renderCommandCatalog(groupCommands([command, otherBot], []), 0);
  assert.ok(html.includes('command-bot-rail'));
  assert.ok(html.includes('data-command-section="frequent"'));
  assert.ok(html.includes('Os comandos que você executar'));
  assert.ok(html.includes('command-row-avatar'));
  assert.ok(html.includes('<strong>/play</strong>'));
  assert.ok(html.includes('command-row-description'));
  const preview = renderCommandParameters(command);
  assert.ok(preview.includes('>song</span>'));
  assert.ok(preview.includes('>count</span>'));
  assert.ok(preview.includes('+3 opcionais'));
  assert.equal(preview.includes('>private</span>'), false);
  const escaped = renderCommandCatalog(groupCommands([{ ...command, botName: '<img src=x>', description: '<script>bad</script>' }], []), 0);
  assert.equal(escaped.includes('<script>'), false);
  assert.ok(escaped.includes('&lt;img src=x&gt;'));
});

test('empty discovery distinguishes loading, offline bots, consent, denied commands and missing registration', (context) => {
  const previous = getLanguage();
  context.after(() => setLanguage(previous));
  const permissions: BotPermissions = {
    requested: ['commands'], granted: [], revision: 1,
    reviewRequired: true, reviewedBy: null, reviewedAt: null,
  };
  const bot: BotSettingsSummary = {
    botId: 'music-bot', name: '<Music Bot>', online: true, capabilities: { downloadsSound: false },
    schemaRevision: 1, revision: 0, hasServerSettings: false, hasUserSettings: false,
    canConfigure: false, canManage: true,
    permissions,
  };
  for (const language of ['pt-BR', 'en'] as const) {
    setLanguage(language);
    assert.ok(renderEmptyCommandCatalog(null).includes(t('botChat.loadingCommands')));
    assert.ok(renderEmptyCommandCatalog([]).includes(t('botChat.noOnlineBots')));
    assert.ok(renderEmptyCommandCatalog([{ ...bot, online: false }]).includes(t('botChat.noOnlineBots')));
    const pending = renderEmptyCommandCatalog([bot]);
    assert.ok(pending.includes(t('botChat.commandsReviewRequired')));
    assert.ok(pending.includes('&lt;Music Bot&gt;'));
    assert.ok(pending.includes('data-command-bot-configure="music-bot"'));
    assert.ok(!pending.includes(t('botChat.noOnlineBots')));
    assert.ok(!renderEmptyCommandCatalog([{ ...bot, canManage: false }]).includes('data-command-bot-configure'));
    const denied = { ...bot, permissions: { ...permissions, reviewRequired: false } };
    assert.ok(renderEmptyCommandCatalog([denied]).includes(t('botChat.commandsNotGranted')));
    const undeclared = { ...bot, permissions: { ...permissions, requested: null } };
    assert.ok(renderEmptyCommandCatalog([undeclared]).includes(t('botChat.commandsUndeclared')));
    const ready: BotSettingsSummary = {
      ...bot, permissions: { ...permissions, granted: ['commands'], reviewRequired: false },
    };
    assert.ok(renderEmptyCommandCatalog([ready]).includes(t('botChat.commandsUnavailable')));
    assert.ok(renderEmptyCommandCatalog([bot], true).includes(t('botChat.noMatchingCommands')));
    assert.ok(!renderEmptyCommandCatalog([bot], true).includes('data-command-bot-configure'));
    const empty = renderCommandCatalog([], 0, undefined, undefined, pending);
    assert.ok(empty.includes(t('botChat.commandsReviewRequired')));
    assert.ok(!empty.includes('role="listbox"'), 'Configuration actions are not exposed as command options');
  }
});

test('required arguments stay visible; removing optional arguments omits them without losing typed values', () => {
  const store = usageStore(new MemoryUsageStorage(), 'server');
  store.selectCommand('channel', command, 'A title with spaces and, commas');
  const draft = store.getCommandDraft('channel');
  assert.ok(draft);
  assert.deepEqual(visibleCommandFields(command, draft.visibleOptionalNames).map((field) => field.name), ['song', 'count']);
  assert.equal(store.setCommandOptionVisible('channel', 'song', false), false);
  assert.equal(store.setCommandOptionVisible('channel', 'unknown', true), false);
  assert.equal(store.setCommandOptionVisible('channel', 'private', true), true);
  assert.equal(store.setCommandOptionVisible('channel', 'mode', true), true);
  store.setCommandValues('channel', { song: 'A title with spaces and, commas', count: '0', private: false, mode: 'shuffle' });
  store.setCommandOptionVisible('channel', 'private', false);
  store.setCommandOptionVisible('channel', 'mode', false);
  assert.equal(draft.values.private, false);
  assert.equal(draft.values.mode, 'shuffle');
  assert.deepEqual(commandValuesFromInputs(command, visibleCommandValues(command, draft.values, draft.visibleOptionalNames), []),
    { success: true, values: { song: 'A title with spaces and, commas', count: 0 } });
  store.setCommandOptionVisible('channel', 'private', true);
  assert.equal(visibleCommandValues(command, draft.values, draft.visibleOptionalNames).private, false);
  store.setCommandPending('channel', draft, true);
  assert.equal(store.setCommandOptionVisible('channel', 'member', true), false);
});

test('unrelated registry refreshes retain the selected draft without rebuilding its controls', () => {
  const store = usageStore(new MemoryUsageStorage(), 'server');
  store.selectCommand('channel', command, 'A title with spaces');
  store.setCommandOptionVisible('channel', 'mode', true);
  store.setCommandValues('channel', { song: 'A title with spaces', count: '0', mode: 'shuffle' });
  const draft = store.getCommandDraft('channel');
  assert.ok(draft);
  let updates = 0;
  const unbind = store.bus.on('chat.command_draft_updated', () => { updates++; });
  try {
    store.setCommands([structuredClone(command), { ...otherBot, botName: 'Another bot changed its profile' }]);
    assert.equal(updates, 0);
    assert.equal(store.getCommandDraft('channel'), draft);
    assert.deepEqual(draft.values, { song: 'A title with spaces', count: '0', mode: 'shuffle' });
    assert.deepEqual(draft.visibleOptionalNames, ['mode']);
    store.setCommands([{ ...command, botName: 'Selected bot renamed' }, otherBot]);
    assert.equal(updates, 1);
    assert.deepEqual(draft.visibleOptionalNames, ['mode']);
    store.setCommands([otherBot]);
    assert.equal(updates, 2);
    store.setCommands([command, otherBot]);
    assert.equal(updates, 3);
  } finally {
    unbind();
  }
});

test('bot user parameters include the human caller and exclude bot accounts without changing mentions', () => {
  const server = createServerStore();
  server.bus = new EventBus();
  const other = { ...member, id: 'other-member', clientId: 'other-client', nickname: 'Bob' };
  const bot = { ...member, id: 'bot-member', clientId: 'bot-client', nickname: 'Bot', isBot: true };
  const offlineBot: UserSummary = { ...bot, id: 'offline-bot', status: 'DISCONNECTED' };
  server.setServerDetails({
    id: 'server', name: 'Server', createdAt: 1, channels: [], members: [member, other, bot],
    knownMembers: [member, other, bot, offlineBot], maxUsers: 10, voiceStates: {},
  }, member);
  const field = commandInputFields(command).find((input) => input.name === 'member');
  assert.ok(field);
  const candidates = server.getHumanMembersInDisplayOrder();
  assert.ok(commandParameterChoices(field, candidates).some((choice) => choice.value === member.id));
  assert.deepEqual(candidates.map((candidate) => candidate.id), [member.id, other.id]);
  assert.equal(server.getMentionableUsers().some((candidate) => candidate.id === member.id), false);
  assert.equal(server.getMentionableUsers().some((candidate) => candidate.id === bot.id), true);
  assert.deepEqual(commandValuesFromInputs(command, { song: 'A song', count: '0', member: member.id }, candidates), {
    success: true, values: { song: 'A song', count: 0, member: member.id },
  });
  assert.equal(commandValuesFromInputs(command, { song: 'A song', count: '0', member: bot.id }, candidates).success, false);
});

test('a typed optional first argument is revealed instead of silently hidden', () => {
  const optional: SlashCommand = { ...command, options: [{ name: 'question', description: 'Question', type: 'string' }] };
  const store = usageStore(new MemoryUsageStorage(), 'server', [optional]);
  store.selectCommand('channel', optional, 'Does this preserve my words?');
  const draft = store.getCommandDraft('channel');
  assert.ok(draft);
  assert.deepEqual(draft.visibleOptionalNames, ['question']);
  assert.equal(visibleCommandValues(optional, draft.values, draft.visibleOptionalNames).question, 'Does this preserve my words?');
});

test('compact composer uses inline controls and anchored declared/member choices, not a stacked form', () => {
  const store = usageStore(new MemoryUsageStorage(), 'server');
  store.selectCommand('channel', command, 'Multiword title');
  for (const name of ['private', 'member', 'mode']) store.setCommandOptionVisible('channel', name, true);
  const draft = store.getCommandDraft('channel');
  assert.ok(draft);
  const html = renderCompactCommand(draft, 'channel', [member], true, true);
  assert.ok(html.includes('bot-inline-command'));
  assert.ok(html.includes('bot-inline-argument'));
  assert.ok(html.includes('data-parameter-hint-description'));
  assert.ok(html.includes('data-bot-choice="member"'));
  assert.ok(html.includes('data-bot-choice="mode"'));
  assert.ok(html.includes('role="switch"'));
  assert.ok(html.includes('toggle-slider'));
  assert.equal(html.includes('class="bot-fields"'), false);
  assert.equal(html.includes('<select'), false);
  assert.equal((html.match(/type="submit"/g) ?? []).length, 1);
  assert.match(html, /bot-command-run" disabled/);
  store.setCommandValues('channel', { song: 'Multiword title', count: '0' });
  const readyHtml = renderCompactCommand(draft, 'channel', [member], true, true);
  assert.doesNotMatch(readyHtml, /bot-command-run" disabled/);
  assert.equal(store.getInvocations('channel').length, 0);
  const fields = commandInputFields(command);
  const userField = fields.find((field) => field.name === 'member');
  const choiceField = fields.find((field) => field.name === 'mode');
  assert.ok(userField && choiceField);
  assert.deepEqual(commandParameterChoices(userField, [member]), [{ value: member.id, label: member.nickname, avatarUrl: member.avatarUrl }]);
  assert.deepEqual(commandParameterChoices(choiceField, []), [{ label: 'In order', value: 'ordered' }, { label: 'Shuffle', value: 'shuffle' }]);
  const choices = renderParameterChoices([{ value: 'real-value', label: '<script>unsafe</script>' }], 0, 'Options');
  assert.ok(choices.includes('role="listbox"'));
  assert.equal(choices.includes('<script>'), false);
});

test('generic selection choices render reusable audio previews without changing submitted values', () => {
  const audioChoices: SelectionChoice[] = [
    {
      label: 'Generic preview',
      value: 'stable-id',
      description: 'Reusable outside any specific bot',
      audio: { url: 'https://cdn.example.test/preview.ogg', fileName: 'preview.ogg', durationMs: 12_345 },
    },
    { label: 'Plain option', value: 'plain' },
    { label: 'Another preview', value: 'another', audio: { url: 'https://cdn.example.test/another.ogg' } },
  ];
  const audioCommand: SlashCommand & {
    options: [{
      name: 'clip';
      description: 'Clip';
      type: 'string';
      required: true;
      choices: SelectionChoice[];
    }];
  } = {
    name: 'preview', description: 'Preview audio', botId: 'generic-bot', botName: 'Generic Bot',
    options: [{ name: 'clip', description: 'Clip', type: 'string', required: true, choices: audioChoices }],
  };
  const field = commandInputFields(audioCommand)[0];
  assert.ok(field.type === 'select');
  const audio = field.choices[0].audio;
  assert.ok(audio && 'url' in audio);
  assert.equal(audio.url, 'https://cdn.example.test/preview.ogg');
  assert.deepEqual(commandValuesFromInputs(audioCommand, { clip: 'stable-id' }, []), {
    success: true, values: { clip: 'stable-id' },
  });
  const menu = renderParameterChoices(field.choices, 0, 'Clip choices');
  assert.ok(menu.includes('data-audio-preview-action="toggle"'));
  assert.ok(menu.includes('data-audio-url="https://cdn.example.test/preview.ogg"'));
  assert.ok(menu.includes('type="range"'));
  assert.ok(menu.includes('0:12'));
  assert.equal((menu.match(/data-audio-preview-volume\s/g) ?? []).length, 1);
  assert.equal((menu.match(/data-audio-preview-progress\s/g) ?? []).length, 2);
  assert.ok(menu.includes('data-audio-preview-percentage>60%</output>'));
  const lazyMenu = renderParameterChoices([{
    label: 'Lazy clip', value: 'canonical-track', audio: { resourceId: 'opaque-preview', fileName: 'clip.ogg', durationMs: 10_000 },
  }], 0, 'Lazy choices');
  assert.ok(lazyMenu.includes('data-audio-resource-id="opaque-preview"'));
  assert.ok(!lazyMenu.includes('data-audio-url='));
  assert.ok(lazyMenu.includes('data-audio-preview-action="toggle"'));
  const form = renderBotFields([
    { ...field, label: 'Clip', presentation: 'buttons' },
    { ...field, name: 'second-clip', label: 'Second clip', presentation: 'dropdown' },
  ], {}, {
    prefix: 'generic-form', disabled: false,
  });
  assert.ok(form.includes('data-bot-select-value="stable-id"'));
  assert.ok(form.includes('data-bot-select-submit="true"'));
  assert.equal(form.includes('<select'), false);
  assert.equal((form.match(/data-audio-preview-volume\s/g) ?? []).length, 1, 'Multiple audio fields share one form volume control');
  assert.equal((form.match(/data-audio-preview-progress\s/g) ?? []).length, 4);
});

test('command parameter errors reuse validation, retain optional removal and allow false and zero', () => {
  const store = usageStore(new MemoryUsageStorage(), 'server');
  store.selectCommand('channel', command);
  for (const name of ['private', 'member', 'mode']) store.setCommandOptionVisible('channel', name, true);
  const draft = store.getCommandDraft('channel');
  assert.ok(draft);
  const fields = commandInputFields(command);
  const error = (name: string) => {
    const field = fields.find((entry) => entry.name === name);
    assert.ok(field);
    return commandParameterError(draft, field, [member]);
  };
  assert.equal(error('count'), undefined, 'Untouched missing values should not start with an error');
  store.touchCommandField('channel', 'count');
  assert.ok(error('count'));
  for (const count of ['11', '-1', '2.5', 'word']) {
    store.setCommandValues('channel', { song: 'Song', count });
    assert.ok(error('count'));
    assert.match(renderCompactCommand(draft, 'channel', [member], true, true), /required invalid" data-field-name="count"/);
  }
  store.setCommandValues('channel', { song: 'Song', count: 0, private: false, mode: 'unknown', member: 'departed' });
  assert.equal(error('count'), undefined);
  assert.equal(error('private'), undefined);
  assert.ok(error('mode'));
  assert.ok(error('member'));
  const html = renderCompactCommand(draft, 'channel', [member], true, true);
  assert.ok(html.includes('data-remove-parameter="mode"'));
  assert.ok(html.includes('bot-argument-measure'));
  assert.ok(html.includes('Enter the full title'));
  store.setCommandOptionVisible('channel', 'mode', false);
  assert.doesNotMatch(renderCompactCommand(draft, 'channel', [member], true, true), /data-field-name="mode"/);
});

test('autocomplete errors wait for interaction and disappear after selecting a valid choice', () => {
  const query: SlashCommand = {
    ...command, options: [{ name: 'audio', description: 'Audio', type: 'string', required: true, autocomplete: true }],
  };
  const store = usageStore(new MemoryUsageStorage(), 'server', [query]);
  store.selectCommand('channel', query);
  const draft = store.getCommandDraft('channel');
  assert.ok(draft);
  const field = commandInputFields(query)[0];
  store.setCommandQuery('channel', 'audio', 'searching');
  assert.equal(commandParameterError(draft, field, []), undefined);
  store.touchCommandField('channel', 'audio');
  assert.ok(commandParameterError(draft, field, []));
  store.selectCommandChoice('channel', 'audio', { label: 'Result', value: 'opaque-id' });
  assert.equal(commandParameterError(draft, field, []), undefined);
});

test('preview volume scope belongs to the command, independently of fields and other commands or servers', () => {
  const scope = commandPreviewVolumeScope('server', 'bot', 'query');
  for (const other of [
    commandPreviewVolumeScope('another-server', 'bot', 'query'),
    commandPreviewVolumeScope('server', 'another-bot', 'query'),
    commandPreviewVolumeScope('server', 'bot', 'another-command'),
  ]) assert.notEqual(scope, other);
  const choices = [{ label: 'Preview', value: 'id', audio: { url: 'https://cdn.example.test/clip.mp3' } }];
  for (const field of ['first', 'second']) {
    const html = renderParameterChoices(choices, 0, field, `command:${field}`, scope);
    assert.ok(html.includes('data-audio-volume-scope="[&quot;command&quot;,&quot;server&quot;,&quot;bot&quot;,&quot;query&quot;]"'));
  }
});

test('download confirmation phase shows pending copy without transfer progress', () => {
  const html = renderBotInvocation({
    invocationId: 'download-confirming', channelId: 'channel', botId: 'music-bot', commandName: 'play',
    botName: 'Music Bot', createdAt: 1, expiresAt: Date.now() + 60_000, status: 'active',
    cancelPending: false, forms: [], acknowledged: true, hasResponse: false,
    soundDownload: {
      downloadId: 'download', title: 'Sound title', fileName: 'sound.mp3', receivedBytes: 0,
      phase: 'confirming',
    },
  });
  assert.ok(html.includes('Aguardando sua confirmação para baixar.'));
  assert.equal(html.includes('<progress'), false);
  assert.match(html, /bot-loading-spinner/);
});

test('an early bot acknowledgement keeps its invocation animated until the operation finishes', () => {
  const invocation: Parameters<typeof renderBotInvocation>[0] = {
    invocationId: 'music-preparing', channelId: 'channel', botId: 'music-bot', commandName: 'play',
    botName: 'Music Bot', createdAt: 1, expiresAt: Date.now() + 60_000, status: 'active',
    cancelPending: false, forms: [], acknowledged: true, hasResponse: true,
  };
  const html = renderBotInvocation(invocation);
  assert.match(html, /bot-loading-spinner/);
  assert.match(html, /aria-busy="true"/);
  assert.equal(html.includes('<progress'), false, 'Unknown source startup time is not a download percentage');
  invocation.status = 'completed';
  assert.equal(renderBotInvocation(invocation), '');
});

test('flat attribution maps to distinct nested caller snapshots for private and public bot messages', () => {
  for (const ephemeral of [true, false]) {
    const payload: BotCommandMessagePayload = {
      invocationId: 'invocation', commandName: 'play', invokerId: member.id,
      invokerNickname: member.nickname, invokerAvatarUrl: member.avatarUrl,
      messageId: 'message', channelId: 'channel', botId: command.botId, botName: command.botName,
      botAvatarUrl: 'http://127.0.0.1:9900/avatars/bot.png',
      content: 'Result', createdAt: 1000, ephemeral,
    };
    const message = botCommandMessage(payload);
    assert.deepEqual(message.botCommand, {
      invocationId: payload.invocationId, commandName: payload.commandName,
      invokerId: payload.invokerId, invokerNickname: payload.invokerNickname,
      invokerAvatarUrl: payload.invokerAvatarUrl,
    });
    assert.equal(message.isEphemeral, ephemeral);
    assert.equal(message.userId, payload.botId);
    assert.equal(message.userNickname, payload.botName);
    assert.equal(message.userAvatarUrl, payload.botAvatarUrl);
    payload.invokerNickname = 'Changed after dispatch';
    assert.equal(message.botCommand?.invokerNickname, member.nickname);
  }
});

test('each recipient localizes private, public and persisted invocation attribution without rewriting snapshots', () => {
  const localized: SlashCommand = { ...command, localizations: { 'pt-BR': { name: 'tocar' }, en: { name: 'listen' } } };
  try {
    for (const ephemeral of [true, false]) {
      const message = botCommandMessage({
        invocationId: 'invocation', commandName: 'play', invokerId: member.id, invokerNickname: member.nickname,
        messageId: 'message', channelId: 'channel', botId: localized.botId, botName: localized.botName,
        content: 'Never translate reply content', createdAt: 1, ephemeral,
      });
      const store = createChatStore();
      store.setHistory('channel', [message]);
      const snapshot = structuredClone(store.getMessages('channel')[0]);
      for (const locale of ['pt-BR', 'en'] as const) {
        setLanguage(locale);
        const presentation = getCommandPresentation(localized, locale);
        const markup = renderBotCommandContext(snapshot, presentation);
        assert.ok(markup.includes(locale === 'pt-BR' ? 'Alice usou /tocar' : 'Alice used /listen'));
        assert.match(markup, /data-command-name="play"/);
        assert.equal(snapshot.botCommand?.commandName, 'play');
        assert.equal(snapshot.content, 'Never translate reply content');
      }
      assert.deepEqual(store.getMessages('channel')[0], snapshot);
    }
    const invocation = {
      invocationId: 'active', channelId: 'channel', botId: localized.botId, commandName: localized.name,
      botName: localized.botName, createdAt: 1, expiresAt: Date.now() + 60_000, status: 'active' as const,
      cancelPending: false, forms: [], acknowledged: true, hasResponse: false,
    };
    const markup = renderBotInvocation(invocation, true, 'server', undefined, getCommandPresentation(localized, 'pt-BR'));
    assert.ok(markup.includes('<div class="bot-command-name">/tocar</div>'));
    assert.match(markup, /data-command-name="play"/);
    assert.equal(invocation.commandName, 'play');
    assert.ok(renderBotCommandContext({ botCommand: {
      invocationId: 'offline', commandName: 'play', invokerId: member.id, invokerNickname: member.nickname,
    } }).includes('/play'), 'Absent bot metadata falls back to the persisted canonical command');
  } finally {
    setLanguage('pt-BR');
  }
});

test('bot response attribution is authoritative, localized and retained through history and edits', () => {
  const payload: BotCommandMessagePayload = {
    invocationId: 'invocation', commandName: 'play', invokerId: member.id,
    invokerNickname: member.nickname, invokerAvatarUrl: member.avatarUrl,
    messageId: 'message', channelId: 'channel', botId: command.botId, botName: command.botName,
    content: 'Public result', createdAt: 1000, ephemeral: false,
  };
  const server = createServerStore();
  server.currentUser = { ...member, id: 'other-viewer', nickname: 'Not the caller' };
  setActiveServerStore(server);
  try {
    const message = botCommandMessage(payload);
    assert.ok(message.botCommand);
    setLanguage('pt-BR');
    assert.equal(formatCommandContext(message.botCommand), 'Alice usou /play');
    setLanguage('en');
    assert.equal(formatCommandContext(message.botCommand), 'Alice used /play');
    const html = renderBotCommandContext(message);
    assert.ok(html.includes('Alice used /play'));
    assert.ok(html.includes(member.avatarUrl ?? ''));
    assert.equal(html.includes('Not the caller'), false);
    assert.equal(renderBotCommandContext({}), '');
    assert.equal(renderBotCommandContext({ botCommand: { ...message.botCommand, invokerNickname: '<script>Caller</script>' } }).includes('<script>'), false);
    const store = createChatStore();
    store.bus = new EventBus();
    store.addMessage(message);
    const { botCommand: context, ...historyRow } = message;
    store.setHistory('channel', [historyRow]);
    assert.deepEqual(store.getMessages('channel')[0].botCommand, context);
    store.updateMessage({ ...historyRow, content: 'Edited public result', editedAt: 2000 });
    assert.deepEqual(store.getMessages('channel')[0].botCommand, context);
    assert.equal(store.getMessages('channel')[0].userId, command.botId);
  } finally {
    setLanguage('pt-BR');
    setActiveServerStore(createServerStore());
  }
});
