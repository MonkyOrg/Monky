'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fixture, deferred, flush } = require('./fixtures/screenSharingUiModel.cjs');
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
  const reopened = control(f, '[data-audience-id="member-499"]');
  assert.notEqual(reopened, user, 'Reopening rebuilds the list with the members the server knows now');
  assert.equal(reopened.getAttribute('aria-selected'), 'true');
  reopened.click();
  assert.equal(reopened.getAttribute('aria-selected'), 'false');
  control(f, '#share-picker-title').dispatchEvent(new Event('pointerdown', { bubbles: true }));
  assert.equal(control(f, '#share-audience-popup').hidden, true, 'outside pointer closes the popup, not the modal');
  key(trigger, 'ArrowDown');
  assert.equal(control(f, '#share-audience-popup').hidden, false);
  toggle(f, false);
  assert.equal(control(f, '#share-audience-popup').hidden, true);
});

test('a private share names at most the server limits, and nothing changes while it starts', async t => {
  const f = fixture();
  t.after(() => f.close());
  f.serverStore.knownMembers = new Map(Array.from({ length: 260 }, (_, index) => [
    `member-${index}`, { id: `member-${index}`, nickname: `Member ${String(index).padStart(3, '0')}` },
  ]));
  // The share being switched already names as many members as the server accepts.
  const live = f.createStream('window:202:0');
  f.captures.get(live.id).source.audience = { userIds: Array.from({ length: 256 }, (_, index) => `member-${index}`), roleIds: [] };
  f.voiceStore.screenShareIds = [live.id];
  await f.picker.open();
  control(f, '[data-source-id="window:101:0"]').click();
  control(f, '#share-audience-toggle').click();
  const members = f.document.querySelectorAll('[data-audience-kind="user"]');
  assert.ok(members.slice(0, 256).every(member => member.getAttribute('aria-selected') === 'true'));
  assert.ok(members.slice(256).every(member => member.disabled), 'The server refuses a 257th member, so it cannot be picked');
  members[0].click();
  assert.equal(members[256].disabled, false, 'Removing one member makes room for another');
  members[256].click();
  const gate = deferred();
  f.controls.start = () => gate.promise;
  const starting = f.picker.startSharing('replace');
  await flush();
  assert.equal(control(f, '#chk-private-share').disabled, true);
  assert.equal(control(f, '#share-audience-toggle').disabled, true);
  assert.equal(control(f, '#share-audience-popup').hidden, true, 'The list closes while the share starts');
  assert.ok(f.document.querySelectorAll('[data-audience-id]').every(option => option.disabled));
  gate.resolve(f.createStream('window:101:0'));
  await starting;
  const start = f.traces.find(value => value[0] === 'native-start');
  assert.equal(start.at(-1).userIds.length, 256);
  assert.ok(start.at(-1).userIds.includes('member-256') && !start.at(-1).userIds.includes('member-0'));
});

const chosen = f => f.document.querySelectorAll('[data-audience-id]')
  .filter(option => option.getAttribute('aria-selected') === 'true').map(option => option.getAttribute('data-audience-id'));
const lastStart = f => JSON.parse(JSON.stringify(f.traces.filter(value => value[0] === 'native-start').at(-1)));

test('switching Private off and on keeps who was chosen for a new share, and off sends none of them', async t => {
  const f = fixture();
  t.after(() => f.close());
  await f.picker.open();
  control(f, '.source-item').click();
  toggle(f, true);
  control(f, '#share-audience-toggle').click();
  control(f, '[data-audience-id="allowed"]').click();
  control(f, '[data-audience-id="friends"]').click();
  toggle(f, false);
  assert.equal(control(f, '#btn-share').disabled, false, 'Switched off, the share is public and can start');
  toggle(f, true);
  assert.deepEqual(chosen(f).sort(), ['allowed', 'friends'], 'Switching back on restores the choice');
  assert.equal(control(f, '#share-audience-status').textContent, f.i18n.t('screenShare.privateSelected', { count: 2 }));
  assert.equal(control(f, '#btn-share').disabled, false);
  toggle(f, false);
  await f.picker.startSharing('replace');
  assert.equal(lastStart(f).length, 5, 'A share started public names nobody, not even the choice set aside');
});

test('switching Private off and on keeps the audience of the share whose source changes', async t => {
  const f = fixture();
  t.after(() => f.close());
  f.serverStore.knownMembers = new Map(Array.from({ length: 40 }, (_, index) => [
    `member-${index}`, { id: `member-${index}`, nickname: `Member ${String(index).padStart(2, '0')}` },
  ]));
  const audience = { userIds: Array.from({ length: 40 }, (_, index) => `member-${index}`), roleIds: ['friends'] };
  const live = f.createStream('window:202:0');
  f.captures.get(live.id).source.audience = audience;
  f.voiceStore.screenShareIds = [live.id];
  await f.picker.open();
  control(f, '[data-source-id="window:101:0"]').click();
  assert.equal(control(f, '#chk-private-share').checked, true);
  toggle(f, false);
  toggle(f, true);
  assert.equal(chosen(f).length, 41, 'The 40 members and the role of the live share come back');
  await f.picker.startSharing('replace');
  assert.deepEqual(lastStart(f).at(-1), audience, 'The new source keeps exactly the same audience');
});