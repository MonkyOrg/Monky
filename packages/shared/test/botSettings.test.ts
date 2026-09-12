import assert from 'node:assert/strict';
import {
  ADMIN_PERMISSIONS, DEFAULT_PERMISSIONS, LIMITS, Permission, hasPermission,
  botSettingsDefinitionSchema, botSettingsValuesSchema, botSettingsSummarySchema,
  botSettingsSnapshotSchema, botSettingsListResponseSchema, botServerSettingsSnapshotSchema,
  botSettingsUpdateSchema, botSelectorRespondSchema, botSelectorRespondedSchema,
  commandInvokeSchema, commandExecutionSchema, commandAutocompleteSchema,
  commandAutocompleteExecutionSchema, commandRegisterSchema, commandSubmitSchema,
  resolveBotSettingsValues,
} from '../src/index.js';

const definition = botSettingsDefinitionSchema.parse({
  server: { title: 'Behavior', fields: [
    { name: 'count', label: 'Count', type: 'integer', min: 0, max: 10, required: true, defaultValue: 2 },
  ] },
  user: { title: 'Preferences', fields: [
    { name: 'compact', label: 'Compact', type: 'boolean', defaultValue: true },
    { name: 'tags', label: 'Tags', type: 'string-list' },
  ] },
});
assert.equal(hasPermission(Permission.CONFIGURE_BOTS, Permission.MANAGE_BOTS), false);
assert.equal(hasPermission(Permission.MANAGE_BOTS, Permission.CONFIGURE_BOTS), false);
assert.equal(hasPermission(DEFAULT_PERMISSIONS, Permission.CONFIGURE_BOTS), false);
assert.equal(hasPermission(ADMIN_PERMISSIONS, Permission.CONFIGURE_BOTS), true);
assert.equal(Permission.CONFIGURE_BOTS, 1 << 15);
assert.deepEqual(resolveBotSettingsValues(definition.server, {}), { success: true, values: { count: 2 } });
assert.deepEqual(resolveBotSettingsValues(definition.server, { count: 0 }), { success: true, values: { count: 0 } });
assert.deepEqual(resolveBotSettingsValues(definition.user, { compact: false, tags: [' a ', 'b'] }),
  { success: true, values: { compact: false, tags: ['a', 'b'] } });
for (const count of ['2', false, 11, 0.5, null, '']) {
  assert.equal(resolveBotSettingsValues(definition.server, { count }).success, false);
}
assert.deepEqual(resolveBotSettingsValues(definition.user, { unknown: true }),
  { success: false, field: 'unknown', reason: 'unknown' });
assert.equal(resolveBotSettingsValues(undefined, { compact: true }).success, false);
assert.deepEqual(resolveBotSettingsValues(undefined, undefined), { success: true, values: {} });
assert.equal(resolveBotSettingsValues(definition.user, null).success, false);
assert.equal(resolveBotSettingsValues(definition.user, { tags: ['a', ' A '] }).success, false);
const optionalDefaults = botSettingsDefinitionSchema.parse({ user: {
  title: 'Optional defaults', fields: [
    { name: 'note', label: 'Note', type: 'text', defaultValue: 'Default note' },
    { name: 'tags', label: 'Tags', type: 'string-list', defaultValue: ['default'] },
  ],
} }).user;
const cleared = resolveBotSettingsValues(optionalDefaults, { note: '', tags: [] });
assert.deepEqual(cleared, { success: true, values: { note: '', tags: [] } });
assert.ok(cleared.success);
assert.deepEqual(resolveBotSettingsValues(optionalDefaults, cleared.values), cleared);
assert.equal(botSettingsValuesSchema.safeParse(JSON.parse('{"__proto__":true}')).success, false);
assert.equal(botSettingsValuesSchema.safeParse({ tags: Array(20).fill('x'.repeat(2000)) }).success, false);
assert.equal(botSettingsValuesSchema.safeParse({ tags: Array(10).fill('\u00e9'.repeat(1000)) }).success, false);
assert.equal(botSettingsDefinitionSchema.safeParse({ user: {
  title: 'Missing default', fields: [{ name: 'name', label: 'Name', type: 'text', required: true }],
} }).success, false);
assert.equal(botSettingsDefinitionSchema.safeParse({ host: { confirmFileName: false } }).success, false);
assert.equal(commandRegisterSchema.safeParse({ commands: [], settings: definition }).success, true);

