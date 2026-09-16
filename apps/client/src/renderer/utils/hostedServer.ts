import { networkClient } from '../core/NetworkClient';
import { settingsStore } from '../stores/settingsStore';
import { showConfirm, showConfirmWithOption } from '../views/Dialog';
import { t, tCount } from '../i18n';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function hostOf(url: string | null): { host: string; port: number } | null {
  if (!url) return null;
  const match = url.replace(/^wss?:\/\//, '').match(/^(.+):(\d+)$/);
  if (!match) return null;
  return { host: match[1], port: Number.parseInt(match[2], 10) };
}

/**
 * Number of people connected to the server hosted by this app, or null when no
 * server is up. Counts distinct people, matching the `/preview` semantics — one
 * person on two devices is still one person (#309).
 */
export async function getHostedServerOnlineUsers(): Promise<number | null> {
  if (!window.api?.hostServerStats) return null;
  try {
    const stats = await window.api.hostServerStats();
    return stats ? stats.onlineUsers : null;
  } catch {
    return null;
  }
}

/**
 * Warns before stopping a server that still has people on it, so the owner is
 * never surprised by disconnecting everyone (#334). Returns whether to proceed.
 */
export async function confirmStopHostedServer(): Promise<boolean> {
  const onlineUsers = await getHostedServerOnlineUsers();
  if (onlineUsers === null || onlineUsers <= 0) return true;

  return showConfirm({
    title: t('hostedServer.stopWithUsersTitle'),
    message: tCount('hostedServer.stopWithUsersMessage', onlineUsers),
    confirmLabel: t('hostedServer.stopAnyway'),
    variant: 'danger',
  });
}

/**
 * Snapshot taken *before* leaving a server: once the socket is gone there is no
 * way to tell whether the user was hosting it or whether anyone else was still
 * connected (#334).
 */
export interface HostedServerLeaveState {
  serverName: string;
}

export async function captureHostedServerLeaveState(
  serverUrl: string = networkClient.getCurrentServerUrl()
): Promise<HostedServerLeaveState | null> {
  if (!settingsStore.askShutdownOnLastLeave) return null;
  if (!window.api?.hostServerStatus || !window.api?.hostServerStats) return null;

  try {
    const current = hostOf(serverUrl);
    if (!current || !LOCAL_HOSTS.has(current.host)) return null;

    const status = await window.api.hostServerStatus();
    if (!status.isRunning || status.port !== current.port) return null;

    const stats = await window.api.hostServerStats();
    // The count still includes the person leaving, so anything above one means
    // somebody stays behind and the server should keep running.
    if (!stats || stats.onlineUsers > 1) return null;

    return { serverName: stats.serverName };
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
  await window.api?.hostServerStop?.();
}
