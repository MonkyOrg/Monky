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
