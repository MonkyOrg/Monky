import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { SettingsStore, settingsStore } from '../src/renderer/stores/settingsStore';
import * as Dialog from '../src/renderer/views/Dialog';
import { confirmHostedServerReach } from '../src/renderer/utils/hostedServer';

/**
 * Creating a server on this computer first explains that others reach it only
 * once the network lets them in, and links the docs (#877). "Don't show again"
 * holds only for a confirmed warning, and survives a restart.
 */

type Answer = { confirmed: boolean; checked: boolean };

function fixture(context: TestContext, answer: Answer) {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const previousWarn = settingsStore.warnHostedServerReach;
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, value); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  settingsStore.warnHostedServerReach = true;
  context.after(() => {
    settingsStore.warnHostedServerReach = previousWarn;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const prompt = context.mock.method(Dialog, 'showConfirmWithOption', async () => answer);
  return { prompt };
}

test('creating a server warns with a docs link and an option to stop warning (#877)', async (context) => {
  const { prompt } = fixture(context, { confirmed: true, checked: false });
  assert.equal(await confirmHostedServerReach(), true);
  assert.equal(prompt.mock.callCount(), 1);
  const [options] = prompt.mock.calls[0].arguments;
  assert.ok(options);
  assert.match(options.link?.url ?? '', /^https:\/\/monkyorg\.github\.io\/Monky\/.*criar-seu-servidor#/);
  assert.ok(options.checkboxLabel);
  assert.equal(settingsStore.warnHostedServerReach, true, 'Confirming without the option keeps warning');
  assert.equal(await confirmHostedServerReach(), true);
  assert.equal(prompt.mock.callCount(), 2);
});

test('cancelling the warning stops the creation and keeps the warning, even with the option on (#877)', async (context) => {
  const { prompt } = fixture(context, { confirmed: false, checked: true });
  assert.equal(await confirmHostedServerReach(), false);
  assert.equal(settingsStore.warnHostedServerReach, true);
  assert.equal(await confirmHostedServerReach(), false);
  assert.equal(prompt.mock.callCount(), 2);
});

test('"don\'t show again" on a confirmed warning is saved and skips it from then on (#877)', async (context) => {
  const { prompt } = fixture(context, { confirmed: true, checked: true });
  assert.equal(await confirmHostedServerReach(), true);
  assert.equal(settingsStore.warnHostedServerReach, false);
  assert.equal(new SettingsStore().warnHostedServerReach, false, 'The choice survives a restart');
  assert.equal(await confirmHostedServerReach(), true);
  assert.equal(prompt.mock.callCount(), 1, 'No warning once dismissed');
});
