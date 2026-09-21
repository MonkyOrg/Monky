'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, deferred, flush, MONITOR_SOURCE_ID } = require('./fixtures/screenSharingUiModel.cjs');

const key = (element, value) => {
  const event = new Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'key', { value });
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

for (const language of ['pt-BR', 'en']) {
  test(`capture methods are localized, accessible and do not identify windows as detected games (${language})`, async t => {
    const f = fixture(language);
    t.after(() => f.close());
    f.sources[1].name = 'Application <script>bad()</script> & "title"';
    f.sources[1].thumbnailDataUrl = 'data:image/png;base64,test" onerror="bad()';
    f.sources[1].appIconDataUrl = 'data:image/png;base64,icon" onerror="bad()';
    await f.picker.open();
    const tabs = f.document.querySelectorAll('[role="tab"]');
    assert.equal(tabs.length, 3);
    assert.ok(f.document.querySelector('[role="tablist"]'));
    assert.equal(control(f, 'share-tab-window').getAttribute('aria-selected'), 'true');
    assert.equal(control(f, 'share-tab-window').tabIndex, 0);
    assert.equal(control(f, 'share-tab-game').tabIndex, -1);
    assert.equal(control(f, 'share-tab-window').getAttribute('aria-controls'), 'share-sources-panel');
    assert.equal(control(f, 'share-tab-window').textContent.includes(language === 'en' ? 'Windows' : 'Janelas'), true);
    assert.equal(control(f, 'share-tab-game').textContent.includes(language === 'en' ? 'Games' : 'Jogos'), true);
    assert.equal(f.document.querySelectorAll('.source-item').length, 2);
    assert.equal(key(control(f, 'share-tab-window'), 'ArrowRight').defaultPrevented, true);
    assert.equal(f.picker.activeTab, 'game');
    assert.equal(f.document.activeElement, control(f, 'share-tab-game'));
    assert.equal(control(f, 'share-sources-panel').getAttribute('aria-labelledby'), 'share-tab-game');
    assert.equal(control(f, 'share-tab-game').getAttribute('aria-selected'), 'true');
    assert.ok(control(f, 'share-sources-panel').textContent.includes(f.i18n.t('screenShare.gameCompatibility')));
    assert.equal(f.document.querySelectorAll('.source-item').length, 2, 'Games lists candidate application windows, not a guessed executable whitelist');
    assert.ok(control(f, 'share-sources-panel').innerHTML.includes('&lt;script&gt;'));
    assert.equal(f.document.querySelector('[onerror]'), null, 'Source metadata cannot inject an attribute');
    assert.equal(f.document.querySelector('script'), null);
    const card = f.document.querySelector('.source-item');
    assert.equal(key(card, ' ').defaultPrevented, true);
    assert.equal(card.getAttribute('aria-pressed'), 'true');
    assert.equal(control(f, 'btn-share').disabled, false);
    key(control(f, 'share-tab-game'), 'ArrowRight');
    assert.equal(f.picker.activeTab, 'screen');
    assert.equal(f.picker.selectedSourceId, null, 'Switching methods requires an explicit source selection');
    assert.equal(control(f, 'btn-share').disabled, true);
    assert.equal(f.document.querySelectorAll('.source-item').length, 1);
    assert.equal(control(f, 'share-audio-text').textContent, f.i18n.t('screenShare.shareAudio'));
    key(control(f, 'share-tab-screen'), 'End');
    assert.equal(f.picker.activeTab, 'game');
    assert.equal(control(f, 'share-audio-text').textContent, f.i18n.t('screenShare.shareAppAudio'));
    key(control(f, 'share-tab-game'), 'Home');
    assert.equal(f.picker.activeTab, 'screen');
    key(control(f, 'share-tab-screen'), 'ArrowLeft');
    assert.equal(f.picker.activeTab, 'game');
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

  test(`explicit selection probing is clearly pending and never runs on open or card selection (${language})`, async t => {
    const f = fixture(language);
    t.after(() => f.close());
    Object.assign(f.capabilities, { capture: false, backend: null, requiresSelectionProbe: true });
    await f.picker.open();
    for (const tab of f.document.querySelectorAll('[role="tab"]')) {
      assert.equal(tab.disabled, false);
      assert.equal(tab.title, f.i18n.t('screenShare.probePending'));
      assert.equal(tab.getAttribute('aria-describedby'), tab.getAttribute('aria-selected') === 'true' ? 'share-capture-info' : null);
      assert.equal(tab.querySelector('.share-tab-status').hidden, false);
      assert.equal(tab.querySelector('.share-tab-status').textContent, f.i18n.t('screenShare.probePending'));
    }
    const profile = f.load('core/VideoService').videoService.getProfile();
    const info = control(f, 'share-capture-info');
    assert.equal(info.dataset.backend, 'probe-pending');
    assert.equal(info.textContent, f.i18n.t('screenShare.nativeProbePending', {
      width: profile.screenWidth, height: profile.screenHeight, fps: profile.screenFps, bitrate: profile.screenBitrateKbps,
    }));
    assert.equal(control(f, 'btn-share').disabled, true, 'A pending probe still needs an explicit source');
    f.document.querySelector('.source-item').click();
    assert.equal(control(f, 'btn-share').disabled, false, 'Confirmation may prepare exactly the selected source');
    assert.equal(info.dataset.backend, 'probe-pending', 'Selecting a card is not hardware verification');
    assert.equal(f.traces.length, 0, 'Enumeration/card selection must not prepare a window, probe, capture or publish');
    assert.equal(f.capabilities.capture, false);
    assert.equal(f.capabilities.backend, null);
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

test('legacy capability fixtures enable only windows; explicit empty/unsupported kinds never enable capture', async t => {
  const f = fixture();
  t.after(() => f.close());
  delete f.capabilities.captureKinds;
  await f.picker.open();
  assert.equal(control(f, 'share-tab-window').disabled, false);
  for (const id of ['screen', 'game']) {
    const button = control(f, `share-tab-${id}`);
    assert.equal(button.disabled, true);
    assert.equal(button.tabIndex, -1);
    assert.equal(button.getAttribute('aria-describedby'), 'share-method-reasons');
    assert.ok(button.title.includes('native backend'));
    assert.ok(control(f, 'share-method-reasons').textContent.includes(button.title));
    button.click();
    assert.equal(f.picker.activeTab, 'window');
  }
  key(control(f, 'share-tab-window'), 'ArrowLeft');
  assert.equal(f.picker.activeTab, 'window');
  f.capabilities.captureKinds = ['window', 'game'];
  await f.picker.open();
  key(control(f, 'share-tab-window'), 'ArrowLeft');
  assert.equal(f.picker.activeTab, 'game', 'Keyboard skips the disabled monitor method');
  const previousEnumerations = f.enumerations;
  f.capabilities.captureKinds = [];
  await f.picker.open();
  assert.equal(f.enumerations, previousEnumerations);
  assert.equal(f.document.querySelectorAll('[role="tab"]').every(tab => tab.disabled), true);
  assert.equal(f.picker.activeTab, 'game', 'An unavailable game selection never falls back to windows');
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
  assert.equal(control(f, 'share-tab-game').disabled, true);
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
  ['game', 'game', `window:101:${'b'.repeat(64)}`],
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
    assert.equal(control(f, 'share-capture-info').dataset.backend, 'probe-pending');
    assert.equal(nativeStarts(f).length, 0);
    await f.picker.startSharing('replace');
    assert.deepEqual(nativeStarts(f), [['native-start', sourceId, true, '', kind]]);
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
  control(f, 'share-tab-game').click();
  f.document.querySelector('.source-item').click();
  await f.picker.startSharing('replace');
  assert.equal(nativeStarts(f).length, 1);
  assert.equal(nativeStarts(f)[0][4], 'game');
  assert.equal(f.picker.activeTab, 'game');
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
  ['screen', 'monitor', MONITOR_SOURCE_ID], ['window', 'window', 'window:101:0'], ['game', 'game', 'window:101:0'],
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
    assert.equal(control(f, 'btn-share-add').disabled, false);
    await f.picker.startSharing('add');
    assert.deepEqual(nativeStarts(f), [['native-start', sourceId, true, 'data:image/png;base64,selected', kind]]);
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

test('failed Game Capture preserves existing shares and never tries a different source, method or Chromium', async t => {
  const f = fixture();
  t.after(() => f.close());
  const previous = f.createStream('window:303:0');
  f.voiceStore.addScreenShare(previous.id);
  f.controls.start = async () => { throw new Error('Game capture is incompatible with the selected application'); };
  await f.picker.open();
  control(f, 'share-tab-game').click();
  f.document.querySelector('[data-source-id="window:101:0"]').click();
  await f.picker.startSharing('replace');
  assert.equal(nativeStarts(f).length, 1);
  assert.equal(nativeStarts(f)[0][4], 'game');
  assert.equal(f.picker.activeTab, 'game');
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
  control(f, 'share-tab-game').click();
  assert.equal(f.picker.selectSource('window:202:0'), false, 'Changing methods does not make an active source available again');
  f.picker.selectedSourceId = 'window:missing:0';
  await f.picker.startSharing('replace');
  assert.equal(nativeStarts(f).length, 0);
  assert.ok(f.alerts[0].message.includes(f.i18n.t('screenShare.sourceUnavailable')));
  assert.equal(control(f, 'btn-share').disabled, true);
});

test('an empty Games result never selects a display or relabels another capture method', async t => {
  const f = fixture();
  t.after(() => f.close());
  await f.picker.open();
  control(f, 'share-tab-game').click();
  f.controls.sources = async () => [f.sources[0]];
  await f.picker.loadSources(f.picker.modalEl);
  assert.equal(f.picker.activeTab, 'game');
  assert.equal(control(f, 'share-tab-game').getAttribute('aria-selected'), 'true');
  assert.equal(f.document.querySelector('.source-item'), null);
  assert.ok(control(f, 'share-sources-panel').textContent.includes(f.i18n.t('screenShare.noGameWindows')));
  assert.equal(control(f, 'btn-share').disabled, true);
  assert.equal(nativeStarts(f).length, 0);
});

test('Games offers only a manual same-window alternative when Window Capture selection is allowed', async t => {
  const f = fixture();
  t.after(() => f.close());
  f.capabilities.captureKinds = ['game'];
  await f.picker.open();
  control(f, 'share-tab-game').click();
  assert.equal(control(f, 'share-tab-window').disabled, true);
  assert.equal(control(f, 'share-sources-panel').textContent.includes(f.i18n.t('screenShare.gameWindowAlternative')), false);
  f.capabilities.captureKinds = ['game', 'window'];
  await f.picker.open();
  assert.equal(control(f, 'share-tab-window').disabled, false);
  assert.ok(control(f, 'share-sources-panel').textContent.includes(f.i18n.t('screenShare.gameWindowAlternative')));
  assert.equal(f.picker.activeTab, 'game', 'Showing the hint does not switch capture methods');
  assert.equal(f.picker.selectedSourceId, null, 'The alternative still requires an explicit source selection');
  assert.equal(nativeStarts(f).length, 0);
});

test('double-click retains the replace shortcut without starting a second native operation', async t => {
  const f = fixture();
  t.after(() => f.close());
  const previous = f.createStream('window:303:0');
  f.voiceStore.addScreenShare(previous.id);
  await f.picker.open();
  control(f, 'share-tab-game').click();
  const card = f.document.querySelector('.source-item');
  card.click();
  card.dispatchEvent(new Event('dblclick', { bubbles: true }));
  card.dispatchEvent(new Event('dblclick', { bubbles: true }));
  await flush();
  assert.equal(nativeStarts(f).length, 1);
  assert.equal(nativeStarts(f)[0][4], 'game');
  assert.equal(f.voiceStore.screenShareIds.length, 1);
  assert.equal(f.streams.has(previous.id), false);
  assert.equal(f.picker.modalEl, null);
});

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
  const gate = deferred();
  let wanted;
  f.controls.start = request => { wanted = request.isWanted; return gate.promise; };
  await f.picker.open();
  control(f, 'share-tab-game').click();
  f.document.querySelector('.source-item').click();
  const oldRoot = f.picker.modalEl;
  const oldTab = control(f, 'share-tab-screen');
  const pending = f.picker.startSharing('replace');
  await flush();
  assert.equal(f.picker.isStarting, true);
  assert.equal(control(f, 'chk-share-audio').disabled, true);
  assert.ok(f.document.querySelectorAll('[role="tab"]').every(tab => tab.disabled));
  f.picker.selectTab('screen');
  assert.equal(f.picker.activeTab, 'game');
  assert.equal(f.picker.selectSource('window:202:0'), false);
  await f.picker.startSharing('replace');
  assert.equal(nativeStarts(f).length, 1);
  f.picker.close();
  assert.equal(f.cancelled, 1);
  assert.equal(wanted(), false);
  assert.ok([...oldRoot.listeners.values()].every(listeners => listeners.size === 0));
  assert.ok([...oldTab.listeners.values()].every(listeners => listeners.size === 0));
  await f.picker.open();
  const current = f.picker.modalEl;
  oldTab.dispatchEvent(new Event('click'));
  assert.equal(f.picker.activeTab, 'game', 'Detached tabs cannot mutate a reopened picker');
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
  control(f, 'share-tab-game').click();
  const panel = control(f, 'share-sources-panel');
  oldSources.resolve([f.source('window:999:0', 'window')]);
  await oldOpening;
  assert.ok(panel.querySelector('.loading-skeleton'));
  assert.equal(panel.querySelector('[data-source-id="window:999:0"]'), null);
  currentSources.resolve(f.sources);
  await currentOpening;
  assert.equal(f.picker.activeTab, 'game', 'The method selected while enumerating is preserved');
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

test('new capture/codec/preview copy has matching translations and placeholders', t => {
  const f = fixture();
  t.after(() => f.close());
  const en = f.load('i18n/locales/en').en;
  const pt = f.load('i18n/locales/pt-BR').ptBR;
  const relevant = key => key.startsWith('screenShare.') || key.startsWith('settings.codec')
    || key.startsWith('settings.screenPreview') || key.startsWith('settings.videoCodec');
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
});
