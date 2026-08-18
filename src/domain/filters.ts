/**
 * Filter state.
 *
 * A selection is either the literal `'all'` or an explicit list. That distinction
 * matters: `'all'` keeps meaning "everything, including sources added tomorrow",
 * while an explicit list is a deliberate choice that should not silently grow. It
 * also makes "nothing selected" a real, visible state rather than a synonym for all.
 */

export type Selection = 'all' | string[];

export type Filters = {
  timeRangeId: string;
  /** Set only when `timeRangeId` is `custom`, as local-midnight Unix ms. */
  customStart?: number;
  customEnd?: number;
  groups: Selection;
  /**
   * Worker Nodes, inside the selected Worker Groups. Only node-level figures can
   * honour this — source and destination status is reported per Worker Group, not
   * per node — so it narrows the systems side of health and nothing else.
   */
  nodes: Selection;
  sources: Selection;
  destinations: Selection;
};

export const DEFAULT_FILTERS: Filters = {
  timeRangeId: '24h',
  groups: 'all',
  nodes: 'all',
  sources: 'all',
  destinations: 'all',
};

export function isSelected(selection: Selection, id: string): boolean {
  return selection === 'all' || selection.includes(id);
}

/**
 * Toggles one id.
 *
 * Toggling off from `'all'` materializes the full list minus that id; selecting
 * every option again collapses back to `'all'` so the filter resumes tracking
 * newly added entities.
 */
export function toggleSelection(selection: Selection, id: string, allIds: string[]): Selection {
  if (selection === 'all') return allIds.filter((candidate) => candidate !== id);
  if (selection.includes(id)) return selection.filter((candidate) => candidate !== id);
  const next = [...selection, id];
  return allIds.every((candidate) => next.includes(candidate)) ? 'all' : next;
}

/**
 * Drops ids that are no longer selectable.
 *
 * A dependent filter is only meaningful inside its parent's selection: once the
 * Worker Groups change, a Worker Node the dashboard no longer reads must not stay
 * selected. Survivors are kept so widening the scope does not discard a deliberate
 * choice; when none survive — or when all of the new scope is covered — the filter
 * returns to `'all'`, which reads as "everything now in scope" rather than the
 * empty state nobody asked for.
 */
export function narrowSelection(selection: Selection, inScope: string[]): Selection {
  if (selection === 'all') return 'all';
  const kept = selection.filter((id) => inScope.includes(id));
  return kept.length === 0 || kept.length === inScope.length ? 'all' : kept;
}

/** The concrete set to filter by. `'all'` resolves to every known id. */
export function selectionSet(selection: Selection, allIds: string[]): Set<string> {
  return new Set(selection === 'all' ? allIds : selection);
}

/** Button label for a multi-select, e.g. `All destinations` or `3 of 12 destinations`. */
export function selectionSummary(
  selection: Selection,
  options: Array<{ id: string; label: string }>,
  noun: string,
): string {
  if (selection === 'all') return `All ${noun}`;
  if (selection.length === 0) return `No ${noun} selected`;
  if (selection.length === 1) {
    const only = options.find((option) => option.id === selection[0]);
    return only?.label ?? selection[0];
  }
  return `${selection.length} of ${options.length} ${noun}`;
}
