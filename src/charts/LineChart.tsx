/**
 * Time-series line chart.
 *
 * One value axis, always — two measures of different scale get two charts, never
 * a second y-scale. Series colors come from the validated categorical slots in
 * fixed order, so a filter that removes a series never repaints the survivors.
 */

import { useMemo, useState, type PointerEvent } from 'react';
import { Collapse, Text } from '@capra/core';
import { DataTable } from '../components/DataTable.tsx';
import {
  axisMax,
  linearScale,
  linePath,
  nearestIndex,
  niceTicks,
  timeTicks,
  type Point,
} from './geometry.ts';

export type ChartSeries = {
  id: string;
  label: string;
  /** Categorical slot 1–3, assigned per entity and never by rank. */
  slot: 1 | 2 | 3;
  points: Array<{ t: number; value: number }>;
  /** Dashed stroke, for projected rather than measured values. */
  projected?: boolean;
};

type LineChartProps = {
  series: ChartSeries[];
  /** Window to plot, Unix ms. Fixed by the filter, not by the data extent. */
  xDomain: [number, number];
  formatValue: (value: number) => string;
  formatX: (t: number) => string;
  /**
   * Horizontal reference lines, e.g. each series' 7-day baseline. Always dashed;
   * given a slot, a reference takes that series' hue so the pairing is obvious.
   */
  references?: Array<{ id: string; value: number; label: string; slot?: 1 | 2 | 3 }>;
  /** Describes the chart for assistive tech; the table below carries the data. */
  ariaLabel: string;
  tableCaption: string;
  height?: number;
};

const VIEW_WIDTH = 800;
const PAD = { top: 16, right: 76, bottom: 28, left: 62 };
const LABEL_MIN_GAP = 14;

/** Rough advance width at the label's 12px size, for keeping text inside the view. */
const CHAR_WIDTH = 6.4;

/**
 * Nudges end labels apart so two series that finish close together stay readable.
 * Only labels in the same horizontal neighbourhood can collide, so series ending at
 * different times are spread independently.
 */
function spreadLabels(labels: Array<{ x: number; y: number; series: ChartSeries }>) {
  const byColumn = new Map<number, Array<{ x: number; y: number; series: ChartSeries }>>();
  for (const label of labels) {
    const column = Math.round(label.x / 40);
    const bucket = byColumn.get(column);
    if (bucket) bucket.push(label);
    else byColumn.set(column, [label]);
  }
  for (const bucket of byColumn.values()) {
    bucket.sort((a, b) => a.y - b.y);
    for (let i = 1; i < bucket.length; i += 1) {
      const gap = bucket[i].y - bucket[i - 1].y;
      if (gap < LABEL_MIN_GAP) bucket[i].y = bucket[i - 1].y + LABEL_MIN_GAP;
    }
  }
  return labels;
}

