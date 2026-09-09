import { scrollWithin } from '../../utils/scroll';

interface SectionLink {
  target: HTMLElement;
  key: string;
  label: string;
  button: HTMLButtonElement;
}

interface SectionMenu {
  trigger: HTMLButtonElement;
  menu: HTMLElement;
  content: HTMLElement;
  expanded: boolean;
  animation: Animation | null;
}

let nextNavigationId = 0;

export class SettingsSectionNavigation {
  private readonly sidebar: HTMLElement;
  private readonly body: HTMLElement;
  private readonly navigationId = ++nextNavigationId;
  private readonly unbind: Array<() => void> = [];
  private readonly generatedIds = new Map<HTMLElement, string>();
  private nextElementId = 0;
  private readonly menus = new Map<string, SectionMenu>();
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly observer: MutationObserver;
  private readonly resizeObserver: ResizeObserver;
  private panel: HTMLElement | null = null;
  private activeTab = '';
  private sections: SectionLink[] = [];
  private scrollingTo: HTMLElement | null = null;
  private frame: number | null = null;
  private needsRefresh = false;
  private destroyed = false;

  constructor(private readonly root: HTMLElement) {
    const sidebar = root.querySelector<HTMLElement>('.settings-sidebar');
    const body = root.querySelector<HTMLElement>('.settings-content-body');
    if (!sidebar || !body) throw new Error('Settings section navigation requires a sidebar and content body');
    this.sidebar = sidebar;
    this.body = body;

    for (const trigger of sidebar.querySelectorAll<HTMLButtonElement>('.settings-tab-btn[data-tab]')) {
      const tab = trigger.dataset.tab!;
      const menu = document.createElement('div');
      menu.id = `settings-subsections-${this.navigationId}-${tab}`;
      menu.className = 'settings-section-nav';
      menu.hidden = true;
      menu.inert = true;
      menu.setAttribute('aria-hidden', 'true');
      menu.setAttribute('role', 'group');
      const content = document.createElement('div');
      content.className = 'settings-section-list';
      menu.append(content);
      this.ensureId(trigger);
      menu.setAttribute('aria-labelledby', trigger.id);
      const expanded = trigger.getAttribute('aria-expanded');
      const controls = trigger.getAttribute('aria-controls');
      trigger.setAttribute('aria-controls', menu.id);
      trigger.setAttribute('aria-expanded', 'false');
      trigger.after(menu);
      this.menus.set(tab, { trigger, menu, content, expanded: false, animation: null });
      this.unbind.push(() => {
        if (expanded === null) trigger.removeAttribute('aria-expanded');
        else trigger.setAttribute('aria-expanded', expanded);
        if (controls === null) trigger.removeAttribute('aria-controls');
        else trigger.setAttribute('aria-controls', controls);
        menu.remove();
      });
    }

    this.observer = new MutationObserver((records) => {
      if (records.some(({ type, target }) => {
        if (!(target instanceof HTMLElement)) return false;
        if (type === 'childList') return this.panel?.contains(target) || target === body;
        return target.parentElement === body || this.panel?.contains(target)
          && (target.hasAttribute('data-settings-section') || !!target.querySelector('[data-settings-section]'));
      })) this.schedule(true);
    });
    this.observer.observe(body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['hidden', 'style', 'class', 'data-settings-section', 'data-settings-label'],
    });
    this.resizeObserver = new ResizeObserver(() => this.schedule(true));
    this.resizeObserver.observe(body);
    const stopMotion = () => {
      if (this.reducedMotion.matches) {
        for (const group of this.menus.values()) this.finishMenuMotion(group);
      }
    };
    this.reducedMotion.addEventListener('change', stopMotion);
    const onScroll = () => this.schedule();
    const onScrollEnd = () => { this.scrollingTo = null; };
    const interrupt = () => {
      if (this.scrollingTo) body.scrollTo({ top: body.scrollTop, behavior: 'instant' });
      this.scrollingTo = null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab'].includes(event.key)) interrupt();
    };
    body.addEventListener('scroll', onScroll, { passive: true });
    body.addEventListener('scrollend', onScrollEnd);
    body.addEventListener('wheel', interrupt, { passive: true });
    body.addEventListener('touchstart', interrupt, { passive: true });
    body.addEventListener('pointerdown', interrupt);
    root.addEventListener('keydown', onKeyDown);
    this.unbind.push(() => {
      body.removeEventListener('scroll', onScroll);
      body.removeEventListener('scrollend', onScrollEnd);
      body.removeEventListener('wheel', interrupt);
      body.removeEventListener('touchstart', interrupt);
      body.removeEventListener('pointerdown', interrupt);
      root.removeEventListener('keydown', onKeyDown);
      this.reducedMotion.removeEventListener('change', stopMotion);
    });
  }

  public setTab(tab: string): void {
    if (this.destroyed) return;
    const panel = this.root.querySelector<HTMLElement>(`#tab-panel-${CSS.escape(tab)}`);
    if (!panel || !this.menus.has(tab)) return;
    const changed = this.activeTab !== tab;
    if (this.panel !== panel) {
      if (this.panel) this.resizeObserver.unobserve(this.panel);
      this.panel = panel;
      this.resizeObserver.observe(panel);
    }
    this.activeTab = tab;
    this.scrollingTo = null;
    for (const [key, group] of this.menus) {
      if (key !== tab) this.setExpanded(group, false);
    }
    if (changed) this.body.scrollTo({ top: 0, behavior: 'instant' });
    this.refresh();
  }

  private finishMenuMotion(group: SectionMenu): void {
    const animation = group.animation;
    group.animation = null;
    group.menu.hidden = !group.expanded;
    if (animation) {
      animation.onfinish = null;
      animation.cancel();
    }
  }

  private setExpanded(group: SectionMenu, expanded: boolean): void {
    if (group.expanded === expanded) return;
    const { menu } = group;
    const hidden = menu.hidden;
    const current = getComputedStyle(menu);
    const gap = Number.parseFloat(getComputedStyle(this.sidebar).rowGap);
    // Cancel the extra flex gap while collapsed, avoiding a jump when hidden is applied.
    const collapsedMargin = Number.isFinite(gap) ? -gap / 2 : 0;
    const from = {
      height: hidden ? '0px' : `${menu.getBoundingClientRect().height}px`,
      opacity: hidden ? '0' : current.opacity,
      marginTop: hidden ? `${collapsedMargin}px` : current.marginTop,
      marginBottom: hidden ? `${collapsedMargin}px` : current.marginBottom,
    };
    group.expanded = expanded;
    if (!expanded && menu.contains(document.activeElement)) {
      this.menus.get(this.activeTab)?.trigger.focus({ preventScroll: true });
    }
    this.finishMenuMotion(group);
    group.trigger.setAttribute('aria-expanded', String(expanded));
    menu.inert = !expanded;
    menu.setAttribute('aria-hidden', String(!expanded));
    if (this.reducedMotion.matches || !menu.isConnected) return;
    menu.hidden = false;
    const natural = getComputedStyle(menu);
    const animation = menu.animate([from, {
      height: expanded ? `${menu.getBoundingClientRect().height}px` : '0px',
      opacity: expanded ? '1' : '0',
      marginTop: expanded ? natural.marginTop : `${collapsedMargin}px`,
      marginBottom: expanded ? natural.marginBottom : `${collapsedMargin}px`,
    }], { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both' });
    group.animation = animation;
    animation.onfinish = () => {
      if (group.animation === animation) this.finishMenuMotion(group);
    };
  }

  private ensureId(element: HTMLElement): void {
    if (element.id) return;
    const id = `settings-section-${this.navigationId}-${this.nextElementId++}`;
    element.id = id;
    this.generatedIds.set(element, id);
  }

  private schedule(refresh = false): void {
    if (this.destroyed) return;
    this.needsRefresh ||= refresh;
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      const refresh = this.needsRefresh;
      this.needsRefresh = false;
      if (refresh) this.refresh();
      else this.updateCurrent();
    });
  }

  private refresh(): void {
    const group = this.menus.get(this.activeTab);
    if (!group || !this.panel) return;
    for (const [element, id] of this.generatedIds) {
      if (!this.root.contains(element)) {
        if (element.id === id) element.removeAttribute('id');
        this.generatedIds.delete(element);
      }
    }
    const targets = Array.from(this.panel.querySelectorAll<HTMLElement>('[data-settings-section]'))
      .filter((target) => target.checkVisibility({ checkVisibilityCSS: true }));
    const changed = targets.length !== this.sections.length || targets.some((target, index) => {
      const previous = this.sections[index];
      return previous?.target !== target || previous.key !== target.dataset.settingsSection
        || previous.label !== target.dataset.settingsLabel;
    });
    if (changed) {
      const focusedKey = this.sections.find(({ button }) => button === document.activeElement)?.key;
      const used = new Set<string>();
      this.sections = [];
      for (const target of targets) {
        const key = target.dataset.settingsSection;
        const label = target.dataset.settingsLabel;
        if (!key || !label || used.has(key)) {
          console.warn('[SettingsSectionNavigation] Invalid or duplicate section:', key);
          continue;
        }
        used.add(key);
        this.ensureId(target);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-section-link';
        button.dataset.sectionTarget = key;
        button.textContent = label;
        button.setAttribute('aria-controls', target.id);
        button.addEventListener('click', () => {
          this.scrollingTo = target;
          this.select(target);
          const destination = scrollWithin(this.body, target, 16);
          if (Math.abs(this.body.scrollTop - destination) < 1) this.scrollingTo = null;
        });
        this.sections.push({ target, key, label, button });
      }
      group.content.replaceChildren(...this.sections.map(({ button }) => button));
      this.sections.find(({ key }) => key === focusedKey)?.button.focus({ preventScroll: true });
    }
    this.setExpanded(group, this.sections.length > 0);
    if (this.scrollingTo && !this.sections.some(({ target }) => target === this.scrollingTo)) this.scrollingTo = null;
    this.updateCurrent();
  }

  private updateCurrent(): void {
    if (this.scrollingTo || !this.sections.length) return;
    const top = this.body.getBoundingClientRect().top + this.body.clientTop + 24;
    let current = this.sections[0];
    for (const section of this.sections) {
      if (section.target.getBoundingClientRect().top <= top) current = section;
    }
    if (this.body.scrollTop > 0 && this.body.scrollHeight - this.body.clientHeight - this.body.scrollTop <= 2) {
      current = this.sections[this.sections.length - 1];
    }
    this.select(current.target);
  }

  private select(target: HTMLElement): void {
    for (const section of this.sections) {
      const active = section.target === target;
      section.button.classList.toggle('active', active);
      if (active) section.button.setAttribute('aria-current', 'location');
      else section.button.removeAttribute('aria-current');
    }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.observer.disconnect();
    this.resizeObserver.disconnect();
    for (const group of this.menus.values()) this.finishMenuMotion(group);
    this.unbind.forEach((off) => off());
    this.unbind.length = 0;
    for (const [element, id] of this.generatedIds) {
      if (element.id === id) element.removeAttribute('id');
    }
    this.generatedIds.clear();
    this.menus.clear();
    this.sections = [];
    this.panel = null;
    this.scrollingTo = null;
  }
}
