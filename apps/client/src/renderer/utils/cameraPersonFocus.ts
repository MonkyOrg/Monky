import { CameraEffectError } from './cameraEffects';

/** Alpha above this marks a cell as part of a person when separating people. */
const PERSON_ALPHA = 0.4;
/** Cells kept around the selected person so soft hair and edges are not clipped. */
const EDGE_CELLS = 2;
/** The person already in focus keeps it while at least this fraction of the largest. */
const KEEP_RATIO = 0.6;

/**
 * Keeps only the most prominent person of a low-resolution matte: the largest connected
 * region, which is normally the person closest to the camera. The current person keeps
 * the focus while still comparable in size, so focus does not jump between people that
 * momentarily have similar areas. People touching each other form a single region.
 */
export class ProminentPersonTracker {
  private selected: Uint8Array | null = null;
  private width = 0;
  private height = 0;

  public reset(): void {
    this.selected = null;
  }

  /** Returns a 0/1 weight per cell to multiply into the matte. */
  public select(alpha: Float32Array, width: number, height: number): Float32Array {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
      || alpha.length !== width * height) {
      throw new CameraEffectError('processing');
    }
    if (width !== this.width || height !== this.height) {
      this.selected = null;
      this.width = width;
      this.height = height;
    }
    const { labels, areas } = labelRegions(alpha, width, height);
    const weights = new Float32Array(alpha.length);
    if (!areas.length) {
      // Nobody is clearly present: leave the faint matte untouched rather than guessing.
      this.selected = null;
      return weights.fill(1);
    }
    let largest = 0;
    for (let label = 1; label < areas.length; label++) if (areas[label] > areas[largest]) largest = label;
    let chosen = largest;
    if (this.selected) {
      const overlap = new Uint32Array(areas.length);
      for (let index = 0; index < labels.length; index++) {
        if (this.selected[index] && labels[index]) overlap[labels[index] - 1]++;
      }
      let kept = -1;
      for (let label = 0; label < areas.length; label++) {
        if (overlap[label] && (kept < 0 || overlap[label] > overlap[kept])) kept = label;
      }
      if (kept >= 0 && areas[kept] >= areas[largest] * KEEP_RATIO) chosen = kept;
    }
    const selected = new Uint8Array(alpha.length);
    for (let index = 0; index < labels.length; index++) {
      if (labels[index] !== chosen + 1) continue;
      selected[index] = 1;
      const x = index % width;
      const y = (index - x) / width;
      for (let dy = -EDGE_CELLS; dy <= EDGE_CELLS; dy++) {
        const row = y + dy;
        if (row < 0 || row >= height) continue;
        for (let dx = -EDGE_CELLS; dx <= EDGE_CELLS; dx++) {
          const column = x + dx;
          if (column < 0 || column >= width) continue;
          const neighbor = row * width + column;
          // The margin never reaches into another person.
          if (!labels[neighbor] || labels[neighbor] === chosen + 1) weights[neighbor] = 1;
        }
      }
    }
    this.selected = selected;
    return weights;
  }
}

/** Labels 4-connected regions above the person alpha; label n has area areas[n - 1]. */
function labelRegions(alpha: Float32Array, width: number, height: number): { labels: Int32Array; areas: number[] } {
  const labels = new Int32Array(alpha.length);
  const areas: number[] = [];
  const stack = new Int32Array(alpha.length);
  for (let start = 0; start < alpha.length; start++) {
    if (labels[start] || !(alpha[start] > PERSON_ALPHA)) continue;
    const label = areas.length + 1;
    let area = 0;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top) {
      const index = stack[--top];
      area++;
      const x = index % width;
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        index >= width ? index - width : -1,
        index < alpha.length - width ? index + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || labels[neighbor] || !(alpha[neighbor] > PERSON_ALPHA)) continue;
        labels[neighbor] = label;
        stack[top++] = neighbor;
      }
    }
    areas.push(area);
  }
  return { labels, areas };
}
