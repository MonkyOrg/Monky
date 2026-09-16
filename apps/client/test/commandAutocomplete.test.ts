import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, MessageType, ProtocolErrorCode, type SlashCommand } from '@monky/shared';
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
  assert.equal(requests.get('new')?.signal.aborted, false, 'Completed results retain a cancellable choice context');
  requests.get('old')?.reject(new Error('late error'));
  await flush();
  assert.equal(states.at(-1)?.status, 'ready');
  controller.setQuery('closing');
  assert.equal(requests.get('new')?.signal.aborted, true, 'Changing a finished query invalidates its lazy preview authority');
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

test('autocomplete respects the shared query limit and displays every validated choice', async (context) => {
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
  controller.setQuery('x'.repeat(LIMITS.MAX_BOT_AUTOCOMPLETE_QUERY_LENGTH + 1));
  context.mock.timers.tick(1000);
  assert.equal(calls, 0);
  assert.equal(state.status, 'failed');
  controller.setQuery('x'.repeat(LIMITS.MAX_BOT_AUTOCOMPLETE_QUERY_LENGTH));
  context.mock.timers.tick(250);
  await flush();
  assert.equal(calls, 1);
  assert.equal(state.choices.length, 20);
});

test('autocomplete appends unlimited pages on demand, deduplicates values and preserves page authorities', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const sent: Array<{ page: number; cursor?: string; signal: AbortSignal }> = [];
  const states: AutocompleteState[] = [];
  const choices = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({
    label: `Sound ${start + index}`, value: `sound-${start + index}`,
  }));
  const controller = new CommandAutocomplete({}, async (_query, signal, page, cursor) => {
    sent.push({ page, cursor, signal });
    return {
      status: 'ok',
      choices: page === 0 ? choices(0, 20) : page === 1 ? choices(19, 20) : page === 2 ? choices(39, 20) : choices(59, 6),
      hasMore: page < 3, ...(page < 3 ? { nextCursor: `cursor-${page + 1}` } : {}),
    };
  }, (state) => states.push(state));
  context.after(() => controller.close());
  controller.setQuery('sound');
  context.mock.timers.tick(250);
  await flush();
  assert.equal(states.at(-1)?.choices.length, 20);
  const first = states.at(-1)?.choices[0];
  assert.equal(sent.length, 1, 'A continuation must not prefetch without scrolling or explicit loadMore');
  controller.loadMore();
  controller.loadMore();
  controller.loadMore();
  assert.equal(states.at(-1)?.loadingMore, true);
  assert.equal(states.at(-1)?.choices.length, 20);
  context.mock.timers.tick(499);
  assert.equal(sent.length, 1, 'Pagination shares the connection throttle');
  context.mock.timers.tick(1);
  await flush();
  assert.equal(sent.length, 2, 'Repeated scroll events must share one pending page');
  assert.equal(sent[1].page, 1);
  assert.equal(sent[1].cursor, 'cursor-1');
  assert.equal(sent[0].signal, sent[1].signal);
  assert.equal(sent[0].signal.aborted, false, 'Earlier lazy previews stay authorized while more results load');
  assert.equal(states.at(-1)?.choices.length, 39);
  assert.equal(states.at(-1)?.choices[0], first, 'Appending must retain the existing choice objects');
  for (let page = 2; page <= 3; page++) {
    controller.loadMore();
    context.mock.timers.tick(500);
    await flush();
    assert.equal(sent.at(-1)?.page, page);
    assert.equal(sent.at(-1)?.cursor, `cursor-${page}`);
  }
  assert.equal(states.at(-1)?.choices.length, 65, 'No accumulated 10/20/25-item cap is allowed');
  assert.deepEqual(states.at(-1)?.choices, choices(0, 65));
  assert.equal(states.at(-1)?.hasMore, false);
  controller.loadMore();
  context.mock.timers.tick(1000);
  await flush();
  assert.equal(sent.length, 4, 'The final page must stop loading');
  controller.close();
  assert.ok(sent.every((request) => request.signal.aborted), 'Closing invalidates the entire search, not just its last page');
});

