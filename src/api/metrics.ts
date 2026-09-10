/**
 * Volume metrics transport and parsing.
 *
 * Everything the volume panel needs comes from four aggregation queries: ingress
 * and egress over the selected range, and the same two over a fixed 7-day window
 * for the baseline. Each is a Cribl Search query against the `cribl_metrics`
 * dataset, split by entity *and* by Worker Group — the dataset is deployment-wide,
 * so attribution comes from a field in the results, not from a `/m/:gid` URL. All
 * filtering, roll-up, and exclusion happens client-side, so the headline chart and
 * the per-entity table can never disagree about which sources are counted.
 *
 * `cribl_metrics` is read instead of the live `/system/metrics/query` store because
 * that store only retains ~2 days; the dataset holds ~30, which is what the time
 * picker now offers.
 */

import { describeError, isAbort } from './criblFetch.ts';
import { cachedSearch } from './searchCache.ts';
import { runSearchDetailed, type SearchRow } from './search.ts';

/**
 * Metric and dimension names as reported in `cribl_metrics`. These are overridable
 * in settings because a deployment can rename or namespace them, and the diagnostics
 * panel runs a live query so the actual field names can be read rather than guessed.
 */
export type MetricNames = {
  inBytes: string;
  outBytes: string;
  inputDim: string;
  outputDim: string;
  /** Field carrying the Worker Group each metric came from. */
  groupDim: string;
};

