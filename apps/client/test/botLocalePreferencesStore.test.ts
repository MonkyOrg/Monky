import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { SettingsStore } from '../src/renderer/stores/settingsStore';
import { appEvents } from '../src/renderer/core/EventBus';

function fixture(context: TestContext): Storage {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() { return entries.size; },
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: key => { entries.delete(key); },
    clear: () => entries.clear(),
    key: index => [...entries.keys()][index] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  context.mock.method(console, 'warn', () => {});
  return storage;
}

test('bot locale hydration normalizes aliases independently of custom bot values and Home preferences', context => {
  const storage = fixture(context);
  storage.setItem('monky_settings', JSON.stringify({
    autoEntryServerKeys: [JSON.stringify(['home.test', 3000])],
    botUserPreferences: 'invalid custom values',
    botLocalePreferences: { first: 'EN_us.UTF-8', second: 'pt-PT' },
  }));
  const settings = new SettingsStore();
  assert.equal(settings.getBotLocalePreference('first'), 'en');
  assert.equal(settings.getBotLocalePreference('second'), 'pt-BR');
  assert.equal(settings.getBotLocalePreference('missing'), 'auto');
  assert.equal(settings.getBotLocalePreference('__proto__'), 'auto');
  assert.equal(settings.isServerAutoEntryEnabled({ host: 'home.test', port: 3000 }), true);
  assert.deepEqual(settings.botUserPreferences, {});
  settings.save();
  assert.deepEqual(new SettingsStore().botLocalePreferences, { first: 'en', second: 'pt-BR' });
});

test('malformed, oversized, missing and unreadable locale preferences reset to auto without stale overrides', context => {
  const storage = fixture(context);
  const settings = new SettingsStore();
  const oversized = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`scope-${index}`, 'en']));
  for (const value of [undefined, null, [], true, { first: 'fr' }, { first: 'auto' }, { '': 'en' }, { ['x'.repeat(2049)]: 'en' }, oversized]) {
    settings.saveBotPreferences('first', {}, undefined, 'en');
    storage.setItem('monky_settings', JSON.stringify({
      autoEntryServerKeys: [JSON.stringify(['home.test', 3000])],
      botLocalePreferences: value,
    }));
    settings.load(false);
    assert.deepEqual(settings.botLocalePreferences, {});
    assert.equal(settings.getBotLocalePreference('first'), 'auto');
    assert.equal(settings.isServerAutoEntryEnabled({ host: 'home.test', port: 3000 }), true);
  }
  settings.saveBotPreferences('first', {}, undefined, 'en');
  storage.setItem('monky_settings', '{invalid');
  settings.load(false);
  assert.equal(settings.getBotLocalePreference('first'), 'auto');
  settings.saveBotPreferences('first', {}, undefined, 'en');
  context.mock.method(storage, 'getItem', () => { throw new Error('Fixture read failure'); });
  settings.load(false);
  assert.equal(settings.getBotLocalePreference('first'), 'auto');
});

test('locale retention is bounded and locale-only changes invalidate previews without changing Home settings', context => {
  fixture(context);
  const settings = new SettingsStore();
  const home = { host: 'home.test', port: 3000 };
  settings.setServerAutoEntry(home, true);
  for (let index = 0; index < 257; index++) {
    settings.saveBotPreferences(`scope-${index}`, {}, undefined, index % 2 ? 'en' : 'pt-BR');
  }
  assert.equal(Object.keys(settings.botLocalePreferences).length, 256);
  assert.equal(settings.getBotLocalePreference('scope-0'), 'auto');
  assert.equal(settings.getBotLocalePreference('scope-256'), 'pt-BR');
  const changes: boolean[] = [];
  context.after(appEvents.on('bot.preferences_updated', (event: { customChanged: boolean }) => changes.push(event.customChanged)));
  settings.saveBotPreferences('scope-256', {}, undefined, 'pt-BR');
  settings.saveBotPreferences('scope-256', {}, undefined, 'en');
  settings.saveBotPreferences('scope-256', {});
  settings.saveBotPreferences('scope-256', {}, undefined, 'auto');
  assert.deepEqual(changes, [false, true, false, true]);
  assert.equal(Object.hasOwn(settings.botLocalePreferences, 'scope-256'), false);
  assert.equal(settings.isServerAutoEntryEnabled(home), true);
  assert.throws(() => Reflect.apply(settings.saveBotPreferences, settings, ['bad-locale', {}, undefined, 'fr']), /Invalid individual bot language/);
  assert.deepEqual(changes, [false, true, false, true]);
});
