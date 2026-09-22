'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, deferred, flush, MONITOR_SOURCE_ID } = require('./fixtures/screenSharingUiModel.cjs');

const key = (element, value, modifiers = {}) => {
  const event = new Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'key', { value });
  for (const [name, value] of Object.entries(modifiers)) Object.defineProperty(event, name, { value });
  element.dispatchEvent(event);
  return event;
};
const change = element => element.dispatchEvent(new Event('change', { bubbles: true }));
const control = (f, id) => {
  const element = f.document.querySelector(`#${id}`);
  assert.ok(element, `Missing control: ${id}`);
  return element;
};
const nativeStarts = f => f.traces.filter(value => value[0] === 'native-start');
const chooseWindowMethod = (f, method, sourceId = 'window:101:0') => {
  control(f, 'share-tab-window').click();
  const card = f.document.querySelector(`[data-source-id="${sourceId}"]`);
  assert.ok(card, 'The intended window must be enumerated before choosing its method');
  card.click();
  control(f, `share-method-${method}`).click();
  assert.equal(f.picker.selectedSourceId, sourceId);
  assert.equal(f.picker.windowCaptureMethod, method);
  return card;
};

for (const language of ['pt-BR', 'en']) {
  test(`one window list has localized, accessible methods without claiming game detection (${language})`, async t => {
    const f = fixture(language);
    t.after(() => f.close());
    f.sources[1].name = 'Application <script>bad()</script> & "title"';
    f.sources[1].thumbnailDataUrl = 'data:image/png;base64,test" onerror="bad()';
    f.sources[1].appIconDataUrl = 'data:image/png;base64,icon" onerror="bad()';
    await f.picker.open();
    const tabs = f.document.querySelectorAll('[role="tab"]');
    assert.equal(tabs.length, 2);
    assert.equal(f.document.querySelector('[role="tablist"]').getAttribute('aria-label'), f.i18n.t('screenShare.sourceTypes'));
    assert.equal(f.document.querySelector('#share-tab-game'), null);
    assert.equal(control(f, 'share-tab-window').getAttribute('aria-selected'), 'true');
    assert.equal(control(f, 'share-tab-window').tabIndex, 0);
    assert.equal(control(f, 'share-tab-screen').tabIndex, -1);
    assert.equal(control(f, 'share-tab-window').getAttribute('aria-controls'), 'share-sources-panel');
    assert.equal(control(f, 'share-tab-window').textContent.includes(language === 'en' ? 'Windows' : 'Janelas'), true);
    assert.equal(control(f, 'share-window-methods').hidden, true, 'A method belongs to an explicitly selected window');
    assert.equal(f.document.querySelectorAll('.source-item').length, 2);
    assert.ok(control(f, 'share-sources-panel').innerHTML.includes('&lt;script&gt;'));
    assert.equal(f.document.querySelector('[onerror]'), null, 'Source metadata cannot inject an attribute');
    assert.equal(f.document.querySelector('script'), null);
    const card = f.document.querySelector('.source-item');
    assert.equal(key(card, ' ').defaultPrevented, true);
    assert.equal(card.getAttribute('aria-pressed'), 'true');
    assert.equal(control(f, 'btn-share').disabled, false);
    assert.equal(control(f, 'share-window-methods').hidden, false);
    assert.equal(control(f, 'share-method-label').textContent,
      f.i18n.t('screenShare.captureMethodForWindow', { name: f.sources[1].name }));
    assert.equal(control(f, 'share-method-window').getAttribute('aria-pressed'), 'true');
    assert.equal(control(f, 'share-method-window').tabIndex, 0);
    assert.equal(control(f, 'share-method-game').getAttribute('aria-pressed'), 'false');
    assert.equal(control(f, 'share-method-game').tabIndex, -1);
    assert.equal(control(f, 'share-method-window').textContent.includes(f.i18n.t('screenShare.windowCapture')), true);
    assert.equal(control(f, 'share-method-game').textContent.includes(f.i18n.t('screenShare.gameCapture')), true);
    const selected = f.picker.selectedSourceId;
    const cards = f.document.querySelectorAll('.source-item');
    assert.equal(key(control(f, 'share-method-window'), 'ArrowRight').defaultPrevented, true);
    assert.equal(f.picker.windowCaptureMethod, 'game');
    assert.equal(f.document.activeElement, control(f, 'share-method-game'));
    assert.equal(control(f, 'share-method-game').getAttribute('aria-pressed'), 'true');
    assert.equal(control(f, 'share-game-tip').hidden, false);
    assert.ok(control(f, 'share-game-tip').textContent.includes(f.i18n.t('screenShare.gameCompatibility')));
    assert.ok(control(f, 'share-game-tip').textContent.includes(f.i18n.t('screenShare.gameWindowAlternative')));
    assert.equal(control(f, 'btn-share').getAttribute('aria-describedby'), 'share-game-tip');
    assert.ok(control(f, 'share-game-tip').textContent.includes('CS2'));
    assert.ok(control(f, 'share-game-tip').textContent.includes('Normal'));
    assert.doesNotMatch(control(f, 'share-game-tip').textContent, /WGC|hook/i);
    assert.equal(f.i18n.t('screenShare.windowCapture'), 'Normal');
    assert.match(control(f, 'share-game-tip').textContent, language === 'en' ? /same window/ : /mesma janela/);
    assert.ok(control(f, 'share-game-tip').textContent.includes('Trusted Mode'));
    assert.ok(control(f, 'share-game-tip').textContent.includes(language === 'en' ? 'borderless' : 'sem bordas'));
    assert.equal(f.picker.selectedSourceId, selected);
    assert.deepEqual(f.document.querySelectorAll('.source-item'), cards, 'Changing method must neither duplicate nor recreate the window list');
    for (const [pressed, expected] of [['Home', 'window'], ['End', 'game'], ['ArrowDown', 'window'], ['ArrowUp', 'game']]) {
      key(control(f, `share-method-${f.picker.windowCaptureMethod}`), pressed);
      assert.equal(f.picker.windowCaptureMethod, expected);
      assert.equal(f.picker.selectedSourceId, selected);
      assert.equal(control(f, 'btn-share').getAttribute('aria-describedby'), expected === 'game' ? 'share-game-tip' : null);
    }
    assert.equal(f.document.querySelector('input[type="radio"]'), null);
    assert.ok(f.document.querySelectorAll('input[type="checkbox"]').every(input => input.closest('.toggle-switch')));
    assert.equal(key(control(f, 'share-tab-window'), 'ArrowRight').defaultPrevented, true);
    assert.equal(f.picker.activeTab, 'screen');
    assert.equal(f.document.activeElement, control(f, 'share-tab-screen'));
    assert.equal(f.picker.selectedSourceId, null, 'Switching source types requires an explicit source selection');
    assert.equal(control(f, 'share-window-methods').hidden, true);
    assert.equal(control(f, 'btn-share').disabled, true);
    assert.equal(f.document.querySelectorAll('.source-item').length, 1);
    assert.equal(control(f, 'share-audio-text').textContent, f.i18n.t('screenShare.shareAudio'));
    key(control(f, 'share-tab-screen'), 'End');
    assert.equal(f.picker.activeTab, 'window');
    assert.equal(control(f, 'share-audio-text').textContent, f.i18n.t('screenShare.shareAppAudio'));
    key(control(f, 'share-tab-window'), 'Home');
    assert.equal(f.picker.activeTab, 'screen');
    key(control(f, 'share-tab-screen'), 'ArrowLeft');
    assert.equal(f.picker.activeTab, 'window');
    assert.equal(f.traces.length, 0, 'Source/method selection cannot prepare a window or start a probe/hook');
    assert.equal(nativeStarts(f).length, 0);
  });

  test(`quality offers only Automatic/H264 and disabled AV1, with an isolated preview switch (${language})`, t => {
    const f = fixture(language);
    t.after(() => f.close());
    const root = f.mountQuality();
    const codec = control(f, 'select-video-codec');
    assert.deepEqual(codec.querySelectorAll('option').map(option => option.value), ['auto', 'h264', 'av1']);
    const av1 = codec.querySelector('option[value="av1"]');
    assert.equal(av1.disabled, true);
    assert.ok(av1.textContent.includes(f.i18n.t('screenShare.comingSoon')));
    assert.equal(codec.querySelector('option[value="auto"]').disabled, false);
    assert.equal(codec.querySelector('option[value="h264"]').disabled, false);
    assert.ok(codec.querySelector('option[value="auto"]').textContent.includes('H.264'));
    assert.equal(f.saves, 0);
    const preview = control(f, 'checkbox-screen-preview-focus');
    assert.ok(preview.closest('.toggle-switch'), 'No isolated native checkbox is exposed');
    assert.equal(preview.checked, true);
    assert.equal(preview.getAttribute('aria-describedby'), 'screen-preview-focus-description');
    assert.equal(root.querySelectorAll('[data-settings-section="screen-preview"]').length, 1);
    assert.equal(root.querySelector('[data-settings-section="screen-preview"]').dataset.settingsLabel, f.i18n.t('settings.screenPreviewSection'));
    const before = JSON.stringify({
      profile: f.settingsStore.customProfile, preset: f.settingsStore.qualityPreset,
      codec: f.settingsStore.preferredVideoCodec, telemetry: f.settingsStore.screenShareTelemetryEnabled,
    });
    f.quality.attachEvents(root);
    preview.checked = false;
    change(preview);
    assert.equal(f.saves, 1, 'Reattaching must not duplicate the preview listener');
    assert.equal(f.settingsStore.screenSharePreviewPauseWhenUnfocused, false);
    assert.equal(JSON.stringify({
      profile: f.settingsStore.customProfile, preset: f.settingsStore.qualityPreset,
      codec: f.settingsStore.preferredVideoCodec, telemetry: f.settingsStore.screenShareTelemetryEnabled,
    }), before);
    assert.equal(f.traces.length, 0, 'Preview preference changes do not touch capture, quality, camera or transport');
    const preset = control(f, 'select-preset');
    preset.value = 'CUSTOM';
    change(preset);
    assert.equal(control(f, 'checkbox-screen-preview-focus'), preview);
    assert.equal(preview.checked, false);
    const oldBitrate = control(f, 'custom-screenBitrate');
    preset.value = 'NORMAL';
    change(preset);
    const savesBeforeOldControl = f.saves;
    oldBitrate.value = '20000';
    change(oldBitrate);
    assert.equal(f.saves, savesBeforeOldControl, 'Removed custom controls have no active listeners');
    f.quality.cleanup();
    f.quality.cleanup();
    preview.checked = true;
    change(preview);
    assert.equal(f.saves, savesBeforeOldControl, 'A closed preview switch cannot persist stale changes');
    root.remove();
    const reopened = f.mountQuality();
    assert.equal(reopened.querySelector('#checkbox-screen-preview-focus').checked, false);
  });

  test(`pending verification stays internal without provisional badges or premature probing (${language})`, async t => {
    const f = fixture(language);
    t.after(() => f.close());
    Object.assign(f.capabilities, { capture: false, backend: null, requiresSelectionProbe: true });
    await f.picker.open();
    for (const tab of f.document.querySelectorAll('[role="tab"]')) {
      assert.equal(tab.disabled, false);
      assert.equal(tab.title, '');
      assert.equal(tab.getAttribute('aria-describedby'), null);
      assert.equal(tab.querySelector('.share-tab-status').hidden, true);
      assert.equal(tab.querySelector('.share-tab-status').textContent, '');
    }
    const info = control(f, 'share-capture-info');
    assert.equal(info.dataset.backend, 'probe-pending');
    assert.equal(info.hidden, true);
    assert.equal(info.textContent, '');
    assert.equal(control(f, 'btn-share').disabled, true, 'A pending probe still needs an explicit source');
    f.document.querySelector('.source-item').click();
    assert.equal(control(f, 'btn-share').disabled, false, 'Confirmation may prepare exactly the selected source');
    assert.equal(info.dataset.backend, 'probe-pending', 'Selecting a card is not hardware verification');
    for (const method of ['window', 'game']) {
      const button = control(f, `share-method-${method}`);
      assert.equal(button.disabled, false);
      assert.equal(button.title, '');
      assert.equal(button.getAttribute('aria-describedby'), `share-method-${method}-description`);
      assert.equal(control(f, `share-method-${method}-status`).hidden, true);
      assert.equal(control(f, `share-method-${method}-status`).textContent, '');
    }
    control(f, 'share-method-game').click();
    assert.equal(f.picker.selectedSourceId, f.sources[1].id);
    assert.equal(f.traces.length, 0, 'Enumeration/card selection must not prepare a window, probe, capture or publish');
    assert.equal(f.capabilities.capture, false);
    assert.equal(f.capabilities.backend, null);
    f.capabilities.captureKinds = ['window'];
    f.picker.updateCaptureInfo();
    assert.equal(control(f, 'share-tab-screen').disabled, true);
    assert.equal(control(f, 'share-tab-screen').querySelector('.share-tab-status').hidden, false);
    assert.equal(control(f, 'share-method-game').disabled, true);
    assert.equal(control(f, 'share-method-game-status').hidden, false);
    assert.equal(control(f, 'btn-share').disabled, true);
    assert.equal(info.hidden, false, 'An actual blocker must replace the hidden provisional info');
    assert.equal(info.textContent, f.i18n.t('screenShare.captureMethodUnavailable', { method: f.i18n.t('screenShare.gameCapture') }));
    f.capabilities.captureKinds = ['window', 'monitor', 'game'];
    f.picker.updateCaptureInfo();
    assert.equal(info.hidden, true);
    assert.equal(info.textContent, '');
    assert.equal(control(f, 'share-method-game-status').hidden, true);
    assert.equal(control(f, 'btn-share').disabled, false);
    assert.equal(f.capabilities.capture, false, 'Restoring an eligible method must not manufacture verified capture');
  });

  test(`preview section navigation targets the real section and cleans up (${language})`, t => {
    const f = fixture(language);
    t.after(() => f.close());
    const root = f.document.createElement('main');
    root.innerHTML = `<aside class="settings-sidebar"><button class="settings-tab-btn" data-tab="quality">Quality</button></aside>
      <div class="settings-content-body"><div id="tab-panel-quality">${f.quality.renderHtml()}</div></div>`;
    f.document.body.appendChild(root);
    f.quality.attachEvents(root);
    const section = root.querySelector('[data-settings-section="screen-preview"]');
    section.top = 600;
    const navigation = new f.SettingsSectionNavigation(root);
    navigation.setTab('quality');
    const link = root.querySelector('[data-section-target="screen-preview"]');
    assert.ok(link);
    assert.equal(link.textContent, f.i18n.t('settings.screenPreviewSection'));
    assert.equal(link.getAttribute('aria-controls'), section.id);
    link.click();
    assert.equal(link.getAttribute('aria-current'), 'location');
    assert.equal(root.querySelector('.settings-content-body').scrollTop, 584);
    navigation.destroy();
    navigation.destroy();
    assert.ok(f.observers.every(observer => observer.disconnected));
    assert.equal(root.querySelector('[data-section-target="screen-preview"]'), null);
    assert.equal(root.querySelector('.settings-tab-btn').hasAttribute('aria-controls'), false);
    assert.equal(navigation.revealSection('screen-preview'), false);
  });
}

