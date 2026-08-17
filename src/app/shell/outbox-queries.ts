/**
 * B11 — read-only queries over the `outbox`/`media` tables for the Outbox
 * screen. `OutboxStore` (`src/sync/outbox-store.ts`, `sync-spine`'s A3) is
 * the write surface and already exposes `counts()`; this file only adds the
 * reads a *screen* needs that a sync worker never does — the per-record list
 * and "how many photo bytes are still waiting," neither of which belongs in
 * the sync spine's own module.
 */

import type { SqlDatabase } from '../../shared/db/types.js';
import type { SyncEntityType, Uuid7 } from '../../shared/contract/common.js';

export interface OutboxRecordRow {
  outbox_id: number;
  entity_type: SyncEntityType;
  entity_id: Uuid7;
  state: 'pending' | 'in_flight' | 'acked' | 'failed';
  attempt_count: number;
  last_error: string | null;
  created_ts: string;
  acked_ts: string | null;
}

export async function listRecentOutboxRecords(db: SqlDatabase, limit = 100): Promise<OutboxRecordRow[]> {
  return db.all<OutboxRecordRow>(
    `SELECT outbox_id, entity_type, entity_id, state, attempt_count, last_error, created_ts, acked_ts
       FROM outbox ORDER BY outbox_id DESC LIMIT ?`,
    [limit],
  );
}

export async function getLastSyncedTs(db: SqlDatabase): Promise<string | null> {
  const rows = await db.all<{ acked_ts: string | null }>(
    `SELECT MAX(acked_ts) AS acked_ts FROM outbox WHERE acked_ts IS NOT NULL`,
  );
  return rows[0]?.acked_ts ?? null;
}

/** Bytes still on-device because they have not been verified uploaded — the
 *  "pending photo MB" v02 §2 asks the Outbox screen to show. */
export async function pendingPhotoBytes(db: SqlDatabase): Promise<number> {
  const rows = await db.all<{ total: number | null }>(
    `SELECT COALESCE(SUM(bytes), 0) AS total FROM media WHERE upload_state != 'uploaded' AND evicted_flag = 0`,
  );
  return Number(rows[0]?.total ?? 0);
}
