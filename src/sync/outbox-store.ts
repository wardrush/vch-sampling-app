/**
 * The outbox table, as a typed store. A3.
 *
 * Every statement that touches `outbox` lives here so the worker reads as
 * policy rather than as SQL. Nothing is ever deleted: an acked row is *marked*
 * acked. Eviction is a separate, deliberate, user-visible operation
 * (device_sqlite_v01 header comment), and the Outbox screen is built on the
 * fact that history survives.
 */

import type { SqlDatabase, SqlValue } from '../shared/db/types.js';
import type { SyncEntityType, Uuid7 } from '../shared/contract/common.js';
import { OUTBOX_PRIORITY } from '../shared/contract/sync.js';

export type OutboxState = 'pending' | 'in_flight' | 'acked' | 'failed';

export interface OutboxRow {
  outbox_id: number;
  entity_type: SyncEntityType;
  entity_id: Uuid7;
  operation: string;
  payload_json: string;
  depends_on: string | null;
  priority: number;
  state: OutboxState;
  attempt_count: number;
  last_attempt_ts: string | null;
  last_error: string | null;
  sync_batch_id: string | null;
  created_ts: string;
  acked_ts: string | null;
}

export interface EnqueueInput {
  entity_type: SyncEntityType;
  entity_id: Uuid7;
  payload: unknown;
  depends_on?: string | null;
  priority?: number;
  created_ts: string;
}

