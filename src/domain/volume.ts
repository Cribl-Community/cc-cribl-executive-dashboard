/**
 * Volume roll-up: series for the chart, per-entity totals, and comparison to the
 * 7-day norm.
 *
 * Metric dimension values are composite (`syslog:in_syslog:udp`), so they are
 * resolved back to configured source and destination ids before anything is
 * summed. Unresolvable values are kept under their raw name rather than dropped —
 * a total that silently omits traffic is worse than one with an odd label.
 */

import { BASELINE_DAYS, type DirectionResult } from '../api/metrics.ts';

export type SeriesPoint = { t: number; bytes: number };

/**
 * Maps a metric dimension value to a configured entity id.
 *
 * Tries the whole value first, then its colon-separated parts longest-first, so
 * `syslog:in_syslog:udp` resolves to the configured `in_syslog`. Falls back to the
 * raw value when nothing matches.
 */
export function resolveEntityId(dimValue: string, knownIds: Set<string>): string {
  if (!dimValue) return '(unknown)';
  if (knownIds.has(dimValue)) return dimValue;
  const parts = dimValue
    .split(':')
    .map((part) => part.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const part of parts) {
    if (knownIds.has(part)) return part;
  }
  return dimValue;
}

export type EntityVolume = {
  /** Resolved entity id, or the raw dimension value when unresolvable. */
  id: string;
  /** Every raw dimension value rolled into this entity. */
  dimValues: string[];
  groupIds: string[];
  /** Bytes over the selected range. */
  bytes: number;
  /** Bytes per day over the selected range. */
  currentBytesPerDay: number;
  /** Bytes per day averaged over the trailing 7 days. */
  baselineBytesPerDay: number;
  /** Fractional change vs the baseline. NaN when there is no baseline to compare. */
  deviation: number;
  /** No traffic in the baseline window — new, or newly resumed. */
  baselineMissing: boolean;
  comparison: 'above' | 'below' | 'normal';
  /** True when the dimension value did not match any configured entity. */
  unresolved: boolean;
};

/**
 * Where an entity's bytes came from, as one line: its Worker Groups, plus the raw
 * dimension value when the id could not be resolved to a configured entity.
 *
 * Shared by the bar rows and the drill-down so the same source is never described
 * two different ways in two places on the same screen.
 */
