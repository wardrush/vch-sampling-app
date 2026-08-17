/**
 * A10 — token URL → signed session cookie.
 *
 * `GET /ingest/<token>` lands here via a redirect in `netlify.toml`. The token
 * is validated against `INGEST_ACCESS_TOKEN`, exchanged for an httpOnly session
 * cookie, and **the response redirects to a clean URL** so the bearer
 * credential stops living in the address bar, the browser history, and the next
 * screenshot.
 *
 * Both outcomes write an `AUDIT_EVENT`. A refused token is exactly the event an
 * audit exists to record.
 */

import { extractToken, validateToken } from '../../src/shared/auth/token.js';
import { createSessionToken, sessionCookieHeader } from '../../src/shared/auth/session.js';
import { AUDIT_ACTION } from '../../src/shared/codes/index.js';
import { auditWriter, sessionSecret, snowflake, SESSION_TTL_SECONDS } from '../../src/server/env.js';

export default async function handler(request: Request): Promise<Response> {
  const token = extractToken(request);
  const audit = auditWriter();

  if (!token) return new Response('not found', { status: 404 });

  const verdict = await validateToken(snowflake(), token);
  if (!verdict.ok) {
    await audit
      .writeFor(request, { ref: 'anonymous', kind: 'token' }, {
        surface: 'ingest',
        action: AUDIT_ACTION.SESSION_REFUSED,
        entity_type: 'ingest_access_token',
        entity_id: 'unknown',
        detail: { reason: verdict.reason },
      })
      .catch(() => undefined);
    // One answer for unknown, expired and revoked. Distinguishing them tells a
    // holder of a guessed link which guess was closer.
    return new Response('not found', { status: 404 });
  }

  const { identity } = verdict;
  const session = createSessionToken(
    {
      sub: identity.person_ref,
      kind: 'token',
      surface: identity.surface === 'ingest' ? 'ingest' : 'sampler',
      crew_org_id: identity.crew_org_id,
      display_name: identity.display_name,
    },
    sessionSecret(),
    SESSION_TTL_SECONDS,
  );

  await audit.writeFor(request, { ref: identity.person_ref, kind: 'token' }, {
    surface: 'ingest',
    action: AUDIT_ACTION.SESSION_ESTABLISH,
    entity_type: 'ingest_access_token',
    entity_id: identity.token_id,
    detail: { surface: identity.surface },
  });

  return new Response(null, {
    status: 303,
    headers: {
      location: identity.surface === 'ingest' ? '/ingest' : '/enroll',
      'set-cookie': sessionCookieHeader(session, SESSION_TTL_SECONDS),
      'cache-control': 'no-store',
    },
  });
}
