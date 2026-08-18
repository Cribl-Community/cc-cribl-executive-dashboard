/**
 * Scales, ticks, and path builders for the inline SVG charts.
 *
 * Small and explicit rather than a charting dependency: every chart here is a
 * line, a bar, or a meter, and owning the geometry keeps the mark specs (2px
 * strokes, 4px rounded data-ends, surface gaps) under our control.
 */

export type Scale = (value: number) => number;

/** Maps a numeric domain onto a pixel range. Degenerate domains map to the middle. */
export function linearScale(
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number,
): Scale {
  const span = domainMax - domainMin;
  if (!Number.isFinite(span) || span === 0) {
    const mid = (rangeMin + rangeMax) / 2;
    return () => mid;
  }
  return (value) => rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
}

const TICK_STEPS = [1, 2, 2.5, 5, 10];

/** Round tick values covering `[0, max]`, chosen so labels stay readable. */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    (TICK_STEPS.find((candidate) => candidate * magnitude >= rough) ?? 10) * magnitude;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step / 2; value += step) ticks.push(value);
  return ticks;
}

/** Evenly spaced time ticks that always include both ends of the window. */
export function timeTicks(start: number, end: number, count = 5): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [start];
  const steps = Math.max(1, count - 1);
  const ticks: number[] = [];
  for (let i = 0; i <= steps; i += 1) ticks.push(start + ((end - start) * i) / steps);
  return ticks;
}

/** A rounded, upper bound for a value axis so the top mark is not flush with the frame. */
export function axisMax(values: number[]): number {
  const max = values.reduce((best, value) => (Number.isFinite(value) && value > best ? value : best), 0);
  if (max <= 0) return 1;
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  return top >= max ? top : max;
}

export type Point = { x: number; y: number };

/** A plain polyline path. Straight segments: interpolation would invent data. */
export function linePath(points: Point[]): string {
  if (points.length === 0) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
}

/**
 * A horizontal bar growing from `baselineX`, with only the data-end rounded.
 *
 * Rounding both ends would make the bar look detached from its axis; rounding
 * only the tip keeps it anchored while softening the end the eye reads as the value.
 */
export function horizontalBarPath(
  baselineX: number,
  y: number,
  width: number,
  height: number,
  radius = 4,
): string {
  const r = Math.max(0, Math.min(radius, height / 2, Math.abs(width)));
  const bottom = y + height;
  if (width >= 0) {
    const end = baselineX + Math.max(width, r);
    return `M${baselineX} ${y} H${end - r} A${r} ${r} 0 0 1 ${end} ${y + r} V${bottom - r} A${r} ${r} 0 0 1 ${end - r} ${bottom} H${baselineX} Z`;
  }
  const end = baselineX + Math.min(width, -r);
  return `M${baselineX} ${y} H${end + r} A${r} ${r} 0 0 0 ${end} ${y + r} V${bottom - r} A${r} ${r} 0 0 0 ${end + r} ${bottom} H${baselineX} Z`;
}

/** Index of the point whose x is closest to `x`. Assumes ascending xs. */
export function nearestIndex(xs: number[], x: number): number {
  if (xs.length === 0) return -1;
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < xs.length; i += 1) {
    const distance = Math.abs(xs[i] - x);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** Keeps a tooltip inside the plot instead of letting it clip at the edge. */
export function clampTooltipLeft(x: number, tooltipWidth: number, chartWidth: number): number {
  return Math.max(0, Math.min(x - tooltipWidth / 2, chartWidth - tooltipWidth));
}
