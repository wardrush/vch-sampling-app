/**
 * C11 — `POST /ingest/commit`.
 *
 * Session-gated: `imported_by` comes from the signed cookie, never from the
 * request body. Attribution a caller can set is not attribution.
 */

import type { IngestCommitRequest } from '../../src/shared/contract/ingest.js';
import { commitImport } from '../../src/ingest/commit/index.js';
import { requireSession } from '../../src/shared/auth/session.js';
import { clientIp } from '../../src/shared/auth/audit.js';
import { blobStore, sessionSecret, sqlClient } from '../../src/server/env.js';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const session = requireSession(request, sessionSecret());
  if (!session) return json({ error: 'no session' }, 401);
  if (session.surface !== 'ingest') return json({ error: 'wrong surface' }, 403);

  let body: IngestCommitRequest;
  try {
    body = (await request.json()) as IngestCommitRequest;
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }
  if (!body.raw_file?.content_hash || !Array.isArray(body.rows)) {
    return json({ error: 'raw_file.content_hash and rows are required' }, 400);
  }

  const result = await commitImport(body, {
    snowflake: sqlClient(),
    blobs: await blobStore(),
    actor: {
      ref: session.sub,
      kind: session.kind,
      ip: clientIp(request),
      user_agent: request.headers.get('user-agent'),
    },
    ipHashSalt: process.env.IP_HASH_SALT ?? '',
  });

  return json(result, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
