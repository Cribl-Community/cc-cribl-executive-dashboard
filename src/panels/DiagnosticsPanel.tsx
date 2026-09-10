/**
 * Diagnostics.
 *
 * The volume and credit numbers depend on the `cribl_metrics` dataset carrying the
 * expected metric and field names, and a Worker Group can fail on its own without
 * the rest noticing. This panel is how an admin sees both: what actually failed, and
 * what a live search returns — so a wrong metric or field name is a query away, not a
 * guess.
 */

import { useState } from 'react';
import { Alert, Button, Card, Collapse, Text } from '@capra/core';
import { describeError, isAbort } from '../api/criblFetch.ts';
import { sampleSearch, type MetricNames, type SearchSample } from '../api/metrics.ts';
import { DataTable } from '../components/DataTable.tsx';
import { formatBytes, formatCount, formatTimestamp } from '../domain/format.ts';
import type { GroupError } from '../hooks/useDashboardData.ts';

type DiagnosticsPanelProps = {
  groupErrors: GroupError[];
  /**
   * Why the saved settings could not be read, verbatim. The banner at the top of the
   * page only asks the reader to save; the cause belongs here, where an admin is
   * already looking at what failed.
   */
  settingsError?: string;
  groupLabels: Record<string, string>;
  metricNames: MetricNames;
  fetchedAt?: number;
  unresolvedDimValues: string[];
  /**
   * Volume arrived without the Worker Group field, so it covers the whole
   * deployment. Worth saying out loud: the group filter looks like it works.
   */
  volumeUnattributed: boolean;
};

/**
 * One row per distinct failure, with a count.
 *
 * The four volume queries and the credit query are one search each, so a single
 * outage repeats the same message five times; collapsing them keeps the cause
 * readable instead of burying it in duplicates.
 */
function summarizeErrors(
  groupErrors: GroupError[],
): Array<{ groupId: string; message: string; count: number }> {
  const byCause = new Map<string, { groupId: string; message: string; count: number }>();
  for (const entry of groupErrors) {
    const message = describeError(entry.error);
    const key = `${entry.groupId}::${message}`;
    const existing = byCause.get(key);
    if (existing) existing.count += 1;
    else byCause.set(key, { groupId: entry.groupId, message, count: 1 });
  }
  return [...byCause.values()];
}

