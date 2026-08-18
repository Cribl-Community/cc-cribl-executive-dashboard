/**
 * Executive dashboard.
 *
 * One page, read top to bottom: filters, then health, then volume against the norm,
 * then credit utilization to end of term. Every panel is driven by the same filter
 * state and the same load, so no two numbers on the page can disagree.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Collapse, Spinner, Text } from '@capra/core';
import { Cog, ReloadOutlined } from '@capra/icons';
import { describeError, isAbort } from './api/criblFetch.ts';
import { DEFAULT_METRIC_NAMES } from './api/metrics.ts';
import { FilterBar } from './components/FilterBar.tsx';
import type { Option } from './components/MultiSelect.tsx';
import { projectCredits } from './domain/credits.ts';
import {
  DEFAULT_FILTERS,
  narrowSelection,
  selectionSet,
  type Filters,
  type Selection,
} from './domain/filters.ts';
import { formatTimestamp } from './domain/format.ts';
import {
  buildEntityHealth,
  buildSystemHealth,
  summarizeHealth,
  summarizeSystems,
} from './domain/health.ts';
import {
  defaultSettings,
  groupLabel,
  loadSettings,
  nodeLabel,
  saveSettings,
  type DashboardSettings,
} from './domain/settings.ts';
import { bucketSecondsFor, customRange, findPreset } from './domain/time.ts';
import { buildDirectionVolume } from './domain/volume.ts';
import { useDashboardData } from './hooks/useDashboardData.ts';
import { CreditsPanel } from './panels/CreditsPanel.tsx';
import { DiagnosticsPanel } from './panels/DiagnosticsPanel.tsx';
import { HealthPanel } from './panels/HealthPanel.tsx';
import { SettingsDrawer } from './panels/SettingsDrawer.tsx';
import { VolumePanel } from './panels/VolumePanel.tsx';

/** Days of measured ingest behind the credit estimate, matching the hook's window. */
const CREDIT_WINDOW_DAYS = 90;

