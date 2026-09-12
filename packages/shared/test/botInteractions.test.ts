import assert from 'node:assert/strict';
import { botSelectorCreateSchema, botSelectorPublicSchema, botSelectorSchema } from '../src/botSelectors.js';
import {
  botFormSchema,
  botManifestSchema,
  commandDefinitionSchema,
  commandInvokeSchema,
  botProfileUpdateSchema,
  commandRegisterSchema,
  commandSubmitSchema,
  commandAutocompleteSchema,
  commandAutocompleteExecutionSchema,
  commandAutocompleteResultSchema,
  commandAutocompleteCancelSchema,
  commandRequestIdSchema,
  commandSoundDownloadSchema,
  commandSoundDownloadReceivedSchema,
  commandSoundDownloadResultSchema,
  audioPreviewSourceSchema,
  soundDownloadRequestSchema,
  soundDownloadResultSchema,
  LIMITS,
  validateBotFormValues,
  validateCommandOptions,
} from '../src/index.js';

const fields = botFormSchema.parse({
  title: 'Poll',
  fields: [
    { name: 'question', label: 'Question', type: 'text', required: true, maxLength: 100 },
    { name: 'options', label: 'Options', type: 'string-list', required: true, minItems: 2, maxItems: 5 },
    { name: 'visibility', label: 'Visibility', type: 'select', choices: [{ label: 'Private', value: 'private' }] },
    { name: 'enabled', label: 'Enabled', type: 'boolean' },
    { name: 'count', label: 'Count', type: 'integer', min: 2, max: 100 },
  ],
});

const preview = { url: 'https://cdn.example.test/audio.mp3', fileName: 'audio.mp3', durationMs: 1500 };

const selector = {
  id: 'selector', channelId: 'channel', title: 'Pick one', choices: [{
    label: 'A', value: 'a', description: 'Audio-enabled option', audio: preview,
  }],
  presentation: 'buttons', responder: 'any', allowChange: true, maxResponders: 10,
};
assert.equal(botSelectorCreateSchema.safeParse(selector).success, true);
assert.equal(botSelectorCreateSchema.safeParse({ ...selector, maxResponders: undefined }).success, false);
assert.equal(botSelectorCreateSchema.safeParse({ ...selector, maxResponders: 10001 }).success, false);
assert.equal(botSelectorCreateSchema.safeParse({ ...selector, responder: 'invoker' }).success, false);
assert.equal(botSelectorCreateSchema.safeParse({ ...selector, responder: 'invoker', invocationId: 'active-invocation' }).success, true);
assert.equal(botSelectorCreateSchema.safeParse({ ...selector, creatorUserId: 'forged-authority' }).success, false);
assert.equal(botSelectorCreateSchema.safeParse({ ...selector, sourceInvocationId: 'forged-authority' }).success, false);
assert.equal(botSelectorCreateSchema.safeParse({ ...selector, choices: [selector.choices[0], selector.choices[0]] }).success, false);
const snapshot = {
  ...selector, botId: 'bot', messageId: 'message', createdAt: 1, closedAt: null, responses: { alice: 'a' }, resultMessageId: null,
};
assert.equal(botSelectorSchema.safeParse(snapshot).success, true);
assert.equal(botSelectorPublicSchema.safeParse({
  ...snapshot, responses: undefined, counts: { a: 1 }, responseCount: 1, canRespond: true,
}).success, false, 'Public payloads must not carry private response maps.');
const { responses: _responses, ...publicSelector } = snapshot;
assert.deepEqual(botSelectorPublicSchema.parse({
  ...publicSelector, counts: { a: 1 }, responseCount: 1, canRespond: true,
}).choices[0].audio, preview);

