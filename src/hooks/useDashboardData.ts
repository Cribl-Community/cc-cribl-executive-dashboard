/**
 * Data loading for the whole dashboard.
 *
 * Two stages, because the second depends on the first: the deployment inventory
 * (groups and nodes) decides which Worker Groups to read, then everything
 * group-scoped is fanned out across them. Every fan-out keeps partial success —
 * one unreachable group degrades its own rows instead of blanking the dashboard.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  inputStatus,
  listGroups,
  listInputs,
  listOutputs,
  listWorkerNodes,
  outputStatus,
} from '../api/cribl.ts';
import { isAbort, perGroup } from '../api/criblFetch.ts';
import {
  DAY_SECONDS,
  fetchTotalSeries,
  fetchVolume,
  type MetricNames,
  type VolumeFetch,
} from '../api/metrics.ts';
import type { ConfigGroup, EntityConfig, EntityStatus, WorkerNode } from '../api/types.ts';
import { selectionSet, type Filters } from '../domain/filters.ts';
import type { Scoped } from '../domain/health.ts';
import { bucketSecondsFor, resolveBounds, type TimeRange } from '../domain/time.ts';

export type GroupError = { groupId: string; error: unknown };

export type Inventory = {
  groups: ConfigGroup[];
  workers: WorkerNode[];
  sources: Array<Scoped<EntityConfig>>;
  destinations: Array<Scoped<EntityConfig>>;
  sourceStatus: Array<Scoped<EntityStatus>>;
  destinationStatus: Array<Scoped<EntityStatus>>;
};

const EMPTY_INVENTORY: Inventory = {
  groups: [],
  workers: [],
  sources: [],
  destinations: [],
  sourceStatus: [],
  destinationStatus: [],
};

/** How far back to look for measured credit consumption. */
const CREDIT_WINDOW_DAYS = 90;

function flatten<T>(entries: Array<{ groupId: string; value: T[] }>): Array<Scoped<T>> {
  return entries.flatMap(({ groupId, value }) =>
    value.map((item) => ({ groupId, value: item })),
  );
}

export type DashboardData = {
  loading: boolean;
  /** Set only when nothing at all could be loaded. */
  error?: unknown;
  inventory: Inventory;
  volume?: VolumeFetch;
  /** Daily ingress bytes for the credit projection, across all selected groups. */
  creditSeries: Array<{ t: number; bytes: number }>;
  groupErrors: GroupError[];
  fetchedAt?: number;
  /** Resolved window of the active range, for axis extents and client-side maths. */
  bounds: { start: number; end: number };
  /** Worker Group ids the data covers, after the group filter. */
  selectedGroupIds: string[];
  refresh: () => void;
};

