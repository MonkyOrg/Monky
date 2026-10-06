import type { ChannelCategory, ChannelSummary } from './models.js';

/** One entry at the root of the channel list: a category or a channel outside every category. */
export interface ChannelTreeRootItem {
  kind: 'channel' | 'category';
  id: string;
  position: number;
  createdAt: number;
}

type RootChannel = Pick<ChannelSummary, 'id' | 'position' | 'createdAt'> & {
  categoryId?: string | null;
  forumId?: string | null;
};
type RootCategory = Pick<ChannelCategory, 'id' | 'position' | 'createdAt'>;

const kindRank = (item: ChannelTreeRootItem): number => item.kind === 'channel' ? 0 : 1;

/**
 * Categories and channels outside every category share one ordering at the
 * root of the channel list, so a loose channel can sit anywhere among them.
 * A channel pointing at a category that no longer exists belongs to the root.
 * Forum threads live inside their forum and are never part of it.
 *
 * `channelsFirst` reproduces servers without `channel-tree-order`, whose loose
 * channels always sit above the categories.
 */
export function channelTreeRoot(
  channels: readonly RootChannel[], categories: readonly RootCategory[], channelsFirst = false,
): ChannelTreeRootItem[] {
  const known = new Set(categories.map(category => category.id));
  const items: ChannelTreeRootItem[] = [
    ...channels
      .filter(channel => !channel.forumId && (!channel.categoryId || !known.has(channel.categoryId)))
      .map(channel => ({ kind: 'channel' as const, id: channel.id, position: channel.position, createdAt: channel.createdAt })),
    ...categories.map(category => ({ kind: 'category' as const, id: category.id, position: category.position, createdAt: category.createdAt })),
  ];
  return items.sort((a, b) => (channelsFirst ? kindRank(a) - kindRank(b) : 0) ||
    a.position - b.position || a.createdAt - b.createdAt || kindRank(a) - kindRank(b) || a.id.localeCompare(b.id));
}

/**
 * Applies a requested root order. Only the kinds named in the request move:
 * a client that knows nothing about mixed roots reorders just its channels or
 * just its categories, and every item of the other kind keeps its slot. Items
 * of a named kind that the request left out keep their relative order after
 * the named ones, so an out-of-date list cannot drop anything.
 */
export function reorderChannelTreeRoot(
  current: readonly ChannelTreeRootItem[], requestedIds: readonly string[],
): ChannelTreeRootItem[] {
  const byId = new Map(current.map(item => [item.id, item]));
  const requested = [...new Set(requestedIds)].flatMap(id => byId.get(id) ?? []);
  const kinds = new Set(requested.map(item => item.kind));
  const named = new Set(requested);
  const moving = [...requested, ...current.filter(item => kinds.has(item.kind) && !named.has(item))];
  let next = 0;
  return current.map(item => kinds.has(item.kind) ? moving[next++] : item);
}
