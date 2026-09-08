import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIMITS,
  MessageType,
  ProtocolErrorCode,
  type BotForm,
  type CommandPromptReceivedPayload,
  type SlashCommand,
} from '@monky/shared';
import {
  botCommandMessage,
  botInputError,
  commandInputFields,
  commandValuesFromInputs,
  formValuesFromInputs,
  initialBotInputValues,
  parseTypedCommand,
  seedCommandInputs,
} from '../src/renderer/utils/botInputs';
import { validateBotAvatar } from '../src/renderer/utils/botProfile';
import { createChatStore, chatStore, setActiveChatStore } from '../src/renderer/stores/chatStore';
import { createServerStore, setActiveServerStore } from '../src/renderer/stores/serverStore';
import { EventBus, appEvents } from '../src/renderer/core/EventBus';
import { silentBus } from '../src/renderer/core/activeProxy';
import { SessionManager } from '../src/renderer/core/SessionManager';
import { bindBotChatEvents } from '../src/renderer/core/botChatEvents';
import { routeSessionEvent, setSessionEventRouter } from '../src/renderer/core/sessionRouting';
import { renderBotFields } from '../src/renderer/views/botFields';
import { renderBotInvocation } from '../src/renderer/views/BotChatView';
import { setLanguage } from '../src/renderer/i18n';
import { translateProtocolError } from '../src/renderer/i18n/protocolErrors';

test('persistent reactions toggle independently per emoji and do not create phantom messages', () => {
  const store = createChatStore();
  store.bus = new EventBus();
  store.addMessage({ id: 'question', channelId: 'text', userId: 'bot', userNickname: 'Bot', content: 'Question?', createdAt: 1, isBot: true });
  const reaction = { channelId: 'text', messageId: 'question', userId: 'alice', userNickname: 'Alice', emoji: '👍' };
  store.updateReaction(reaction, true);
  store.updateReaction(reaction, true);
  store.updateReaction({ ...reaction, emoji: '❤️' }, true);
  store.updateReaction({ ...reaction, userId: 'bob', userNickname: 'Bob' }, true);
  const message = store.getMessages('text')[0];
  assert.equal(message.reactions?.length, 2);
  assert.equal(message.reactions?.find((entry) => entry.emoji === '👍')?.users.length, 2);
  store.updateReaction(reaction, false);
  assert.equal(message.reactions?.find((entry) => entry.emoji === '👍')?.users[0].userId, 'bob');
  store.updateReaction({ ...reaction, emoji: '❤️' }, false);
  assert.equal(message.reactions?.length, 1);
  store.updateReaction({ ...reaction, messageId: 'missing' }, true);
  assert.equal(store.getMessages('text').length, 1);
  store.setHistory('text', [{ ...message, reactions: [] }]);
  assert.deepEqual(store.getMessages('text')[0].reactions, []);
});

const pollCommand: SlashCommand = {
  name: 'poll',
  description: 'Create a poll',
  botId: 'bot-one',
  botName: 'Poll Bot',
  botAvatarUrl: '/avatars/poll.png',
  options: [
    { name: 'question', description: 'Question', type: 'string', required: true, placeholder: 'What should we play?' },
    { name: 'duration', description: 'Minutes', type: 'integer', required: true, min: 1, max: 60 },
    { name: 'anonymous', description: 'Anonymous', type: 'boolean' },
    { name: 'host', description: 'Host', type: 'user' },
    { name: 'theme', description: 'Theme', type: 'string', choices: [{ label: 'Games', value: 'games' }] },
  ],
};

const form: BotForm = {
  title: 'Configure poll',
  fields: [
    { name: 'title', label: 'Title', type: 'text', required: true, multiline: true, maxLength: 200 },
    { name: 'choices', label: 'Choices', type: 'string-list', required: true, minItems: 2, maxItems: 5 },
    { name: 'minutes', label: 'Minutes', type: 'integer', required: true, min: 1, max: 60, defaultValue: 5 },
    { name: 'anonymous', label: 'Anonymous', type: 'boolean', defaultValue: false },
    { name: 'theme', label: 'Theme', type: 'select', choices: [{ label: 'Games', value: 'games' }] },
  ],
};

function prompt(invocationId = 'invoke-one', interactionId = 'step-one'): CommandPromptReceivedPayload {
  return {
    invocationId,
    interactionId,
    channelId: 'channel-one',
    botId: pollCommand.botId,
    botName: pollCommand.botName,
    botAvatarUrl: pollCommand.botAvatarUrl,
    expiresAt: Date.now() + 60_000,
    form,
  };
}