for (const language of ['pt-BR', 'en']) {
  test(`terminal Game Capture failures use the structured code for localized Normal guidance (${language})`, async t => {
    const f = fixture(language);
    t.after(() => f.close());
    const message = 'Raw native CS2 diagnostic must stay in logs, not identify a game or select an error message';
    f.notifyNativeFailure({ reason: 'capture-failed', code: 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE', message });
    assert.equal(f.alerts.length, 1);
    assert.equal(f.alerts[0].title, f.i18n.t('screenShare.errorTitle'));
    assert.equal(f.alerts[0].message, f.i18n.t('screenShare.gameCaptureUnavailable'));
    assert.equal(f.alerts[0].variant, 'danger');
    assert.ok(f.alerts[0].message.includes('CS2'));
    assert.ok(f.alerts[0].message.includes('Normal'));
    assert.doesNotMatch(f.alerts[0].message, /WGC|hook/i);
    assert.ok(f.alerts[0].message.includes('Trusted Mode'));
    assert.ok(f.alerts[0].message.includes(language === 'en' ? 'borderless' : 'sem bordas'));
    assert.equal(f.alerts[0].message.includes(message), false);
    f.notifyNativeFailure({ reason: 'capture-failed', message });
    assert.equal(f.alerts[1].message, f.i18n.t('screenShare.nativeFailure.capture-failed'),
      'Without the code, neither native English nor a game name may manufacture a Game Capture diagnosis');
    f.notifyNativeFailure({ reason: 'unsupported' });
    assert.equal(f.alerts[2].message, f.i18n.t('screenShare.nativeFailure.unsupported'));
    assert.equal(f.traces.length, 0, 'The terminal alert must not start Normal, retry Game Capture or change the selected source');
  });

  test(`fallback reports an attempt through an informational toast, never a success or terminal modal (${language})`, t => {
    const f = fixture(language);
    t.after(() => f.close());
    f.notifyCaptureFallback({ shareId: '<img src=x onerror=bad()>' });
    assert.equal(f.alerts.length, 0);
    assert.equal(f.traces.length, 1);
    assert.deepEqual(f.traces[0], ['info-toast', f.i18n.t('screenShare.gameFallback'), 8000]);
    assert.match(f.traces[0][1], language === 'en' ? /Trying Normal.*same window/ : /Tentando.*Normal.*mesma janela/);
    assert.doesNotMatch(f.traces[0][1], /<img|WGC|hook/i);
    f.notifyNativeFailure({ reason: 'capture-failed' });
    assert.equal(f.alerts.length, 1, 'A later terminal Normal failure must still be visible');
    assert.equal(f.alerts[0].message, f.i18n.t('screenShare.nativeFailure.capture-failed'));
  });
}

test('fallback toast lasts eight seconds without extending the default information and copy notices', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), clears = [];
  t.after(() => { for (const clear of clears) clear(); f.close(); });
  const { showInfoToast, showCopyToast } = f.load('views/CopyToast');
  clears.push(showInfoToast(f.i18n.t('screenShare.gameFallback'), 8000));
  const fallback = f.document.querySelector('.chat-copy-toast');
  t.mock.timers.tick(3200);
  assert.equal(fallback.isConnected, true, 'The fallback notice must outlast its previous timeout');
  t.mock.timers.tick(4799);
  assert.equal(fallback.isConnected, true, 'The fallback notice must remain until eight seconds');
  t.mock.timers.tick(1);
  assert.equal(fallback.isConnected, false);
  for (const [show, durationMs] of [[showInfoToast, 3200], [showCopyToast, 1600]]) {
    clears.push(show('Unchanged default'));
    const notice = f.document.querySelector('.chat-copy-toast');
    t.mock.timers.tick(durationMs - 1);
    assert.equal(notice.isConnected, true);
    t.mock.timers.tick(1);
    assert.equal(notice.isConnected, false);
  }
});

