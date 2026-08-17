/**
 * Condition codes — site conditions recorded at the sample point
 * Source: SAMPLING_SCHEMA_v01.md §4.6, pushed to device as reference data
 *
 * Conditions are versioned and added to PROJECT_SAMPLING_SPEC, not hardcoded.
 * This file defines the structure; actual values are loaded from reference data.
 */

export type ConditionValueType = 'none' | 'band' | 'number' | 'text';
export type ConditionGroup = 'moisture' | 'residue' | 'crop' | 'access' | 'soil';

export interface ConditionCode {
  code: string;
  group: ConditionGroup;
  displayLabel: string;
  valueType: ConditionValueType;
  valueOptions?: string[];
  sortOrder: number;
  isActive: boolean;
}

/**
 * Template condition codes grouped by category.
 * Real values are loaded from REF.CONDITION_CODE per project/season.
 *
 * Examples from spec:
 *   - Residue cover percent band
 *   - Water depth band (for flooded areas)
 *   - Elevation class (A_high, B_low)
 */
export const CONDITION_GROUPS: Record<ConditionGroup, string> = {
  moisture: 'Soil moisture',
  residue: 'Residue or vegetation cover',
  crop: 'Crop or vegetation type',
  access: 'Access constraints',
  soil: 'Soil observation',
};

/**
 * These are examples/templates. Actual condition codes are config-driven.
 * The device receives them in the assignment bundle under each PROJECT_SAMPLING_SPEC.
 */
export const EXAMPLE_CONDITION_CODES: Record<string, ConditionCode> = {
  MOISTURE_WET: {
    code: 'MOISTURE_WET',
    group: 'moisture',
    displayLabel: 'Wet / flooded',
    valueType: 'none',
    sortOrder: 10,
    isActive: true,
  },
  MOISTURE_MOIST: {
    code: 'MOISTURE_MOIST',
    group: 'moisture',
    displayLabel: 'Moist',
    valueType: 'none',
    sortOrder: 20,
    isActive: true,
  },
  MOISTURE_DRY: {
    code: 'MOISTURE_DRY',
    group: 'moisture',
    displayLabel: 'Dry / drought',
    valueType: 'none',
    sortOrder: 30,
    isActive: true,
  },
  RESIDUE_COVER_PCT: {
    code: 'RESIDUE_COVER_PCT',
    group: 'residue',
    displayLabel: 'Residue cover percent',
    valueType: 'band',
    valueOptions: ['0-10%', '10-25%', '25-50%', '50-75%', '75-90%', '90-100%'],
    sortOrder: 10,
    isActive: true,
  },
  WATER_DEPTH_CM: {
    code: 'WATER_DEPTH_CM',
    group: 'moisture',
    displayLabel: 'Water depth (cm)',
    valueType: 'band',
    valueOptions: ['0-5 cm', '5-15 cm', '15-30 cm', '>30 cm'],
    sortOrder: 40,
    isActive: true,
  },
  CROP_TYPE: {
    code: 'CROP_TYPE',
    group: 'crop',
    displayLabel: 'Current or recent crop',
    valueType: 'text',
    sortOrder: 10,
    isActive: true,
  },
  ACCESS_NOTES: {
    code: 'ACCESS_NOTES',
    group: 'access',
    displayLabel: 'Access constraints',
    valueType: 'text',
    sortOrder: 10,
    isActive: true,
  },
};

/**
 * Schema note: Many rows per sample point. Adding a condition code next season
 * is a reference-data insert, not a schema change and not a new column on a
 * 40,000-row-a-year table.
 */
