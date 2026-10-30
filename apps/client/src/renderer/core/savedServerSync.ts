import { connectionStore } from '../stores/connectionStore';
import { toAbsoluteServerIconUrl } from '../utils/avatar';
import { isLoopbackHost } from '../utils/serverAddress';

/**
 * Keeps the saved entry of a server in step with the server itself.
 *
 * The rail and Home read the name and icon from the saved entry, not from the
 * live connection, so a server renamed, or given a new icon, while it was in
 * the background or while this app was away has to update it too (#85, #301).
 * Called at every sign-in and at every settings change, of any session.
 */
export function syncSavedServer(address: { host: string; port: number }, server: { name: string; iconUrl?: string | null }): void {
  const { host, port } = address;
  connectionStore.updateSavedServerMeta(host, port, {
    name: server.name,
    iconUrl: toAbsoluteServerIconUrl(host, port, server.iconUrl),
  });
  // A server hosted from this machine also has an entry in "Meus Servidores",
  // with its own copy of the name.
  if (isLoopbackHost(host)) connectionStore.renameCreatedServerByPort(port, server.name);
}
