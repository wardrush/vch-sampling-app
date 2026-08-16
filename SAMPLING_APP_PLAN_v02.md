# Sampling Application — Build Plan v02

*2026-08-16 · Viridi Data · Ward Rushton*
*Supersedes `SAMPLING_APP_PLAN_v01.md`. Companions: `SAMPLING_SCHEMA_v01.md` + `SCHEMA_AND_SYNC_ADDENDUM_v02.md`, `SYNC_CONTRACT_v01.md`, `PLAN_INGEST_SPEC_v01.md`, `ddl/`*

## Changes in v02

| Change | Where |
|---|---|
| Nightly sync is now the operational expectation; a week of offline tolerance is retained in the design | D8, §5, §10 R3 |
| Defect **down**-sync added — yesterday's flags reach the crew next morning | §9, addendum |
| Hosting settled: **Netlify**, with the real function limits worked through | §6 |
| Plan-point ingest tool added as a second surface | §7, `PLAN_INGEST_SPEC_v01.md` |
| Auth phased: token-URL MVP, shared IdP post-MVP | §8 |
| Audit trail consolidated and strengthened (EXIF, capture source, sampler, device) | §9 |
| Tutorial-branch / production-branch made a cross-cutting principle | §4.5 |
| Model recommendation for building it | Appendix A |

---

## 0. The one-paragraph version

A contracted crew on their own Android and iOS phones drives to ground with intermittent signal, works a list of points Thane uploaded from a spreadsheet, records where they actually drilled and why it moved, scans a lab-printed barcode, takes three photographs, and syncs — expected nightly, tolerated for a week. Every record is created once by one person and never edited by anyone else, so the offline problem is a durable queue rather than a merge problem. One TypeScript codebase hosted on Netlify, shipped as an installable PWA for the fall 2026 season, wrapped with Capacitor for the app stores in 2027, running unchanged on a Zebra when that fleet arrives. The schema is the deliverable that outlives the app; the app has to ship in six weeks.

---

## 1. Decisions

| # | Decision | Consequence |
|---|---|---|
| D1 | **One bag per point** in v1 | `SAMPLE_BAG` is still its own table so a BD or split-depth bag is an insert, not a migration |
| D2 | **Points pre-planned**, actual-vs-planned recorded | `SAMPLE_PLAN_POINT` and `SAMPLE_POINT` separate; offset and coded deviation reason computed server-side |
| D3 | **Lab pre-prints barcodes, bound in the field** | Opaque attribute stored verbatim; symbology unconfirmed and the design does not depend on it |
| D4 | **Android first, iOS parity from day one** | One web codebase |
| D5 | **Three required photo roles**: label, core/hole, site | Media is 1:N and role-tagged; required roles come from the project spec |
| D6 | **Custody deferred, seam designed now** | `SHIPMENT` tables exist, FK nullable, no v1 UI |
| D7 | **Hosting is Netlify** — app, functions, and MVP blob storage | §6. Media path abstracted so S3/R2 is a server-side swap |
| D8 | **Nightly sync expected; a week of offline tolerated** | Operational expectation changes, architecture does not. §5 |
| D9 | **Contracted crew (Thane) on their own devices** | No MDM. Security is minimal-data-on-device. §8 |
| D10 | **Structured conditions + coded deviation reasons** mandatory per point | Both versioned reference data |
| D11 | **Depth and core count are project constants**; exceptions only captured | `PROJECT_SAMPLING_SPEC` pushed to device |
| D12 | **Office-side analyst queue** is the QA gate | With D8, findings reach the crew next morning — §9 |
| D13 | **True-up: schema link now, navigation in v2** | `prior_sample_uid` populated from day one |
| D14 | **Fall 2026 sampling season** is the target | ~6 weeks |
| D15 | **Plan points arrive via an ingest tool**, not an analyst hand-building rows | `PLAN_INGEST_SPEC_v01.md`. Separate URL for Thane |
| D16 | **Uploads never create CRM records** | Operation and contact strings are suggested and analyst-resolved, never minted |
| D17 | **Auth is phased**: token URL for MVP, shared IdP after | §8 |
| D18 | **Every surface has a first-run tutorial branch and a minimal-click production branch** | §4.5 |

