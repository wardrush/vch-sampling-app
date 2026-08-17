/**
 * Deviation reasons — why a sample deviates from the plan
 * Source: SAMPLING_SCHEMA_v01.md §4.5, SAMPLING_APP_PLAN_v02.md §2 & §4
 *
 * Shown when a sample is recorded beyond spec thresholds.
 * A picker on the capture screen for offsets > warn_threshold.
 */

export interface DeviationReason {
  code: string;
  displayLabel: string;
  requiresNote?: boolean;
  requiresPhoto?: boolean;
  isSkipReason?: boolean;
  isActive: boolean;
}

export const DEVIATION_REASONS: Record<string, DeviationReason> = {
  // Spatial/positional deviations
  INACCESSIBLE: {
    code: 'INACCESSIBLE',
    displayLabel: 'Point inaccessible or blocked',
    requiresNote: true,
    isSkipReason: true,
    isActive: true,
  },
  UNSAFE: {
    code: 'UNSAFE',
    displayLabel: 'Point unsafe to access',
    requiresNote: true,
    isSkipReason: true,
    isActive: true,
  },
  BOUNDARY_ERROR: {
    code: 'BOUNDARY_ERROR',
    displayLabel: 'Boundary polygon error — point actually in field',
    requiresPhoto: true,
    isActive: true,
  },

  // Sampling refusals
  OWNER_REFUSAL: {
    code: 'OWNER_REFUSAL',
    displayLabel: 'Owner refused access',
    isSkipReason: true,
    isActive: true,
  },
  TENANT_REFUSAL: {
    code: 'TENANT_REFUSAL',
    displayLabel: 'Tenant or operator refused',
    isSkipReason: true,
    isActive: true,
  },
  NO_SUITABLE_LOCATION: {
    code: 'NO_SUITABLE_LOCATION',
    displayLabel: 'No suitable location within acceptable offset',
    isSkipReason: true,
    requiresNote: true,
    isActive: true,
  },

  // Depth/coring
  REFUSAL_AT_DEPTH: {
    code: 'REFUSAL_AT_DEPTH',
    displayLabel: 'Hit refusal layer before reaching target depth',
    requiresNote: true,
    isActive: true,
  },
  REACHED_SPEC_DEPTH: {
    code: 'REACHED_SPEC_DEPTH',
    displayLabel: 'Reached spec depth — actual recorded',
    isActive: true,
  },

  // Soil conditions
  WATER_TABLE_BLOCKED: {
    code: 'WATER_TABLE_BLOCKED',
    displayLabel: 'Water table above target depth',
    isActive: true,
  },
  FROZEN_GROUND: {
    code: 'FROZEN_GROUND',
    displayLabel: 'Ground frozen or seasonally hard',
    isSkipReason: true,
    isActive: true,
  },

  // Re-drilling or amendments
  RE_DRILLED: {
    code: 'RE_DRILLED',
    displayLabel: 'Re-drilled after initial refusal',
    requiresNote: false,
    isActive: true,
  },
  NEARBY_HOLE: {
    code: 'NEARBY_HOLE',
    displayLabel: 'Sampled nearby existing hole instead',
    requiresNote: true,
    isActive: true,
  },

  // Field conditions
  WEATHER_DELAY: {
    code: 'WEATHER_DELAY',
    displayLabel: 'Deferred due to weather',
    isSkipReason: true,
    isActive: true,
  },
  EQUIPMENT_FAILURE: {
    code: 'EQUIPMENT_FAILURE',
    displayLabel: 'Sampling equipment failure',
    isSkipReason: true,
    requiresNote: true,
    isActive: true,
  },

  // Generic
  OTHER: {
    code: 'OTHER',
    displayLabel: 'Other reason',
    requiresNote: true,
    isActive: true,
  },
};

/**
 * Skip-only reasons (isSkipReason: true)
 * These appear only on the "Skip" screen, not on the capture form.
 */
export const SKIP_ONLY_REASONS = Object.entries(DEVIATION_REASONS)
  .filter(([, reason]) => reason.isSkipReason)
  .reduce(
    (acc, [code, reason]) => {
      acc[code] = reason;
      return acc;
    },
    {} as Record<string, DeviationReason>,
  );

/**
 * Offset deviations (not skip reasons)
 * These appear on the capture form when offset > MAX_PLAN_OFFSET_M_WARN.
 */
export const OFFSET_REASONS = Object.entries(DEVIATION_REASONS)
  .filter(([, reason]) => !reason.isSkipReason)
  .reduce(
    (acc, [code, reason]) => {
      acc[code] = reason;
      return acc;
    },
    {} as Record<string, DeviationReason>,
  );
