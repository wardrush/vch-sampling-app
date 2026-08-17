/**
 * Shared code sets — defects, conditions, deviations, validation, priorities
 * Exported from this barrel file for use across the sampler and ingest tools
 *
 * To move into project scaffold: rename these files to:
 *   src/shared/codes/defect.ts
 *   src/shared/codes/condition.ts
 *   src/shared/codes/deviation.ts
 *   src/shared/codes/validation.ts
 *   src/shared/codes/priority.ts
 *   src/shared/codes/index.ts
 */

export * from './defect';
export * from './condition';
export * from './deviation';
export * from './validation';
export * from './priority';

// Re-export common unions for convenience
export type { DefectSeverity, DefectSource } from './defect';
export type { ConditionValueType, ConditionGroup } from './condition';
export type { ValidationType } from './validation';
export type { EntityType } from './priority';
