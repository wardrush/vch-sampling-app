# FLEET.md — how to run subagents in parallel on this repository

*Companion to `CONCURRENT_BUILD_PLAN_v01.md`. That document cut the build into three
lanes for three **human-launched Claude Code instances**. This one re-cuts the same
work for **subagents spawned from a single session**, which is a different problem with
a different set of failure modes.*

**If you are an orchestrating instance about to parallelise work on this repo, read
§1–§5 before spawning anything.** If you are a subagent, your own file in
`.claude/agents/` tells you what you need; §4 and §6 here are the parts that bind you.

---

## 0. Why this exists, in one paragraph

Three separate Claude Code sessions ran this repo's first concurrent wave in August
2026. The work landed and most of it was good, but the coordination failed in three
specific ways, all recorded in the status docs: one session wrote an entire scaffold
that a later session discovered was duplicate and discarded; one session created files
named `src_shared_codes_condition.ts` **at the repository root**, flattening the
directory path into the filename, and nothing failed loudly enough to catch it; and the
F0 gate the plan depends on never actually held, because three sessions on three
branches could not see each other. Subagents fix the visibility problem — one
orchestrator sees every result — and introduce a new one, because subagents share a
single working tree. Everything below is aimed at those two facts.

---

## 1. The roster

Ten agents. Three tiers, and the tier is a claim about **what kind of wrongness the
task admits**, not about how hard it is.

| Agent | Model | Spawn it when | Owns (write) |
|---|---|---|---|
| **`schema-steward`** | opus | A wire type, device migration, or Snowflake name must change | `src/shared/{contract,db,snowflake,geo}/**`, `*.sql`, `tools/deploy-ddl.ts` |
| **`sync-spine`** | opus | Retry, idempotency, ordering, RAW persistence, media tickets, derivation | `src/sync/**`, `src/server/{sync,derive,media,storage}/**`, `netlify/functions/{sync,derive}-*`, `tests/acceptance/**` |
| **`capture-integrity`** | opus | GPS fix semantics, EXIF, `capture_source`, anything an auditor reads in 2029 | `src/app/capture/**` |
| **`pwa-screens`** | sonnet | Shell, service worker, routing, or any of the six sampler screens | `src/app/{App.tsx,shell,styles}/**`, `src/app/screens/**` *except* `skip/` and `storage/`, `src/main.tsx`, `index.html` |
| **`map-surface`** | sonnet | Anything MapLibre, PMTiles, or `<BoundaryMap>` | `src/shared/map/**`, `tools/pmtiles/**` |
| **`server-endpoints`** | sonnet | A route in `netlify.toml` has no function file yet | `src/server/{assignments,nightly,dev}/**`, `src/analyst/**`, `netlify/functions/{assignments,nightly,analyst}-*` |
| **`ingest-lane`** | haiku | Parsing, coordinates, column mapping, preview, ingest tutorial | `src/ingest/**`, `netlify/functions/ingest-*` |
| **`defect-rules`** | haiku | A code in `PENDING_A8_RULES` needs writing | `src/server/defects/rules/**` |
| **`spec-transcriber`** | haiku | Code sets, fixtures, design primitives, ERD — the decision is already written down | `src/shared/codes/**`, `src/app/components/**`, `src/app/screens/{skip,storage}/**`, `fixtures/**`, `sampling_erd.mermaid` |
| **`fleet-integrator`** | opus | A wave finished and the next one has not started | nothing under `src/` |

### The routing heuristic

Ask **"what happens if this is subtly wrong and nobody notices for a month?"**

- **A season is lost, or an audit record is unfalsifiable → opus.** Sync durability,
  the wire contract, capture provenance. These are the three things plan v02
  Appendix A names, and the reasoning is that the sampling window is annual: a defect
  found in October cannot be fixed until the following October.
- **A human looks at it and says "that's wrong" within a day → sonnet.** Screens, the
  map, endpoint plumbing. The feedback loop is short and visual, which is what makes
  the cheaper model safe here.
