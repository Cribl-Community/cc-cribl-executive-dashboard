/** Display formatting. Every number a reader sees passes through here. */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];

/** Bytes at 1024-scale, e.g. `4.2 GB`. Used for volume everywhere. */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes)) return '—';
  const sign = bytes < 0 ? '-' : '';
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = unit === 0 ? 0 : value >= 100 ? 0 : digits;
  return `${sign}${value.toFixed(precision)} ${BYTE_UNITS[unit]}`;
}

/** Bytes per second rendered as a rate, e.g. `12.4 MB/s`. */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Compact counts for stat tiles, e.g. `1,284` / `12.9K` / `4.2M`. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs < 10_000) return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  if (abs < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

/** A whole percentage, e.g. `98%`. Fractions are kept only below 1 decimal need. */
export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Signed percentage change, e.g. `+18%` / `-4%`. */
export function formatDelta(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return '—';
  const percent = fraction * 100;
  const sign = percent > 0 ? '+' : '';
  return `${sign}${percent.toFixed(digits)}%`;
}

export function formatCredits(credits: number): string {
  if (!Number.isFinite(credits)) return '—';
  const abs = Math.abs(credits);
  if (abs >= 1_000_000) return `${(credits / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(credits / 1_000).toFixed(1)}K`;
  return credits.toLocaleString('en-US', { maximumFractionDigits: abs < 100 ? 1 : 0 });
}

const ABSOLUTE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const SHORT_DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

const SHORT_TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** Absolute local timestamp, e.g. `Aug 10, 2026, 4:15 PM`. */
export function formatTimestamp(epochMs: number | undefined): string {
  if (!epochMs || !Number.isFinite(epochMs)) return 'Never';
  return ABSOLUTE_TIME.format(new Date(epochMs));
}

/** Axis tick label: date for multi-day ranges, clock time for shorter ones. */
export function formatAxisTime(epochMs: number, spanMs: number): string {
  const date = new Date(epochMs);
  return spanMs > 2 * 86_400_000 ? SHORT_DATE.format(date) : SHORT_TIME.format(date);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 1000],
  ['minute', 60_000],
  ['hour', 3_600_000],
  ['day', 86_400_000],
];

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** `4 minutes ago`, relative to `now`. Returns `Never` when there is no timestamp. */
export function formatRelative(epochMs: number | undefined, now = Date.now()): string {
  if (!epochMs || !Number.isFinite(epochMs)) return 'Never';
  const delta = epochMs - now;
  const abs = Math.abs(delta);
  let chosen: [Intl.RelativeTimeFormatUnit, number] = UNITS[0];
  for (const unit of UNITS) {
    if (abs >= unit[1]) chosen = unit;
  }
  return RELATIVE.format(Math.round(delta / chosen[1]), chosen[0]);
}

/** Duration in whole days, for term countdowns. */
export function formatDays(days: number): string {
  if (!Number.isFinite(days)) return '—';
  const whole = Math.max(0, Math.round(days));
  return `${whole} ${whole === 1 ? 'day' : 'days'}`;
}

/** `2026-08-10`, the form the date inputs in settings expect. */
export function toDateInputValue(epochMs: number): string {
  const date = new Date(epochMs);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Parses a `yyyy-mm-dd` input as local midnight. */
export function fromDateInputValue(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}
