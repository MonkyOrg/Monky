export interface BotPreferenceScope {
  serverUrl: string;
  serverId: string;
  invokerId: string;
  botId: string;
}

export function botPreferenceScope(details: BotPreferenceScope): string | null {
  if (!details.serverId || !details.invokerId || !details.botId) return null;
  let url: URL;
  try { url = new URL(details.serverUrl); } catch { return null; }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) return null;
  const key = JSON.stringify([url.origin, url.pathname, details.serverId, details.invokerId, details.botId]);
  return key.length <= 2048 ? key : null;
}
