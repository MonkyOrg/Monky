import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { presentServerShutdownNotice } from '../src/renderer/core/serverShutdownNotice';
import { sessionManager } from '../src/renderer/core/SessionManager';
import { t } from '../src/renderer/i18n';
import { voiceStore } from '../src/renderer/stores/voiceStore';
import * as CopyToast from '../src/renderer/views/CopyToast';
import * as Dialog from '../src/renderer/views/Dialog';

type AlertOptions = Parameters<typeof Dialog.showAlert>[0];

function fixture(context: TestContext) {
  const alerts: AlertOptions[] = [];
  const toasts: Array<{ message: string; durationMs?: number }> = [];
  context.mock.method(Dialog, 'showAlert', async (options: AlertOptions) => { alerts.push(options); });
  context.mock.method(CopyToast, 'showInfoToast', (message: string, durationMs?: number) => {
    toasts.push({ message, durationMs });
    return () => {};
  });
  const onScreen = sessionManager.create('on-screen.test', 7001, 'Fixture');
  const call = sessionManager.create('call.test', 7002, 'Fixture');
  const background = sessionManager.create('background.test', 7003, 'Fixture');
  sessionManager.activate(onScreen.key);
  const previousCall = voiceStore.voiceSessionKey;
  voiceStore.voiceSessionKey = call.key;
  context.after(() => {
    voiceStore.voiceSessionKey = previousCall;
    for (const session of [background, call, onScreen]) sessionManager.remove(session.key);
  });
  return { alerts, toasts, onScreen, call, background };
}

test('a background server that restarts only gets a toast naming it', (context) => {
  const { alerts, toasts, background } = fixture(context);
  presentServerShutdownNotice({ reasonCode: 'stopped', serverName: 'Quiet server', sessionKey: background.key });
  presentServerShutdownNotice({ reasonCode: 'update', serverName: 'Quiet server', sessionKey: background.key });
  assert.equal(alerts.length, 0, 'a server the user is not using must not open a modal');
  assert.deepEqual(toasts.map(toast => toast.message), [
    t('app.serverClosedToast', { server: 'Quiet server' }),
    t('app.serverUpdatingToast', { server: 'Quiet server' }),
  ]);
  assert.ok(toasts.every(toast => (toast.durationMs ?? 0) >= 5000), 'the toast stays long enough to be read');
});

test('the server on screen and the one hosting the call get a modal when closed for good', (context) => {
  const { alerts, toasts, onScreen, call } = fixture(context);
  presentServerShutdownNotice({ reasonCode: 'stopped', serverName: 'Open server', sessionKey: onScreen.key });
  presentServerShutdownNotice({ reasonCode: 'stopped', serverName: 'Call server', sessionKey: call.key });
  assert.equal(toasts.length, 0);
  assert.deepEqual(alerts.map(alert => [alert.title, alert.message]), [
    [t('app.serverShutdownTitle'), t('app.serverShutdownMessage')],
    [t('app.serverShutdownTitle'), t('app.serverShutdownMessage')],
  ]);
});

test('an update restart is a toast even for the server on screen and the one hosting the call', (context) => {
  const { alerts, toasts, onScreen, call } = fixture(context);
  presentServerShutdownNotice({ reasonCode: 'update', serverName: 'Open server', sessionKey: onScreen.key });
  presentServerShutdownNotice({ reasonCode: 'update', serverName: 'Call server', sessionKey: call.key });
  assert.equal(alerts.length, 0);
  assert.deepEqual(toasts.map(toast => toast.message), [
    t('app.serverUpdatingToast', { server: 'Open server' }),
    t('app.serverUpdatingToast', { server: 'Call server' }),
  ]);
});

test('Home shows no server, so only the call keeps a modal there', (context) => {
  const { alerts, toasts, onScreen, call } = fixture(context);
  sessionManager.showHome();
  assert.equal(sessionManager.getActiveKey(), onScreen.key, 'the last server stays active behind Home');
  presentServerShutdownNotice({ reasonCode: 'stopped', serverName: 'Behind Home', sessionKey: onScreen.key });
  presentServerShutdownNotice({ reasonCode: 'stopped', serverName: 'Call server', sessionKey: call.key });
  assert.deepEqual(toasts.map(toast => toast.message), [t('app.serverClosedToast', { server: 'Behind Home' })]);
  assert.equal(alerts.length, 1);
});

test('a notice the app raises itself, without a session, keeps its modal and reason', (context) => {
  const { alerts, toasts } = fixture(context);
  presentServerShutdownNotice({ reason: t('app.kickedFromServerMessage') });
  assert.equal(toasts.length, 0);
  assert.equal(alerts[0]?.message, t('app.kickedFromServerMessage'));
});