export class OutboxStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Queues a record. Idempotent on `(entity_type, entity_id, operation)`.
   *
   * `ON CONFLICT … DO UPDATE` rather than `DO NOTHING`: a sampler who corrects
   * a point before it has synced should send the corrected payload, and the
   * unique constraint is what keeps that one row rather than two. A record
   * already acked is left alone — corrections after sync are new rows
   * (`supersedes_sample_uid`), never edits.
   */
  async enqueue(input: EnqueueInput): Promise<void> {
    const priority = input.priority ?? OUTBOX_PRIORITY[input.entity_type] ?? 100;
    await this.db.run(
      `INSERT INTO outbox (entity_type, entity_id, operation, payload_json,
                           depends_on, priority, state, created_ts)
       VALUES (?, ?, 'upsert', ?, ?, ?, 'pending', ?)
       ON CONFLICT (entity_type, entity_id, operation) DO UPDATE SET
         payload_json = excluded.payload_json,
         depends_on   = excluded.depends_on,
         priority     = excluded.priority,
         state        = CASE WHEN outbox.state = 'acked' THEN 'acked' ELSE 'pending' END,
         last_error   = CASE WHEN outbox.state = 'acked' THEN outbox.last_error ELSE NULL END`,
      [
        input.entity_type,
        input.entity_id,
        JSON.stringify(input.payload),
        input.depends_on ?? null,
        priority,
        input.created_ts,
      ],
    );
  }

  /**
   * Rows left `in_flight` by a force-quit or a crash, oldest batch first.
   *
   * v02 §11 criterion 2 — killing the app mid-capture loses at most the
   * current, uncommitted point. Anything that reached the outbox is here on
   * next launch, and it is re-sent **under its original `sync_batch_id`** so
   * the server's idempotency key still lines up with whatever it may already
   * have committed.
   */
  async inFlight(): Promise<OutboxRow[]> {
    return this.db.all<OutboxRow>(
      `SELECT * FROM outbox WHERE state = 'in_flight' ORDER BY sync_batch_id, priority, outbox_id`,
    );
  }

  /** Pending rows in send order. Filtering on `depends_on` happens in the worker. */
  async pending(limit: number): Promise<OutboxRow[]> {
    return this.db.all<OutboxRow>(
      `SELECT * FROM outbox WHERE state = 'pending' ORDER BY priority, outbox_id LIMIT ?`,
      [limit],
    );
  }

  /** Entity ids the server has already acknowledged — the `depends_on` gate. */
  async ackedEntityIds(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => '?').join(',');
    const rows = await this.db.all<{ entity_id: string }>(
      `SELECT entity_id FROM outbox WHERE state = 'acked' AND entity_id IN (${placeholders})`,
      ids as SqlValue[],
    );
    return new Set(rows.map((r) => r.entity_id));
  }

  async markInFlight(outboxIds: readonly number[], batchId: string, nowIso: string): Promise<void> {
    if (outboxIds.length === 0) return;
    const placeholders = outboxIds.map(() => '?').join(',');
    await this.db.run(
      `UPDATE outbox
          SET state = 'in_flight',
              sync_batch_id = ?,
              attempt_count = attempt_count + 1,
              last_attempt_ts = ?
        WHERE outbox_id IN (${placeholders})`,
      [batchId, nowIso, ...(outboxIds as unknown as SqlValue[])],
    );
  }

  /** Contract §1 property 3 — "synced" is a fact, and this is where it becomes one. */
  async markAcked(entityIds: readonly string[], batchId: string, nowIso: string): Promise<void> {
    if (entityIds.length === 0) return;
    const placeholders = entityIds.map(() => '?').join(',');
    await this.db.run(
      `UPDATE outbox
          SET state = 'acked', acked_ts = ?, last_error = NULL
        WHERE sync_batch_id = ? AND entity_id IN (${placeholders})`,
      [nowIso, batchId, ...(entityIds as unknown as SqlValue[])],
    );
  }

  /**
   * Records a failed attempt **without changing state**.
   *
   * Used when the transport failed and the server's answer is unknown. The rows
   * stay `in_flight` so the next drain re-sends them under the *same*
   * `sync_batch_id` — which is the whole basis of blind-retry safety. Returning
   * them to `pending` would hand them a fresh batch id on the next attempt, and
   * a batch the server had already committed would arrive looking new.
   */
  async noteAttemptError(entityIds: readonly string[], batchId: string, error: string): Promise<void> {
    if (entityIds.length === 0) return;
    const placeholders = entityIds.map(() => '?').join(',');
    await this.db.run(
      `UPDATE outbox SET last_error = ? WHERE sync_batch_id = ? AND entity_id IN (${placeholders})`,
      [error, batchId, ...(entityIds as unknown as SqlValue[])],
    );
  }

  /** Retryable *rejection* — the server answered, so the batch is finished with. */
  async markRetry(entityIds: readonly string[], batchId: string, error: string | null): Promise<void> {
    if (entityIds.length === 0) return;
    const placeholders = entityIds.map(() => '?').join(',');
    await this.db.run(
      `UPDATE outbox
          SET state = 'pending', last_error = ?
        WHERE sync_batch_id = ? AND entity_id IN (${placeholders})`,
      [error, batchId, ...(entityIds as unknown as SqlValue[])],
    );
  }

  /**
   * Non-retryable rejection. The row stops moving and gets a visible badge.
   *
   * This is the state the Outbox screen exists for. A silently-stuck outbox is
   * the failure mode that loses a season, so `failed` is loud and `last_error`
   * is the sampler's, not the log's.
   */
  async markFailed(entityIds: readonly string[], batchId: string, error: string): Promise<void> {
    if (entityIds.length === 0) return;
    const placeholders = entityIds.map(() => '?').join(',');
    await this.db.run(
      `UPDATE outbox
          SET state = 'failed', last_error = ?
        WHERE sync_batch_id = ? AND entity_id IN (${placeholders})`,
      [error, batchId, ...(entityIds as unknown as SqlValue[])],
    );
  }

  /** Counts for the Today screen's badge and the Outbox screen's header. */
  async counts(): Promise<Record<OutboxState, number>> {
    const rows = await this.db.all<{ state: OutboxState; n: number }>(
      `SELECT state, COUNT(*) AS n FROM outbox GROUP BY state`,
    );
    const out: Record<OutboxState, number> = { pending: 0, in_flight: 0, acked: 0, failed: 0 };
    for (const r of rows) out[r.state] = Number(r.n);
    return out;
  }

  /** A sampler's "try that one again" on a failed row. */
  async retryFailed(entityId: string): Promise<void> {
    await this.db.run(
      `UPDATE outbox SET state = 'pending', last_error = NULL
        WHERE entity_id = ? AND state = 'failed'`,
      [entityId],
    );
  }
}