test('legacy capability fixtures enable only windows; explicit empty/unsupported kinds never enable capture', async t => {
  const f = fixture();
  t.after(() => f.close());
  delete f.capabilities.captureKinds;
  await f.picker.open();
  assert.equal(control(f, 'share-tab-window').disabled, false);
  const button = control(f, 'share-tab-screen');
  assert.equal(button.disabled, true);
  assert.equal(button.tabIndex, -1);
  assert.equal(button.getAttribute('aria-describedby'), 'share-method-reasons');
  assert.ok(button.title.includes('native backend'));
  assert.ok(control(f, 'share-method-reasons').textContent.includes(button.title));
  button.click();
  assert.equal(f.picker.activeTab, 'window');
  f.document.querySelector('.source-item').click();
  const game = control(f, 'share-method-game');
  assert.equal(game.disabled, true);
  assert.equal(game.tabIndex, -1);
  assert.ok(game.getAttribute('aria-describedby').includes('share-method-game-status'));
  assert.ok(game.title.includes('native backend'));
  game.click();
  assert.equal(f.picker.windowCaptureMethod, 'window');
  key(control(f, 'share-tab-window'), 'ArrowLeft');
  assert.equal(f.picker.activeTab, 'window');
  f.capabilities.captureKinds = ['window', 'game'];
  f.picker.updateCaptureInfo();
  key(control(f, 'share-method-window'), 'ArrowRight');
  assert.equal(f.picker.windowCaptureMethod, 'game');
  f.capabilities.captureKinds = ['window'];
  f.picker.updateCaptureInfo();
  assert.equal(f.picker.windowCaptureMethod, 'game', 'Losing game support never silently changes the selected method');
  assert.equal(f.picker.selectedSourceId, 'window:101:0');
  assert.equal(control(f, 'btn-share').disabled, true);
  assert.equal(game.disabled, true);
  assert.equal(game.getAttribute('aria-pressed'), 'true');
  const previousEnumerations = f.enumerations;
  f.capabilities.captureKinds = [];
  await f.picker.open();
  assert.equal(f.enumerations, previousEnumerations);
  assert.equal(f.document.querySelectorAll('[role="tab"]').every(tab => tab.disabled), true);
  assert.equal(f.picker.activeTab, 'window');
  assert.equal(f.document.querySelector('.source-item'), null);
  assert.equal(control(f, 'btn-share').disabled, true);
});

test('unverified capture without selection permission stays disabled even with a GPU backend label and advertised kinds', async t => {
  const f = fixture();
  t.after(() => f.close());
  Object.assign(f.capabilities, { capture: false, reason: 'encoder', backend: 'libobs-nvenc' });
  await f.picker.open();
  assert.equal(f.enumerations, 0);
  assert.ok(f.document.querySelectorAll('[role="tab"]').every(tab => tab.disabled));
  assert.equal(control(f, 'share-capture-info').textContent, f.i18n.t('screenShare.nativeEncoderUnavailable'));
  assert.equal(f.picker.selectSource('window:101:0'), false);
  assert.equal(nativeStarts(f).length, 0);
});

test('selection probing needs its explicit flag and declared kinds; it never assumes monitor or window support', async t => {
  const f = fixture();
  t.after(() => f.close());
  Object.assign(f.capabilities, { capture: false, backend: null, requiresSelectionProbe: false });
  await f.picker.open();
  assert.equal(f.enumerations, 0);
  assert.ok(f.document.querySelectorAll('[role="tab"]').every(tab => tab.disabled));
  f.capabilities.requiresSelectionProbe = true;
  delete f.capabilities.captureKinds;
  await f.picker.open();
  assert.equal(f.enumerations, 0, 'Missing kinds only have the legacy window default when capture is already available');
  assert.ok(f.document.querySelectorAll('[role="tab"]').every(tab => tab.disabled));
  f.capabilities.captureKinds = ['monitor'];
  await f.picker.open();
  assert.equal(control(f, 'share-tab-screen').disabled, false);
  assert.equal(control(f, 'share-tab-window').disabled, true);
  assert.equal(control(f, 'share-method-game').disabled, true);
  assert.equal(f.picker.activeTab, 'window', 'The new flag does not automatically switch methods');
  assert.equal(nativeStarts(f).length, 0);
  f.capabilities.capture = true;
  delete f.capabilities.captureKinds;
  await f.picker.open();
  assert.equal(control(f, 'share-tab-window').disabled, false);
  assert.equal(control(f, 'share-tab-screen').disabled, true);
  assert.equal(control(f, 'share-capture-info').dataset.backend, 'probe-pending', 'An explicit probe requirement is never presented as verified capture');
});

for (const [tab, kind, sourceId] of [
  ['screen', 'monitor', MONITOR_SOURCE_ID],
  ['window', 'window', `window:101:${'a'.repeat(64)}`],
  ['window', 'game', `window:101:${'b'.repeat(64)}`],
]) {
  test(`pending ${kind} confirmation passes the original opaque ID without rebuilding it`, async t => {
    const f = fixture();
    t.after(() => f.close());
    Object.assign(f.capabilities, { capture: false, backend: null, requiresSelectionProbe: true, captureKinds: [kind] });
    const index = kind === 'monitor' ? 0 : 1;
    f.sources[index].id = sourceId;
    await f.picker.open();
    control(f, `share-tab-${tab}`).click();
    f.document.querySelector(`[data-source-id="${sourceId}"]`).click();
    if (kind === 'game') {
      assert.equal(control(f, 'btn-share').disabled, true, 'Game-only support still requires explicit hook selection');
      control(f, 'share-method-game').click();
    }
    assert.equal(control(f, 'share-capture-info').dataset.backend, 'probe-pending');
    assert.equal(control(f, 'share-capture-info').hidden, true);
    assert.equal(nativeStarts(f).length, 0);
    await f.picker.startSharing('replace');
    assert.deepEqual(nativeStarts(f), [['native-start', sourceId, true, '', kind, false]]);
    const restores = f.traces.filter(value => value[0] === 'prepare-window');
    assert.deepEqual(restores, kind === 'monitor' ? [] : [['prepare-window', sourceId]]);
    assert.equal(f.capabilities.capture, false, 'The UI must not upgrade Main capabilities by itself');
    assert.equal(f.capabilities.backend, null);
    assert.equal(f.voiceStore.screenShareIds.length, 1);
    assert.equal(f.alerts.length, 0);
  });
}

test('Electron display ordinals are not native monitor selections and are never remapped automatically', async t => {
  const f = fixture();
  t.after(() => f.close());
  f.sources.push(f.source('screen:1:0', 'screen'));
  await f.picker.open();
  control(f, 'share-tab-screen').click();
  assert.equal(f.document.querySelectorAll('.source-item').length, 1);
  assert.ok(f.document.querySelector(`[data-source-id="${MONITOR_SOURCE_ID}"]`));
  assert.equal(f.picker.selectSource('screen:1:0'), false);
  f.picker.selectedSourceId = 'screen:1:0';
  await f.picker.startSharing('replace');
  assert.equal(nativeStarts(f).length, 0);
  assert.ok(f.alerts[0].message.includes(f.i18n.t('screenShare.sourceUnavailable')));
});

test('failed selected-source probing keeps the game choice and previous shares without advertising a verified encoder', async t => {
  const f = fixture();
  t.after(() => f.close());
  Object.assign(f.capabilities, { capture: false, backend: null, requiresSelectionProbe: true });
  const previous = f.createStream('window:303:0');
  f.voiceStore.addScreenShare(previous.id);
  f.controls.start = async () => { throw new Error('Selected-source encoder probe failed'); };
  await f.picker.open();
  chooseWindowMethod(f, 'game');
  await f.picker.startSharing('replace');
  assert.equal(nativeStarts(f).length, 1);
  assert.equal(nativeStarts(f)[0][4], 'game');
  assert.equal(f.picker.activeTab, 'window');
  assert.equal(f.picker.windowCaptureMethod, 'game');
  assert.equal(f.picker.selectedSourceId, 'window:101:0');
  assert.equal(control(f, 'share-capture-info').dataset.backend, 'probe-pending');
  assert.equal(f.capabilities.capture, false);
  assert.equal(f.capabilities.backend, null);
  assert.deepEqual(f.voiceStore.screenShareIds, [previous.id]);
  assert.equal(f.streams.get(previous.id), previous);
  assert.equal(f.traces.some(value => ['stop-shares', 'notify', 'audio-stop'].includes(value[0])), false);
  assert.ok(f.alerts[0].message.includes('probe failed'));
});

for (const [tab, kind, sourceId] of [
  ['screen', 'monitor', MONITOR_SOURCE_ID], ['window', 'window', 'window:101:0'], ['window', 'game', 'window:101:0'],
]) {
  test(`${tab} passes the explicit ${kind} method and keeps voice/camera/additional shares`, async t => {
    const f = fixture();
    t.after(() => f.close());
    const previous = f.createStream('window:303:0');
    f.voiceStore.addScreenShare(previous.id);
    f.sources.find(source => source.id === sourceId).thumbnailDataUrl = 'data:image/png;base64,selected';
    await f.picker.open();
    control(f, `share-tab-${tab}`).click();
    const card = f.document.querySelector(`[data-source-id="${sourceId}"]`);
    key(card, 'Enter');
    if (kind === 'game') control(f, 'share-method-game').click();
    assert.equal(control(f, 'btn-share-add').disabled, false);
    assert.equal(control(f, 'btn-share-add').getAttribute('aria-describedby'), kind === 'game' ? 'share-game-tip' : null);
    await f.picker.startSharing('add');
    assert.deepEqual(nativeStarts(f), [['native-start', sourceId, true, 'data:image/png;base64,selected', kind, false]]);
    assert.equal(f.traces.filter(value => value[0] === 'prepare-window').length, kind === 'monitor' ? 0 : 1);
    assert.equal(f.voiceStore.screenShareIds.length, 2);
    assert.ok(f.voiceStore.screenShareIds.includes(previous.id));
    assert.equal(f.streams.get(previous.id), previous);
    assert.equal(f.voiceStore.screenAudioShareId, f.voiceStore.screenShareIds[1]);
    assert.equal(f.voiceStore.camera, 'preserved-camera');
    assert.equal(f.voiceStore.voice, 'preserved-call');
    assert.equal(f.traces.filter(value => value[0] === 'notify').length, 1);
    assert.equal(f.picker.modalEl, null);
  });
}

