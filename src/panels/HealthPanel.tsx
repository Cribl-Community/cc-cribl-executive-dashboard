/**
 * Health panel.
 *
 * Three headline percentages, then the lists that explain them. The rule is strict
 * — every Worker Process Green, or the entity is unhealthy — so the lists are where
 * the number becomes actionable: which thing, in which group, last seen when.
 */

import { useState } from 'react';
import { Card, Text } from '@capra/core';
import { HealthMeter } from '../charts/HealthMeter.tsx';
import { DataTable, type Column } from '../components/DataTable.tsx';
import { StatTile } from '../components/StatTile.tsx';
import { StatusIndicator } from '../components/StatusIndicator.tsx';
import { formatPercent, formatRelative, formatTimestamp } from '../domain/format.ts';
import { HealthDrilldown } from './HealthDrilldown.tsx';
import { SystemsDrilldown } from './SystemsDrilldown.tsx';
import {
  systemIdentifiers,
  type EntityHealth,
  type HealthSummary,
  type SystemHealth,
  type SystemSummary,
} from '../domain/health.ts';
import { levelForHealthy, type StatusLevel } from '../domain/status.ts';
import type { Health } from '../api/types.ts';

const HEALTH_LEVELS: Record<Health, StatusLevel> = {
  Green: 'good',
  Yellow: 'warning',
  Red: 'critical',
  Unknown: 'neutral',
};

const ENTITY_COLUMNS: Column[] = [
  { key: 'name', label: 'Name' },
  { key: 'group', label: 'Worker Group' },
  { key: 'status', label: 'Status' },
  { key: 'processes', label: 'Healthy processes', numeric: true },
  { key: 'last', label: 'Last connection' },
  { key: 'detail', label: 'Detail' },
];

function entityRows(entities: EntityHealth[], now: number) {
  return entities.map((entity) => ({
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
      <StatusIndicator key="status" level={HEALTH_LEVELS[entity.health]} label={entity.health} />,
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
      <Text key="detail" variant="body-sm-normal" color="secondary">
        {entity.message ?? (entity.noStatus ? 'No status reported' : 'Not all processes healthy')}
      </Text>,
    ],
  }));
}

type MeterCardProps = {
  title: string;
  noun: string;
  summary: HealthSummary;
  onOpen: () => void;
};

/**
 * A meter that is also the way into the list behind it.
 *
 * The whole card is the hit target — the title's button is stretched over it in CSS
 * — rather than a separate "view all" link, so there is exactly one control to find
 * and one thing to announce. Everything else in the card stays non-interactive, so
 * the card can be clicked anywhere without a nested-control problem.
 */
function MeterCard({ title, noun, summary, onOpen }: MeterCardProps) {
  return (
    <Card className="drilldown-card">
      <Card.Header>
        <Card.Title>
          <button type="button" className="drilldown-trigger" onClick={onOpen}>
            {title}
          </button>
        </Card.Title>
        <Card.Description>
          {`Click to see all ${summary.entities.length} ${noun}${summary.entities.length === 1 ? '' : 's'} and their health`}
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <HealthMeter
          ariaLabel={title}
          segments={[
            { level: 'good', label: 'Healthy', count: summary.connected },
            { level: 'critical', label: 'Unhealthy', count: summary.disconnected },
          ]}
        />
      </Card.Content>
    </Card>
  );
}

type HealthPanelProps = {
  systems: SystemSummary;
  sources: HealthSummary;
  destinations: HealthSummary;
  /** Passed in so every relative time on one render agrees. */
  now: number;
};

