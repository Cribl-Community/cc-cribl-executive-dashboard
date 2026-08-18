/**
 * Worker Node drill-down.
 *
 * "Healthy systems" is one percentage; this is the deployment behind it — every
 * Worker Node the Leader knows about, disconnected first, with the heartbeat that
 * decided its state. It reads the same `systems` the summary counted, so the list is
 * the arithmetic spelled out rather than a second, differently-scoped query.
 */

import { useMemo, useState } from 'react';
import { Drawer, Text, TextField } from '@capra/core';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { StatusIndicator } from '../components/StatusIndicator.tsx';
import { formatCount, formatPercent, formatRelative, formatTimestamp } from '../domain/format.ts';
import { systemIdentifiers, type SystemHealth, type SystemSummary } from '../domain/health.ts';

const COLUMNS: Column[] = [
  { key: 'node', label: 'Node' },
  { key: 'group', label: 'Worker Group' },
  { key: 'status', label: 'Status' },
  { key: 'processes', label: 'Worker Processes', numeric: true },
  { key: 'last', label: 'Last heartbeat' },
  { key: 'version', label: 'Cribl version' },
];

/**
 * The node's own status string, when it adds something to "Connected".
 *
 * The Leader reports a free-text status alongside the connection flag; showing it
 * only when it differs from the verdict keeps the column from repeating itself.
 */
function detail(system: SystemHealth): string | undefined {
  const status = system.status?.trim();
  if (!status) return system.connected ? undefined : 'No status reported';
  return status.toLowerCase() === (system.connected ? 'connected' : '') ? undefined : status;
}

type SystemsDrilldownProps = {
  isOpen: boolean;
  onClose: () => void;
  summary: SystemSummary;
  /** Passed in so every relative time on one render agrees. */
  now: number;
};

export function SystemsDrilldown({ isOpen, onClose, summary, now }: SystemsDrilldownProps) {
  const [query, setQuery] = useState('');

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return summary.systems;
    return summary.systems.filter((system) =>
      [
        system.id,
        system.label,
        system.hostname ?? '',
        system.groupLabel,
        system.version ?? '',
        system.connected ? 'connected' : 'disconnected',
        system.status ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    );
  }, [summary.systems, query]);

  return (
    <Drawer isOpen={isOpen} onClose={onClose} width={880} title="Every Worker Node">
      <div className="card-body">
        <Text variant="body-sm-normal" color="secondary">
          {`${formatPercent(summary.healthyFraction)} healthy: ${formatCount(summary.connected)} of ${formatCount(summary.total)} Worker Nodes connected, ${formatCount(summary.disconnected)} not. A node counts as healthy while the Leader still has it connected. The Worker Group and Worker Node filters apply to this list.`}
        </Text>

        <TextField
          type="search"
          label="Find a Worker Node"
          value={query}
          onChange={setQuery}
          placeholder="Node, alias, hostname, Worker Group, or status"
        />

        <DataTable
          caption="Every Worker Node in scope, disconnected first, with Worker Process counts and the last heartbeat received"
          columns={COLUMNS}
          rows={matches.map((system) => ({
            id: system.id,
            cells: [
              <>
                <Text variant="body-sm-normal">{system.label}</Text>
                {/* The id is what the API and the Leader UI call the node, so it stays
                    visible under any alias or hostname shown above it. */}
                {systemIdentifiers(system) && (
                  <>
                    <br />
                    <Text variant="body-xs-normal" color="secondary">
                      {systemIdentifiers(system)}
                    </Text>
                  </>
                )}
              </>,
              system.groupLabel,
              <div key="status" className="cell-stack">
                <StatusIndicator
                  level={system.connected ? 'good' : 'critical'}
                  label={system.connected ? 'Connected' : 'Disconnected'}
                />
                {detail(system) && (
                  <Text variant="body-xs-normal" color="secondary">
                    {detail(system)}
                  </Text>
                )}
              </div>,
              system.processes || '—',
              <>
                <Text variant="body-sm-normal">{formatTimestamp(system.lastMessage)}</Text>
                {system.lastMessage && (
                  <>
                    <br />
                    <Text variant="body-xs-normal" color="secondary">
                      {formatRelative(system.lastMessage, now)}
                    </Text>
                  </>
                )}
              </>,
              system.version ?? '—',
            ],
          }))}
          emptyMessage={
            summary.systems.length === 0
              ? 'No Worker Nodes are in scope for the selected Worker Groups.'
              : `No Worker Node matches “${query}”.`
          }
        />
      </div>
    </Drawer>
  );
}
