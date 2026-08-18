/**
 * Time range control: relative presets plus an absolute custom range.
 *
 * Presets stay relative (`-24h`) so the dashboard keeps meaning "the last 24 hours"
 * after a reload; the custom range is the escape hatch for a specific window, and
 * only then do two date inputs appear.
 */

import { Button, Menu, Text } from '@capra/core';
import { CalendarOutlined, ChevronDown } from '@capra/icons';
import { fromDateInputValue, toDateInputValue } from '../domain/format.ts';
import { TIME_PRESETS } from '../domain/time.ts';
import type { Filters } from '../domain/filters.ts';

type TimeRangePickerProps = {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  /** Label of the active range, resolved by the caller so both agree. */
  activeLabel: string;
};

const DAY = 86_400_000;

export function TimeRangePicker({ filters, onChange, activeLabel }: TimeRangePickerProps) {
  const isCustom = filters.timeRangeId === 'custom';
  const start = filters.customStart ?? Date.now() - 7 * DAY;
  const end = filters.customEnd ?? Date.now();

  return (
    <>
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
          <Menu.Divider />
          <Menu.Item
            as="button"
            label="Custom range"
            active={isCustom}
            onPress={() =>
              onChange({
                timeRangeId: 'custom',
                customStart: filters.customStart ?? Date.now() - 7 * DAY,
                customEnd: filters.customEnd ?? Date.now(),
              })
            }
          />
        </Menu>
      </div>

      {isCustom && (
        <div className="filter-bar-field">
          <Text variant="body-sm-semibold" as="label" htmlFor="range-start">
            From
          </Text>
          <input
            id="range-start"
            className="date-input"
            type="date"
            value={toDateInputValue(start)}
            max={toDateInputValue(end)}
            onChange={(event) => {
              const parsed = fromDateInputValue(event.target.value);
              if (parsed !== undefined) onChange({ customStart: parsed });
            }}
          />
        </div>
      )}

      {isCustom && (
        <div className="filter-bar-field">
          <Text variant="body-sm-semibold" as="label" htmlFor="range-end">
            To
          </Text>
          <input
            id="range-end"
            className="date-input"
            type="date"
            value={toDateInputValue(end)}
            min={toDateInputValue(start)}
            onChange={(event) => {
              const parsed = fromDateInputValue(event.target.value);
              if (parsed !== undefined) onChange({ customEnd: parsed });
            }}
          />
        </div>
      )}
    </>
  );
}
