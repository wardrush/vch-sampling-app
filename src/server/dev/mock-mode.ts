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
 */
export function isMockMode(): boolean {
  return process.env.MOCK_SNOWFLAKE === '1' || !process.env.SNOWFLAKE_ACCOUNT;
}
