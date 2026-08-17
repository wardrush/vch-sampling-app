/**
 * A3 — the outbox worker.
 *
 * The spine of the whole offline design, and the file v02 Appendix A names
 * first. Everything it does is in service of one sentence from the plan:
 * *nothing shows as committed to the sampler until the server says so.*
 *
 * What it guarantees, and where each guarantee comes from:
 *
 *  - **Priority ordering** (contract §5). Parents before children, JSON before
 *    media, telemetry last. A week of records reaches the warehouse over a
 *    gas-station connection while the photos continue in the background.
 *  - **`depends_on`** — a child never goes before its parent is acked *or* is
 *    ahead of it in the same batch. The server also holds orphans for 30 days,
 *    so this is belt and braces on purpose: a device wiped mid-deployment
 *    should not orphan the records that did arrive.
 *  - **Blind-retry idempotency.** A batch keeps its `sync_batch_id` across
 *    retries, including across a force-quit. Re-POSTing an accepted batch
 *    changes nothing and returns the same acknowledgement (v02 §11.4).
 *  - **Partial ack.** A whole batch is never failed for one bad record. Each
 *    entity is acked, retried, or failed on its own.
 *  - **`retryable` is obeyed, not inferred.** Non-retryable means the row
 *    stops and shows a badge; it never means the row is dropped.
 *  - **Resume after force-quit.** `in_flight` rows are re-sent under their
 *    original batch id before any new work is claimed.
 *
 * It deliberately does *not* upload photo bytes. Tickets come back from the
 * batch response and a separate pass moves bytes at priority 90, on unmetered
 * connections by default — quietly consuming a sampler's personal data plan is
 * how an app gets uninstalled.
 */

import { uuidv7 } from 'uuidv7';
import type {
  SyncBatchRequest,
  SyncBatchResponse,
  SyncRecord,
  SyncRejection,
} from '../shared/contract/sync.js';
import { BATCH_MAX_BYTES, BATCH_MAX_RECORDS } from '../shared/contract/sync.js';
import type { MediaTicket } from '../shared/contract/media.js';
import { SCHEMA_VERSION } from '../shared/contract/common.js';
import { backoffDelayMs } from './backoff.js';
import type { OutboxRow, OutboxStore } from './outbox-store.js';

/** Thrown by a transport when the batch did not get a per-record answer. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface SyncTransport {
  postBatch(request: SyncBatchRequest): Promise<SyncBatchResponse>;
}

export interface OutboxWorkerOptions {
  store: OutboxStore;
  transport: SyncTransport;
  deviceId: string;
  appVersion: string;
  now?: () => number;
  random?: () => number;
  newBatchId?: () => string;
  /** Called with every ticket the server returns. Drives the byte upload pass. */
  onTickets?: (tickets: MediaTicket[]) => void;
  /** Per-drain ceiling on batches, so one call cannot run for an hour. */
  maxBatchesPerDrain?: number;
}

export interface DrainResult {
  batchesSent: number;
  accepted: number;
  rejectedRetryable: number;
  rejectedPermanent: number;
  /** Set when the worker is in backoff; nothing was attempted. */
  waitingUntilMs?: number;
  /** Set when a transport failure ended the drain early. */
  transportError?: string;
}

export class OutboxWorker {
  private readonly store: OutboxStore;
  private readonly transport: SyncTransport;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly newBatchId: () => string;

  private consecutiveFailures = 0;
  private nextAttemptAtMs = 0;

  constructor(private readonly options: OutboxWorkerOptions) {
    this.store = options.store;
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.newBatchId = options.newBatchId ?? uuidv7;
  }

  /** Exposed for the Outbox screen: "next try in 4 minutes" beats a spinner. */
  get nextAttemptAt(): number {
    return this.nextAttemptAtMs;
  }

  /**
   * Drains the outbox until it is empty, a batch fails, or the ceiling is hit.
   *
   * `force` is the sampler pressing "sync now" — it ignores backoff, because a
   * person who has just walked to the top of a hill for signal has better
   * information than the timer does.
   */
  async drain(opts: { force?: boolean } = {}): Promise<DrainResult> {
    const result: DrainResult = {
      batchesSent: 0,
      accepted: 0,
      rejectedRetryable: 0,
      rejectedPermanent: 0,
    };

    if (!opts.force && this.now() < this.nextAttemptAtMs) {
      result.waitingUntilMs = this.nextAttemptAtMs;
      return result;
    }

    const maxBatches = this.options.maxBatchesPerDrain ?? 50;

    // Resume first. Anything in flight when the process died is re-sent under
    // the batch id it already had, so the server sees a replay and not a
    // second batch of the same records.
    for (const [batchId, rows] of await this.groupInFlight()) {
      if (result.batchesSent >= maxBatches) return result;
      const ok = await this.sendBatch(batchId, rows, result, { resend: true });
      if (!ok) return result;
    }

    for (;;) {
      if (result.batchesSent >= maxBatches) return result;
      const rows = await this.claim();
      if (rows.length === 0) return result;

      const batchId = this.newBatchId();
      await this.store.markInFlight(
        rows.map((r) => r.outbox_id),
        batchId,
        new Date(this.now()).toISOString(),
      );
      const ok = await this.sendBatch(batchId, rows, result, { resend: false });
      if (!ok) return result;
    }
  }

