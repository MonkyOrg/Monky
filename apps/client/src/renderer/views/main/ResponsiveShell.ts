import { t } from '../../i18n';
import { appEvents } from '../../core/EventBus';
import { voiceStore } from '../../stores/voiceStore';
import { html } from '../../utils/html';
import { openModal, type ModalShell } from '../../utils/modalShell';
import { cancelCompactPageTransition, cancelSurfaceMotion, hasOwnedSurface, topModal, transitionCompactPage } from '../../utils/surfaceMotion';
import { COMPACT_VIEWPORT_QUERY } from '../../utils/viewport';

type Panel = 'content' | 'navigation' | 'members';

/** Compact navigation is transient: it never changes the saved desktop sidebar preferences. */
export class ResponsiveShell {
  private panel: Panel = 'navigation';
  private show: ((panel: Panel, focus: boolean) => void) | null = null;

  public showContent(): void {
    if (this.show) this.show('content', true);
    else this.panel = 'content';
  }

  public toggle(sidebar: 'navigation' | 'members'): boolean {
    if (!this.show || !window.matchMedia(COMPACT_VIEWPORT_QUERY).matches) return false;
    this.show(this.panel === sidebar ? 'content' : sidebar, true);
    return true;
  }

  public bind(layout: HTMLElement): () => void {
    const lifetime = new AbortController();
    const { signal } = lifetime;
    let callOptions: ModalShell | null = null;
    let callOptionsSource: Element | null = null;
    let pagePending = false;
    const compact = window.matchMedia(COMPACT_VIEWPORT_QUERY);
    const center = layout.querySelector<HTMLElement>(':scope > .main-center-column');
    const rail = layout.querySelector<HTMLElement>(':scope > .server-rail');
    const navigation = layout.querySelector<HTMLElement>(':scope > .channels-sidebar, :scope > .home-sidebar-shell');
    const members = layout.querySelector<HTMLElement>(':scope > .members-sidebar');
    const voiceChat = layout.querySelector<HTMLElement>(':scope > .voice-channel-chat-panel');
    const footer = layout.querySelector<HTMLElement>('.user-control-bar');
    if (!center || !rail || !navigation || !footer) return () => lifetime.abort();

    const toolbar = document.createElement('nav');
    toolbar.className = 'compact-navigation';
    toolbar.setAttribute('aria-label', t('responsive.navigation'));
    toolbar.innerHTML = String(html`
      <button type="button" class="btn btn-icon compact-back-button" data-compact-back
        aria-label="${t('main.showNavigationSidebar')}" aria-controls="server-rail compact-navigation-panel" aria-expanded="false">
        <span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>
      </button>
      <button type="button" class="btn btn-icon compact-search-button" data-compact-search
        aria-label="${t('messageSearch.title')}" aria-expanded="false">
        <span class="material-symbols-outlined" aria-hidden="true">search</span>
      </button>
      ${members ? html`<button type="button" class="btn btn-icon" data-compact-toggle="members"
        aria-label="${t('main.showMembersSidebar')}" aria-controls="compact-members-panel" aria-expanded="false">
        <span class="material-symbols-outlined" aria-hidden="true">group</span>
      </button>` : null}
    `);
    const footerSlot = document.createElement('div');
    footerSlot.className = 'compact-footer';
    // Move the existing controls, not a second copy: listeners, media and notices keep their owner.
    const footerPlace = document.createComment('user controls');
    footer.before(footerPlace);
    layout.prepend(toolbar);
    layout.append(footerSlot);
    const panels = [
      { element: center, panel: 'content', id: 'compact-content-panel' },
      { element: rail, panel: 'navigation', id: rail.id },
      { element: navigation, panel: 'navigation', id: 'compact-navigation-panel' },
      ...members ? [{ element: members, panel: 'members', id: 'compact-members-panel' }] : [],
      ...voiceChat ? [{ element: voiceChat, panel: 'content', id: voiceChat.id }] : [],
    ].map(entry => ({ ...entry, inert: entry.element.inert, originalId: entry.element.id }));
    panels.forEach(({ element, id }) => { element.id = id; });

    const apply = (panel: Panel, focus: boolean): void => {
      this.panel = panel === 'members' && !members ? 'content' : panel;
      const active = document.activeElement;
      if (compact.matches) {
        if (footer.parentElement !== footerSlot) footerSlot.append(footer);
      } else if (footer.previousSibling !== footerPlace) footerPlace.after(footer);
      layout.toggleAttribute('data-compact', compact.matches);
      layout.dataset.compactPanel = this.panel;
      layout.toggleAttribute('data-compact-call', !!voiceStore.currentVoiceChannelId);
      layout.toggleAttribute('data-compact-stage', !!center.querySelector('.voice-stage-container') && (!voiceChat || voiceChat.hidden));
      if (layout.hasAttribute('data-compact-stage') || !layout.querySelector('.message-search-launch')) {
        layout.removeAttribute('data-compact-search-open');
        toolbar.querySelector('[data-compact-search]')?.setAttribute('aria-expanded', 'false');
      }
      for (const controls of center.querySelectorAll<HTMLElement>('.stage-call-controls')) {
        if (controls.querySelector('[data-compact-call-options]')) continue;
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'btn btn-icon compact-call-options';
        more.dataset.compactCallOptions = '';
        more.setAttribute('aria-label', t('chat.moreActions'));
        more.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">more_horiz</span>';
        controls.querySelector('#stage-btn-leave')?.before(more);
      }
      panels.forEach(({ element, panel: owned, inert }) => {
        element.inert = compact.matches
          ? owned !== this.panel || element === center && !!voiceChat && !voiceChat.hidden : inert;
      });
      for (const button of toolbar.querySelectorAll<HTMLButtonElement>('[data-compact-toggle]')) {
        const selected = button.dataset.compactToggle === this.panel;
        if (button.dataset.compactToggle !== 'content') button.setAttribute('aria-expanded', String(selected));
      }
      const navButton = toolbar.querySelector<HTMLButtonElement>('[data-compact-back]')!;
      navButton.setAttribute('aria-label', t(this.panel === 'members' ? 'responsive.content' : 'main.showNavigationSidebar'));
      const membersButton = toolbar.querySelector<HTMLButtonElement>('[data-compact-toggle="members"]');
      membersButton?.setAttribute('aria-label', t(this.panel === 'members' ? 'main.hideMembersSidebar' : 'main.showMembersSidebar'));
      if (focus || (active instanceof HTMLElement && (active.closest('[inert]') || toolbar.contains(active)))) {
        // Never autofocus the composer on a phone: opening a channel must not summon the keyboard.
        if (compact.matches) {
          const target = this.panel === 'navigation'
            ? navigation.querySelector<HTMLElement>('button:not([disabled]), [tabindex="0"]')
            : navButton;
          target?.focus({ preventScroll: true });
        } else if (active instanceof HTMLElement && toolbar.contains(active)) {
          const target = center.querySelector<HTMLElement>('button, [tabindex="0"], input, textarea');
          target?.focus({ preventScroll: true });
        }
      }
    };
    const show = (panel: Panel, focus: boolean): void => {
      if (!compact.matches) { this.panel = panel; return; }
      const changed = this.panel !== panel;
      this.panel = panel;
      panels.forEach(({ element }) => cancelSurfaceMotion(element));
      if (changed) {
        pagePending = true;
        transitionCompactPage(layout, () => {
          pagePending = false;
          apply(panel, focus);
        }, panel === 'navigation' ? -1 : 1);
      } else {
        cancelCompactPageTransition(layout);
        pagePending = false;
        apply(panel, focus);
      }
    };
    this.show = show;
    toolbar.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[data-compact-back]')) {
        show(this.panel === 'members' ? 'content' : 'navigation', true);
        return;
      }
      if (event.target.closest('[data-compact-search]')) {
        const open = !layout.hasAttribute('data-compact-search-open');
        layout.toggleAttribute('data-compact-search-open', open);
        toolbar.querySelector('[data-compact-search]')?.setAttribute('aria-expanded', String(open));
        const searchHost = voiceChat && !voiceChat.hidden ? voiceChat : center;
        if (open) searchHost.querySelector<HTMLInputElement>('.message-search-launch')?.focus();
        return;
      }
      const panel = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-compact-toggle]')?.dataset.compactToggle : undefined;
      if (panel === 'content' || panel === 'navigation' || panel === 'members') {
        show(panel === this.panel ? 'content' : panel, true);
      }
    }, { signal });
    layout.addEventListener('click', event => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-compact-call-options]')) return;
      const source = event.target.closest('.stage-call-controls');
      if (!source) return;
      callOptions?.close('owner', true);
      callOptionsSource = source;
      const actions = [
        ...source.querySelectorAll<HTMLButtonElement>('#stage-btn-screen, #stage-btn-overlay, #stage-btn-soundboard'),
        ...footer.querySelectorAll<HTMLButtonElement>('#bar-btn-settings'),
      ].filter(button => !button.hidden);
      const sheet = openModal({
        backdropClass: 'compact-call-sheet',
        label: t('chat.moreActions'),
        signal,
        closeWithSession: true,
        onClose: () => { if (callOptions === sheet) callOptions = null; },
        card: html`<div class="modal-card">
          <div class="compact-sheet-grabber" aria-hidden="true"></div>
          <div class="modal-header"><h2 class="modal-title">${t('chat.moreActions')}</h2>
            <button type="button" class="btn btn-icon" data-modal-close aria-label="${t('common.close')}">
              <span class="material-symbols-outlined" aria-hidden="true">close</span>
            </button></div>
          <div class="compact-call-action-list">${actions.map((button, index) => html`
            <button type="button" class="compact-call-action" data-call-action="${index}" ${button.disabled ? html`disabled` : null}
              ${button.dataset.desktopOnly ? html`aria-disabled="true" data-desktop-only="${button.dataset.desktopOnly}" data-tooltip="${button.dataset.tooltip}"` : null}>
              <span class="material-symbols-outlined" aria-hidden="true">${button.querySelector('.material-symbols-outlined')?.textContent ?? 'settings'}</span>
              <span>${button.title || button.getAttribute('aria-label')}</span>
            </button>`)}</div></div>`,
      });
      callOptions = sheet;
      sheet.card.addEventListener('click', event => {
        const action = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-call-action]') : null;
        if (!action) return;
        const button = actions[Number(action.dataset.callAction)];
        sheet.close('button');
        if (button?.isConnected && !button.disabled) button.click();
      }, { signal: sheet.signal });
    }, { signal });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.defaultPrevented || !compact.matches || this.panel === 'navigation'
        || topModal() || hasOwnedSurface(layout)) return;
      event.preventDefault();
      if (layout.hasAttribute('data-compact-search-open')) {
        layout.removeAttribute('data-compact-search-open');
        const search = toolbar.querySelector<HTMLButtonElement>('[data-compact-search]');
        search?.setAttribute('aria-expanded', 'false');
        search?.focus({ preventScroll: true });
      } else show(this.panel === 'members' ? 'content' : 'navigation', true);
    }, { signal });
    compact.addEventListener('change', () => {
      cancelCompactPageTransition(layout);
      pagePending = false;
      apply(this.panel, false);
    }, { signal });
    const observer = new MutationObserver(records => {
      if (callOptions && !callOptionsSource?.isConnected) callOptions.close('owner', true);
      if (!pagePending && records.some(record => record.target === voiceChat || [...record.addedNodes, ...record.removedNodes]
        .some(node => node instanceof Element && (node.matches('.voice-stage-container, .stage-call-controls')
          || node.querySelector('.voice-stage-container, .stage-call-controls'))))) apply(this.panel, false);
    });
    if (voiceChat) observer.observe(voiceChat, { attributes: true, attributeFilter: ['hidden'] });
    observer.observe(center, { childList: true, subtree: true });
    const unbindVoice = appEvents.on('voice.channel_changed', () => {
      callOptions?.close('owner', true);
      if (!pagePending) apply(this.panel, false);
    });
    apply(this.panel, false);

    return () => {
      cancelCompactPageTransition(layout);
      lifetime.abort();
      observer.disconnect();
      unbindVoice();
      if (this.show === show) this.show = null;
      panels.forEach(({ element, inert, originalId }) => {
        cancelSurfaceMotion(element);
        element.inert = inert;
        element.id = originalId;
      });
      footerPlace.after(footer);
      footerPlace.remove();
      toolbar.remove();
      footerSlot.remove();
      layout.removeAttribute('data-compact');
      layout.removeAttribute('data-compact-call');
      layout.removeAttribute('data-compact-stage');
      layout.removeAttribute('data-compact-search-open');
      center.querySelectorAll('[data-compact-call-options]').forEach(button => button.remove());
      delete layout.dataset.compactPanel;
    };
  }
}
