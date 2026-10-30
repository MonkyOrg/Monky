import {
  AUDIENCE_LIMITS,
  PUBLIC_AUDIENCE,
  type ResourceAudience,
} from '@monky/shared';
import type { ServerStore } from '../stores/serverStore';
import { getAvatarUrl } from '../utils/avatar';
import { isHexColor } from '../utils/colors';
import { escapeHtml } from '../utils/html';
import { t, type TranslationKey } from '../i18n';
import { scrollWithin, smoothScrollIntoView } from '../utils/scroll';
import { focusItem, nextIndex } from '../utils/rovingFocus';
import { animateEnter, hideWithMotion, ownSurface } from '../utils/surfaceMotion';
import { setSurfaceVisible } from '../utils/surfaceVisibility';

/** Where the members and roles on offer come from. */
export type AudienceDirectory = Pick<ServerStore, 'knownMembers' | 'currentUser' | 'roles' | 'getVisibleRoles'>;

/** What the picker says; a screen share speaks of who can watch, a community resource of who can access. */
export interface AudienceTexts {
  readonly private: TranslationKey;
  readonly description: TranslationKey;
  readonly who: TranslationKey;
  readonly search: TranslationKey;
  readonly choose: TranslationKey;
  readonly noResults: TranslationKey;
  readonly empty: TranslationKey;
  /** With `{count}`. */
  readonly selected: TranslationKey;
  readonly roles: TranslationKey;
  readonly members: TranslationKey;
  /** The accessible name of the "+N" after the first selections, with `{count}`. */
  readonly more?: TranslationKey;
}

const RESOURCE_TEXTS: AudienceTexts = {
  private: 'audience.private', description: 'audience.description', who: 'audience.who', search: 'audience.search',
  choose: 'audience.choose', noResults: 'audience.noResults', empty: 'audience.empty', selected: 'audience.selected',
  roles: 'audience.roles', members: 'audience.members',
};

export interface AudiencePickerOptions {
  readonly texts?: Partial<AudienceTexts>;
  /** The host shows its own private/public switch and reports it with setPrivate(). */
  readonly externalSwitch?: boolean;
  /** Classes of the picker's root; the community resource block by default. */
  readonly className?: string;
}

export class ResourceAudiencePicker {
  private audience: ResourceAudience;
  /** Who was chosen before the host's switch made the audience public (setPrivate). */
  private parked: { userIds: string[]; roleIds: string[] } | null = null;
  private open = false;
  private disabled = false;
  private readonly texts: AudienceTexts;
  private readonly externalSwitch: boolean;
  private readonly className: string;
  private positionOpenPopup: (() => void) | null = null;
  private openPopup: (() => void) | null = null;
  /**
   * The open popup is registered as a surface of its trigger, so the modal
   * around it leaves Escape to the popup instead of closing everything.
   */
  private ownedPopup: HTMLElement | null = null;
  private releaseOwner: (() => void) | null = null;

  constructor(
    private readonly server: AudienceDirectory | (() => AudienceDirectory | null),
    private readonly prefix: string,
    initial: ResourceAudience = PUBLIC_AUDIENCE,
    private readonly placement: 'adaptive' | 'below' = 'adaptive',
    private readonly mode: 'audience' | 'permission-targets' = 'audience',
    options: AudiencePickerOptions = {},
  ) {
    this.audience = initial.visibility === 'private'
      ? { visibility: 'private', userIds: [...initial.userIds], roleIds: [...initial.roleIds] }
      : PUBLIC_AUDIENCE;
    this.texts = { ...RESOURCE_TEXTS, ...options.texts };
    this.externalSwitch = options.externalSwitch === true;
    this.className = options.className ?? 'resource-audience';
  }

  value(): ResourceAudience {
    return this.audience.visibility === 'private'
      ? { visibility: 'private', userIds: [...this.audience.userIds], roleIds: [...this.audience.roleIds] }
      : PUBLIC_AUDIENCE;
  }

  setValue(value: ResourceAudience): void {
    this.parked = null;
    this.audience = value.visibility === 'private'
      ? { visibility: 'private', userIds: [...value.userIds], roleIds: [...value.roleIds] }
      : PUBLIC_AUDIENCE;
  }

  isValid(): boolean {
    return this.mode === 'permission-targets' || this.audience.visibility === 'public' ||
      this.audience.userIds.length + this.audience.roleIds.length > 0;
  }