function invocationStore(id = 'invoke-one') {
  const store = createChatStore();
  store.bus = new EventBus();
  store.setCommands([pollCommand]);
  store.acknowledgeCommand({
    invocationId: id, channelId: 'channel-one', botId: pollCommand.botId, commandName: pollCommand.name,
  });
  return store;
}

test('named command inputs retain multiword text, commas and option identity', () => {
  const text = 'Which game should we play, after dinner?';
  const parsed = parseTypedCommand(`/poll ${text}`, [pollCommand]);
  assert.equal(parsed.kind, 'command');
  if (parsed.kind !== 'command') throw new Error('Expected a command');
  const inputs = { ...seedCommandInputs(parsed.command, parsed.text), duration: '15', anonymous: false, host: 'member-one', theme: 'games' };
  const result = commandValuesFromInputs(parsed.command, inputs, [{ id: 'member-one' }]);
  assert.deepEqual(result, {
    success: true,
    values: { question: text, duration: 15, anonymous: false, host: 'member-one', theme: 'games' },
  });
  assert.equal('input' in inputs, false);
});

test('integer conversion is strict and required, choice and membership errors name the field', () => {
  for (const invalid of ['12junk', '1.5', '1e2', '9007199254740992']) {
    assert.deepEqual(commandValuesFromInputs(pollCommand, { question: 'A B', duration: invalid }, []),
      { success: false, field: 'duration', reason: 'type' });
  }
  assert.deepEqual(commandValuesFromInputs(pollCommand, { question: 'A B' }, []),
    { success: false, field: 'duration', reason: 'required' });
  assert.deepEqual(commandValuesFromInputs(pollCommand, { question: 'A B', duration: '0' }, []),
    { success: false, field: 'duration', reason: 'min' });
  assert.deepEqual(commandValuesFromInputs(pollCommand, { question: 'A B', duration: '1', theme: 'invalid' }, []),
    { success: false, field: 'theme', reason: 'choice' });
  assert.deepEqual(commandValuesFromInputs(pollCommand, { question: 'A B', duration: '1', host: 'missing' }, []),
    { success: false, field: 'host', reason: 'choice' });
  assert.deepEqual(commandValuesFromInputs(pollCommand, { question: 'A B', duration: '+1', host: '', theme: '' }, []),
    { success: true, values: { question: 'A B', duration: 1 } });
});

test('duplicate command names require selection and retain the exact bot, without executing', () => {
  const other: SlashCommand = { ...pollCommand, botId: 'bot-two', botName: 'Second Bot' };
  const store = createChatStore();
  store.bus = new EventBus();
  store.setCommands([pollCommand, other]);
  const parsed = parseTypedCommand('/poll Which game tonight?', store.getCommands());
  assert.equal(parsed.kind, 'ambiguous');
  if (parsed.kind !== 'ambiguous') throw new Error('Expected disambiguation');
  store.selectCommand('channel-one', parsed.commands[1], parsed.text);
  assert.equal(store.getCommandDraft('channel-one')?.command.botId, 'bot-two');
  assert.equal(store.getCommandDraft('channel-one')?.values.question, 'Which game tonight?');
  assert.equal(store.getCommandDraft('channel-one')?.pending, false);
  assert.equal(store.getInvocations('channel-one').length, 0);
  store.setCommands([pollCommand]);
  const selected = store.getCommandDraft('channel-one');
  assert.ok(selected);
  assert.equal(store.isCommandAvailable(selected.command), false);
  assert.equal(selected.command.botId, 'bot-two');
});

test('ordinary chat stays ordinary while unavailable slash commands cannot become public text', () => {
  assert.deepEqual(parseTypedCommand('Hello /poll friends', []), { kind: 'chat' });
  assert.deepEqual(parseTypedCommand('/poll Long private question', []), { kind: 'unavailable' });
  const command = { ...pollCommand, name: 'with-hyphen', options: [] };
  assert.equal(parseTypedCommand('/with-hyphen', [command]).kind, 'command');
  const numericCommand: SlashCommand = {
    ...pollCommand,
    name: '8ball',
    options: [{ name: 'question', description: 'Question', type: 'string', required: true }],
  };
  const numeric = parseTypedCommand('/8ball Should we play tonight?', [numericCommand]);
  assert.equal(numeric.kind, 'command');
  if (numeric.kind !== 'command') throw new Error('Expected a command beginning with a digit');
  assert.deepEqual(commandValuesFromInputs(numeric.command, seedCommandInputs(numeric.command, numeric.text), []),
    { success: true, values: { question: 'Should we play tonight?' } });
  const store = createChatStore();
  store.setDraft('other-channel', 'Unsent ordinary message\nwith a second line');
  store.selectCommand('channel-one', command);
  assert.deepEqual(store.getCommandDraft('channel-one')?.values, {});
  assert.equal(store.getDraft('other-channel'), 'Unsent ordinary message\nwith a second line');
  store.clearCommand('channel-one');
  assert.equal(store.getDraft('other-channel'), 'Unsent ordinary message\nwith a second line');
});

