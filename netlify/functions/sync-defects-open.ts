/**
 * F0.9 stub -- `GET /v1/defects/open`. Defect down-sync is v1.5 (addendum
 * §4.2, plan v02 §9): it depends on the analyst queue existing and nightly
 * sync being real, both of which the pilot establishes. The endpoint is
 * pre-declared in `netlify.toml` now so the route and the client type
 * (`DefectFeedResponse`, `src/shared/contract/defects.ts`) exist before the
 * season; Lane A implements the body when v1.5 opens.
 */
export default async function handler(): Promise<Response> {
  return new Response(JSON.stringify({ error: 'not_implemented', detail: 'defect down-sync ships in v1.5' }), {
    status: 501,
    headers: { 'content-type': 'application/json' },
  });
}
