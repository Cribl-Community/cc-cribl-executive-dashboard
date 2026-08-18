/**
 * Multi-select filter built from Popover + Checkbox.
 *
 * Capra has no select component, so the pattern is a popover of checkboxes: it
 * scales to long inventories, shows every option's state at once, and keeps the
 * trigger label honest about how much is filtered out.
 */

import { Button, Checkbox, Popover, Text } from '@capra/core';
import { ChevronDown } from '@capra/icons';
import {
  isSelected,
  selectionSummary,
  toggleSelection,
  type Selection,
} from '../domain/filters.ts';

export type Option = {
  id: string;
  label: string;
  /** Secondary line, e.g. the Worker Group an entity belongs to. */
  description?: string;
};

type MultiSelectProps = {
  label: string;
  /** Plural noun for the summary label, e.g. `destinations`. */
  noun: string;
  options: Option[];
  selection: Selection;
  onChange: (selection: Selection) => void;
  disabled?: boolean;
};

export function MultiSelect({
  label,
  noun,
  options,
  selection,
  onChange,
  disabled = false,
}: MultiSelectProps) {
  const allIds = options.map((option) => option.id);
  const summary = selectionSummary(selection, options, noun);

  return (
    <div className="filter-bar-field">
      {/* The visible caption is decorative; the trigger carries the full accessible
          name so the popover button announces both the field and its state. */}
      <Text variant="body-sm-semibold" aria-hidden="true">
        {label}
      </Text>
      <Popover
        content={
          <div className="multiselect-panel">
            <div className="multiselect-actions">
              <Button size="sm" variant="tertiary" onClick={() => onChange('all')}>
                Select all
              </Button>
              <Button size="sm" variant="tertiary" onClick={() => onChange([])}>
                Clear
              </Button>
            </div>
            <div className="multiselect-options">
              {options.length === 0 ? (
                <Text variant="body-sm-normal" color="secondary">
                  Nothing to select yet.
                </Text>
              ) : (
                options.map((option) => (
                  <Checkbox
                    key={option.id}
                    checked={isSelected(selection, option.id)}
                    onChange={() => onChange(toggleSelection(selection, option.id, allIds))}
                  >
                    {option.description ? `${option.label} · ${option.description}` : option.label}
                  </Checkbox>
                ))
              )}
            </div>
          </div>
        }
      >
        <Button
          size="sm"
          variant="secondary"
          trailingIcon={ChevronDown}
          disabled={disabled || options.length === 0}
          aria-label={`${label}: ${summary}`}
        >
          {summary}
        </Button>
      </Popover>
    </div>
  );
}
