/**
 * `?` → `$1…$n`, and splitting one flat bind array across several statements.
 *
 * Callers write Snowflake's positional `?` on both backends. Rewriting it here
 * rather than in every query is what keeps the port's promise that existing call
 * sites do not change.
 *
 * The rewrite is lexical and must not touch a `?` that is not a placeholder, so
 * it tracks:
 *
 *  - `'…'` string literals, including the `''` escape
 *  - `"…"` quoted identifiers
 *  - `--` line comments and slash-star block comments
 *  - `$tag$ … $tag$` dollar-quoted bodies, including the anonymous `$$ … $$`
 *
 * ## The one thing this makes unreachable
 *
 * Postgres' jsonb **existence operators** `?`, `?|` and `?&` are indistinguishable
 * from a placeholder to any lexer, which is why `node-postgres` has the same
 * limitation. On this backend write the function forms instead:
 *
 *   `a ? 'k'`   →  `jsonb_exists(a, 'k')`
 *   `a ?| ARR`  →  `jsonb_exists_any(a, ARR)`
 *   `a ?& ARR`  →  `jsonb_exists_all(a, ARR)`
 *
 * A `?` immediately followed by `|` or `&` is therefore treated as an error
 * rather than silently rewritten into a broken query.
 */

export class PlaceholderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaceholderError';
  }
}

export interface RewriteResult {
  sql: string;
  /** How many placeholders were consumed. */
  count: number;
}

/**
 * Rewrites `?` to `$n`, numbering from `startIndex` (1-based).
 *
 * `startIndex` exists for `executeMulti`: statement two's first placeholder is
 * `$1` in its *own* query, so callers normally leave this at 1 and split the
 * binds instead. It is here for the case where a caller genuinely concatenates.
 */
export function rewritePlaceholders(sql: string, startIndex = 1): RewriteResult {
  let out = '';
  let next = startIndex;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    const following = sql[i + 1];

    // -- line comment
    if (ch === '-' && following === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // /* block comment */ — Postgres nests these, so count depth.
    if (ch === '/' && following === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // '…' literal, '' escapes an inner quote
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) {
          throw new PlaceholderError('unterminated string literal in SQL');
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // "…" quoted identifier, "" escapes an inner quote
    if (ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) {
          throw new PlaceholderError('unterminated quoted identifier in SQL');
        }
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // $tag$ … $tag$ dollar quoting. `$1` and `$foo` alone are not tags, so the
    // opening delimiter must be a full `$…$` with a tag of word characters.
    if (ch === '$') {
      const tag = dollarTagAt(sql, i);
      if (tag !== null) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) {
          throw new PlaceholderError(`unterminated dollar-quoted string ${tag} in SQL`);
        }
        const stop = close + tag.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '?') {
      if (following === '|' || following === '&' || following === '?') {
        throw new PlaceholderError(
          `SQL contains "?${following}", which cannot be distinguished from a bind ` +
            `placeholder. Use jsonb_exists / jsonb_exists_any / jsonb_exists_all instead.`,
        );
      }
      out += `$${next}`;
      next += 1;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { sql: out, count: next - startIndex };
}

/** `$$` or `$tag$` at `index`, or null when this `$` starts something else. */
function dollarTagAt(sql: string, index: number): string | null {
  if (sql[index] !== '$') return null;
  let j = index + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j += 1;
  if (sql[j] !== '$') return null;
  // `$1$` is not a tag — a tag may not start with a digit.
  const tag = sql.slice(index + 1, j);
  if (tag.length > 0 && /^\d/.test(tag)) return null;
  return sql.slice(index, j + 1);
}

/** Placeholder count without rewriting — used to split a multi-statement bind array. */
export function countPlaceholders(sql: string): number {
  return rewritePlaceholders(sql).count;
}

export interface SplitStatement<T> {
  sql: string;
  binds: T[];
}

/**
 * Splits one flat positional bind array across several statements.
 *
 * Snowflake's `executeMulti` numbers binds `1..N` across the whole joined
 * statement; Postgres needs each query to carry its own `$1..$k`. So each
 * statement consumes as many binds as it has placeholders, in order.
 *
 * A mismatch throws. It is always a caller bug, it is always cheap to find at
 * this point, and the alternative — Postgres substituting a bind from the wrong
 * statement — writes the wrong row and returns success.
 */
export function splitMultiStatementBinds<T>(
  statements: readonly string[],
  binds: readonly T[],
): Array<SplitStatement<T>> {
  const out: Array<SplitStatement<T>> = [];
  let consumed = 0;

  for (const [index, statement] of statements.entries()) {
    const { sql, count } = rewritePlaceholders(statement);
    if (consumed + count > binds.length) {
      throw new PlaceholderError(
        `statement ${index + 1} of ${statements.length} needs ${count} bind(s) but only ` +
          `${binds.length - consumed} of ${binds.length} remain`,
      );
    }
    out.push({ sql, binds: binds.slice(consumed, consumed + count) as T[] });
    consumed += count;
  }

  if (consumed !== binds.length) {
    throw new PlaceholderError(
      `${binds.length} bind(s) supplied but the ${statements.length} statement(s) ` +
        `consume ${consumed}`,
    );
  }

  return out;
}
