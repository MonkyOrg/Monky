import { appEvents } from '../core/EventBus';

export interface ContextMenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  shortcut?: string;
  onClick: () => void;
}

export interface ContextMenuSubmenu {
  label: string;
  icon?: string;
  submenu: ContextMenuItem[];
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSubmenu;

/**
 * Lightweight floating menu anchored at a screen position. Reused for
 * per-channel "more options" (#151) and designed to grow as more actions are
 * added. Dismisses on outside click, Escape, resize or network loss.
 */
export class ContextMenu {
  private menuEl: HTMLElement | null = null;
  private submenuEl: HTMLElement | null = null;
  private submenuTrigger: HTMLButtonElement | null = null;
  private unbindGlobalListeners: Array<() => void> = [];
  private returnFocus: HTMLElement | null = null;
  private submenuId = 0;

  public open(x: number, y: number, items: ContextMenuEntry[], anchor?: HTMLElement): void {
    this.close();
    if (!items.length) return;
    this.returnFocus = anchor ?? null;
    anchor?.setAttribute('aria-expanded', 'true');

    const menu = this.createMenu(items);
    document.body.appendChild(menu);
    this.menuEl = menu;
    this.positionMenu(menu, x, y);

    this.attachDismiss();
    menu.querySelector('button')?.focus({ preventScroll: true });
  }

  private createMenu(items: ContextMenuEntry[]): HTMLElement {
    const menu = document.createElement('div');
    menu.className = 'floating-context-menu';
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.tabIndex = -1;
      btn.setAttribute('role', 'menuitem');
      btn.className = 'server-dropdown-item' + ('danger' in item && item.danger ? ' danger' : '');
      if (item.icon) {
        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined md-18';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = item.icon;
        btn.appendChild(icon);
      }
      const label = document.createElement('span');
      label.textContent = item.label;
      btn.appendChild(label);
      if ('submenu' in item) {
        btn.setAttribute('aria-haspopup', 'menu');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-label', item.label);
        const arrow = document.createElement('span');
        arrow.className = 'material-symbols-outlined md-18 context-menu-trailing';
        arrow.textContent = 'chevron_right';
        arrow.setAttribute('aria-hidden', 'true');
        btn.appendChild(arrow);
        btn.addEventListener('pointerenter', () => this.openSubmenu(btn, item.submenu, false));
        btn.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowRight') return;
          event.preventDefault();
          this.openSubmenu(btn, item.submenu, true);
        });
      } else if (item.shortcut) {
        const shortcut = document.createElement('kbd');
        shortcut.className = 'context-menu-trailing';
        shortcut.textContent = item.shortcut;
        btn.appendChild(shortcut);
      }
      btn.addEventListener('pointerenter', () => {
        if (menu === this.menuEl && btn !== this.submenuTrigger) this.closeSubmenu();
      });
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if ('submenu' in item) {
          this.openSubmenu(btn, item.submenu, true);
          return;
        }
        const anchor = this.returnFocus;
        this.close();
        if (e.detail === 0 && anchor?.isConnected) anchor.focus({ preventScroll: true });
        item.onClick();
      });
      menu.appendChild(btn);
    }
    return menu;
  }

  private openSubmenu(trigger: HTMLButtonElement, items: ContextMenuItem[], focus: boolean): void {
    if (!this.menuEl || !items.length) return;
    if (this.submenuTrigger !== trigger) {
      this.closeSubmenu();
      const submenu = this.createMenu(items);
      submenu.classList.add('floating-context-submenu');
      submenu.id = `context-submenu-${++this.submenuId}`;
      submenu.setAttribute('aria-label', trigger.getAttribute('aria-label') ?? '');
      document.body.appendChild(submenu);
      this.submenuEl = submenu;
      this.submenuTrigger = trigger;
      trigger.setAttribute('aria-controls', submenu.id);
      trigger.setAttribute('aria-expanded', 'true');
      const parent = this.menuEl.getBoundingClientRect();
      const rect = trigger.getBoundingClientRect();
      const width = submenu.getBoundingClientRect().width;
      const x = parent.right + width > window.innerWidth - 12 ? parent.left - width : parent.right;
      this.positionMenu(submenu, x, rect.top);
    }
    if (focus) this.submenuEl?.querySelector('button')?.focus({ preventScroll: true });
  }

  private positionMenu(menu: HTMLElement, x: number, y: number): void {
    // Keep the menu within the viewport.
    const rect = menu.getBoundingClientRect();
    let posX = x;
    let posY = y;
    if (posX + rect.width > window.innerWidth - 12) posX = window.innerWidth - rect.width - 12;
    if (posY + rect.height > window.innerHeight - 12) posY = window.innerHeight - rect.height - 12;
    if (posX < 12) posX = 12;
    if (posY < 12) posY = 12;
    menu.style.left = `${posX}px`;
    menu.style.top = `${posY}px`;
  }

  private attachDismiss(): void {
    const handleOutsideClick = (e: Event) => {
      if (e.target instanceof Node && this.menuEl
        && !this.menuEl.contains(e.target) && !this.submenuEl?.contains(e.target)
        && !this.returnFocus?.contains(e.target)) this.close();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Escape' || e.key === 'ArrowLeft') && this.submenuEl) {
        e.preventDefault();
        e.stopPropagation();
        const trigger = this.submenuTrigger;
        this.closeSubmenu();
        trigger?.focus({ preventScroll: true });
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const anchor = this.returnFocus;
        this.close();
        anchor?.focus({ preventScroll: true });
      }
      if (e.key === 'Tab') this.close();
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && this.menuEl) {
        e.preventDefault();
        const activeMenu = this.submenuEl?.contains(document.activeElement) ? this.submenuEl : this.menuEl;
        if (activeMenu === this.menuEl) this.closeSubmenu();
        const buttons = Array.from(activeMenu.querySelectorAll('button'));
        const current = buttons.findIndex((button) => button === document.activeElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
          : (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus({ preventScroll: true });
      }
    };
    const handleResize = () => this.close();

    // Opening happens after pointerdown/capture; no delayed callback may
    // install listeners after a menu has already been destroyed.
    document.addEventListener('pointerdown', handleOutsideClick, true);
    document.addEventListener('contextmenu', handleOutsideClick, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleResize, true);

    this.unbindGlobalListeners.push(() => {
      document.removeEventListener('pointerdown', handleOutsideClick, true);
      document.removeEventListener('contextmenu', handleOutsideClick, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleResize, true);
    },
    appEvents.on('network.disconnected', () => this.close()),
    appEvents.on('voice.channel_changed', () => this.close()),
    appEvents.on('session.changed', () => this.close()));
  }

  public isOpenFor(anchor: HTMLElement): boolean {
    return this.menuEl !== null && this.returnFocus === anchor;
  }

  public close(): void {
    this.closeSubmenu();
    this.returnFocus?.setAttribute('aria-expanded', 'false');
    this.returnFocus = null;
    this.unbindGlobalListeners.forEach((u) => u());
    this.unbindGlobalListeners = [];
    if (this.menuEl) {
      this.menuEl.remove();
      this.menuEl = null;
    }
  }

  private closeSubmenu(): void {
    this.submenuTrigger?.setAttribute('aria-expanded', 'false');
    this.submenuTrigger?.removeAttribute('aria-controls');
    this.submenuTrigger = null;
    this.submenuEl?.remove();
    this.submenuEl = null;
  }
}

export const contextMenu = new ContextMenu();
