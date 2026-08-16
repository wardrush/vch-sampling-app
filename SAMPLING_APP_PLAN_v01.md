# Sampling Application — Build Plan v01

*2026-08-16 · Viridi Data · Ward Rushton*
*Companions: `SAMPLING_SCHEMA_v01.md`, `SYNC_CONTRACT_v01.md`, `ddl/`*
*Supersedes nothing. Fills in Product 1 of `2026-07-28_vch-product-scoping`, which scoped the app but did not specify it.*

---

## 0. The one-paragraph version

A contracted crew on their own Android and iOS phones drives to ground they may not have signal on for a week, works a list of analyst-planned points, records where they actually drilled and why it moved, scans a lab-printed barcode, takes three photographs, and syncs when a signal returns. Every record is created once by one person and never edited by anyone else, which means the offline problem is a durable queue rather than a merge problem. Build it as one web codebase shipped first as an installable PWA for the fall 2026 season, wrapped with Capacitor for the app stores in 2027, and running unchanged on a Zebra TC-series when that fleet arrives. The schema is the deliverable that outlives the app; the app is the thing that has to ship in six weeks.

---

## 1. Decisions locked in this session

| # | Decision | Consequence |
|---|---|---|
| D1 | **One bag per point** in v1 | `SAMPLE_BAG` still exists as its own table so a bulk-density or split-depth bag is an insert, not a migration. Cost today: one join |
| D2 | **Points are pre-planned**, with actual-vs-planned recorded | `SAMPLE_PLAN_POINT` and `SAMPLE_POINT` are separate. `offset_from_plan_m` and a coded `deviation_reason_code` are first-class, computed server-side |
| D3 | **Lab pre-prints barcodes, bound in the field** | Barcode is an opaque attribute, stored verbatim. Symbology unconfirmed — the design does not depend on it |
| D4 | **Android first, iOS parity from day one** | One web codebase. Rules out native-per-platform; the honest iOS caveats are in §4 |
| D5 | **Three required photo roles**: label, core/hole, site | Media is 1:N and role-tagged, never 1:1. Required roles come from the project spec, not from code |
| D6 | **Custody (boxing/shipping) is a later phase, seam designed now** | `SHIPMENT` tables exist, `SAMPLE_BAG.shipment_id` nullable, no v1 UI |
| D7 | **Write path host undecided — contract specified both ways** | `SYNC_CONTRACT_v01.md` is host-agnostic. Recommendation in §6 |
| D8 | **A week or more offline** | Whole-route pre-caching. Storage budget in §5 |
| D9 | **Contracted crew on their own devices (BYOD)** | No MDM. Security is app-scoped: minimal data on device, encrypted at rest, bounded offline session. §7 |
| D10 | **Structured site conditions and coded deviation reasons** are mandatory per point | Both are versioned reference data, not enum columns |
| D11 | **Depth and core count are project constants, exceptions only are captured** | `PROJECT_SAMPLING_SPEC` pushed to device. Saves two taps × ~40K samples/yr. Caveat in §11 |
| D12 | **Office-side analyst queue is the QA gate**, no crew-lead review step | The defect taxonomy and the review queue view *are* the office product for v1 |
| D13 | **True-up revisit: schema link now, navigation flow in v2** | `prior_sample_uid` populated from day one so 2027 does not need a backfill |
| D14 | **Target is the fall 2026 sampling season** | Everything below is phased against roughly six weeks |

---

## 2. What the sampler actually does

Six screens. If it needs a seventh, something in the workflow is wrong.

**1 · Today.** Assigned boundaries, sorted by the route, each with a progress ring (points sampled / planned), acres, and the access contact with a tap-to-call. Prominent, permanent: outbox count and days-until-bundle-expiry. Hand off to Google or Apple Maps for the drive — the app owns in-field positioning only, never routing.

**2 · Field.** The boundary polygon on a cached satellite basemap, planned points as pins coloured by state (pending / sampled / skipped), the sampler's live position with an accuracy ring. Tapping a pin opens capture. A long-press on bare ground opens capture as a field-added point.

**3 · Capture.** The whole screen exists to be usable in gloves, in wind, in low sun.