test('terminal Game Capture rejection preserves existing shares without a second renderer capture attempt', async t => {
  const f = fixture();
  t.after(() => f.close());
  const previous = f.createStream('window:303:0');
  f.voiceStore.addScreenShare(previous.id);
  f.controls.start = async () => { throw new Error('Game capture is incompatible with the selected application'); };
  await f.picker.open();
  chooseWindowMethod(f, 'game');
  await f.picker.startSharing('replace');
  assert.equal(nativeStarts(f).length, 1);
  assert.equal(nativeStarts(f)[0][4], 'game');
  assert.equal(f.picker.activeTab, 'window');
  assert.equal(f.picker.windowCaptureMethod, 'game');
  assert.equal(f.picker.selectedSourceId, 'window:101:0');
  assert.deepEqual(f.voiceStore.screenShareIds, [previous.id]);
  assert.equal(f.streams.get(previous.id), previous);
  assert.equal(f.traces.some(value => ['stop-shares', 'notify', 'audio-stop'].includes(value[0])), false);
  assert.equal(f.alerts.length, 1);
  assert.ok(f.alerts[0].message.includes('incompatible'));
  assert.equal(control(f, 'btn-share').disabled, false, 'Retry remains possible on the exact selected method');
  assert.equal(f.voiceStore.camera, 'preserved-camera');
  assert.equal(f.voiceStore.voice, 'preserved-call');
});

test('replacement publishes only after successful acquisition and retires precisely the previous shares', async t => {
  const f = fixture();
  t.after(() => f.close());
  const previous = [f.createStream('window:303:0'), f.createStream('window:404:0')];
  for (const stream of previous) f.voiceStore.addScreenShare(stream.id);
  await f.picker.open();
  control(f, 'share-tab-screen').click();
  f.document.querySelector('.source-item').click();
  await f.picker.startSharing('replace');
  const order = f.traces.map(value => value[0]);
  assert.ok(order.indexOf('native-start') < order.indexOf('stop-shares'));
  assert.ok(order.indexOf('stop-shares') < order.indexOf('notify'));
  assert.deepEqual(f.traces.find(value => value[0] === 'stop-shares'), ['stop-shares', previous.map(stream => stream.id), false]);
  assert.equal(f.voiceStore.screenShareIds.length, 1);
  assert.ok(previous.every(stream => !f.streams.has(stream.id)));
  assert.equal(f.traces.filter(value => value[0] === 'notify').length, 1);
});

test('selection must be enumerated, match its method and not already be shared', async t => {
  const f = fixture();
  t.after(() => f.close());
  f.createStream('window:202:0');
  f.sources.push(f.source('window:999:0', 'screen'), f.source('screen:999:0', 'window'));
  await f.picker.open();
  assert.equal(f.document.querySelectorAll('.source-item').length, 1);
  assert.equal(f.picker.selectSource('window:202:0'), false);
  assert.equal(f.picker.selectSource('window:missing:0'), false);
  assert.equal(f.picker.selectSource(MONITOR_SOURCE_ID), false);
  chooseWindowMethod(f, 'game');
  assert.equal(f.picker.selectSource('window:202:0'), false, 'Changing methods does not make an active source available again');
  f.picker.selectedSourceId = 'window:missing:0';
  await f.picker.startSharing('replace');
  assert.equal(nativeStarts(f).length, 0);
  assert.ok(f.alerts[0].message.includes(f.i18n.t('screenShare.sourceUnavailable')));
  assert.equal(control(f, 'btn-share').disabled, true);
});

test('source refresh removes a disappeared game window without selecting a display or another window', async t => {
  const f = fixture();
  t.after(() => f.close());
  await f.picker.open();
  chooseWindowMethod(f, 'game');
  f.controls.sources = async () => [f.sources[0]];
  await f.picker.loadSources(f.picker.modalEl);
  assert.equal(f.picker.activeTab, 'window');
  assert.equal(control(f, 'share-tab-window').getAttribute('aria-selected'), 'true');
  assert.equal(f.picker.selectedSourceId, null);
  assert.equal(control(f, 'share-window-methods').hidden, true);
  assert.equal(f.document.querySelector('.source-item'), null);
  assert.ok(control(f, 'share-sources-panel').textContent.includes(f.i18n.t('screenShare.noWindows')));
  assert.equal(control(f, 'btn-share').disabled, true);
  assert.equal(nativeStarts(f).length, 0);
});

test('game-only capability does not enable a guessed Normal card; an available alternative keeps the exact same window', async t => {
  const f = fixture();
  t.after(() => f.close());
  f.capabilities.captureKinds = ['game'];
  await f.picker.open();
  assert.equal(control(f, 'share-tab-window').disabled, false);
  chooseWindowMethod(f, 'game');
  assert.equal(control(f, 'share-method-window').disabled, true);
  assert.equal(control(f, 'share-game-tip').textContent.includes(f.i18n.t('screenShare.gameWindowAlternative')), false);
  f.capabilities.captureKinds = ['game', 'window'];
  f.picker.updateCaptureInfo();
  assert.equal(control(f, 'share-method-window').disabled, false);
  assert.ok(control(f, 'share-game-tip').textContent.includes(f.i18n.t('screenShare.gameWindowAlternative')));
  assert.equal(f.picker.windowCaptureMethod, 'game', 'Showing the hint does not switch capture methods');
  assert.equal(f.picker.selectedSourceId, 'window:101:0');
  control(f, 'share-method-window').click();
  assert.equal(f.picker.windowCaptureMethod, 'window');
  assert.equal(f.picker.selectedSourceId, 'window:101:0', 'The manual Normal alternative must not reselect another window');
  assert.equal(nativeStarts(f).length, 0);
});

test('double-click retains the replace shortcut without starting a second native operation', async t => {
  const f = fixture();
  t.after(() => f.close());
  const previous = f.createStream('window:303:0');
  f.voiceStore.addScreenShare(previous.id);
  await f.picker.open();
  const card = chooseWindowMethod(f, 'window');
  card.click();
  card.dispatchEvent(new Event('dblclick', { bubbles: true }));
  card.dispatchEvent(new Event('dblclick', { bubbles: true }));
  await flush();
  assert.equal(nativeStarts(f).length, 1);
  assert.equal(nativeStarts(f)[0][4], 'window');
  assert.equal(f.voiceStore.screenShareIds.length, 1);
  assert.equal(f.streams.has(previous.id), false);
  assert.equal(f.picker.modalEl, null);
});

test('Game Capture requires explicit confirmation and is never inherited by a different window', async t => {
  const f = fixture();
  t.after(() => f.close());
  await f.picker.open();
  const first = chooseWindowMethod(f, 'game');
  const enumerations = f.enumerations;
  key(control(f, 'share-method-game'), 'Enter');
  key(control(f, 'share-method-game'), ' ');
  first.dispatchEvent(new Event('dblclick', { bubbles: true }));
  assert.equal(f.traces.length, 0, 'Choosing or double-clicking a hook method must not prepare, probe or capture');
  assert.equal(f.enumerations, enumerations, 'Changing method must not enumerate or replace the selected window');
  f.document.querySelector('[data-source-id="window:202:0"]').click();
  assert.equal(f.picker.selectedSourceId, 'window:202:0');
  assert.equal(f.picker.windowCaptureMethod, 'window', 'A hook choice belongs only to its explicitly selected window');
  assert.equal(control(f, 'share-method-window').getAttribute('aria-pressed'), 'true');
  assert.equal(control(f, 'share-game-tip').hidden, true);
  key(control(f, 'share-method-game'), ' ');
  assert.equal(f.picker.selectedSourceId, 'window:202:0');
  assert.equal(f.picker.windowCaptureMethod, 'game');
  assert.equal(f.traces.length, 0);
  control(f, 'btn-share').click();
  await flush();
  assert.deepEqual(nativeStarts(f), [['native-start', 'window:202:0', true, '', 'game', false]]);
});

test('changing method cannot retain a window removed from the current source set or switch to another one', async t => {
  const f = fixture();
  t.after(() => f.close());
  await f.picker.open();
  chooseWindowMethod(f, 'game');
  f.sources.splice(1, 1);
  control(f, 'share-method-window').click();
  assert.equal(f.picker.selectedSourceId, null);
  assert.equal(control(f, 'share-window-methods').hidden, true);
  assert.equal(control(f, 'btn-share').disabled, true);
  assert.ok(f.document.querySelectorAll('.source-item').every(card => card.getAttribute('aria-pressed') === 'false'));
  assert.equal(f.traces.length, 0);
  await f.picker.loadSources(f.picker.modalEl);
  assert.equal(f.document.querySelector('[data-source-id="window:101:0"]'), null);
  assert.equal(f.picker.selectedSourceId, null, 'Refreshing to a remaining window must not select it automatically');
  assert.equal(f.document.querySelectorAll('.source-item').length, 1);
});

test('app audio follows the same window across methods, while screen/app choices survive source-type switches and refresh', async t => {
  const f = fixture();
  t.after(() => f.close());
  await f.picker.open();
  chooseWindowMethod(f, 'window');
  const audio = control(f, 'chk-share-audio');
  audio.checked = false;
  change(audio);
  control(f, 'share-method-game').click();
  assert.equal(control(f, 'chk-share-audio'), audio);
  assert.equal(audio.checked, false);
  assert.equal(control(f, 'share-audio-text').textContent, f.i18n.t('screenShare.shareAppAudio'));
  assert.equal(f.picker.selectedSourceId, 'window:101:0');
  control(f, 'share-tab-screen').click();
  assert.equal(audio.checked, true, 'The initial system-audio choice is separate from app audio');
  assert.equal(control(f, 'share-audio-text').textContent, f.i18n.t('screenShare.shareAudio'));
  control(f, 'share-tab-window').click();
  assert.equal(audio.checked, false);
  chooseWindowMethod(f, 'game');
  await f.picker.loadSources(f.picker.modalEl);
  assert.equal(f.picker.selectedSourceId, 'window:101:0', 'Refresh preserves the same available source');
  assert.equal(f.picker.windowCaptureMethod, 'game');
  assert.equal(audio.checked, false);
  f.document.querySelector('[data-source-id="window:202:0"]').click();
  assert.equal(f.picker.windowCaptureMethod, 'window');
  audio.checked = true;
  change(audio);
  control(f, 'share-tab-screen').click();
  audio.checked = false;
  change(audio);
  control(f, 'share-tab-window').click();
  assert.equal(audio.checked, true);
  control(f, 'share-tab-screen').click();
  assert.equal(audio.checked, false);
  assert.equal(f.traces.length, 0);
});

