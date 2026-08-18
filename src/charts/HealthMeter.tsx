/**
 * A part-to-whole meter for healthy vs unhealthy counts.
 *
 * A pie would be worse here: two or three parts of one total, read as "how much of
 * it is fine", is exactly what a single stacked bar shows best. Segments carry a
 * 2px surface gap so they never merge, and every segment is also listed with its
 * icon, label, and count below.
 */

import { Text } from '@capra/core';
import { StatusIndicator } from '../components/StatusIndicator.tsx';
import type { StatusLevel } from '../domain/status.ts';
import { formatPercent } from '../domain/format.ts';

export type MeterSegment = {
  level: StatusLevel;
  label: string;
  count: number;
};

type HealthMeterProps = {
  segments: MeterSegment[];
  /** Names what the meter covers, e.g. "Destination health". */
  ariaLabel: string;
};

export function HealthMeter({ segments, ariaLabel }: HealthMeterProps) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  const visible = segments.filter((segment) => segment.count > 0);

  return (
    <div className="health-meter">
      <div
        className="meter"
        role="img"
        aria-label={`${ariaLabel}: ${visible
          .map((segment) => `${segment.count} ${segment.label}`)
          .join(', ')}`}
      >
        {visible.map((segment) => (
          <div
            key={segment.level}
            className={`meter-segment meter-segment--${segment.level}`}
            style={{ width: `${(segment.count / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="meter-key">
        {segments.map((segment) => (
          <li key={segment.level}>
            <StatusIndicator level={segment.level} label={segment.label} />
            <Text variant="body-sm-normal" color="secondary">
              {segment.count} · {total > 0 ? formatPercent(segment.count / total) : '—'}
            </Text>
          </li>
        ))}
      </ul>
    </div>
  );
}
