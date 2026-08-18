/**
 * Diverging bars for "above or below the norm".
 *
 * Deviation is polarity data, so it gets the diverging pair — cool for above, warm
 * for below — around a neutral zero line, plus an arrow and a signed percentage as
 * secondary encoding. It is built as a real table with the bar inside a cell, so the
 * numbers are readable, copyable, and announced without a separate table view.
 */

import { Text } from '@capra/core';
import { ArrowTrendDown, ArrowTrendUp, Minus } from '@capra/icons';
import { horizontalBarPath } from './geometry.ts';
import { formatDelta } from '../domain/format.ts';

export type DeviationItem = {
  id: string;
  label: string;
  /** Secondary line, e.g. the Worker Group or the raw metric dimension value. */
  sublabel?: string;
  /** Fractional change vs baseline. NaN when there is no baseline. */
  deviation: number;
  comparison: 'above' | 'below' | 'normal';
  currentLabel: string;
  baselineLabel: string;
};

const BAR_WIDTH = 200;
const BAR_HEIGHT = 16;
const CENTER = BAR_WIDTH / 2;
/** Floor on the axis so a small change does not render as a full-width bar. */
const MIN_DOMAIN = 0.5;

const ICONS = { above: ArrowTrendUp, below: ArrowTrendDown, normal: Minus } as const;

type DeviationBarsProps = {
  items: DeviationItem[];
  caption: string;
  emptyMessage: string;
};

export function DeviationBars({ items, caption, emptyMessage }: DeviationBarsProps) {
  if (items.length === 0) {
    return (
      <div className="table-empty">
        <Text variant="body-sm-normal" color="secondary">
          {emptyMessage}
        </Text>
      </div>
    );
  }

  const domain = Math.max(
    MIN_DOMAIN,
    ...items.map((item) => (Number.isFinite(item.deviation) ? Math.abs(item.deviation) : 0)),
  );

  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">vs 7-day baseline</th>
            <th scope="col" className="cell--numeric">
              Change
            </th>
            <th scope="col" className="cell--numeric">
              Current per day
            </th>
            <th scope="col" className="cell--numeric">
              Baseline per day
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const Icon = ICONS[item.comparison];
            const finite = Number.isFinite(item.deviation);
            const width = finite ? (Math.max(-domain, Math.min(domain, item.deviation)) / domain) * CENTER : 0;
            return (
              <tr key={item.id}>
                <td>
                  <Text variant="body-sm-normal">{item.label}</Text>
                  {item.sublabel && (
                    <>
                      <br />
                      <Text variant="body-xs-normal" color="secondary">
                        {item.sublabel}
                      </Text>
                    </>
                  )}
                </td>
                <td>
                  <svg
                    className="deviation-bar"
                    viewBox={`0 0 ${BAR_WIDTH} ${BAR_HEIGHT}`}
                    width={BAR_WIDTH}
                    height={BAR_HEIGHT}
                    aria-hidden="true"
                  >
                    <line className="chart-axis-zero" x1={CENTER} x2={CENTER} y1={0} y2={BAR_HEIGHT} />
                    {width !== 0 && (
                      <path
                        className={`bar bar--${item.comparison === 'below' ? 'below' : 'above'}`}
                        d={horizontalBarPath(CENTER, 2, width, BAR_HEIGHT - 4)}
                      />
                    )}
                  </svg>
                </td>
                <td className="cell--numeric">
                  {/* The arrow stays in text ink: a volume swing is a signal, not a
                      verdict, and status hues are reserved for actual health state. */}
                  <span className="cell-inline">
                    <span className="status-icon" aria-hidden="true">
                      <Icon size="sm" />
                    </span>
                    <Text variant="body-sm-normal">
                      {finite ? formatDelta(item.deviation) : 'No baseline'}
                    </Text>
                  </span>
                </td>
                <td className="cell--numeric">
                  <Text variant="body-sm-normal">{item.currentLabel}</Text>
                </td>
                <td className="cell--numeric">
                  <Text variant="body-sm-normal">{item.baselineLabel}</Text>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