for (const language of ['pt-BR', 'en']) {
  test(`explicit refresh discovers new windows and preserves only the same valid selection (${language})`, async t => {
    const f = fixture(language);
    t.after(() => f.close());
    await f.picker.open();
    chooseWindowMethod(f, 'game');
    f.settingsStore.qualityPreset = 'CUSTOM';
    f.settingsStore.preferredVideoCodec = 'h264';
    const profile = { ...f.settingsStore.customProfile };
    const audio = control(f, 'chk-share-audio');
    audio.checked = false;
    change(audio);
    const aspect = control(f, 'chk-preserve-aspect-ratio');
    assert.equal(aspect.checked, false);
    assert.equal(aspect.getAttribute('role'), 'switch');
    assert.equal(aspect.getAttribute('aria-labelledby'), 'share-aspect-label');
    assert.equal(aspect.getAttribute('aria-describedby'), 'share-aspect-description');
    assert.ok(aspect.closest('.toggle-switch'));
    aspect.checked = true;
    const refresh = control(f, 'btn-refresh-sources');
    assert.equal(refresh.tagName, 'BUTTON');
    assert.equal(refresh.type, 'button');
    assert.equal(refresh.getAttribute('aria-label'), f.i18n.t('screenShare.refreshSourcesLabel'));
    assert.equal(refresh.getAttribute('aria-controls'), 'share-sources-panel');
    assert.ok(refresh.textContent.includes(f.i18n.t('screenShare.refreshSources')));
    assert.equal(refresh.disabled, false);
    refresh.focus();
    assert.equal(f.document.activeElement, refresh);
    const gate = deferred();
    const selected = f.picker.selectedSourceId;
    const window = f.source('window:303:0', 'window', 'Opened after the picker');
    f.controls.sources = () => gate.promise;
    refresh.click();
    refresh.click();
    refresh.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    assert.equal(f.enumerations, 2, 'Repeated refresh clicks cannot overlap enumeration');
    assert.equal(refresh.disabled, true);
    assert.equal(refresh.dataset.loading, '1');
    assert.equal(refresh.getAttribute('aria-busy'), 'true');
    assert.equal(control(f, 'btn-share').disabled, true);
    assert.equal(control(f, 'btn-cancel').disabled, false);
    assert.equal(f.picker.selectedSourceId, selected, 'Loading does not discard a selection before checking it');
    gate.resolve([...f.sources, window]);
    await flush();
    assert.equal(refresh.disabled, false);
    assert.equal(refresh.getAttribute('aria-busy'), 'false');
    assert.ok(f.document.querySelector(`[data-source-id="${window.id}"]`));
    assert.equal(f.picker.activeTab, 'window');
    assert.equal(f.picker.selectedSourceId, selected);
    assert.equal(f.picker.windowCaptureMethod, 'game');
    assert.equal(control(f, 'share-method-game').getAttribute('aria-pressed'), 'true');
    assert.equal(f.document.querySelector(`[data-source-id="${selected}"]`).getAttribute('aria-pressed'), 'true');
    assert.equal(control(f, 'chk-preserve-aspect-ratio'), aspect);
    assert.equal(aspect.checked, true);
    assert.equal(audio.checked, false);
    assert.equal(f.settingsStore.qualityPreset, 'CUSTOM');
    assert.deepEqual(f.settingsStore.customProfile, profile);
    assert.equal(f.settingsStore.preferredVideoCodec, 'h264');
    const replacement = f.source('window:404:0', 'window', f.sources[1].name);
    f.controls.sources = async () => [f.sources[0], f.sources[2], window, replacement];
    refresh.click();
    await flush();
    assert.equal(f.picker.selectedSourceId, null, 'The same title cannot replace the selected opaque ID');
    assert.equal(control(f, 'btn-share').disabled, true);
    assert.equal(control(f, 'share-window-methods').hidden, true);
    assert.ok(f.document.querySelectorAll('.source-item').every(card => card.getAttribute('aria-pressed') === 'false'));
    assert.equal(aspect.checked, true);
    assert.equal(audio.checked, false);
    assert.equal(f.saves, 0);
    assert.equal(f.traces.length, 0, 'Refreshing sources must not prepare or capture a window');
  });
}

test('refresh errors and overlapping generations keep choices but never enable stale source confirmation', async t => {
  const f = fixture();
  t.after(() => f.close());
  await f.picker.open();
  chooseWindowMethod(f, 'game');
  control(f, 'chk-preserve-aspect-ratio').checked = true;
  const selected = f.picker.selectedSourceId;
  const first = deferred(), latest = deferred();
  f.controls.sources = () => first.promise;
  const oldRequest = f.picker.loadSources(f.picker.modalEl);
  await flush();
  f.controls.sources = () => latest.promise;
  const currentRequest = f.picker.loadSources(f.picker.modalEl);
  await flush();
  first.resolve([f.source('window:999:0', 'window')]);
  await oldRequest;
  assert.equal(control(f, 'share-sources-panel').getAttribute('aria-busy'), 'true');
  assert.equal(control(f, 'btn-refresh-sources').disabled, true);
  assert.equal(f.document.querySelector('[data-source-id="window:999:0"]'), null);
  latest.reject(new Error('Expected refresh failure'));
  await currentRequest;
  assert.ok(control(f, 'share-sources-panel').querySelector('[role="alert"]'));
  assert.equal(control(f, 'btn-refresh-sources').disabled, false);
  assert.equal(control(f, 'btn-share').disabled, true);
  assert.equal(f.picker.selectedSourceId, selected);
  assert.equal(f.picker.windowCaptureMethod, 'game');
  assert.equal(control(f, 'chk-preserve-aspect-ratio').checked, true);
  assert.ok(f.warnings.some(value => value[0] === '[ScreenShare] Could not load capture sources'));
  f.controls.sources = async () => f.sources;
  control(f, 'share-sources-panel').querySelector('[data-loading-retry]').click();
  await flush();
  assert.equal(f.picker.selectedSourceId, selected);
  assert.equal(f.picker.windowCaptureMethod, 'game');
  assert.equal(control(f, 'btn-share').disabled, false);
  assert.equal(f.traces.length, 0);
});

test('closing a refreshing picker retires its listeners and rejects detached refresh attempts', async t => {
  const f = fixture();
  t.after(() => f.close());
  await f.picker.open();
  chooseWindowMethod(f, 'game');
  const oldRoot = f.picker.modalEl, refresh = control(f, 'btn-refresh-sources');
  const pending = deferred();
  f.controls.sources = () => pending.promise;
  refresh.click();
  await flush();
  control(f, 'btn-cancel').click();
  assert.equal(f.picker.modalEl, null);
  assert.ok([...refresh.listeners.values()].every(listeners => listeners.size === 0));
  f.controls.sources = async () => f.sources;
  await f.picker.open();
  const currentRoot = f.picker.modalEl, count = f.enumerations;
  refresh.dispatchEvent(new Event('click', { bubbles: true }));
  await f.picker.loadSources(oldRoot);
  pending.reject(new Error('Expected abandoned refresh'));
  await flush();
  assert.equal(f.picker.modalEl, currentRoot);
  assert.equal(f.enumerations, count);
  assert.equal(f.picker.selectedSourceId, null);
  assert.equal(f.picker.windowCaptureMethod, 'window');
  assert.equal(control(f, 'chk-preserve-aspect-ratio').checked, false);
  assert.equal(f.document.querySelector('[role="alert"]'), null);
  assert.equal(f.alerts.length, 0);
});

for (const kind of ['window', 'game', 'monitor']) {
  for (const preserveAspectRatio of [false, true]) {
    test(`${kind} sends per-share preserveAspectRatio=${preserveAspectRatio} and a new picker defaults to stretch`, async t => {
      const f = fixture();
      t.after(() => f.close());
      await f.picker.open();
      const sourceId = kind === 'monitor' ? MONITOR_SOURCE_ID : 'window:101:0';
      if (kind === 'monitor') {
        control(f, 'share-tab-screen').click();
        f.document.querySelector(`[data-source-id="${sourceId}"]`).click();
      } else chooseWindowMethod(f, kind);
      const aspect = control(f, 'chk-preserve-aspect-ratio');
      assert.equal(aspect.checked, false);
      aspect.checked = preserveAspectRatio;
      const pending = deferred();
      f.controls.sources = () => pending.promise;
      control(f, 'btn-refresh-sources').click();
      await flush();
      pending.resolve(f.sources);
      await flush();
      assert.equal(f.picker.selectedSourceId, sourceId);
      assert.equal(aspect.checked, preserveAspectRatio);
      await f.picker.startSharing('replace');
      assert.deepEqual(nativeStarts(f), [['native-start', sourceId, true, '', kind, preserveAspectRatio]]);
      assert.equal(f.saves, 0, 'Aspect ratio is not a global preference');
      f.controls.sources = async () => f.sources;
      await f.picker.open();
      assert.equal(control(f, 'chk-preserve-aspect-ratio').checked, false);
      assert.equal(Object.hasOwn(f.settingsStore, 'preserveAspectRatio'), false);
    });
  }
}