export function describeEntityOrigin(
  entity: EntityVolume,
  groupLabels: Record<string, string>,
): string {
  return [
    // An empty group id means metrics carried no Worker Group dimension, so the
    // row is deployment-wide rather than mislabelled as belonging to nothing.
    entity.groupIds
      .map((groupId) => (groupId ? (groupLabels[groupId] ?? groupId) : 'all Worker Groups'))
      .join(', '),
    entity.unresolved ? `unmatched metric dimension: ${entity.dimValues.join(', ')}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

type Accumulator = {
  bytes: number;
  dimValues: Set<string>;
  groupIds: Set<string>;
  unresolved: boolean;
};

const DAY_MS = 86_400_000;

function accumulate(
  result: DirectionResult,
  knownIds: Set<string>,
  keep: (id: string) => boolean,
): { totals: Map<string, Accumulator>; series: Map<number, number> } {
  const totals = new Map<string, Accumulator>();
  const series = new Map<number, number>();

  for (const { groupId, buckets } of result.byGroup) {
    for (const bucket of buckets) {
      const id = resolveEntityId(bucket.dimValue, knownIds);
      if (!keep(id)) continue;
      let entry = totals.get(id);
      if (!entry) {
        entry = { bytes: 0, dimValues: new Set(), groupIds: new Set(), unresolved: !knownIds.has(id) };
        totals.set(id, entry);
      }
      entry.bytes += bucket.bytes;
      if (bucket.dimValue) entry.dimValues.add(bucket.dimValue);
      entry.groupIds.add(groupId);
      series.set(bucket.t, (series.get(bucket.t) ?? 0) + bucket.bytes);
    }
  }

  return { totals, series };
}

function toSeries(points: Map<number, number>): SeriesPoint[] {
  return [...points.entries()]
    .map(([t, bytes]) => ({ t, bytes }))
    .sort((a, b) => a.t - b.t);
}

export type DirectionVolume = {
  /** Total bytes per bucket across every counted entity and group. */
  points: SeriesPoint[];
  totalBytes: number;
  /** Bytes per day over the selected range — comparable to the baseline. */
  currentBytesPerDay: number;
  /** Deployment-wide 7-day average, bytes per day. */
  baselineBytesPerDay: number;
  /** The same baseline expressed per chart bucket, for the reference line. */
  baselinePerBucket: number;
  deviation: number;
  entities: EntityVolume[];
  above: EntityVolume[];
  below: EntityVolume[];
  /** Raw dimension values that matched no configured entity. */
  unresolvedDimValues: string[];
  errors: Array<{ groupId: string; error: unknown }>;
};

function classify(deviation: number, threshold: number, baselineMissing: boolean, current: number) {
  if (baselineMissing) return current > 0 ? ('above' as const) : ('normal' as const);
  if (!Number.isFinite(deviation)) return 'normal' as const;
  if (deviation >= threshold) return 'above' as const;
  if (deviation <= -threshold) return 'below' as const;
  return 'normal' as const;
}

export type VolumeOptions = {
  /** Ids of configured entities, used to resolve composite dimension values. */
  knownIds: Set<string>;
  /** Selected ids; empty means all. Applied after resolution. */
  selectedIds: Set<string>;
  /** Ids removed from every total and from the chart. */
  excludedIds: Set<string>;
  /** Length of the selected range, ms — the denominator for the current rate. */
  spanMs: number;
  bucketSeconds: number;
  /** Fractional deviation past which an entity is listed above or below the norm. */
  threshold: number;
};

/**
 * Builds one direction's view from the range series and the 7-day baseline.
 *
 * Selection and exclusion are applied identically to the chart series and the
 * per-entity table, so the headline number is always the sum of the rows shown.
 */
export function buildDirectionVolume(
  range: DirectionResult,
  baseline: DirectionResult,
  options: VolumeOptions,
): DirectionVolume {
  const { knownIds, selectedIds, excludedIds, spanMs, bucketSeconds, threshold } = options;
  const keep = (id: string) =>
    !excludedIds.has(id) && (selectedIds.size === 0 || selectedIds.has(id));

  const current = accumulate(range, knownIds, keep);
  const baselineTotals = accumulate(baseline, knownIds, keep).totals;

  const spanDays = Math.max(spanMs / DAY_MS, 1 / 1440);
  const ids = new Set([...current.totals.keys(), ...baselineTotals.keys()]);

  const entities: EntityVolume[] = [];
  for (const id of ids) {
    const rangeEntry = current.totals.get(id);
    const baselineEntry = baselineTotals.get(id);
    const bytes = rangeEntry?.bytes ?? 0;
    const currentBytesPerDay = bytes / spanDays;
    const baselineBytesPerDay = (baselineEntry?.bytes ?? 0) / BASELINE_DAYS;
    const baselineMissing = baselineBytesPerDay <= 0;
    const deviation = baselineMissing
      ? Number.NaN
      : (currentBytesPerDay - baselineBytesPerDay) / baselineBytesPerDay;
    entities.push({
      id,
      dimValues: [...(rangeEntry?.dimValues ?? baselineEntry?.dimValues ?? new Set<string>())],
      groupIds: [...(rangeEntry?.groupIds ?? baselineEntry?.groupIds ?? new Set<string>())],
      bytes,
      currentBytesPerDay,
      baselineBytesPerDay,
      deviation,
      baselineMissing,
      comparison: classify(deviation, threshold, baselineMissing, currentBytesPerDay),
      unresolved: (rangeEntry?.unresolved ?? baselineEntry?.unresolved) === true,
    });
  }

  entities.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));

  const totalBytes = entities.reduce((sum, entity) => sum + entity.bytes, 0);
  const baselineBytesPerDay = entities.reduce(
    (sum, entity) => sum + entity.baselineBytesPerDay,
    0,
  );
  const currentBytesPerDay = totalBytes / spanDays;
  const deviation =
    baselineBytesPerDay > 0
      ? (currentBytesPerDay - baselineBytesPerDay) / baselineBytesPerDay
      : Number.NaN;

  const byDeviation = entities.filter((entity) => entity.comparison !== 'normal');

  return {
    points: toSeries(current.series),
    totalBytes,
    currentBytesPerDay,
    baselineBytesPerDay,
    baselinePerBucket: (baselineBytesPerDay * bucketSeconds) / 86_400,
    deviation,
    entities,
    above: byDeviation
      .filter((entity) => entity.comparison === 'above')
      .sort((a, b) => b.currentBytesPerDay - a.currentBytesPerDay),
    below: byDeviation
      .filter((entity) => entity.comparison === 'below')
      .sort((a, b) => a.deviation - b.deviation),
    unresolvedDimValues: entities
      .filter((entity) => entity.unresolved)
      .flatMap((entity) => entity.dimValues),
    errors: [...range.errors, ...baseline.errors],
  };
}

/** Total bytes ingested over the trailing 7 days — the input to credit projection. */
export function baselineTotalBytes(direction: DirectionVolume): number {
  return direction.baselineBytesPerDay * BASELINE_DAYS;
}

/** Aligns two directions onto one bucket axis so the line chart shares an x-scale. */
export function mergeSeries(
  ingress: SeriesPoint[],
  egress: SeriesPoint[],
): Array<{ t: number; ingress: number; egress: number }> {
  const times = new Set<number>([...ingress.map((p) => p.t), ...egress.map((p) => p.t)]);
  const inMap = new Map(ingress.map((point) => [point.t, point.bytes]));
  const outMap = new Map(egress.map((point) => [point.t, point.bytes]));
  return [...times]
    .sort((a, b) => a - b)
    .map((t) => ({ t, ingress: inMap.get(t) ?? 0, egress: outMap.get(t) ?? 0 }));
}
