export const OVERLAY_RESIZE_HINTS = [
  { direction: 'nw', x: 0, y: 0, rotation: 135 },
  { direction: 'n', x: 0.5, y: 0, rotation: 0 },
  { direction: 'ne', x: 1, y: 0, rotation: 45 },
  { direction: 'w', x: 0, y: 0.5, rotation: 90 },
  { direction: 'e', x: 1, y: 0.5, rotation: 90 },
  { direction: 'sw', x: 0, y: 1, rotation: 45 },
  { direction: 's', x: 0.5, y: 1, rotation: 0 },
  { direction: 'se', x: 1, y: 1, rotation: 135 },
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

export function fitOverlayCards(width: number, height: number, count: number, layout: string, preserveAspectRatio = true, aspectRatio = 16 / 9) {
  if (width <= 0 || height <= 0 || count < 1) return { columns: 1, width: 0, height: 0 };
  const { columns, rows } = arrangeOverlayCards({ width: 0, height: 0 }, count, layout);
  const cellWidth = Math.max(0, (width - (columns - 1) * 6) / columns);
  const cellHeight = Math.max(0, (height - (rows - 1) * 6) / rows);
  const cardWidth = preserveAspectRatio ? Math.min(cellWidth, cellHeight * aspectRatio) : cellWidth;
  return { columns, width: cardWidth, height: preserveAspectRatio ? cardWidth / aspectRatio : cellHeight };
}

export function arrangeOverlayCards(size: { width: number; height: number }, count: number, layout: string) {
  const columns = layout === 'vertical' ? 1 : layout === 'horizontal' ? Math.max(1, count) : Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  return { columns, rows, width: columns * size.width + (columns - 1) * 6,
    height: rows * size.height + Math.max(0, rows - 1) * 6 };
}