test('required booleans start at false; optional booleans can remain skipped', () => {
  const command: SlashCommand = {
    ...pollCommand,
    options: [
      { name: 'required_flag', description: 'Required flag', type: 'boolean', required: true },
      { name: 'optional_flag', description: 'Optional flag', type: 'boolean' },
    ],
  };
  assert.deepEqual(seedCommandInputs(command), { required_flag: false });
  assert.deepEqual(commandValuesFromInputs(command, seedCommandInputs(command), []),
    { success: true, values: { required_flag: false } });
  assert.deepEqual(seedCommandInputs(command, 'false'), { required_flag: false });
});

test('command state rejects duplicate invokes and cannot be cleared by a stale completion', () => {
  const store = createChatStore();
  store.bus = new EventBus();
  store.selectCommand('channel-one', pollCommand, 'Private draft');
  const draft = store.getCommandDraft('channel-one');
  assert.ok(draft);
  store.setCommandPending('channel-one', draft, true);
  store.selectCommand('channel-one', { ...pollCommand, botId: 'other-bot' });
  assert.equal(store.getCommandDraft('channel-one'), draft);
  store.setCommandValues('channel-one', { question: 'Overwritten' });
  assert.equal(draft.values.question, 'Private draft');
  store.clear();
  store.selectCommand('channel-one', pollCommand, 'New connection');
  store.clearCommand('channel-one', draft);
  assert.equal(store.setCommandPending('channel-one', draft, false, 'Stale error'), false);
  assert.equal(store.getCommandDraft('channel-one')?.values.question, 'New connection');
});

test('private form inputs survive history, duplicate prompts and channel changes', () => {
  const store = invocationStore();
  const incoming = prompt();
  store.receivePrompt(incoming);
  const values = { title: '\nA private multiword question', choices: ['First option', 'Second option'], minutes: '12', anonymous: false };
  store.setFormValues(incoming.invocationId, incoming.interactionId, values);
  store.setHistory('channel-one', []);
  store.getInvocations('other-channel');
  store.receivePrompt(incoming);
  const invocation = store.getInvocation(incoming.invocationId);
  assert.ok(invocation);
  assert.equal(invocation.forms.length, 1);
  assert.deepEqual(invocation.forms[0].values, values);
  assert.equal(invocation.forms[0].status, 'editing');
  assert.deepEqual(formValuesFromInputs(form, values), {
    success: true, values: { ...values, minutes: 12 },
  });
});

test('form defaults are independent and list validation preserves errors and entered values', () => {
  const fields: BotForm['fields'] = [{ name: 'choices', label: 'Choices', type: 'string-list', defaultValue: ['One', 'Two'] }];
  const first = initialBotInputValues(fields);
  const second = initialBotInputValues(fields);
  assert.notEqual(first.choices, second.choices);
  const store = invocationStore();
  store.receivePrompt(prompt());
  const values = { title: 'Question', choices: ['Same', ' same '], minutes: '5' };
  store.setFormValues('invoke-one', 'step-one', values);
  assert.deepEqual(formValuesFromInputs(form, values), { success: false, field: 'choices', reason: 'duplicate' });
  store.failFormSubmit('invoke-one', 'step-one', 'Please use distinct options');
  assert.deepEqual(store.getInvocation('invoke-one')?.forms[0].values, values);
  assert.equal(store.getInvocation('invoke-one')?.forms[0].status, 'editing');
});

test('empty form defaults remain unfilled while false and zero survive input conversion', () => {
  const emptyDefaults: BotForm = {
    title: 'Initially unfilled',
    fields: [
      { name: 'title', label: 'Title', type: 'text', required: true, minLength: 0, defaultValue: '' },
      { name: 'choices', label: 'Choices', type: 'string-list', required: true, minItems: 2, defaultValue: [] },
      { name: 'optional_choices', label: 'Optional choices', type: 'string-list', defaultValue: [] },
      { name: 'count', label: 'Count', type: 'integer', min: 0, defaultValue: 0 },
      { name: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: false },
    ],
  };
  const initial = initialBotInputValues(emptyDefaults.fields);
  assert.deepEqual(formValuesFromInputs(emptyDefaults, initial), { success: false, field: 'title', reason: 'required' });
  assert.deepEqual(formValuesFromInputs(emptyDefaults, { ...initial, title: 'Question' }),
    { success: false, field: 'choices', reason: 'required' });
  assert.deepEqual(formValuesFromInputs(emptyDefaults, {
    ...initial, title: 'Question', choices: ['One', 'Two'], count: '0',
  }), {
    success: true,
    values: { title: 'Question', choices: ['One', 'Two'], count: 0, enabled: false },
  });
});