for (const language of ['pt-BR', 'en']) {
  test(`monitor cards localize displayNumber without changing opaque IDs or metadata (${language})`, async t => {
    const f = fixture(language);
    t.after(() => f.close());
    const sources = ['a', 'b', 'c', 'd'].map((token, index) => Object.freeze({
      ...f.source(`native-monitor:${token.repeat(64)}`, 'screen', 'Generic PnP Monitor'),
      displayNumber: [3, 1, 4, 2][index],
      thumbnailDataUrl: index === 0 ? 'data:image/png;base64,synthetic' : '',
    }));
    f.controls.sources = async () => sources;
    await f.picker.open();
    control(f, 'share-tab-screen').click();
    const cards = f.document.querySelectorAll('.source-item');
    assert.equal(cards.length, 4);
    for (const [index, card] of cards.entries()) {
      const source = sources[index];
      const label = `${language === 'pt-BR' ? 'Tela' : 'Screen'} ${source.displayNumber}`;
      assert.equal(card.dataset.sourceId, source.id);
      assert.equal(card.getAttribute('aria-label'), label);
      assert.equal(card.querySelector('.source-name').title, label);
      assert.ok(card.querySelector('.source-name').textContent.includes(label));
      assert.equal(card.textContent.includes(source.name), false, 'Raw monitor metadata is not a disambiguated display label');
      if (source.thumbnailDataUrl) assert.equal(card.querySelector('img.source-thumbnail').getAttribute('alt'), label);
      else assert.ok(card.textContent.includes(f.i18n.t('screenShare.previewUnavailable')));
      key(card, 'Enter');
      assert.equal(f.picker.selectedSourceId, source.id);
      assert.equal(card.getAttribute('aria-pressed'), 'true');
      assert.equal(cards.filter(item => item.getAttribute('aria-pressed') === 'true').length, 1);
      assert.equal(source.name, 'Generic PnP Monitor');
    }
    assert.equal(new Set(cards.map(card => card.querySelector('.source-name').title)).size, 4);
    assert.equal(control(f, 'share-window-methods').hidden, true);
    assert.equal(f.traces.length, 0, 'UI enumeration must not create capture thumbnails or probe hardware');
    key(cards[0], ' ');
    await f.picker.startSharing('replace');
    assert.deepEqual(nativeStarts(f), [['native-start', sources[0].id, true, sources[0].thumbnailDataUrl, 'monitor', false]]);
  });

  test(`unnumbered monitors and application windows retain escaped source names (${language})`, async t => {
    const f = fixture(language);
    t.after(() => f.close());
    f.sources[0].name = 'Legacy <monitor> & "name"';
    f.sources[1].name = 'Application <window> & "name"';
    f.sources[1].displayNumber = 4;
    for (const source of f.sources.slice(0, 2)) source.thumbnailDataUrl = 'data:image/png;base64,synthetic';
    await f.picker.open();
    for (const source of [f.sources[1], f.sources[0]]) {
      control(f, `share-tab-${source.type}`).click();
      const card = f.document.querySelector(`[data-source-id="${source.id}"]`);
      assert.ok(card);
      assert.equal(card.getAttribute('aria-label'), source.name);
      assert.equal(card.querySelector('.source-name').title, source.name);
      assert.ok(card.querySelector('.source-name').textContent.includes(source.name));
      assert.equal(card.querySelector('img.source-thumbnail').getAttribute('alt'), source.name);
      assert.equal(card.querySelector('monitor'), null);
      assert.equal(card.querySelector('window'), null);
      key(card, 'Enter');
      assert.equal(f.picker.selectedSourceId, source.id);
      assert.equal(card.getAttribute('aria-pressed'), 'true');
    }
    assert.equal(f.traces.length, 0);
  });
}

test('audio availability and reservation cannot silently capture another mix or a second source', async t => {
  const f = fixture();
  t.after(() => f.close());
  f.capabilities.captureAudio = false;
  await f.picker.open();
  f.document.querySelector('.source-item').click();
  assert.equal(control(f, 'btn-share').disabled, true);
  assert.equal(control(f, 'share-capture-info').textContent, f.i18n.t('screenShare.nativeAudioUnavailable'));
  const audio = control(f, 'chk-share-audio');
  audio.checked = false;
  change(audio);
  assert.equal(control(f, 'btn-share').disabled, false);
  f.capabilities.captureAudio = true;
  f.voiceStore.screenAudioShareId = 'other-audio-share';
  await f.picker.open();
  assert.equal(control(f, 'chk-share-audio').disabled, true);
  assert.equal(control(f, 'chk-share-audio').checked, false);
  assert.equal(control(f, 'share-audio-text').textContent, f.i18n.t('screenShare.audioAlreadySharing'));
  f.voiceStore.screenAudioShareId = null;
  await f.picker.open();
  f.document.querySelector('.source-item').click();
  f.controls.capturingAudio = true;
  await f.picker.startSharing('replace');
  assert.equal(nativeStarts(f).length, 0);
  assert.ok(f.alerts.at(-1).message.includes(f.i18n.t('screenShare.audioAlreadySharing')));
  assert.equal(control(f, 'btn-share').disabled, true);
});

test('async capture locks the selected method; cancelling retires a late result without touching a newer picker', async t => {
  const f = fixture();
  t.after(() => f.close());
  Object.assign(f.capabilities, { capture: false, backend: null, requiresSelectionProbe: true });
  const gate = deferred();
  let wanted;
  f.controls.start = request => { wanted = request.isWanted; return gate.promise; };
  await f.picker.open();
  chooseWindowMethod(f, 'game');
  const oldRoot = f.picker.modalEl;
  const oldTab = control(f, 'share-tab-screen');
  const oldMethod = control(f, 'share-method-game');
  const pending = f.picker.startSharing('replace');
  await flush();
  assert.equal(f.picker.isStarting, true);
  assert.equal(control(f, 'btn-share').dataset.loading, '1', 'Actual capture preparation still has a loading indicator');
  assert.equal(control(f, 'share-capture-info').hidden, true);
  assert.equal(control(f, 'chk-share-audio').disabled, true);
  assert.equal(control(f, 'chk-preserve-aspect-ratio').disabled, true);
  assert.equal(control(f, 'btn-refresh-sources').disabled, true);
  assert.ok(f.document.querySelectorAll('[role="tab"]').every(tab => tab.disabled));
  assert.ok(f.document.querySelectorAll('.share-capture-methods button').every(button => button.disabled));
  f.picker.selectTab('screen');
  f.picker.selectWindowCaptureMethod('window');
  assert.equal(f.picker.activeTab, 'window');
  assert.equal(f.picker.windowCaptureMethod, 'game');
  assert.equal(f.picker.selectSource('window:202:0'), false);
  await f.picker.startSharing('replace');
  assert.equal(nativeStarts(f).length, 1);
  f.picker.close();
  assert.equal(f.cancelled, 1);
  assert.equal(wanted(), false);
  assert.ok([...oldRoot.listeners.values()].every(listeners => listeners.size === 0));
  assert.ok([...oldTab.listeners.values()].every(listeners => listeners.size === 0));
  assert.ok([...oldMethod.listeners.values()].every(listeners => listeners.size === 0));
  await f.picker.open();
  const current = f.picker.modalEl;
  oldTab.dispatchEvent(new Event('click'));
  oldMethod.dispatchEvent(new Event('click'));
  assert.equal(f.picker.activeTab, 'window', 'Detached tabs cannot mutate a reopened picker');
  assert.equal(f.picker.windowCaptureMethod, 'window', 'Detached method cards cannot select a hook in a reopened picker');
  const late = f.createStream('window:101:0');
  gate.resolve(late);
  await pending;
  assert.equal(f.streams.has(late.id), false);
  assert.equal(f.picker.modalEl, current);
  assert.equal(f.picker.isStarting, false);
  assert.equal(f.voiceStore.screenShareIds.length, 0);
  assert.equal(f.alerts.length, 0);
});

test('capability/source generations, retries and close cleanup ignore late results', async t => {
  const f = fixture();
  t.after(() => f.close());
  const capability = deferred();
  f.controls.capabilities = () => capability.promise;
  const abandoned = f.picker.open();
  assert.equal(control(f, 'share-sources-panel').getAttribute('aria-busy'), 'true');
  assert.ok(control(f, 'share-sources-panel').querySelector('.loading-skeleton'));
  assert.ok(f.document.querySelectorAll('[role="tab"]').every(tab => tab.disabled));
  f.picker.close();
  capability.resolve(f.capabilities);
  await abandoned;
  assert.equal(f.enumerations, 0);
  const oldSources = deferred();
  f.controls.capabilities = async () => f.capabilities;
  f.controls.sources = () => oldSources.promise;
  const oldOpening = f.picker.open();
  await flush();
  f.picker.close();
  const currentSources = deferred();
  f.controls.sources = () => currentSources.promise;
  const currentOpening = f.picker.open();
  await flush();
  control(f, 'share-tab-screen').click();
  control(f, 'share-tab-window').click();
  control(f, 'share-method-game').click();
  const panel = control(f, 'share-sources-panel');
  oldSources.resolve([f.source('window:999:0', 'window')]);
  await oldOpening;
  assert.ok(panel.querySelector('.loading-skeleton'));
  assert.equal(panel.querySelector('[data-source-id="window:999:0"]'), null);
  currentSources.resolve(f.sources);
  await currentOpening;
  assert.equal(f.picker.activeTab, 'window', 'The source type selected while enumerating is preserved');
  assert.equal(f.picker.windowCaptureMethod, 'window', 'No hook can be selected before its window exists');
  assert.equal(panel.getAttribute('aria-busy'), 'false');
  f.controls.sources = async () => { throw new Error('Enumeration failed'); };
  await f.picker.loadSources(f.picker.modalEl);
  assert.ok(panel.querySelector('[role="alert"]'));
  assert.equal(control(f, 'btn-share').disabled, true);
  f.controls.sources = async () => f.sources;
  panel.querySelector('[data-loading-retry]').click();
  await flush();
  assert.equal(control(f, 'share-sources-panel'), panel);
  assert.equal(panel.querySelectorAll('.source-item').length, 2);
  assert.equal(f.picker.selectedSourceId, null);
  f.picker.close();
  assert.equal(f.picker.nativeCapabilities, null);
  assert.equal('sources' in f.picker.sourceState, false);
  assert.equal(f.picker.eventController, null);
});

