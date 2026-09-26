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
  const [{ ScreenSharePickerModal }, { OverlayConfigModal }, { webRtcManager }, language] = await Promise.all([
    import('/views/ScreenSharePickerModal.ts'), import('/views/OverlayConfigModal.ts'),
    import('/core/WebRtcManager.ts'), import('/i18n/index.ts'),
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
  let picker, overlay, preview = '', previewScroll = 0;
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
      await settle();
      const aspect = document.querySelector('#chk-preserve-aspect-ratio');
      const labels = ['share-aspect-label', 'share-private-label'].map(id => document.getElementById(id));
      const audioStyle = getComputedStyle(document.querySelector('#share-audio-text'));
      for (const label of labels) {
        const style = getComputedStyle(label);
        check(['fontSize', 'fontWeight', 'fontFamily', 'color'].every(key => style[key] === audioStyle[key]),
          `${locale}: both picker option labels must match the standard audio label typography.`);
      }
      const switches = [aspect, privacy].map(input => input.closest('.toggle-switch').getBoundingClientRect());
      check(Math.abs(switches[0].right - switches[1].right) < 1,
        'Picker option switches must share a right-aligned column.');
      check(switches.every(rect => rect.width === 36 && rect.height === 20), 'Switches keep their standard size.');
      labels[0].click();
      check(!aspect.checked, 'Clicking the aspect label changes the associated switch exactly once.');
      labels[0].click();
      check(aspect.checked, 'The aspect label also restores ON.');
      if (locale === 'pt-BR') window.modalOptionPickerPreview = document.body.innerHTML;
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

      overlay = new OverlayConfigModal();
      overlay.open();
      await settle();
      const overlayAspect = document.querySelector('#overlay-aspect-ratio');
      const row = overlayAspect.closest('.overlay-aspect-option');
      const reference = document.querySelector('#overlay-hide-self-cb').closest('.toggle-switch').parentElement;
      check(!!row, 'Overlay aspect ratio must use an option row, not unstyled body text.');
      const rowStyle = getComputedStyle(row), referenceStyle = getComputedStyle(reference);
      check(['display', 'alignItems', 'justifyContent', 'gap', 'padding', 'backgroundColor', 'border', 'borderRadius']
        .every(key => rowStyle[key] === referenceStyle[key]), 'Aspect ratio uses the same card treatment as other overlay toggles.');
      for (const id of ['overlay-hide-stage-cb', 'overlay-hide-inactive-cb']) {
        const input = document.getElementById(id);
        const option = input.closest('.overlay-visibility-option');
        const style = getComputedStyle(option);
        check(['display', 'alignItems', 'justifyContent', 'gap', 'padding', 'backgroundColor', 'border', 'borderRadius']
          .every(key => style[key] === referenceStyle[key]), `${id}: new options retain the standard card treatment.`);
        const label = document.getElementById(input.getAttribute('aria-labelledby'));
        const hint = document.getElementById(input.getAttribute('aria-describedby'));
        check(label?.htmlFor === id && hint?.textContent && getComputedStyle(label).fontSize === '12px'
          && getComputedStyle(hint).fontSize === '11px', `${id}: accessible labels use standard typography.`);
        const checked = input.checked;
        label.click();
        check(input.checked !== checked, `${id}: label activates its switch exactly once.`);
        label.click();
      }
      const title = document.getElementById(overlayAspect.getAttribute('aria-labelledby'));
      const description = document.getElementById(overlayAspect.getAttribute('aria-describedby'));
      const referenceText = reference.firstElementChild.lastElementChild;
      for (const [actual, expected] of [[title, referenceText.children[0]], [description, referenceText.children[1]]]) {
        const actualStyle = getComputedStyle(actual), expectedStyle = getComputedStyle(expected);
        check(['fontSize', 'fontWeight', 'fontFamily', 'color'].every(key => actualStyle[key] === expectedStyle[key]),
          'Overlay title and helper text match the existing compact typography.');
      }
      check(title.textContent === language.t('overlay.preserveAspectRatio')
        && description.textContent === language.t('overlay.preserveAspectRatioDesc'),
      'Overlay aspect title and description retain their translations and accessible relationships.');
      check(row.scrollWidth <= row.clientWidth && description.scrollWidth <= description.clientWidth,
        'Overlay aspect controls fit without horizontal overflow.');
      const toggle = overlayAspect.closest('.toggle-switch');
      const referenceToggle = reference.querySelector('.toggle-switch');
      check(Math.abs(toggle.getBoundingClientRect().right - referenceToggle.getBoundingClientRect().right) < 1
        && toggle.getBoundingClientRect().width === 36, 'Overlay switches stay aligned and do not shrink.');
      overlayAspect.scrollIntoView({ block: 'nearest' });
      overlayAspect.focus();
      check(document.activeElement === overlayAspect && overlayAspect.tabIndex === 0
        && overlayAspect.getAttribute('role') === 'switch', 'Overlay aspect ratio remains keyboard focusable as a switch.');
      const initial = overlayAspect.checked;
      title.click();
      check(overlayAspect.checked === !initial && overlay.currentPreserveAspectRatio === !initial,
        'Clicking the overlay title toggles once and updates its existing configuration state.');
      title.click();
      check(overlay.currentPreserveAspectRatio === initial, 'A second click restores the previous overlay choice.');
      if (locale === 'pt-BR') window.modalOptionOverlayPreview = document.body.innerHTML;
      overlay.close();
    }
    check(mediaRequests === 0, 'No camera, desktop pixels, or native capture requested.');
  } finally {
    picker?.close();
    overlay?.close();
    window.api = originalApi;
    webRtcManager.getNativeScreenCapabilities = originalCapabilities;
    Object.assign(media, originalMedia);
    language.setLanguage(originalLanguage);
  }
  document.body.innerHTML = preview;
  document.querySelector('.screen-share-picker-card').scrollTop = previewScroll;
  return checks;
}
