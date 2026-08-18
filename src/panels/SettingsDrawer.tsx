/**
 * Settings drawer.
 *
 * Everything here is deployment-level and shared: Worker Group and Worker Node
 * aliases, the sources and destinations that never count, the commercial terms behind
 * the credit projection, and the metric names to use if this deployment differs.
 * Nothing is written until Save is pressed — the drawer edits a draft, never live
 * settings.
 */

import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Divider, Drawer, Text, TextField } from '@capra/core';
import type { Option } from '../components/MultiSelect.tsx';
import { fromDateInputValue, toDateInputValue } from '../domain/format.ts';
import { clampThreshold, type DashboardSettings } from '../domain/settings.ts';
import { DEFAULT_METRIC_NAMES } from '../api/metrics.ts';

/** Exclusions are stored as ids; a set keeps the checkbox list cheap to toggle. */
function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
}

type ExclusionListProps = {
  legend: string;
  description: string;
  options: Option[];
  excluded: string[];
  onToggle: (id: string) => void;
};

function ExclusionList({ legend, description, options, excluded, onToggle }: ExclusionListProps) {
  return (
    <fieldset className="settings-fieldset">
      <legend>
        <Text variant="body-sm-semibold">{legend}</Text>
      </legend>
      <Text variant="body-sm-normal" color="secondary">
        {description}
      </Text>
      {options.length === 0 ? (
        <Text variant="body-sm-normal" color="secondary">
          Nothing to exclude yet.
        </Text>
      ) : (
        <div className="multiselect-options">
          {options.map((option) => (
            <Checkbox
              key={option.id}
              checked={excluded.includes(option.id)}
              onChange={() => onToggle(option.id)}
            >
              {option.description ? `${option.label} · ${option.description}` : option.label}
            </Checkbox>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** One alias row: the field's caption, and the name used when the alias is blank. */
type AliasField = { id: string; label: string; placeholder: string; helperText?: string };

type AliasFieldsProps = {
  fields: AliasField[];
  aliases: Record<string, string>;
  onChange: (aliases: Record<string, string>) => void;
  emptyMessage: string;
};

/**
 * A text field per entity, editing one alias map.
 *
 * Blank deletes the entry rather than storing an empty string, so the map only ever
 * holds names somebody chose and the fallback stays whatever the API reported.
 */
function AliasFields({ fields, aliases, onChange, emptyMessage }: AliasFieldsProps) {
  if (fields.length === 0) {
    return (
      <Text variant="body-sm-normal" color="secondary">
        {emptyMessage}
      </Text>
    );
  }
  return (
    <>
      {fields.map((field) => (
        <TextField
          key={field.id}
          label={field.label}
          helperText={field.helperText}
          value={aliases[field.id] ?? ''}
          placeholder={field.placeholder}
          onChange={(value) => {
            const next = { ...aliases };
            if (value.trim()) next[field.id] = value;
            else delete next[field.id];
            onChange(next);
          }}
        />
      ))}
    </>
  );
}

type SettingsDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  settings: DashboardSettings;
  /** Saves and closes. Rejections surface as an error inside the drawer. */
  onSave: (settings: DashboardSettings) => Promise<void>;
  groups: Array<{ id: string; name?: string }>;
  /**
   * Every Worker Node in the deployment, not just the filtered ones: an alias is
   * configuration, so it must be editable without first filtering to that node.
   */
  nodes: Array<{ id: string; hostname?: string; groupLabel: string }>;
  sourceOptions: Option[];
  destinationOptions: Option[];
};

export function SettingsDrawer({
  isOpen,
  onClose,
  settings,
  onSave,
  groups,
  nodes,
  sourceOptions,
  destinationOptions,
}: SettingsDrawerProps) {
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  // Opening the drawer starts a fresh draft from whatever is currently saved, so an
  // abandoned edit never leaks into the next visit.
  useEffect(() => {
    if (isOpen) {
      setDraft(settings);
      setError(undefined);
    }
  }, [isOpen, settings]);

  const patch = (next: Partial<DashboardSettings>) => setDraft((current) => ({ ...current, ...next }));
  const patchCredit = (next: Partial<DashboardSettings['creditModel']>) =>
    setDraft((current) => ({ ...current, creditModel: { ...current.creditModel, ...next } }));
  const patchMetrics = (next: Partial<DashboardSettings['metricNames']>) =>
    setDraft((current) => ({ ...current, metricNames: { ...current.metricNames, ...next } }));

  const handleSave = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await onSave({ ...draft, deviationThreshold: clampThreshold(draft.deviationThreshold) });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      width={520}
      title="Dashboard settings"
      footer={
        <div className="settings-footer">
          <Button variant="tertiary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} pending={saving}>
            Save settings
          </Button>
        </div>
      }
    >
      <div className="settings-form">
        {error && (
          <Alert appearance="danger" title="Settings not saved">
            {error}
          </Alert>
        )}

        <Text variant="body-sm-normal" color="secondary">
          These settings are shared by everyone who opens the dashboard and are stored with the app,
          not in your browser.
        </Text>

        <section className="settings-section">
          <Text variant="body-md-semibold" as="h3">
            Worker Group aliases
          </Text>
          <Text variant="body-sm-normal" color="secondary">
            A business-facing name to show instead of the Worker Group id. Leave blank to use the
            group's own name.
          </Text>
          <AliasFields
            fields={groups.map((group) => ({
              id: group.id,
              label: group.name ? `${group.id} (${group.name})` : group.id,
              placeholder: group.name ?? group.id,
            }))}
            aliases={draft.groupAliases}
            onChange={(groupAliases) => patch({ groupAliases })}
            emptyMessage="No Worker Groups loaded."
          />
        </section>

        <Divider />

        <section className="settings-section">
          <Text variant="body-md-semibold" as="h3">
            Worker Node aliases
          </Text>
          <Text variant="body-sm-normal" color="secondary">
            A name to show instead of the Worker Node id, in the Worker Node filter and everywhere
            nodes are listed. Leave blank to use the hostname the node reports.
          </Text>
          <AliasFields
            fields={nodes.map((node) => ({
              id: node.id,
              label: node.hostname ? `${node.id} (${node.hostname})` : node.id,
              placeholder: node.hostname ?? node.id,
              helperText: node.groupLabel,
            }))}
            aliases={draft.nodeAliases}
            onChange={(nodeAliases) => patch({ nodeAliases })}
            emptyMessage="No Worker Nodes loaded."
          />
        </section>

        <Divider />

        <section className="settings-section">
          <Text variant="body-md-semibold" as="h3">
            Exclusions
          </Text>
          <ExclusionList
            legend="Excluded sources"
            description="Left out of health counts and volume totals everywhere except the credit estimate."
            options={sourceOptions}
            excluded={draft.excludedSourceIds}
            onToggle={(id) => patch({ excludedSourceIds: toggleId(draft.excludedSourceIds, id) })}
          />
          <ExclusionList
            legend="Excluded destinations"
            description="Left out of health counts and volume totals."
            options={destinationOptions}
            excluded={draft.excludedDestinationIds}
            onToggle={(id) =>
              patch({ excludedDestinationIds: toggleId(draft.excludedDestinationIds, id) })
            }
          />
        </section>

        <Divider />

        <section className="settings-section">
          <Text variant="body-md-semibold" as="h3">
            Volume threshold
          </Text>
          <TextField
            label="Deviation from the 7-day norm (%)"
            helperText="A source or destination is listed as above or below the norm past this much change. 1–200."
            type="number"
            min={1}
            max={200}
            value={Math.round(draft.deviationThreshold * 100)}
            onChange={(value) => {
              const percent = Number(value);
              if (Number.isFinite(percent)) patch({ deviationThreshold: percent / 100 });
            }}
          />
        </section>

        <Divider />

        <section className="settings-section">
          <Text variant="body-md-semibold" as="h3">
            Credit terms
          </Text>
          <Text variant="body-sm-normal" color="secondary">
            Cribl does not expose credits over the API, so utilization is estimated from measured
            ingest at the rate below.
          </Text>
          <div className="settings-row">
            <TextField
              label="Committed credits for the term"
              type="number"
              min={0}
              value={draft.creditModel.committedCredits}
              onChange={(value) => {
                const credits = Number(value);
                if (Number.isFinite(credits)) patchCredit({ committedCredits: Math.max(0, credits) });
              }}
            />
            <TextField
              label="Credits per GB ingested"
              type="number"
              min={0}
              step={0.01}
              value={draft.creditModel.creditsPerGb}
              onChange={(value) => {
                const rate = Number(value);
                if (Number.isFinite(rate)) patchCredit({ creditsPerGb: Math.max(0, rate) });
              }}
            />
          </div>
          <div className="settings-row">
            <div className="field">
              <Text variant="body-sm-semibold" as="label" htmlFor="settings-term-start">
                Term start
              </Text>
              <input
                id="settings-term-start"
                className="date-input"
                type="date"
                value={toDateInputValue(draft.creditModel.termStart)}
                onChange={(event) => {
                  const parsed = fromDateInputValue(event.target.value);
                  if (parsed !== undefined) patchCredit({ termStart: parsed });
                }}
              />
            </div>
            <div className="field">
              <Text variant="body-sm-semibold" as="label" htmlFor="settings-term-end">
                Term end
              </Text>
              <input
                id="settings-term-end"
                className="date-input"
                type="date"
                value={toDateInputValue(draft.creditModel.termEnd)}
                onChange={(event) => {
                  const parsed = fromDateInputValue(event.target.value);
                  if (parsed !== undefined) patchCredit({ termEnd: parsed });
                }}
              />
            </div>
          </div>
          {draft.creditModel.termEnd <= draft.creditModel.termStart && (
            <Alert appearance="warning" title="Term end is not after term start">
              The projection needs a term that runs forward in time.
            </Alert>
          )}
        </section>

        <Divider />

        <section className="settings-section">
          <Text variant="body-md-semibold" as="h3">
            Metric names
          </Text>
          <Text variant="body-sm-normal" color="secondary">
            Change these only if this deployment reports volume under different internal metric or
            dimension names. Blank restores the default.
          </Text>
          <div className="settings-row">
            <TextField
              label="Ingress bytes metric"
              value={draft.metricNames.inBytes}
              placeholder={DEFAULT_METRIC_NAMES.inBytes}
              onChange={(value) => patchMetrics({ inBytes: value || DEFAULT_METRIC_NAMES.inBytes })}
            />
            <TextField
              label="Egress bytes metric"
              value={draft.metricNames.outBytes}
              placeholder={DEFAULT_METRIC_NAMES.outBytes}
              onChange={(value) => patchMetrics({ outBytes: value || DEFAULT_METRIC_NAMES.outBytes })}
            />
            <TextField
              label="Source dimension"
              value={draft.metricNames.inputDim}
              placeholder={DEFAULT_METRIC_NAMES.inputDim}
              onChange={(value) => patchMetrics({ inputDim: value || DEFAULT_METRIC_NAMES.inputDim })}
            />
            <TextField
              label="Destination dimension"
              value={draft.metricNames.outputDim}
              placeholder={DEFAULT_METRIC_NAMES.outputDim}
              onChange={(value) =>
                patchMetrics({ outputDim: value || DEFAULT_METRIC_NAMES.outputDim })
              }
            />
            <TextField
              label="Worker Group dimension"
              value={draft.metricNames.groupDim}
              placeholder={DEFAULT_METRIC_NAMES.groupDim}
              helperText="Attributes volume to a Worker Group. If it is wrong, figures stay deployment-wide."
              onChange={(value) => patchMetrics({ groupDim: value || DEFAULT_METRIC_NAMES.groupDim })}
            />
          </div>
        </section>
      </div>
    </Drawer>
  );
}