- GPS acquires on screen open, not on submit. Shows a live accuracy figure against the spec's threshold and a plain "close enough / not yet" state. Averages several fixes and records the spread.
- **Scan barcode** — big target, camera scanner, torch toggle. Manual entry is always available beside it, tagged `manual_entry` so the difference is permanent.
- **Three photo tiles**, each showing captured/not. Label, core, site. Tap adds more of any role; nothing caps at one.
- **Conditions** — chips from the versioned code set, multi-select, no typing.
- If the actual position is beyond the spec's block threshold from the plan point, a **deviation reason** picker appears and must be answered. Under the warn threshold it never appears at all.
- Depth and cores appear only as a single "different from spec?" affordance. Untouched in the normal case.
- **Save** writes locally and returns to the map in under a second. Sync is invisible.

**4 · Skip.** A plan point that cannot be sampled is recorded, not ignored — reason code, optional photo, optional note. An unsampled plan point that was never explicitly skipped becomes a defect at the plan's close date, which is how "we got 47 of 60 points and nobody wrote down why" stops happening.

**5 · Outbox.** Pending records, pending photo megabytes, last successful sync, a manual sync button, and per-record failure reasons. A silently stuck outbox is the failure mode that loses a season, so it is a screen rather than a spinner.

**6 · Storage.** Space used, space free, and a "reclaim uploaded photos" action. On a personal phone this is not optional politeness; it is what keeps the app installed.

---

## 3. Non-negotiable field behaviours

These are acceptance criteria, not aspirations.

- **Capture never blocks on connectivity.** No screen waits on a network call. Ever.
- **Position is captured at the moment of sampling**, not at form submit. A sampler who fills the form back at the truck must produce a record that says so — the accuracy ring and `fix_spread_m` make that visible without accusing anyone.
- **Missing data flags, it does not drop.** No GPS is a sample with `NO_GPS_FIX`, visible to an analyst in October rather than discovered in April.
- **Nothing shows as committed until acked.** The outbox count is the truth.
- **Nothing is deleted locally on sync.** Records are marked; photo bytes are evicted only by explicit action after a verified upload.
- **The app never normalizes the barcode in place.** The current lab-name corruption (`N`→`M`, dashes→spaces) is precisely what normalize-on-write produces.
- **Battery.** GPS at high accuracy continuously will not survive a ten-hour day. Poll on capture screens, coarse-poll on the map, off elsewhere. A field-measured battery number is a v1 acceptance test, not an assumption.

---

## 4. Stack — and the honest version of the iOS problem

**Recommendation: one TypeScript web codebase, shipped as an installable PWA for fall 2026, wrapped with Capacitor for the app stores in early 2027.**

| Layer | Choice | Reason |
|---|---|---|
| UI | React + TypeScript + Vite | Same skills as the existing enrollment app and the farmer dashboard demo; one hiring pool |
| Map | MapLibre GL JS | Open, no per-tile licence cost, renders offline from local tile packs |
| Offline tiles | **PMTiles** (single-file pyramid, range-read) | One file per route pack, no tile-server, resumable download, trivially versioned |
| Local database | SQLite — `wa-sqlite`/OPFS in the PWA, `op-sqlite` under Capacitor | Same SQL either way; the data layer does not change when the shell does |
| Photo bytes | OPFS (PWA) / native filesystem (Capacitor), keyed by content hash | Blobs out of the database. A 1 GB SQLite table is a bad week |
| Barcode | ZXing-js via `getUserMedia` for camera scan; Zebra DataWedge intercept for hardware imagers | Symbology-agnostic, which matters given D3 |
| Sync | Custom outbox worker (~600 lines) | The conflict surface is genuinely nil (§ `SYNC_CONTRACT` §1). A sync framework here is a dependency bought to solve a problem that does not exist |
| Shell (2027) | Capacitor | Same web code, native camera/geolocation/filesystem/background-upload, store distribution |

### Why not React Native or Flutter

Both are defensible and both cost a second codebase's worth of skills for a UI that is six screens of forms and one map. The map is the deciding factor: MapLibre GL JS with PMTiles offline is mature on the web and fiddly in both native wrappers. Worth stating out loud rather than assuming, and worth revisiting if the app grows a second workflow.