test('only the matched form is acknowledged across rounds and concurrent invocations', () => {
  const store = invocationStore();
  store.receivePrompt(prompt());
  assert.equal(store.beginFormSubmit('invoke-one', 'step-one'), true);
  assert.equal(store.beginFormSubmit('invoke-one', 'step-one'), false);
  store.acknowledgeForm({ invocationId: 'invoke-one', interactionId: 'step-one', values: { title: 'First' } });
  store.receivePrompt(prompt('invoke-one', 'step-two'));
  store.receivePrompt(prompt('invoke-two', 'step-one'));
  store.acknowledgeForm({ invocationId: 'invoke-one', interactionId: 'step-one', values: { title: 'First' } });
  assert.equal(store.getInvocation('invoke-one')?.forms[0].status, 'submitted');
  assert.equal(store.getInvocation('invoke-one')?.forms[1].status, 'editing');
  assert.equal(store.getInvocation('invoke-two')?.forms[0].status, 'editing');
  assert.equal(store.setCancelPending('invoke-one', true), true);
  assert.equal(store.setCancelPending('invoke-one', true), false);
  assert.equal(store.beginFormSubmit('invoke-one', 'step-two'), false);
});

test('an early next prompt cannot let a late failure reopen the previous round', () => {
  const store = invocationStore();
  store.receivePrompt(prompt());
  store.beginFormSubmit('invoke-one', 'step-one');
  store.receivePrompt(prompt('invoke-one', 'step-two'));
  store.failFormSubmit('invoke-one', 'step-one', 'Late error');
  assert.equal(store.getInvocation('invoke-one')?.forms[0].status, 'closed');
  assert.equal(store.getInvocation('invoke-one')?.forms[1].status, 'editing');
  store.acknowledgeForm({ invocationId: 'invoke-one', interactionId: 'step-one', values: { title: 'Acknowledged' } });
  assert.equal(store.getInvocation('invoke-one')?.forms[0].status, 'submitted');
  assert.equal(store.getInvocation('invoke-one')?.forms[1].status, 'editing');
});

test('successful forms disappear and discard inputs, while failed submissions remain editable', () => {
  const store = invocationStore();
  store.receivePrompt(prompt());
  const invocation = store.getInvocation('invoke-one');
  assert.ok(invocation);
  store.setFormValues('invoke-one', 'step-one', { title: 'Private input' });
  store.beginFormSubmit('invoke-one', 'step-one');
  store.failFormSubmit('invoke-one', 'step-one', 'Try again');
  assert.match(renderBotInvocation(invocation), /Private input/);
  assert.match(renderBotInvocation(invocation), /Try again/);
  store.beginFormSubmit('invoke-one', 'step-one');
  store.acknowledgeForm({ invocationId: 'invoke-one', interactionId: 'step-one', values: { title: 'Private input' } });
  assert.deepEqual(invocation.forms[0].values, {});
  assert.doesNotMatch(renderBotInvocation(invocation), /bot-inline-form|Private input/);
  store.failFormSubmit('invoke-one', 'step-one', 'Late failure');
  assert.doesNotMatch(renderBotInvocation(invocation), /bot-inline-form|Late failure/);
  store.receivePrompt(prompt('invoke-one', 'step-two'));
  assert.match(renderBotInvocation(invocation), /data-interaction-id="step-two"/);
  assert.doesNotMatch(renderBotInvocation(invocation), /data-interaction-id="step-one"/);
});

test('private selectors render escaped immediate buttons or a dropdown with confirmation', () => {
  const store = invocationStore();
  const selector: BotForm = {
    title: 'Choose',
    fields: [{
      name: 'choice', label: 'Your choice', type: 'select', required: true, presentation: 'buttons',
      choices: [{ label: '<First>', value: '"first"' }, { label: 'Second', value: 'second' }],
    }],
  };
  store.receivePrompt({ ...prompt(), form: selector });
  const invocation = store.getInvocation('invoke-one');
  assert.ok(invocation);
  const buttons = renderBotInvocation(invocation);
  assert.match(buttons, /data-bot-select-value="&quot;first&quot;"/);
  assert.match(buttons, /&lt;First&gt;/);
  assert.doesNotMatch(buttons, /type="submit"/);
  assert.match(renderBotInvocation(invocation, false), /data-bot-select-value="second" disabled/);
  store.receivePrompt({
    ...prompt('invoke-one', 'step-two'),
    form: { ...selector, fields: [{
      name: 'choice', label: 'Your choice', type: 'select', required: true,
      choices: [{ label: 'First', value: 'first' }], presentation: 'dropdown',
    }] },
  });
  const dropdown = renderBotInvocation(invocation);
  assert.match(dropdown, /<select /);
  assert.match(dropdown, /type="submit"/);
});

