# Plan-Point Ingest Tool — Spec v01

*2026-08-16 · Viridi Data · the surface Thane uses to get sample points into the system*
*Companions: `SAMPLING_APP_PLAN_v02.md`, `SCHEMA_AND_SYNC_ADDENDUM_v02.md`*

---

## 1. Why this exists and what it must not do

Pre-work item 3 in plan v01 asked where fall 2026 plan points come from. The answer is: from Thane, in a spreadsheet. This tool is that answer made durable — a separate URL where a coordinate list becomes `SAMPLE_PLAN_POINT` rows, validated, attributed, and reviewable before it commits.

**The one hard rule: an upload never creates CRM records.** Optional operation and contact columns land as *text* on the import row with a match status and a suggestion. An analyst resolves them. The alternative is that a spreadsheet quietly mints a fifty-fifth spelling of an existing grower, and the 94-clients-to-68-growers cleanup that took a hand-maintained table becomes an annual event instead of a one-off. Suggest, never create.

Everything else about this tool is a convenience decision. That one is a structural decision, and it should survive any argument about clicks.

---

## 2. Two input modes, one destination

**Paste** — a textarea that accepts a block copied straight out of Excel or Sheets (tab-separated, with or without a header row). This is what people actually do, and building it costs one clipboard parser.

**File** — drag-and-drop or picker for `.csv`, `.tsv`, `.xlsx`. First sheet by default, with a sheet picker if there is more than one.

Both land in the same staging table and the same preview. There is no third mode; a "type them in by hand" grid is a support burden pretending to be a feature.

---

## 3. Columns

| Column | Required | Notes |
|---|---|---|
| `plan_point_label` | **yes** | Thane's own point ID. Becomes `SAMPLE_PLAN_POINT.plan_point_label` — the successor to the Master Sheet's Soil Strat Point ID. Not the primary key; VCH generates that |
| `lat`, `lon` | **yes** | Decimal degrees preferred. DMS and `47°54'12.3"N` forms are detected and converted, with the original preserved |
| `boundary_id` | no | If known. Otherwise resolved by point-in-polygon |
| `field_name` | no | Free text; helps a human resolve an ambiguous point-in-polygon |
| `farmer_operation` | no | **Text only.** Fuzzy-matched to `OPERATION.legal_name`, suggested, never created |
| `contact_name`, `contact_phone`, `contact_email` | no | **Text only.** Matched to `PERSON`, suggested, never created |
| `strata_label` | no | e.g. `D3_Silty Clay` |
| `elevation_class` | no | `A_high` / `B_low` — accepts `A`/`B` and maps them, preserving the existing pairing convention |
| `sequence_no` | no | Route order within the boundary |
| `period_code` | no | Defaults from the import-level selection |
| `access_note` | no | Free text, carried to the sampler's screen |
| `prior_sample_uid` | no | True-up link, when re-sampling a known point |

**Unrecognised columns are preserved, not dropped.** They land in `PLAN_IMPORT_ROW.extra_json` and are visible in the preview under an "unmapped" group. A column someone bothered to include is information, and silently discarding it is how a tool loses trust on its second use.

---

## 4. Column mapping, and why it is nearly always zero clicks

On parse, the tool guesses the mapping from the header row using a synonym table (`latitude`/`lat`/`y`/`northing`; `point`/`point_id`/`sample_id`/`label`; and so on). The guess is shown as a compact row of chips above the preview — `Point ID ← sample_id`, `Latitude ← LAT_DD` — each a dropdown if the guess is wrong.

The accepted mapping is saved to `IMPORT_PROFILE` keyed to the user. **The second upload of the same-shaped file requires zero mapping interaction**; the chips render already-correct and collapsed behind a "mapping: matched saved profile" line. A file whose headers differ from the saved profile expands the chips automatically and says why.

Files with no header row: the tool detects this (first row parses as numbers where a header would be text) and offers positional mapping against the saved profile.

---

## 5. Validation — every rule is a badge in the preview

Validation runs client-side for anything cheap and server-side for anything requiring data. The preview table shows one row per input row, with a status chip.

**Blocking (row will not commit):**

| Rule | Note |
|---|---|
| Missing `plan_point_label`, `lat`, or `lon` | |
| Coordinate unparseable or out of range | |
| **Swapped lat/lon** | Detected when longitude is positive in a US context or when `abs(lat) > 90`. Offered as a one-click "swap all" fix rather than an error to hand-edit |
| Duplicate `plan_point_label` **within the file** | |
| Duplicate `plan_point_label` **against an existing released plan** for the same boundary and period | |

**Review (row commits, flagged):**

| Rule | Note |
|---|---|
| `POINT_OUTSIDE_BOUNDARY` — no polygon contains the point | Same defect code the sampling app uses. Usually a boundary problem, not a coordinate problem |
| Point falls in a *different* boundary than the stated `boundary_id` | |
| Two points within 2 m of each other | Below the protocol's composite radius; probably a copy-paste artefact |
| `farmer_operation` fuzzy-matches an existing operation below the confidence threshold | Shows the top three candidates with scores |
| `farmer_operation` matches nothing | Lands as text; analyst resolves |
| Contact matches no `PERSON` | Same |
| Coordinate is implausibly far from any assigned ground for the period | Catches the wrong-file upload before it becomes a crew's day |

**Advisory:** unmapped columns present; `elevation_class` values outside `A`/`B`; no `strata_label` on any row.

The header of the preview reads plainly: **"312 rows · 298 ready · 9 need review · 5 blocked."** Commit is enabled when blocked is zero, and commits the ready and review rows together — review-flagged rows are still real points a crew needs.