---

## 2. What the sampler does

Six screens. A seventh means something in the workflow is wrong.

**1 · Today.** Assigned boundaries sorted by route, each with a progress ring, acres, and a tap-to-call access contact. Permanently visible: outbox count, days until bundle expiry, and — new in v02 — **yesterday's flags**, any defect the server raised overnight on work still within driving distance. Hand off to Google or Apple Maps for the drive; the app owns in-field positioning only.

**2 · Field.** Boundary polygon on a cached satellite basemap, planned points coloured by state, live position with an accuracy ring. Tap a pin to capture; long-press bare ground for a field-added point.

**3 · Capture.** Usable in gloves, in wind, in low sun.

- GPS acquires on screen open, not on submit. Live accuracy against the spec threshold, several fixes averaged, spread recorded.
- **Scan barcode** — large target, torch toggle, manual entry always beside it and permanently tagged as such.
- **Three photo tiles** — label, core, site. Tap adds more of any role; nothing caps at one. **In-app camera only for required roles** (§9).
- **Conditions** — chips from the versioned code set. No typing.
- Beyond the spec's block threshold from plan, a **deviation reason** picker appears and must be answered. Under the warn threshold it never appears.
- Depth and cores appear only behind a single "different from spec?" affordance.
- **Save** writes locally and returns to the map in under a second.

**4 · Skip.** A plan point that cannot be sampled is recorded with a reason code, optional photo, optional note. An unsampled point never explicitly skipped becomes a defect at the plan's close date.

**5 · Outbox.** Pending records, pending photo megabytes, last successful sync, manual sync, per-record failure reasons. A silently stuck outbox is the failure mode that loses a season, so it is a screen rather than a spinner.

**6 · Storage.** Used, free, and "reclaim uploaded photos."

---

## 3. Non-negotiable field behaviours

- **Capture never blocks on connectivity.** No screen waits on a network call.
- **Position is captured at the moment of sampling**, not at form submit.
- **Missing data flags, it does not drop.**
- **Nothing shows as committed until acked.**
- **Nothing is deleted locally on sync.** Records are marked; photo bytes evicted only by explicit action after verified upload.
- **The barcode is never normalized in place.**
- **Battery:** GPS high-accuracy continuously will not survive ten hours. Poll on capture, coarse-poll on map, off elsewhere. Measured, not assumed (§11.7).

---

## 4. Stack

**One TypeScript web codebase, shipped as an installable PWA for fall 2026, wrapped with Capacitor for the stores in early 2027.**

| Layer | Choice | Reason |
|---|---|---|
| UI | React + TypeScript + Vite | Same skills as the enrollment app and the dashboard demo |
| Hosting | **Netlify** — static app, Functions, Blobs | §6 |
| Map | MapLibre GL JS | Open, no per-tile licence, renders offline from local packs |
| Offline tiles | PMTiles | One versioned file per route pack, range-read, no tile server |
| Local database | SQLite — `wa-sqlite`/OPFS in the PWA, `op-sqlite` under Capacitor | Same SQL either way |
| Photo bytes | OPFS / native filesystem, keyed by content hash | Blobs out of the database |
| Barcode | ZXing-js via `getUserMedia`; DataWedge intercept for Zebra imagers | Symbology-agnostic |
| Spreadsheet parse | SheetJS, client-side | Ingest tool; the workbook never needs to reach a function |
| Sync | Custom outbox worker (~600 lines) | The conflict surface is nil; a sync framework here buys a solution to a problem that does not exist |
| Shell (2027) | Capacitor | Same web code, native camera/geolocation/filesystem/background upload, store distribution |

### 4.1 Why not React Native or Flutter

Both are defensible and both cost a second codebase's worth of skills for six screens of forms and one map. The map decides it: MapLibre GL JS with offline PMTiles is mature on the web and fiddly in both wrappers. Worth revisiting if the app grows a second workflow.

### 4.2 The iOS caveats, and how nightly sync changes them

Three real limits, none with a workaround: Safari evicts site data after roughly seven days of non-use; there is no background sync, so uploads run only while the app is foregrounded; and quota is enforced less predictably than Android's.