test('finish, expiry, disconnect, revoked bots and channel access loss disable forms', () => {
  for (const action of ['finish', 'expiry', 'disconnect', 'revoke', 'channel'] as const) {
    const store = invocationStore();
    store.receivePrompt(prompt());
    store.setFormValues('invoke-one', 'step-one', { title: 'Do not lose this' });
    if (action === 'finish') store.finishInvocation({ invocationId: 'invoke-one', channelId: 'channel-one', reason: 'completed' });
    else if (action === 'expiry') store.expireInvocations(Date.now() + LIMITS.BOT_INTERACTION_TIMEOUT_MS);
    else if (action === 'disconnect') store.finishAllInvocations('caller_disconnected');
    else if (action === 'revoke') store.finishBotInvocations(pollCommand.botId);
    else store.finishChannelInvocations('channel-one');
    assert.equal(store.beginFormSubmit('invoke-one', 'step-one'), false);
    store.acknowledgeForm({ invocationId: 'invoke-one', interactionId: 'step-one', values: { title: 'Late acknowledgement' } });
    store.receivePrompt(prompt('invoke-one', 'late-step'));
    assert.equal(store.getInvocation('invoke-one')?.forms[0].status, 'closed');
    assert.equal(store.getInvocation('invoke-one')?.forms[0].values.title, 'Do not lose this');
    assert.equal(store.getInvocation('invoke-one')?.forms.length, 1);
  }
});

test('server routing stores background prompts silently and restores the foreground proxy', () => {
  const manager = new SessionManager();
  manager.install();
  const foreground = manager.create('127.0.0.1', 9901, 'Caller');
  const background = manager.create('127.0.0.1', 9902, 'Caller');
  manager.activate(foreground.key);
  let uiUpdates = 0;
  const unbindUi = appEvents.on('chat.bot_interaction_updated', () => { uiUpdates++; });
  const unbindMessage = bindBotChatEvents();
  try {
    foreground.chatStore.setDraft('channel-one', 'Foreground draft');
    const incoming = prompt();
    routeSessionEvent(background.key, `message.${MessageType.COMMAND_PROMPT}`, () => {
      appEvents.emit(`message.${MessageType.COMMAND_PROMPT}`, incoming);
    });

    assert.equal(uiUpdates, 0);
    assert.equal(foreground.chatStore.getInvocations('channel-one').length, 0);
    assert.equal(background.chatStore.getInvocations('channel-one').length, 1);
    assert.equal(chatStore.getDraft('channel-one'), 'Foreground draft');
    background.chatStore.setFormValues('invoke-one', 'step-one', { title: 'Background draft' });
    manager.activate(background.key);
    assert.equal(chatStore.getInvocation('invoke-one')?.forms[0].values.title, 'Background draft');
    manager.activate(foreground.key);
    background.chatStore.finishAllInvocations('caller_disconnected');
    assert.equal(uiUpdates, 0);
    assert.equal(foreground.chatStore.getDraft('channel-one'), 'Foreground draft');
  } finally {
    unbindUi();
    unbindMessage();
    manager.removeAll();
    setSessionEventRouter((_key, _event, emit) => emit());
    setActiveChatStore(createChatStore());
  }
});

test('canonical command registry responses reach both session stores through actual protocol bindings', () => {
  const events = new EventBus();
  const store = createChatStore();
  const server = createServerStore();
  store.bus = new EventBus();
  server.bus = new EventBus();
  setActiveChatStore(store);
  setActiveServerStore(server);
  const unbind = bindBotChatEvents(events);
  try {
    events.emit(`message.${MessageType.COMMANDS_LIST_RESPONSE}`, { commands: [pollCommand] });
    assert.deepEqual(store.getCommands(), [pollCommand]);
    assert.deepEqual(server.slashCommands, [pollCommand]);
    events.emit(`message.${MessageType.COMMAND_INVOKED}`, {
      invocationId: 'canonical-invocation', channelId: 'channel-one', botId: pollCommand.botId, commandName: pollCommand.name,
    });
    events.emit(`message.${MessageType.COMMAND_PROMPT}`, prompt('canonical-invocation'));
    assert.equal(store.getInvocation('canonical-invocation')?.forms.length, 1);
    events.emit(`message.${MessageType.COMMAND_FINISHED}`, {
      invocationId: 'canonical-invocation', channelId: 'channel-one', reason: 'cancelled',
    });
    assert.equal(store.getInvocation('canonical-invocation')?.status, 'cancelled');
    unbind();
    events.emit(`message.${MessageType.COMMANDS_LIST_RESPONSE}`, { commands: [] });
    assert.deepEqual(store.getCommands(), [pollCommand]);
  } finally {
    unbind();
    setActiveChatStore(createChatStore());
    setActiveServerStore(createServerStore());
  }
});

