export const OVERLAY_RESIZE_HINTS = [
  { direction: 'nw', x: 0, y: 0, rotation: 180 },
  { direction: 'n', x: 0.5, y: 0, rotation: 0 },
  { direction: 'ne', x: 1, y: 0, rotation: 270 },
  { direction: 'w', x: 0, y: 0.5, rotation: 90 },
  { direction: 'e', x: 1, y: 0.5, rotation: 90 },
  { direction: 'sw', x: 0, y: 1, rotation: 90 },
  { direction: 's', x: 0.5, y: 1, rotation: 0 },
  { direction: 'se', x: 1, y: 1, rotation: 0 },
] as const;

export function overlayResizeHint(width: number, height: number, pointer: { x: number; y: number }) {
  if (width <= 0 || height <= 0 || pointer.x < 0 || pointer.y < 0 || pointer.x > width || pointer.y > height) return undefined;
  const cornerDistance = Math.min(36, width / 4, height / 4);
  const corner = OVERLAY_RESIZE_HINTS.find(hint => hint.x !== 0.5 && hint.y !== 0.5 &&
    Math.hypot(pointer.x - hint.x * width, pointer.y - hint.y * height) <= cornerDistance);
  if (corner) return corner.direction;
  const edgeDistance = Math.min(48, width / 4, height / 4);
  return OVERLAY_RESIZE_HINTS.find(hint => hint.x === 0.5
    ? Math.abs(pointer.y - hint.y * height) <= edgeDistance && Math.abs(pointer.x - width / 2) <= width / 4
    : hint.y === 0.5 && Math.abs(pointer.x - hint.x * width) <= edgeDistance && Math.abs(pointer.y - height / 2) <= height / 4
  )?.direction;
}

export function fitOverlayCards(width: number, height: number, count: number, layout: string) {
  let best = { columns: 1, width: 0, height: 0 };
  if (width <= 0 || height <= 0 || count < 1) return best;
  for (let columns = 1; columns <= count; columns++) {
    if (layout === 'vertical' && columns !== 1) continue;
    if (layout === 'horizontal' && columns !== count) continue;
    const rows = Math.ceil(count / columns);
    const cardWidth = Math.max(0, Math.min((width - (columns - 1) * 6) / columns,
      (height - (rows - 1) * 6) / rows * 16 / 9));
    if (cardWidth > best.width) best = { columns, width: cardWidth, height: cardWidth * 9 / 16 };
  }
  return best;
}
