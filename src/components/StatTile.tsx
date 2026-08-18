/**
 * A single headline number.
 *
 * Sometimes the right chart is not a chart: one number with its comparison beats a
 * plot with one data point. The value uses a metric type variant; the comparison
 * sits underneath in secondary ink with an arrow, so direction is never color-alone.
 *
 * `level` colors the value itself, so state is readable from across the room before
 * the number is. It is optional on purpose: a tile whose value has no good or bad
 * reading — bytes in range, a count of things — keeps plain white ink, which is what
 * makes green and red mean something on the tiles that do have a state. The detail
 * line always spells the state out in words, so color is never the only carrier.
 */

import type { ReactNode } from 'react';
import { Text } from '@capra/core';
import { ArrowTrendDown, ArrowTrendUp, Minus } from '@capra/icons';
import type { StatusLevel } from '../domain/status.ts';

export type TrendDirection = 'up' | 'down' | 'flat';

const TREND_ICONS = { up: ArrowTrendUp, down: ArrowTrendDown, flat: Minus } as const;

type StatTileProps = {
  label: string;
  value: string;
  /** Colors the value. Omit where the number is neither good nor bad. */
  level?: StatusLevel;
  /** Sub-line, e.g. `12 of 14 connected`. */
  detail?: string;
  /**
   * Makes the tile the way into its own breakdown. The label becomes the control and
   * is stretched over the tile in CSS, so the whole tile is one hit target with one
   * thing for a screen reader to announce.
   */
  onOpen?: () => void;
  trend?: {
    direction: TrendDirection;
    label: string;
    /** How to color the arrow. Omit when a direction is neither good nor bad. */
    level?: StatusLevel;
  };
  children?: ReactNode;
};

export function StatTile({ label, value, level, detail, onOpen, trend, children }: StatTileProps) {
  const TrendIcon = trend ? TREND_ICONS[trend.direction] : undefined;
  return (
    <div className={onOpen ? 'stat-tile drilldown-tile' : 'stat-tile'}>
      <Text variant="body-sm-normal" color="secondary">
        {onOpen ? (
          <button type="button" className="drilldown-trigger" onClick={onOpen}>
            {label}
          </button>
        ) : (
          label
        )}
      </Text>
      {/* The wrapper carries the color; `Text` inherits it, so the metric variant's
          size and weight are left to Capra. */}
      <span className={level ? `stat-value stat-value--${level}` : 'stat-value'}>
        <Text variant="metric-lg" as="p">
          {value}
        </Text>
      </span>
      {detail && (
        <Text variant="body-sm-normal" color="secondary">
          {detail}
        </Text>
      )}
      {trend && TrendIcon && (
        <span className="stat-trend">
          <span
            className={trend.level ? `status-icon status-icon--${trend.level}` : 'status-icon'}
            aria-hidden="true"
          >
            <TrendIcon size="sm" />
          </span>
          <Text variant="body-sm-normal" color="secondary">
            {trend.label}
          </Text>
        </span>
      )}
      {children}
    </div>
  );
}
