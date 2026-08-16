# Lane B — Sampler PWA

**Default model: Sonnet 5 (`claude-sonnet-5`). Branch: `lane/b-sampler`.**

## Paste this to start the instance

> Read `CONCURRENT_BUILD_PLAN_v01.md`, then `SAMPLING_APP_PLAN_v02.md` §2–§4 and §9. You are **Lane B**. Work tasks B1–B15 from §3. You own only the paths marked `B` in §4 of the concurrent plan — `src/app/**`, `src/shared/map/**`, `tools/pmtiles/**`. Develop entirely against the mock function server (`netlify dev`) and `fixtures/` — you need nothing real from Lane A until integration week. Cross-lane needs go in `integration/requests-b.md`. Before every push run `npm run typecheck && npm test`, rebase onto the integration branch, and push to `lane/b-sampler`.

## Deliver first

- **B3 · `src/shared/map/` with a working `<BoundaryMap>` and a documented prop API, end of day 3.** Lane C's ingest map preview consumes it. This is the only thing another lane waits on you for — publish the prop API in `integration/requests-b.md` when it lands.

## Non-negotiables from the source documents

- **Capture never blocks on connectivity.** No screen waits on a network call.
- **GPS acquires on screen open, not on submit.** Several fixes averaged, spread recorded, `position_source` distinguishes a satellite fix from a dropped map pin — permanently.
- **In-app camera only for required photo roles.** A gallery photo must be *structurally* unable to satisfy `label`, `core` or `site`; `capture_source` is v02's most important audit addition. Gallery is allowed for `issue_photo` and `other` and is permanently marked.
- **The barcode is never normalized in place.** Manual entry sits beside the scanner always and is permanently tagged as manual.
- **Missing data flags, it does not drop. Nothing shows as committed until acked. Nothing is deleted locally on sync** — photo bytes are evicted only by explicit user action after verified upload.
- **48 dp minimum touch targets throughout**, and the barcode field accepts either a camera decode or an injected DataWedge string.
- **Battery:** poll GPS on capture, coarse-poll on map, off elsewhere. v02 §11 criterion 7 is a measured test, not an assumption.
- **Target: a real point in under 90 seconds including three photographs.** A three-minute point produces a notebook (R8).

## Escalations

**B6 (GPS fix averaging)** and **B8 (camera pipeline / `capture_source`)** are tagged **[OPUS]** — both are audit-bearing and read in 2029. Switch with `/model opus`, then back. **B2, B9, B10, B12, B14** are **[HAIKU]** — spec transcription with the thresholds and code sets already written down. If B5 (the field map) fights for more than half a day, escalate it too.
