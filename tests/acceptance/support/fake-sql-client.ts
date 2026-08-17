/**
 * `FakeSnowflake` + the two members the SQL port added.
 *
 * `tests/support/fake-snowflake.ts` records statements and binds, which is the
 * only thing checkable without a database and — for the properties that matter
 * (idempotent keys, one parse, ordered writes, bind order) — the thing worth
 * checking. It predates `SqlClient` and has no `dialect` or `capabilities`, so
 * this subclass adds them rather than duplicating the recorder.
 *
 * It lives under `tests/acceptance/` deliberately: the shared fake is used by
 * tests this lane does not own, and widening it there would be a write outside
 * this lane's paths.
 */

import { FakeSnowflake } from '../../support/fake-snowflake.js';
import {
  POSTGRES_CAPABILITIES,
  SNOWFLAKE_CAPABILITIES,
  type SqlCapabilities,
  type SqlClient,
  type SqlDialect,
} from '../../../src/shared/db/port.js';

export class FakeSqlClient extends FakeSnowflake implements SqlClient {
  readonly dialect: SqlDialect;
  readonly capabilities: SqlCapabilities;

  constructor(dialect: SqlDialect = 'snowflake') {
    super();
    this.dialect = dialect;
    this.capabilities = dialect === 'postgres' ? POSTGRES_CAPABILITIES : SNOWFLAKE_CAPABILITIES;
  }

  /** The port-typed view. `asClient()` from the base class still returns the narrow one. */
  asSqlClient(): SqlClient {
    return this;
  }
}

/** Both backends, for a test that must hold on each. */
export const BOTH_DIALECTS: readonly SqlDialect[] = ['snowflake', 'postgres'];
