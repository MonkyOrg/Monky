import {
  PUBLIC_AUDIENCE,
  type ResourceAudience,
} from '@monky/shared';
import type { ServerStore } from '../stores/serverStore';
import { getAvatarUrl } from '../utils/avatar';
import { isHexColor } from '../utils/colors';
import { escapeHtml } from '../utils/html';
import { t } from '../i18n';
import { scrollWithin, smoothScrollIntoView } from '../utils/scroll';

export class ResourceAudiencePicker {
  private audience: ResourceAudience;
  private open = false;
  private positionOpenPopup: (() => void) | null = null;

  constructor(
    private readonly server: ServerStore,
    private readonly prefix: string,
    initial: ResourceAudience = PUBLIC_AUDIENCE,
    private readonly placement: 'adaptive' | 'below' = 'adaptive',
    private readonly mode: 'audience' | 'permission-targets' = 'audience',
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

  setValue(value: ResourceAudience): void {
    this.audience = value.visibility === 'private'
      ? { visibility: 'private', userIds: [...value.userIds], roleIds: [...value.roleIds] }
      : PUBLIC_AUDIENCE;
  }

  isValid(): boolean {
    return this.mode === 'permission-targets' || this.audience.visibility === 'public' ||
      this.audience.userIds.length + this.audience.roleIds.length > 0;
  }

  render(disabled = false): string {
    return `<section class="resource-audience" data-resource-audience="${escapeHtml(this.prefix)}">
      ${this.mode === 'audience' ? `<div class="bot-permission-row resource-audience-mode">
        <div><label for="${escapeHtml(this.prefix)}-private">${t('audience.private')}</label>
          <p class="bot-settings-description">${t('audience.description')}</p></div>
        <label class="toggle-switch"><input id="${escapeHtml(this.prefix)}-private" data-audience-private
          type="checkbox" role="switch" ${this.audience.visibility === 'private' ? 'checked' : ''}
          ${disabled ? 'disabled' : ''}><span class="toggle-slider"></span></label>
      </div>` : ''}
      <div class="share-audience" data-audience-selection ${this.audience.visibility === 'private' ? '' : 'hidden'}>
        <label class="share-audience-label">${t(this.mode === 'audience' ? 'audience.who' : 'channelPermissions.targets')}</label>
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
        ${this.mode === 'audience' ? '<p class="audio-device-status" data-audience-status role="status" aria-live="polite"></p>' : ''}
      </div>
    </section>`;
  }

  bind(container: HTMLElement, signal: AbortSignal, onChange: () => void): void {
    let positioningScroll = false;
    let positioningScrollTimer: number | null = null;
    const finishPositioningScroll = (cancel = false) => {
      if (positioningScrollTimer !== null) window.clearTimeout(positioningScrollTimer);
      positioningScrollTimer = null;
      if (cancel && positioningScroll) {
        container.scrollTo({ top: container.scrollTop, left: container.scrollLeft, behavior: 'instant' });
      }
      positioningScroll = false;
    };
    const closePopup = () => {
      if (!this.open) return;
      finishPositioningScroll(true);
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
      const triggerBox = trigger.getBoundingClientRect();
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
    const revealTrigger = (trigger: HTMLElement) => {
      const box = trigger.getBoundingClientRect();
      if (this.placement !== 'below' || window.innerHeight - box.bottom >= 240) return;
      const before = container.scrollTop;
      positioningScroll = true;
      const destination = scrollWithin(container, trigger, Math.max(0, (container.clientHeight - box.height) / 2));
      if (Math.abs(destination - before) < 1) {
        finishPositioningScroll();
        return;
      }
      positioningScrollTimer = window.setTimeout(() => {
        finishPositioningScroll();
        positionPopup();
      }, 500);
    };
    this.positionOpenPopup = positionPopup;
    signal.addEventListener('abort', () => {
      closePopup();
      if (this.positionOpenPopup === positionPopup) this.positionOpenPopup = null;
      finishPositioningScroll(true);
    }, { once: true });
    window.addEventListener('resize', positionPopup, { signal });
    document.addEventListener('scroll', event => {
      if (!this.open) return;
      const root = container.querySelector<HTMLElement>(
        `[data-resource-audience="${CSS.escape(this.prefix)}"]`,
      );
      if (!root || !(event.target instanceof Node) || !event.target.contains(root)) return;
      if (!positioningScroll) {
        closePopup();
        return;
      }
      positionPopup();
      if (positioningScrollTimer !== null) window.clearTimeout(positioningScrollTimer);
      positioningScrollTimer = window.setTimeout(() => {
        finishPositioningScroll();
        positionPopup();
      }, 120);
    }, { capture: true, signal });
    document.addEventListener('wheel', event => {
      if (!this.open) return;
      const root = container.querySelector<HTMLElement>(
        `[data-resource-audience="${CSS.escape(this.prefix)}"]`,
      );
      const popup = root?.querySelector<HTMLElement>('[data-audience-popup]');
      if (!(event.target instanceof Node) || popup?.contains(event.target)) return;
      const modal = container.closest('.community-modal, [role="dialog"]') ?? container;
      if (!modal.contains(event.target)) return;
      closePopup();
    }, { capture: true, passive: true, signal });
    document.addEventListener('pointerdown', event => {
      if (!this.open || !(event.target instanceof Node)) return;
      const root = container.querySelector<HTMLElement>(
        `[data-resource-audience="${CSS.escape(this.prefix)}"]`,
      );
      if (root?.querySelector('[data-audience-popup]')?.contains(event.target)
        || root?.querySelector('[data-audience-toggle]')?.contains(event.target)) return;
      const modal = container.closest('.community-modal, [role="dialog"]') ?? container;
      if (modal.contains(event.target)) closePopup();
    }, { capture: true, signal });
    document.addEventListener('keydown', event => {
      if (!this.open || !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
        || !(event.target instanceof Node)) return;
      if (event.key === ' ' && event.target instanceof Element && event.target.closest('button, input, textarea, select')) return;
      const popup = container.querySelector(
        `[data-resource-audience="${CSS.escape(this.prefix)}"] [data-audience-popup]`,
      );
      const modal = container.closest('.community-modal, [role="dialog"]') ?? container;
      if (!popup?.contains(event.target) && modal.contains(event.target)) closePopup();
    }, { capture: true, signal });
    container.addEventListener('change', event => {
      const input = event.target instanceof HTMLInputElement ? event.target : null;
      if (!input?.matches('[data-audience-private]')) return;
      closePopup();
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
      if (!root || !target || target.closest('button')?.matches(':disabled')) return;
      if (target.closest('[data-audience-toggle]')) {
        if (this.open) { closePopup(); return; }
        root.querySelector<HTMLElement>('.share-audience-options')!.innerHTML = this.options();
        this.open = true;
        this.sync(container);
        const trigger = root.querySelector<HTMLElement>('[data-audience-toggle]');
        if (trigger) revealTrigger(trigger);
        positionPopup();
        root.querySelector<HTMLInputElement>('[data-audience-search]')?.focus({ preventScroll: true });
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
      if (!this.open) return;
      const target = event.target instanceof Element ? event.target : null;
      const root = target?.closest<HTMLElement>(`[data-resource-audience="${CSS.escape(this.prefix)}"]`);
      if (!root) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePopup();
        root.querySelector<HTMLButtonElement>('[data-audience-toggle]')?.focus({ preventScroll: true });
        return;
      }
      const searching = target?.matches('[data-audience-search]');
      const current = target?.closest<HTMLButtonElement>('[data-audience-id]');
      const choices = [...root.querySelectorAll<HTMLButtonElement>('[data-audience-id]:not([hidden])')];
      if (searching && event.key === 'Enter') {
        event.preventDefault();
        choices[0]?.click();
      } else if (['ArrowDown', 'ArrowUp'].includes(event.key) || current && ['Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const index = current ? choices.indexOf(current) : -1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % choices.length
            : index <= 0 ? choices.length - 1 : index - 1;
        choices[next]?.focus({ preventScroll: true });
        if (choices[next]) smoothScrollIntoView(choices[next], { block: 'nearest' });
      }
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
      summary.innerHTML = selectedOptions.length && this.mode === 'audience'
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
      .filter(user => (this.mode === 'permission-targets' || user.id !== this.server.currentUser?.id) && !user.isBot)
      .map(user => ({ id: user.id, name: user.nickname, avatarUrl: user.avatarUrl }));
    return `<div class="share-audience-group" role="group">
      <h4>${t('audience.roles')}</h4>${render('role', this.mode === 'permission-targets' ? this.server.getVisibleRoles() : this.server.roles)}
    </div><div class="share-audience-group" role="group">
      <h4>${t('audience.members')}</h4>${render('user', members)}
    </div>`;
  }
}