- **The answer is already written in a document → haiku.** Code sets, parsers with a
  fault table, defect rules with a stated threshold. This tier is only safe *because
  these documents exist* — that is the explicit bet in plan v02 Appendix A, and
  `ingest-lane` is where it gets tested.

**Escalation is a signal, not a setting.** If a haiku agent reports that it stopped
because something was unspecified, that is the tier working correctly. If the same
agent stops twice in one wave for the same reason, the task was mis-tiered — re-spawn
it at sonnet with the `model` parameter on the Agent call and note it in the wave
summary. Do not edit the agent file's default to chase one task.

---

## 2. How to actually spawn a wave

**Parallelism comes from putting multiple `Agent` calls in a single assistant message.**
Sequential calls in separate messages run sequentially and buy nothing. Concurrency is
capped at 20 by default (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`); the practical limit
here is §4's disjointness, not that number.

A wave is:

1. **Check the board.** `.claude/fleet/TASK_BOARD.md` is the live state of remaining
   work. Pick tasks whose dependencies are already satisfied.
2. **Check disjointness.** Two agents in the same wave must not own overlapping paths.
   The roster in §1 is built so that no two agents ever do — so this reduces to: do not
   spawn the same agent twice in one wave, and do not hand an agent a task outside its
   paths.
3. **Spawn them all in one message**, each with a prompt naming the specific task ids,
   the source document sections, and what "done" means for that task.
4. **Wait for all of them.** Do not start the next wave on partial results.
5. **Spawn `fleet-integrator` alone.** It runs the authoritative gate.
6. **Commit yourself** (see §5), update the board, then open the next wave.

### Prompts to subagents must carry context, because they start cold

A subagent inherits none of your conversation. A prompt of "do B4" produces an agent
that reads three documents to work out what B4 is. Name the task, the file paths, the
spec section, the definition of done, and anything the current wave has already changed
that it needs to know about.

---

## 3. The wave plan

Dependency order, not priority order. Within a wave, everything is genuinely parallel.

| Wave | Agents | Why together |
|---|---|---|
| **1 — unblock** | `map-surface` (B3 `<BoundaryMap>` + prop API) · `pwa-screens` (B1 shell/SW/OPFS) · `defect-rules` (A8) · `spec-transcriber` (B2 primitives, code-set remainder) | Four agents, zero shared paths, zero mutual dependencies. B3 and B1 are what everything downstream in the app waits on. |
| **2 — build out** | `pwa-screens` (B4 Today, B5 Field, B7 barcode, B11 Outbox) · `ingest-lane` (C1–C6, C9) · `server-endpoints` (A9 nightly pair) · `spec-transcriber` (B9, B10, B12) | All consume wave 1's outputs; none produce anything the others need. |
| **3 — join up** | `ingest-lane` (C10 map preview, C13 tutorial) · `server-endpoints` (C14 analyst queue) · `pwa-screens` (B14 sampler tutorial) · `capture-integrity` (any gap the screens exposed) | C10 needs `<BoundaryMap>` real, not stubbed. Tutorials need the screens they teach. |
| **4 — close** | `schema-steward` (A12 DDL deploy, the three schema-name fixes) · `spec-transcriber` (C15 ERD) · `sync-spine` (acceptance-test repair) | **A12 is blocked on the Snowflake service user** — three days to approve. That call should have been made before wave 1. |

**Run `fleet-integrator` between every wave.** It is one agent, it is short, and it is
the only thing that sees the tree whole.

---

## 4. The six rules

These bind every subagent. They are repeated in each agent file because an agent that
does not read this document must still obey them.

**1 · No subagent runs a git command that writes.**
Not `add`, `commit`, `push`, `checkout`, `stash`, or `restore`. Four agents writing the
same `.git/index` concurrently corrupt it, and the failure surfaces as an unrelated
error in whichever agent happens to lose the race. Read-only git (`status`, `diff`,
`log`) is fine and `spec-transcriber` is specifically required to run `git status
--short`. **The orchestrator owns the index and does every commit.**

**2 · Write-disjoint paths, enforced by §1.**
An agent writes only under the paths its own file lists. Reading anything is always
fine and always encouraged. This is the same boundary as `CODEOWNERS`, which is the
human-facing copy of it.

**3 · Shared files are orchestrator-only.**
`package.json`, `package-lock.json`, `netlify.toml`, `CLAUDE.md`, root `*.md`, and
`.claude/**` are never written by a subagent. **Dependencies in particular:** one
lockfile writer, always, because a lockfile conflict between four agents is a bad hour
and it is entirely avoidable. An agent needing a dependency says so in its report.

**4 · Cross-agent requests go in `integration/requests-<a|b|c>.md`, append-only.**
One file per lane so two appends never conflict. "I need `MediaTicket.expires_ts` as a
string" goes there; it does not go in a direct edit to `src/shared/contract/`.

**5 · A subagent's green is not evidence.**
When an agent runs `npm run typecheck && npm test`, it is testing a tree that three
other agents are still writing to. Errors from paths it does not own are noise, and a
pass proves less than it looks like it does. Agents still run the gate — it catches
their own breakage — but **the authoritative run is `fleet-integrator`'s, after the
wave is complete.** Never report a wave as green on a subagent's say-so.

**6 · Stopping beats guessing.**
Every agent file names where that agent must stop rather than decide. An unspecified
threshold, an unconfirmed table name, a missing fault handling — these get reported,
not filled in. A plausible invented value costs more to find in November than an
unfinished file costs today. This repo already does this well: see
`snowflake_v03_entity_compat.sql`, which isolates an unconfirmable name into one place
instead of guessing it in three.

---

## 5. What the orchestrator does

Only the orchestrator commits. Between waves:

```bash
npm run typecheck && npm test && npm run lint
git add -A
git commit -m "wave <n>: <what landed>"
git push -u origin claude/subagents-parallel-spawn-ct4c6m
```

Commit **per wave**, not per agent — a wave is the unit that was verified together.
Update `.claude/fleet/TASK_BOARD.md` in the same commit so the board and the tree never
disagree.

### When to reach for worktree isolation instead

Agents support `isolation: worktree`, which gives one its own git worktree and its own
`node_modules`. It is the right tool when two agents genuinely must touch the same
paths — a large refactor and a feature on the same directory — and the wrong tool for
normal waves, because you then own merging the worktrees back. **Default to the shared
tree and disjoint paths.** Reach for worktrees only when §4 rule 2 cannot be satisfied,
and say so in the wave summary.

---

## 6. Reports

Every subagent writes one file: `.claude/fleet/reports/<agent-name>-wave<n>.md`. One
file per agent per wave, so parallel writes never collide. Format and template are in
`.claude/fleet/reports/README.md`.

A subagent's final message back to the orchestrator is **not** the record — it is
summarised into a context you will later compact away. The file is the record, and
`fleet-integrator` reads the files.

---

## 7. What this cut does not buy you

- **Ten agents do not make six weeks into one.** Lane A's chain (A3 → A4 → A6 → A7) is
  strictly ordered and cannot be parallelised. Parallelism compresses the middle; the
  binding constraint becomes human review bandwidth over concurrent diffs.
- **The blocking items are still not engineering.** The Snowflake service user, Thane's
  actual spreadsheet, real Agidata barcode labels, BCarbon's answer on exception-based
  depth evidence, and the fall window and crew size. Ten agents make these *more*
  expensive to leave open, not less, because more work queues behind each one.
- **Haiku in this fleet is a bet, and `ingest-lane` is where it is settled.** If C1–C6
  come back needing rework rather than review, the bet is wrong and that lane moves to
  sonnet wholesale. Decide it on the wave-1 evidence, not in week four.
- **Model IDs** — `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001` —
  were current at 2026-08-16 per plan v02 Appendix A. The agent files use the aliases
  `opus` / `sonnet` / `haiku`, which track the current generation automatically;
  re-verify the pinned IDs before budgeting against them.