test('pagination failures preserve choices and retry the same page and cursor', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const requests: Array<{ page: number; cursor?: string }> = [];
  const states: AutocompleteState[] = [];
  let fail = true;
  const controller = new CommandAutocomplete({}, async (_query, _signal, page, cursor) => {
    requests.push({ page, cursor });
    if (page === 0) return { status: 'ok', choices: [{ label: 'First', value: 'first' }], hasMore: true, nextCursor: 'next' };
    if (fail) throw new Error('Localized provider error');
    return { status: 'ok', choices: [{ label: 'Later', value: 'later' }], hasMore: false };
  }, (state) => states.push(state));
  context.after(() => controller.close());
  controller.setQuery('sound');
  context.mock.timers.tick(250);
  await flush();
  controller.loadMore();
  context.mock.timers.tick(500);
  await flush();
  assert.equal(states.at(-1)?.status, 'ready');
  assert.equal(states.at(-1)?.loadMoreFailed, true);
  assert.equal(states.at(-1)?.error, 'Localized provider error');
  assert.equal(states.at(-1)?.choices[0].value, 'first');
  assert.equal(states.at(-1)?.hasMore, true);
  context.mock.timers.tick(10_000);
  assert.equal(requests.length, 2, 'Failures must not trigger an automatic retry loop');
  fail = false;
  controller.loadMore();
  context.mock.timers.tick(0);
  await flush();
  assert.deepEqual(requests.slice(1), [{ page: 1, cursor: 'next' }, { page: 1, cursor: 'next' }]);
  assert.deepEqual(states.at(-1)?.choices.map((choice) => choice.value), ['first', 'later']);
  assert.equal(states.at(-1)?.loadMoreFailed, undefined);
});

test('changing a query cancels a pending page and ignores its late continuation', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const requests: Array<{ query: string; page: number; signal: AbortSignal; resolve: (value: unknown) => void }> = [];
  const states: AutocompleteState[] = [];
  const controller = new CommandAutocomplete({}, (query, signal, page) => new Promise((resolve) => {
    requests.push({ query, signal, page, resolve });
  }), (state) => states.push(state));
  context.after(() => controller.close());
  controller.setQuery('original');
  context.mock.timers.tick(250);
  requests[0].resolve({ status: 'ok', choices: [{ label: 'Original', value: 'original' }], hasMore: true });
  await flush();
  controller.loadMore();
  context.mock.timers.tick(500);
  controller.setQuery('replacement');
  assert.equal(requests[1].signal.aborted, true);
  assert.deepEqual(states.at(-1)?.choices, []);
  requests[1].resolve({ status: 'ok', choices: [{ label: 'Late', value: 'late' }], hasMore: true });
  await flush();
  assert.equal(states.at(-1)?.query, 'replacement');
  assert.deepEqual(states.at(-1)?.choices, []);
  context.mock.timers.tick(500);
  assert.equal(requests[2].page, 0);
  requests[2].resolve({ status: 'ok', choices: [{ label: 'Replacement', value: 'replacement' }] });
  await flush();
  controller.loadMore();
  context.mock.timers.tick(1000);
  assert.equal(requests.length, 3, 'Legacy array-style responses have no continuation');
});

test('empty terminal pages preserve loaded results while repeated cursors fail visibly', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let result: unknown = { status: 'ok', choices: [{ label: 'First', value: 'first' }], hasMore: true, nextCursor: 'next' };
  const states: AutocompleteState[] = [];
  const controller = new CommandAutocomplete({}, async () => result, (state) => states.push(state));
  context.after(() => controller.close());
  controller.setQuery('query');
  context.mock.timers.tick(250);
  await flush();
  controller.loadMore();
  context.mock.timers.tick(500);
  await flush();
  assert.equal(states.at(-1)?.loadMoreFailed, true, 'A source returning the same continuation must not loop forever');
  assert.equal(states.at(-1)?.choices.length, 1);
  result = { status: 'ok', choices: [], hasMore: false };
  controller.loadMore();
  context.mock.timers.tick(500);
  await flush();
  assert.equal(states.at(-1)?.status, 'ready');
  assert.equal(states.at(-1)?.choices.length, 1);
  assert.equal(states.at(-1)?.hasMore, false);
});

