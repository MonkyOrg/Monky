/** Most messages one selection may hold: enough for a conversation, bounded for forwarding. */
export const MESSAGE_SELECTION_MAX = 100;

/**
 * The selection while dragging from the row at `anchor` to the row at `current`
 * (indexes into `order`, the rows top to bottom). Rows between them take
 * `target`; every other message keeps what it had when the drag began. When
 * adding, rows are taken from the anchor outwards until `max` is reached.
 */
export function dragSelection(
  order: readonly string[],
  before: ReadonlySet<string>,
  anchor: number,
  current: number,
  target: boolean,
  max = MESSAGE_SELECTION_MAX,
): Set<string> {
  const low = Math.min(anchor, current);
  const high = Math.max(anchor, current);
  const index = new Map(order.map((id, position) => [id, position]));
  const result = new Set<string>();
  for (const id of before) {
    const position = index.get(id);
    if (position === undefined || position < low || position > high) result.add(id);
  }
  if (!target) return result;
  const step = current >= anchor ? 1 : -1;
  for (let position = anchor; result.size < max; position += step) {
    result.add(order[position]);
    if (position === current) break;
  }
  return result;
}

/**
 * Pixels to scroll per frame while the pointer is near an edge of the feed:
 * faster the closer it gets, up to `maxSpeed` once it leaves the feed.
 */
export function edgeScrollSpeed(pointerY: number, top: number, bottom: number, edge = 56, maxSpeed = 28): number {
  const zone = Math.min(edge, (bottom - top) / 3);
  if (zone <= 0) return 0;
  if (pointerY < top + zone) return -Math.ceil(maxSpeed * Math.min(1, (top + zone - pointerY) / zone));
  if (pointerY > bottom - zone) return Math.ceil(maxSpeed * Math.min(1, (pointerY - (bottom - zone)) / zone));
  return 0;
}
