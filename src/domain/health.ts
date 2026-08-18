/**
 * Health classification.
 *
 * The rule is deliberately strict, as specified: a source or destination counts
 * as connected only when *every* Worker Process reports Green. Anything else —
 * a single Yellow, a Red, or no status at all — is unhealthy. Partial health is
 * the case executives most need to see, so it is never rounded up to "fine".
 */

import type { EntityConfig, EntityStatus, Health, HealthCounts, WorkerNode } from '../api/types.ts';

export type EntityKind = 'source' | 'destination';

/** A value that belongs to one Worker Group. */
export type Scoped<T> = { groupId: string; value: T };

export type EntityHealth = {
  /** Stable key across groups: the same id can exist in several groups. */
  key: string;
  id: string;
  type?: string;
  kind: EntityKind;
  groupId: string;
  groupLabel: string;
  health: Health;
  /** True only when every Worker Process reports Green. */
  connected: boolean;
  counts: HealthCounts;
  /** Worker Processes reporting any status. Zero means nothing reported. */
  processes: number;
  greenProcesses: number;
  /** Last status update, Unix ms. Undefined when the entity never reported. */
  lastConnected?: number;
  /** Why it is unhealthy, when the API says. */
  message?: string;
  disabled: boolean;
  /** Configured but never reported a status — unhealthy, but for a different reason. */
  noStatus: boolean;
};

function sumCounts(counts: HealthCounts): number {
  let total = 0;
  for (const value of Object.values(counts)) {
    if (typeof value === 'number' && Number.isFinite(value)) total += value;
  }
  return total;
}

/** Applies the all-Green rule to one status tally. */
export function classifyCounts(counts: HealthCounts): {
  processes: number;
  greenProcesses: number;
  connected: boolean;
} {
  const processes = sumCounts(counts);
  const greenProcesses = counts.Green ?? 0;
  return { processes, greenProcesses, connected: processes > 0 && greenProcesses === processes };
}

function statusMessage(status: EntityStatus['status'] | undefined): string | undefined {
  const message = status?.error?.message;
  return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}

function entityKey(groupId: string, id: string): string {
  return `${groupId}::${id}`;
}

/**
 * Joins configured entities with their reported status.
 *
 * Both directions of the join matter: a configured entity with no status is
 * unhealthy (nothing is confirming it works), and a reporting entity with no
 * config still appears rather than being dropped — internal and system-managed
 * entities show up that way, and hiding them would understate the deployment.
 */
export function buildEntityHealth(
  kind: EntityKind,
  configs: Array<Scoped<EntityConfig>>,
  statuses: Array<Scoped<EntityStatus>>,
  groupLabels: Record<string, string>,
): EntityHealth[] {
  const statusByKey = new Map<string, Scoped<EntityStatus>>();
  for (const entry of statuses) {
    if (entry.value?.id) statusByKey.set(entityKey(entry.groupId, entry.value.id), entry);
  }

  const result: EntityHealth[] = [];
  const seen = new Set<string>();

  const push = (
    groupId: string,
    id: string,
    type: string | undefined,
    disabled: boolean,
    status: EntityStatus | undefined,
  ) => {
    const key = entityKey(groupId, id);
    if (seen.has(key)) return;
    seen.add(key);
    const counts = status?.status?.healthCounts ?? {};
    const { processes, greenProcesses, connected } = classifyCounts(counts);
    const noStatus = status === undefined || processes === 0;
    result.push({
      key,
      id,
      type: type ?? status?.type,
      kind,
      groupId,
      groupLabel: groupLabels[groupId] ?? groupId,
      health: status?.status?.health ?? 'Unknown',
      connected: disabled ? false : connected,
      counts,
      processes,
      greenProcesses,
      lastConnected: status?.status?.timestamp || undefined,
      message: statusMessage(status?.status),
      disabled,
      noStatus,
    });
  };

  for (const { groupId, value } of configs) {
    if (!value?.id) continue;
    const status = statusByKey.get(entityKey(groupId, value.id))?.value;
    push(groupId, value.id, value.type, value.disabled === true, status);
  }

  for (const { groupId, value } of statuses) {
    if (!value?.id) continue;
    push(groupId, value.id, value.type, false, value);
  }

  return result.sort((a, b) => a.id.localeCompare(b.id) || a.groupId.localeCompare(b.groupId));
}

export type HealthSummary = {
  /** Entities counted, i.e. after filters, exclusions, and disabled removal. */
  total: number;
  connected: number;
  disconnected: number;
  /** Share of counted entities that are fully healthy. NaN when nothing is counted. */
  healthyFraction: number;
  unhealthyFraction: number;
  /** Unhealthy entities, worst first, for the disconnected list. */
  disconnectedEntities: EntityHealth[];
  /** Excluded from the maths because they are disabled in config. */
  disabled: EntityHealth[];
  /**
   * Everything behind the percentage, worst first and disabled last: the drill-down
   * list. Same entities the maths used, so the list can always be reconciled with
   * the headline rather than being a second, differently-scoped query.
   */
  entities: EntityHealth[];
};