export const DEFAULT_METRIC_NAMES: MetricNames = {
  inBytes: 'total.in_bytes',
  outBytes: 'total.out_bytes',
  inputDim: 'input',
  outputDim: 'output',
  // Cribl Search exposes the Worker Group as `worker_group` (the live metrics store
  // used `__worker_group`); this is the `cribl_metrics` field name.
  groupDim: 'worker_group',
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
 * Builds the `cribl_metrics` aggregation query.
 *
 * The metric name is matched with `metric in ("…")`, the measure lives in the
 * `value` field, and the result is bucketed by time with `bin(_time, Ns)` and split
 * by the entity and Worker Group fields — the same split-bys the parser expects, so
 * a row reads exactly like a metrics-store event did.
 */
function buildQuery(
  metricName: string,
  dimension: string,
  groupDim: string,
  bucketSeconds: number,
): string {
  const by = [`_time=bin(_time, ${bucketSeconds}s)`, dimension, groupDim].filter(Boolean).join(', ');
  return `dataset="cribl_metrics" metric in ("${metricName}") | summarize ${VALUE_ALIAS}=sum(value) by ${by}`;
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
 * `_time` may arrive as Unix seconds, Unix milliseconds, or an ISO string depending
 * on how Search renders the bin, so all three are tolerated — a deployment that
 * reports one form should not silently render a chart in 1970.
 */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const raw = toNumber(value);
  if (raw <= 0) return undefined;
  return raw > 1e11 ? raw : raw * 1000;
}

/** A split-by value, or `''` when the field is absent from this row. */
function dimensionValue(event: SearchRow, dimension: string): string {
  if (!dimension) return '';
  const value = event[dimension];
  return typeof value === 'string' ? value : '';
}

/** Row fields that are metadata rather than the aggregated measure. */
const RESERVED_FIELDS = new Set(['_time', '_raw', '_metric', 'metric', 'starttime', 'endtime']);

/**
 * Reads the aggregated number out of a result row.
 *
 * The `bytes` alias is preferred, but not trusted: if a deployment returns the
 * column under another name, every figure on the page would read zero while every
 * request succeeded — the least diagnosable failure available. So fall back to the
 * row's only other number, skipping timestamps and the split-by fields.
 */
function aggregatedValue(event: SearchRow, splitBys: string[]): number {
  const aliased = event[VALUE_ALIAS];
  if (typeof aliased === 'number' || typeof aliased === 'string') return toNumber(aliased);
  for (const [field, value] of Object.entries(event)) {
    if (RESERVED_FIELDS.has(field) || splitBys.includes(field)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

function parseRows(events: SearchRow[] | undefined, dimension: string, groupDim: string): MetricRow[] {
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
 * Absolute milliseconds go on the wire because they cannot be misread; the relative
 * form stays in the UI layer, and is used only to key the cache, where "the last 7
 * days" should hit the same entry across loads even as the absolute window shifts.
 */
export function toAbsoluteMs(value: string | number, now: number): number {
  if (typeof value === 'number') return value;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'now') return now;
  const match = RELATIVE_PATTERN.exec(trimmed);
  if (match) return now - Number(match[1]) * RELATIVE_UNITS[match[2]];
  // Only this app's own presets reach here, so an unparsed value is a bug, not user
  // input; `now` keeps the request valid and the panel visibly empty.
  return now;
}

/**
 * Resolves a range endpoint to **Unix seconds**, the unit the Search jobs API reads
 * `earliest`/`latest` in. Sending milliseconds there is silently catastrophic: the
 * value is interpreted as seconds, so the window lands ~50,000 years out and the job
 * completes with zero rows — a success that looks exactly like an idle deployment.
 */
export function toEpochSeconds(value: string | number, now: number): number {
  return Math.floor(toAbsoluteMs(value, now) / 1000);
}

/**
 * One query: byte totals bucketed over time, split by entity and Worker Group.
 *
 * The cache key is the query text plus the *relative* range, so an automatic reload
 * for the same range reuses the last scan; `force` (a manual refresh) skips the read
 * and re-scans.
 */
async function queryRows(
  metricName: string,
  dimension: string,
  groupDim: string,
  request: SeriesRequest,
  force: boolean,
  signal?: AbortSignal,
): Promise<MetricRow[]> {
  const query = buildQuery(metricName, dimension, groupDim, request.bucketSeconds);
  const now = Date.now();
  const cacheKey = `${query}|${request.earliest}|${request.latest}`;
  const rows = await cachedSearch(
    cacheKey,
    {
      query,
      earliest: toEpochSeconds(request.earliest, now),
      latest: toEpochSeconds(request.latest, now),
    },
    force,
    signal,
  );
  return parseRows(rows, dimension, groupDim);
}

/** A diagnostic run of one query, reported raw so field names can be read. */
export type SearchSample = {
  query: string;
  earliest: string | number;
  latest: string | number;
  rowCount: number;
  /** The first rows, verbatim, so field names can be read rather than inferred. */
  rows: SearchRow[];
  /**
   * The first results page exactly as it came off the wire (NDJSON), truncated. The
   * verbatim bytes are the ground truth when the parsed view is empty or surprising —
   * they show the real envelope, field names, and the job's echoed time window.
   */
  rawFirstPage: string;
  /** What this app made of the whole response. */
  parsed: { buckets: number; bytes: number; entities: string[]; groups: string[] };
  /** Wall-clock time the whole job took, submit to results. */
  elapsedMs: number;
  error?: string;
};

/** Cap the raw dump so a large first page cannot bloat the diagnostics view. */
const RAW_SAMPLE_LIMIT = 4000;

/**
 * Runs the real ingress query over a small window and reports what came back.
 *
 * An empty result and a success is the least diagnosable answer Search can give: a
 * wrong metric name, a wrong field name, and a genuinely idle deployment all look
 * identical from the panel. This runs the exact query the dashboard uses (bypassing
 * the cache) so an admin can read the verbatim rows and timing and tell them apart.
 */
export async function sampleSearch(
  metricName: string,
  dimension: string,
  groupDim: string,
  request: SeriesRequest,
  signal?: AbortSignal,
): Promise<SearchSample> {
  const query = buildQuery(metricName, dimension, groupDim, request.bucketSeconds);
  const now = Date.now();
  const started = Date.now();
  try {
    const { rows, rawFirstPage } = await runSearchDetailed(
      { query, earliest: toEpochSeconds(request.earliest, now), latest: toEpochSeconds(request.latest, now) },
      signal,
    );
    const parsed = parseRows(rows, dimension, groupDim);
    return {
      query,
      earliest: request.earliest,
      latest: request.latest,
      rowCount: rows.length,
      rows: rows.slice(0, 3),
      rawFirstPage: rawFirstPage.slice(0, RAW_SAMPLE_LIMIT),
      parsed: {
        buckets: new Set(parsed.map((row) => row.t)).size,
        bytes: parsed.reduce((sum, row) => sum + row.bytes, 0),
        entities: [...new Set(parsed.map((row) => row.dimValue).filter(Boolean))].slice(0, 12),
        groups: [...new Set(parsed.map((row) => row.groupId).filter(Boolean))],
      },
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return {
      query,
      earliest: request.earliest,
      latest: request.latest,
      rowCount: 0,
      rows: [],
      rawFirstPage: '',
      parsed: { buckets: 0, bytes: 0, entities: [], groups: [] },
      elapsedMs: Date.now() - started,
      error: describeError(error),
    };
  }
}

/** Per-group buckets for one direction, keeping partial success across groups. */
export type DirectionResult = {
  byGroup: Array<{ groupId: string; buckets: EntityBucket[] }>;
  /** A `groupId` of `''` means the one query failed, not one group's share of it. */
  errors: Array<{ groupId: string; error: unknown }>;
  /**
   * Results arrived, but none carried the Worker Group field: the figures are
   * deployment-wide and the Worker Group filter did not narrow them.
   */
  unattributed: boolean;
};

const EMPTY_DIRECTION: DirectionResult = { byGroup: [], errors: [], unattributed: false };

/**
 * Splits rows into the per-group shape the panels consume.
 *
 * Groups are filtered here rather than in the query: a server-side filter would
 * stake the entire figure on the group field being named exactly as configured,
 * whereas this way a wrong name costs the group *labels* and not the *volume*. So
 * when no row carries the field at all, everything is kept under an empty group id
 * and flagged `unattributed` — a deployment-wide total the panel can still show, and
 * diagnostics can explain.
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
  force: boolean,
  signal?: AbortSignal,
): Promise<DirectionResult> {
  try {
    const rows = await queryRows(metricName, dimension, groupDim, request, force, signal);
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
  force: boolean,
  signal?: AbortSignal,
): Promise<{ points: Array<{ t: number; bytes: number }>; errors: Array<{ groupId: string; error: unknown }> }> {
  let result: DirectionResult;
  try {
    const rows = await queryRows(metricName, '', groupDim, request, force, signal);
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
 * The baseline window is fixed at 7 days regardless of the selected time range, so
 * "compared to the norm" always means the same thing. `force` (a manual refresh)
 * re-scans every query instead of serving the cache.
 */
export async function fetchVolume(
  groupIds: string[],
  metrics: MetricNames,
  range: SeriesRequest,
  force: boolean,
  signal?: AbortSignal,
): Promise<VolumeFetch> {
  const baseline: SeriesRequest = {
    earliest: `-${BASELINE_DAYS}d`,
    latest: 'now',
    bucketSeconds: DAY_SECONDS,
  };

  const [ingress, egress, ingressBaseline, egressBaseline] = await Promise.all([
    fetchDirection(groupIds, metrics.inBytes, metrics.inputDim, metrics.groupDim, range, force, signal),
    fetchDirection(groupIds, metrics.outBytes, metrics.outputDim, metrics.groupDim, range, force, signal),
    fetchDirection(groupIds, metrics.inBytes, metrics.inputDim, metrics.groupDim, baseline, force, signal),
    fetchDirection(groupIds, metrics.outBytes, metrics.outputDim, metrics.groupDim, baseline, force, signal),
  ]);

  return { ingress, egress, ingressBaseline, egressBaseline };
}
