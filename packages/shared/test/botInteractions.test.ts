import assert from 'node:assert/strict';
import {
  botFormSchema,
  botManifestSchema,
  commandDefinitionSchema,
  commandInvokeSchema,
  botProfileUpdateSchema,
  commandRegisterSchema,
  commandSubmitSchema,
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

assert.equal(commandDefinitionSchema.safeParse({ name: '8ball', description: 'Question' }).success, true);
assert.equal(commandRegisterSchema.safeParse({
  commands: [{ name: 'ping', description: 'Ping' }, { name: 'ping', description: 'Other' }],
}).success, false);
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

console.log('Bot interaction schemas and typed options passed.');
