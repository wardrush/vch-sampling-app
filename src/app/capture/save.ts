/**
 * The local write. Everything a completed point becomes on the device.
 *
 * Two sentences from v02 §3 shape this file entirely:
 *
 *  - **"Capture never blocks on connectivity."** Nothing here touches the
 *    network. It writes rows and queues them. The radio can be off, the SIM
 *    can be missing, the phone can be in a basement in North Dakota, and the
 *    point is still captured and still durable.
 *  - **"Save writes locally and returns to the map in under a second."** One
 *    transaction, no re-encoding — the photograph bytes were written to OPFS
 *    at the moment each one was taken, so save is metadata only.
 *
 * The rows and the outbox entries go in **one transaction**, so a force-quit
 * between them is impossible. A sample in the database that is not in the
 * outbox is a sample that never syncs and never appears in the Outbox screen
 * — silent loss, which is the failure v02 §11 criterion 2 is written against.
 */

import type { SqlDatabase, SqlValue } from '../../shared/db/types.js';
import { transaction } from '../../shared/db/types.js';
import type {
  FieldVisitPayload,
  MediaMetaPayload,
  SampleBagPayload,
  SampleConditionPayload,
  SamplePointPayload,
} from '../../shared/contract/entities.js';
import { OutboxStore } from '../../sync/outbox-store.js';
import { assertNoTutorialIdentity } from './tutorial-boundary.js';

/** A media row plus the local-only columns the wire payload does not carry. */
export interface StoredMedia {
  payload: MediaMetaPayload;
  local_path: string;
}

export interface CaptureWrite {
  /**
   * Upserted if given. The Field screen normally opens the visit; passing it
   * here makes the capture path self-sufficient, which matters because
   * `sample_point.visit_id` is a real foreign key and `PRAGMA foreign_keys`
   * is ON.
   */
  visit?: FieldVisitPayload | null;
  sample: SamplePointPayload;
  bags?: readonly SampleBagPayload[];
  conditions?: readonly SampleConditionPayload[];
  media?: readonly StoredMedia[];
}

export interface CaptureWriteResult {
  sample_uid: string;
  media_ids: string[];
  /** Rows added to the outbox — what the Outbox screen's count moves by. */
  queued: number;
}

export async function writeCaptureLocally(
  db: SqlDatabase,
  write: CaptureWrite,
  nowIso: string = new Date().toISOString(),
): Promise<CaptureWriteResult> {
  const outbox = new OutboxStore(db);
  const media = write.media ?? [];
  const bags = write.bags ?? [];
  const conditions = write.conditions ?? [];

  // The last gate before SQLite, and the one that holds for callers that are
  // not `CaptureSession`. Outside the transaction on purpose: nothing has been
  // written yet when it throws, so there is no partial row to reason about.
  assertNoTutorialWrite(write, media, bags, conditions);

  await transaction(db, async () => {
    if (write.visit) {
      await upsert(db, 'field_visit', 'visit_id', { ...write.visit });
      await outbox.enqueue({
        entity_type: 'field_visit',
        entity_id: write.visit.visit_id,
        payload: write.visit,
        created_ts: nowIso,
      });
    }

    await upsert(db, 'sample_point', 'sample_uid', { ...write.sample });
    await outbox.enqueue({
      entity_type: 'sample_point',
      entity_id: write.sample.sample_uid,
      payload: write.sample,
      depends_on: write.sample.visit_id,
      created_ts: nowIso,
    });

    for (const bag of bags) {
      await upsert(db, 'sample_bag', 'bag_id', { ...bag });
      await outbox.enqueue({
        entity_type: 'sample_bag',
        entity_id: bag.bag_id,
        payload: bag,
        depends_on: bag.sample_uid,
        created_ts: nowIso,
      });
    }

    for (const condition of conditions) {
      await upsert(db, 'sample_condition', 'condition_id', { ...condition });
      await outbox.enqueue({
        entity_type: 'sample_condition',
        entity_id: condition.condition_id,
        payload: condition,
        depends_on: condition.sample_uid,
        created_ts: nowIso,
      });
    }

    for (const item of media) {
      await upsert(db, 'media', 'media_id', {
        ...item.payload,
        local_path: item.local_path,
        upload_state: 'pending',
      });
      await outbox.enqueue({
        entity_type: 'media_meta',
        entity_id: item.payload.media_id,
        payload: item.payload,
        // The metadata row waits on its sample; the *bytes* wait on the
        // ticket the server issues in reply to this row (contract §4).
        depends_on: item.payload.sample_uid ?? item.payload.visit_id ?? null,
        created_ts: nowIso,
      });
    }
  });

  return {
    sample_uid: write.sample.sample_uid,
    media_ids: media.map((m) => m.payload.media_id),
    queued: 1 + (write.visit ? 1 : 0) + bags.length + conditions.length + media.length,
  };
}