---

## 6. The map is the preview

A MapLibre panel beside the table renders the parsed points over the assigned boundaries. Colour by status. Hovering a table row highlights its pin and vice versa.

This is not decoration. A swapped lat/lon, a wrong-file upload, a decimal shifted one place, and a point plotted in the neighbouring county are all instantly visible on a map and effectively invisible in a table of numbers. It is the cheapest validation in the whole tool because the human does it for free.

---

## 7. Commit

One button. On commit:

1. The raw uploaded bytes (or the pasted text) are stored verbatim and content-hashed → `RAW.PLAN_IMPORT_FILE`.
2. `PLAN_IMPORT` header row written with `imported_by`, `source_filename`, `content_hash`, `row_count`, `mapping_json`, `period_code`.
3. `PLAN_IMPORT_ROW` written for every input row, including blocked ones, with its status and its resolved values. The rejected rows are part of the record.
4. `SAMPLE_PLAN` and `SAMPLE_PLAN_POINT` rows created for the committed rows, grouped by boundary.
5. Unresolved operation and contact strings raise analyst-queue items.
6. `AUDIT_EVENT` written.

**An import is never edited after commit.** A correction is a new import that supersedes rows by `plan_point_label` within the same plan, producing a new `plan_version` — same upsert-never-delete discipline as everywhere else. The "undo this import" button therefore does exactly one thing: it retires the plan version it created, and it stops working once any point in it has been sampled.

---

## 8. Tutorial branch and production branch

The tool will be used dozens of times a season by one or two people. Verbose is right exactly once.

### First run — guided, ~3 minutes, on model data

Triggered when `IMPORT_PROFILE.tutorial_completed_ts` is null for this user. Not a cookie: a new laptop should not re-teach an experienced user, and the gate living server-side is the reason even the MVP needs soft identity (§9).

Four steps against a **pre-loaded 12-row sample file containing deliberate, instructive faults**:

| Row | Fault | What it teaches |
|---|---|---|
| 3 | lat/lon swapped | The swap-all fix, and why the map catches it |
| 5 | duplicate point ID | Blocking vs review |
| 7 | operation name `"Bring Farms"` against an existing `"Ben Bring Farms LLC"` | Suggest-don't-create, and the candidate picker |
| 9 | point 400 m outside every boundary | That a flag is not a rejection |
| 11 | an unmapped column `soil_note` | That extra columns survive |

The walkthrough commits to a sandbox that is discarded, ends with a **"download the template"** button, and sets `tutorial_completed_ts`. Skippable at any point, and skipping still sets the flag — an adult who skips a tutorial has made a decision.

### Every run after — production, three clicks

Land directly on one screen: paste box and drop zone at the top, nothing else. Then:

1. **Paste or drop.** Mapping resolves from the saved profile, silently.
2. **Review** the preview table and map.
3. **Commit.**

No wizard, no steps, no modal, no confirmation dialog on top of a screen whose entire purpose is confirmation. Target: a clean 300-row file goes from clipboard to committed in under thirty seconds.

### Help without verbosity

Every validation badge is a link. Clicking `POINT_OUTSIDE_BOUNDARY` opens a two-sentence explanation and, where one exists, the relevant fragment of the tutorial against the model data. Help is pulled, never pushed. A persistent, small "Show me the walkthrough again" link sits in the footer.

**This same principle applies to the sampler app** — first-run guided capture against a demo boundary with fake points, then the 90-second production flow with contextual help only on the badges. Written down here because it is one principle, not two.

---

## 9. Auth — what the MVP does, and what it is not

**MVP: a per-user unguessable URL.** `/ingest/<32-byte token>`, issued to Thane out of band. A Netlify function validates it against `INGEST_ACCESS_TOKEN`, sets a signed httpOnly session cookie, and stamps `imported_by` from the token's identity. Tokens are rotatable, revocable, and carry an expiry.

That buys the three things the MVP actually needs: attribution on every import, server-side state for the tutorial-vs-production branch, and a surface that is not open to the internet.

**Say plainly what it is not.** A link is a bearer credential. Anyone holding it is Thane. That is an acceptable trade for one trusted contractor uploading coordinates on a six-week schedule; it stops being acceptable the moment this surface displays farmer contact information broadly or gains a second class of user. Two mitigations that cost nothing: the tool shows contact *matches* rather than the CRM's contact records, and tokens expire at the end of the season.

**Post-MVP:** the shared IdP from the July scoping doc, passkey-first, roles differentiating sampler / uploader / analyst / admin. `imported_by` becomes a real `person_id` and `INGEST_ACCESS_TOKEN` is dropped. This is a swap of the session-establishment step, not a rewrite — which is the reason to put the token behind a session cookie now rather than putting it in every request.

---

## 10. Build notes

- **All of it fits inside the Netlify app.** Parsing, mapping, and cheap validation are client-side. Point-in-polygon, fuzzy matching, and duplicate checks are one function call against Snowflake. A 300-row file is a single sub-second query; a 5,000-row file is still comfortably inside the 60-second synchronous budget.
- **`.xlsx` parsing client-side** via SheetJS, so the file never needs to reach a function at all until commit — and commit sends parsed JSON, not the workbook. The raw bytes go up separately for `RAW.PLAN_IMPORT_FILE` and are well under the 6 MB payload cap for any plausible point list.
- **Reuse the sampling app's MapLibre setup and its boundary GeoJSON endpoint.** Same codebase, different route.
- **Effort:** roughly one week on top of the sampling app's infrastructure, of which the tutorial branch is about a day and a half and the map preview about a day. Worth both.
