/**
 * A plain accessible table.
 *
 * Capra has no table component, so this is hand-built: a real `<table>` with a
 * caption and scoped headers, which is what screen readers and copy-paste both
 * want. Rows arrive pre-sorted by the domain layer (worst health first, largest
 * volume first) — that ordering is deliberate, so there is no column sorting to
 * accidentally destroy it.
 */

import type { ReactNode } from 'react';
import { Text } from '@capra/core';

export type Column = {
  key: string;
  label: string;
  /** Right-align and tabular-figure the column. Use for every number. */
  numeric?: boolean;
};

export type Row = {
  id: string;
  cells: ReactNode[];
};

type DataTableProps = {
  /** Describes the table for screen readers; shown only when `showCaption`. */
  caption: string;
  showCaption?: boolean;
  columns: Column[];
  rows: Row[];
  /** Shown in place of the body when there is nothing to list. */
  emptyMessage: string;
};

export function DataTable({
  caption,
  showCaption = false,
  columns,
  rows,
  emptyMessage,
}: DataTableProps) {
  if (rows.length === 0) {
    return (
      <div className="table-empty">
        <Text variant="body-sm-normal" color="secondary">
          {emptyMessage}
        </Text>
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table className="data-table">
        {/* Always a real caption: hidden visually when the surrounding card
            already names the table, but never removed from the accessibility tree. */}
        <caption className={showCaption ? 'data-table-caption' : 'visually-hidden'}>
          {caption}
        </caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.numeric ? 'cell--numeric' : undefined}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {row.cells.map((cell, index) => (
                <td
                  key={columns[index]?.key ?? index}
                  className={columns[index]?.numeric ? 'cell--numeric' : undefined}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
