/**
 * C8 — operation & contact fuzzy matching. Ingest spec §5, addendum §5.
 *
 * **Suggest, never create** (D16). This module never writes a CRM record; it
 * only scores existing candidates and returns the top three. The confidence
 * threshold is configuration, not a constant — addendum §5 flags this
 * explicitly because the Louisiana candidate pool is about to grow an order
 * of magnitude, and the right cutoff is a function of how many candidates
 * exist, not a fixed number chosen once.
 *
 * Scoring is a pure function with no IO, so it is exhaustively testable
 * without a warehouse. The candidate *lookup* (which table, which columns) is
 * the part that needs live schema — see `findOperationCandidates` /
 * `findContactCandidates` below and the comment on why they are a guess.
 */

import type { MatchCandidate, MatchStatus } from '../../shared/contract/ingest.js';
import type { SnowflakeClient } from '../../shared/snowflake/client.js';
import { asObjects } from '../../shared/snowflake/client.js';

export interface MatchConfig {
  /** Score >= this and it is `matched`, not merely `suggested`. */
  matchedThreshold: number;
  /** Below this, nothing is worth showing — the row is `unmatched`. */
  suggestThreshold: number;
  maxCandidates: number;
}

/**
 * Default configuration. **Not a constant to import and forget** — addendum
 * §5 names this as the thing that changes with the candidate pool's size.
 * Callers (the validate endpoint, the commit path) take a `MatchConfig` and
 * this is only the fallback when none is supplied.
 */
export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  matchedThreshold: 0.92,
  suggestThreshold: 0.55,
  maxCandidates: 3,
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const LEGAL_SUFFIXES = new Set([
  'llc', 'inc', 'incorporated', 'corp', 'corporation', 'ltd', 'lp', 'llp',
  'co', 'company', 'farms', 'farm', 'estate', 'trust',
]);

function tokens(s: string): string[] {
  return normalize(s).split(' ').filter(Boolean);
}

function significantTokens(s: string): string[] {
  const t = tokens(s);
  const kept = t.filter((tok) => !LEGAL_SUFFIXES.has(tok));
  return kept.length > 0 ? kept : t;
}

/**
 * Levenshtein distance, normalized to a 0-1 similarity. Good enough for
 * spelling variants ("Bring Farms" vs "Ben Bring Farms LLC" scores on token
 * overlap below, not this) and cheap at the row counts this tool handles.
 */
function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dp = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) dp[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  const distance = dp[b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

/** Jaccard overlap of significant tokens — catches "Bring Farms" ⊂ "Ben Bring Farms LLC". */
function tokenOverlapSimilarity(a: string, b: string): number {
  const ta = new Set(significantTokens(a));
  const tb = new Set(significantTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const tok of ta) if (tb.has(tok)) intersection += 1;
  const union = new Set([...ta, ...tb]).size;
  // A full-containment match (every token of the shorter name appears in the
  // longer one) scores as strongly as an exact match on the significant
  // tokens — "Bring Farms" is not a *weaker* match to "Ben Bring Farms LLC",
  // it is a subset match, which is exactly the case ingest spec §8 row 7 is
  // teaching the tutorial branch to catch.
  const smaller = Math.min(ta.size, tb.size);
  const containment = intersection / smaller;
  return Math.max(intersection / union, containment * 0.95);
}

/** Combined score, 0-1. Token overlap dominates for multi-word business names. */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  return Math.max(levenshteinSimilarity(na, nb), tokenOverlapSimilarity(na, nb));
}

export interface ScoredCandidate extends MatchCandidate {
  score: number;
}

export interface MatchResult {
  status: MatchStatus;
  candidates: ScoredCandidate[];
}

/** Pure scoring over an already-fetched candidate pool. No IO. */
export function scoreCandidates(
  text: string,
  pool: readonly { id: string; label: string }[],
  config: MatchConfig = DEFAULT_MATCH_CONFIG,
): MatchResult {
  const scored = pool
    .map((c) => ({ id: c.id, label: c.label, score: similarity(text, c.label) }))
    .filter((c) => c.score >= config.suggestThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.maxCandidates);

  if (scored.length === 0) return { status: 'unmatched', candidates: [] };
  return {
    status: scored[0]!.score >= config.matchedThreshold ? 'matched' : 'suggested',
    candidates: scored,
  };
}

/**
 * **Guessed table name.** No `OPERATION` table is defined in this repo's DDL
 * (`snowflake_sampling_v01.sql` / `_v02_addendum` / `_v03_entity_compat`) —
 * it is assumed to already exist in `VCH_GEO`'s Phase 1 entity model, the
 * same open question `V_BOUNDARY_ENTITY` isolates for boundaries (see
 * `snowflake_v03_entity_compat.sql`). `CURATED.OPERATION(OPERATION_ID,
 * LEGAL_NAME)` is the best-available guess from `PLAN_INGEST_SPEC_v01.md`
 * §3 (`farmer_operation` — "Fuzzy-matched to OPERATION.legal_name"). When
 * the live name is confirmed, this is the one query to edit.
 */
export async function findOperationCandidates(
  sf: SnowflakeClient,
  text: string,
  limit = 50,
): Promise<{ id: string; label: string }[]> {
  const rows = asObjects<{ operation_id: string; legal_name: string }>(
    await sf.execute(
      `SELECT OPERATION_ID, LEGAL_NAME
         FROM CURATED.OPERATION
        WHERE LEGAL_NAME ILIKE '%' || ? || '%' OR EDITDISTANCE(LEGAL_NAME, ?) <= 4
        LIMIT ?`,
      { binds: [text, text, limit] },
    ),
  );
  return rows.map((r) => ({ id: r.operation_id, label: r.legal_name }));
}

/** Same caveat as `findOperationCandidates` — guessed against `CURATED.PERSON`. */
export async function findContactCandidates(
  sf: SnowflakeClient,
  name: string,
  limit = 50,
): Promise<{ id: string; label: string }[]> {
  const rows = asObjects<{ person_id: string; display_name: string }>(
    await sf.execute(
      `SELECT PERSON_ID, DISPLAY_NAME
         FROM CURATED.PERSON
        WHERE DISPLAY_NAME ILIKE '%' || ? || '%' OR EDITDISTANCE(DISPLAY_NAME, ?) <= 4
        LIMIT ?`,
      { binds: [name, name, limit] },
    ),
  );
  return rows.map((r) => ({ id: r.person_id, label: r.display_name }));
}
