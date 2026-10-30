import { Permission, type ServerDetails } from '@monky/shared';
import { appEvents } from '../../core/EventBus';
import { sessionManager } from '../../core/SessionManager';
import { isForegroundEvent } from '../../core/sessionRouting';
import { canOpenServerAudit } from '../../core/ServerAuditSource';
import { serverStore } from '../../stores/serverStore';
import { html, type SafeHtml } from '../../utils/html';
import { getAvatarUrl } from '../../utils/avatar';
import { withButtonLoading } from '../../utils/buttonLoading';
import { nextIndex } from '../../utils/rovingFocus';
import { hideWithMotion, positionAnchoredSurface, showWithMotion } from '../../utils/surfaceMotion';
import { inviteModal } from '../InviteModal';
import { recentSoundsModal } from '../RecentSoundsModal';
import { showErrorToast } from '../CopyToast';
import { showAlert } from '../Dialog';
import logoUrl from '../../assets/Logo.png';
import { t } from '../../i18n';

/**
 * The server's name and icon at the top of the channel list, with the menu of
 * what can be done with the server. The menu is a dropdown as wide as its
 * button; each action shows only to whoever may use it.
 */
export class ServerHeader {
  constructor(private readonly root: HTMLElement) {}

  public markup(server: ServerDetails): SafeHtml {
    const item = (id: string, icon: string, label: string, title = label) => html`
      <button id="${id}" class="server-dropdown-item" title="${title}" hidden>
        <span class="material-symbols-outlined md-18">${icon}</span>
        <span>${label}</span>
      </button>`;
    return html`
      <div class="server-header">
        <button id="server-dropdown-toggle" class="server-dropdown-toggle" title="${t('main.serverOptions')}">
          <img id="server-header-icon" src="${server.iconUrl ? getAvatarUrl(server.iconUrl) : logoUrl}" alt="${t('serverSettings.iconAlt')}" style="width: 22px; height: 22px; object-fit: cover; border-radius: 4px; flex-shrink: 0;">
          <span id="server-name-title" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 700;">${server.name}</span>
          <span class="material-symbols-outlined md-18 server-dropdown-caret">expand_more</span>
        </button>
        <div id="server-dropdown-menu" class="server-dropdown-menu" role="menu" aria-labelledby="server-dropdown-toggle" hidden>
          ${item('btn-server-settings', 'settings', t('serverSettings.title'), t('main.serverSettingsTitle'))}
          ${item('btn-server-monitor', 'monitoring', t('serverMonitor.title'))}
          ${item('btn-server-audit', 'policy', t('serverAudit.title'))}
          ${item('btn-recent-sounds', 'history', t('recentSounds.title'))}
          ${item('btn-invite-friends', 'person_add', t('invite.title'), t('main.inviteTitle'))}
        </div>
      </div>`;
  }

  /** Shows the menu actions this member may use on the server on screen, with its connection as it is now. */
  public refresh(): void {
    const show = (id: string, visible: boolean) => {
      const button = this.root.querySelector<HTMLElement>(`#${id}`);
      if (button && button.hidden === visible) button.hidden = !visible;
    };
    // Always the server on screen: while a background server's event is
    // handled, the store proxies point at that server instead (#400).
    const session = sessionManager.getActive();
    const store = session?.serverStore ?? serverStore;
    const connected = session?.client.getStatus() === 'CONNECTED';
    const user = session?.serverStore.currentUser;
    show('btn-server-settings', store.hasPermission(Permission.MANAGE_SERVER)
      || store.hasPermission(Permission.MANAGE_ROLES) || store.hasPermission(Permission.MANAGE_BOTS)
      || store.hasPermission(Permission.MANAGE_EVENTS));
    show('btn-server-monitor', !!(connected && user && !user.isBot
      && session.serverStore.hasPermission(Permission.VIEW_SERVER_MONITOR)));
    show('btn-server-audit', !!session && canOpenServerAudit(session.serverStore, connected));
    show('btn-recent-sounds', !!store.serverDetails?.recentSoundCacheEnabled
      && !!store.serverDetails.protocol?.features.includes('recent-sounds'));
    show('btn-invite-friends', true);
  }

  /** A rename or a new icon of the server on screen (#400). */
  public showServer(name: string, iconUrl: string | null | undefined): void {
    const title = this.root.querySelector<HTMLElement>('#server-name-title');
    if (title) title.textContent = name;
    const icon = this.root.querySelector<HTMLImageElement>('#server-header-icon');
    if (icon) icon.src = iconUrl ? getAvatarUrl(iconUrl) : logoUrl;
  }

  public close(): void {
    const menu = this.root.querySelector<HTMLElement>('#server-dropdown-menu');
    const toggle = this.root.querySelector<HTMLElement>('#server-dropdown-toggle');
    if (menu && !menu.hidden) hideWithMotion(menu, 'popover');
    toggle?.classList.remove('open');
    toggle?.setAttribute('aria-expanded', 'false');
  }