test('unavailable audio/codec/profile and application-wide Mac audio confirmation stay fail-closed', async t => {
  const f = fixture();
  t.after(() => f.close());
  await f.picker.open();
  f.document.querySelector('.source-item').click();
  for (const codec of ['vp8', 'vp9', 'av1']) {
    f.settingsStore.preferredVideoCodec = codec;
    await f.picker.startSharing('replace');
    assert.equal(control(f, 'btn-share').disabled, true);
  }
  assert.equal(nativeStarts(f).length, 0);
  f.settingsStore.preferredVideoCodec = 'auto';
  f.settingsStore.qualityPreset = 'CUSTOM';
  f.settingsStore.customProfile.screenFps = 144;
  await f.picker.startSharing('replace');
  assert.equal(nativeStarts(f).length, 0);
  f.settingsStore.qualityPreset = 'NORMAL';
  f.api.platform = 'darwin';
  f.controls.confirm = false;
  const alertsBefore = f.alerts.length;
  await f.picker.startSharing('replace');
  assert.equal(f.alerts.length, alertsBefore);
  assert.equal(nativeStarts(f).length, 0);
  assert.equal(f.traces.some(value => value[0] === 'prepare-window'), false);
  assert.equal(control(f, 'share-audio-text').textContent, f.i18n.t('screenShare.shareAudioMacWindow'));
});

for (const saved of ['vp8', 'vp9', 'av1']) {
  test(`legacy ${saved} stays persisted until an explicit supported codec selection`, async t => {
    const f = fixture();
    t.after(() => f.close());
    f.settingsStore.preferredVideoCodec = saved;
    const root = f.mountQuality();
    const codec = root.querySelector('#select-video-codec');
    const notice = root.querySelector('#screen-codec-preference-notice');
    assert.equal(f.settingsStore.preferredVideoCodec, saved);
    assert.equal(f.saves, 0);
    assert.equal(codec.value, saved === 'av1' ? 'av1' : '');
    assert.equal(notice.hidden, false);
    assert.ok(notice.textContent.includes(saved.toUpperCase()));
    assert.equal(codec.querySelector('option[value="vp8"]'), null);
    assert.equal(codec.querySelector('option[value="vp9"]'), null);
    codec.value = 'av1';
    change(codec);
    assert.equal(f.settingsStore.preferredVideoCodec, saved);
    assert.equal(f.saves, 0);
    assert.equal(codec.value, saved === 'av1' ? 'av1' : '');
    f.controls.settingsError = new Error('Active screen settings cannot change');
    codec.value = 'h264';
    change(codec);
    assert.equal(f.settingsStore.preferredVideoCodec, saved);
    assert.equal(f.saves, 0);
    f.controls.settingsError = null;
    codec.value = 'auto';
    change(codec);
    await flush();
    assert.equal(f.settingsStore.preferredVideoCodec, 'auto');
    assert.equal(f.saves, 1);
    assert.equal(notice.hidden, true);
    assert.equal(codec.querySelector('option[value=""]'), null);
  });
}

test('a late codec error cannot open a dialog after quality settings cleanup', async t => {
  const f = fixture();
  t.after(() => f.close());
  const gate = deferred();
  f.controls.reapply = () => gate.promise;
  f.mountQuality();
  const codec = control(f, 'select-video-codec');
  codec.value = 'h264';
  change(codec);
  assert.equal(f.saves, 1);
  f.quality.cleanup();
  gate.reject(new Error('Obsolete codec operation'));
  await flush();
  assert.equal(f.alerts.length, 0);
});

test('the local OBS guide contains only the 14 sourced limitations, searchable by aliases without compatibility verdicts', t => {
  const f = fixture();
  t.after(() => f.close());
  const { GAME_CAPTURE_GUIDANCE: entries, GAME_CAPTURE_GUIDE_SOURCE, searchGameCaptureGuidance: search } = f.load('views/GameCaptureGuideModal');
  assert.equal(GAME_CAPTURE_GUIDE_SOURCE, 'https://obsproject.com/kb/game-capture-troubleshooting');
  assert.equal(entries.length, 14);
  assert.equal(new Set(entries.map(entry => entry.id)).size, 14);
  assert.deepEqual([...entries].filter(entry => entry.advice === 'normal').map(entry => entry.id).sort(),
    ['cs2', 'destiny2', 'gta-san-andreas', 'roblox', 'samp']);
  assert.deepEqual([...entries].filter(entry => entry.advice === 'permissions').map(entry => entry.id).sort(),
    ['call-of-duty', 'genshin-impact', 'honkai-star-rail', 'valorant', 'zenless-zone-zero']);
  assert.deepEqual([...entries].filter(entry => entry.advice === 'multiGpu').map(entry => entry.id).sort(),
    ['minecraft-java', 'osu']);
  assert.equal(entries.find(entry => entry.id === 'fortnite').advice, 'dx12');
  assert.equal(entries.find(entry => entry.id === 'league-of-legends').advice, 'separateWindow');
  assert.ok(entries.every(entry => !Object.hasOwn(entry, 'compatible') && !Object.hasOwn(entry, 'executable')));
  for (const [query, expected] of [
    ['CS2', 'cs2'], ['cs 2', 'cs2'], ['counter strike', 'cs2'], ['Counter-Strike 2', 'cs2'],
    ['GTA San Andreas', 'gta-san-andreas'], ['GTA SA', 'gta-san-andreas'],
    ['SA-MP', 'samp'], ['samp', 'samp'], ['LoL', 'league-of-legends'],
    ['Minecraft Java', 'minecraft-java'], ['Mínecraft: JÁVA Edition', 'minecraft-java'],
    ['  OSU!  ', 'osu'], ['Valorant', 'valorant'], ['honkai star rail', 'honkai-star-rail'],
  ]) assert.deepEqual([...search(query)].map(entry => entry.id), [expected], query);
  assert.deepEqual([...search('San Andreas')].map(entry => entry.id), ['gta-san-andreas', 'samp']);
  assert.equal(search(' \t ').length, 14);
  for (const query of ['TLOU2', 'The Last of Us Part II', 'Minecraft Bedrock', 'CSGO', 'GTA V', '!!!', '不存在']) {
    assert.equal(search(query).length, 0, `${query} has no catalogued information, not an incompatibility verdict`);
  }
});

