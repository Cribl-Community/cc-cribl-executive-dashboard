/**
 * Time range control: a fixed set of relative presets.
 *
 * Presets stay relative (`-7d`) so the dashboard keeps meaning "the last 7 days"
 * after a reload. There is no custom absolute range: the `cribl_metrics` dataset the
 * volume panel reads retains ~30 days, so every offered window is one the data can
 * answer, and an arbitrary date range could silently ask for data that is not there.
 */

import { Button, Menu, Text } from '@capra/core';
import { CalendarOutlined, ChevronDown } from '@capra/icons';
import { TIME_PRESETS } from '../domain/time.ts';
import type { Filters } from '../domain/filters.ts';

type TimeRangePickerProps = {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  /** Label of the active range, resolved by the caller so both agree. */
  activeLabel: string;
};

export function TimeRangePicker({ filters, onChange, activeLabel }: TimeRangePickerProps) {
  return (
    <div className="filter-bar-field">
      <Text variant="body-sm-semibold" aria-hidden="true">
        Time range
      </Text>
      <Menu
        trigger={
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={CalendarOutlined}
            trailingIcon={ChevronDown}
            aria-label={`Time range: ${activeLabel}`}
          >
            {activeLabel}
          </Button>
        }
      >
        {TIME_PRESETS.map((preset) => (
          <Menu.Item
            key={preset.id}
            as="button"
            label={preset.label}
            active={filters.timeRangeId === preset.id}
            onPress={() => onChange({ timeRangeId: preset.id })}
          />
        ))}
      </Menu>
    </div>
  );
}