test('autocomplete preserves full YouTube URLs longer than the old 100-character input limit', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const query = `https://www.youtube.com/watch?feature=${'x'.repeat(110)}&v=abcdefghijk`;
  assert.ok(query.length > 100 && query.length <= LIMITS.MAX_BOT_AUTOCOMPLETE_QUERY_LENGTH);
  const sent: string[] = [];
  const controller = new CommandAutocomplete({}, async (value) => {
    sent.push(value);
    return { status: 'ok', choices: [] };
  }, () => {});
  context.after(() => controller.close());
  controller.setQuery(query);
  context.mock.timers.tick(LIMITS.BOT_AUTOCOMPLETE_DEBOUNCE_MS);
  await flush();
  assert.deepEqual(sent, [query]);
  const command: SlashCommand = {
    name: 'play', description: 'Play', botId: 'bot', botName: 'Bot',
    options: [{ name: 'busca', description: 'Search', type: 'string', required: true, autocomplete: true }],
  };
  const store = createChatStore();
  store.bus = new EventBus();
  store.selectCommand('text', command, query);
  const draft = store.getCommandDraft('text');
  assert.ok(draft);
  const markup = renderCompactCommand(draft, 'text', [], true, true);
  assert.ok(markup.includes(`maxlength="${LIMITS.MAX_BOT_AUTOCOMPLETE_QUERY_LENGTH}"`));
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

test('localized command chips preserve selected autocomplete IDs and wire option names across locale changes', () => {
  const command: SlashCommand = {
    name: 'play', description: 'Search', botId: 'music', botName: 'Music',
    options: [{ name: 'track', description: 'Track', type: 'string', required: true, autocomplete: true }],
    localizations: {
      'pt-BR': { name: 'tocar', aliases: ['musica'], options: { track: { label: 'Música' } } },
      en: { name: 'listen', options: { track: { label: 'Track' } } },
    },
  };
  const store = createChatStore();
  store.bus = new EventBus();
  store.setCommands([command]);
  store.selectCommand('chat', command, 'Untranslated query');
  store.selectCommandChoice('chat', 'track', { label: 'Selected song title', value: 'opaque:original-id' });
  const draft = store.getCommandDraft('chat');
  assert.ok(draft);
  const original = structuredClone(draft);
  for (const locale of ['pt-BR', 'en'] as const) {
    const markup = renderCompactCommand(draft, 'chat', [], true, true, undefined, locale);
    assert.ok(markup.includes(`<strong>/${locale === 'en' ? 'listen' : 'tocar'}</strong>`));
    assert.match(markup, /data-command-name="play"/);
    assert.match(markup, /data-bot-autocomplete="track"/);
    assert.ok(markup.includes('value="Selected song title"'));
    assert.deepEqual(commandValuesFromInputs(command, draft.values, [], draft.autocomplete), {
      success: true, values: { track: 'opaque:original-id' },
    });
  }
  assert.deepEqual(draft, original);
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

test('timed out lazy preview requests retire late replies and errors', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const client = createNetworkClient();
  client.send = () => {};
  let events = 0;
  const unbind = [
    appEvents.on(`message.${MessageType.SERVER_ERROR}`, () => { events++; }),
    appEvents.on(`message.${MessageType.COMMAND_AUDIO_PREVIEW_RESULT}`, () => { events++; }),
  ];
  context.after(() => { unbind.forEach((off) => off()); client.dispose(); });
  const request = client.sendRequest<unknown>(MessageType.COMMAND_AUDIO_PREVIEW, {}, 'expired-preview', 30_000);
  const rejection = assert.rejects(request);
  context.mock.timers.tick(30_000);
  await rejection;
  const handle = Reflect.get(client, 'handleIncomingMessage');
  assert.equal(typeof handle, 'function');
  for (const type of [MessageType.SERVER_ERROR, MessageType.COMMAND_AUDIO_PREVIEW_RESULT]) {
    Reflect.apply(handle, client, [{ type, requestId: 'expired-preview', payload: { status: 'failed', reason: 'timeout' } }]);
  }
  assert.equal(events, 0);
});
