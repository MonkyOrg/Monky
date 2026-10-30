import { Permission, type ChannelSummary, type ServerEventPublic } from '@monky/shared';
import type { ServerStore } from '../../stores/serverStore';

/** What the community reads to decide who may do what. */
export type CommunityAccess = Pick<ServerStore, 'currentUser' | 'serverDetails' | 'hasPermission'>;

/** Events and live actions take place in text and voice channels, never in a forum or its posts. */
export function isActivityChannel(channel: ChannelSummary): boolean {
  return !channel.forumId && (channel.type === 'TEXT' || channel.type === 'VOICE');
}

/** Someone who manages events on the server, or in at least one channel where events can take place. */
export function canCreateEvent(server: CommunityAccess): boolean {
  return server.hasPermission(Permission.MANAGE_EVENTS) || !!server.serverDetails?.channels.some(channel =>
    isActivityChannel(channel) && server.hasPermission(Permission.MANAGE_EVENTS, channel.id));
}

/** Its creator, a server manager, or whoever manages events where it takes place. */
export function canManageEvent(server: CommunityAccess, event: Pick<ServerEventPublic, 'creatorUserId' | 'location'>): boolean {
  return event.creatorUserId === server.currentUser?.id ||
    server.hasPermission(Permission.MANAGE_SERVER) ||
    server.hasPermission(Permission.MANAGE_EVENTS, event.location.kind === 'external' ? undefined : event.location.channelId);
}

/** Its creator, a server manager, or whoever runs live actions in its channel: closing a poll, form or action. */
export function canManageLiveItem(server: CommunityAccess, item: { creatorUserId: string; channelId: string }): boolean {
  return server.currentUser?.id === item.creatorUserId ||
    server.hasPermission(Permission.MANAGE_SERVER) ||
    server.hasPermission(Permission.EMIT_LIVE_ACTIONS, item.channelId);
}

/** The channels where this member may start a live action. */
export function liveActionChannels(server: CommunityAccess): ChannelSummary[] {
  return server.serverDetails?.channels.filter(channel =>
    isActivityChannel(channel) && server.hasPermission(Permission.EMIT_LIVE_ACTIONS, channel.id)) ?? [];
}

/** A channel to start one in, and a server that has native polls or forms. */
export function canCreateLiveAction(server: CommunityAccess): boolean {
  const features = server.serverDetails?.protocol?.features ?? [];
  return liveActionChannels(server).length > 0 &&
    (features.includes('native-polls') || features.includes('native-live-forms'));
}
