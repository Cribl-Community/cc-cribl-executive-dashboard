/**
 * Volume metrics transport and parsing.
 *
 * Everything the volume panel needs comes from four aggregation queries: ingress
 * and egress over the selected range, and the same two over a fixed 7-day window
 * for the baseline. Each is a single Leader-level query split by entity *and* by
 * Worker Group, because the metrics store is not group-scoped — attribution comes
 * from a dimension in the results, not from a `/m/:gid` URL. All filtering,
 * roll-up, and exclusion happens client-side, so the headline chart and the
 * per-entity table can never disagree about which sources are counted.
 */

import { metricsQuery } from './cribl.ts';
import { describeError, isAbort } from './criblFetch.ts';
import type { MetricsQueryEvent, MetricsQueryRequest } from './types.ts';

/**
 * Metric and dimension names as reported by Cribl internal metrics. These are
 * overridable in settings because a deployment can rename or namespace them, and
 * the diagnostics panel lists what the live system actually reports.
 */
export type MetricNames = {
  inBytes: string;
  outBytes: string;
  inputDim: string;
  outputDim: string;
  /** Dimension carrying the Worker Group each metric came from. */
  groupDim: string;
};

export const DEFAULT_METRIC_NAMES: MetricNames = {
  inBytes: 'total.in_bytes',
  outBytes: 'total.out_bytes',
  inputDim: 'input',
  outputDim: 'output',
  groupDim: '__worker_group',
};

/** One entity's byte total inside one time bucket. */
export type EntityBucket = {
  /** Raw dimension value, e.g. `syslog:in_syslog:udp`. */
  dimValue: string;
  /** Bucket start, Unix ms. */
  t: number;
  bytes: number;
};

/** A bucket before it has been attributed to a Worker Group. */
type MetricRow = EntityBucket & { groupId: string };

const VALUE_ALIAS = 'bytes';

/**
 * Builds the aggregation expression. Metric names are wrapped in double quotes
 * to match Cribl's documented expression form, e.g. `sum("total.in_bytes")`.
 */