### The iOS caveats, stated plainly

An installable PWA on iOS is genuinely capable — camera, geolocation, OPFS, service worker — but three limits are real and none of them have workarounds:

1. **Storage eviction.** Safari evicts site data after roughly seven days without use. An *installed* (home-screen) PWA with `navigator.storage.persist()` granted is materially safer, but "materially safer" is not "guaranteed", and a crew that leaves the app closed over a long weekend is inside the risk window.
2. **No background sync.** Uploads only run while the app is foregrounded. Practically: a sampler must open the app and leave it open at the motel. Fixable with a plain instruction, not with code.
3. **Quota.** Roughly 60% of free disk for an installed PWA, which clears the §5 budget on any modern phone, but is enforced less predictably than Android's.

**The mitigation is not clever engineering, it is sequencing.** Run the fall 2026 pilot on Android devices, where the PWA story is unambiguous. Give iOS samplers the same PWA with a shorter sync interval and an explicit "sync before you close the app" step. Ship the Capacitor build — which removes all three limits — before the spring 2027 season, when volume makes the risk unaffordable. That is the honest recommendation: iOS has parity of *function* from day one and parity of *durability* in 2027.

### Zebra

Zebra TC-series runs Android, so the Capacitor build installs directly. Two things must be designed in now rather than retrofitted:

- **Hardware scanner input.** DataWedge delivers scans either as keystrokes into a focused input or via intent broadcast. Build the barcode field as a controlled input that accepts *either* a camera decode or an injected string, with the source recorded in `barcode_capture_method`. Doing this on day one costs nothing; doing it later means touching every capture path.
- **Physical trigger and gloved targets.** Hardware trigger keycodes map to the scan action. Minimum 48 dp touch targets throughout, which is good practice for muddy hands regardless of hardware.

Nothing else in the design changes. That is the point of one codebase.

---

## 5. Offline strategy and the storage budget

D8 permits generous local storage. Here is what "generous" actually costs, because the number turns out to be reassuring and worth having before someone designs around a fear.

**Photographs.** Capture at 1920 px long edge, JPEG quality ~0.72 — roughly 350–450 KB for a site or core photo, ~180 KB for a label. Call it **1.0 MB per sample point** for all three roles. That resolution reads a barcode label reliably and shows residue and horizon detail; the full-resolution original is discarded at capture, deliberately, because 4 MB × 40,000 samples is 160 GB a year of storage nobody queries.

| Item | Per week, one crew | Basis |
|---|---|---|
| Sample records (JSON + SQLite) | ~3 MB | ~4 KB × 720 points |
| Photographs | **~720 MB** | 1.0 MB × 720 points (120/day × 6 days) |
| Satellite tiles, z12–z17 + 500 m buffer | **~60–250 MB** | see below |
| Boundaries, plan points, reference data | <5 MB | GeoJSON for a route's fields |
| **Total** | **~0.8–1.0 GB** | |

**Tile math**, since "cache the imagery offline" usually sounds worse than it is. At 47° N, zoom 17 gives 0.815 m/px, so a 256 px tile covers 208 m — **10.74 acres**. Twenty thousand acres of assigned ground is therefore 1,861 tiles at z17 and 2,481 including the z12–z16 pyramid: **~61 MB** at ~25 KB per tile. Assigned fields are scattered rather than contiguous, so a 500 m buffer inflates that materially — call it 150–250 MB for a real route pack, still one PMTiles file downloaded once on wi-fi, versioned and resumable. Measure it against a real fall assignment before promising a number to a crew.

**Eviction policy.** Photo bytes are reclaimable only after `upload_state='uploaded'` and a server-verified content hash. The app surfaces reclaimable megabytes and asks; it never deletes silently. Records are never evicted for the life of a deployment.

**Practical guidance to the crew:** start the week with ~3 GB free. That is a sentence in a training doc, not an engineering problem.

---

## 6. The write path — a recommendation, not just an option list

The contract in `SYNC_CONTRACT_v01.md` is deliberately host-agnostic, so this can be decided late. The recommendation is nonetheless clear.

