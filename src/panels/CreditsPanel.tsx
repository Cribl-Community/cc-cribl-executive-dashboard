/**
 * Credits panel.
 *
 * Cribl has no credit API, so every figure here is derived from measured ingest and
 * the contract terms recorded in settings. The panel says that out loud, and the
 * projection is drawn dashed, because a confident number with nothing behind it is
 * worse than an honest estimate.
 */

import { Alert, Card, Text } from '@capra/core';
import { LineChart } from '../charts/LineChart.tsx';
import { StatTile } from '../components/StatTile.tsx';
import { formatAxisTime, formatCredits, formatDays, formatPercent } from '../domain/format.ts';
import type { CreditProjection } from '../domain/credits.ts';
import type { StatusLevel } from '../domain/status.ts';

/**
 * Utilization is a state, so it earns a status hue: over commitment is critical.
 *
 * Without recorded terms there is nothing to be over or under, so a tile that has no
 * commitment behind it stays uncolored rather than reporting a reassuring green.
 */
function levelForUtilization(utilization: number): StatusLevel {
  if (!Number.isFinite(utilization)) return 'neutral';
  if (utilization > 1) return 'critical';
  if (utilization > 0.9) return 'warning';
  return 'good';
}

type CreditsPanelProps = {
  projection: CreditProjection;
  /** Days of ingest the credit estimate rests on. */
  windowDays: number;
  onConfigure: () => void;
};

export function CreditsPanel({ projection, windowDays, onConfigure }: CreditsPanelProps) {
  const {
    configured,
    committedCredits,
    consumedToDate,
    currentAveragePerDay,
    projectedAveragePerDay,
    projectedTotal,
    projectedUtilization,
    currentUtilization,
    budgetPerDay,
    paceDelta,
    projectedVariance,
    daysRemaining,
    observedDays,
    trend,
    pace,
    termStart,
    termEnd,
  } = projection;

  const spanMs = termEnd - termStart;
  const measured = trend.filter((point) => !point.projected);
  const projectedPoints = trend.filter((point) => point.projected);
  // The projected line starts on the last measured point so the two read as one
  // continuous line that changes texture where measurement stops.
  const lastMeasured = measured.at(-1);
  const projectedSeries = lastMeasured ? [lastMeasured, ...projectedPoints] : projectedPoints;

  // The commitment pace is sampled at every plotted time, so hovering never compares
  // a real value against an interpolated gap.
  const paceSeries =
    pace.length === 2
      ? [...new Set([termStart, ...trend.map((point) => point.t), termEnd])]
          .sort((a, b) => a - b)
          .map((t) => ({
            t,
            value: (committedCredits * (t - termStart)) / Math.max(spanMs, 1),
          }))
      : [];

  return (
    <div className="card-stack">
      <Card>
        <Card.Header>
          <Card.Title>Credit utilization</Card.Title>
          <Card.Description>
            Estimated from measured ingest over the last {formatDays(windowDays)} at the credit rate
            in settings. Source exclusions are not applied here — a billing estimate counts all
            ingest for the selected Worker Groups.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="card-body">
            {!configured && (
              <Alert
                appearance="info"
                title="Credit terms not set"
                action={{ label: 'Set credit terms', onClick: onConfigure }}
              >
                Add the committed credits, credit rate, and term dates to see utilization and an
                end-of-term projection. The averages below are measured and do not depend on the
                commitment.
              </Alert>
            )}
            <div className="tile-row">
              <StatTile
                label="Current average"
                value={`${formatCredits(currentAveragePerDay)}/day`}
                level={
                  configured && Number.isFinite(paceDelta)
                    ? paceDelta > 0
                      ? 'warning'
                      : 'good'
                    : undefined
                }
                detail={
                  configured
                    ? `Commitment allows ${formatCredits(budgetPerDay)}/day`
                    : `Measured over ${formatDays(observedDays)} of ingest`
                }
                trend={
                  Number.isFinite(paceDelta)
                    ? {
                        direction: paceDelta > 0 ? 'up' : paceDelta < 0 ? 'down' : 'flat',
                        label:
                          paceDelta > 0
                            ? `${formatCredits(paceDelta)}/day over pace`
                            : `${formatCredits(Math.abs(paceDelta))}/day under pace`,
                        level: paceDelta > 0 ? 'warning' : 'good',
                      }
                    : undefined
                }
              />
              <StatTile
                label="Projected average"
                value={`${formatCredits(projectedAveragePerDay)}/day`}
                level={configured ? levelForUtilization(projectedUtilization) : undefined}
                detail="Full-term average implied by the current rate"
              />
              <StatTile
                label="Projected at term end"
                value={formatCredits(projectedTotal)}
                level={configured ? levelForUtilization(projectedUtilization) : undefined}
                detail={
                  configured
                    ? `${formatPercent(projectedUtilization)} of ${formatCredits(committedCredits)} committed`
                    : 'No commitment recorded'
                }
                trend={
                  Number.isFinite(projectedVariance)
                    ? {
                        direction: projectedVariance > 0 ? 'up' : 'down',
                        label:
                          projectedVariance > 0
                            ? `${formatCredits(projectedVariance)} over commitment`
                            : `${formatCredits(Math.abs(projectedVariance))} headroom`,
                        level: levelForUtilization(projectedUtilization),
                      }
                    : undefined
                }
              />
              <StatTile
                label="Consumed to date"
                value={formatCredits(consumedToDate)}
                level={configured ? levelForUtilization(currentUtilization) : undefined}
                detail={
                  configured
                    ? `${formatPercent(currentUtilization)} of commitment · ${formatDays(daysRemaining)} left in term`
                    : `${formatDays(daysRemaining)} left in term`
                }
              />
            </div>
            {projection.consumedIsEstimated && (
              <Text variant="body-sm-normal" color="secondary">
                Metrics do not reach back to the start of the term, so consumption before{' '}
                {formatAxisTime(measured[0]?.t ?? termStart, spanMs)} is extrapolated at the measured
                daily rate.
              </Text>
            )}
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>Utilization to end of term</Card.Title>
          <Card.Description>
            Cumulative credits. The solid line is measured, the dashed continuation is the current
            rate carried forward{configured ? ', against the straight commitment pace' : ''}.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <LineChart
            series={[
              {
                id: 'measured',
                label: 'Measured',
                slot: 1,
                points: measured.map((point) => ({ t: point.t, value: point.cumulative })),
              },
              {
                id: 'projected',
                label: 'Projected',
                slot: 1,
                projected: true,
                points: projectedSeries.map((point) => ({ t: point.t, value: point.cumulative })),
              },
              ...(paceSeries.length > 0
                ? [
                    {
                      id: 'pace',
                      label: 'Commitment pace',
                      slot: 3 as const,
                      projected: true,
                      points: paceSeries,
                    },
                  ]
                : []),
            ]}
            references={
              committedCredits > 0
                ? [{ id: 'committed', value: committedCredits, label: 'Committed credits' }]
                : []
            }
            xDomain={[termStart, termEnd]}
            formatValue={formatCredits}
            formatX={(t) => formatAxisTime(t, spanMs)}
            ariaLabel="Cumulative credit consumption across the contract term, with the projected continuation and the committed total"
            tableCaption="Cumulative credits by date, measured and projected"
            height={300}
          />
        </Card.Content>
      </Card>
    </div>
  );
}
