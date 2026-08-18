/**
 * Health drill-down.
 *
 * The meter answers "how many," this answers "which ones": every source or
 * destination behind the percentage, worst first, in one list. It reads the same
 * `entities` the summary counted, so the drill-down and the headline can never
 * disagree — the list is the arithmetic, spelled out.
 */

import { useMemo, useState } from 'react';
import { Drawer, Text, TextField } from '@capra/core';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { StatusIndicator } from '../components/StatusIndicator.tsx';
import { formatCount, formatPercent, formatRelative, formatTimestamp } from '../domain/format.ts';
import type { EntityHealth, HealthSummary } from '../domain/health.ts';
import type { StatusLevel } from '../domain/status.ts';

const COLUMNS: Column[] = [
  { key: 'name', label: 'Name' },
  { key: 'group', label: 'Worker Group' },
  { key: 'status', label: 'Status' },
  { key: 'processes', label: 'Healthy processes', numeric: true },
  { key: 'last', label: 'Last connection' },
  { key: 'counted', label: 'In the percentage' },
];

/** Disabled entities are listed but never counted, so they say so in their row. */
function countedLabel(entity: EntityHealth): string {
  if (entity.disabled) return 'No — disabled in config';
  return entity.connected ? 'Yes — healthy' : 'Yes — unhealthy';
}

function detail(entity: EntityHealth): string | undefined {
  if (entity.message) return entity.message;
  if (entity.noStatus) return 'No status reported';
  return undefined;
}

type HealthDrilldownProps = {
  isOpen: boolean;
  onClose: () => void;
  /** "destination" or "source", lowercase: used in the title and empty states. */
  noun: string;
  summary: HealthSummary;
  now: number;
  levelFor: (entity: EntityHealth) => StatusLevel;
};

export function HealthDrilldown({
  isOpen,
  onClose,
  noun,
  summary,
  now,
  levelFor,
}: HealthDrilldownProps) {
  const [query, setQuery] = useState('');

  /**
   * One drawer serves both lists, so a search typed against destinations would
   * otherwise still be filtering when the sources list opens — an empty table for a
   * term the user cannot see they typed. Resetting on the noun rather than on
   * `isOpen` keeps a search alive while the same list is being read.
   */
  const [searchedNoun, setSearchedNoun] = useState(noun);
  if (searchedNoun !== noun) {
    setSearchedNoun(noun);
    setQuery('');
  }

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return summary.entities;
    return summary.entities.filter((entity) =>
      [entity.id, entity.type ?? '', entity.groupLabel, entity.health]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [summary.entities, query]);

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      width={880}
      title={`Every ${noun}`}
    >
      <div className="card-body">
        <Text variant="body-sm-normal" color="secondary">
          {`${formatPercent(summary.healthyFraction)} healthy: ${formatCount(summary.connected)} of ${formatCount(summary.total)} ${noun}s fully healthy, ${formatCount(summary.disconnected)} not.${
            summary.disabled.length > 0
              ? ` ${formatCount(summary.disabled.length)} disabled ${noun}(s) are listed but not counted.`
              : ''
          } The dashboard filters and any exclusions in settings apply to this list.`}
        </Text>

        <TextField
          type="search"
          label={`Find a ${noun}`}
          value={query}
          onChange={setQuery}
          placeholder="Name, type, Worker Group, or status"
        />

        <DataTable
          caption={`Every ${noun} in scope, worst health first, with healthy process counts and last connection time`}
          columns={COLUMNS}
          rows={matches.map((entity) => ({
            id: entity.key,
            cells: [
              <>
                <Text variant="body-sm-normal">{entity.id}</Text>
                {entity.type && (
                  <>
                    <br />
                    <Text variant="body-xs-normal" color="secondary">
                      {entity.type}
                    </Text>
                  </>
                )}
              </>,
              entity.groupLabel,
              <div key="status" className="cell-stack">
                <StatusIndicator level={levelFor(entity)} label={entity.health} />
                {detail(entity) && (
                  <Text variant="body-xs-normal" color="secondary">
                    {detail(entity)}
                  </Text>
                )}
              </div>,
              entity.processes > 0 ? `${entity.greenProcesses} of ${entity.processes}` : '—',
              <>
                <Text variant="body-sm-normal">{formatTimestamp(entity.lastConnected)}</Text>
                {entity.lastConnected && (
                  <>
                    <br />
                    <Text variant="body-xs-normal" color="secondary">
                      {formatRelative(entity.lastConnected, now)}
                    </Text>
                  </>
                )}
              </>,
              <Text key="counted" variant="body-sm-normal" color="secondary">
                {countedLabel(entity)}
              </Text>,
            ],
          }))}
          emptyMessage={
            summary.entities.length === 0
              ? `No ${noun}s are in scope for the current filters.`
              : `No ${noun} matches “${query}”.`
          }
        />
      </div>
    </Drawer>
  );
}