**Nightly sync largely defuses the first.** A device opened and synced daily never approaches the eviction window. That moves iOS from "carries no volume this fall" to "viable in the pilot" — conditional on the nightly assumption actually holding, which is why the week of tolerance stays in the design. Foregrounded-upload still means a sampler opens the app at the motel and leaves it open; that is a line in a training doc, not a code problem. The Capacitor build removes all three and should ship before spring 2027, when volume makes the risk unaffordable.

### 4.3 Zebra

Zebra TC-series runs Android, so the Capacitor build installs directly. Two things designed in now rather than retrofitted: the barcode field is a controlled input accepting **either** a camera decode **or** an injected DataWedge string, with the source recorded in `barcode_capture_method`; and 48 dp minimum touch targets throughout, which is right for muddy hands regardless of hardware. Nothing else changes — that is the point of one codebase.

### 4.4 Storage budget

Photographs captured at 1920 px long edge, JPEG ~0.72 — roughly 350–450 KB for site and core, ~180 KB for a label. **~1.0 MB per sample point.** Full-resolution originals are discarded at capture, deliberately: 4 MB × 40,000 samples is 160 GB a year of storage nobody queries.

| | Nightly sync (steady state) | Week of tolerance (worst case) |
|---|---|---|
| Records | <1 MB | ~3 MB |
| Photographs | ~120 MB | ~720 MB |
| PMTiles route pack | 150–250 MB (kept, not re-fetched) | 150–250 MB |
| **Total in flight** | **~150–400 MB** | **~0.9–1.0 GB** |

Tile arithmetic, since "cache the imagery" sounds worse than it is: at 47° N, z17 gives 0.815 m/px, so a 256 px tile covers 208 m — **10.74 acres**. Twenty thousand acres is 1,861 tiles at z17 and 2,481 across the z12–z17 pyramid: **~61 MB** at ~25 KB/tile. Scattered fields with a 500 m buffer inflate that to a realistic 150–250 MB per route pack. Measure it against a real fall assignment before promising a crew a number.

**Keep route-level tile packs even under nightly sync.** Re-fetching 200 MB nightly over a motel connection is worse than storing it once.

**Guidance to the crew:** start the week with ~3 GB free. A sentence in a training doc, not an engineering problem.

### 4.5 Tutorial branch and production branch — a cross-cutting principle

Both surfaces get used dozens of times a season. Verbose is right exactly once.

- **First run** is guided, ~3 minutes, against **model data with deliberate, instructive faults**, and ends by setting a server-side `tutorial_completed_ts`. Server-side, not a cookie: a new phone or laptop must not re-teach an experienced user, and that requirement is one of the reasons even the MVP needs soft identity (§8).
- **Every run after** lands directly on the working screen. Ingest: paste → review → commit, three clicks, under thirty seconds for a clean file. Sampler: tap pin → capture → save, under ninety seconds including three photographs.
- **Help is pulled, never pushed.** Every validation badge and defect chip is a link to a two-sentence explanation and, where one exists, the matching fragment of the tutorial. A small permanent "show me again" link, and nothing else.
- Skipping the tutorial still sets the flag. An adult who skips a tutorial has made a decision.

The ingest tool's model dataset is specified in `PLAN_INGEST_SPEC_v01.md` §8. The sampler app's equivalent is a demo boundary with six fake points, one of which has a deliberately unreadable barcode.

---

## 5. Sync: nightly expected, a week tolerated

**Nothing in the schema or the sync contract changes because of the nightly assumption.** Client-generated UUIDv7, the outbox, idempotent batch upsert, JSON-before-media, two-phase media — all of it is required for one unreliable nightly sync exactly as much as for a deferred one. A nightly sync that fails at a motel with no wifi is a two-night backlog, and the machinery that drains a two-night backlog is the machinery that drains a seven-day one.

What changes is the **operational expectation**, and three consequences follow:

1. **Storage becomes a non-issue** rather than an ask (§4.4). On a contractor's personal phone that matters.
2. **iOS becomes viable in the pilot** (§4.2).
3. **The feedback loop is the real prize** (§9). Overnight defect detection puts yesterday's problems in front of the analyst by 7am, while the crew is still within driving distance of yesterday's fields — converting D12's office-only gate from "discovered in April" to "re-drilled tomorrow," which is most of what a crew-lead review step would have bought without building one.

