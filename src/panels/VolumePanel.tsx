/**
 * Volume panel.
 *
 * Ingress and egress are both bytes, so they share one chart and one axis, each
 * with its own dashed 7-day baseline. The tables below name the sources and
 * destinations that moved away from that baseline — the part an executive can act on.
 */

import { useState } from 'react';
import { Card, Collapse, Text } from '@capra/core';
import { DeviationBars, type DeviationItem } from '../charts/DeviationBars.tsx';
import { LineChart } from '../charts/LineChart.tsx';
import { Sparkline } from '../charts/Sparkline.tsx';
import { StatTile } from '../components/StatTile.tsx';
import { formatAxisTime, formatBytes, formatDelta } from '../domain/format.ts';
import { VolumeDrilldown } from './VolumeDrilldown.tsx';
import { describeEntityOrigin, type DirectionVolume, type EntityVolume } from '../domain/volume.ts';

function trendDirection(deviation: number): 'up' | 'down' | 'flat' {
  if (!Number.isFinite(deviation) || Math.abs(deviation) < 0.01) return 'flat';
  return deviation > 0 ? 'up' : 'down';
}

function toDeviationItems(entities: EntityVolume[], groupLabels: Record<string, string>): DeviationItem[] {
  return entities.map((entity) => ({
    id: entity.id,
    label: entity.id,
    sublabel: describeEntityOrigin(entity, groupLabels),
    deviation: entity.deviation,
    comparison: entity.comparison,
    currentLabel: `${formatBytes(entity.currentBytesPerDay)}/day`,
    baselineLabel: entity.baselineMissing ? '—' : `${formatBytes(entity.baselineBytesPerDay)}/day`,
  }));
}

type VolumePanelProps = {
  ingress: DirectionVolume;
  egress: DirectionVolume;
  /** Plot window, Unix ms — fixed by the filter, not by the data extent. */
  bounds: { start: number; end: number };
  spanMs: number;
  groupLabels: Record<string, string>;
};