  private async groupInFlight(): Promise<Map<string, OutboxRow[]>> {
    const groups = new Map<string, OutboxRow[]>();
    for (const row of await this.store.inFlight()) {
      // A row marked in_flight with no batch id means the process died between
      // the two statements. It has certainly not been sent; give it a new id.
      const key = row.sync_batch_id ?? this.newBatchId();
      const list = groups.get(key);
      if (list) list.push(row);
      else groups.set(key, [row]);
    }
    return groups;
  }

  /**
   * Selects the next batch: priority order, dependencies satisfied, inside both
   * the record and the byte cap.
   *
   * A record whose parent is neither acked nor already in this batch is skipped
   * rather than blocking the scan — its siblings and the rest of the queue
   * should not wait behind it.
   */
  private async claim(): Promise<OutboxRow[]> {
    // Over-fetch: a candidate may be skipped for an unmet dependency, and the
    // batch should still fill.
    const candidates = await this.store.pending(BATCH_MAX_RECORDS * 3);
    if (candidates.length === 0) return [];

    const deps = candidates.map((r) => r.depends_on).filter((d): d is string => !!d);
    const acked = await this.store.ackedEntityIds([...new Set(deps)]);

    const batch: OutboxRow[] = [];
    const inBatch = new Set<string>();
    let bytes = 0;

    for (const row of candidates) {
      if (batch.length >= BATCH_MAX_RECORDS) break;
      if (row.depends_on && !acked.has(row.depends_on) && !inBatch.has(row.depends_on)) continue;

      const size = row.payload_json.length + row.entity_id.length + 64;
      if (bytes + size > BATCH_MAX_BYTES && batch.length > 0) break;

      batch.push(row);
      inBatch.add(row.entity_id);
      bytes += size;
    }
    return batch;
  }

  /** Returns false when the drain should stop (transport failure). */
  private async sendBatch(
    batchId: string,
    rows: OutboxRow[],
    result: DrainResult,
    { resend }: { resend: boolean },
  ): Promise<boolean> {
    if (rows.length === 0) return true;

    const nowIso = new Date(this.now()).toISOString();
    if (resend) {
      // Re-count the attempt and refresh the timestamp, but keep the batch id.
      await this.store.markInFlight(
        rows.map((r) => r.outbox_id),
        batchId,
        nowIso,
      );
    }

    const request: SyncBatchRequest = {
      sync_batch_id: batchId,
      device_id: this.options.deviceId,
      app_version: this.options.appVersion,
      schema_version: SCHEMA_VERSION,
      client_sent_ts: nowIso,
      records: rows.map(toSyncRecord),
    };

    let response: SyncBatchResponse;
    try {
      response = await this.transport.postBatch(request);
    } catch (err) {
      const retryable = err instanceof TransportError ? err.retryable : true;
      const message = err instanceof Error ? err.message : String(err);
      const ids = rows.map((r) => r.entity_id);
      if (retryable) {
        // Stay in_flight — the error is noted, the state is not touched. The
        // next drain re-sends under this same batch id, which is what makes a
        // timeout that actually committed harmless.
        await this.store.noteAttemptError(ids, batchId, message);
        result.rejectedRetryable += ids.length;
        this.registerFailure();
      } else {
        await this.store.markFailed(ids, batchId, message);
        result.rejectedPermanent += ids.length;
      }
      result.transportError = message;
      return false;
    }

    result.batchesSent += 1;
    this.registerSuccess();

    const acked = new Set(response.accepted);
    const retryable: string[] = [];
    const permanent: SyncRejection[] = [];
    for (const rejection of response.rejected) {
      if (rejection.retryable) retryable.push(rejection.entity_id);
      else permanent.push(rejection);
    }

    // A record neither accepted nor rejected is a server bug or a truncated
    // response. Treat it as retryable: the upsert is idempotent, so re-sending
    // costs nothing and dropping it costs a sample.
    const unanswered = rows
      .map((r) => r.entity_id)
      .filter((id) => !acked.has(id) && !response.rejected.some((x) => x.entity_id === id));

    await this.store.markAcked([...acked], batchId, new Date(this.now()).toISOString());
    await this.store.markRetry([...retryable, ...unanswered], batchId, 'retryable rejection');
    for (const rejection of permanent) {
      await this.store.markFailed(
        [rejection.entity_id],
        batchId,
        `${rejection.code}${rejection.detail ? `: ${rejection.detail}` : ''}`,
      );
    }

    result.accepted += acked.size;
    result.rejectedRetryable += retryable.length + unanswered.length;
    result.rejectedPermanent += permanent.length;

    if (response.media_upload_tickets.length > 0) {
      this.options.onTickets?.(response.media_upload_tickets);
    }
    return true;
  }

  private registerSuccess(): void {
    this.consecutiveFailures = 0;
    this.nextAttemptAtMs = 0;
  }

  private registerFailure(): void {
    this.consecutiveFailures += 1;
    this.nextAttemptAtMs = this.now() + backoffDelayMs(this.consecutiveFailures, this.random);
  }
}

function toSyncRecord(row: OutboxRow): SyncRecord {
  return {
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    operation: 'upsert',
    payload: JSON.parse(row.payload_json) as unknown,
  };
}
