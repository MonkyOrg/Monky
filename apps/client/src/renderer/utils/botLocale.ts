import { resolveBotLocale, type BotLocale } from '@monky/shared';
import type { NetworkClient } from '../core/NetworkClient';
import type { ServerStore } from '../stores/serverStore';
import { settingsStore } from '../stores/settingsStore';
import { getLanguage } from '../i18n';
import { botPreferenceScopeFor } from './botSettingsContext';

export function botLocaleFor(client: NetworkClient, server: ServerStore, botId: string): BotLocale {
  const preference = settingsStore.getBotLocalePreference(botPreferenceScopeFor(client, server, botId));
  return resolveBotLocale(preference === 'auto' ? getLanguage() : preference);
}