export function VolumePanel({ ingress, egress, bounds, spanMs, groupLabels }: VolumePanelProps) {
  const formatX = (t: number) => formatAxisTime(t, spanMs);
  /** Whether the per-entity breakdown behind the headline is open. */
  const [breakdownOpen, setBreakdownOpen] = useState(false);

  const entityCount = ingress.entities.length + egress.entities.length;

  return (
    <div className="card-stack">
      {/*
       * The whole card is the way into its own breakdown — the title is a button
       * stretched over the card in CSS, matching the health meters. Nothing inside
       * the card is interactive (the tiles and sparklines are static), so there is
       * one hit target, one control to focus, and no nesting problem.
       */}
      <Card className="drilldown-card">
        <Card.Header>
          <Card.Title>
            <button
              type="button"
              className="drilldown-trigger"
              onClick={() => setBreakdownOpen(true)}
            >
              Volume against the norm
            </button>
          </Card.Title>
          <Card.Description>
            {`The norm is a 7-day average, measured per day, so it stays comparable whatever time range is selected. Click to break the headline out across all ${entityCount} sources and destinations.`}
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="tile-row">
            <StatTile
              label="Ingress in range"
              value={formatBytes(ingress.totalBytes)}
              detail={`${formatBytes(ingress.currentBytesPerDay)}/day · norm ${formatBytes(ingress.baselineBytesPerDay)}/day`}
              trend={{
                direction: trendDirection(ingress.deviation),
                label: Number.isFinite(ingress.deviation)
                  ? `${formatDelta(ingress.deviation)} vs 7-day norm`
                  : 'No baseline yet',
              }}
            >
              <Sparkline
                points={ingress.points.map((point) => ({ t: point.t, value: point.bytes }))}
                slot={1}
                ariaLabel="Ingress over the selected range"
              />
            </StatTile>
            <StatTile
              label="Egress in range"
              value={formatBytes(egress.totalBytes)}
              detail={`${formatBytes(egress.currentBytesPerDay)}/day · norm ${formatBytes(egress.baselineBytesPerDay)}/day`}
              trend={{
                direction: trendDirection(egress.deviation),
                label: Number.isFinite(egress.deviation)
                  ? `${formatDelta(egress.deviation)} vs 7-day norm`
                  : 'No baseline yet',
              }}
            >
              <Sparkline
                points={egress.points.map((point) => ({ t: point.t, value: point.bytes }))}
                slot={2}
                ariaLabel="Egress over the selected range"
              />
            </StatTile>
            {/*
              * Deviation is amber, never green or red: moving away from a 7-day norm is
              * something to look at, not a failure, and the two health hues stay
              * reserved for actual connection state.
              */}
            <StatTile
              label="Above the norm"
              value={String(ingress.above.length + egress.above.length)}
              level={ingress.above.length + egress.above.length > 0 ? 'warning' : undefined}
              detail={`${ingress.above.length} sources · ${egress.above.length} destinations`}
            />
            <StatTile
              label="Below the norm"
              value={String(ingress.below.length + egress.below.length)}
              level={ingress.below.length + egress.below.length > 0 ? 'warning' : undefined}
              detail={`${ingress.below.length} sources · ${egress.below.length} destinations`}
            />
          </div>
        </Card.Content>
      </Card>

      <VolumeDrilldown
        isOpen={breakdownOpen}
        onClose={() => setBreakdownOpen(false)}
        ingress={ingress}
        egress={egress}
        groupLabels={groupLabels}
      />

      <Card>
        <Card.Header>
          <Card.Title>Ingress and egress</Card.Title>
          <Card.Description>
            Bytes per time bucket. The dashed lines are each direction's 7-day average, scaled to
            the same bucket so they can be compared directly.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <LineChart
            series={[
              {
                id: 'ingress',
                label: 'Ingress',
                slot: 1,
                points: ingress.points.map((point) => ({ t: point.t, value: point.bytes })),
              },
              {
                id: 'egress',
                label: 'Egress',
                slot: 2,
                points: egress.points.map((point) => ({ t: point.t, value: point.bytes })),
              },
            ]}
            references={[
              {
                id: 'ingress-baseline',
                value: ingress.baselinePerBucket,
                label: 'Ingress 7-day norm',
                slot: 1,
              },
              {
                id: 'egress-baseline',
                value: egress.baselinePerBucket,
                label: 'Egress 7-day norm',
                slot: 2,
              },
            ]}
            xDomain={[bounds.start, bounds.end]}
            formatValue={formatBytes}
            formatX={formatX}
            ariaLabel="Ingress and egress bytes over the selected time range, with each direction's seven-day average"
            tableCaption="Ingress and egress bytes per time bucket"
          />
        </Card.Content>
      </Card>

      <div className="card-grid card-grid--wide">
        <Card>
          <Card.Header>
            <Card.Title>Sources away from the norm</Card.Title>
            <Card.Description>
              Ingress per source compared with its own 7-day average.
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <DeviationBars
              items={toDeviationItems([...ingress.above, ...ingress.below], groupLabels)}
              caption="Sources whose ingress is above or below their seven-day average"
              emptyMessage="Every source is within the threshold of its 7-day norm."
            />
            <Collapse title="Show all sources">
              <DeviationBars
                items={toDeviationItems(ingress.entities, groupLabels)}
                caption="Every source with its ingress and seven-day average"
                emptyMessage="No ingress reported in this range."
              />
            </Collapse>
          </Card.Content>
        </Card>

        <Card>
          <Card.Header>
            <Card.Title>Destinations away from the norm</Card.Title>
            <Card.Description>
              Egress per destination compared with its own 7-day average.
            </Card.Description>
          </Card.Header>
          <Card.Content>
            <DeviationBars
              items={toDeviationItems([...egress.above, ...egress.below], groupLabels)}
              caption="Destinations whose egress is above or below their seven-day average"
              emptyMessage="Every destination is within the threshold of its 7-day norm."
            />
            <Collapse title="Show all destinations">
              <DeviationBars
                items={toDeviationItems(egress.entities, groupLabels)}
                caption="Every destination with its egress and seven-day average"
                emptyMessage="No egress reported in this range."
              />
            </Collapse>
          </Card.Content>
        </Card>
      </div>

      {(ingress.unresolvedDimValues.length > 0 || egress.unresolvedDimValues.length > 0) && (
        <Text variant="body-sm-normal" color="secondary">
          Some metric dimension values did not match a configured source or destination and are
          listed under their raw name, so no volume is left out of the totals.
        </Text>
      )}
    </div>
  );
}
