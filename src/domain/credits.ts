/**
 * Credit utilization and end-of-term projection.
 *
 * Cribl exposes no credit or entitlement API, so consumption is *derived*: measured
 * ingest volume × the contracted credit rate, against a term recorded in settings.
 * Every number here is therefore an estimate from observed data, and the panel says
 * so — the alternative is a confident figure with nothing behind it.
 */

import type { CreditModel } from './settings.ts';
import type { SeriesPoint } from './volume.ts';

/** 1 GB as 1024³ bytes, matching how volume is displayed elsewhere in the app. */
export const BYTES_PER_GB = 1024 ** 3;

const DAY_MS = 86_400_000;

export function creditsForBytes(bytes: number, creditsPerGb: number): number {
  if (!Number.isFinite(bytes) || !Number.isFinite(creditsPerGb)) return 0;
  return (bytes / BYTES_PER_GB) * creditsPerGb;
}

/** One point on the utilization trendline. */
export type CreditPoint = {
  t: number;
  /** Cumulative credits consumed by this day. */
  cumulative: number;
  /** True for days extrapolated forward rather than measured. */
  projected: boolean;
};

export type CreditProjection = {
  /** Whether the model has enough configuration to mean anything. */
  configured: boolean;
  termStart: number;
  termEnd: number;
  termDays: number;
  daysElapsed: number;
  daysRemaining: number;
  committedCredits: number;
  /** Days of measured ingest the estimate rests on. */
  observedDays: number;
  /** Measured credits over the observed window. */
  observedCredits: number;
  /** Average credits per day over the observed window — the "current average". */
  currentAveragePerDay: number;
  /** Credits consumed term-to-date; measured where possible, else extrapolated. */
  consumedToDate: number;
  /** True when `consumedToDate` had to be extrapolated past the observed window. */
  consumedIsEstimated: boolean;
  /** Credits at term end if the current daily rate holds. */
  projectedTotal: number;
  /** Full-term average per day implied by the projection — the "projected average". */
  projectedAveragePerDay: number;
  /** Projected total as a share of the commitment. NaN when nothing is committed. */
  projectedUtilization: number;
  /** Share of the commitment already consumed. NaN when nothing is committed. */
  currentUtilization: number;
  /** Credits per day that would land exactly on the commitment at term end. */
  budgetPerDay: number;
  /** Positive means burning faster than the commitment allows. */
  paceDelta: number;
  /** Projected overage (positive) or headroom (negative) in credits. */
  projectedVariance: number;
  /** Cumulative measured line followed by the projected continuation. */
  trend: CreditPoint[];
  /** Straight line from 0 to the commitment across the term — the "on plan" pace. */
  pace: Array<{ t: number; credits: number }>;
};

function dayFloor(epochMs: number): number {
  const date = new Date(epochMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Projects credit utilization to the end of term.
 *
 * `dailyIngress` is measured ingest bytes bucketed by day, over whatever window
 * the metrics system could return. When that window starts after the term did,
 * term-to-date consumption is extrapolated backwards at the observed rate and
 * flagged as an estimate rather than presented as measured fact.
 */
export function projectCredits(
  model: CreditModel,
  dailyIngress: SeriesPoint[],
  now = Date.now(),
): CreditProjection {
  const termStart = model.termStart;
  const termEnd = Math.max(model.termEnd, termStart + DAY_MS);
  const termDays = Math.max((termEnd - termStart) / DAY_MS, 1);
  const daysElapsed = Math.min(Math.max((now - termStart) / DAY_MS, 0), termDays);
  const daysRemaining = Math.max(termDays - daysElapsed, 0);

  const measured = dailyIngress
    .filter((point) => Number.isFinite(point.t) && point.t <= now)
    .sort((a, b) => a.t - b.t);

  // The daily rate is measured over everything observed, including days that fall
  // before the term — more days is a better rate estimate.
  const observedCredits = measured.reduce(
    (sum, point) => sum + creditsForBytes(point.bytes, model.creditsPerGb),
    0,
  );
  const observedDays = measured.length;
  const currentAveragePerDay = observedDays > 0 ? observedCredits / observedDays : 0;

  // Term-to-date consumption, though, only counts days inside the term: ingest from
  // before the term started was billed against the previous one.
  const inTerm = measured.filter((point) => point.t >= termStart);
  const inTermCredits = inTerm.reduce(
    (sum, point) => sum + creditsForBytes(point.bytes, model.creditsPerGb),
    0,
  );

  // Whatever stretch of the term the metrics do not reach back to, priced at the
  // measured rate and flagged as extrapolated rather than presented as measured.
  const observedStart = inTerm.length > 0 ? inTerm[0].t : Math.min(now, termEnd);
  const daysBeforeObservation = Math.max((observedStart - termStart) / DAY_MS, 0);
  const consumedIsEstimated = daysBeforeObservation > 0.5;
  const consumedToDate = inTermCredits + daysBeforeObservation * currentAveragePerDay;

  const projectedTotal = consumedToDate + daysRemaining * currentAveragePerDay;
  const committedCredits = model.committedCredits;
  const configured = committedCredits > 0 && model.creditsPerGb > 0 && termEnd > termStart;

  const budgetPerDay = committedCredits > 0 ? committedCredits / termDays : Number.NaN;

  // Plotted over the term, so only in-term days are drawn; anything earlier would
  // fall outside the chart's domain.
  const trend: CreditPoint[] = [];
  let running = daysBeforeObservation * currentAveragePerDay;
  for (const point of inTerm) {
    running += creditsForBytes(point.bytes, model.creditsPerGb);
    trend.push({ t: point.t, cumulative: running, projected: false });
  }
  if (trend.length === 0) {
    trend.push({
      t: Math.min(Math.max(dayFloor(now), termStart), termEnd),
      cumulative: running,
      projected: false,
    });
  }

  // Extend to term end at the observed rate, one point per week so the line stays
  // readable over a multi-month term, always ending exactly on the term boundary.
  const lastMeasured = trend[trend.length - 1];
  const stepMs = Math.max(DAY_MS, Math.min(7 * DAY_MS, (termEnd - lastMeasured.t) / 12));
  for (let t = lastMeasured.t + stepMs; t < termEnd; t += stepMs) {
    const days = (t - lastMeasured.t) / DAY_MS;
    trend.push({
      t,
      cumulative: lastMeasured.cumulative + days * currentAveragePerDay,
      projected: true,
    });
  }
  if (termEnd > lastMeasured.t) {
    trend.push({ t: termEnd, cumulative: projectedTotal, projected: true });
  }

  return {
    configured,
    termStart,
    termEnd,
    termDays,
    daysElapsed,
    daysRemaining,
    committedCredits,
    observedDays,
    observedCredits,
    currentAveragePerDay,
    consumedToDate,
    consumedIsEstimated,
    projectedTotal,
    projectedAveragePerDay: projectedTotal / termDays,
    projectedUtilization: committedCredits > 0 ? projectedTotal / committedCredits : Number.NaN,
    currentUtilization: committedCredits > 0 ? consumedToDate / committedCredits : Number.NaN,
    budgetPerDay,
    paceDelta: committedCredits > 0 ? currentAveragePerDay - budgetPerDay : Number.NaN,
    projectedVariance: committedCredits > 0 ? projectedTotal - committedCredits : Number.NaN,
    trend,
    pace:
      committedCredits > 0
        ? [
            { t: termStart, credits: 0 },
            { t: termEnd, credits: committedCredits },
          ]
        : [],
  };
}
