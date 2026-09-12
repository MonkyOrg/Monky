import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageType, ProtocolErrorCode, type SlashCommand } from '@monky/shared';
import { CommandAutocomplete, type AutocompleteState } from '../src/renderer/utils/commandAutocomplete';
import { commandValuesFromInputs } from '../src/renderer/utils/botInputs';
import { createChatStore } from '../src/renderer/stores/chatStore';
import { EventBus, appEvents } from '../src/renderer/core/EventBus';
import { createNetworkClient } from '../src/renderer/core/NetworkClient';
import { renderCompactCommand } from '../src/renderer/views/commandComposer';
import { translateProtocolError } from '../src/renderer/i18n/protocolErrors';

const flush = async () => { for (let count = 0; count < 6; count++) await Promise.resolve(); };

test('autocomplete preserves actionable localized settings errors', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const message = translateProtocolError(ProtocolErrorCode.BOT_SETTINGS_INVALID);
  const states: AutocompleteState[] = [];
  const controller = new CommandAutocomplete({}, async () => { throw new Error(message); }, (state) => states.push(state));
  context.after(() => controller.close());
  controller.setQuery('query');
  context.mock.timers.tick(250);
  await flush();
  assert.equal(states.at(-1)?.status, 'failed');
  assert.equal(states.at(-1)?.error, message);
  assert.deepEqual(states.at(-1)?.choices, []);
});

test('autocomplete combines 250ms debounce and 500ms throttle, including menu reconstruction', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const connection = {};
  const sent: Array<{ query: string; time: number }> = [];
  const search = async (query: string) => {
    sent.push({ query, time: Date.now() });
    return { status: 'ok', choices: [] };
  };
  let controller = new CommandAutocomplete(connection, search, () => {});
  context.after(() => controller.close());
  controller.setQuery('first');
  context.mock.timers.tick(249);
  assert.equal(sent.length, 0);
  context.mock.timers.tick(1);
  await flush();
  assert.deepEqual(sent, [{ query: 'first', time: 250 }]);
  controller.setQuery('second');
  context.mock.timers.tick(250);
  await flush();
  assert.equal(sent.length, 1, 'debounce alone must not send a second request after 250ms');
  controller.setQuery('latest');
  context.mock.timers.tick(249);
  assert.equal(sent.length, 1);
  context.mock.timers.tick(1);
  await flush();
  assert.deepEqual(sent[1], { query: 'latest', time: 750 });
  controller.close();
  controller = new CommandAutocomplete(connection, search, () => {});
  controller.setQuery('reopened');
  context.mock.timers.tick(250);
  assert.equal(sent.length, 2, 'rebuilding a view must not reset the connection budget');
  context.mock.timers.tick(250);
  await flush();
  assert.deepEqual(sent[2], { query: 'reopened', time: 1250 });
});

test('autocomplete clears stale choices immediately, ignores late successes/errors and aborts on close', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const requests = new Map<string, { signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const states: AutocompleteState[] = [];
  const controller = new CommandAutocomplete({}, (query, signal) => new Promise((resolve, reject) => {
    requests.set(query, { signal, resolve, reject });
  }), (state) => states.push(state));
  context.after(() => controller.close());
  controller.setQuery('old');
  context.mock.timers.tick(250);
  controller.setQuery('new');
  assert.equal(requests.get('old')?.signal.aborted, true);
  assert.deepEqual(states.at(-1)?.choices, []);
  context.mock.timers.tick(500);
  requests.get('new')?.resolve({ status: 'ok', choices: [{ label: 'New label', value: 'opaque-id' }] });
  await flush();
  assert.equal(states.at(-1)?.choices[0]?.value, 'opaque-id');
  requests.get('old')?.reject(new Error('late error'));
  await flush();
  assert.equal(states.at(-1)?.status, 'ready');
  controller.setQuery('closing');
  context.mock.timers.tick(500);
  controller.close();
  const count = states.length;
  requests.get('closing')?.resolve({ status: 'ok', choices: [{ label: 'Stale', value: 'stale' }] });
  await flush();
  assert.equal(requests.get('closing')?.signal.aborted, true);
  assert.equal(states.length, count);
  controller.setQuery('cancel timer');
  controller.close();
  context.mock.timers.tick(1000);
  assert.equal(requests.has('cancel timer'), false);
});

test('autocomplete respects 2..100 query characters and displays at most ten validated choices', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let calls = 0;
  let state: AutocompleteState = { status: 'idle', choices: [], query: '' };
  const controller = new CommandAutocomplete({}, async () => {
    calls++;
    return { status: 'ok', choices: Array.from({ length: 20 }, (_, index) => ({ label: `Result ${index}`, value: `opaque-${index}` })) };
  }, (next) => { state = next; });
  context.after(() => controller.close());
  controller.setQuery('x');
  context.mock.timers.tick(1000);
  assert.equal(calls, 0);
  assert.equal(state.status, 'idle');
  controller.setQuery('x'.repeat(101));
  context.mock.timers.tick(1000);
  assert.equal(calls, 0);
  assert.equal(state.status, 'failed');
  controller.setQuery('xx');
  context.mock.timers.tick(250);
  await flush();
  assert.equal(calls, 1);
  assert.equal(state.choices.length, 10);
});

