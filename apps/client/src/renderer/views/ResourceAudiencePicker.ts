import {
  PUBLIC_AUDIENCE,
  type ResourceAudience,
} from '@monky/shared';
import type { ServerStore } from '../stores/serverStore';
import { getAvatarUrl } from '../utils/avatar';
import { isHexColor } from '../utils/colors';
import { escapeHtml } from '../utils/html';
import { t } from '../i18n';
import { smoothScrollIntoView } from '../utils/scroll';

export class ResourceAudiencePicker {
  private audience: ResourceAudience;
  private open = false;
  private positionOpenPopup: (() => void) | null = null;

  constructor(
    private readonly server: ServerStore,
    private readonly prefix: string,
    initial: ResourceAudience = PUBLIC_AUDIENCE,
    private readonly placement: 'adaptive' | 'below' = 'adaptive',
  ) {
    this.audience = initial.visibility === 'private'
      ? { visibility: 'private', userIds: [...initial.userIds], roleIds: [...initial.roleIds] }
      : PUBLIC_AUDIENCE;
  }

  value(): ResourceAudience {
    return this.audience.visibility === 'private'
      ? { visibility: 'private', userIds: [...this.audience.userIds], roleIds: [...this.audience.roleIds] }
      : PUBLIC_AUDIENCE;
  }

  isValid(): boolean {
    return this.audience.visibility === 'public' ||
      this.audience.userIds.length + this.audience.roleIds.length > 0;
  }

  render(disabled = false): string {
    return `<section class="resource-audience" data-resource-audience="${escapeHtml(this.prefix)}">
      <div class="bot-permission-row resource-audience-mode">
        <div><label for="${escapeHtml(this.prefix)}-private">${t('audience.private')}</label>
          <p class="bot-settings-description">${t('audience.description')}</p></div>
        <label class="toggle-switch"><input id="${escapeHtml(this.prefix)}-private" data-audience-private
          type="checkbox" role="switch" ${this.audience.visibility === 'private' ? 'checked' : ''}
          ${disabled ? 'disabled' : ''}><span class="toggle-slider"></span></label>
      </div>
      <div class="share-audience" data-audience-selection ${this.audience.visibility === 'private' ? '' : 'hidden'}>
        <label class="share-audience-label">${t('audience.who')}</label>
        <div class="share-audience-picker">
          <button type="button" class="share-audience-trigger" data-audience-toggle aria-haspopup="listbox"
            aria-expanded="${this.open}" ${disabled ? 'disabled' : ''}>
            <span class="share-audience-summary" data-audience-summary></span>
            <span class="material-symbols-outlined md-20 share-audience-chevron" aria-hidden="true">expand_more</span>
          </button>
          <div class="share-audience-popup" data-audience-popup popover="manual" ${this.open ? '' : 'hidden'}>
            <div class="share-audience-search">
              <span class="material-symbols-outlined md-18" aria-hidden="true">search</span>
              <input type="search" data-audience-search autocomplete="off"
                aria-label="${escapeHtml(t('audience.search'))}" placeholder="${escapeHtml(t('audience.search'))}">
            </div>
            <div class="share-audience-options" role="listbox" aria-multiselectable="true">
              ${this.options()}
            </div>
            <p data-audience-no-results role="status" hidden>${t('audience.noResults')}</p>
          </div>
        </div>
        <p class="audio-device-status" data-audience-status role="status" aria-live="polite"></p>
      </div>
    </section>`;
  }