**What to protect against.** Designing *for* nightly sync means designing *against* multi-day offline, and the failure mode is someone building a "must sync to continue" gate, or sizing the device budget so tightly that a three-day communications gap fills it. The week of slack costs approximately zero engineering — same code paths, different constant — and buying it back later costs a season. Bundle expiry and the offline auth window may shorten from 14 days to 10; neither should go to 2.

---

## 6. Hosting on Netlify — the constraints worked through

Netlify hosts the static app, the functions, and the MVP object storage. The limits are specific and two of them shape the design, so they are written out rather than discovered later.

| Limit | Value | What it means here |
|---|---|---|
| Synchronous function execution | 60 s, not configurable | Fine. A sync batch or a 5,000-row validation query is sub-second to a few seconds |
| Background function execution | 15 min | Where the post-sync derivation pipeline lives |
| Scheduled function execution | 30 s | Too tight for real work — the nightly job kicks a background function rather than doing the work itself |
| Buffered request/response payload | **6 MB** | Batch cap of 2 MB (already in the contract) sits well inside it |
| Binary payload after base64 | **~4.5 MB effective** | A ~400 KB photo encodes to ~533 KB. Comfortable |
| Background function payload | 256 KB | The derivation trigger passes a `sync_batch_id`, never the data |
| Function memory | 1024 MB default, 4096 MB max | Default is enough |
| Netlify Blobs object size | 5 GB | Far beyond need |
| Netlify Blobs upload path | **No direct browser upload — bytes must pass through a function** | The one constraint that matters. See below |

### 6.1 The three paths

**Records → Snowflake, via the SQL API v2 with key-pair JWT auth.** Stateless, no driver, no connection pool to keep warm across cold starts, no VPC. This is the right shape for a function-per-request runtime and it means `VCH_GEO` stays the warehouse of record with no second database introduced.

**Raw payloads → Netlify Blobs, content-addressed**, then batched into `RAW.SYNC_PAYLOAD`. The verbatim-raw discipline survives the move to serverless intact.

**Photos → Netlify Blobs for the MVP, through a function.** At ~533 KB base64 this fits comfortably. It is genuinely Netlify-only, which is what was asked for.

### 6.2 The honest limit on that third path

Every photo byte transits a function's bandwidth, and there is no resumable upload through a function — a connection dropped at 80% restarts from zero. At 400 KB that is tolerable. At 40,000 samples × 3 photos = **120,000 objects a year**, it is not the shape you want.

**This costs nothing to defer, because the contract already has the seam.** `SYNC_CONTRACT` §4 returns a *ticket containing a URL*; the client does not know or care whether that URL points at a Netlify function or an S3/R2 presigned PUT. So: ship the MVP on Blobs, swap to presigned direct-to-object-store when the pilot proves volume, and **the app does not change** — it is a server-side change behind an interface that already exists. Put the swap in the v2 list and do not let it hold up the season.

### 6.3 What lives where

```
Netlify static      the PWA, the ingest tool (same codebase, different routes)
Netlify Functions   /sync/batch  /sync/media  /assignments/bundle
                    /ingest/validate  /ingest/commit
Netlify Background  post-sync derivation pipeline (PIP, TRS, offset, defect rules)
Netlify Scheduled   nightly: unsampled-point sweep, plan close, kicks background
Netlify Blobs       RAW payloads; photo bytes (MVP only)
Snowflake VCH_GEO   everything curated, all geometry, all analytics
S3 / R2             photo bytes, post-MVP, behind the same ticket interface
```

---

## 7. The second surface: plan-point ingest

Full spec in `PLAN_INGEST_SPEC_v01.md`. In brief: a separate URL where Thane pastes an Excel block or drops a CSV/XLSX, sees a validated preview beside a map, and commits — producing `SAMPLE_PLAN_POINT` rows with attribution. Required columns are point ID, latitude, longitude; optional columns include operation, contact, strata, elevation class, and access notes.

Two structural rules carry beyond the tool:

