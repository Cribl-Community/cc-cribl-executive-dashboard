/**
 * Status as icon + label + color, never color alone.
 *
 * Status hues are reserved for state and never reused as a series color, so an
 * indicator here always means "this thing is in this condition".
 *
 * The two states that call for action — critical and warning — are drawn as a tinted
 * pill so they can be found by scanning rather than read row by row. Healthy and
 * neutral stay quiet: if every row wore a pill, none of them would stand out.
 */

import { Text } from '@capra/core';
import { CircleCheckFilled, CircleXFilled, Minus, WarningSolid } from '@capra/icons';
import type { StatusLevel } from '../domain/status.ts';

const ICONS = {
  good: CircleCheckFilled,
  warning: WarningSolid,
  critical: CircleXFilled,
  neutral: Minus,
} as const;

type StatusIndicatorProps = {
  level: StatusLevel;
  label: string;
  /** Hide the text label only where an adjacent cell already carries it. */
  labelHidden?: boolean;
};

const PILL_LEVELS = new Set<StatusLevel>(['critical', 'warning']);

export function StatusIndicator({ level, label, labelHidden = false }: StatusIndicatorProps) {
  const Icon = ICONS[level];
  const classNames = ['status-indicator'];
  if (PILL_LEVELS.has(level)) {
    classNames.push('status-indicator--pill', `status-indicator--${level}`);
  }
  return (
    <span className={classNames.join(' ')}>
      <span className={`status-icon status-icon--${level}`} aria-hidden={!labelHidden}>
        <Icon size="sm" aria-label={labelHidden ? label : undefined} />
      </span>
      {labelHidden ? (
        <span className="visually-hidden">{label}</span>
      ) : (
        <Text variant="body-sm-normal">{label}</Text>
      )}
    </span>
  );
}
