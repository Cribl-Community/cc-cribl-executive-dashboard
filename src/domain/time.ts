/**
 * Time range presets and bucketing.
 *
 * Ranges are stored as relative Cribl expressions (`-24h`) so a shared or
 * reloaded dashboard keeps meaning "the last 24 hours" rather than freezing a
 * past window. Custom ranges store absolute Unix ms.
 */

export type TimeRange = {
  id: string;
  label: string;
  /** Relative expression or Unix ms. */
  earliest: string | number;
  latest: string | number;
  /** Nominal span, used to pick bucket size and axis labels. */
  spanMs: number;
};

const HOUR = 3_600_000;
const DAY = 86_400_000;

export const TIME_PRESETS: TimeRange[] = [
  { id: '1h', label: 'Last hour', earliest: '-1h', latest: 'now', spanMs: HOUR },
  { id: '4h', label: 'Last 4 hours', earliest: '-4h', latest: 'now', spanMs: 4 * HOUR },
  { id: '24h', label: 'Last 24 hours', earliest: '-24h', latest: 'now', spanMs: DAY },
  { id: '7d', label: 'Last 7 days', earliest: '-7d', latest: 'now', spanMs: 7 * DAY },
  { id: '30d', label: 'Last 30 days', earliest: '-30d', latest: 'now', spanMs: 30 * DAY },
  { id: '90d', label: 'Last 90 days', earliest: '-90d', latest: 'now', spanMs: 90 * DAY },
];

export const DEFAULT_TIME_RANGE_ID = '24h';

export function findPreset(id: string): TimeRange {
  return TIME_PRESETS.find((preset) => preset.id === id) ?? TIME_PRESETS[2];
}

/** Builds a custom absolute range from two local dates (inclusive of the end day). */
export function customRange(startMs: number, endMs: number): TimeRange {
  const earliest = Math.min(startMs, endMs);
  const latest = Math.max(startMs, endMs) + DAY - 1;
  return {
    id: 'custom',
    label: 'Custom range',
    earliest,
    latest,
    spanMs: latest - earliest,
  };
}

/**
 * Picks a bucket size targeting roughly 60–120 points: dense enough to show
 * shape, sparse enough that each bucket still holds a meaningful sample.
 */
export function bucketSecondsFor(spanMs: number): number {
  const candidates = [60, 300, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400];
  const target = spanMs / 1000 / 90;
  for (const candidate of candidates) {
    if (candidate >= target) return candidate;
  }
  return candidates[candidates.length - 1];
}

/** Resolves a range to concrete bounds for client-side maths and axis extents. */
export function resolveBounds(range: TimeRange, now = Date.now()): { start: number; end: number } {
  const end = typeof range.latest === 'number' ? range.latest : now;
  const start = typeof range.earliest === 'number' ? range.earliest : end - range.spanMs;
  return { start, end };
}
