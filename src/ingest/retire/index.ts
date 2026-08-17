/**
 * C12 — `POST /ingest/retire/{import_id}`. Ingest spec §7, addendum §4.3.
 *
 * "Undo this import" does exactly one thing: retires the plan version(s) it
 * created. **Refuses once any point in it has been sampled** — a plan a crew
 * has already worked against is a fact, not a draft. Both outcomes write an
 * `AUDIT_EVENT`, including the refusal, because a refusal that was never
 * attempted and a refusal that was attempted and denied look identical to
 * everyone except the audit log.
 *
 * Same upsert-never-delete discipline as everywhere else: the plan is marked
 * `superseded` (the status commit.ts already uses for a plan an import
 * revises), never deleted, so "where did this point come from" stays
 * answerable.
 */
import type { IngestRetireRequest, IngestRetireResponse } from '../../shared/contract/ingest.js';
import { AUDIT_ACTION } from '../../shared/codes/index.js';
import type { SnowflakeClient } from '../../shared/snowflake/client.js';
import { asObjects, scalar } from '../../shared/snowflake/client.js';
import { hashIp } from '../../shared/auth/audit.js';
import { uuidv7 } from 'uuidv7';

export interface RetireActor {
  ref: string;
  kind: 'token' | 'idp_user' | 'service';
  ip?: string | null;
  user_agent?: string | null;
}

export interface RetireDeps {
  snowflake: SnowflakeClient;
  actor: RetireActor;
  ipHashSalt: string;
  now?: () => number;
}

export async function retireImport(
  request: IngestRetireRequest,
  deps: RetireDeps,
): Promise<IngestRetireResponse> {
  const now = deps.now ?? Date.now;
  const nowIso = new Date(now()).toISOString();
  const sf = deps.snowflake;

  const importRow = await findImport(sf, request.import_id);
  if (!importRow) {
    return refuse(request.import_id, 'NOT_FOUND', [], nowIso);
  }
  if (importRow.status === 'retired') {
    return refuse(request.import_id, 'ALREADY_RETIRED', importRow.plan_ids, nowIso);
  }

  const sampledCount = await countSampledPoints(sf, importRow.plan_ids);
  if (sampledCount > 0) {
    await writeAudit(sf, deps, request.import_id, AUDIT_ACTION.IMPORT_RETIRE_REFUSED, {
      code: 'POINTS_ALREADY_SAMPLED',
      sampled_point_count: sampledCount,
      reason: request.reason,
    });
    return {
      import_id: request.import_id,
      outcome: 'refused',
      code: 'POINTS_ALREADY_SAMPLED',
      sampled_point_count: sampledCount,
      plan_ids: importRow.plan_ids,
      retired_ts: null,
    };
  }

  await sf.executeMulti(
    [
      `UPDATE CURATED.PLAN_IMPORT
          SET STATUS = 'retired', RETIRED_BY = ?, RETIRED_TS = ?, RETIRE_REASON = ?,
              LAST_UPDATED_TS = CURRENT_TIMESTAMP()
        WHERE IMPORT_ID = ?`,
      importRow.plan_ids.length > 0
        ? `UPDATE CURATED.SAMPLE_PLAN
              SET STATUS = 'superseded', LAST_UPDATED_TS = CURRENT_TIMESTAMP()
            WHERE PLAN_ID IN (${importRow.plan_ids.map(() => '?').join(',')})`
        : `SELECT 1 WHERE FALSE`,
      `INSERT INTO CURATED.AUDIT_EVENT
         (EVENT_ID, EVENT_TS, ACTOR_REF, ACTOR_KIND, SURFACE, ACTION, ENTITY_TYPE,
          ENTITY_ID, DETAIL_JSON, IP_HASH, USER_AGENT_RAW)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, PARSE_JSON(?), ?, ?`,
    ],
    {
      binds: [
        deps.actor.ref,
        nowIso,
        request.reason ?? null,
        request.import_id,
        ...importRow.plan_ids,
        uuidv7(),
        nowIso,
        deps.actor.ref,
        deps.actor.kind,
        'ingest',
        AUDIT_ACTION.IMPORT_RETIRE,
        'plan_import',
        request.import_id,
        JSON.stringify({ plan_ids: importRow.plan_ids, reason: request.reason ?? null }),
        hashIp(deps.actor.ip, deps.ipHashSalt),
        deps.actor.user_agent ?? null,
      ],
    },
  );

  return {
    import_id: request.import_id,
    outcome: 'retired',
    plan_ids: importRow.plan_ids,
    retired_ts: nowIso,
  };
}

async function refuse(
  importId: string,
  code: 'NOT_FOUND' | 'ALREADY_RETIRED',
  planIds: string[],
  nowIso: string,
): Promise<IngestRetireResponse> {
  return {
    import_id: importId,
    outcome: 'refused',
    code,
    plan_ids: planIds,
    retired_ts: null,
  } satisfies IngestRetireResponse;
}

async function writeAudit(
  sf: SnowflakeClient,
  deps: RetireDeps,
  importId: string,
  action: string,
  detail: unknown,
): Promise<void> {
  await sf.execute(
    `INSERT INTO CURATED.AUDIT_EVENT
       (EVENT_ID, EVENT_TS, ACTOR_REF, ACTOR_KIND, SURFACE, ACTION, ENTITY_TYPE,
        ENTITY_ID, DETAIL_JSON, IP_HASH, USER_AGENT_RAW)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, PARSE_JSON(?), ?, ?`,
    {
      binds: [
        uuidv7(),
        new Date((deps.now ?? Date.now)()).toISOString(),
        deps.actor.ref,
        deps.actor.kind,
        'ingest',
        action,
        'plan_import',
        importId,
        JSON.stringify(detail),
        hashIp(deps.actor.ip, deps.ipHashSalt),
        deps.actor.user_agent ?? null,
      ],
    },
  );
}

async function findImport(
  sf: SnowflakeClient,
  importId: string,
): Promise<{ status: string; plan_ids: string[] } | null> {
  const rows = asObjects<{ status: string; plan_ids: string | null }>(
    await sf.execute(`SELECT STATUS, PLAN_IDS FROM CURATED.PLAN_IMPORT WHERE IMPORT_ID = ?`, {
      binds: [importId],
    }),
  );
  const row = rows[0];
  if (!row) return null;
  let planIds: string[] = [];
  try {
    const parsed = JSON.parse(row.plan_ids ?? '[]') as unknown;
    if (Array.isArray(parsed)) planIds = parsed.map(String);
  } catch {
    planIds = [];
  }
  return { status: row.status, plan_ids: planIds };
}

async function countSampledPoints(sf: SnowflakeClient, planIds: string[]): Promise<number> {
  if (planIds.length === 0) return 0;
  const result = await sf.execute(
    `SELECT COUNT(*) FROM CURATED.SAMPLE_POINT sp
       JOIN CURATED.SAMPLE_PLAN_POINT pp ON pp.PLAN_POINT_ID = sp.PLAN_POINT_ID
      WHERE pp.PLAN_ID IN (${planIds.map(() => '?').join(',')})`,
    { binds: planIds },
  );
  return Number(scalar(result) ?? 0);
}
