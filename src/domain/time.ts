/**
 * Time range presets and bucketing.
 *
 * Ranges are stored as relative Cribl expressions (`-7d`) so a shared or reloaded
 * dashboard keeps meaning "the last 7 days" rather than freezing a past window.
 *
 * The range only goes back 30 days because that is how far the `cribl_metrics`
 * dataset the volume panel reads retains data; asking for more returns empty buckets
 * that look like an outage. There is deliberately no custom absolute range for the
 * same reason — every offered window is one the data can actually answer.
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

const DAY = 86_400_000;

export const TIME_PRESETS: TimeRange[] = [
  { id: '1d', label: 'Last 1 day', earliest: '-1d', latest: 'now', spanMs: DAY },
  { id: '7d', label: 'Last 7 days', earliest: '-7d', latest: 'now', spanMs: 7 * DAY },
  { id: '14d', label: 'Last 14 days', earliest: '-14d', latest: 'now', spanMs: 14 * DAY },
  { id: '30d', label: 'Last 30 days', earliest: '-30d', latest: 'now', spanMs: 30 * DAY },
];

export const DEFAULT_TIME_RANGE_ID = '7d';

export function findPreset(id: string): TimeRange {
  return TIME_PRESETS.find((preset) => preset.id === id) ?? TIME_PRESETS[1];
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