export function HealthPanel({ systems, sources, destinations, now }: HealthPanelProps) {
  /** Which drill-down is open, and therefore which list it shows. */
  const [drilldown, setDrilldown] = useState<'source' | 'destination'>();
  /** Whether the Worker Node list behind the healthy-systems percentage is open. */
  const [systemsOpen, setSystemsOpen] = useState(false);

  return (
    <div className="card-stack">
      <Card>
        <Card.Header>
          <Card.Title>Health</Card.Title>
          <Card.Description>
            A source, destination, or system counts as connected only when every Worker Process
            reports healthy. Anything less is unhealthy. Click Healthy systems to see every Worker
            Node behind that percentage. The Worker Node filter narrows the systems figures only —
            sources and destinations report their status per Worker Group.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="tile-row">
            <StatTile
              label="Healthy systems"
              value={formatPercent(systems.healthyFraction)}
              level={levelForHealthy(systems.healthyFraction)}
              onOpen={() => setSystemsOpen(true)}
              detail={`${systems.connected} of ${systems.total} Worker Nodes connected`}
              trend={{
                direction: systems.disconnected === 0 ? 'flat' : 'down',
                label:
                  systems.disconnected === 0
                    ? 'All nodes connected'
                    : `${systems.disconnected} disconnected`,
                level: levelForHealthy(systems.healthyFraction),
              }}
            />
            <StatTile
              label="Connected destinations"
              value={formatPercent(destinations.healthyFraction)}
              level={levelForHealthy(destinations.healthyFraction)}
              detail={`${destinations.connected} of ${destinations.total} destinations`}
              trend={{
                direction: destinations.disconnected === 0 ? 'flat' : 'down',
                label: `${formatPercent(destinations.unhealthyFraction)} unhealthy`,
                level: levelForHealthy(destinations.healthyFraction),
              }}
            />
            <StatTile
              label="Connected sources"
              value={formatPercent(sources.healthyFraction)}
              level={levelForHealthy(sources.healthyFraction)}
              detail={`${sources.connected} of ${sources.total} sources`}
              trend={{
                direction: sources.disconnected === 0 ? 'flat' : 'down',
                label: `${formatPercent(sources.unhealthyFraction)} unhealthy`,
                level: levelForHealthy(sources.healthyFraction),
              }}
            />
          </div>
        </Card.Content>
      </Card>

      <div className="card-grid">
        <MeterCard
          title="Destination health"
          noun="destination"
          summary={destinations}
          onOpen={() => setDrilldown('destination')}
        />
        <MeterCard
          title="Source health"
          noun="source"
          summary={sources}
          onOpen={() => setDrilldown('source')}
        />
      </div>

      <SystemsDrilldown
        isOpen={systemsOpen}
        onClose={() => setSystemsOpen(false)}
        summary={systems}
        now={now}
      />

      <HealthDrilldown
        isOpen={drilldown !== undefined}
        onClose={() => setDrilldown(undefined)}
        noun={drilldown ?? 'destination'}
        summary={drilldown === 'source' ? sources : destinations}
        now={now}
        levelFor={(entity) => HEALTH_LEVELS[entity.health]}
      />

      <Card>
        <Card.Header>
          <Card.Title>Disconnected destinations</Card.Title>
          <Card.Description>
            Every destination that is not fully healthy, worst first, with the last time it
            reported.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <DataTable
            caption="Disconnected destinations with status, healthy process counts, and last connection time"
            columns={ENTITY_COLUMNS}
            rows={entityRows(destinations.disconnectedEntities, now)}
            emptyMessage="Every destination is fully healthy."
          />
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Disconnected sources</Card.Title>
          <Card.Description>
            Sources you have excluded in settings are left out of these counts.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <DataTable
            caption="Disconnected sources with status, healthy process counts, and last connection time"
            columns={ENTITY_COLUMNS}
            rows={entityRows(sources.disconnectedEntities, now)}
            emptyMessage="Every source is fully healthy."
          />
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Disconnected Worker Nodes</Card.Title>
        </Card.Header>
        <Card.Content>
          <DataTable
            caption="Worker Nodes the Leader no longer has connected, with the last heartbeat received"
            columns={[
              { key: 'node', label: 'Node' },
              { key: 'group', label: 'Worker Group' },
              { key: 'processes', label: 'Worker Processes', numeric: true },
              { key: 'last', label: 'Last heartbeat' },
            ]}
            rows={systems.disconnectedSystems.map((system: SystemHealth) => ({
              id: system.id,
              cells: [
                <>
                  <Text variant="body-sm-normal">{system.label}</Text>
                  {/* The ids the label hides, then the version: what an operator needs to
                      find this node in the Leader UI, in one line. */}
                  {(systemIdentifiers(system) || system.version) && (
                    <>
                      <br />
                      <Text variant="body-xs-normal" color="secondary">
                        {[systemIdentifiers(system), system.version && `Cribl ${system.version}`]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </>
                  )}
                </>,
                system.groupLabel,
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
              ],
            }))}
            emptyMessage="Every Worker Node is connected."
          />
        </Card.Content>
      </Card>
    </div>
  );
}
