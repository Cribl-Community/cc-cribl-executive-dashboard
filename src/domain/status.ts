/** Mapping from measurements to the reserved status levels. */

export type StatusLevel = 'good' | 'warning' | 'critical' | 'neutral';

/**
 * Maps a share of healthy things to a status level.
 *
 * Only a fully healthy set reads as good, matching the strict connected rule: a
 * dashboard that shows green at 97% teaches people to ignore the last 3%.
 */
export function levelForHealthy(fraction: number): StatusLevel {
  if (!Number.isFinite(fraction)) return 'neutral';
  if (fraction >= 1) return 'good';
  if (fraction >= 0.9) return 'warning';
  return 'critical';
}