**Build a small dedicated sync service** (Cloud Run or equivalent) that owns exactly three things: the idempotent batch endpoint, signed-URL media brokering, and the assignment-bundle generator. It lands raw payloads verbatim into `RAW.SYNC_PAYLOAD` and runs the derivation pipeline into `CURATED`. Roughly a week of work.

The reasoning, and the counter-arguments:

- **Snowflake direct** is the wrong shape. Snowflake is excellent at the batch geometry and the analytics and is the warehouse of record; it is a poor fit for high-frequency small writes with binary media and signed-URL brokering. Nobody is arguing otherwise, but it should be written down.
- **The existing GCP portal API** is the real competitor and its case is genuine: reuse the auth, the ops, the on-call. The cost is coupling a field app's release cadence to the portal's, at exactly the moment the portal is also absorbing the Phase 1 enrollment work. In a six-week window, that coupling is the risk.
- **A dedicated service** keeps the seam narrow and makes the unresolved GCP-vs-Snowflake ownership question (R7 in the scoping doc) answerable later for the whole platform rather than being answered by accident, now, by whoever ships first.

This does not resolve O7. It scopes the sampling app so O7 can be resolved on its own merits.

---

## 7. Security on somebody else's phone

BYOD with a contracted crew changes the story materially, and the answer is less data rather than more control.

- **Minimal payload.** The device holds assigned boundaries, plan points, reference data, and one access contact per property — name, role, phone. No enrollment terms, no acreage economics, no credit figures, no other grower's anything. Scoped by `crew_org_id` at bundle generation, so another crew's data is not merely hidden, it is absent.
- **Encrypted at rest**, key in the platform keystore. Biometric or PIN unlock per app open — not per capture, because a sampler with cold hands re-authenticating at every hole will find a workaround, and the workaround will be paper.
- **Bounded offline session**, 14 days to start. Past `offline_valid_until` the app locks; work already captured still syncs, but no new visit can start.
- **Revocation is honest about its limits.** A phone that never returns to a network cannot be wiped. The mitigation is the 14-day window plus the fact that the worst-case exposure is a contact list for assigned fields. Say that in the crew agreement rather than implying remote wipe works on a device that is off.
- **Contractual, not technical:** the crew agreement should name the app as the system of record and prohibit parallel paper or personal-photo records, because a sampler's camera roll is the actual data-leak path here, not the database.

---

## 8. Phasing against fall 2026

Today is 16 August. Fall sampling is weeks out. What follows assumes two engineers and treats the season as immovable.

### Pre-work (this week — mostly phone calls, all blocking)

1. **Get real barcode labels from Agidata.** Symbology, format, whether they reuse across seasons. Photograph a label. Nothing in the schema depends on the answer; the scanner configuration and the lab-join date window do.
2. **Confirm the fall sampling window and crew size.** Determines how many devices, how many route packs, and whether v1 supports one crew or six.
3. **Confirm with BCarbon that exception-based depth evidence is acceptable** (§11, R2). One-column change if not, and much cheaper before the season than after.
4. **Decide the write-path host** (§6).
5. **Confirm the plan-point source.** Who produces `SAMPLE_PLAN_POINT` rows for fall 2026 — Stratas, a spreadsheet, or an analyst in QGIS — and in what format. The app is useless without them and this is not currently written down anywhere.

### v1 — pilot-ready, ~5 weeks

Weeks 1–2: schema deployed to `VCH_GEO`; sync service with batch endpoint, bundle generator, media brokering; PMTiles pack builder; PWA shell with SQLite/OPFS, auth, and bundle download.
Weeks 3–4: the six screens; GPS capture with fix averaging; barcode scan with manual fallback; camera and photo pipeline with downscale, hash, EXIF preservation; conditions and deviation UI; outbox worker.
Week 5: server derivation pipeline (PIP, TRS, offset, defect rules); the analyst review queue as a simple web list over `V_SAMPLE_REVIEW_QUEUE`; field trial on real ground with a real crew; battery and storage measurement.

**Explicitly out of v1:** shipment and custody, true-up revisit navigation, crew-lead review, in-app routing, Capacitor builds, Zebra, offline map editing, sample-plan authoring UI (plans arrive as a file).