  /**
   * The host's own switch made the audience public or private again. Switching it off sets who
   * was chosen aside, unsent, so switching back on restores them instead of starting over.
   */
  setPrivate(container: ParentNode, isPrivate: boolean): void {
    if (isPrivate === (this.audience.visibility === 'private')) return;
    this.open = false;
    if (this.audience.visibility === 'private') {
      this.parked = { userIds: [...this.audience.userIds], roleIds: [...this.audience.roleIds] };
      this.audience = PUBLIC_AUDIENCE;
    } else {
      const { userIds = [], roleIds = [] } = this.parked ?? {};
      this.audience = { visibility: 'private', userIds: [...userIds], roleIds: [...roleIds] };
    }
    this.sync(container);
  }

  /** Nothing can be chosen while the host's operation is in flight; the list closes. */
  setDisabled(container: ParentNode, disabled: boolean): void {
    if (disabled && this.open) this.open = false;
    this.disabled = disabled;
    this.sync(container);
  }

  /** Opens the list with focus in its search, as the host asks for a choice. */
  showOptions(): void {
    if (!this.open && !this.disabled && this.audience.visibility === 'private') this.openPopup?.();
  }

  render(disabled = false): string {
    this.disabled = disabled;
    const id = (part: string): string => escapeHtml(`${this.prefix}-${part}`);
    const isPrivate = this.audience.visibility === 'private';
    const hasStatus = this.mode === 'audience';
    const listed = this.listsOptions();
    return `<section class="${escapeHtml(this.className)}" data-resource-audience="${escapeHtml(this.prefix)}">
      ${this.mode === 'audience' && !this.externalSwitch ? `<div class="bot-permission-row resource-audience-mode">
        <div><label for="${id('private')}">${t(this.texts.private)}</label>
          <p class="bot-settings-description">${t(this.texts.description)}</p></div>
        <label class="toggle-switch"><input id="${id('private')}" data-audience-private
          type="checkbox" role="switch" aria-controls="${escapeHtml(this.prefix)}" ${isPrivate ? 'checked' : ''}
          ${disabled ? 'disabled' : ''}><span class="toggle-slider"></span></label>
      </div>` : ''}
      <div class="share-audience" id="${escapeHtml(this.prefix)}" data-audience-selection ${isPrivate ? '' : 'hidden'}>
        <label class="share-audience-label" for="${id('toggle')}">${t(this.mode === 'audience' ? this.texts.who : 'channelPermissions.targets')}</label>
        <div class="share-audience-picker">
          <button type="button" id="${id('toggle')}" class="share-audience-trigger" data-audience-toggle aria-haspopup="listbox"
            aria-expanded="${this.open}" aria-controls="${id('options')}"${hasStatus ? ` aria-describedby="${id('status')}"` : ''}
            ${disabled ? 'disabled' : ''}>
            <span id="${id('summary')}" class="share-audience-summary" data-audience-summary></span>
            <span class="material-symbols-outlined md-20 share-audience-chevron" aria-hidden="true">expand_more</span>
          </button>
          <div id="${id('popup')}" class="share-audience-popup" data-audience-popup popover="manual" ${this.open ? '' : 'hidden'}>
            <div class="share-audience-search">
              <span class="material-symbols-outlined md-18" aria-hidden="true">search</span>
              <input type="search" id="${id('search')}" data-audience-search autocomplete="off" aria-controls="${id('options')}"
                aria-label="${escapeHtml(t(this.texts.search))}" placeholder="${escapeHtml(t(this.texts.search))}">
            </div>
            <div id="${id('options')}" class="share-audience-options" role="listbox" aria-multiselectable="true"
              aria-label="${escapeHtml(t(this.mode === 'audience' ? this.texts.who : 'channelPermissions.targets'))}"
              ${listed ? 'data-audience-rendered' : ''}>${listed ? this.options() : ''}</div>
            <p id="${id('no-results')}" data-audience-no-results role="status" hidden>${t(this.texts.noResults)}</p>
          </div>
        </div>
        ${hasStatus ? `<p class="audio-device-status" id="${id('status')}" data-audience-status role="status" aria-live="polite"></p>` : ''}
      </div>
    </section>`;
  }

