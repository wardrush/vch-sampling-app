/**
 * Splitting a `.sql` file into statements, for the deploy runners.
 *
 * Lives here rather than in `tools/` because both `tools/deploy-ddl.ts` and
 * `./migrate-postgres.ts` need it and a `src → tools` import is backwards.
 * `tools/deploy-ddl.ts` re-exports it, so existing importers do not change.
 *
 * Splits on semicolons outside of string literals, line comments, block comments
 * and `$$ … $$` bodies. The `$$` handling is why this is not `sql.split(';')`:
 * `SP_RESOLVE_SAMPLE_BOUNDARY` in `snowflake_sampling_v01.sql` contains three
 * semicolons of its own.
 */

export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inLineComment = false;
  let inBlockComment = false;
  let inDollar = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (inDollar) {
      current += ch;
      if (ch === '$' && next === '$') {
        current += next;
        i += 1;
        inDollar = false;
      }
      continue;
    }
    if (inSingle) {
      current += ch;
      // '' is an escaped quote inside a literal, not the end of one.
      if (ch === "'" && next === "'") {
        current += next;
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch;
      continue;
    }
    if (ch === '$' && next === '$') {
      inDollar = true;
      current += ch + next;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());

  return statements.filter((s) => !isOnlyComments(s));
}

function isOnlyComments(statement: string): boolean {
  return statement
    .split('\n')
    .every((line) => line.trim() === '' || line.trim().startsWith('--'));
}

/** The first line of a statement that is not blank or a comment, for logging. */
export function firstLine(statement: string, max = 80): string {
  const line = statement.split('\n').find((l) => l.trim() && !l.trim().startsWith('--')) ?? '';
  return line.trim().slice(0, max);
}