export function LineChart({
  series,
  xDomain,
  formatValue,
  formatX,
  references = [],
  ariaLabel,
  tableCaption,
  height = 260,
}: LineChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const model = useMemo(() => {
    const times = [...new Set(series.flatMap((entry) => entry.points.map((point) => point.t)))].sort(
      (a, b) => a - b,
    );
    const values = series.flatMap((entry) => entry.points.map((point) => point.value));
    const top = axisMax([...values, ...references.map((entry) => entry.value)]);
    const x = linearScale(xDomain[0], xDomain[1], PAD.left, VIEW_WIDTH - PAD.right);
    const y = linearScale(0, top, height - PAD.bottom, PAD.top);
    const byId = new Map(
      series.map((entry) => [entry.id, new Map(entry.points.map((point) => [point.t, point.value]))]),
    );
    return { times, top, x, y, byId, xs: times.map((t) => x(t)) };
  }, [series, references, xDomain, height]);

  const hasData = model.times.length > 0;

  const paths = series.map((entry) => {
    const points: Point[] = entry.points
      .filter((point) => Number.isFinite(point.value))
      .sort((a, b) => a.t - b.t)
      .map((point) => ({ x: model.x(point.t), y: model.y(point.value) }));
    return { entry, d: linePath(points), last: points.at(-1), count: points.length };
  });

  // A label sits just past where its own line ends, not in the right-hand gutter: a
  // measured series that stops at today would otherwise be labelled at term end.
  const endLabels = spreadLabels(
    paths.flatMap((path) =>
      path.last
        ? [
            {
              x: Math.min(
                path.last.x + 8,
                Math.max(PAD.left, VIEW_WIDTH - 6 - path.entry.label.length * CHAR_WIDTH),
              ),
              y: path.last.y,
              series: path.entry,
            },
          ]
        : [],
    ),
  );

  const hoverTime = hoverIndex === null ? undefined : model.times[hoverIndex];
  const hoverX = hoverIndex === null ? 0 : model.xs[hoverIndex];

  const handleMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!hasData) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const localX = ((event.clientX - rect.left) / rect.width) * VIEW_WIDTH;
    setHoverIndex(nearestIndex(model.xs, localX));
  };

  const tooltipPercent = (hoverX / VIEW_WIDTH) * 100;
  const tooltipTransform =
    tooltipPercent < 20 ? 'translateX(0)' : tooltipPercent > 80 ? 'translateX(-100%)' : 'translateX(-50%)';

  return (
    <div className="chart-block">
      {(series.length >= 2 || references.length > 0) && (
        <div className="legend">
          {series.map((entry) => (
            <span className="legend-item" key={entry.id}>
              <span className={`legend-swatch legend-swatch--${entry.slot}`} aria-hidden="true" />
              <Text variant="body-sm-normal" color="secondary">
                {entry.label}
              </Text>
            </span>
          ))}
          {references.map((entry) => (
            <span className="legend-item" key={entry.id}>
              <span
                className={`legend-swatch legend-swatch--reference${entry.slot ? ` legend-swatch--reference-${entry.slot}` : ''}`}
                aria-hidden="true"
              />
              <Text variant="body-sm-normal" color="secondary">
                {entry.label}
              </Text>
            </span>
          ))}
        </div>
      )}

      <div className="chart">
        <svg
          className="chart-svg"
          viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
          role="img"
          aria-label={ariaLabel}
          onPointerMove={handleMove}
          onPointerLeave={() => setHoverIndex(null)}
        >
          <g className="chart-grid">
            {niceTicks(model.top).map((tick) => (
              <line
                key={tick}
                x1={PAD.left}
                x2={VIEW_WIDTH - PAD.right}
                y1={model.y(tick)}
                y2={model.y(tick)}
              />
            ))}
          </g>

          <g>
            {niceTicks(model.top).map((tick) => (
              <text key={tick} className="chart-tick chart-tick--y" x={PAD.left - 8} y={model.y(tick) + 4}>
                {formatValue(tick)}
              </text>
            ))}
          </g>

          <g className="chart-axis">
            <line x1={PAD.left} x2={VIEW_WIDTH - PAD.right} y1={height - PAD.bottom} y2={height - PAD.bottom} />
          </g>

          <g>
            {timeTicks(xDomain[0], xDomain[1]).map((tick, index, all) => (
              <text
                key={tick}
                className="chart-tick chart-tick--x"
                x={model.x(tick)}
                y={height - PAD.bottom + 16}
                textAnchor={index === 0 ? 'start' : index === all.length - 1 ? 'end' : 'middle'}
              >
                {formatX(tick)}
              </text>
            ))}
          </g>

          {references
            .filter((entry) => entry.value > 0)
            .map((entry) => (
              <line
                key={entry.id}
                className={`series-reference${entry.slot ? ` series-${entry.slot}` : ''}`}
                x1={PAD.left}
                x2={VIEW_WIDTH - PAD.right}
                y1={model.y(entry.value)}
                y2={model.y(entry.value)}
              />
            ))}

          {paths.map(({ entry, d }) => (
            <path
              key={entry.id}
              className={`series-line series-${entry.slot}${entry.projected ? ' series-line--projected' : ''}`}
              d={d}
            />
          ))}

          {/* One point has no segment to stroke, so it is drawn as a dot instead of
              vanishing — a term that has only just started still shows its first day. */}
          {paths.map(({ entry, last, count }) =>
            count === 1 && last ? (
              <circle
                key={`${entry.id}-dot`}
                className={`series-marker series-${entry.slot}-fill`}
                cx={last.x}
                cy={last.y}
                r={4}
              />
            ) : null,
          )}

          {hoverTime !== undefined && (
            <>
              <line
                className="chart-crosshair"
                x1={hoverX}
                x2={hoverX}
                y1={PAD.top}
                y2={height - PAD.bottom}
              />
              {series.map((entry) => {
                const value = model.byId.get(entry.id)?.get(hoverTime);
                if (value === undefined) return null;
                return (
                  <circle
                    key={entry.id}
                    className={`series-marker series-${entry.slot}-fill`}
                    cx={hoverX}
                    cy={model.y(value)}
                    r={5}
                  />
                );
              })}
            </>
          )}

          {/* Direct labels for up to four series, so identity is never color-alone. */}
          {series.length <= 4 &&
            endLabels.map(({ x, y, series: entry }) => (
              <text key={entry.id} className="chart-end-label" x={x} y={y + 4}>
                {entry.label}
              </text>
            ))}
        </svg>

        {hoverTime !== undefined && (
          <div
            className="chart-tooltip"
            style={{ left: `${tooltipPercent}%`, top: 0, transform: tooltipTransform }}
          >
            <Text variant="body-sm-semibold">{formatX(hoverTime)}</Text>
            {/* A series with no point at this time is left out rather than shown as
                zero — a projection has no value in the measured past, and vice versa. */}
            {series.map((entry) => {
              const value = model.byId.get(entry.id)?.get(hoverTime);
              if (value === undefined) return null;
              return (
                <div className="chart-tooltip-row" key={entry.id}>
                  <span className="legend-item">
                    <span className={`legend-swatch legend-swatch--${entry.slot}`} aria-hidden="true" />
                    <Text variant="body-sm-normal" color="secondary">
                      {entry.label}
                    </Text>
                  </span>
                  <Text variant="body-sm-normal">{formatValue(value)}</Text>
                </div>
              );
            })}
            {references.map((entry) => (
              <div className="chart-tooltip-row" key={entry.id}>
                <Text variant="body-sm-normal" color="secondary">
                  {entry.label}
                </Text>
                <Text variant="body-sm-normal">{formatValue(entry.value)}</Text>
              </div>
            ))}
          </div>
        )}
      </div>

      <Collapse title="View data as a table">
        <DataTable
          caption={tableCaption}
          columns={[
            { key: 'time', label: 'Time' },
            ...series.map((entry) => ({ key: entry.id, label: entry.label, numeric: true })),
          ]}
          rows={model.times.map((t) => ({
            id: String(t),
            cells: [
              formatX(t),
              ...series.map((entry) => {
                const value = model.byId.get(entry.id)?.get(t);
                return value === undefined ? '—' : formatValue(value);
              }),
            ],
          }))}
          emptyMessage="No data in the selected range."
        />
      </Collapse>
    </div>
  );
}
