'use strict';
module.exports = { runScreenViewersSmoke };

async function runScreenViewersSmoke() {
  const [{ ScreenViewersView }, { webRtcManager: rtc }, { participantManager: participants },
    { serverStore: server }, language] = await Promise.all([
    import('/views/ScreenViewersView.ts'), import('/core/WebRtcManager.ts'),
    import('/core/ParticipantManager.ts'), import('/stores/serverStore.ts'), import('/i18n/index.ts'),
  ]);
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const original = { query: rtc.getScreenViewers, participant: participants.get, name: participants.displayName,
    user: server.currentUser, language: language.getLanguage() };
  let view;
  let ids = [];
  let fail = false;
  let resolvePending;
  let deferred = false;
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  try {
    server.currentUser = { id: 'me', sessionId: 'me' };
    participants.get = id => ({ user: { id, nickname: `${id} <img onerror="bad()">`, avatarUrl: null } });
    participants.displayName = p => p.user.nickname;
    rtc.getScreenViewers = async (publisher, share) => {
      check(publisher === 'publisher' && share === 'source', 'The widget must query its own source');
      if (deferred) return new Promise(resolve => { resolvePending = resolve; });
      if (fail) throw new DOMException('Retired', 'AbortError');
      return ids;
    };
    for (const locale of ['pt-BR', 'en']) {
      language.setLanguage(locale);
      document.body.innerHTML = `<div class="stage-card" style="height:250px;width:320px;max-width:100vw;position:relative">
        <video></video><div class="stage-viewers" data-publisher="publisher" data-share="source"></div></div>`;
      const root = document.querySelector('.stage-viewers'), video = document.querySelector('video');
      let cardClicks = 0;
      root.parentElement.addEventListener('click', () => cardClicks++);
      view = new ScreenViewersView(root);
      await settle();
      const button = root.querySelector('button'), popup = root.querySelector('[popover]');
      for (const [people, key, count] of [
        [[], 'viewersEmpty'], [['a'], 'viewersOne'], [['a', 'b'], 'viewersMany', 2],
        [['a', 'b', 'c'], 'viewersMany', 3],
        [['a', 'b', 'c', 'd'], 'viewersMany', 4], [['me'], 'viewersOnlyYou'],
        [['a', 'me'], 'viewersYouAndOne'], [['a', 'me', 'b', 'c', 'a'], 'viewersYouAndMore', 3],
      ]) {
        ids = people;
        clearTimeout(view.timer);
        await view.refresh();
        check(button.getAttribute('aria-label') === language.t(`stage.${key}`, { count }), 'Localized count and self text');
        check(popup.querySelector('strong').textContent === language.t(`stage.${key}`, { count }),
          'The expanded list retains the full localized audience summary');
        check(button.querySelector('.stage-viewers-summary').textContent
          === language.t(people.length ? 'stage.viewersWatching' : 'stage.viewersEmpty'),
          'The compact card does not repeat the total count or self-inclusive sentence');
        const extra = Math.max(0, new Set(people).size - 2);
        check((button.querySelector('.stage-viewers-more')?.textContent ?? '') === (extra ? `+${extra}` : ''),
          '+N counts only viewers beyond the two visible avatars');
        check(popup.querySelectorAll('li').length === new Set(people).size, 'List contains every session exactly once');
        check(button.querySelectorAll('img').length === Math.min(2, new Set(people).size), 'At most two avatars');
        check(!popup.querySelector('[onerror]') && !popup.querySelector('script'), 'Participant names remain escaped');
        check(document.querySelector('video') === video && root.querySelector('button') === button,
          'Audience refresh never replaces the video or focusable trigger');
      }
      check(button.querySelector('.stage-viewers-more').textContent === '+2', 'Extra viewers use +N');
      button.dispatchEvent(new PointerEvent('pointerenter'));
      check(popup.matches(':popover-open') && button.getAttribute('aria-expanded') === 'true', 'Hover reveals full list');
      button.click();
      check(cardClicks === 0 && popup.matches(':popover-open'), 'Click pins hover without toggling card focus');
      popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      check(!popup.matches(':popover-open'), 'Escape closes the list');
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      check(popup.matches(':popover-open'), 'Keyboard can open the list');
      const bounds = popup.getBoundingClientRect();
      check(bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight,
        'Popover stays inside the viewport, even on a clipped mini card');
      ids = ['me'];
      clearTimeout(view.timer);
      await view.refresh();
      check(popup.matches(':popover-open') && popup.querySelectorAll('li').length === 1, 'Open list updates without closing');
      fail = true;
      clearTimeout(view.timer);
      await view.refresh();
      check(button.getAttribute('aria-label') === language.t('stage.viewersUnavailable') && !popup.querySelector('li'),
        'Failed refresh clears stale identities instead of pretending nobody is watching');
      check(button.querySelector('.stage-viewers-summary').textContent === language.t('stage.viewersUnavailable'),
        'Unavailable state remains explicit rather than saying watching');
      fail = false;
      deferred = true;
      clearTimeout(view.timer);
      const pending = view.refresh();
      const markup = root.innerHTML;
      view.destroy();
      resolvePending(['late']);
      await pending;
      check(root.innerHTML === markup.replace('aria-expanded="true"', 'aria-expanded="false"'),
        'Destroyed widget ignores late responses');
      check(!popup.matches(':popover-open'), 'Destroy closes top-layer popover');
      deferred = false;
      view = null;
    }
    return checks;
  } finally {
    view?.destroy();
    rtc.getScreenViewers = original.query;
    participants.get = original.participant;
    participants.displayName = original.name;
    server.currentUser = original.user;
    language.setLanguage(original.language);
    document.body.innerHTML = '';
  }
}
