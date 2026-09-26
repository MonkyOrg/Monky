'use strict';

module.exports = { runScreenAudienceSmoke };

async function runScreenAudienceSmoke() {
  let checks = 0, mediaRequests = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const settle = async () => { await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); };
  const media = navigator.mediaDevices;
  const originalMedia = { getUserMedia: media.getUserMedia, getDisplayMedia: media.getDisplayMedia };
  const deny = async () => { mediaRequests++; throw new Error('Audience UI must never request media.'); };
  media.getUserMedia = deny;
  media.getDisplayMedia = deny;
  const [{ ScreenSharePickerModal }, { webRtcManager }, language] = await Promise.all([
    import('/views/ScreenSharePickerModal.ts'), import('/core/WebRtcManager.ts'), import('/i18n/index.ts'),
  ]);
  const originalApi = window.api, originalCapabilities = webRtcManager.getNativeScreenCapabilities;
  const originalLanguage = language.getLanguage();
  const avatar = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="16" fill="#5865f2"/><circle cx="16" cy="12" r="6" fill="#fff"/><path d="M5 30a11 11 0 0 1 22 0" fill="#fff"/></svg>');
  webRtcManager.getNativeScreenCapabilities = async () => ({
    capture: true, captureAudio: true, receive: true, captureKinds: ['window', 'monitor', 'game'], backend: 'libobs-amf', reason: null,
  });
  window.api = {
    platform: 'win32',
    nativeScreenCommand: deny,
    getDesktopSources: async () => [{ id: 'window:1', type: 'window', name: 'Owned fixture', thumbnailDataUrl: '', appIconDataUrl: null }],
    getDesktopSourcePreviews: async () => [],
  };
  let picker, preview = '', previewScroll = 0;
  try {
    for (const locale of ['pt-BR', 'en']) {
      document.body.replaceChildren();
      language.setLanguage(locale);
      picker = new ScreenSharePickerModal();
      await picker.open();
      picker.pickerCall = {
        isCurrent: () => true, client: null,
        serverStore: {
          currentUser: { id: 'self' },
          roles: Array.from({ length: 20 }, (_, index) => ({
            id: `role-${index}`, name: `Role ${String(index).padStart(2, '0')}`, color: index % 2 ? '#3ba55d' : '#ed4245',
          })),
          knownMembers: new Map(Array.from({ length: 500 }, (_, index) => [
            `user-${index}`, { id: `user-${index}`, nickname: `Member ${String(index).padStart(3, '0')}`, avatarUrl: avatar },
          ])),
        },
      };
      const privacy = document.querySelector('#chk-private-share');
      privacy.checked = true;
      privacy.dispatchEvent(new Event('change', { bubbles: true }));
      const trigger = document.querySelector('#share-audience-toggle');
      const popup = document.querySelector('#share-audience-popup');
      const list = document.querySelector('#share-audience-options');
      const search = document.querySelector('#share-audience-search');
      const card = document.querySelector('.screen-share-picker-card');
      trigger.scrollIntoView({ block: 'nearest' });
      await settle();
      const closedHeight = card.getBoundingClientRect().height;
      check(!popup.checkVisibility(), 'Closed dropdown must hide all 520 choices.');
      check(trigger.textContent.includes(language.t('screenShare.privateChoose')), 'Localized placeholder.');
      trigger.click();
      await settle();
      check(document.activeElement === search, 'Opening focuses search.');
      check(list.querySelectorAll('[role="option"]').length === 520, 'All members and roles remain searchable.');
      check(list.scrollHeight > list.clientHeight && list.clientHeight <= 280, 'Large audience has a bounded scrollable list.');
      check(Math.abs(card.getBoundingClientRect().height - closedHeight) <= 1, 'Opening the dropdown never expands the modal.');
      const bounds = popup.getBoundingClientRect(), cardBounds = card.getBoundingClientRect();
      check(bounds.top >= cardBounds.top && bounds.bottom <= cardBounds.bottom
        && bounds.left >= 0 && bounds.right <= innerWidth, 'Popup remains inside the scrollable modal and viewport.');
      const role = list.querySelector('[data-audience-id="role-0"]');
      const roleBounds = role.getBoundingClientRect();
      check(role.contains(document.elementFromPoint(roleBounds.left + 30, roleBounds.top + 18)),
        'The popup is not clipped or covered by underlying source controls.');
      check(getComputedStyle(role.querySelector('.share-audience-role')).backgroundColor === 'rgb(237, 66, 69)', 'Role color is actually painted.');
      role.click();
      check(popup.checkVisibility() && role.getAttribute('aria-selected') === 'true', 'Selection keeps dropdown open.');
      search.value = 'member 499';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await settle();
      const visible = [...list.querySelectorAll('[role="option"]')].filter(row => row.checkVisibility());
      check(visible.length === 1 && visible[0].dataset.audienceId === 'user-499', 'Search hides nonmatching rows and groups visually.');
      const photo = visible[0].querySelector('img');
      await photo.decode();
      check(photo.naturalWidth === 32 && photo.getBoundingClientRect().width === 24, 'User avatar loads at the intended size.');
      visible[0].click();
      search.value = 'member 000';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      list.querySelector('[data-audience-id="user-0"]').click();
      check(document.querySelectorAll('.share-audience-chip').length === 2
        && document.querySelector('.share-audience-more').textContent === '+1', 'Selected summary stays compact.');
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      check(document.activeElement.dataset.audienceId === 'user-0', 'Arrow navigation skips hidden rows.');
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      check(!popup.checkVisibility() && document.activeElement === trigger && !!document.querySelector('#share-picker-title'),
        'Escape restores trigger focus without closing the modal.');
      trigger.click();
      check(list.querySelector('[data-audience-id="user-499"]').getAttribute('aria-selected') === 'true', 'Selections survive closing/searching.');
      document.querySelector('#share-picker-title').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      check(!popup.checkVisibility(), 'Outside click closes only the popup.');
      trigger.click();
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      list.scrollTop = 0;
      await settle();
      preview = document.body.innerHTML;
      previewScroll = card.scrollTop;
      picker.close();
      check(!document.querySelector('#share-audience-popup'), 'Closing modal retires the dropdown.');
    }
    check(mediaRequests === 0, 'No camera, desktop pixels, or native capture requested.');
  } finally {
    picker?.close();
    window.api = originalApi;
    webRtcManager.getNativeScreenCapabilities = originalCapabilities;
    Object.assign(media, originalMedia);
    language.setLanguage(originalLanguage);
  }
  document.body.innerHTML = preview;
  document.querySelector('.screen-share-picker-card').scrollTop = previewScroll;
  return checks;
}