assert.equal(commandDefinitionSchema.safeParse({ name: '8ball', description: 'Question' }).success, true);
assert.deepEqual(audioPreviewSourceSchema.parse(preview), preview);
for (const badAudio of [
  { ...preview, url: 'http://cdn.example.test/audio.mp3' },
  { ...preview, url: 'https://user@cdn.example.test/audio.mp3' },
  { ...preview, url: 'https://cdn.example.test:8443/audio.mp3' },
  { ...preview, url: 'https://cdn.example.test/audio.mp3#fragment' },
  { ...preview, url: `https://cdn.example.test/${'x'.repeat(2049)}.mp3` },
  { ...preview, fileName: '../audio.mp3' },
  { ...preview, fileName: 'audio.exe' },
  { ...preview, durationMs: 0 },
  { ...preview, durationMs: 60 * 60 * 1000 + 1 },
]) {
  assert.equal(audioPreviewSourceSchema.safeParse(badAudio).success, false);
}
assert.equal(commandRegisterSchema.safeParse({
  commands: [{ name: 'ping', description: 'Ping' }, { name: 'ping', description: 'Other' }],
}).success, false);
assert.deepEqual(commandDefinitionSchema.parse({
  name: 'sound', description: 'Sound',
  options: [{
    name: 'choice', description: 'Choice', type: 'string',
    choices: [{ label: 'Effect', value: 'effect', description: 'Short effect', audio: preview }],
  }],
}).options?.[0].choices?.[0].audio, preview);
assert.equal(commandDefinitionSchema.safeParse({
  name: 'poll', description: 'Poll',
  options: [{ name: 'constructor', description: 'Unsafe name', type: 'string' }],
}).success, false);
assert.equal(commandInvokeSchema.safeParse({
  commandName: 'dice', botId: 'bot', channelId: 'chat', args: [{ name: 'input', value: '20' }],
}).success, false, 'Legacy unnamed args must not silently disappear.');
assert.equal(commandInvokeSchema.safeParse({
  commandName: 'dice', botId: 'bot', channelId: 'chat', options: { sides: 20 }, locale: 'en',
}).success, true);
assert.equal(commandDefinitionSchema.safeParse({
  name: 'dice', description: 'Dice',
  options: [{ name: 'sides', description: 'Sides', type: 'integer', min: 100, max: 2 }],
}).success, false);

const options = [
  { name: 'question', description: 'Question', type: 'string' as const, required: true },
  { name: 'sides', description: 'Sides', type: 'integer' as const, min: 2, max: 100 },
  { name: 'enabled', description: 'Enabled', type: 'boolean' as const },
];
assert.deepEqual(validateCommandOptions(options, { question: 'Text with spaces', sides: 20, enabled: false }), {
  success: true, values: { question: 'Text with spaces', sides: 20, enabled: false },
});
assert.equal(validateCommandOptions(options, { sides: 20 }).success, false);
assert.equal(validateCommandOptions(options, { question: 'Question', sides: '20' }).success, false);
assert.equal(validateCommandOptions(options, { question: 'Question', sides: 101 }).success, false);
assert.equal(validateCommandOptions(options, { question: 'Question', enabled: 'false' }).success, false);
assert.equal(validateCommandOptions(options, { question: 'Question', injected: true }).success, false);

assert.deepEqual(validateBotFormValues(fields, {
  question: 'What shall we play?', options: ['Game A', 'Game B'], visibility: 'private', enabled: false, count: 2,
}), {
  success: true,
  values: { question: 'What shall we play?', options: ['Game A', 'Game B'], visibility: 'private', enabled: false, count: 2 },
});
for (const badValues of [
  { question: 'Question', options: ['Only one'] },
  { question: 'Question', options: ['Same', ' same '] },
  { question: 'Question', options: ['First', ''] },
  { question: 'Question', options: ['First', 'Second'], visibility: 'public' },
  { question: 'Question', options: ['First', 'Second'], count: 2.5 },
  { question: 'Question', options: ['First', 'Second'], extra: 'unexpected' },
  { question: '', options: ['First', 'Second'] },
]) assert.equal(validateBotFormValues(fields, badValues).success, false);
assert.equal(botFormSchema.safeParse({
  title: 'Bad form', fields: [{ name: 'text', label: 'Text', type: 'text', minLength: 10, maxLength: 5 }],
}).success, false);
assert.equal(botFormSchema.safeParse({
  title: 'Bad form', fields: [
    { name: 'text', label: 'Text', type: 'text' },
    { name: 'text', label: 'Text', type: 'text' },
  ],
}).success, false);
assert.equal(botFormSchema.safeParse({
  title: 'Empty form', fields: [
    { name: 'question', label: 'Question', type: 'text', required: true, defaultValue: '' },
    { name: 'options', label: 'Options', type: 'string-list', required: true, minItems: 2, defaultValue: [] },
  ],
}).success, true, 'Empty defaults can be filled by the caller.');
assert.equal(validateBotFormValues({
  title: 'Required',
  fields: [{ name: 'text', label: 'Text', type: 'text', required: true, minLength: 0 }],
}, { text: '  ' }).success, false);
assert.equal(botFormSchema.safeParse({
  title: 'Bad form', fields: [
    { name: 'select', label: 'Select', type: 'select', choices: [{ label: 'One', value: 'one' }], defaultValue: 'two' },
  ],
}).success, false);
assert.equal(commandSubmitSchema.safeParse({
  invocationId: 'inv', interactionId: 'form', values: JSON.parse('{"constructor": "evil"}'),
}).success, false);
assert.equal(botManifestSchema.safeParse({ name: 'Bot', registrationUrl: 'not a URL' }).success, false);
assert.equal(botManifestSchema.safeParse({ name: 'Bot', registrationUrl: 'file:///tmp/bot' }).success, false);
assert.equal(botManifestSchema.safeParse({ name: 'Bot', registrationUrl: 'http://user:pass@host/register' }).success, false);
assert.equal(botManifestSchema.safeParse({ name: 'Bot', registrationUrl: 'http://localhost:7780/register' }).success, true);
assert.equal(botProfileUpdateSchema.safeParse({ avatarBase64: null }).success, true);

