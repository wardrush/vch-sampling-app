/**
 * A10 — token validation. Plan v02 §8, ingest spec §9, addendum §2.5.
 *
 * **Say plainly what this is.** A link is a bearer credential: anyone holding
 * `/ingest/<token>` is Thane. That is an acceptable trade for one trusted
 * contractor uploading coordinates on a six-week schedule, and it stops being
 * acceptable the moment this surface displays farmer contact data broadly or
 * gains a second class of user. The mitigations that cost nothing are in place:
 * the tool shows contact *matches* rather than CRM records, and tokens expire.
 *
 * `INGEST_ACCESS_TOKEN` stores `TOKEN_HASH`, **never the token itself**. A
 * warehouse read, a backup, or a support screenshot therefore does not hand
 * someone the credential.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SnowflakeClient } from '../snowflake/client.js';
import { asObjects } from '../snowflake/client.js';

/** 32 bytes, base64url — 256 bits of unguessable. */
export function issueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface TokenIdentity {
  token_id: string;
  person_ref: string;
  display_name: string | null;
  surface: 'ingest' | 'sampler_enroll';
  crew_org_id: string | null;
}

export type TokenVerdict =
  | { ok: true; identity: TokenIdentity }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' };

/**
 * Looks a token up by hash and returns who it is.
 *
 * The lookup is by hash equality in the warehouse, so it is not constant-time
 * against a timing attacker who can measure the query. That is the right trade
 * here — the token is 256 bits of entropy, so there is no adjacent guess to
 * time your way toward. The `timingSafeEqual` below guards the one comparison
 * that *is* worth guarding: two hashes of equal, known length.
 */
export async function validateToken(
  sf: SnowflakeClient,
  rawToken: string,
  nowIso = new Date().toISOString(),
): Promise<TokenVerdict> {
  const hash = hashToken(rawToken);
  const rows = asObjects<Record<string, string | null>>(
    await sf.execute(
      `SELECT TOKEN_ID, TOKEN_HASH, PERSON_REF, DISPLAY_NAME, SURFACE, CREW_ORG_ID,
              EXPIRES_TS, REVOKED_TS
         FROM CURATED.INGEST_ACCESS_TOKEN
        WHERE TOKEN_HASH = ?`,
      { binds: [hash] },
    ),
  );

  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };

  const stored = Buffer.from(String(row.token_hash ?? ''));
  const computed = Buffer.from(hash);
  if (stored.length !== computed.length || !timingSafeEqual(stored, computed)) {
    return { ok: false, reason: 'unknown' };
  }

  if (row.revoked_ts) return { ok: false, reason: 'revoked' };
  if (row.expires_ts && new Date(row.expires_ts) <= new Date(nowIso)) {
    return { ok: false, reason: 'expired' };
  }

  // Fire-and-forget usage stamping: a failure here must not cost a valid user
  // their session, and the audit event is the durable record either way.
  void sf
    .execute(
      `UPDATE CURATED.INGEST_ACCESS_TOKEN
          SET LAST_USED_TS = ?, USE_COUNT = COALESCE(USE_COUNT, 0) + 1
        WHERE TOKEN_ID = ?`,
      { binds: [nowIso, String(row.token_id)] },
    )
    .catch(() => undefined);

  return {
    ok: true,
    identity: {
      token_id: String(row.token_id),
      person_ref: String(row.person_ref),
      display_name: row.display_name ?? null,
      surface: (row.surface as TokenIdentity['surface']) ?? 'ingest',
      crew_org_id: row.crew_org_id ?? null,
    },
  };
}

/** Extracts the token from `/ingest/<token>` or an `Authorization: Bearer`. */
export function extractToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim() || null;

  const { pathname } = new URL(request.url);
  const match = /\/ingest\/([A-Za-z0-9_-]{20,})\/?$/.exec(pathname);
  return match?.[1] ?? null;
}
