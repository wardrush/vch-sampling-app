/**
 * DeviationChip component — renders a single deviation reason from the versioned code set
 * Used when a sample deviates from the plan
 */

import React from 'react';
import { Chip } from './Chip.js';
import type { DeviationReason } from '../../shared/codes/deviation.js';

interface DeviationChipProps {
  reason: DeviationReason;
  selected?: boolean;
  onSelect?: (reason: DeviationReason) => void;
  onDeselect?: () => void;
  disabled?: boolean;
}

const deviationStatusMap: Record<string, 'warning' | 'error' | 'neutral'> = {
  INACCESSIBLE: 'error',
  UNSAFE: 'error',
  BOUNDARY_ERROR: 'warning',
  OWNER_REFUSAL: 'error',
  TENANT_REFUSAL: 'error',
  NO_SUITABLE_LOCATION: 'warning',
  REFUSAL_AT_DEPTH: 'warning',
  REACHED_SPEC_DEPTH: 'neutral',
  WATER_TABLE_BLOCKED: 'warning',
  FROZEN_GROUND: 'error',
  RE_DRILLED: 'neutral',
  NEARBY_HOLE: 'warning',
  WEATHER_DELAY: 'neutral',
  EQUIPMENT_FAILURE: 'error',
  OTHER: 'neutral',
};

export const DeviationChip: React.FC<DeviationChipProps> = ({
  reason,
  selected = false,
  onSelect,
  onDeselect,
  disabled = false,
}) => {
  const status = deviationStatusMap[reason.code] || 'neutral';

  return (
    <Chip
      label={reason.displayLabel}
      status={status}
      selected={selected}
      disabled={disabled || !reason.isActive}
      selectable={true}
      onClick={() => {
        if (selected) {
          onDeselect?.();
        } else {
          onSelect?.(reason);
        }
      }}
    />
  );
};

DeviationChip.displayName = 'DeviationChip';
