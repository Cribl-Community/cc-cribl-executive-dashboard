/**
 * Diagnostics.
 *
 * The volume and credit numbers depend on specific internal metric and dimension
 * names, and a Worker Group can fail on its own without the rest noticing. This
 * panel is how an admin sees both: what actually failed, and what the live system
 * reports it can measure — so a wrong metric name is a lookup, not a guess.
 */

import { useState } from 'react';
import { Alert, Button, Card, Collapse, Text } from '@capra/core';
import { metricsEnum } from '../api/cribl.ts';
import { describeError, isAbort } from '../api/criblFetch.ts';
import { sampleQueries, type MetricNames, type QuerySample } from '../api/metrics.ts';
import { DataTable } from '../components/DataTable.tsx';
import { formatBytes, formatCount, formatTimestamp } from '../domain/format.ts';
import type { GroupError } from '../hooks/useDashboardData.ts';

type EnumRow = { name: string; dims: Array<{ name: string; count: number; values: string[] }> };

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
   * Volume arrived without the Worker Group dimension, so it covers the whole
   * deployment. Worth saying out loud: the group filter looks like it works.
   */
  volumeUnattributed: boolean;
};

/**
 * One row per distinct failure, with a count.
 *
 * The four volume queries and the credit query are one request each against the
 * Leader, so a single outage repeats the same message five times; collapsing them
 * keeps the cause readable instead of burying it in duplicates.
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
  const [rows, setRows] = useState<EnumRow[]>();
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string>();
  const [sampled, setSampled] = useState<QuerySample[]>();
  const [byteMetrics, setByteMetrics] = useState<EnumRow[]>();
  const [sampling, setSampling] = useState(false);
  const [sampleError, setSampleError] = useState<string>();

  // Read-only, and only on an explicit press: no probe fires on load.
  const probe = async () => {
    setProbing(true);
    setProbeError(undefined);
    try {
      const response = await metricsEnum({ maxValues: 20 });
      setRows(response.items ?? []);
    } catch (error) {
      if (!isAbort(error)) setProbeError(describeError(error));
    } finally {
      setProbing(false);
    }
  };

  /**
   * The sweep over one hour in 15-minute buckets — enough rows to read, small
   * enough to be cheap — plus every byte-shaped metric this Leader reports, so a
   * name mismatch and an empty metrics store are told apart in one press.
   */
  const sample = async () => {
    setSampling(true);
    setSampleError(undefined);
    try {
      const [samples, names] = await Promise.all([
        sampleQueries(metricNames.inBytes, metricNames.inputDim, metricNames.groupDim, {
          earliest: '-1h',
          latest: 'now',
          bucketSeconds: 900,
        }),
        metricsEnum({ metricNameFilter: 'bytes', maxValues: 8 }).catch(() => undefined),
      ]);
      setSampled(samples);
      setByteMetrics(names?.items ?? []);
    } catch (error) {
      if (!isAbort(error)) setSampleError(describeError(error));
    } finally {
      setSampling(false);
    }
  };

  const failures = summarizeErrors(groupErrors);
  const expectedNames = [metricNames.inBytes, metricNames.outBytes];
  const reported = new Set(rows?.map((row) => row.name));
  const missing = rows ? expectedNames.filter((name) => !reported.has(name)) : [];
  const reportedDims = new Set(rows?.flatMap((row) => row.dims.map((dim) => dim.name)));
  const groupDimMissing = rows !== undefined && !reportedDims.has(metricNames.groupDim);

  /** The first variant that produced a usable number, and the rows worth showing. */
  const productive = sampled?.find((entry) => entry.parsed.bytes > 0);
  const anyRows = sampled?.some((entry) => entry.rowCount > 0) === true;
  const shown = productive ?? sampled?.find((entry) => entry.rowCount > 0);

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
                    // An empty group id belongs to a Leader-level read, which has no
                    // one Worker Group to name.
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
                {`Metrics reported no ${metricNames.groupDim} dimension, so volume and credits could not be attributed to a Worker Group and cover the whole deployment. The Worker Group filter still applies to health. Probe below for the dimension this deployment uses, then set it in settings.`}
              </Alert>
            )}

            {unresolvedDimValues.length > 0 && (
              <Collapse title={`${unresolvedDimValues.length} unmatched metric dimension value(s)`}>
                <Text variant="body-sm-normal" color="secondary">
                  These values were reported by metrics but matched no configured source or
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
          <Card.Title>Reported metrics</Card.Title>
          <Card.Description>
            Volume is read from <code>{metricNames.inBytes}</code> and{' '}
            <code>{metricNames.outBytes}</code>, split by <code>{metricNames.inputDim}</code>,{' '}
            <code>{metricNames.outputDim}</code>, and <code>{metricNames.groupDim}</code> for the
            Worker Group. Probe this Leader to confirm those names exist here, and change them in
            settings if they do not.
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <div className="card-body">
            <div className="multiselect-actions">
              <Button variant="secondary" size="sm" onClick={probe} pending={probing}>
                Probe reported metrics
              </Button>
              <Button variant="secondary" size="sm" onClick={sample} pending={sampling}>
                Run one ingress query
              </Button>
            </div>

            {probeError && (
              <Alert appearance="danger" title="Could not read metric names">
                {probeError}
              </Alert>
            )}

            {missing.length > 0 && (
              <Alert appearance="warning" title="Expected metric not reported">
                {`${missing.join(', ')} did not appear in this deployment's metrics. Volume figures will read zero until the metric name is corrected in settings.`}
              </Alert>
            )}

            {groupDimMissing && (
              <Alert appearance="warning" title="Worker Group dimension not reported">
                {`No metric reported a ${metricNames.groupDim} dimension. Volume and credits will cover the whole deployment rather than the selected Worker Groups; pick the right dimension from the table below and set it in settings.`}
              </Alert>
            )}

            {rows && (
              <DataTable
                caption="Metric names reported by this Leader, with their dimensions"
                columns={[
                  { key: 'metric', label: 'Metric' },
                  { key: 'dims', label: 'Dimensions' },
                  { key: 'values', label: 'Example values' },
                ]}
                rows={rows.map((row) => ({
                  id: row.name,
                  cells: [
                    <Text key="metric" variant="body-sm-normal">
                      {row.name}
                    </Text>,
                    <Text key="dims" variant="body-sm-normal" color="secondary">
                      {row.dims.map((dim) => `${dim.name} (${formatCount(dim.count)})`).join(', ') ||
                        '—'}
                    </Text>,
                    <Text key="values" variant="body-xs-normal" color="secondary">
                      {row.dims.flatMap((dim) => dim.values).slice(0, 6).join(', ') || '—'}
                    </Text>,
                  ],
                }))}
                emptyMessage="This Worker Group reported no metrics."
              />
            )}

            {sampleError && (
              <Alert appearance="danger" title="Could not run the ingress query">
                {sampleError}
              </Alert>
            )}

            {sampled && (
              <>
                {/* The verdict first: which cause of zero this deployment has. */}
                {productive ? (
                  <Alert appearance="success" title={`Data came back: ${productive.label.toLowerCase()}`}>
                    {`${formatCount(productive.rowCount)} rows read as ${formatBytes(productive.parsed.bytes)} over the last hour.${
                      productive === sampled[0]
                        ? ''
                        : ' The dashboard’s own query returned nothing, so this variant is the difference that matters — see the table below.'
                    }`}
                  </Alert>
                ) : anyRows ? (
                  <Alert appearance="warning" title="Rows returned, but no value was read">
                    Rows came back and none carried a number this dashboard could read as bytes.
                    Compare the field names in the verbatim rows below against the aggregation in
                    the request.
                  </Alert>
                ) : (
                  <Alert appearance="warning" title="Every variant returned no rows">
                    {`${metricNames.inBytes} reported nothing over the last hour under any variant. Either that is not this deployment's name for ingress bytes — check the list below — or the Leader's metrics store holds no ingest for it.`}
                  </Alert>
                )}

                <DataTable
                  caption="Read-only variants of the ingress query, and what each returned"
                  columns={[
                    { key: 'variant', label: 'Variant' },
                    { key: 'rows', label: 'Rows', numeric: true },
                    { key: 'read', label: 'Read as', numeric: true },
                    { key: 'fields', label: 'Row fields' },
                  ]}
                  rows={sampled.map((entry) => ({
                    id: entry.label,
                    cells: [
                      <Text key="variant" variant="body-sm-normal">
                        {entry.label}
                      </Text>,
                      entry.error ? '—' : formatCount(entry.rowCount),
                      entry.error ? '—' : formatBytes(entry.parsed.bytes),
                      <Text key="fields" variant="body-xs-normal" color="secondary">
                        {entry.error ?? (Object.keys(entry.rows[0] ?? {}).join(', ') || '—')}
                      </Text>,
                    ],
                  }))}
                  emptyMessage="No variants ran."
                />

                {byteMetrics && byteMetrics.length > 0 && (
                  <Collapse title={`${byteMetrics.length} byte metric(s) reported by this Leader`}>
                    <ul className="diagnostics-list">
                      {byteMetrics.map((row) => (
                        <li key={row.name}>
                          <Text variant="body-sm-normal">
                            {`${row.name} — ${row.dims.map((dim) => dim.name).join(', ') || 'no dimensions'}`}
                          </Text>
                        </li>
                      ))}
                    </ul>
                  </Collapse>
                )}

                <Text variant="body-sm-semibold">Request sent, as the dashboard queries it</Text>
                <pre className="diagnostics-code">
                  {JSON.stringify(sampled[0].request, null, 2)}
                </pre>

                <Text variant="body-sm-semibold">
                  {`Rows from “${(shown ?? sampled[0]).label}”, verbatim`}
                </Text>
                <pre className="diagnostics-code">
                  {JSON.stringify((shown ?? sampled[0]).rows, null, 2)}
                </pre>
              </>
            )}
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}
