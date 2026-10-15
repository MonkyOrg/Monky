import type { BotScreenBridge, BotScreenCloseReason } from '../src';

// The miniapp document's global, typed by the SDK.
declare const monkyScreen: BotScreenBridge;

let unsaved = true;
const stopAsking = monkyScreen.onBeforeClose(async ({ reason }) => {
  if (!unsaved) return;
  // Keep the miniapp open for everyone; this person can still leave it.
  if (reason === 'end') return false;
  unsaved = false;
});
const stopSaving = monkyScreen.onClose(async ({ reason }) => {
  const why: BotScreenCloseReason = reason;
  void why;
});
monkyScreen.onBeforeClose(() => true);
stopAsking();
stopSaving();

// @ts-expect-error The miniapp asks in its own UI; the answer is only whether to close.
monkyScreen.onBeforeClose(() => 'Save first?');
// @ts-expect-error Revocations never wait for onBeforeClose.
monkyScreen.onBeforeClose(({ reason }) => reason === 'revoked');