test('initial registry snapshots populate new and reconnecting sessions without duplicate requests', () => {
  const manager = new SessionManager();
  manager.install();
  const foreground = manager.create('127.0.0.1', 9901, 'Caller');
  const background = manager.create('127.0.0.1', 9902, 'Caller');
  manager.activate(foreground.key);
  const sent: Array<{ sessionKey: string; type: MessageType; payload: unknown }> = [];
  foreground.client.send = (type: MessageType, payload: unknown) => { sent.push({ sessionKey: foreground.key, type, payload }); };
  background.client.send = (type: MessageType, payload: unknown) => { sent.push({ sessionKey: background.key, type, payload }); };
  let uiUpdates = 0;
  const unbindUi = appEvents.on('chat.commands_updated', () => { uiUpdates++; });
  const unbind = bindBotChatEvents();
  const connected = (sessionKey: string) => {
    routeSessionEvent(sessionKey, 'network.connected', () => appEvents.emit('network.connected'));
  };
  const registry = (sessionKey: string, commands: SlashCommand[]) => {
    routeSessionEvent(sessionKey, `message.${MessageType.COMMANDS_LIST_RESPONSE}`, () => {
      appEvents.emit(`message.${MessageType.COMMANDS_LIST_RESPONSE}`, { commands });
    });
  };
  try {
    connected(background.key);
    assert.deepEqual(sent, []);
    registry(background.key, [pollCommand]);
    assert.deepEqual(background.chatStore.getCommands(), [pollCommand]);
    assert.deepEqual(background.serverStore.slashCommands, [pollCommand]);
    assert.deepEqual(foreground.chatStore.getCommands(), []);
    assert.equal(uiUpdates, 0);
    connected(foreground.key);
    const ownCommand = { ...pollCommand, botId: 'foreground-bot' };
    registry(foreground.key, [ownCommand]);
    assert.deepEqual(chatStore.getCommands(), [ownCommand]);
    assert.equal(uiUpdates, 1);
    connected(foreground.key);
    const refreshedCommand = { ...ownCommand, name: 'reconnected-command' };
    registry(foreground.key, [refreshedCommand]);
    assert.deepEqual(chatStore.getCommands(), [refreshedCommand]);
    assert.deepEqual(foreground.serverStore.slashCommands, [refreshedCommand]);
    assert.deepEqual(background.chatStore.getCommands(), [pollCommand]);
    assert.deepEqual(sent, []);
    unbind();
    connected(foreground.key);
    registry(foreground.key, []);
    assert.deepEqual(chatStore.getCommands(), [refreshedCommand]);
    assert.deepEqual(sent, []);
  } finally {
    unbind();
    unbindUi();
    manager.removeAll();
    setSessionEventRouter((_key, _event, emit) => emit());
    setActiveChatStore(createChatStore());
    setActiveServerStore(createServerStore());
  }
});

test('captured stores complete a background submission without touching the selected server', () => {
  const origin = invocationStore();
  const other = invocationStore();
  origin.bus = silentBus;
  origin.receivePrompt(prompt());
  other.receivePrompt(prompt());
  origin.setFormValues('invoke-one', 'step-one', { title: 'Origin draft' });
  other.setFormValues('invoke-one', 'step-one', { title: 'Other draft' });
  origin.beginFormSubmit('invoke-one', 'step-one');
  setActiveChatStore(other);
  origin.acknowledgeForm({ invocationId: 'invoke-one', interactionId: 'step-one', values: { title: 'Origin sent' } });
  assert.equal(origin.getInvocation('invoke-one')?.forms[0].status, 'submitted');
  assert.equal(chatStore.getInvocation('invoke-one')?.forms[0].values.title, 'Other draft');
  assert.equal(chatStore.getInvocation('invoke-one')?.forms[0].status, 'editing');
  setActiveChatStore(createChatStore());
});