for (const presentation of ['dropdown', 'buttons']) {
  const selector = botFormSchema.parse({
    title: 'Choose',
    fields: [{
      name: 'choice', label: 'Choice', type: 'select', required: true, presentation,
      choices: [{ label: 'First', value: 'first', description: 'Preview', audio: preview }, { label: 'Second', value: 'second' }],
    }],
  });
  const firstField = selector.fields[0];
  assert.equal(firstField.type, 'select');
  assert.deepEqual(firstField.choices[0].audio, preview);
  assert.deepEqual(validateBotFormValues(selector, { choice: 'second' }), {
    success: true, values: { choice: 'second' },
  });
  assert.equal(validateBotFormValues(selector, { choice: 'forged' }).success, false);
  assert.equal(validateBotFormValues(selector, {}).success, false);
}
assert.equal(botFormSchema.safeParse({
  title: 'Choose', fields: [{
    name: 'choice', label: 'Choice', type: 'select', presentation: 'arbitrary-html',
    choices: [{ label: 'First', value: 'first' }],
  }],
}).success, false);

console.log('Bot interaction schemas and typed options passed.');

const autocompleteCommand = {
  name: 'search', description: 'Search audio', downloadsSound: true,
  options: [{ name: 'sound', description: 'Sound', type: 'string', autocomplete: true, required: true }],
};
assert.equal(commandDefinitionSchema.safeParse(autocompleteCommand).success, true);
for (const option of [
  { name: 'sound', description: 'Sound', type: 'integer', autocomplete: true },
  { name: 'sound', description: 'Sound', type: 'string', autocomplete: true, choices: [{ label: 'One', value: 'one' }] },
]) {
  assert.equal(commandDefinitionSchema.safeParse({ ...autocompleteCommand, options: [option] }).success, false);
}
assert.deepEqual(validateCommandOptions(options, { sides: 20, enabled: false }, { partial: true }), {
  success: true, values: { sides: 20, enabled: false },
});
assert.equal(validateCommandOptions(options, { sides: '20' }, { partial: true }).success, false);
assert.equal(validateCommandOptions(options, { sides: 101 }, { partial: true }).success, false);
assert.equal(validateCommandOptions(options, { unknown: true }, { partial: true }).success, false);
assert.equal(validateCommandOptions(options, {}).success, false, 'Partial validation must remain opt-in.');

