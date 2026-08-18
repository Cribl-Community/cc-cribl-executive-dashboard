/**
 * Volume drill-down.
 *
 * "Volume against the norm" gives four numbers; this gives the breakdown behind
 * them — every source with its ingress and every destination with its egress, each
 * against its own 7-day average. It reads the same `entities` the headline summed,
 * so the rows always add up to the tiles rather than being a second, differently
 * scoped query.
 *
 * Rows lead with the biggest movers rather than the biggest talkers: the panel's
 * subject is deviation, and a source that doubled matters more than one that is
 * merely large and steady. Volume is still a column, so size stays readable.
 */

import { useMemo, useState } from 'react';
import { Drawer, Text, TextField } from '@capra/core';
import { ArrowTrendDown, ArrowTrendUp, Minus } from '@capra/icons';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { formatBytes, formatDelta, formatPercent } from '../domain/format.ts';
import { describeEntityOrigin, type DirectionVolume, type EntityVolume } from '../domain/volume.ts';

const COLUMNS: Column[] = [
  { key: 'name', label: 'Name' },
  { key: 'bytes', label: 'Volume in range', numeric: true },
  { key: 'share', label: 'Share', numeric: true },
  { key: 'perDay', label: 'Per day', numeric: true },
  { key: 'norm', label: '7-day norm, per day', numeric: true },
  { key: 'change', label: 'Change', numeric: true },
  { key: 'status', label: 'Against the norm' },
];

const ICONS = { above: ArrowTrendUp, below: ArrowTrendDown, normal: Minus } as const;

const STATUS_LABELS = {
  above: 'Above the norm',
  below: 'Below the norm',
  normal: 'Within the norm',
} as const;

/**
 * How far an entity moved, for ordering.
 *
 * A first-time or newly resumed entity has no baseline to deviate from, so it sorts
 * to the very top when it is carrying traffic — that is the largest unexplained
 * change on the screen, not a missing value to be tidied away at the bottom.
 */
function movement(entity: EntityVolume): number {
  if (entity.baselineMissing) return entity.bytes > 0 ? Number.POSITIVE_INFINITY : -1;
  return Number.isFinite(entity.deviation) ? Math.abs(entity.deviation) : -1;
}

function statusLabel(entity: EntityVolume): string {
  if (entity.baselineMissing) {
    return entity.bytes > 0 ? 'New — no 7-day norm yet' : 'No traffic in either window';
  }
  return STATUS_LABELS[entity.comparison];
}

type DirectionSectionProps = {
  heading: string;
  /** "source" / "destination", lowercase: used in the empty states. */
  noun: string;
  measure: string;
  direction: DirectionVolume;
  groupLabels: Record<string, string>;
  query: string;
};

function DirectionSection({
  heading,
  noun,
  measure,
  direction,
  groupLabels,
  query,
}: DirectionSectionProps) {
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return direction.entities
      .filter((entity) =>
        needle === ''
          ? true
          : [entity.id, describeEntityOrigin(entity, groupLabels), statusLabel(entity)]
              .join(' ')
              .toLowerCase()
              .includes(needle),
      )
      .sort((a, b) => movement(b) - movement(a) || b.bytes - a.bytes || a.id.localeCompare(b.id));
  }, [direction.entities, groupLabels, query]);

  return (
    <div className="card-body">
      <div className="stat-tile">
        <Text variant="body-md-semibold">{heading}</Text>
        <Text variant="body-sm-normal" color="secondary">
          {`${formatBytes(direction.totalBytes)} in range · ${formatBytes(direction.currentBytesPerDay)}/day against a norm of ${formatBytes(direction.baselineBytesPerDay)}/day${
            Number.isFinite(direction.deviation) ? ` (${formatDelta(direction.deviation)})` : ''
          } · ${direction.above.length} above, ${direction.below.length} below the threshold`}
        </Text>
      </div>

      <DataTable
        caption={`Every ${noun} with its ${measure} in range, share of the total, per-day rate, seven-day norm, and change against that norm`}
        columns={COLUMNS}
        rows={rows.map((entity) => {
          const Icon = ICONS[entity.comparison];
          const origin = describeEntityOrigin(entity, groupLabels);
          return {
            id: entity.id,
            cells: [
              <>
                <Text variant="body-sm-normal">{entity.id}</Text>
                {origin && (
                  <>
                    <br />
                    <Text variant="body-xs-normal" color="secondary">
                      {origin}
                    </Text>
                  </>
                )}
              </>,
              formatBytes(entity.bytes),
              // Share of the direction's own total, so ingress shares and egress
              // shares each add to 100% instead of being diluted by the other.
              direction.totalBytes > 0 ? formatPercent(entity.bytes / direction.totalBytes) : '—',
              `${formatBytes(entity.currentBytesPerDay)}/day`,
              entity.baselineMissing ? '—' : `${formatBytes(entity.baselineBytesPerDay)}/day`,
              // The arrow stays in text ink: a volume swing is a signal, not a
              // verdict, and status hues are reserved for actual health state.
              <span key="change" className="cell-inline">
                <span className="status-icon" aria-hidden="true">
                  <Icon size="sm" />
                </span>
                <Text variant="body-sm-normal">
                  {Number.isFinite(entity.deviation) ? formatDelta(entity.deviation) : 'No baseline'}
                </Text>
              </span>,
              <Text key="status" variant="body-sm-normal" color="secondary">
                {statusLabel(entity)}
              </Text>,
            ],
          };
        })}
        emptyMessage={
          direction.entities.length === 0
            ? `No ${measure} reported for any ${noun} in this range.`
            : `No ${noun} matches “${query}”.`
        }
      />
    </div>
  );
}

type VolumeDrilldownProps = {
  isOpen: boolean;
  onClose: () => void;
  ingress: DirectionVolume;
  egress: DirectionVolume;
  groupLabels: Record<string, string>;
};

export function VolumeDrilldown({
  isOpen,
  onClose,
  ingress,
  egress,
  groupLabels,
}: VolumeDrilldownProps) {
  /** One search across both lists: an id is usually only in one of them anyway. */
  const [query, setQuery] = useState('');

  return (
    <Drawer isOpen={isOpen} onClose={onClose} width={1040} title="Volume against the norm">
      <div className="card-stack">
        <Text variant="body-sm-normal" color="secondary">
          Every source and destination behind the headline, biggest mover first. The norm is each
          entity&rsquo;s own 7-day average, measured per day, so it stays comparable whatever range
          is selected. The dashboard filters and any exclusions in settings apply to these lists.
        </Text>

        <TextField
          type="search"
          label="Find a source or destination"
          value={query}
          onChange={setQuery}
          placeholder="Name, Worker Group, or status"
        />

        <DirectionSection
          heading="Sources — ingress"
          noun="source"
          measure="ingress"
          direction={ingress}
          groupLabels={groupLabels}
          query={query}
        />

        <DirectionSection
          heading="Destinations — egress"
          noun="destination"
          measure="egress"
          direction={egress}
          groupLabels={groupLabels}
          query={query}
        />
      </div>
    </Drawer>
  );
}
