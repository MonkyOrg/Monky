'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, flush } = require('./fixtures/screenSharingUiModel.cjs');
const control = (f, selector) => {
  const element = f.document.querySelector(selector);
  assert.ok(element, selector);
  return element;
};
const toggle = (f, checked) => {
  const input = control(f, '#chk-private-share');
  input.checked = checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
};
const key = (element, value) => {
  const event = new Event('keydown', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'key', { value });
  element.dispatchEvent(event);
  return event;
};

for (const language of ['pt-BR', 'en']) {
  test(`private picker is public by default, searchable, selectable and empty-private stays closed (${language})`, async t => {
    const f = fixture(language);
    t.after(() => f.close());
    await f.picker.open();
    control(f, '.source-item').click();
    assert.equal(control(f, '#chk-private-share').checked, false);
    assert.equal(control(f, '#chk-private-share').getAttribute('role'), 'switch');
    assert.equal(control(f, '#chk-private-share').parentElement.className, 'toggle-switch');
    assert.equal(control(f, '#share-audience').hidden, true);
    assert.equal(f.document.querySelector('[data-audience-id]'), null, 'public source enumeration does not build a member picker');
    toggle(f, true);
    assert.equal(control(f, '#share-audience-popup').hidden, true);
    assert.equal(control(f, '#share-audience-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(control(f, '#share-audience-options').getAttribute('aria-multiselectable'), 'true');
    assert.equal(control(f, '#btn-share').disabled, true);
    assert.equal(control(f, '#share-audience-status').textContent, f.i18n.t('screenShare.privateEmpty'));
    await f.picker.startSharing('replace');
    assert.equal(f.traces.some(value => value[0] === 'native-start'), false);
    assert.equal(f.document.activeElement, control(f, '#share-audience-search'));
    const search = control(f, '#share-audience-search');
    search.value = 'alice';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    const alice = control(f, '[data-audience-id="allowed"]');
    assert.equal(alice.hidden, false);
    assert.equal(control(f, '[data-audience-id="outsider"]').hidden, true);
    assert.equal(alice.tagName, 'BUTTON', 'real buttons retain native Enter/Space activation');
    assert.equal(key(search, 'ArrowDown').defaultPrevented, true);
    assert.equal(f.document.activeElement, alice, 'keyboard navigation skips filtered-out users and roles');
    alice.click();
    assert.equal(f.document.activeElement, alice, 'selection updates do not replace focused controls');
    assert.equal(alice.getAttribute('aria-selected'), 'true');
    assert.equal(control(f, '#btn-share').disabled, false);
    search.value = 'friends';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    control(f, '[data-audience-id="friends"]').click();
    assert.equal(alice.getAttribute('aria-selected'), 'true', 'search does not clear selected users');
    assert.equal(control(f, '[data-audience-id="friends"]').getAttribute('aria-selected'), 'true');
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    alice.focus();
    key(alice, 'End');
    assert.equal(f.document.activeElement, control(f, '[data-audience-id="outsider"]'));
    key(f.document.activeElement, 'Home');
    assert.equal(f.document.activeElement, control(f, '[data-audience-id="admin"]'));
    assert.equal(control(f, '[data-audience-id="admin"]').getAttribute('aria-selected'), 'false', 'navigation never grants access');
    search.value = 'unmatched';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(control(f, '#share-audience-no-results').hidden, false);
    await f.picker.startSharing('replace');
    const start = f.traces.find(value => value[0] === 'native-start');
    assert.deepEqual(JSON.parse(JSON.stringify(start.at(-1))), { userIds: ['allowed'], roleIds: ['friends'] });
    assert.equal(f.voiceStore.voice, 'preserved-call');
    assert.equal(f.voiceStore.camera, 'preserved-camera');
  });

  test(`private audience survives source replacement and resets after stopping (${language})`, async t => {
    const f = fixture(language);
    t.after(() => f.close());
    await f.picker.open();
    control(f, '.source-item').click();
    toggle(f, true);
    control(f, '#share-audience-toggle').click();
    control(f, '[data-audience-id="friends"]').click();
    await f.picker.startSharing('replace');
    await f.picker.open();
    assert.equal(control(f, '#chk-private-share').checked, true);
    assert.equal(control(f, '[data-audience-id="friends"]').getAttribute('aria-selected'), 'true');
    control(f, '[data-source-id="window:202:0"]').click();
    await f.picker.startSharing('replace');
    assert.deepEqual(JSON.parse(JSON.stringify(f.traces.filter(value => value[0] === 'native-start').at(-1).at(-1))),
      { userIds: [], roleIds: ['friends'] });
    f.captures.clear();
    f.voiceStore.screenShareIds = [];
    await f.picker.open();
    assert.equal(control(f, '#chk-private-share').checked, false);
    toggle(f, true);
    assert.equal(control(f, '#btn-share').disabled, true);
    toggle(f, false);
    f.picker.close();
    await flush();
    assert.equal(f.document.querySelector('#share-audience'), null);
  });
}

test('audience dropdown stays compact with 500 members/20 roles and preserves rich selections', async t => {
  const f = fixture();
  t.after(() => f.close());
  f.serverStore.roles = Array.from({ length: 20 }, (_, index) => ({
    id: `role-${index}`, name: `Role ${String(index).padStart(2, '0')}`, color: index ? '#3ba55d' : '#ed4245',
  }));
  f.serverStore.knownMembers = new Map(Array.from({ length: 500 }, (_, index) => [
    `member-${index}`, { id: `member-${index}`, nickname: `Member ${String(index).padStart(3, '0')}`, avatarUrl: `/avatars/${index}.png` },
  ]));
  f.serverStore.knownMembers.set('self', { id: 'self', nickname: 'Me' });
  f.serverStore.knownMembers.set('bot', { id: 'bot', nickname: 'Bot', isBot: true });
  await f.picker.open();
  toggle(f, true);
  const trigger = control(f, '#share-audience-toggle');
  assert.equal(control(f, '#share-audience-popup').hidden, true);
  assert.equal(f.document.querySelectorAll('[data-audience-id]').length, 520);
  trigger.click();
  assert.equal(f.document.activeElement, control(f, '#share-audience-search'));
  assert.equal(control(f, '#share-audience-popup').hidden, false);
  const role = control(f, '[data-audience-id="role-0"]');
  assert.equal(role.querySelector('.share-audience-role').style['--role-color'], '#ed4245');
  role.click();
  const user = control(f, '[data-audience-id="member-499"]');
  assert.equal(user.querySelector('img').getAttribute('src'), 'http://127.0.0.1:9999/avatars/499.png');
  assert.equal(user.querySelector('img').getAttribute('loading'), 'lazy');
  user.click();
  control(f, '[data-audience-id="member-0"]').click();
  assert.equal(f.document.querySelectorAll('.share-audience-chip').length, 2);
  assert.equal(control(f, '.share-audience-more').textContent, '+1');
  assert.ok(control(f, '#share-audience-summary').querySelector('img'));
  assert.ok(control(f, '#share-audience-summary').querySelector('.share-audience-role'));
  const search = control(f, '#share-audience-search');
  search.value = 'member 499';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(f.document.querySelectorAll('[data-audience-id]').filter(row => !row.hidden).length, 1);
  assert.equal(control(f, '#share-audience-roles').parentElement.hidden, true);
  key(search, 'ArrowDown');
  assert.equal(f.document.activeElement, user);
  assert.equal(user.lastScrollIntoView.block, 'nearest');
  const escape = key(user, 'Escape');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(control(f, '#share-audience-popup').hidden, true);
  assert.equal(f.document.activeElement, trigger);
  assert.ok(f.document.querySelector('#share-picker-title'), 'Escape closes only the dropdown first');
  trigger.click();
  assert.equal(user.getAttribute('aria-selected'), 'true');
  user.click();
  assert.equal(user.getAttribute('aria-selected'), 'false');
  control(f, '#share-picker-title').dispatchEvent(new Event('pointerdown', { bubbles: true }));
  assert.equal(control(f, '#share-audience-popup').hidden, true, 'outside pointer closes the popup, not the modal');
  key(trigger, 'ArrowDown');
  assert.equal(control(f, '#share-audience-popup').hidden, false);
  toggle(f, false);
  assert.equal(control(f, '#share-audience-popup').hidden, true);
});
