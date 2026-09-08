import { appEvents } from '../core/EventBus';

export interface ContextMenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  onClick: () => void;
}

/**
 * Lightweight floating menu anchored at a screen position. Reused for
 * per-channel "more options" (#151) and designed to grow as more actions are
 * added. Dismisses on outside click, Escape, resize or network loss.
 */
export class ContextMenu {
  private menuEl: HTMLElement | null = null;
  private unbindGlobalListeners: Array<() => void> = [];
  private returnFocus: HTMLElement | null = null;

  constructor() {
    appEvents.on('network.disconnected', () => this.close());
    appEvents.on('voice.channel_changed', () => this.close());
  }

  public open(x: number, y: number, items: ContextMenuItem[], anchor?: HTMLElement): void {
    this.close();
    if (!items.length) return;
    this.returnFocus = anchor ?? null;

    const menu = document.createElement('div');
    menu.className = 'floating-context-menu';
    menu.setAttribute('role', 'menu');

    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'menuitem');
      btn.className = 'server-dropdown-item' + (item.danger ? ' danger' : '');
      btn.innerHTML = `${
        item.icon ? `<span class="material-symbols-outlined md-18">${item.icon}</span>` : ''
      }<span>${item.label}</span>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.close();
        item.onClick();
      });
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    this.menuEl = menu;

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

    this.attachDismiss();
    menu.querySelector('button')?.focus({ preventScroll: true });
  }

  private attachDismiss(): void {
    const handleOutsideClick = (e: Event) => {
      if (this.menuEl && !this.menuEl.contains(e.target as Node)) this.close();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        const anchor = this.returnFocus;
        this.close();
        anchor?.focus({ preventScroll: true });
      }
      if (e.key === 'Tab') this.close();
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && this.menuEl) {
        e.preventDefault();
        const buttons = Array.from(this.menuEl.querySelectorAll('button'));
        const current = buttons.findIndex((button) => button === document.activeElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
          : (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
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
    });
  }

  public close(): void {
    this.returnFocus = null;
    this.unbindGlobalListeners.forEach((u) => u());
    this.unbindGlobalListeners = [];
    if (this.menuEl) {
      this.menuEl.remove();
      this.menuEl = null;
    }
  }
}

export const contextMenu = new ContextMenu();