/**
 * Every identifier in the write, checked against the reserved tutorial
 * namespace.
 *
 * Plan v02 D18: the tutorial sandbox commit is discarded, never written to a
 * real plan. `TutorialCaptureSession` has no `SqlDatabase` and so cannot reach
 * this function at all; this is the guard for the day someone copies a
 * tutorial payload into a fixture, a repair script, or a "just re-queue it"
 * console call. A tutorial image cannot get here — `MediaMetaPayload.capture_source`
 * has no value for it and the compiler stops that — but a tutorial *id* is
 * just a string, so ids need a runtime check.
 */
function assertNoTutorialWrite(
  write: CaptureWrite,
  media: readonly StoredMedia[],
  bags: readonly SampleBagPayload[],
  conditions: readonly SampleConditionPayload[],
): void {
  if (write.visit) {
    assertNoTutorialIdentity('writeCaptureLocally/field_visit', {
      visit_id: write.visit.visit_id,
      boundary_id: write.visit.boundary_id,
      device_id: write.visit.device_id,
    });
  }
  assertNoTutorialIdentity('writeCaptureLocally/sample_point', {
    sample_uid: write.sample.sample_uid,
    visit_id: write.sample.visit_id,
    plan_point_id: write.sample.plan_point_id,
    device_id: write.sample.device_id,
    supersedes_sample_uid: write.sample.supersedes_sample_uid,
  });
  for (const bag of bags) {
    assertNoTutorialIdentity('writeCaptureLocally/sample_bag', {
      bag_id: bag.bag_id,
      sample_uid: bag.sample_uid,
    });
  }
  for (const condition of conditions) {
    assertNoTutorialIdentity('writeCaptureLocally/sample_condition', {
      condition_id: condition.condition_id,
      sample_uid: condition.sample_uid,
    });
  }
  for (const item of media) {
    assertNoTutorialIdentity('writeCaptureLocally/media', {
      media_id: item.payload.media_id,
      sample_uid: item.payload.sample_uid,
      bag_id: item.payload.bag_id,
      visit_id: item.payload.visit_id,
      device_id: item.payload.device_id,
      content_hash: item.payload.content_hash,
      local_path: item.local_path,
    });
  }
}

/**
 * Insert, or update the columns given.
 *
 * `ON CONFLICT DO UPDATE` on the named columns only, so a retried save after a
 * partial failure converges without touching the device-local columns —
 * `sync_state`, `upload_state`, `evicted_flag` — that the sync worker owns.
 * `INSERT OR REPLACE` would silently reset them, and resetting `upload_state`
 * on an uploaded photograph means uploading it again.
 */
async function upsert(
  db: SqlDatabase,
  table: string,
  primaryKey: string,
  row: Record<string, unknown>,
): Promise<void> {
  const columns = Object.keys(row).filter((key) => row[key] !== undefined);
  const values = columns.map((key) => toSqlValue(row[key]));
  const placeholders = columns.map(() => '?').join(', ');
  const assignments = columns
    .filter((c) => c !== primaryKey)
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');

  await db.run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(${primaryKey}) DO UPDATE SET ${assignments}`,
    values,
  );
}

function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (value instanceof Uint8Array) return value;
  // `exif_raw` is the one that lands here: a VARIANT on the wire, TEXT on the
  // device. Stored whole — the point of keeping it is that nobody had to
  // decide in advance which tag would matter.
  return JSON.stringify(value);
}