test('only a selected opaque value is submitted; seeded/edited text and labels are not IDs', () => {
  const command: SlashCommand = {
    name: 'query', description: 'Find sound', botId: 'bot', botName: 'Sound bot',
    options: [{ name: 'sound', description: 'Sound', type: 'string', required: true, autocomplete: true }],
  };
  const store = createChatStore();
  store.bus = new EventBus();
  store.setCommands([command]);
  store.selectCommand('text', command, 'Search term');
  const draft = store.getCommandDraft('text');
  assert.ok(draft);
  assert.deepEqual(draft.values, {});
  assert.equal(draft.autocomplete.sound.query, 'Search term');
  assert.equal(commandValuesFromInputs(command, { sound: 'forged-id' }, [], draft.autocomplete).success, false);
  const value = `opaque:${'x'.repeat(490)}`;
  store.selectCommandChoice('text', 'sound', { value, label: '<Visible label>' });
  assert.deepEqual(commandValuesFromInputs(command, draft.values, [], draft.autocomplete), {
    success: true, values: { sound: value },
  });
  const markup = renderCompactCommand(draft, 'text', [], true, true);
  assert.ok(markup.includes('&lt;Visible label&gt;'));
  assert.ok(!markup.includes(value));
  store.setCommandQuery('text', 'sound', 'Changed');
  assert.equal(draft.autocomplete.sound.selected, undefined);
  assert.equal(draft.values.sound, undefined);
  assert.equal(commandValuesFromInputs(command, draft.values, [], draft.autocomplete).success, false);
});

test('autocomplete uses the shared audio contract and does not recover rejected metadata', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const invalid = [
    { audio: { url: 'http://audio.example/sound.wav' } },
    { audio: { url: 'https://audio.example/sound.wav', durationMs: -1 } },
    { audio: { url: 'https://audio.example/sound.wav', unknown: true } },
    { description: 123 },
  ];
  for (const metadata of invalid) {
    const states: AutocompleteState[] = [];
    const controller = new CommandAutocomplete({}, async () => ({
      status: 'ok', choices: [{ label: 'Sound', value: 'sound', ...metadata }],
    }), (state) => states.push(state));
    controller.setQuery('sound');
    context.mock.timers.tick(250);
    await flush();
    assert.equal(states.at(-1)?.status, 'failed');
    assert.deepEqual(states.at(-1)?.choices, []);
    controller.close();
  }
});

test('an empty optional autocomplete does not disable an otherwise complete command', () => {
  const command: SlashCommand = {
    name: 'choose', description: 'Choose', botId: 'bot', botName: 'Bot',
    options: [
      { name: 'title', description: 'Title', type: 'string', required: true },
      { name: 'sound', description: 'Sound', type: 'string', autocomplete: true },
    ],
  };
  const store = createChatStore();
  store.bus = new EventBus();
  store.setCommands([command]);
  store.selectCommand('text', command);
  store.setCommandValues('text', { title: 'Filled' });
  store.setCommandOptionVisible('text', 'sound', true);
  const draft = store.getCommandDraft('text');
  assert.ok(draft);
  const submit = () => renderCompactCommand(draft, 'text', [], true, true).match(/<button type="submit"[^>]*>/)?.[0] ?? '';
  store.setCommandQuery('text', 'sound', 'unselected');
  assert.ok(submit().includes('disabled'));
  store.setCommandOptionVisible('text', 'sound', false);
  assert.ok(!submit().includes('disabled'), 'A removed optional must not block submission or lose its saved query');
  store.setCommandOptionVisible('text', 'sound', true);
  assert.ok(submit().includes('disabled'));
  store.setCommandQuery('text', 'sound', '');
  assert.ok(!submit().includes('disabled'));
});

test('cancelled autocomplete requests release timers and late server errors are not global UI events', async () => {
  const client = createNetworkClient();
  client.send = () => {};
  let errors = 0;
  const unbind = appEvents.on(`message.${MessageType.SERVER_ERROR}`, () => { errors++; });
  const request = client.sendRequest(MessageType.COMMAND_AUTOCOMPLETE, {}, 'cancelled-query');
  const rejection = assert.rejects(request, { name: 'AbortError' });
  assert.equal(client.cancelRequest('cancelled-query'), true);
  assert.equal(client.cancelRequest('cancelled-query'), false);
  await rejection;
  // Exercise the actual transport entry point without opening a socket.
  const handle = Reflect.get(client, 'handleIncomingMessage');
  assert.equal(typeof handle, 'function');
  Reflect.apply(handle, client, [{ type: MessageType.SERVER_ERROR, requestId: 'cancelled-query', payload: { message: 'Late failure' } }]);
  assert.equal(errors, 0);
  unbind();
  client.dispose();
});