- **An upload never creates CRM records** (D16). Operation and contact strings are fuzzy-matched, suggested, and analyst-resolved. Otherwise a spreadsheet quietly mints a fifty-fifth spelling of an existing grower, and the 94-clients-to-68-growers cleanup becomes an annual event.
- **An import is never edited after commit.** A correction is a new import producing a new `plan_version`. Same upsert-never-delete discipline as everywhere else.

Roughly one week on top of the sampling app's infrastructure, and it removes the single likeliest blocker to the pilot.

---

## 8. Auth, phased

**MVP — per-user token URL.** `/ingest/<32-byte token>` for the ingest tool; device enrolment for the sampler app uses the same mechanism. A function validates the token, sets a signed httpOnly session cookie, and stamps `imported_by` / `enrolled_by`. Rotatable, revocable, season-expiring.

This buys the three things the MVP actually needs: attribution on every write, server-side state for the tutorial-vs-production branch, and a surface that is not open to the internet.

**Say plainly what it is not.** A link is a bearer credential; anyone holding it is Thane. Acceptable for one trusted contractor uploading coordinates on a six-week schedule. Not acceptable once the surface displays farmer contact data broadly or gains a second class of user. Two mitigations that cost nothing: show contact *matches* rather than CRM records, and expire tokens at season end.

**Post-MVP — the shared IdP** from the July scoping doc, passkey-first, roles differentiating sampler / uploader / analyst / admin. `imported_by` becomes a real `person_id`, the token table is dropped. This is a swap of the session-establishment step, not a rewrite — which is precisely why the token is exchanged for a session cookie now rather than being carried in every request.

**On the sampler side the phasing is different**, because a BYOD device offline for days cannot re-authenticate: enrolment happens online once, the device holds an encrypted refresh token and an offline session with a hard `offline_valid_until`, unlock is biometric or PIN per app open (never per capture — a sampler with cold hands re-authenticating at every hole will find a workaround, and the workaround will be paper), and revocation is a sync-time refusal plus a self-wipe instruction. A phone that never returns to a network cannot be wiped; the mitigation is the bounded window plus the fact that the only person data on it is a contact name and phone for assigned properties. Say that in the crew agreement rather than implying remote wipe works on a device that is off.

---

## 9. Audit trail

The chain has to answer, in 2029, which hole produced a given credit and who was standing over it. Most of this was already in the schema; v02 closes three gaps.

**Already present:** `sample_uid` generated at capture; sampler, device, and sync batch on every row; device and server timestamps both preserved plus `device_uptime_ms` so a changed clock is detectable rather than silent; GPS accuracy, provider, fix count and spread; `position_source` distinguishing a satellite fix from a dropped map pin, permanently; EXIF latitude, longitude and timestamp preserved verbatim on every photo, plus the full `EXIF_RAW`; content hashes addressing every object; raw device payloads stored verbatim.

**Added in v02:**

- **`MEDIA.capture_source`** — `in_app_camera` vs `device_gallery`. This is the single most important audit distinction in the media table and it was missing. A photograph picked from the camera roll is not evidence of having been at the hole. **Required photo roles accept in-app camera only**; gallery selection is permitted for `issue_photo` and `other`, and is permanently marked.
- **`MEDIA.device_id`** — so a photograph's provenance stands on its own without traversing to its parent sample.
- **`DEVICE.device_model`, `manufacturer`, `user_agent_raw`** — "an Android phone" is not a device record.
- **`CURATED.AUDIT_EVENT`** — a server-side actor log for the surfaces that are not the sampling app: who committed which import, who resolved which defect, who enrolled or revoked which device, who released which plan. The sampling app's own attribution is on the rows themselves; the office-side surfaces need somewhere to write.

**And the EXIF-vs-GPS comparison is a rule, not decoration.** `EXIF_POSITION_MISMATCH` fires when a photo's own fix disagrees with the app's fix by more than a threshold. Two independent position sources that disagree is a finding; two that agree is corroboration worth having.

**Defect down-sync**, new in v02: `GET /v1/defects/open?crew_org_id=…` returns defects raised overnight against this crew's recent work, rendered as "yesterday's flags" on the Today screen with a revisit affordance on affected points. This is what makes D12's office-only gate workable — and it only pays off if nightly sync is real, so it lands in v1.5, after the analyst queue exists.

