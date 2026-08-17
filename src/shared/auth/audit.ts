/**
 * A11 — the `AUDIT_EVENT` writer. Addendum §2.6, plan v02 §9.
 *
 * The sampling app's own attribution lives on its rows — sampler, device and
 * sync batch on every one. The **office-side** surfaces have nowhere to write,
 * and this is that somewhere: who committed which import, who resolved which
 * defect, who enrolled or revoked which device.
 *
 * `ip_hash`, not `ip`. The question an audit answers is "was this the same
 * origin as the other nineteen imports", and a hash answers it. Storing the
 * address itself answers a question nobody asked and creates a retention
 * conversation nobody scheduled.
 */

import { createHash } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import type { SnowflakeClient } from '../snowflake/client.js';
import type { ActorKind } from './session.js';
import type { AuditAction, AuditSurface } from '../codes/index.js';

export interface AuditEventInput {
  actor_ref: string;
  actor_kind: ActorKind;
  surface: AuditSurface;
  action: AuditAction | string;
  entity_type: string;
  entity_id: string;
  detail?: unknown;
  /** Raw address; hashed before it reaches a column. */
  ip?: string | null;
  user_agent?: string | null;
}

/**
 * Salted so the hashes are not a rainbow table of the IPv4 space.
 *
 * The salt is deployment-scoped and stable: rotating it makes historical events
 * incomparable, which defeats the only question the column exists to answer.
 */
export function hashIp(ip: string | null | undefined, salt: string): string | null {
  if (!ip) return null;
  return createHash('sha256').update(`${salt}|${ip}`).digest('hex');
}

export interface AuditWriterOptions {
  snowflake: SnowflakeClient;
  ipHashSalt: string;
  now?: () => number;
}

export class AuditWriter {
  constructor(private readonly options: AuditWriterOptions) {}

  /**
   * Writes one event. Returns its id.
   *
   * Deliberately **not** fire-and-forget for `import_commit` and
   * `import_retire` — spec §7 makes the audit row part of the commit, and a
   * commit whose audit row silently failed is a commit nobody can attribute.
   * Callers that genuinely do not need the guarantee can ignore the promise.
   */
  async write(input: AuditEventInput): Promise<string> {
    const eventId = uuidv7();
    const now = this.options.now ?? Date.now;
    await this.options.snowflake.execute(
      `INSERT INTO CURATED.AUDIT_EVENT
         (EVENT_ID, EVENT_TS, ACTOR_REF, ACTOR_KIND, SURFACE, ACTION,
          ENTITY_TYPE, ENTITY_ID, DETAIL_JSON, IP_HASH, USER_AGENT_RAW)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, PARSE_JSON(?), ?, ?`,
      {
        binds: [
          eventId,
          new Date(now()).toISOString(),
          input.actor_ref,
          input.actor_kind,
          input.surface,
          input.action,
          input.entity_type,
          input.entity_id,
          JSON.stringify(input.detail ?? {}),
          hashIp(input.ip, this.options.ipHashSalt),
          input.user_agent ?? null,
        ],
      },
    );
    return eventId;
  }

  /** Pulls actor and client details straight off a request. */
  async writeFor(
    request: Request,
    actor: { ref: string; kind: ActorKind },
    event: Omit<AuditEventInput, 'actor_ref' | 'actor_kind' | 'ip' | 'user_agent'>,
  ): Promise<string> {
    return this.write({
      ...event,
      actor_ref: actor.ref,
      actor_kind: actor.kind,
      ip: clientIp(request),
      user_agent: request.headers.get('user-agent'),
    });
  }
}

/**
 * Netlify sets `x-nf-client-connection-ip`; the standard proxy headers are the
 * fallback. Only the first hop of `x-forwarded-for` is meaningful and the rest
 * is caller-supplied, so nothing beyond it is read.
 */
export function clientIp(request: Request): string | null {
  const direct = request.headers.get('x-nf-client-connection-ip');
  if (direct) return direct;
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() ?? null;
}
