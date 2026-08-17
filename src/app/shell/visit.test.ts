import { describe, expect, it } from 'vitest';
import { NodeSqliteDb } from '../../../tests/support/node-sqlite.js';
import { bootstrapDeviceDb } from '@shared/db/schema.js';
import { resolveVisitForBoundary } from './visit.js';

async function freshDb() {
  const db = new NodeSqliteDb(':memory:');
  await bootstrapDeviceDb(db);
  return db;
}

describe('resolveVisitForBoundary', () => {
  it('mints a new visit id and payload when no in_progress visit exists for the boundary', async () => {
    const db = await freshDb();
    const { visitId, visit } = await resolveVisitForBoundary(db, {
      boundaryId: 'b-001',
      planId: null,
      specId: 'spec-1',
      crewOrgId: null,
      deviceId: 'device-1',
      nowIso: '2026-09-01T00:00:00Z',
    });

    expect(visit).not.toBeNull();
    expect(visit?.visit_id).toBe(visitId);
    expect(visit?.boundary_id).toBe('b-001');
    expect(visit?.status).toBe('in_progress');

    // Read-only — nothing written yet. That is `CaptureSession.save()`'s job.
    const rows = await db.all('SELECT * FROM field_visit');
    expect(rows).toHaveLength(0);
  });

  it('reuses an existing in_progress visit and returns visit: null (already persisted)', async () => {
    const db = await freshDb();
    await db.run(
      `INSERT INTO field_visit (visit_id, boundary_id, status, started_ts) VALUES (?,?,?,?)`,
      ['existing-visit', 'b-001', 'in_progress', '2026-09-01T00:00:00Z'],
    );

    const resolved = await resolveVisitForBoundary(db, {
      boundaryId: 'b-001',
      planId: null,
      specId: null,
      crewOrgId: null,
      deviceId: 'device-1',
      nowIso: '2026-09-01T01:00:00Z',
    });

    expect(resolved.visitId).toBe('existing-visit');
    expect(resolved.visit).toBeNull();
  });

  it('does not reuse a visit that belongs to a different boundary', async () => {
    const db = await freshDb();
    await db.run(
      `INSERT INTO field_visit (visit_id, boundary_id, status, started_ts) VALUES (?,?,?,?)`,
      ['other-boundary-visit', 'b-999', 'in_progress', '2026-09-01T00:00:00Z'],
    );

    const resolved = await resolveVisitForBoundary(db, {
      boundaryId: 'b-001',
      planId: null,
      specId: null,
      crewOrgId: null,
      deviceId: null,
      nowIso: '2026-09-01T01:00:00Z',
    });

    expect(resolved.visitId).not.toBe('other-boundary-visit');
    expect(resolved.visit).not.toBeNull();
  });
});
