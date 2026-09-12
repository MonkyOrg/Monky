export interface FavoriteOrderEntry {
  favorite: boolean;
  name: string;
  identity: string;
}

export function sortFavoritesFirst<T>(
  items: readonly T[],
  describe: (item: T) => FavoriteOrderEntry,
  locale: string
): T[] {
  const names = new Intl.Collator(locale, { sensitivity: 'base' });
  return items
    .map((item, index) => ({ item, index, order: describe(item) }))
    .sort((a, b) => Number(b.order.favorite) - Number(a.order.favorite)
      || names.compare(a.order.name, b.order.name)
      // Equal names still identify distinct files/endpoints; never use array
      // position as their identity or mutate the service/store's source list.
      || (a.order.identity < b.order.identity ? -1 : a.order.identity > b.order.identity ? 1 : 0)
      || a.index - b.index)
    .map(({ item }) => item);
}