/** One option per distinct id, annotated with the groups it appears in. */
function toOptions(entities: Array<{ id: string; groupLabel: string }>): Option[] {
  const byId = new Map<string, Set<string>>();
  for (const entity of entities) {
    const groups = byId.get(entity.id) ?? new Set<string>();
    groups.add(entity.groupLabel);
    byId.set(entity.id, groups);
  }
  return [...byId.entries()]
    .map(([id, groups]) => ({ id, label: id, description: [...groups].sort().join(', ') }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function App() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [settings, setSettings] = useState<DashboardSettings>(defaultSettings);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsError, setSettingsError] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        setSettings(await loadSettings(controller.signal));
        // A read that succeeds retracts an earlier failure, so a retried or
        // remounted load does not leave a stale warning above the dashboard.
        setSettingsError(undefined);
      } catch (error) {
        // Defaults are usable, so a failed read degrades rather than blocks.
        if (!isAbort(error)) setSettingsError(describeError(error));
      } finally {
        if (!controller.signal.aborted) setSettingsReady(true);
      }
    })();
    return () => controller.abort();
  }, []);

  const range = useMemo(() => {
    if (filters.timeRangeId === 'custom' && filters.customStart && filters.customEnd) {
      return customRange(filters.customStart, filters.customEnd);
    }
    return findPreset(filters.timeRangeId);
  }, [filters.timeRangeId, filters.customStart, filters.customEnd]);

  const metricNames = settingsReady ? settings.metricNames : DEFAULT_METRIC_NAMES;
  const data = useDashboardData(filters, range, metricNames);
  const { inventory, volume, bounds, selectedGroupIds } = data;

  // One timestamp for the whole render, so every relative time on the page agrees.
  const now = useMemo(() => data.fetchedAt ?? Date.now(), [data.fetchedAt]);

  const groupLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const group of inventory.groups) {
      labels[group.id] = groupLabel(group.id, settings.groupAliases, group.name);
    }
    return labels;
  }, [inventory.groups, settings.groupAliases]);

  const allSources = useMemo(
    () => buildEntityHealth('source', inventory.sources, inventory.sourceStatus, groupLabels),
    [inventory.sources, inventory.sourceStatus, groupLabels],
  );
  const allDestinations = useMemo(
    () =>
      buildEntityHealth('destination', inventory.destinations, inventory.destinationStatus, groupLabels),
    [inventory.destinations, inventory.destinationStatus, groupLabels],
  );

  const sourceOptions = useMemo(() => toOptions(allSources), [allSources]);
  const destinationOptions = useMemo(() => toOptions(allDestinations), [allDestinations]);

  const excludedSources = useMemo(
    () => new Set(settings.excludedSourceIds),
    [settings.excludedSourceIds],
  );
  const excludedDestinations = useMemo(
    () => new Set(settings.excludedDestinationIds),
    [settings.excludedDestinationIds],
  );

  const sourceHealth = useMemo(() => {
    const selected = selectionSet(
      filters.sources,
      sourceOptions.map((option) => option.id),
    );
    return summarizeHealth(
      allSources.filter(
        (entity) => selected.has(entity.id) && !excludedSources.has(entity.id),
      ),
    );
  }, [allSources, filters.sources, sourceOptions, excludedSources]);

  const destinationHealth = useMemo(() => {
    const selected = selectionSet(
      filters.destinations,
      destinationOptions.map((option) => option.id),
    );
    return summarizeHealth(
      allDestinations.filter(
        (entity) => selected.has(entity.id) && !excludedDestinations.has(entity.id),
      ),
    );
  }, [allDestinations, filters.destinations, destinationOptions, excludedDestinations]);

  /**
   * The Worker Nodes the Worker Group filter leaves in scope.
   *
   * `inventory.workers` is the whole deployment — the Leader reports nodes in one
   * call, not per group — so this is where the group filter is applied, and it is
   * both what the Worker Node dropdown offers and what the node filter chooses from.
   * Selecting every Worker Group therefore lists every node, with no special case.
   */
  const scopedWorkers = useMemo(() => {
    const inScope = new Set(selectedGroupIds);
    return inventory.workers.filter((worker) => inScope.has(worker.group));
  }, [inventory.workers, selectedGroupIds]);

  const nodeOptions = useMemo<Option[]>(
    () =>
      scopedWorkers
        .map((worker) => {
          // An alias, else the hostname an operator recognises. The id is what the API
          // and the Leader UI call the node, so it stays on the secondary line.
          const label = nodeLabel(worker.id, settings.nodeAliases, worker.info?.hostname);
          const group = groupLabels[worker.group] ?? worker.group;
          return {
            id: worker.id,
            label,
            description: label === worker.id ? group : `${group} · ${worker.id}`,
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    [scopedWorkers, groupLabels, settings.nodeAliases],
  );

  const systemSummary = useMemo(() => {
    const selected = selectionSet(
      filters.nodes,
      scopedWorkers.map((worker) => worker.id),
    );
    return summarizeSystems(
      buildSystemHealth(
        scopedWorkers.filter((worker) => selected.has(worker.id)),
        groupLabels,
        settings.nodeAliases,
      ),
    );
  }, [scopedWorkers, filters.nodes, groupLabels, settings.nodeAliases]);

  const allGroupIds = useMemo(() => inventory.groups.map((group) => group.id), [inventory.groups]);

  /**
   * The node ids a given Worker Group selection would leave in scope.
   *
   * `scopedWorkers` answers this for the selection currently in state; narrowing has
   * to ask about the selection being written, before it becomes state.
   */
  const nodesForGroups = useCallback(
    (groups: Selection) => {
      const scope = selectionSet(groups, allGroupIds);
      return inventory.workers
        .filter((worker) => scope.has(worker.group))
        .map((worker) => worker.id);
    },
    [inventory.workers, allGroupIds],
  );

  /**
   * Filter writes, with the one dependency between filters enforced here.
   *
   * The Worker Node selection is scoped by the Worker Groups, so a group change has
   * to re-check it: the nodes for the *new* group selection are what the old node
   * list is narrowed against, which is why this cannot be a plain state setter.
   */
  const patchFilters = useCallback(
    (patch: Partial<Filters>) =>
      setFilters((current) => {
        const next = { ...current, ...patch };
        if (patch.groups !== undefined) {
          next.nodes = narrowSelection(next.nodes, nodesForGroups(next.groups));
        }
        return next;
      }),
    [nodesForGroups],
  );

  const volumeView = useMemo(() => {
    if (!volume) return undefined;
    const spanMs = Math.max(bounds.end - bounds.start, 1);
    const bucketSeconds = bucketSecondsFor(range.spanMs);
    const common = { spanMs, bucketSeconds, threshold: settings.deviationThreshold };
    return {
      ingress: buildDirectionVolume(volume.ingress, volume.ingressBaseline, {
        ...common,
        knownIds: new Set(allSources.map((entity) => entity.id)),
        selectedIds: filters.sources === 'all' ? new Set<string>() : new Set(filters.sources),
        excludedIds: excludedSources,
      }),
      egress: buildDirectionVolume(volume.egress, volume.egressBaseline, {
        ...common,
        knownIds: new Set(allDestinations.map((entity) => entity.id)),
        selectedIds:
          filters.destinations === 'all' ? new Set<string>() : new Set(filters.destinations),
        excludedIds: excludedDestinations,
      }),
      spanMs,
    };
  }, [
    volume,
    bounds.start,
    bounds.end,
    range.spanMs,
    settings.deviationThreshold,
    allSources,
    allDestinations,
    filters.sources,
    filters.destinations,
    excludedSources,
    excludedDestinations,
  ]);

  const credits = useMemo(
    () => projectCredits(settings.creditModel, data.creditSeries, now),
    [settings.creditModel, data.creditSeries, now],
  );

  const groupOptions = useMemo(
    () =>
      inventory.groups.map((group) => ({
        id: group.id,
        label: groupLabels[group.id] ?? group.id,
        description: groupLabels[group.id] === group.id ? undefined : group.id,
      })),
    [inventory.groups, groupLabels],
  );

  const handleSaveSettings = useCallback(async (next: DashboardSettings) => {
    await saveSettings(next);
    setSettings(next);
    setSettingsError(undefined);
  }, []);

  const firstLoad = data.loading && !data.fetchedAt;

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="dashboard-header-text">
          <Text variant="heading-lg" as="h1">
            Executive dashboard
          </Text>
          <Text variant="body-sm-normal" color="secondary">
            {range.label} · {selectedGroupIds.length} Worker Group
            {selectedGroupIds.length === 1 ? '' : 's'} · updated {formatTimestamp(data.fetchedAt)}
          </Text>
        </div>
        <div className="dashboard-header-actions">
          {data.loading && <Spinner size="sm" />}
          <Button variant="secondary" leadingIcon={ReloadOutlined} onClick={data.refresh}>
            Refresh
          </Button>
          <Button variant="secondary" leadingIcon={Cog} onClick={() => setSettingsOpen(true)}>
            Settings
          </Button>
        </div>
      </header>

      <FilterBar
        filters={filters}
        onChange={patchFilters}
        activeRangeLabel={range.label}
        groupOptions={groupOptions}
        nodeOptions={nodeOptions}
        sourceOptions={sourceOptions}
        destinationOptions={destinationOptions}
      />

      {/*
        A failed settings read is, in practice, a deployment where nobody has saved
        yet — so the banner asks for the one action that fixes it rather than
        reporting a KV error to someone who cannot act on it. The verbatim failure
        still goes to diagnostics, where an admin looks for causes.
      */}
      {settingsError && (
        <Alert
          appearance="info"
          title="Save your settings to finish setting up"
          action={{ label: 'Open settings', onClick: () => setSettingsOpen(true) }}
        >
          Open Settings and save once to store your Worker Group and Worker Node aliases, source and
          destination exclusions, and credit terms. Until then the dashboard runs on defaults.
        </Alert>
      )}

      {data.error !== undefined && (
        <Alert
          appearance="danger"
          title="Could not load the deployment"
          action={{ label: 'Retry', onClick: data.refresh }}
        >
          {describeError(data.error)}
        </Alert>
      )}

      {!firstLoad && data.error === undefined && selectedGroupIds.length === 0 && (
        <Alert appearance="info" title="No Worker Groups in scope">
          {inventory.groups.length === 0
            ? 'This Leader reported no Worker Groups.'
            : 'Select at least one Worker Group to see health, volume, and credits.'}
        </Alert>
      )}

      {firstLoad ? (
        <div className="dashboard-loading">
          <Spinner />
          <Text variant="body-sm-normal" color="secondary">
            Loading the deployment…
          </Text>
        </div>
      ) : (
        <>
          <section className="section" aria-labelledby="section-health">
            <div className="section-heading">
              <Text variant="body-sm-semibold" as="h2" id="section-health">
                Health
              </Text>
            </div>
            <HealthPanel
              systems={systemSummary}
              sources={sourceHealth}
              destinations={destinationHealth}
              now={now}
            />
          </section>

          <section className="section" aria-labelledby="section-volume">
            <div className="section-heading">
              <Text variant="body-sm-semibold" as="h2" id="section-volume">
                Volume
              </Text>
            </div>
            {volumeView ? (
              <VolumePanel
                ingress={volumeView.ingress}
                egress={volumeView.egress}
                bounds={bounds}
                spanMs={volumeView.spanMs}
                groupLabels={groupLabels}
              />
            ) : (
              <Alert appearance="info" title="No volume metrics">
                Metrics returned nothing for this range. Probe the metric names in diagnostics below.
              </Alert>
            )}
          </section>

          <section className="section" aria-labelledby="section-credits">
            <div className="section-heading">
              <Text variant="body-sm-semibold" as="h2" id="section-credits">
                Credits
              </Text>
            </div>
            <CreditsPanel
              projection={credits}
              windowDays={CREDIT_WINDOW_DAYS}
              onConfigure={() => setSettingsOpen(true)}
            />
          </section>

          <Collapse title="Diagnostics">
            <DiagnosticsPanel
              groupErrors={data.groupErrors}
              settingsError={settingsError}
              groupLabels={groupLabels}
              metricNames={metricNames}
              fetchedAt={data.fetchedAt}
              volumeUnattributed={volume?.ingress.unattributed === true || volume?.egress.unattributed === true}
              unresolvedDimValues={[
                ...(volumeView?.ingress.unresolvedDimValues ?? []),
                ...(volumeView?.egress.unresolvedDimValues ?? []),
              ]}
            />
          </Collapse>
        </>
      )}

      <SettingsDrawer
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
        groups={inventory.groups.map((group) => ({ id: group.id, name: group.name }))}
        nodes={inventory.workers.map((worker) => ({
          id: worker.id,
          hostname: worker.info?.hostname,
          groupLabel: groupLabels[worker.group] ?? worker.group,
        }))}
        sourceOptions={sourceOptions}
        destinationOptions={destinationOptions}
      />
    </div>
  );
}

export default App;