  /** The menu's button, keyboard, actions and anchoring; returns their cleanup. */
  public bind(): () => void {
    const controller = new AbortController();
    const { signal } = controller;
    const toggle = this.root.querySelector<HTMLElement>('#server-dropdown-toggle');
    const menu = (): HTMLElement | null => this.root.querySelector<HTMLElement>('#server-dropdown-menu');
    const action = (id: string, run: (button: HTMLElement) => void) => {
      this.root.querySelector<HTMLElement>(`#${id}`)?.addEventListener('click', (event) => {
        this.close();
        if (event.currentTarget instanceof HTMLElement) run(event.currentTarget);
      }, { signal });
    };
    action('btn-invite-friends', button => withButtonLoading(button, () => inviteModal.open()));
    // The rare server screens load with their first opening, CSS included (#852).
    action('btn-server-settings', button => withButtonLoading(button, async () =>
      (await import('../ServerSettingsModal')).serverSettingsModal.open()));
    action('btn-server-monitor', button => {
      const session = sessionManager.getActive();
      withButtonLoading(button, async () => {
        if (!session) return showAlert({ title: t('serverMonitor.title'), message: t('serverMonitor.disconnected'), variant: 'warning' });
        const { serverMonitorModal } = await import('../ServerMonitorModal');
        // The server on screen may have changed while the screen loaded.
        if (sessionManager.getActive() === session) await serverMonitorModal.openRemote(session);
      });
    });
    action('btn-server-audit', button => {
      const session = sessionManager.getActive();
      withButtonLoading(button, async () => {
        if (!session) return showErrorToast(t('serverAudit.disconnected'));
        const { serverAuditModal } = await import('../ServerAuditModal');
        if (sessionManager.getActive() === session) await serverAuditModal.open(session);
      });
    });
    action('btn-recent-sounds', button => withButtonLoading(button, () => recentSoundsModal.open()));
    this.refresh();

    const position = () => {
      const current = menu();
      if (!current || current.hidden || !toggle) return;
      current.style.width = `${toggle.getBoundingClientRect().width}px`;
      positionAnchoredSurface(current, toggle);
    };
    const size = new ResizeObserver(position);
    signal.addEventListener('abort', () => size.disconnect(), { once: true });
    if (toggle) {
      size.observe(toggle);
      if (toggle.parentElement) size.observe(toggle.parentElement);
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', 'server-dropdown-menu');
      toggle.setAttribute('aria-haspopup', 'menu');
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const current = menu();
        if (!current) return;
        if (toggle.classList.contains('open')) this.close();
        else {
          showWithMotion(current, 'popover');
          position();
          toggle.classList.add('open');
          toggle.setAttribute('aria-expanded', 'true');
        }
      }, { signal });
    }
    window.addEventListener('resize', position, { signal });
    window.addEventListener('scroll', position, { capture: true, signal });
    this.root.querySelectorAll<HTMLElement>('#server-dropdown-menu button').forEach(button => button.setAttribute('role', 'menuitem'));
    document.addEventListener('keydown', (event: KeyboardEvent) => {
      const current = menu();
      if (!current || !toggle) return;
      const items = () => [...current.querySelectorAll<HTMLElement>('button:not(:disabled)')]
        .filter(item => !item.hidden && item.getClientRects().length);
      if (event.target === toggle && event.key === 'ArrowDown' && !toggle.classList.contains('open')) {
        event.preventDefault();
        toggle.click();
        items()[0]?.focus();
        return;
      }
      if (!toggle.classList.contains('open')) return;
      if (event.key === 'Tab') {
        this.close();
        toggle.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        toggle.focus();
      } else if (event.target instanceof Node && current.contains(event.target)
        && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const list = items();
        const active = document.activeElement instanceof HTMLElement ? list.indexOf(document.activeElement) : -1;
        const next = nextIndex(event.key, active, list.length);
        if (next !== null) list[next].focus();
      }
    }, { signal });
    document.addEventListener('click', (event: MouseEvent) => {
      const current = menu();
      if (!current || current.hidden || current.hasAttribute('data-ui-closing')) return;
      const target = event.target instanceof Node ? event.target : null;
      if (!current.contains(target) && !toggle?.contains(target)) this.close();
    }, { signal });

    const unbind = [
      // Monitor and audit depend on the session on screen and its connection;
      // another server connecting in the background changes neither.
      appEvents.on('session.changed', () => this.refresh()),
      appEvents.on('network.status', () => {
        if (isForegroundEvent()) this.refresh();
      }),
      () => controller.abort(),
    ];
    return () => unbind.forEach(off => off());
  }
}