  bind(container: HTMLElement, signal: AbortSignal, onChange: () => void): void {
    let positioningScroll = false;
    let positioningScrollTimer: number | null = null;
    const closePopup = () => {
      if (!this.open) return;
      const root = container.querySelector<HTMLElement>(
        `[data-resource-audience="${CSS.escape(this.prefix)}"]`,
      );
      const popup = root?.querySelector<HTMLElement>('[data-audience-popup]');
      const trigger = root?.querySelector<HTMLButtonElement>('[data-audience-toggle]');
      const focusWasInside = !!(popup && document.activeElement instanceof Node && popup.contains(document.activeElement));
      this.open = false;
      this.sync(container);
      if (focusWasInside) trigger?.focus({ preventScroll: true });
    };
    const scrollableAncestor = (element: HTMLElement): HTMLElement | null => {
      for (let current = element.parentElement; current; current = current.parentElement) {
        const overflowY = getComputedStyle(current).overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) {
          return current;
        }
      }
      return null;
    };
    const positionPopup = () => {
      if (!this.open) return;
      const root = container.querySelector<HTMLElement>(
        `[data-resource-audience="${CSS.escape(this.prefix)}"]`,
      );
      const trigger = root?.querySelector<HTMLElement>('[data-audience-toggle]');
      const popup = root?.querySelector<HTMLElement>('[data-audience-popup]');
      if (!trigger || !popup) return;
      const viewportPadding = 12;
      const gap = 8;
      let triggerBox = trigger.getBoundingClientRect();
      if (this.placement === 'below' && window.innerHeight - triggerBox.bottom < 240 && !positioningScroll) {
        positioningScroll = true;
        smoothScrollIntoView(trigger, { block: 'center', inline: 'nearest' });
        triggerBox = trigger.getBoundingClientRect();
        if (positioningScrollTimer !== null) window.clearTimeout(positioningScrollTimer);
        positioningScrollTimer = window.setTimeout(() => {
          positioningScroll = false;
          positionPopup();
        }, 500);
      }
      const width = Math.min(
        Math.max(triggerBox.width, 280),
        window.innerWidth - viewportPadding * 2,
      );
      const left = Math.min(
        Math.max(viewportPadding, triggerBox.left),
        window.innerWidth - width - viewportPadding,
      );
      const spaceBelow = window.innerHeight - triggerBox.bottom - viewportPadding - gap;
      const spaceAbove = triggerBox.top - viewportPadding - gap;
      const desiredHeight = Math.min(360, Math.max(80, popup.scrollHeight));
      const openAbove = this.placement === 'adaptive' && spaceBelow < 240 && spaceAbove > spaceBelow;
      const availableHeight = Math.max(80, openAbove ? spaceAbove : spaceBelow);
      popup.style.left = `${left}px`;
      popup.style.width = `${width}px`;
      popup.style.maxHeight = `${Math.min(360, availableHeight)}px`;
      const height = Math.min(popup.getBoundingClientRect().height, availableHeight);
      const idealTop = openAbove ? triggerBox.top - gap - height : triggerBox.bottom + gap;
      popup.style.top = `${this.placement === 'below'
        ? idealTop
        : Math.min(Math.max(viewportPadding, idealTop), window.innerHeight - viewportPadding - height)}px`;
      popup.dataset.placement = openAbove ? 'above' : 'below';
    };
    this.positionOpenPopup = positionPopup;
    signal.addEventListener('abort', () => {
      if (this.positionOpenPopup === positionPopup) this.positionOpenPopup = null;
      if (positioningScrollTimer !== null) window.clearTimeout(positioningScrollTimer);
    }, { once: true });
    window.addEventListener('resize', positionPopup, { signal });
    document.addEventListener('scroll', () => {
      if (!positioningScroll) {
        closePopup();
        return;
      }
      positionPopup();
      if (positioningScrollTimer !== null) window.clearTimeout(positioningScrollTimer);
      positioningScrollTimer = window.setTimeout(() => {
        positioningScroll = false;
        positionPopup();
      }, 120);
    }, { capture: true, signal });
    document.addEventListener('wheel', event => {
      if (!this.open) return;
      const root = container.querySelector<HTMLElement>(
        `[data-resource-audience="${CSS.escape(this.prefix)}"]`,
      );
      const popup = root?.querySelector<HTMLElement>('[data-audience-popup]');
      const trigger = root?.querySelector<HTMLElement>('[data-audience-toggle]');
      const insidePopup = event.target instanceof Node && !!popup?.contains(event.target);
      closePopup();
      if (!insidePopup || !trigger) return;
      event.preventDefault();
      const scroller = scrollableAncestor(trigger);
      if (scroller) scroller.scrollTop += event.deltaY;
    }, { capture: true, passive: false, signal });
    container.addEventListener('change', event => {
      const input = event.target instanceof HTMLInputElement ? event.target : null;
      if (!input?.matches('[data-audience-private]')) return;
      this.audience = input.checked
        ? { visibility: 'private', userIds: [], roleIds: [] }
        : PUBLIC_AUDIENCE;
      this.open = false;
      this.sync(container);
      if (input.checked) {
        requestAnimationFrame(() => {
          const trigger = container.querySelector<HTMLElement>(
            `[data-resource-audience="${CSS.escape(this.prefix)}"] [data-audience-toggle]`,
          );
          if (trigger) smoothScrollIntoView(trigger, { block: 'center', inline: 'nearest' });
        });
      }
      onChange();
    }, { signal });
    container.addEventListener('input', event => {
      if (event.target instanceof HTMLInputElement && event.target.matches('[data-audience-search]')) {
        this.sync(container);
      }
    }, { signal });
    container.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      const root = target?.closest<HTMLElement>(`[data-resource-audience="${CSS.escape(this.prefix)}"]`);
      if (!root || !target) return;
      if (target.closest('[data-audience-toggle]')) {
        this.open = !this.open;
        this.sync(container);
        if (this.open) {
          positionPopup();
          root.querySelector<HTMLInputElement>('[data-audience-search]')?.focus();
        }
        return;
      }
      const option = target.closest<HTMLButtonElement>('[data-audience-id]');
      const audience = this.audience;
      if (!option || audience.visibility !== 'private') return;
      const id = option.dataset.audienceId;
      if (!id) return;
      const key = option.dataset.audienceKind === 'role' ? 'roleIds' : 'userIds';
      const selected = audience[key];
      audience[key] = selected.includes(id)
        ? selected.filter(value => value !== id)
        : [...selected, id];
      this.sync(container);
      onChange();
    }, { signal });
    container.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !this.open) return;
      const target = event.target instanceof Element ? event.target : null;
      const root = target?.closest<HTMLElement>(`[data-resource-audience="${CSS.escape(this.prefix)}"]`);
      if (!root) return;
      this.open = false;
      this.sync(container);
      root.querySelector<HTMLButtonElement>('[data-audience-toggle]')?.focus();
    }, { signal });
    this.sync(container);
    positionPopup();
  }

  sync(container: ParentNode): void {
    const root = container.querySelector<HTMLElement>(`[data-resource-audience="${CSS.escape(this.prefix)}"]`);
    if (!root) return;
    const audience = this.audience;
    const isPrivate = audience.visibility === 'private';
    const section = root.querySelector<HTMLElement>('[data-audience-selection]');
    if (section) section.hidden = !isPrivate;
    const toggle = root.querySelector<HTMLButtonElement>('[data-audience-toggle]');
    toggle?.setAttribute('aria-expanded', String(this.open));
    const popup = root.querySelector<HTMLElement>('[data-audience-popup]');
    if (popup) {
      if (this.open) {
        popup.hidden = false;
        if (typeof popup.showPopover === 'function' && popup.dataset.audiencePopoverOpen !== 'true') {
          popup.showPopover();
          popup.dataset.audiencePopoverOpen = 'true';
        }
        this.positionOpenPopup?.();
        requestAnimationFrame(() => {
          if (this.open && popup.isConnected) this.positionOpenPopup?.();
        });
      } else {
        if (typeof popup.hidePopover === 'function' && popup.dataset.audiencePopoverOpen === 'true') {
          popup.hidePopover();
          delete popup.dataset.audiencePopoverOpen;
        }
        popup.hidden = true;
      }
    }
    if (audience.visibility !== 'private') return;
    const search = root.querySelector<HTMLInputElement>('[data-audience-search]');
    const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
    const query = normalize(search?.value.trim() ?? '');
    const selectedOptions: HTMLButtonElement[] = [];
    let visible = 0;
    for (const option of root.querySelectorAll<HTMLButtonElement>('[data-audience-id]')) {
      const key = option.dataset.audienceKind === 'role' ? 'roleIds' : 'userIds';
      const selected = audience[key].includes(option.dataset.audienceId ?? '');
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-selected', String(selected));
      option.hidden = !normalize(option.dataset.audienceName ?? '').includes(query);
      if (!option.hidden) visible++;
      if (selected) selectedOptions.push(option);
    }
    for (const group of root.querySelectorAll<HTMLElement>('.share-audience-group')) {
      group.hidden = ![...group.querySelectorAll<HTMLButtonElement>('[data-audience-id]')]
        .some(option => !option.hidden);
    }
    const summary = root.querySelector<HTMLElement>('[data-audience-summary]');
    if (summary) {
      summary.innerHTML = selectedOptions.length
        ? selectedOptions.slice(0, 2).map(option =>
          `<span class="share-audience-chip">${option.querySelector('.share-audience-identity')?.innerHTML ?? ''}</span>`).join('')
          + (selectedOptions.length > 2 ? `<span class="share-audience-more">+${selectedOptions.length - 2}</span>` : '')
        : `<span class="share-audience-placeholder">${t('audience.choose')}</span>`;
    }
    const empty = root.querySelector<HTMLElement>('[data-audience-no-results]');
    if (empty) empty.hidden = visible > 0;
    const status = root.querySelector<HTMLElement>('[data-audience-status]');
    if (status) status.textContent = this.isValid()
      ? t('audience.selected', { count: audience.userIds.length + audience.roleIds.length })
      : t('audience.empty');
  }

  private options(): string {
    const render = (
      kind: 'role' | 'user',
      values: Array<{ id: string; name: string; color?: string | null; avatarUrl?: string | null }>,
    ) => [...values].sort((a, b) => a.name.localeCompare(b.name)).map(value => `
      <button type="button" class="share-audience-option" data-audience-kind="${kind}"
        data-audience-id="${escapeHtml(value.id)}" data-audience-name="${escapeHtml(value.name)}"
        role="option" aria-selected="false">
        <span class="share-audience-identity">
          ${kind === 'role'
            ? `<span class="share-audience-role" style="--role-color: ${isHexColor(value.color) ? value.color : 'var(--text-muted)'}" aria-hidden="true"></span>`
            : `<img class="share-audience-avatar" src="${escapeHtml(getAvatarUrl(value.avatarUrl))}" alt="">`}
          <span class="share-audience-name">${escapeHtml(value.name)}</span>
        </span>
        <span class="material-symbols-outlined md-18 share-audience-check" aria-hidden="true">check</span>
      </button>`).join('');
    const members = [...this.server.knownMembers.values()]
      .filter(user => user.id !== this.server.currentUser?.id && !user.isBot)
      .map(user => ({ id: user.id, name: user.nickname, avatarUrl: user.avatarUrl }));
    return `<div class="share-audience-group" role="group">
      <h4>${t('audience.roles')}</h4>${render('role', this.server.roles)}
    </div><div class="share-audience-group" role="group">
      <h4>${t('audience.members')}</h4>${render('user', members)}
    </div>`;
  }
}