### v1 pilot — the fall 2026 season

One or two crews, Android, a named person watching the sync dashboard daily. The purpose is to learn the field reality: how often GPS fails under canopy, how often a barcode will not scan, how far actual points really drift from planned, how much battery a real day costs, and which conditions codes nobody ever taps. Every one of those is currently a guess.

### v2 — before spring 2027

Capacitor builds for both stores and the durability they buy on iOS. True-up revisit navigation using `prior_sample_uid` and prior-visit photos. Shipment and custody. Zebra support. Plan authoring in the analyst workbench. Crew-lead in-field review, if the pilot shows the office-only gate is too slow to send anyone back to a hole.

---

## 9. What "done" means for v1

Testable, not rhetorical:

1. A device in airplane mode for **seven simulated days** captures 700 points with photographs, then syncs completely over a single 4G connection, with zero record loss and a per-record acknowledgement for every one.
2. Killing the app mid-capture loses **at most the current, uncommitted point**. Verified by force-quit during capture, twenty times.
3. A duplicate barcode, a missing GPS fix, and a point outside its boundary each produce exactly one defect row and appear in the analyst queue within a minute of sync.
4. Re-POSTing an already-accepted batch changes nothing and returns the same acknowledgement.
5. `CURATED` is dropped and rebuilt entirely from `RAW.SYNC_PAYLOAD`, producing byte-identical results.
6. A real sampler completes a real point in **under 90 seconds** including three photographs. Timed in a field, not in an office.
7. A ten-hour day on a mid-range Android costs **under 60% battery** with the app in normal use.
8. A lab result file loads and matches ≥95% of its bags on the `(lab_id, barcode, received_date)` triple, with the remainder appearing as `unmatched` rather than silently absent.

---

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Six weeks is genuinely tight** for capture + sync + server pipeline + a review queue | The pilot is one or two crews, not the whole fleet. If the schedule slips, the thing to cut is the analyst queue UI — a Snowflake view plus a spreadsheet export survives one season; a lossy capture path does not |
| R2 | **Exception-based depth evidence may not satisfy a verifier** (D11) | Confirm with BCarbon before the season. One-column change now, a re-sampling conversation later |
| R3 | **iOS PWA storage eviction** during a multi-week deployment | Pilot on Android; installed PWA + `storage.persist()` for iOS; Capacitor before spring 2027. Do not let iOS carry heavy volume this fall |
| R4 | **Barcode symbology unknown** | Design is symbology-agnostic. Still needs a real label in hand before the crew leaves, because a scanner that will not read the actual label is discovered in a field, at the worst moment |
| R5 | **BYOD storage and battery** on personal phones | Measured budget (§5) is ~1 GB/week; reclaim action in the app; battery is a v1 acceptance test |
| R6 | **Plan points may not exist in a usable form** for fall 2026 | Pre-work item 5. This is the likeliest thing to stop the pilot and it is not an engineering problem |
| R7 | **The analyst queue becomes a standing function**, not a project | Same R6 as the scoping doc. At Louisiana scale the defect queue needs a named owner and a state machine, and neither is on the engineering budget |
| R8 | **The crew works around the app** | Time a real capture (§9.6). A 90-second point is used; a three-minute point produces a notebook |

---

## 11. Open questions carried forward

1. Agidata barcode symbology and reuse policy — blocks scanner config and the lab-join date window, not the schema.
2. Whether BCarbon accepts exception-based depth and core-count evidence.
3. Source and format of fall 2026 plan points.
4. Whether `SAMPLE_POINT.boundary_id` should be nullable (schema doc §7.3).
5. Media retention policy — nothing is written, and one should exist before the first season fills the bucket.
6. `crew_org_id` — whether a contracted sampling partner belongs in the CRM layer's `OPERATION` or gets its own table. Decide alongside the Phase 1 entity model, not separately.
7. Whether the fall pilot runs against production `VCH_GEO` or an isolated schema. Recommend production, with a `is_pilot` flag on `FIELD_VISIT`, because a pilot whose data has to be migrated later is a pilot that teaches you less.