test('bot response identity and private rows survive history without duplicates or caller impersonation', () => {
  const store = createChatStore();
  store.bus = new EventBus();
  const message = botCommandMessage({
    invocationId: 'invoke-one',
    messageId: 'server-assigned-message-id',
    channelId: 'channel-one',
    botId: 'real-bot-id',
    botName: 'Actual Bot Name',
    botAvatarUrl: '/avatars/actual.png',
    commandName: 'poll',
    invokerId: 'caller',
    invokerNickname: 'Original caller',
    invokerAvatarUrl: '/avatars/caller.png',
    createdAt: 100,
    content: 'Private response',
    ephemeral: true,
  });
  store.addMessage(message);
  store.addMessage(message);
  store.setHistory('channel-one', [{ id: 'human-message', channelId: 'channel-one', userId: 'caller', userNickname: 'Caller', content: 'Hi', createdAt: 50 }]);
  store.setHistory('channel-one', store.getMessages('channel-one').filter((entry) => !entry.isEphemeral));
  const bot = store.getMessages('channel-one').find((entry) => entry.id === message.id);
  assert.ok(bot);
  assert.equal(bot.userId, 'real-bot-id');
  assert.equal(bot.userNickname, 'Actual Bot Name');
  assert.equal(bot.userAvatarUrl, '/avatars/actual.png');
  assert.equal(bot.isBot, true);
  assert.equal(bot.isEphemeral, true);
  assert.equal(bot.createdAt, 100);
  assert.equal(store.getMessages('channel-one').length, 2);
});

test('persisted replies reconcile invocation state before live duplicates, including consumed forms', () => {
  for (const withForm of [false, true]) {
    for (const historyFirst of [false, true]) {
      const store = invocationStore();
      const invocation = store.getInvocation('invoke-one');
      assert.ok(invocation);
      if (withForm) {
        store.receivePrompt(prompt());
        store.acknowledgeForm({ invocationId: 'invoke-one', interactionId: 'step-one', values: {} });
      }
      const response = {
        id: 'persisted-result', channelId: 'channel-one', userId: pollCommand.botId,
        userNickname: pollCommand.botName, content: 'Public result', createdAt: 100, isBot: true,
        botCommand: { invocationId: 'invoke-one', commandName: pollCommand.name, invokerId: 'caller', invokerNickname: 'Caller' },
      };
      let updates = 0;
      const detach = store.bus.on('chat.bot_interaction_updated', () => updates++);
      if (historyFirst) store.setHistory('channel-one', [response]);
      store.finishInvocation({ invocationId: 'invoke-one', channelId: 'channel-one', reason: 'completed' });
      if (!historyFirst) {
        assert.notEqual(renderBotInvocation(invocation), '');
        const beforeResponse = updates;
        store.setHistory('channel-one', [response]);
        assert.equal(updates, beforeResponse + 1, 'A late history response must refresh the completed card');
      }
      store.addMessage(response);
      assert.equal(invocation.hasResponse, true);
      assert.equal(store.getMessages('channel-one').length, 1);
      assert.equal(renderBotInvocation(invocation), '');
      detach();
    }
  }
});

test('retained messages, completed invocations and multi-round form cards stay bounded', () => {
  const store = invocationStore();
  for (let index = 0; index < 30; index++) {
    store.receivePrompt(prompt('invoke-one', `round-${index}`));
    store.acknowledgeForm({ invocationId: 'invoke-one', interactionId: `round-${index}`, values: {} });
  }
  assert.equal(store.getInvocation('invoke-one')?.forms.length, 20);
  for (let index = 0; index < 70; index++) {
    const invocation = store.acknowledgeCommand({
      invocationId: `completed-${index}`, channelId: 'channel-one', botId: 'bot-one', commandName: 'poll',
    });
    store.finishInvocation({ ...invocation, reason: 'completed' });
    store.addMessage({
      id: `message-${index}`, userId: 'bot-one', userNickname: 'Bot', channelId: 'channel-one',
      content: 'Private', createdAt: index, isBot: true, isEphemeral: true,
    });
  }
  assert.equal(store.getInvocations('channel-one').length, 50);
  for (let index = 70; index < 400; index++) {
    store.addMessage({ id: `message-${index}`, userId: 'bot-one', userNickname: 'Bot', channelId: 'channel-one', content: 'Private', createdAt: index, isBot: true, isEphemeral: true });
  }
  store.setHistory('channel-one', []);
  assert.equal(store.getMessages('channel-one').length, 250);
  store.clear();
  assert.equal(store.getInvocations('channel-one').length, 0);
  assert.equal(store.getMessages('channel-one').length, 0);
});

