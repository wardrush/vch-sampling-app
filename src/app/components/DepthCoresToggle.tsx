/**
 * DepthCoresToggle component — toggle to reveal depth and core count exception fields
 * Part of the Capture screen (B9, wave 2)
 *
 * Schema: SAMPLE_POINT.depth_achieved_cm and cores_taken are nullable.
 * NULL means "per the spec" (normal case); non-NULL is an exception.
 * BCarbon confirmation (blocking pre-work) will determine exact validation rules.
 *
 * Design: a single "Different from spec?" affordance reveals two fields.
 * Unselected state costs the sampler zero taps (v02 §2).
 */

import React, { useState } from 'react';
import { Input } from './Input.js';
import { SPACING } from './tokens/index.js';

interface DepthCoresToggleProps {
  depthAchievedCm?: number | null;
  coresTaken?: number | null;
  specDepthTopCm?: number;
  specDepthBottomCm?: number;
  specCoresMin?: number;
  specCoresMax?: number;
  onDepthChange: (value: number | null) => void;
  onCoresChange: (value: number | null) => void;
  disabled?: boolean;
}

export const DepthCoresToggle: React.FC<DepthCoresToggleProps> = ({
  depthAchievedCm,
  coresTaken,
  specDepthTopCm = 0,
  specDepthBottomCm = 30,
  specCoresMin = 5,
  specCoresMax = 10,
  onDepthChange,
  onCoresChange,
  disabled = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(depthAchievedCm !== null || coresTaken !== null);

  const handleToggle = () => {
    if (!isExpanded) {
      // Expanding
      setIsExpanded(true);
    } else {
      // Collapsing — clear values
      setIsExpanded(false);
      onDepthChange(null);
      onCoresChange(null);
    }
  };

  const specText = `(spec: ${specDepthTopCm}–${specDepthBottomCm} cm, ${specCoresMin}–${specCoresMax} cores)`;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: SPACING.md,
      }}
    >
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        style={{
          background: 'none',
          border: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
          color: '#003f2f',
          fontSize: '14px',
          fontWeight: 600,
          textAlign: 'left',
          padding: SPACING.sm,
          margin: 0,
          opacity: disabled ? 0.6 : 1,
          textDecoration: 'underline',
          transition: 'opacity 150ms ease-in-out',
        }}
      >
        {isExpanded ? '✓ ' : '○ '} Different from spec?
      </button>

      {isExpanded && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: SPACING.md,
            paddingLeft: SPACING.lg,
            borderLeft: '2px solid #d4a574',
          }}
        >
          <div>
            <Input
              label="Depth achieved (cm)"
              type="number"
              value={depthAchievedCm ?? ''}
              onChange={(e) => {
                const val = e.target.value ? parseInt(e.target.value, 10) : null;
                onDepthChange(val);
              }}
              placeholder="e.g., 28"
              hint={specText}
              disabled={disabled}
            />
          </div>

          <div>
            <Input
              label="Cores taken"
              type="number"
              value={coresTaken ?? ''}
              onChange={(e) => {
                const val = e.target.value ? parseInt(e.target.value, 10) : null;
                onCoresChange(val);
              }}
              placeholder={`e.g., ${specCoresMin}-${specCoresMax}`}
              hint={specText}
              disabled={disabled}
            />
          </div>
        </div>
      )}
    </div>
  );
};

DepthCoresToggle.displayName = 'DepthCoresToggle';
