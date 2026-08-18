/**
 * Dashboard settings, persisted in the app-scoped KV store.
 *
 * These are deployment-level decisions rather than per-view filters: what a
 * Worker Group is called in business terms, which noisy sources never count
 * toward health or volume, and the commercial terms the credit projection is
 * measured against. They persist across users, devices, and reloads.
 */

import { kvGet, kvSet } from '../api/kv.ts';
import { DEFAULT_METRIC_NAMES, type MetricNames } from '../api/metrics.ts';

export type CreditModel = {
  /** Total credits committed for the term. */
  committedCredits: number;
  /** Credits consumed per GB of ingress — the deployment's contracted rate. */
  creditsPerGb: number;
  /** Term start, Unix ms. */
  termStart: number;
  /** Term end, Unix ms. */
  termEnd: number;
};

export type DashboardSettings = {
  /** Worker Group id → executive-facing alias. */
  groupAliases: Record<string, string>;
  /**
   * Worker Node id → operator-facing alias. Node ids are generated (`w-4`,
   * `ip-10-0-3-17`), so an alias is often the only way to say which rack, region, or
   * tenant a node serves.
   */
  nodeAliases: Record<string, string>;
  /**
   * Source ids excluded from health and volume everywhere. Internal and test
   * sources otherwise dominate an executive view.
   */
  excludedSourceIds: string[];
  /** Destination ids excluded from health and volume everywhere. */
  excludedDestinationIds: string[];
  /**
   * Deviation from the 7-day baseline, as a fraction, past which a source or
   * destination is listed as above or below the norm.
   */
  deviationThreshold: number;
  creditModel: CreditModel;
  metricNames: MetricNames;
};

const DAY = 86_400_000;

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * Defaults chosen to be honest rather than flattering: no exclusions until an
 * admin picks them, and a credit model that reads as unconfigured (zero
 * commitment) so the panel prompts for real terms instead of inventing them.
 */
export function defaultSettings(): DashboardSettings {
  const termStart = startOfToday();
  return {
    groupAliases: {},
    nodeAliases: {},
    excludedSourceIds: [],
    excludedDestinationIds: [],
    deviationThreshold: 0.25,
    creditModel: {
      committedCredits: 0,
      creditsPerGb: 1,
      termStart,
      termEnd: termStart + 365 * DAY,
    },
    metricNames: { ...DEFAULT_METRIC_NAMES },
  };
}

const SETTINGS_KEY = 'settings/v1';

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function asAliasMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, alias] of Object.entries(value as Record<string, unknown>)) {
    if (typeof alias === 'string' && alias.trim()) result[key] = alias.trim();
  }
  return result;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Merges stored settings over the defaults, field by field.
 *
 * Anything malformed or from an older shape falls back to its default instead of
 * propagating `undefined` into the maths downstream.
 */
export function normalizeSettings(stored: unknown): DashboardSettings {
  const defaults = defaultSettings();
  if (typeof stored !== 'object' || stored === null) return defaults;
  const raw = stored as Partial<DashboardSettings>;
  const credit = (raw.creditModel ?? {}) as Partial<CreditModel>;
  const metrics = (raw.metricNames ?? {}) as Partial<MetricNames>;

  return {
    groupAliases: asAliasMap(raw.groupAliases) ?? defaults.groupAliases,
    nodeAliases: asAliasMap(raw.nodeAliases) ?? defaults.nodeAliases,
    excludedSourceIds: asStringArray(raw.excludedSourceIds) ?? defaults.excludedSourceIds,
    excludedDestinationIds:
      asStringArray(raw.excludedDestinationIds) ?? defaults.excludedDestinationIds,
    deviationThreshold: clampThreshold(
      asFiniteNumber(raw.deviationThreshold) ?? defaults.deviationThreshold,
    ),
    creditModel: {
      committedCredits: Math.max(0, asFiniteNumber(credit.committedCredits) ?? 0),
      creditsPerGb: Math.max(0, asFiniteNumber(credit.creditsPerGb) ?? 1),
      termStart: asFiniteNumber(credit.termStart) ?? defaults.creditModel.termStart,
      termEnd: asFiniteNumber(credit.termEnd) ?? defaults.creditModel.termEnd,
    },
    metricNames: {
      inBytes: metrics.inBytes?.trim() || defaults.metricNames.inBytes,
      outBytes: metrics.outBytes?.trim() || defaults.metricNames.outBytes,
      inputDim: metrics.inputDim?.trim() || defaults.metricNames.inputDim,
      outputDim: metrics.outputDim?.trim() || defaults.metricNames.outputDim,
      groupDim: metrics.groupDim?.trim() || defaults.metricNames.groupDim,
    },
  };
}

/** Keeps the deviation threshold in a range where the "above/below" list is useful. */
export function clampThreshold(value: number): number {
  return Math.min(2, Math.max(0.01, value));
}

export async function loadSettings(signal?: AbortSignal): Promise<DashboardSettings> {
  const stored = await kvGet<unknown>(SETTINGS_KEY, signal);
  return normalizeSettings(stored);
}

export async function saveSettings(
  settings: DashboardSettings,
  signal?: AbortSignal,
): Promise<void> {
  await kvSet(SETTINGS_KEY, settings, signal);
}

/** The alias if one is set, otherwise the group's own name, otherwise its id. */
export function groupLabel(
  groupId: string,
  aliases: Record<string, string>,
  name?: string,
): string {
  return aliases[groupId] ?? name ?? groupId;
}

/**
 * The alias if one is set, otherwise the node's hostname, otherwise its id.
 *
 * Same precedence as a Worker Group: a name someone chose beats a name the machine
 * reported, and the id is the last resort that always exists.
 */
export function nodeLabel(
  nodeId: string,
  aliases: Record<string, string>,
  hostname?: string,
): string {
  return aliases[nodeId] ?? hostname ?? nodeId;
}