test('completed text-only commands keep their reply without a duplicate status card', () => {
  for (const replyFirst of [true, false]) {
    const store = invocationStore();
    const invocation = store.getInvocation('invoke-one');
    assert.ok(invocation);
    const reply = () => store.addMessage({
      id: 'text-result', channelId: 'channel-one', userId: pollCommand.botId, userNickname: pollCommand.botName,
      content: 'Result', createdAt: Date.now(), isBot: true, isEphemeral: true,
      botCommand: { invocationId: 'invoke-one', commandName: pollCommand.name, invokerId: 'caller', invokerNickname: 'Caller' },
    });
    if (replyFirst) reply();
    assert.notEqual(renderBotInvocation(invocation), '', 'active calls remain cancellable');
    store.finishInvocation({ invocationId: 'invoke-one', channelId: 'channel-one', reason: 'completed' });
    if (!replyFirst) reply();
    assert.equal(renderBotInvocation(invocation), '');
    store.setHistory('channel-one', []);
    assert.equal(store.getMessages('channel-one')[0].content, 'Result');
    assert.equal(renderBotInvocation(invocation), '');
  }
  const quiet = invocationStore();
  quiet.finishInvocation({ invocationId: 'invoke-one', channelId: 'channel-one', reason: 'completed' });
  const quietInvocation = quiet.getInvocation('invoke-one');
  assert.ok(quietInvocation);
  assert.ok(renderBotInvocation(quietInvocation), 'a command without a reply still shows completion');
});

test('field and card markup escapes bot labels and uses switches instead of exposed checkboxes', () => {
  const command: SlashCommand = { ...pollCommand, options: [
    { name: 'unsafe', description: '<img src=x onerror=evil()>', type: 'string', placeholder: '" autofocus onfocus="evil()' },
    { name: 'flag', description: 'Visible flag', type: 'boolean' },
    { name: 'user', description: 'Member', type: 'user' },
  ] };
  const html = renderBotFields(commandInputFields(command), { unsafe: '<script>secret</script>' }, {
    prefix: 'command', disabled: false, members: [{ id: 'member', nickname: '<script>member</script>' }],
  });
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes('&lt;script&gt;secret&lt;/script&gt;'));
  assert.ok(html.includes('class="toggle-switch"'));
  assert.ok(html.includes('role="switch"'));
  assert.ok(html.includes('<span class="toggle-slider"></span>'));
  const store = invocationStore();
  store.receivePrompt({ ...prompt(), botName: '<script>bot</script>', form: { ...form, title: '<script>title</script>' } });
  const invocation = store.getInvocation('invoke-one');
  assert.ok(invocation);
  const card = renderBotInvocation(invocation);
  assert.equal(card.includes('<script>'), false);
  assert.ok(card.includes('invoke-one-step-one-title'));
  assert.ok(card.includes('bot-private-cue'));
  assert.ok(card.includes('data-bot-action="cancel-invocation"'));
});

test('bot errors and input validation have Portuguese and English actionable messages', () => {
  const codes = [
    ProtocolErrorCode.BOT_OFFLINE, ProtocolErrorCode.BOT_COMMAND_NOT_FOUND,
    ProtocolErrorCode.BOT_INVALID_OPTIONS, ProtocolErrorCode.BOT_INTERACTION_EXPIRED,
    ProtocolErrorCode.BOT_INTERACTION_INVALID, ProtocolErrorCode.BOT_COMMAND_BUSY,
    ProtocolErrorCode.BOT_INVALID_PROFILE,
  ];
  try {
    setLanguage('en');
    const english = codes.map((code) => translateProtocolError(code, 'Raw exception'));
    assert.ok(english.every((message) => message.length > 25 && message !== 'Raw exception'));
    assert.match(botInputError(commandInputFields(pollCommand), 'duration', 'required'), /Minutes: complete/);
    setLanguage('pt-BR');
    const portuguese = codes.map((code) => translateProtocolError(code, 'Raw exception'));
    assert.ok(portuguese.every((message, index) => message !== english[index] && message !== 'Raw exception'));
    assert.match(botInputError(commandInputFields(pollCommand), 'duration', 'required'), /Minutes: preencha/);
  } finally {
    setLanguage('pt-BR');
  }
});

test('bot photos accept supported image signatures and reject oversized, malformed or SVG input', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=';
  assert.equal(validateBotAvatar(png), null);
  assert.equal(validateBotAvatar('data:image/svg+xml;base64,PHN2Zz4='), 'type');
  assert.equal(validateBotAvatar('data:image/png;base64,AAAA'), 'type');
  assert.equal(validateBotAvatar('data:image/jpeg;base64,%%%'), 'type');
  assert.equal(validateBotAvatar(png.replace('image/png', 'image/jpeg')), 'type');
  const tooLarge = 'A'.repeat(Math.ceil((LIMITS.MAX_AVATAR_SIZE + 1) / 3) * 4);
  assert.equal(validateBotAvatar(`data:image/png;base64,${tooLarge}`), 'size');
});
