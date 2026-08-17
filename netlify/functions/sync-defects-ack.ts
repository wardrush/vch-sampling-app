/**
 * F0.9 stub -- `POST /v1/defects/:id/ack`. See sync-defects-open.ts: v1.5,
 * pre-declared, not implemented.
 */
export default async function handler(): Promise<Response> {
  return new Response(JSON.stringify({ error: 'not_implemented', detail: 'defect down-sync ships in v1.5' }), {
    status: 501,
    headers: { 'content-type': 'application/json' },
  });
}
