/**
 * F0.8 -- the remaining half of the mock function server.
 *
 * By the time this lane opened, A1/A4/A5/A6/A10/C11 were already real and
 * require live Snowflake credentials (env.ts fails loudly without them, by
 * design). The endpoints still to build here (A2, A9, C7, C8, C12, C14) do
 * the same in production, but each checks `isMockMode()` first and serves
 * fixture-backed data instead -- so `netlify dev` with no `SNOWFLAKE_*` env
 * vars at all still serves every one of them, which is the property B and C
 * actually needed from F0.8.
 *
 * **This used to key directly on `SNOWFLAKE_ACCOUNT`.** That broke the day a
 * second backend existed: with the Postgres backend selected (the entire
 * MVP/UAT configuration) there are no Snowflake credentials either, so the old
 * check read `true` and every endpoint that consulted it served fixtures
 * forever -- the Netlify database was never reached. Deferring to
 * `sqlBackend()` (`src/server/env.ts`, owned by `schema-steward`) fixes that
 * while keeping every existing property: `MOCK_SNOWFLAKE=1` still forces mock,
 * and a bare checkout with nothing configured still resolves to `mock` (see
 * `sqlBackend()`'s resolution order, step 5) so `netlify dev` and the test
 * suite keep working with no env vars at all.
 */
import { sqlBackend } from '../env.js';

export function isMockMode(): boolean {
  return sqlBackend() === 'mock';
}
