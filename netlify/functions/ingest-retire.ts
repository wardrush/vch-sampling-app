/**
 * C12 — `POST /ingest/retire/{import_id}`. `netlify.toml` forwards the
 * `:import_id` redirect placeholder as a query parameter (Netlify's default
 * for a named placeholder not reused in the `to` path).
 */
import type { IngestRetireRequest } from '../../src/shared/contract/ingest.js';
import { retireImport } from '../../src/ingest/retire/index.js';
import { requireSession } from '../../src/shared/auth/session.js';
import { clientIp } from '../../src/shared/auth/audit.js';
import { sessionSecret, sqlClient } from '../../src/server/env.js';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const session = requireSession(request, sessionSecret());
  if (!session) return json({ error: 'no session' }, 401);
  if (session.surface !== 'ingest') return json({ error: 'wrong surface' }, 403);

  const url = new URL(request.url);
  const importId = url.searchParams.get('import_id');
  if (!importId) return json({ error: 'import_id is required' }, 400);

  let reason: string | null = null;
  try {
    const body = (await request.json()) as Partial<IngestRetireRequest>;
    reason = body.reason ?? null;
  } catch {
    /* an empty body is fine -- reason is optional */
  }

  const result = await retireImport(
    { import_id: importId, reason },
    {
      snowflake: sqlClient(),
      actor: {
        ref: session.sub,
        kind: session.kind,
        ip: clientIp(request),
        user_agent: request.headers.get('user-agent'),
      },
      ipHashSalt: process.env.IP_HASH_SALT ?? '',
    },
  );

  return json(result, result.outcome === 'refused' ? 409 : 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