for (const language of ['pt-BR', 'en']) {
  test(`the guide is an independent searchable modal that restores focus and selection without starting capture (${language})`, async t => {
    const f = fixture(language);
    t.after(() => f.close());
    Object.assign(f.capabilities, { capture: false, backend: null, requiresSelectionProbe: true });
    f.sources[1].name = 'Counter-Strike 2';
    await f.picker.open();
    const opener = control(f, 'btn-game-capture-guide');
    const picker = f.picker.modalEl;
    assert.equal(opener.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(opener.getAttribute('aria-expanded'), 'false');
    assert.ok(opener.textContent.includes(f.i18n.t('screenShare.gameGuideButton')));
    opener.click();
    assert.ok(f.document.querySelector('#game-capture-guide'), 'The guide is available before selecting a source');
    control(f, 'game-capture-guide-close').click();
    assert.equal(f.document.activeElement, opener);
    chooseWindowMethod(f, 'game');
    const selectedCard = f.document.querySelector('[data-source-id="window:101:0"]');
    control(f, 'chk-share-audio').checked = false;
    change(control(f, 'chk-share-audio'));
    control(f, 'chk-preserve-aspect-ratio').checked = true;
    const quality = JSON.stringify([f.settingsStore.qualityPreset, f.settingsStore.customProfile, f.settingsStore.preferredVideoCodec]);
    const enumerations = f.enumerations;
    opener.click();
    const guide = control(f, 'game-capture-guide').closest('.modal-backdrop');
    const search = control(f, 'game-capture-guide-search');
    const close = control(f, 'game-capture-guide-close');
    const first = guide.querySelector('[data-game-guide-close]');
    assert.equal(f.document.querySelectorAll('.modal-backdrop').length, 2);
    assert.equal(control(f, 'game-capture-guide').getAttribute('role'), 'dialog');
    assert.equal(control(f, 'game-capture-guide').getAttribute('aria-describedby'), 'game-capture-guide-intro');
    const intro = control(f, 'game-capture-guide-intro').textContent;
    assert.equal(intro, f.i18n.t('screenShare.gameGuideIntro'));
    assert.match(intro, language === 'pt-BR' ? /^Para jogos, prefira Captura de jogo\./ : /^For games, try Game Capture first\./);
    assert.ok(intro.includes('OBS'), 'Known limitations must be attributed to OBS rather than Monky game certification');
    for (const key of ['screenShare.gameGuideUseNormal', 'screenShare.gameGuideAttention']) {
      assert.ok(intro.includes(f.i18n.t(key)), 'The recommendation must explain both exception groups shown in the guide');
    }
    assert.equal(picker.inert, true);
    assert.equal(opener.getAttribute('aria-expanded'), 'true');
    assert.equal(f.document.activeElement, search);
    assert.equal(guide.querySelectorAll('[data-game-guide-entry]').length, 14);
    assert.equal(guide.querySelectorAll('[data-game-guide-group="normal"] [data-game-guide-entry]').length, 5);
    assert.equal(guide.querySelectorAll('[data-game-guide-group="attention"] [data-game-guide-entry]').length, 9);
    await f.picker.startSharing('replace');
    assert.equal(nativeStarts(f).length, 0, 'The parent cannot confirm capture while the guide is open');
    search.value = 'gta sa';
    search.dispatchEvent(new Event('input'));
    assert.equal(guide.querySelector('[data-game-guide-entry]').dataset.gameGuideEntry, 'gta-san-andreas');
    assert.equal(control(f, 'game-capture-guide-count').textContent, f.i18n.t('screenShare.gameGuideResultsCount', { count: 1 }));
    search.value = 'TLOU2 <img src=x onerror=bad()>';
    search.dispatchEvent(new Event('input'));
    assert.equal(guide.querySelectorAll('[data-game-guide-entry]').length, 0);
    const noResults = guide.querySelector('.game-capture-guide-empty').textContent;
    assert.equal(noResults, f.i18n.t('screenShare.gameGuideNoResults'));
    assert.match(noResults, language === 'pt-BR' ? /Tente Captura de jogo primeiro/ : /Try Game Capture first/);
    assert.equal(guide.querySelector('img'), null);
    assert.equal(f.document.activeElement, search);
    key(search, 'Enter');
    assert.equal(nativeStarts(f).length, 0, 'Searching or pressing Enter must not confirm the underlying picker');
    close.focus();
    assert.equal(key(close, 'Tab').defaultPrevented, true);
    assert.equal(f.document.activeElement, first);
    assert.equal(key(first, 'Tab', { shiftKey: true }).defaultPrevented, true);
    assert.equal(f.document.activeElement, close);
    search.focus();
    assert.equal(key(search, 'Escape').defaultPrevented, true);
    assert.equal(f.picker.modalEl, picker);
    assert.equal(picker.inert, false);
    assert.equal(opener.getAttribute('aria-expanded'), 'false');
    assert.equal(opener.getAttribute('aria-controls'), null);
    assert.equal(f.document.activeElement, opener);
    assert.equal(f.picker.selectedSourceId, 'window:101:0');
    assert.equal(f.picker.windowCaptureMethod, 'game', 'Advisory entries are not a whitelist and cannot change the chosen method');
    assert.equal(f.document.querySelector('[data-source-id="window:101:0"]'), selectedCard);
    assert.equal(control(f, 'chk-share-audio').checked, false);
    assert.equal(control(f, 'chk-preserve-aspect-ratio').checked, true);
    assert.equal(JSON.stringify([f.settingsStore.qualityPreset, f.settingsStore.customProfile, f.settingsStore.preferredVideoCodec]), quality);
    assert.equal(f.enumerations, enumerations);
    assert.equal(f.traces.length, 0, 'No probe, capture, external navigation or transport work runs while browsing');
    assert.equal(f.capabilities.capture, false);
    assert.ok([...guide.listeners.values(), ...search.listeners.values(), ...close.listeners.values()].every(listeners => listeners.size === 0));
    opener.click();
    const nextGuide = control(f, 'game-capture-guide');
    assert.equal(control(f, 'game-capture-guide-search').value, '');
    search.value = 'CS2';
    search.dispatchEvent(new Event('input'));
    close.click();
    assert.equal(nextGuide.querySelectorAll('[data-game-guide-entry]').length, 14, 'Detached controls cannot search or close a new guide');
    f.picker.close();
    assert.equal(nextGuide.isConnected, false);
    assert.equal(f.document.querySelectorAll('.modal-backdrop').length, 0, 'Closing the picker must dispose its child guide');
    opener.click();
    assert.equal(f.document.querySelector('#game-capture-guide'), null, 'A detached opener cannot reopen a guide');
  });
}

test('the guide uses only the fixed official link through the existing bridge and exposes failures without stale updates', async t => {
  const f = fixture();
  t.after(() => f.close());
  await f.picker.open();
  const opener = control(f, 'btn-game-capture-guide');
  opener.click();
  const source = control(f, 'game-capture-guide-source');
  const url = 'https://obsproject.com/kb/game-capture-troubleshooting';
  assert.equal(source.getAttribute('href'), url);
  assert.ok(source.textContent.includes('obsproject.com'));
  source.setAttribute('href', 'javascript:bad()');
  const click = new Event('click', { bubbles: true, cancelable: true });
  source.dispatchEvent(click);
  await flush();
  assert.equal(click.defaultPrevented, true);
  assert.deepEqual(f.traces, [['open-external', url]], 'Navigation must use the trusted constant, not altered DOM data');
  f.controls.openExternal = async () => ({ success: false });
  source.click();
  await flush();
  const failure = control(f, 'game-capture-guide-link-error');
  assert.equal(failure.hidden, false);
  assert.equal(failure.getAttribute('role'), 'alert');
  assert.equal(failure.textContent, f.i18n.t('screenShare.gameGuideSourceError'));
  assert.equal(f.warnings.length, 1);
  const gate = deferred();
  f.controls.openExternal = () => gate.promise;
  source.click();
  const calls = f.traces.length;
  assert.equal(source.getAttribute('aria-busy'), 'true');
  source.click();
  assert.equal(f.traces.length, calls, 'Repeated activation must not duplicate an in-flight external opening');
  control(f, 'game-capture-guide-close').click();
  opener.click();
  gate.reject(new Error('Expected delayed navigation failure'));
  await flush();
  assert.equal(control(f, 'game-capture-guide-link-error').hidden, true, 'A closed guide must not report a stale error in its replacement');
  assert.equal(control(f, 'game-capture-guide-source').getAttribute('aria-busy'), null);
  delete f.api.openExternal;
  control(f, 'game-capture-guide-source').click();
  await flush();
  assert.equal(control(f, 'game-capture-guide-link-error').hidden, false, 'A missing safe bridge is an explicit error, not window.open fallback');
  assert.equal(f.traces.length, calls);
  assert.equal(nativeStarts(f).length, 0);
});

test('the guide remains device-free during enumeration without selecting an unsupported tab or source', async t => {
  const f = fixture();
  t.after(() => f.close());
  const gate = deferred();
  f.controls.capabilities = () => gate.promise;
  const opening = f.picker.open();
  control(f, 'btn-game-capture-guide').click();
  assert.equal(f.document.querySelectorAll('[data-game-guide-entry]').length, 14);
  Object.assign(f.capabilities, { captureKinds: ['monitor'] });
  gate.resolve(f.capabilities);
  await opening;
  assert.equal(f.picker.activeTab, 'window');
  assert.equal(control(f, 'share-tab-window').disabled, true);
  assert.equal(control(f, 'share-tab-screen').disabled, false);
  control(f, 'game-capture-guide-close').click();
  assert.equal(f.document.activeElement, control(f, 'btn-game-capture-guide'));
  control(f, 'share-tab-screen').click();
  assert.equal(control(f, 'btn-game-capture-guide').hidden, true);
  control(f, 'btn-game-capture-guide').click();
  assert.equal(f.document.querySelector('#game-capture-guide'), null, 'An inactive source tab cannot reopen its hidden guide');
  assert.equal(f.picker.selectedSourceId, null);
  assert.equal(control(f, 'btn-share').disabled, true);
  assert.equal(f.traces.length, 0);
});

test('a source removed by an in-flight refresh stays unselected when its guide closes', async t => {
  const f = fixture();
  t.after(() => f.close());
  await f.picker.open();
  chooseWindowMethod(f, 'game');
  control(f, 'chk-preserve-aspect-ratio').checked = true;
  const gate = deferred();
  f.controls.sources = () => gate.promise;
  control(f, 'btn-refresh-sources').focus();
  const refreshing = f.picker.loadSources(f.picker.modalEl);
  control(f, 'btn-game-capture-guide').click();
  const search = control(f, 'game-capture-guide-search');
  gate.resolve(f.sources.filter(source => source.id !== 'window:101:0'));
  await refreshing;
  assert.equal(f.document.activeElement, search, 'Completing the parent refresh cannot steal focus from the guide');
  assert.equal(f.picker.selectedSourceId, null);
  assert.equal(control(f, 'btn-share').disabled, true);
  control(f, 'game-capture-guide-close').click();
  assert.equal(f.picker.selectedSourceId, null, 'Closing help cannot resurrect or replace a vanished source');
  assert.equal(control(f, 'btn-share').disabled, true);
  assert.equal(control(f, 'chk-preserve-aspect-ratio').checked, true);
  assert.equal(f.document.activeElement, control(f, 'btn-game-capture-guide'));
  assert.equal(f.traces.length, 0);
});

test('new capture/codec/preview copy has matching translations and placeholders', t => {
  const f = fixture();
  t.after(() => f.close());
  const en = f.load('i18n/locales/en').en;
  const pt = f.load('i18n/locales/pt-BR').ptBR;
  const relevant = key => key.startsWith('screenShare.') || key.startsWith('settings.codec')
    || key.startsWith('settings.screenPreview') || key.startsWith('settings.videoCodec') || key.startsWith('stage.captureMode');
  assert.deepEqual(Object.keys(en).filter(relevant).sort(), Object.keys(pt).filter(relevant).sort());
  for (const key of Object.keys(en).filter(relevant)) {
    assert.deepEqual((en[key].match(/\{\w+\}/g) ?? []).sort(), (pt[key].match(/\{\w+\}/g) ?? []).sort(), key);
  }
  assert.ok(!en['screenShare.nativeBackend'].includes('starts when someone watches'));
  assert.ok(!pt['screenShare.nativeBackend'].includes('começa quando alguém assiste'));
  assert.ok(!en['screenShare.platformSoon'].includes('AMD'));
  assert.ok(!pt['screenShare.platformSoon'].includes('AMD'));
  assert.ok(!en['settings.videoCodecDesc'].includes('VP9'));
  assert.ok(!pt['settings.videoCodecDesc'].includes('VP9'));
  for (const locale of [en, pt]) {
    for (const key of Object.keys(locale).filter(key => key.startsWith('screenShare.'))) {
      assert.doesNotMatch(locale[key], /\bWGC\b|\bhook\b/i, key);
    }
    assert.equal(Object.hasOwn(locale, 'stage.captureModePending'), false);
    assert.equal(Object.hasOwn(locale, 'stage.captureModeUnconfirmed'), false);
  }
});