const autocomplete = {
  botId: 'bot', commandName: 'search', channelId: 'chat', optionName: 'sound',
  query: 'hello', options: { enabled: false, sides: 0 }, locale: 'en',
};
assert.equal(commandAutocompleteSchema.safeParse(autocomplete).success, true);
assert.equal(commandAutocompleteSchema.safeParse({ ...autocomplete, query: 'x'.repeat(201) }).success, false);
assert.equal(commandAutocompleteSchema.safeParse({ ...autocomplete, invocationId: 'forged' }).success, false);
assert.equal(commandAutocompleteSchema.safeParse({ ...autocomplete, options: JSON.parse('{"__proto__": true}') }).success, false);
assert.equal(commandAutocompleteExecutionSchema.safeParse({
  commandName: 'search', optionName: 'sound', query: '', options: {}, locale: 'pt-BR',
}).success, true);
assert.equal(commandRequestIdSchema.safeParse('').success, false);
assert.equal(commandRequestIdSchema.safeParse('x'.repeat(129)).success, false);
assert.equal(commandAutocompleteCancelSchema.safeParse({ requestId: 'query', userId: 'forged' }).success, false);
const longChoice = { label: 'Long identifier', value: `/instant/${'a'.repeat(503)}`, description: 'Description' };
assert.equal(commandAutocompleteResultSchema.safeParse({ status: 'ok', choices: [longChoice] }).success, true);
const previewAutocompleteResult = commandAutocompleteResultSchema.parse({
  status: 'ok',
  choices: [{ ...longChoice, audio: preview }],
});
assert.equal(previewAutocompleteResult.status, 'ok');
assert.deepEqual(previewAutocompleteResult.choices[0].audio, preview);
assert.equal(commandAutocompleteResultSchema.safeParse({ status: 'ok', choices: [] }).success, true);
assert.equal(commandAutocompleteResultSchema.safeParse({ status: 'ok', choices: [longChoice, longChoice] }).success, false);
assert.equal(commandAutocompleteResultSchema.safeParse({
  status: 'ok', choices: Array.from({ length: 21 }, (_, i) => ({ label: `Choice ${i}`, value: `${i}` })),
}).success, false);
assert.equal(commandAutocompleteResultSchema.safeParse({
  status: 'ok', choices: [{ label: 'Too long', value: 'x'.repeat(LIMITS.MAX_MESSAGE_LENGTH + 1) }],
}).success, false);
assert.equal(commandAutocompleteResultSchema.safeParse({
  status: 'ok', choices: [{ label: 'Empty value', value: '  ' }],
}).success, false);
assert.equal(commandAutocompleteResultSchema.safeParse({ status: 'failed', reason: 'timeout' }).success, true);
assert.equal(commandAutocompleteResultSchema.safeParse({ status: 'failed', reason: 'internal detail' }).success, false);
assert.equal(commandInvokeSchema.safeParse({
  commandName: 'search', botId: 'bot', channelId: 'chat', allowSoundDownload: true,
}).success, true);
assert.equal(commandInvokeSchema.safeParse({
  commandName: 'search', botId: 'bot', channelId: 'chat', allowSoundDownload: 'true',
}).success, false);

const sound = { url: 'https://example.com/sound.mp3', fileName: 'sound.mp3', title: 'Sound' };
assert.equal(LIMITS.MAX_SOUNDBOARD_FILE_SIZE, 3 * 1024 * 1024);
assert.equal(soundDownloadRequestSchema.safeParse(sound).success, true);
for (const fileName of ['../escape.mp3', '..\\escape.mp3', 'C:\\escape.mp3', 'CON.mp3', 'CON .mp3', 'COM¹.mp3', 'LPT².mp3', '.hidden.mp3', 'sound.mp3 ', 'sound.mp3:stream', 'sound.exe']) {
  assert.equal(soundDownloadRequestSchema.safeParse({ ...sound, fileName }).success, false, fileName);
}
for (const url of ['http://example.com/sound.mp3', 'file:///sound.mp3', 'https://user:password@example.com/sound.mp3', 'https://example.com/sound.mp3#fragment']) {
  assert.equal(soundDownloadRequestSchema.safeParse({ ...sound, url }).success, false);
}
assert.equal(commandSoundDownloadSchema.safeParse({ ...sound, invocationId: 'invocation' }).success, true);
for (const extra of [{ userId: 'victim' }, { channelId: 'other-channel' }, { downloadId: 'forged' }, { folderPath: 'C:\\Other' }]) {
  assert.equal(commandSoundDownloadSchema.safeParse({ ...sound, invocationId: 'invocation', ...extra }).success, false);
}
const receivedSound = {
  ...sound, invocationId: 'invocation', downloadId: 'download', channelId: 'chat',
  botId: 'bot', botName: 'Bot', commandName: 'search', invokerId: 'caller', invokerNickname: 'Caller',
  createdAt: 1, expiresAt: 2,
};
assert.equal(commandSoundDownloadReceivedSchema.safeParse(receivedSound).success, true);
assert.equal(commandSoundDownloadReceivedSchema.safeParse({ ...receivedSound, expiresAt: 0 }).success, false);
for (const result of [
  { status: 'downloaded' }, { status: 'exists' }, { status: 'cancelled' },
  { status: 'failed', reason: 'too_large' }, { status: 'failed', reason: 'no_folder' },
]) {
  assert.equal(soundDownloadResultSchema.safeParse(result).success, true);
  assert.equal(commandSoundDownloadResultSchema.safeParse({
    invocationId: 'invocation', downloadId: 'download', result,
  }).success, true);
}
for (const result of [
  { status: 'downloaded', filePath: 'C:\\Private\\sound.mp3' },
  { status: 'downloaded', bytes: 1000 },
  { status: 'failed', reason: 'raw local error' },
  { status: 'failed' }, { status: 'cancelled', reason: 'unknown' },
]) assert.equal(soundDownloadResultSchema.safeParse(result).success, false);

console.log('Autocomplete and local sound download contracts passed.');