const HEALTH_RANK: Record<Health, number> = { Red: 0, Unknown: 1, Yellow: 2, Green: 3 };

/**
 * Rolls entities up to the headline percentages.
 *
 * Disabled entities are set aside rather than counted as unhealthy — an
 * intentionally switched-off source is not an outage — but they are still
 * reported so the count is auditable.
 */
/** Worst health first, then longest since a connection, then by name. */
function bySeverity(a: EntityHealth, b: EntityHealth): number {
  return (
    HEALTH_RANK[a.health] - HEALTH_RANK[b.health] ||
    (a.lastConnected ?? 0) - (b.lastConnected ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

export function summarizeHealth(entities: EntityHealth[]): HealthSummary {
  const disabled = entities.filter((entity) => entity.disabled);
  const counted = entities.filter((entity) => !entity.disabled);
  const connected = counted.filter((entity) => entity.connected).length;
  const total = counted.length;
  const disconnectedEntities = counted.filter((entity) => !entity.connected).sort(bySeverity);

  return {
    entities: [...[...counted].sort(bySeverity), ...[...disabled].sort(bySeverity)],
    total,
    connected,
    disconnected: total - connected,
    healthyFraction: total > 0 ? connected / total : Number.NaN,
    unhealthyFraction: total > 0 ? (total - connected) / total : Number.NaN,
    disconnectedEntities,
    disabled,
  };
}

export type SystemHealth = {
  id: string;
  groupId: string;
  groupLabel: string;
  /** What to call the node: its alias, else its hostname, else its id. */
  label: string;
  hostname?: string;
  version?: string;
  connected: boolean;
  processes: number;
  /** Last heartbeat the Leader received, Unix ms. */
  lastMessage?: number;
  status?: string;
};

const DISCONNECTED_STATUSES = new Set(['disconnected', 'offline', 'unhealthy', 'down']);

/**
 * A Worker Node is a healthy system when the Leader still has it connected.
 *
 * `nodeAliases` is resolved here rather than in each view, so the filter dropdown,
 * the drill-down, and the disconnected table cannot end up calling one node three
 * different things.
 */
export function buildSystemHealth(
  workers: WorkerNode[],
  groupLabels: Record<string, string>,
  nodeAliases: Record<string, string> = {},
): SystemHealth[] {
  return workers
    .map((worker) => {
      const status = worker.status?.toLowerCase();
      const connected = worker.disconnected !== true && !(status && DISCONNECTED_STATUSES.has(status));
      return {
        id: worker.id,
        groupId: worker.group,
        groupLabel: groupLabels[worker.group] ?? worker.group,
        label: nodeAliases[worker.id] ?? worker.info?.hostname ?? worker.id,
        hostname: worker.info?.hostname,
        version: worker.info?.cribl?.version,
        connected,
        processes: worker.workerProcesses ?? 0,
        lastMessage: worker.lastMsgTime || undefined,
        status: worker.status,
      };
    })
    .sort((a, b) => Number(a.connected) - Number(b.connected) || a.id.localeCompare(b.id));
}

/**
 * The identifiers the node's label does not already show, for a secondary line.
 *
 * Once an alias is set, both the hostname and the id are still worth printing —
 * anyone reconciling this dashboard against the Leader UI works from the id — while
 * with no alias the label already *is* one of them, so it is not repeated.
 */
export function systemIdentifiers(system: SystemHealth): string {
  const names = new Set<string>();
  for (const name of [system.hostname, system.id]) {
    if (name && name !== system.label) names.add(name);
  }
  return [...names].join(' · ');
}

export type SystemSummary = {
  total: number;
  connected: number;
  disconnected: number;
  healthyFraction: number;
  disconnectedSystems: SystemHealth[];
  /**
   * Every Worker Node behind the percentage, disconnected first: the drill-down list.
   * Same nodes the maths counted, so the list always reconciles with the headline.
   */
  systems: SystemHealth[];
};

export function summarizeSystems(systems: SystemHealth[]): SystemSummary {
  const connected = systems.filter((system) => system.connected).length;
  const total = systems.length;
  return {
    total,
    connected,
    disconnected: total - connected,
    healthyFraction: total > 0 ? connected / total : Number.NaN,
    disconnectedSystems: systems.filter((system) => !system.connected),
    systems,
  };
}

/** The most recent moment anything in the set reported, for "last connection time". */
export function latestContact(entities: Array<{ lastConnected?: number }>): number | undefined {
  let latest: number | undefined;
  for (const entity of entities) {
    if (entity.lastConnected && (latest === undefined || entity.lastConnected > latest)) {
      latest = entity.lastConnected;
    }
  }
  return latest;
}
