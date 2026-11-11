import { networkClient } from '../core/NetworkClient';
import { settingsStore } from '../stores/settingsStore';
import { showConfirm, showConfirmWithOption } from '../views/Dialog';
import { t, tCount } from '../i18n';
import { isLoopbackHost, parseServerUrl } from './serverAddress';
import { docsUrl } from './docsLinks';
import { ensureHostedServerStarted } from '../core/hostedServerStart';
import type { CreatedServer } from '../stores/connectionStore';

/** Network reachability cannot tell whether this app's own server has started. */
export async function prepareHostedServerJoin(server: CreatedServer, isCurrent: () => boolean): Promise<boolean> {
  const target = { ...server };
  if (!window.api?.hostServerStatus) throw new Error(t('navigation.hostingUnavailable'));
  const status = await window.api.hostServerStatus();
  if (!isCurrent()) return false;
  const running = status.servers.some(instance => instance.port === target.port && instance.serverId === target.id);
  if (!running) {
    const confirmed = await showConfirm({
      title: t('main.serverOfflineStartTitle'),
      message: t('main.serverOfflineStartMessage', { name: target.name }),
      confirmLabel: t('main.serverOfflineStartConfirm'),
      variant: 'warning',
    });
    if (!confirmed || !isCurrent()) return false;
  }
  // Even matching status can have a stop queued; only an acknowledged start is ready.
  await ensureHostedServerStarted(target);
  return isCurrent();
}

/**
 * Number of people connected to the server this app hosts on `port`, or null
 * when it is not up. Counts distinct people, matching the `/preview` semantics
 * — one person on two devices is still one person (#309).
 */
export async function getHostedServerOnlineUsers(port: number): Promise<number | null> {
  if (!window.api?.hostServerStats) return null;
  try {
    const stats = await window.api.hostServerStats(port);
    return stats ? stats.onlineUsers : null;
  } catch {
    return null;
  }
}

/**
 * Warns before stopping a server that still has people on it, so the owner is
 * never surprised by disconnecting everyone (#334). Returns whether to proceed.
 */
export async function confirmStopHostedServer(port: number): Promise<boolean> {
  const onlineUsers = await getHostedServerOnlineUsers(port);
  if (onlineUsers === null || onlineUsers <= 0) return true;

  return showConfirm({
    title: t('hostedServer.stopWithUsersTitle'),
    message: tCount('hostedServer.stopWithUsersMessage', onlineUsers),
    confirmLabel: t('hostedServer.stopAnyway'),
    variant: 'danger',
  });
}

/**
 * Before the first server is created, explains that friends only reach it over
 * a VPN, the same local network or forwarded ports (#877). Returns whether to
 * go on; "don't show again" turns the warning off, Settings turns it back on.
 */
export async function confirmHostedServerReach(): Promise<boolean> {
  if (!settingsStore.warnHostedServerReach) return true;

  const { confirmed, checked } = await showConfirmWithOption({
    title: t('hostedServer.reachTitle'),
    message: t('hostedServer.reachMessage'),
    confirmLabel: t('hostedServer.reachConfirm'),
    variant: 'info',
    link: { label: t('hostedServer.reachDocs'), url: docsUrl('reachServer') },
    checkboxLabel: t('hostedServer.dontShowAgain'),
  });

  // Only a confirmed warning counts as read: cancelling keeps it for next time.
  if (confirmed && checked) {
    settingsStore.warnHostedServerReach = false;
    settingsStore.save();
  }
  return confirmed;
}

/**
 * Snapshot taken *before* leaving a server: once the socket is gone there is no
 * way to tell whether the user was hosting it or whether anyone else was still
 * connected (#334).
 */
export interface HostedServerLeaveState {
  serverName: string;
  port: number;
}

export async function captureHostedServerLeaveState(
  serverUrl: string = networkClient.getCurrentServerUrl()
): Promise<HostedServerLeaveState | null> {
  if (!settingsStore.askShutdownOnLastLeave) return null;
  if (!window.api?.hostServerStatus || !window.api?.hostServerStats) return null;

  try {
    const current = parseServerUrl(serverUrl);
    if (!current || !isLoopbackHost(current.host)) return null;

    const status = await window.api.hostServerStatus();
    if (!status.servers.some((server) => server.port === current.port)) return null;

    const stats = await window.api.hostServerStats(current.port);
    // The count still includes the person leaving, so anything above one means
    // somebody stays behind and the server should keep running.
    if (!stats || stats.onlineUsers > 1) return null;

    return { serverName: stats.serverName, port: current.port };
  } catch {
    return null;
  }
}

/**
 * Offers to shut the server down now that it is empty. Runs after the socket is
 * closed: stopping the server while still connected would look like a dropped
 * connection and trigger the reconnect loop (#312).
 */
export async function promptShutdownAfterLeave(state: HostedServerLeaveState): Promise<void> {
  if (!settingsStore.askShutdownOnLastLeave) return;

  const { confirmed, checked } = await showConfirmWithOption({
    title: t('hostedServer.emptyTitle'),
    message: t('hostedServer.emptyMessage', { name: state.serverName }),
    confirmLabel: t('hostedServer.shutDown'),
    cancelLabel: t('hostedServer.keepRunning'),
    variant: 'warning',
    checkboxLabel: t('hostedServer.dontAskAgain'),
  });

  if (checked) {
    settingsStore.askShutdownOnLastLeave = false;
    settingsStore.save();
  }

  if (!confirmed) return;
  await window.api?.hostServerStop?.(state.port);
}
