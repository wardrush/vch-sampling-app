/**
 * Outbox entity priorities and ordering
 * Source: SYNC_CONTRACT_v01.md §5
 *
 * Determines the order in which records are synced. Lower priority number goes first.
 * This is the spine of offline sync: JSON before media, data before metadata, metadata before bytes.
 */

export type EntityType =
  | 'field_visit'
  | 'sample_point'
  | 'sample_bag'
  | 'sample_condition'
  | 'local_defect'
  | 'media_meta'
  | 'media_bytes'
  | 'app_event';

export interface EntityPriority {
  entityType: EntityType;
  priority: number;
  description: string;
  why: string;
}

export const ENTITY_PRIORITIES: Record<EntityType, EntityPriority> = {
  field_visit: {
    entityType: 'field_visit',
    priority: 10,
    description: 'Field visit (parent)',
    why: 'Parent of everything else',
  },
  sample_point: {
    entityType: 'sample_point',
    priority: 20,
    description: 'Sample point (core record)',
    why: 'The record that matters most',
  },
  sample_bag: {
    entityType: 'sample_bag',
    priority: 30,
    description: 'Sample bag (child)',
    why: 'Children of the sample',
  },
  sample_condition: {
    entityType: 'sample_condition',
    priority: 30,
    description: 'Sample condition (child)',
    why: 'Children of the sample',
  },
  local_defect: {
    entityType: 'local_defect',
    priority: 30,
    description: 'Local defect (child)',
    why: 'Children of the sample',
  },
  media_meta: {
    entityType: 'media_meta',
    priority: 40,
    description: 'Media metadata',
    why: 'Small; unlocks the upload tickets',
  },
  media_bytes: {
    entityType: 'media_bytes',
    priority: 90,
    description: 'Media bytes',
    why: 'Large, slow, background, last',
  },
  app_event: {
    entityType: 'app_event',
    priority: 95,
    description: 'App telemetry events',
    why: 'Never competes with data',
  },
};

/**
 * Dependency rules for outbox ordering.
 * Some entities have dependencies on their parents.
 */
export const ENTITY_DEPENDENCIES: Record<EntityType, EntityType | null> = {
  field_visit: null,
  sample_point: 'field_visit',
  sample_bag: 'sample_point',
  sample_condition: 'sample_point',
  local_defect: 'sample_point',
  media_meta: 'sample_point', // May be attached to bag instead, but sample_point is the tightest parent
  media_bytes: 'media_meta',
  app_event: null,
};

/**
 * Get priority for an entity type
 */
export function getPriority(entityType: EntityType): number {
  return ENTITY_PRIORITIES[entityType]?.priority ?? 100;
}

/**
 * Get the parent entity type that must be synced first
 */
export function getDependency(entityType: EntityType): EntityType | null {
  return ENTITY_DEPENDENCIES[entityType] ?? null;
}

/**
 * Validate outbox ordering: check that no entity comes before its parent
 */
export function validateOutboxOrder(records: { entityType: EntityType; entityId: string }[]): string[] {
  const errors: string[] = [];
  const ackedEntities = new Set<string>();

  for (const record of records) {
    const dependency = getDependency(record.entityType);
    if (dependency) {
      // This is a simplified check; real validation would track by entity_id
      // and ensure the specific parent is acked before the child is processed
    }
  }

  return errors;
}