export function useDashboardData(
  filters: Filters,
  range: TimeRange,
  metricNames: MetricNames,
): DashboardData {
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  const [deployment, setDeployment] = useState<{ groups: ConfigGroup[]; workers: WorkerNode[] }>({
    groups: [],
    workers: [],
  });
  const [deploymentError, setDeploymentError] = useState<unknown>();
  const [deploymentLoading, setDeploymentLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setDeploymentLoading(true);
    (async () => {
      try {
        const [groups, workers] = await Promise.all([
          listGroups(controller.signal),
          listWorkerNodes(controller.signal),
        ]);
        setDeployment({ groups, workers });
        setDeploymentError(undefined);
      } catch (error) {
        if (!isAbort(error)) setDeploymentError(error);
      } finally {
        if (!controller.signal.aborted) setDeploymentLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refreshToken]);

  const allGroupIds = useMemo(
    () => deployment.groups.map((group) => group.id),
    [deployment.groups],
  );

  const selectedGroupIds = useMemo(
    () => [...selectionSet(filters.groups, allGroupIds)].filter((id) => allGroupIds.includes(id)),
    [filters.groups, allGroupIds],
  );

  /** Stable dependency key: the identity of the fan-out, not the array instance. */
  const groupKey = selectedGroupIds.join(',');
  const bounds = useMemo(() => resolveBounds(range), [range]);
  const rangeKey = `${range.earliest}|${range.latest}|${range.spanMs}`;
  const metricsKey = `${metricNames.inBytes}|${metricNames.outBytes}|${metricNames.inputDim}|${metricNames.outputDim}|${metricNames.groupDim}`;

  const [scoped, setScoped] = useState<{
    inventory: Inventory;
    volume?: VolumeFetch;
    creditSeries: Array<{ t: number; bytes: number }>;
    groupErrors: GroupError[];
    fetchedAt?: number;
  }>({ inventory: EMPTY_INVENTORY, creditSeries: [], groupErrors: [] });
  const [scopedLoading, setScopedLoading] = useState(true);

  useEffect(() => {
    const groupIds = groupKey ? groupKey.split(',') : [];
    if (groupIds.length === 0) {
      // Nothing group-scoped to read, but the deployment itself is still known —
      // keeping the groups and nodes means deselecting every Worker Group empties the
      // panels rather than the filters, so the selection can be undone without a
      // reload. Blanking them left the group dropdown with no options, and therefore
      // disabled, which was a dead end.
      setScoped({
        inventory: { ...EMPTY_INVENTORY, groups: deployment.groups, workers: deployment.workers },
        creditSeries: [],
        groupErrors: [],
      });
      setScopedLoading(false);
      return;
    }

    const controller = new AbortController();
    const signal = controller.signal;
    setScopedLoading(true);

    (async () => {
      try {
        const bucketSeconds = bucketSecondsFor(range.spanMs);
        const [sources, destinations, sourceStatus, destinationStatus, volume, credits] =
          await Promise.all([
            perGroup(groupIds, (groupId) => listInputs(groupId, signal)),
            perGroup(groupIds, (groupId) => listOutputs(groupId, signal)),
            perGroup(groupIds, (groupId) => inputStatus(groupId, signal)),
            perGroup(groupIds, (groupId) => outputStatus(groupId, signal)),
            fetchVolume(
              groupIds,
              metricNames,
              { earliest: range.earliest, latest: range.latest, bucketSeconds },
              signal,
            ),
            fetchTotalSeries(
              groupIds,
              metricNames.inBytes,
              metricNames.groupDim,
              {
                earliest: `-${CREDIT_WINDOW_DAYS}d`,
                latest: 'now',
                bucketSeconds: DAY_SECONDS,
              },
              signal,
            ),
          ]);

        if (signal.aborted) return;

        setScoped({
          inventory: {
            groups: deployment.groups,
            workers: deployment.workers,
            sources: flatten(sources.values),
            destinations: flatten(destinations.values),
            sourceStatus: flatten(sourceStatus.values),
            destinationStatus: flatten(destinationStatus.values),
          },
          volume,
          creditSeries: credits.points,
          groupErrors: [
            ...sources.errors,
            ...destinations.errors,
            ...sourceStatus.errors,
            ...destinationStatus.errors,
            ...volume.ingress.errors,
            ...volume.egress.errors,
            ...volume.ingressBaseline.errors,
            ...volume.egressBaseline.errors,
            ...credits.errors,
          ],
          fetchedAt: Date.now(),
        });
      } catch (error) {
        if (!isAbort(error)) setDeploymentError(error);
      } finally {
        if (!signal.aborted) setScopedLoading(false);
      }
    })();

    return () => controller.abort();
    // `groupKey`, `rangeKey`, and `metricsKey` stand in for the arrays and objects
    // they describe, so a re-render with equal contents does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey, rangeKey, metricsKey, refreshToken, deployment.groups, deployment.workers]);

  return {
    loading: deploymentLoading || scopedLoading,
    error: deploymentError,
    inventory: scoped.inventory,
    volume: scoped.volume,
    creditSeries: scoped.creditSeries,
    groupErrors: scoped.groupErrors,
    fetchedAt: scoped.fetchedAt,
    bounds,
    selectedGroupIds,
    refresh,
  };
}
