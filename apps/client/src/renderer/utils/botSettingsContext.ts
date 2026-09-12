import type { NetworkClient } from '../core/NetworkClient';
import type { ServerStore } from '../stores/serverStore';
import { settingsStore } from '../stores/settingsStore';
import { t } from '../i18n';
import { botPreferenceScope } from './botPreferenceScope';

export function botPreferenceScopeFor(client: NetworkClient, server: ServerStore, botId: string): string {
  const serverId = server.serverDetails?.id;
  const invokerId = server.currentUser?.id;
  if (!serverId || !invokerId) throw new Error(t('botSettings.sessionChanged'));
  const scope = botPreferenceScope({ serverUrl: client.getCurrentServerUrl(), serverId, invokerId, botId });
  if (!scope) throw new Error(t('botSettings.sessionChanged'));
  return scope;
}

export function botUserSettingsPayload(client: NetworkClient, server: ServerStore, botId: string) {
  const values = settingsStore.getBotUserSettings(botPreferenceScopeFor(client, server, botId));
  return Object.keys(values).length ? { userSettings: values } : {};
}
