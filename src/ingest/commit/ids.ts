/**
 * Deterministic identity for an import.
 *
 * **This is how `/ingest/commit` is made idempotent, and it is a better answer
 * than a transaction.** Every id an import produces — the import, each row,
 * each plan, each plan point — is derived from `content_hash` + `imported_by` +
 * the resolved mapping. A double-click therefore does not need to be *detected*:
 * the second request computes the same ids, every write is a MERGE on those
 * ids, and it changes nothing.
 *
 * The alternative — generate random ids, then detect the duplicate — fails the
 * exact case it exists for, because the detection and the insert race each
 * other on precisely the double-click that motivated it.
 *
 * A *correction* is deliberately not idempotent with the original: different
 * bytes hash differently, so it is a new import producing a new `plan_version`.
 * Same upsert-never-delete discipline as everywhere else.
 */

import { createHash } from 'node:crypto';

/** Stable regardless of key order — `{a,b}` and `{b,a}` are the same mapping. */
export function canonicalMapping(mapping: Record<string, string>): string {
  const keys = Object.keys(mapping).sort();
  return JSON.stringify(keys.map((k) => [k, mapping[k]]));
}

function id(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

export function importId(
  contentHash: string,
  importedBy: string,
  mapping: Record<string, string>,
): string {
  return id('import', contentHash, importedBy, canonicalMapping(mapping));
}

export function importRowId(importIdValue: string, sourceRowNo: number): string {
  return id('import_row', importIdValue, String(sourceRowNo));
}

export function planId(importIdValue: string, boundaryId: string, periodCode: string): string {
  return id('plan', importIdValue, boundaryId, periodCode);
}

export function planPointId(importRowIdValue: string): string {
  return id('plan_point', importRowIdValue);
}

/** Matches the harness and the pipeline, so a code cannot double-raise. */
export function queueDefectId(subjectId: string, defectCode: string): string {
  return createHash('md5').update(`${subjectId}|${defectCode}`).digest('hex');
}