  bind(container: HTMLElement, signal: AbortSignal, onChange: () => void): void {
    let positioningScroll = false;
    let positioningScrollTimer: number | null = null;
    let placedAt: { top: number; left: number } | null = null;
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
      placedAt = { top: triggerBox.top, left: triggerBox.left };
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
    const openPopup = (root: HTMLElement) => {
      // Members come and go: the list is rebuilt each time it opens.
      this.renderOptions(root);
      this.open = true;
      this.sync(container);
      const trigger = root.querySelector<HTMLElement>('[data-audience-toggle]');
      if (trigger) revealTrigger(trigger);
      positionPopup();
      root.querySelector<HTMLInputElement>('[data-audience-search]')?.focus({ preventScroll: true });
    };
    const openFromHost = () => {
      const root = container.querySelector<HTMLElement>(`[data-resource-audience="${CSS.escape(this.prefix)}"]`);
      if (root) openPopup(root);
    };
    this.positionOpenPopup = positionPopup;
    this.openPopup = openFromHost;
    signal.addEventListener('abort', () => {
      closePopup();
      if (this.positionOpenPopup === positionPopup) this.positionOpenPopup = null;
      if (this.openPopup === openFromHost) this.openPopup = null;
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
        // Scroll events arrive a frame after the movement, so this one may report a
        // scroll that ended before the popup opened. Only a scroll that moves the
        // field away from where the popup was placed dismisses it.
        const box = root.querySelector<HTMLElement>('[data-audience-toggle]')?.getBoundingClientRect();
        if (!box || !placedAt || Math.abs(box.top - placedAt.top) >= 1 || Math.abs(box.left - placedAt.left) >= 1) {
          closePopup();
        }
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
    // While the popup is open the modal leaves the keyboard to it, Tab included,
    // so it closes as soon as focus moves past the picker.
    document.addEventListener('focusin', event => {
      if (!this.open || !(event.target instanceof Node)) return;
      const root = container.querySelector<HTMLElement>(
        `[data-resource-audience="${CSS.escape(this.prefix)}"]`,
      );
      if (!root?.contains(event.target)) closePopup();
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
        openPopup(root);
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
      const target = event.target instanceof Element ? event.target : null;
      const root = target?.closest<HTMLElement>(`[data-resource-audience="${CSS.escape(this.prefix)}"]`);
      if (!root) return;
      if (!this.open) {
        // A closed list opens from its field with the arrows, like a select.
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && target?.matches('[data-audience-toggle]:not(:disabled)')) {
          event.preventDefault();
          openPopup(root);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePopup();
        root.querySelector<HTMLButtonElement>('[data-audience-toggle]')?.focus({ preventScroll: true });
        return;
      }
      const searching = target?.matches('[data-audience-search]');
      const current = target?.closest<HTMLButtonElement>('[data-audience-id]');
      const choices = [...root.querySelectorAll<HTMLButtonElement>('[data-audience-id]')]
        .filter(choice => !choice.hidden && !choice.disabled);
      if (searching && event.key === 'Enter') {
        event.preventDefault();
        choices[0]?.click();
      } else if (['ArrowDown', 'ArrowUp'].includes(event.key) || current && ['Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = nextIndex(event.key, current ? choices.indexOf(current) : -1, choices.length);
        if (next !== null) focusItem(choices[next]);
      }
    }, { signal });
    this.sync(container);
    positionPopup();
  }

  sync(container: ParentNode): void {
    if (!this.open) this.releasePopup();
    const root = container.querySelector<HTMLElement>(`[data-resource-audience="${CSS.escape(this.prefix)}"]`);
    if (!root) return;
    const audience = this.audience;
    const isPrivate = audience.visibility === 'private';
    const section = root.querySelector<HTMLElement>('[data-audience-selection]');
    if (section) setSurfaceVisible(section, isPrivate);
    const privacy = root.querySelector<HTMLInputElement>('[data-audience-private]');
    if (privacy) privacy.disabled = this.disabled;
    const toggle = root.querySelector<HTMLButtonElement>('[data-audience-toggle]');
    toggle?.setAttribute('aria-expanded', String(this.open));
    if (toggle) toggle.disabled = this.disabled;
    const popup = root.querySelector<HTMLElement>('[data-audience-popup]');
    if (popup) {
      if (this.open) {
        const opening = popup.hidden || popup.hasAttribute('data-ui-closing');
        popup.hidden = false;
        if (typeof popup.showPopover === 'function' && popup.dataset.audiencePopoverOpen !== 'true') {
          popup.showPopover();
          popup.dataset.audiencePopoverOpen = 'true';
        }
        // A wizard step re-render replaces the popup while it stays open.
        if (toggle && this.ownedPopup !== popup) {
          this.releasePopup();
          this.releaseOwner = ownSurface(popup, toggle);
          this.ownedPopup = popup;
        }
        if (opening) animateEnter(popup, 'popover');
        this.positionOpenPopup?.();
        requestAnimationFrame(() => {
          if (this.open && popup.isConnected) this.positionOpenPopup?.();
        });
      } else if (!popup.hidden && !popup.hasAttribute('data-ui-closing')) {
        hideWithMotion(popup, 'popover', () => {
          if (typeof popup.hidePopover === 'function' && popup.dataset.audiencePopoverOpen === 'true') {
            popup.hidePopover();
          }
          delete popup.dataset.audiencePopoverOpen;
        });
      }
    }
    if (audience.visibility !== 'private') return;
    if (!root.querySelector('[data-audience-rendered]')) this.renderOptions(root);
    const search = root.querySelector<HTMLInputElement>('[data-audience-search]');
    if (search) search.disabled = this.disabled;
    const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
    const query = normalize(search?.value.trim() ?? '');
    const selectedOptions: HTMLButtonElement[] = [];
    let visible = 0;
    for (const option of root.querySelectorAll<HTMLButtonElement>('[data-audience-id]')) {
      const key = option.dataset.audienceKind === 'role' ? 'roleIds' : 'userIds';
      const chosen = audience[key];
      const selected = chosen.includes(option.dataset.audienceId ?? '');
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-selected', String(selected));
      // A private audience names at most AUDIENCE_LIMITS of each; the server refuses more.
      option.disabled = this.disabled || (this.mode === 'audience' && !selected
        && chosen.length >= (key === 'userIds' ? AUDIENCE_LIMITS.users : AUDIENCE_LIMITS.roles));
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
      const more = selectedOptions.length - 2;
      const content = selectedOptions.length && this.mode === 'audience'
        ? selectedOptions.slice(0, 2).map(option =>
          `<span class="share-audience-chip">${option.querySelector('.share-audience-identity')?.innerHTML ?? ''}</span>`).join('')
          + (more > 0 ? `<span class="share-audience-more"${this.texts.more
            ? ` aria-label="${escapeHtml(t(this.texts.more, { count: more }))}"` : ''}>+${more}</span>` : '')
        : `<span class="share-audience-placeholder">${escapeHtml(t(this.texts.choose))}</span>`;
      // Rewriting equal markup would replace the chips' avatars and make them reload.
      if (summary.innerHTML !== content) summary.innerHTML = content;
    }
    const empty = root.querySelector<HTMLElement>('[data-audience-no-results]');
    if (empty) empty.hidden = visible > 0;
    const status = root.querySelector<HTMLElement>('[data-audience-status]');
    if (status) status.textContent = this.isValid()
      ? t(this.texts.selected, { count: audience.userIds.length + audience.roleIds.length })
      : t(this.texts.empty);
  }

  private releasePopup(): void {
    this.releaseOwner?.();
    this.releaseOwner = null;
    this.ownedPopup = null;
  }

  /** A public audience never lists members: the list is built when someone could be chosen. */
  private listsOptions(): boolean {
    return this.mode === 'permission-targets' || this.audience.visibility === 'private';
  }

  private renderOptions(root: HTMLElement): void {
    const list = root.querySelector<HTMLElement>('.share-audience-options');
    if (!list) return;
    list.innerHTML = this.options();
    list.dataset.audienceRendered = '';
  }

  private directory(): AudienceDirectory | null {
    return typeof this.server === 'function' ? this.server() : this.server;
  }

  private options(): string {
    const server = this.directory();
    const render = (
      kind: 'role' | 'user',
      values: Array<{ id: string; name: string; color?: string | null; avatarUrl?: string | null }>,
    ) => [...values].sort((a, b) => a.name.localeCompare(b.name)).map(value => `
      <button type="button" class="share-audience-option" data-audience-kind="${kind}"
        data-audience-id="${escapeHtml(value.id)}" data-audience-name="${escapeHtml(value.name)}"
        role="option" aria-selected="false" tabindex="-1">
        <span class="share-audience-identity">
          ${kind === 'role'
            ? `<span class="share-audience-role" style="--role-color: ${isHexColor(value.color) ? value.color : 'var(--text-muted)'}" aria-hidden="true"></span>`
            : `<img class="share-audience-avatar" src="${escapeHtml(getAvatarUrl(value.avatarUrl))}" alt="" data-fallback="avatar" loading="lazy" decoding="async">`}
          <span class="share-audience-name">${escapeHtml(value.name)}</span>
        </span>
        <span class="material-symbols-outlined md-18 share-audience-check" aria-hidden="true">check</span>
      </button>`).join('');
    const members = [...server?.knownMembers.values() ?? []]
      .filter(user => (this.mode === 'permission-targets' || user.id !== server?.currentUser?.id) && !user.isBot)
      .map(user => ({ id: user.id, name: user.nickname, avatarUrl: user.avatarUrl }));
    const roles = !server ? [] : this.mode === 'permission-targets' ? server.getVisibleRoles() : server.roles;
    const heading = (part: string): string => escapeHtml(`${this.prefix}-${part}`);
    return `<div class="share-audience-group" role="group" aria-labelledby="${heading('roles')}">
      <h4 id="${heading('roles')}">${t(this.texts.roles)}</h4>${render('role', roles)}
    </div><div class="share-audience-group" role="group" aria-labelledby="${heading('members')}">
      <h4 id="${heading('members')}">${t(this.texts.members)}</h4>${render('user', members)}
    </div>`;
  }
}
