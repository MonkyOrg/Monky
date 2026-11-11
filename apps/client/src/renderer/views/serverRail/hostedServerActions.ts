import { connectionStore, type CreatedServer } from '../../stores/connectionStore';
import { t } from '../../i18n';
import { confirmStopHostedServer } from '../../utils/hostedServer';
import { showAlert, showConfirm } from '../Dialog';
import { appEvents } from '../../core/EventBus';
import { sessionKeyFor } from '../../core/SessionManager';

export async function stopOwnedServer(port: number): Promise<boolean> {
  if (!window.api?.hostServerStop) throw new Error(t('navigation.hostingUnavailable'));
  if (!(await confirmStopHostedServer(port))) return false;
  const result = await window.api.hostServerStop(port);
  if (!result.success) throw new Error(t('connection.stopServerError'));
  return true;
}

export async function deleteOwnedServer(server: CreatedServer): Promise<void> {
  const target = { ...server };
  const confirmed = await showConfirm({
    title: t('connection.deleteSavedServer'),
    message: t('connection.deleteServerMessage', { name: target.name }),
    confirmLabel: t('common.delete'),
    cancelLabel: t('common.cancel'),
    variant: 'danger',
    focusCancel: true,
  });
  if (!confirmed) return;
  try {
    const api = window.api;
    if (!api?.hostServerStatus || !api.hostServerDeleteData) throw new Error(t('navigation.hostingUnavailable'));
    const status = await api.hostServerStatus();
    const running = status.servers.find(item => item.serverId === target.id);
    if (running && !(await stopOwnedServer(running.port))) return;
    const deleted = await api.hostServerDeleteData(target.id);
    if (!deleted.success) throw new Error(deleted.error || t('connection.deleteServerError'));
    // Keep the entry and its pinned identity until deletion actually succeeds.
    connectionStore.removeCreatedServer(target.id);
    appEvents.emit('connection.manual_disconnect', { key: sessionKeyFor('127.0.0.1', target.port) });
    connectionStore.removeSavedServer('127.0.0.1', target.port);
  } catch (error: unknown) {
    await showAlert({
      title: t('common.error'),
      message: error instanceof Error && error.message ? error.message : t('connection.deleteServerError'),
      variant: 'danger',
    });
  }
}
