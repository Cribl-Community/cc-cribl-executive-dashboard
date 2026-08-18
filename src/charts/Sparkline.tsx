/**
 * A sparkline: shape only, no axes.
 *
 * It sits inside a stat tile to answer "which way has this been going" without
 * competing with the headline number. Exact values live in the tile's own text and
 * in the full chart below, so this mark carries no labels and no hover layer.
 *
 * Line only, no fill: the y-domain starts at zero, so an area under a large value
 * fills the whole box and reads as a colored panel rather than as data.
 */

import { axisMax, linearScale, linePath, type Point } from './geometry.ts';

const VIEW_WIDTH = 160;
const VIEW_HEIGHT = 40;
const STROKE_INSET = 2;

type SparklineProps = {
  points: Array<{ t: number; value: number }>;
  /** Categorical slot, matched to the same entity's color in the full chart. */
  slot: 1 | 2 | 3;
  /** Sparklines are decorative next to their number; describe the trend here. */
  ariaLabel: string;
};

export function Sparkline({ points, slot, ariaLabel }: SparklineProps) {
  const sorted = [...points].filter((point) => Number.isFinite(point.value)).sort((a, b) => a.t - b.t);
  if (sorted.length < 2) return null;

  const x = linearScale(sorted[0].t, sorted[sorted.length - 1].t, 0, VIEW_WIDTH);
  const y = linearScale(0, axisMax(sorted.map((point) => point.value)), VIEW_HEIGHT - STROKE_INSET, STROKE_INSET);
  const plotted: Point[] = sorted.map((point) => ({ x: x(point.t), y: y(point.value) }));

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      role="img"
      aria-label={ariaLabel}
    >
      <path className={`series-line series-${slot}`} d={linePath(plotted)} />
    </svg>
  );
}