---

## 10. Phasing

Today is 16 August. Two engineers, season immovable.

### Pre-work — this week, mostly phone calls, all blocking

1. **Real barcode labels from Agidata** — symbology, format, cross-season reuse.
2. **BCarbon confirmation** that exception-based depth and core evidence is acceptable rather than per-sample attestation. One column if not, and far cheaper now.
3. **Fall sampling window and crew size** — device count, route packs, one crew or six.
4. ~~Where plan points come from~~ — **answered by D15**. Still needs Thane's actual current spreadsheet as the column-mapping fixture.
5. **Snowflake service user with key-pair auth** for the SQL API, plus the network policy that permits it.

### v1 — pilot-ready, ~6 weeks

Weeks 1–2: schema deployed to `VCH_GEO`; Netlify functions for batch sync, bundle generation and media; Snowflake SQL API integration; PMTiles pack builder; PWA shell with SQLite/OPFS, token enrolment, bundle download.
Weeks 3–4: the six sampler screens; GPS capture with fix averaging; barcode scan with manual fallback; camera pipeline with downscale, hash, EXIF preservation and `capture_source`; conditions and deviation UI; outbox worker.
Week 5: **ingest tool** — paste and file parse, mapping with saved profiles, validation, map preview, commit, tutorial branch.
Week 6: server derivation pipeline as a background function; analyst review queue as a simple list over `V_SAMPLE_REVIEW_QUEUE`; field trial on real ground with a real crew; battery and storage measurement.

**Explicitly out of v1:** custody and shipment, true-up revisit navigation, crew-lead review, in-app routing, Capacitor builds, Zebra, S3 media swap, defect down-sync, real IdP, plan authoring beyond upload.

### Pilot — the fall 2026 season

One or two crews, Android-led with iOS permitted given nightly sync, a named person watching the sync dashboard daily. The purpose is to learn the field reality: how often GPS fails under canopy, how often a barcode will not scan, how far actual points really drift from planned, how much battery a real day costs, how often nightly sync actually happens, and which condition codes nobody ever taps. Every one of those is currently a guess.

### v1.5 — during or just after the season

Defect down-sync and "yesterday's flags." S3/R2 media swap if volume warrants. Whatever the pilot's first week makes obvious.

### v2 — before spring 2027

Capacitor builds for both stores. True-up revisit navigation using `prior_sample_uid` and prior-visit photos. Shipment and custody. Zebra. Shared IdP. Plan authoring in the analyst workbench. Crew-lead in-field review, if the season shows the office gate is too slow even at overnight turnaround.

---

## 11. What "done" means for v1

Testable, not rhetorical.

1. A device in airplane mode for **seven simulated days** captures 700 points with photographs, then syncs completely over one 4G connection with zero record loss and a per-record acknowledgement for every one.
2. Killing the app mid-capture loses **at most the current, uncommitted point**. Verified by force-quit during capture, twenty times.
3. A duplicate barcode, a missing GPS fix, and a point outside its boundary each produce exactly one defect row and reach the analyst queue within a minute of sync.
4. Re-POSTing an already-accepted batch changes nothing and returns the same acknowledgement.
5. `CURATED` is dropped and rebuilt entirely from `RAW`, byte-identical.
6. A real sampler completes a real point in **under 90 seconds** including three photographs. Timed in a field.
7. A ten-hour day on a mid-range Android costs **under 60% battery**.
8. A lab result file matches **≥95%** of its bags on `(lab_id, barcode, received_date)`, with the remainder appearing as `unmatched` rather than silently absent.
9. **Ingest:** a 300-row clean file goes clipboard → committed in **under 30 seconds** with no mapping interaction on the second use.
10. **Ingest:** a file with swapped lat/lon is caught before commit and fixed in one click.
11. **Audit:** a photograph selected from the gallery cannot satisfy a required photo role, and is permanently marked when attached to an optional one.

