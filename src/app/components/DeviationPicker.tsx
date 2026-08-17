/**
 * DeviationPicker component — single-select picker for deviation reasons
 * Used on Capture and Skip screens when a sample deviates from the plan
 */

import React from 'react';
import { DeviationChip } from './DeviationChip.js';
import type { DeviationReason } from '../../shared/codes/deviation.js';

interface DeviationPickerProps {
  reasons: Record<string, DeviationReason>;
  selectedCode?: string;
  onSelect: (reason: DeviationReason) => void;
  onClear?: () => void;
  disabled?: boolean;
  label?: string;
}

export const DeviationPicker: React.FC<DeviationPickerProps> = ({
  reasons,
  selectedCode,
  onSelect,
  onClear,
  disabled = false,
  label = 'Select a reason',
}) => {
  const reasonsList = Object.values(reasons);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      {label && (
        <label
          style={{
            fontSize: '14px',
            fontWeight: 500,
            color: disabled ? '#999' : '#333',
          }}
        >
          {label}
        </label>
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}
      >
        {reasonsList.map((reason) => (
          <DeviationChip
            key={reason.code}
            reason={reason}
            selected={selectedCode === reason.code}
            onSelect={onSelect}
            onDeselect={onClear}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
};

DeviationPicker.displayName = 'DeviationPicker';