export function DiagnosticsPanel({
  groupErrors,
  settingsError,
  groupLabels,
  metricNames,
  fetchedAt,
  unresolvedDimValues,
  volumeUnattributed,
}: DiagnosticsPanelProps) {
  const [sample, setSample] = useState<SearchSample>();
  const [sampling, setSampling] = useState(false);
  const [sampleError, setSampleError] = useState<string>();

  /**
   * Runs the exact ingress query the dashboard uses, over the last hour, straight
   * against `cribl_metrics` and bypassing the cache — so a name mismatch, an empty
   * dataset, and a slow job are told apart in one press. Read-only, and only on an
   * explicit press: no search fires on load.
   */
  const runSample = async () => {
    setSampling(true);
    setSampleError(undefined);
    try {
      const result = await sampleSearch(metricNames.inBytes, metricNames.inputDim, metricNames.groupDim, {
        earliest: '-1h',
        latest: 'now',
        bucketSeconds: 900,
      });
      setSample(result);
    } catch (error) {
      if (!isAbort(error)) setSampleError(describeError(error));
    } finally {
      setSampling(false);
    }
  };

  const failures = summarizeErrors(groupErrors);

  // The verdict on the sample: which cause of an empty chart this deployment has.
  const groupFieldMissing =
    sample !== undefined && !sample.error && sample.rowCount > 0 && sample.parsed.groups.length === 0;

  return (
    <div className="card-stack">
      <Card>
        <Card.Header>
          <Card.Title>Diagnostics</Card.Title>
          <Card.Description>
            Data last loaded {formatTimestamp(fetchedAt)}. Everything this dashboard reads is
            read-only.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="card-body">
            {failures.length === 0 ? (
              <Text variant="body-sm-normal" color="secondary">
                Every request succeeded for every Worker Group in scope.
              </Text>
            ) : (
              <>
                <Alert appearance="warning" title={`${groupErrors.length} request(s) failed`}>
                  The panels above show what did load. The figures covered by the requests below are
                  incomplete.
                </Alert>
                <DataTable
                  caption="Requests that failed, by scope"
                  columns={[
                    { key: 'scope', label: 'Scope' },
                    { key: 'error', label: 'Error' },
                    { key: 'count', label: 'Requests', numeric: true },
                  ]}
                  rows={failures.map((entry, index) => ({
                    id: `${entry.groupId}-${index}`,
                    // An empty group id belongs to a deployment-wide search, which has
                    // no one Worker Group to name.
                    cells: [
                      entry.groupId
                        ? (groupLabels[entry.groupId] ?? entry.groupId)
                        : 'Whole deployment',
                      <Text key="error" variant="body-sm-normal" color="secondary">
                        {entry.message}
                      </Text>,
                      String(entry.count),
                    ],
                  }))}
                  emptyMessage="No failures."
                />
              </>
            )}

            {settingsError && (
              <Alert appearance="warning" title="Saved settings could not be read">
                {`${settingsError} Defaults are in use — no aliases, no exclusions, and no credit terms — until settings are saved, which writes a fresh copy.`}
              </Alert>
            )}

            {volumeUnattributed && (
              <Alert appearance="info" title="Volume covers every Worker Group">
                {`Search returned no ${metricNames.groupDim} field, so volume and credits could not be attributed to a Worker Group and cover the whole deployment. The Worker Group filter still applies to health. Run the query below to see the fields cribl_metrics actually returns, then set the right one in settings.`}
              </Alert>
            )}

            {unresolvedDimValues.length > 0 && (
              <Collapse title={`${unresolvedDimValues.length} unmatched metric dimension value(s)`}>
                <Text variant="body-sm-normal" color="secondary">
                  These values came back from cribl_metrics but matched no configured source or
                  destination id. Their volume is still counted, under the raw value.
                </Text>
                <ul className="diagnostics-list">
                  {[...new Set(unresolvedDimValues)].map((value) => (
                    <li key={value}>
                      <Text variant="body-sm-normal">{value}</Text>
                    </li>
                  ))}
                </ul>
              </Collapse>
            )}
          </div>
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title>cribl_metrics search</Card.Title>
          <Card.Description>
            Volume is read from <code>{metricNames.inBytes}</code> and{' '}
            <code>{metricNames.outBytes}</code> in the <code>cribl_metrics</code> dataset, split by{' '}
            <code>{metricNames.inputDim}</code> / <code>{metricNames.outputDim}</code> and{' '}
            <code>{metricNames.groupDim}</code> for the Worker Group. Run the ingress query against
            the live dataset to confirm those names exist here, and change them in settings if they
            do not.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="card-body">
            <div className="multiselect-actions">
              <Button variant="secondary" size="sm" onClick={runSample} pending={sampling}>
                Run one ingress query
              </Button>
            </div>

            {sampleError && (
              <Alert appearance="danger" title="Could not run the ingress query">
                {sampleError}
              </Alert>
            )}

            {sample && (
              <>
                {sample.error ? (
                  <Alert appearance="danger" title="The search did not complete">
                    {sample.error}
                  </Alert>
                ) : sample.parsed.bytes > 0 ? (
                  <Alert appearance="success" title="Data came back">
                    {`${formatCount(sample.rowCount)} rows read as ${formatBytes(sample.parsed.bytes)} over the last hour, across ${formatCount(sample.parsed.groups.length)} Worker Group(s), in ${(sample.elapsedMs / 1000).toFixed(1)}s.`}
                  </Alert>
                ) : sample.rowCount > 0 ? (
                  <Alert appearance="warning" title="Rows returned, but no value was read">
                    Rows came back and none carried a number this dashboard could read as bytes.
                    Compare the field names in the verbatim rows below against the query.
                  </Alert>
                ) : (
                  <Alert appearance="warning" title="The search returned no rows">
                    {`${metricNames.inBytes} returned nothing over the last hour. Either that is not this deployment's name for ingress bytes — check the verbatim rows below — or cribl_metrics holds no ingest for it in that window.`}
                  </Alert>
                )}

                {groupFieldMissing && (
                  <Alert appearance="warning" title="Worker Group field not returned">
                    {`No row carried a ${metricNames.groupDim} field. Volume and credits will cover the whole deployment rather than the selected Worker Groups; pick the right field from the verbatim rows below and set it in settings.`}
                  </Alert>
                )}

                <Text variant="body-sm-semibold">Query sent, as the dashboard runs it</Text>
                <pre className="diagnostics-code">{sample.query}</pre>

                {sample.parsed.entities.length > 0 && (
                  <Text variant="body-sm-normal" color="secondary">
                    {`Entities seen: ${sample.parsed.entities.join(', ')}`}
                  </Text>
                )}

                <Text variant="body-sm-semibold">First rows, verbatim</Text>
                <pre className="diagnostics-code">{JSON.stringify(sample.rows, null, 2)}</pre>

                {sample.rawFirstPage && (
                  <>
                    <Text variant="body-sm-semibold">Raw results page, off the wire</Text>
                    <Text variant="body-sm-normal" color="secondary">
                      The results stream verbatim (NDJSON — one object per line). One line is the
                      job summary, which echoes the query and the resolved time window; the rest are
                      the rows. This is the ground truth when the parsed view looks empty.
                    </Text>
                    <pre className="diagnostics-code">{sample.rawFirstPage}</pre>
                  </>
                )}
              </>
            )}
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}