---

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Six weeks is tight** for capture + sync + pipeline + ingest + review queue | Pilot is one or two crews. If it slips, cut the analyst queue UI — a Snowflake view and a spreadsheet export survive one season; a lossy capture path does not |
| R2 | **Exception-based depth evidence may not satisfy a verifier** | Confirm with BCarbon before the season |
| R3 | ~~iOS PWA eviction~~ **downgraded** — nightly sync keeps devices well inside the eviction window | Retain the week of tolerance so the assumption failing is a delay, not a loss. Capacitor before spring 2027 |
| R4 | **Barcode symbology unknown** | Design is symbology-agnostic; still needs a real label in hand before the crew leaves |
| R5 | **BYOD storage and battery** | ~150–400 MB steady state under nightly sync; reclaim action in-app; battery is an acceptance test |
| R6 | ~~Plan points may not exist~~ — **addressed by the ingest tool**, but it must be built inside the six weeks and Thane's real file is needed as a fixture | Week 5. Get the file now |
| R7 | **The analyst queue becomes a standing function**, not a project | At Louisiana scale the defect queue needs a named owner and a state machine. Not on the engineering budget |
| R8 | **The crew works around the app** | Time a real capture. A 90-second point gets used; a three-minute point produces a notebook |
| R9 | **Netlify function bandwidth on media at scale** | Known and quantified (§6.2). The swap is server-side behind an existing interface. Do not let it hold the season |
| R10 | **Token URLs are bearer credentials** | Bounded to one trusted contractor and a season. Real IdP is post-MVP, and the session-cookie exchange makes it a swap rather than a rewrite |

---

## 13. Open questions carried forward

1. Agidata barcode symbology and reuse policy.
2. Whether BCarbon accepts exception-based depth and core evidence.
3. Nullable `SAMPLE_POINT.boundary_id` vs a `BOUNDARY_UNKNOWN` sentinel.
4. Media retention policy — nothing written, and the first season fills the bucket.
5. `crew_org_id` — CRM `OPERATION` or its own table. Decide with the Phase 1 entity model.
6. Whether the pilot runs against production `VCH_GEO` (recommended, with `IS_PILOT` on `FIELD_VISIT`) or an isolated schema.
7. Snowflake-vs-GCP write-path ownership (R7 in the July scoping doc). **Netlify + the Snowflake SQL API scopes around it for this product** rather than resolving it; the platform question remains open.

---

## Appendix A — which Claude model to build this with

Short answer: **Opus 5 for the load-bearing parts, Sonnet 5 for the bulk, Haiku 4.5 for scoped work under a written spec.** Haiku alone would be a false economy on a six-week schedule; Haiku *as part of the mix* is real savings, and this project is unusually well-suited to it because the specs now exist.

| Model | API ID | Price in/out per MTok | Use it for |
|---|---|---|---|
| Opus 5 | `claude-opus-5` | $5 / $25 | The offline sync worker and its idempotency and ordering semantics; the Snowflake derivation pipeline; schema migrations; anything where a subtle bug is discovered in April |
| Sonnet 5 | `claude-sonnet-5` | $2 / $10 | The bulk: the six screens, the ingest UI, the validation rules, the MapLibre and PMTiles work, tests |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | $1 / $5 | Scoped pieces with a spec in front of them: the CSV/TSV parser, individual validation rules, form components, test fixtures, the tutorial's model dataset, DDL boilerplate |

**Could Haiku do the whole thing?** For the parts that are transcription from a written spec — most of the ingest tool, most of the forms — yes, and cheaply. For three areas, no: the offline sync worker (idempotency, ordering, partial-ack handling, backoff — where "plausible but subtly wrong" is exactly the failure mode a smaller model produces and exactly the failure mode that loses a season's data), the server-side derivation pipeline, and any decision about the schema. Haiku's 200k context is also short for holding the schema, the contract, and the app code at once, which matters more on this build than raw capability does.

**The real constraint is not tokens, it is six weeks.** Optimise for fewer wrong turns, not for cost per token — a day lost to a subtly wrong sync worker costs more than the entire model spend for the project. The practical pattern: Opus writes the spec and the load-bearing code, Sonnet builds against it, Haiku fills in the pieces where the spec is already unambiguous. The documents in this folder are that spec, which is what makes the cheap tier usable at all.

*Model IDs and prices from Anthropic's model overview, checked 2026-08-16; verify before budgeting.*
