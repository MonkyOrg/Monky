import {
  withoutBotStorageCapabilities, withoutBotStoragePermissions,
  type BotInstallPreview, type BotPermissions, type BotSettingsListResponse, type BotSettingsSnapshot, type ProtocolAgreement,
} from '@monky/shared';

type Peer = { protocol?: ProtocolAgreement };

/** Peers without `bot-storage` reject the storage capability names in their strict enum. */
export function supportsBotStorage(peer: Peer): boolean {
  return peer.protocol?.features.includes('bot-storage') === true;
}

export function visibleBotPermissions(peer: Peer, permissions: BotPermissions): BotPermissions {
  return supportsBotStorage(peer) ? permissions : withoutBotStoragePermissions(permissions);
}

export function visibleBotSettings(peer: Peer, snapshot: BotSettingsSnapshot): BotSettingsSnapshot {
  const { permissions } = snapshot.bot;
  return permissions && !supportsBotStorage(peer)
    ? { ...snapshot, bot: { ...snapshot.bot, permissions: withoutBotStoragePermissions(permissions) } } : snapshot;
}

export function visibleBotSettingsList(peer: Peer, list: BotSettingsListResponse): BotSettingsListResponse {
  if (supportsBotStorage(peer)) return list;
  return { bots: list.bots.map((bot) => bot.permissions ? { ...bot, permissions: withoutBotStoragePermissions(bot.permissions) } : bot) };
}

export function visibleBotInstallPreview(peer: Peer, preview: BotInstallPreview): BotInstallPreview {
  return supportsBotStorage(peer) ? preview : { ...preview, manifest: {
    ...preview.manifest, requestedCapabilities: withoutBotStorageCapabilities(preview.manifest.requestedCapabilities),
  } };
}