const bot = {
  botId: 'bot', name: 'Bot', online: false, capabilities: { downloadsSound: true },
  schemaRevision: 1, revision: 2, hasServerSettings: true, hasUserSettings: true, canConfigure: false,
};
assert.equal(botSettingsSummarySchema.safeParse(bot).success, true);
assert.equal(botSettingsSummarySchema.safeParse({ ...bot, tokenHash: 'private' }).success, false);
assert.equal(botSettingsSummarySchema.safeParse({ ...bot, revision: -1 }).success, false);
assert.equal(botSettingsSummarySchema.safeParse({ ...bot, revision: Number.MAX_SAFE_INTEGER + 1 }).success, false);
assert.equal(botSettingsSnapshotSchema.safeParse({ bot, definition: { user: definition.user } }).success, true);
const server = { schemaRevision: 1, revision: 2, values: { count: 3 } };
assert.equal(botServerSettingsSnapshotSchema.safeParse(server).success, true);
const snapshot = { bot: { ...bot, canConfigure: true }, definition, server };
assert.equal(botSettingsSnapshotSchema.safeParse(snapshot).success, true);
assert.equal(botSettingsSnapshotSchema.safeParse({ ...snapshot, server: { ...server, revision: 3 } }).success, false);
assert.equal(botSettingsSnapshotSchema.safeParse({ ...snapshot, server: undefined }).success, false);
assert.equal(botSettingsSnapshotSchema.safeParse({ ...snapshot, server: { ...server, values: { count: '3' } } }).success, false);
assert.equal(botSettingsListResponseSchema.safeParse({ bots: [bot, bot] }).success, false);
assert.equal(botSettingsListResponseSchema.safeParse({
  bots: Array.from({ length: LIMITS.MAX_BOT_SETTINGS_CATALOG + 1 }, (_, index) => ({ ...bot, botId: `${index}` })),
}).success, false);
assert.equal(botSettingsUpdateSchema.safeParse({ botId: 'bot', schemaRevision: 1, expectedRevision: 2, patch: { count: null } }).success, true);
assert.equal(botSettingsUpdateSchema.safeParse({ botId: 'bot', schemaRevision: 1, expectedRevision: 2, patch: {}, userSettings: {} }).success, false);

const invoke = { commandName: 'run', botId: 'bot', channelId: 'channel', userSettings: { compact: false } };
assert.equal(commandInvokeSchema.safeParse(invoke).success, true);
const settings = { schemaRevision: 1, serverRevision: 2, server: { count: 3 }, user: { compact: false } };
assert.equal(commandExecutionSchema.safeParse({
  commandName: 'run', botId: 'bot', channelId: 'channel', invocationId: 'inv',
  invokerId: 'user', invokerNickname: 'User', settings,
}).success, true);
assert.equal(commandExecutionSchema.safeParse({
  ...invoke, invocationId: 'inv', invokerId: 'user', invokerNickname: 'User',
}).success, false);
assert.equal(commandAutocompleteSchema.safeParse({ ...invoke, optionName: 'query', query: '' }).success, true);
assert.equal(commandAutocompleteExecutionSchema.safeParse({
  commandName: 'run', optionName: 'query', query: '', options: {}, locale: 'en', settings,
}).success, true);
assert.equal(commandSubmitSchema.safeParse({ invocationId: 'inv', interactionId: 'form', values: {}, userSettings: {} }).success, false);
assert.equal(botSelectorRespondSchema.safeParse({ id: 'selector', value: 'a', userSettings: { compact: false } }).success, true);
assert.equal(botSelectorRespondSchema.safeParse({ id: 'selector', value: 'a', userId: 'forged' }).success, false);
assert.equal(botSelectorRespondedSchema.safeParse({ id: 'selector', channelId: 'channel', userId: 'user', value: 'a', settings }).success, true);
console.log('Bot settings schemas, defaults, permissions and wire boundaries passed.');
