/**
 * A6 — the derivation pipeline, as a Netlify background function.
 *
 * Netlify routes `*-background` names to the 15-minute runtime. The payload is
 * a `sync_batch_id` and nothing else (256 KB cap), so this function's first act
 * is to read back what it needs from the warehouse.
 *
 * Returning 202 immediately is the platform's contract for background
 * functions; the work continues after the response. Failures therefore have to
 * be durable in the warehouse rather than in a status code, which is why every
 * step is idempotent and the nightly sweep can re-kick any batch.
 */

import { runDerivationPipeline } from '../../src/server/derive/pipeline.js';
import { sqlClient } from '../../src/server/env.js';

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  let body: { sync_batch_id?: string };
  try {
    body = (await request.json()) as { sync_batch_id?: string };
  } catch {
    return new Response('body is not valid JSON', { status: 400 });
  }
  if (!body.sync_batch_id) return new Response('sync_batch_id is required', { status: 400 });

  try {
    const result = await runDerivationPipeline(body.sync_batch_id, { snowflake: sqlClient() });
    // `steps_skipped` and `rules_not_run` are the interesting half of this on a
    // backend without geospatial. They are also written to
    // `CURATED.DERIVATION_RUN`, because a log line is not a record.
    console.log('derivation complete', result);
  } catch (err) {
    // Loud, and left for the nightly sweep to retry. Swallowing this would
    // leave a batch permanently un-derived with nothing pointing at it.
    console.error('derivation failed', body.sync_batch_id, err);
  }

  return new Response(null, { status: 202 });
}
