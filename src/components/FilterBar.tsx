/**
 * The filter row.
 *
 * One row above the charts, ordered the way the data narrows: time first, then
 * Worker Groups, then the Worker Nodes inside them, then the sources and
 * destinations. Every filter defaults to everything, so the first view is the whole
 * deployment.
 */

import { MultiSelect, type Option } from './MultiSelect.tsx';
import { TimeRangePicker } from './TimeRangePicker.tsx';
import type { Filters } from '../domain/filters.ts';

type FilterBarProps = {
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  activeRangeLabel: string;
  groupOptions: Option[];
  /** Only the nodes in the selected Worker Groups; the caller does that narrowing. */
  nodeOptions: Option[];
  sourceOptions: Option[];
  destinationOptions: Option[];
};

export function FilterBar({
  filters,
  onChange,
  activeRangeLabel,
  groupOptions,
  nodeOptions,
  sourceOptions,
  destinationOptions,
}: FilterBarProps) {
  return (
    <div className="filter-bar" role="group" aria-label="Dashboard filters">
      <TimeRangePicker filters={filters} onChange={onChange} activeLabel={activeRangeLabel} />
      <MultiSelect
        label="Worker Groups"
        noun="Worker Groups"
        options={groupOptions}
        selection={filters.groups}
        onChange={(groups) => onChange({ groups })}
      />
      {/* Sits beside its parent filter, and lists only what that parent leaves in
          scope: every node in the deployment while all Worker Groups are selected,
          and just that group's nodes once one is picked. */}
      <MultiSelect
        label="Worker Nodes"
        noun="Worker Nodes"
        options={nodeOptions}
        selection={filters.nodes}
        onChange={(nodes) => onChange({ nodes })}
      />
      <MultiSelect
        label="Sources"
        noun="sources"
        options={sourceOptions}
        selection={filters.sources}
        onChange={(sources) => onChange({ sources })}
      />
      <MultiSelect
        label="Destinations"
        noun="destinations"
        options={destinationOptions}
        selection={filters.destinations}
        onChange={(destinations) => onChange({ destinations })}
      />
    </div>
  );
}
