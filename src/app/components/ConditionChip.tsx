/**
 * ConditionChip component — renders a single condition from the versioned code set
 * Conditions have groups and optional values
 */

import React from 'react';
import { Chip } from './Chip.js';
import type { ConditionCode } from '../../shared/codes/condition.js';

interface ConditionChipProps {
  condition: ConditionCode;
  value?: string | string[];
  selected?: boolean;
  onSelect?: (condition: ConditionCode, value?: string) => void;
  onDeselect?: () => void;
  disabled?: boolean;
}

const groupStatusMap: Record<string, 'info' | 'neutral' | 'warning'> = {
  moisture: 'info',
  residue: 'neutral',
  crop: 'neutral',
  access: 'warning',
  soil: 'info',
};

export const ConditionChip: React.FC<ConditionChipProps> = ({
  condition,
  value,
  selected = false,
  onSelect,
  onDeselect,
  disabled = false,
}) => {
  const status = groupStatusMap[condition.group] || 'neutral';
  const displayValue = Array.isArray(value) ? value.join(', ') : value;
  const displayLabel = displayValue ? `${condition.displayLabel}: ${displayValue}` : condition.displayLabel;

  return (
    <Chip
      label={displayLabel}
      status={status}
      selected={selected}
      disabled={disabled || !condition.isActive}
      selectable={true}
      onClick={() => {
        if (selected) {
          onDeselect?.();
        } else {
          onSelect?.(condition, displayValue);
        }
      }}
    />
  );
};

ConditionChip.displayName = 'ConditionChip';