function sumExpression(metricName: string): string {
  return `sum("${metricName}").as("${VALUE_ALIAS}")`;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * `_time` is documented as Unix seconds, but tolerate millisecond values so a
 * deployment that reports them does not silently render a chart in 1970.
 */
function toEpochMs(value: unknown): number | undefined {
  const raw = toNumber(value);
  if (raw <= 0) return undefined;
  return raw > 1e11 ? raw : raw * 1000;
}

/** A split-by value, or `''` when the dimension is absent from this row. */
function dimensionValue(event: MetricsQueryEvent, dimension: string): string {
  if (!dimension) return '';
  const value = event[dimension];
  return typeof value === 'string' ? value : '';
}

/** Row fields that are metadata rather than the aggregated measure. */
const RESERVED_FIELDS = new Set(['_time', '_raw', '_metric', 'starttime', 'endtime']);

/**
 * Reads the aggregated number out of a result row.
 *
 * The `.as("bytes")` alias is preferred, but not trusted: if a deployment returns
 * the column under its expression name instead, every figure on the page would read
 * zero while every request succeeded — the least diagnosable failure available. So
 * fall back to the row's only other number, skipping timestamps and the split-by
 * dimensions.
 */
function aggregatedValue(event: MetricsQueryEvent, splitBys: string[]): number {
  const aliased = event[VALUE_ALIAS];
  if (typeof aliased === 'number' || typeof aliased === 'string') return toNumber(aliased);
  for (const [field, value] of Object.entries(event)) {
    if (RESERVED_FIELDS.has(field) || splitBys.includes(field)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

function parseRows(
  events: MetricsQueryEvent[] | undefined,
  dimension: string,
  groupDim: string,
): MetricRow[] {
  if (!events) return [];
  const splitBys = [dimension, groupDim].filter(Boolean);
  const rows: MetricRow[] = [];
  for (const event of events) {
    const t = toEpochMs(event._time ?? event.starttime);
    if (t === undefined) continue;
    rows.push({
      groupId: dimensionValue(event, groupDim),
      dimValue: dimensionValue(event, dimension),
      t,
      bytes: aggregatedValue(event, splitBys),
    });
  }
  return rows;
}

export type SeriesRequest = {
  /** Relative (`-24h`) or Unix ms. */
  earliest: string | number;
  latest: string | number;
  bucketSeconds: number;
};

const RELATIVE_UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const RELATIVE_PATTERN = /^-(\d+)([smhdw])$/;

/**
 * Resolves a range endpoint to Unix ms.
 *
 * The API documents relative strings (`-24h`, `now`) as acceptable, but a
 * deployment that does not resolve them answers with an empty result set and a
 * 200 — a zero that looks like "no traffic" rather than "no range". Absolute
 * milliseconds are accepted everywhere and cannot be misread, so that is what
 * goes on the wire; the relative form stays in the UI layer, where it belongs.
 */
export function toAbsoluteMs(value: string | number, now: number): number {
  if (typeof value === 'number') return value;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'now') return now;
  const match = RELATIVE_PATTERN.exec(trimmed);
  if (match) return now - Number(match[1]) * RELATIVE_UNITS[match[2]];
  // Only this app's own presets reach here, so an unparsed value is a bug, not
  // user input; `now` keeps the request valid and the panel visibly empty.
  return now;
}

function queryBody(
  metricName: string,
  dimension: string,
  groupDim: string,
  request: SeriesRequest,
  now = Date.now(),
): MetricsQueryRequest {
  const splitBys = [dimension, groupDim].filter(Boolean);
  return {
    earliest: toAbsoluteMs(request.earliest, now),
    latest: toAbsoluteMs(request.latest, now),
    aggs: {
      aggregations: [sumExpression(metricName)],
      ...(splitBys.length > 0 ? { splitBys } : {}),
      timeWindowSeconds: request.bucketSeconds,
    },
  };
}

/** One query: byte totals bucketed over time, split by entity and Worker Group. */
async function queryRows(
  metricName: string,
  dimension: string,
  groupDim: string,
  request: SeriesRequest,
  signal?: AbortSignal,
): Promise<MetricRow[]> {
  const response = await metricsQuery(queryBody(metricName, dimension, groupDim, request), signal);
  return parseRows(response.results, dimension, groupDim);
}

export type QuerySample = {
  /** What was varied, in words, so a passing row names its own fix. */
  label: string;
  request: MetricsQueryRequest;
  rowCount: number;
  /** The first rows, verbatim, so field names can be read rather than inferred. */
  rows: MetricsQueryEvent[];
  /** What this app made of the whole response. */
  parsed: { buckets: number; bytes: number; entities: string[]; groups: string[] };
  error?: string;
};

function readSample(
  label: string,
  request: MetricsQueryRequest,
  results: MetricsQueryEvent[],
  dimension: string,
  groupDim: string,
): QuerySample {
  const rows = parseRows(results, dimension, groupDim);
  return {
    label,
    request,
    rowCount: results.length,
    rows: results.slice(0, 3),
    parsed: {
      buckets: new Set(rows.map((row) => row.t)).size,
      bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
      entities: [...new Set(rows.map((row) => row.dimValue).filter(Boolean))].slice(0, 12),
      groups: [...new Set(rows.map((row) => row.groupId).filter(Boolean))],
    },
  };
}

/**
 * Runs a small sweep of read-only variants of the volume query and reports the raw
 * response of each.
 *
 * An empty result and a 200 is the least diagnosable answer the API can give: a
 * wrong metric name, an unresolved relative time range, an unsupported split-by, and
 * genuinely idle traffic all look identical from the panels. Each variant changes
 * exactly one of those things, so whichever one returns rows names the fix. All four
 * are `POST`-shaped reads that mutate nothing.
 */
export async function sampleQueries(
  metricName: string,
  dimension: string,
  groupDim: string,
  request: SeriesRequest,
  signal?: AbortSignal,
): Promise<QuerySample[]> {
  const now = Date.now();
  const absolute = queryBody(metricName, dimension, groupDim, request, now);

  const variants: Array<{ label: string; request: MetricsQueryRequest; dimension: string }> = [
    { label: 'As the dashboard queries it', request: absolute, dimension },
    {
      label: 'Relative time strings instead of Unix ms',
      request: { ...absolute, earliest: '-1h', latest: 'now' },
      dimension,
    },
    {
      label: 'No split-bys',
      request: { ...absolute, aggs: { ...absolute.aggs, splitBys: undefined } },
      dimension: '',
    },
    {
      label: 'Cumulative instead of time buckets',
      request: {
        ...absolute,
        aggs: { aggregations: absolute.aggs.aggregations, cumulative: true },
      },
      dimension: '',
    },
  ];

  const samples: QuerySample[] = [];
  for (const variant of variants) {
    try {
      const response = await metricsQuery(variant.request, signal);
      samples.push(
        readSample(
          variant.label,
          variant.request,
          response.results ?? [],
          variant.dimension,
          groupDim,
        ),
      );
    } catch (error) {
      if (isAbort(error)) return samples;
      samples.push({
        label: variant.label,
        request: variant.request,
        rowCount: 0,
        rows: [],
        parsed: { buckets: 0, bytes: 0, entities: [], groups: [] },
        error: describeError(error),
      });
    }
  }
  return samples;
}

/** Per-group buckets for one direction, keeping partial success across groups. */
export type DirectionResult = {
  byGroup: Array<{ groupId: string; buckets: EntityBucket[] }>;
  /** A `groupId` of `''` means the one query failed, not one group's share of it. */
  errors: Array<{ groupId: string; error: unknown }>;
  /**
   * Results arrived, but none carried the Worker Group dimension: the figures are
   * deployment-wide and the Worker Group filter did not narrow them.
   */
  unattributed: boolean;
};

const EMPTY_DIRECTION: DirectionResult = { byGroup: [], errors: [], unattributed: false };

/**
 * Splits rows into the per-group shape the panels consume.
 *
 * Groups are filtered here rather than in the query, with a `where` clause: a
 * server-side filter would stake the entire figure on the group dimension being
 * named exactly as configured, whereas this way a wrong name costs the group
 * *labels* and not the *volume*. So when no row carries the dimension at all,
 * everything is kept under an empty group id and flagged `unattributed` — a
 * deployment-wide total the panel can still show, and diagnostics can explain.
 */
function attribute(
  rows: MetricRow[],
  groupIds: string[],
): Pick<DirectionResult, 'byGroup' | 'unattributed'> {
  const inScope = new Set(groupIds);
  const attributable = rows.some((row) => row.groupId !== '');
  const byGroup = new Map<string, EntityBucket[]>();

  for (const row of rows) {
    if (attributable && !inScope.has(row.groupId)) continue;
    const key = attributable ? row.groupId : '';
    const buckets = byGroup.get(key);
    const bucket = { dimValue: row.dimValue, t: row.t, bytes: row.bytes };
    if (buckets) buckets.push(bucket);
    else byGroup.set(key, [bucket]);
  }

  return {
    byGroup: [...byGroup.entries()].map(([groupId, buckets]) => ({ groupId, buckets })),
    unattributed: rows.length > 0 && !attributable,
  };
}

export async function fetchDirection(
  groupIds: string[],
  metricName: string,
  dimension: string,
  groupDim: string,
  request: SeriesRequest,
  signal?: AbortSignal,
): Promise<DirectionResult> {
  try {
    const rows = await queryRows(metricName, dimension, groupDim, request, signal);
    return { ...attribute(rows, groupIds), errors: [] };
  } catch (error) {
    // A cancelled load is not a failure to report; the caller discards the result.
    if (isAbort(error)) return EMPTY_DIRECTION;
    return { byGroup: [], errors: [{ groupId: '', error }], unattributed: false };
  }
}

/**
 * One total series for the selected groups, un-split by entity.
 *
 * Credit consumption is a billing number, so it is measured against *all* ingest
 * for the selected groups — no split by source and no exclusions, which would
 * understate what was actually charged.
 */
export async function fetchTotalSeries(
  groupIds: string[],
  metricName: string,
  groupDim: string,
  request: SeriesRequest,
  signal?: AbortSignal,
): Promise<{ points: Array<{ t: number; bytes: number }>; errors: Array<{ groupId: string; error: unknown }> }> {
  let result: DirectionResult;
  try {
    const rows = await queryRows(metricName, '', groupDim, request, signal);
    result = { ...attribute(rows, groupIds), errors: [] };
  } catch (error) {
    if (isAbort(error)) return { points: [], errors: [] };
    return { points: [], errors: [{ groupId: '', error }] };
  }

  const totals = new Map<number, number>();
  for (const { buckets } of result.byGroup) {
    for (const bucket of buckets) totals.set(bucket.t, (totals.get(bucket.t) ?? 0) + bucket.bytes);
  }

  return {
    points: [...totals.entries()].map(([t, bytes]) => ({ t, bytes })).sort((a, b) => a.t - b.t),
    errors: [],
  };
}

export type VolumeFetch = {
  ingress: DirectionResult;
  egress: DirectionResult;
  /** Daily buckets over the trailing 7 days, the baseline for both directions. */
  ingressBaseline: DirectionResult;
  egressBaseline: DirectionResult;
};

export const BASELINE_DAYS = 7;
export const DAY_SECONDS = 86_400;

/**
 * Fetches everything the volume panel needs.
 *
 * The baseline window is fixed at 7 days regardless of the selected time range,
 * so "compared to the norm" always means the same thing.
 */
export async function fetchVolume(
  groupIds: string[],
  metrics: MetricNames,
  range: SeriesRequest,
  signal?: AbortSignal,
): Promise<VolumeFetch> {
  const baseline: SeriesRequest = {
    earliest: `-${BASELINE_DAYS}d`,
    latest: 'now',
    bucketSeconds: DAY_SECONDS,
  };

  const [ingress, egress, ingressBaseline, egressBaseline] = await Promise.all([
    fetchDirection(groupIds, metrics.inBytes, metrics.inputDim, metrics.groupDim, range, signal),
    fetchDirection(groupIds, metrics.outBytes, metrics.outputDim, metrics.groupDim, range, signal),
    fetchDirection(groupIds, metrics.inBytes, metrics.inputDim, metrics.groupDim, baseline, signal),
    fetchDirection(groupIds, metrics.outBytes, metrics.outputDim, metrics.groupDim, baseline, signal),
  ]);

  return { ingress, egress, ingressBaseline, egressBaseline };
}
