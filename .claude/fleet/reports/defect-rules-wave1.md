# defect-rules — wave 1

**Tasks:** A8 (six defect rules from `PENDING_A8_RULES`)
**Gate:** `npm run typecheck && npm test` → PASS (116 tests, including 22 new defect-rule tests)
(Note: this ran against a tree other agents were still writing to. See FLEET.md §4.5.)

## Landed

| Code | Files | What it does |
|---|---|---|
| **MISSING_REQUIRED_MEDIA** | `missing-required-media.ts` | Flags when a required photo role (defined in `PROJECT_SAMPLING_SPEC.REQUIRED_MEDIA_ROLES`) is absent from a sample. Severity: blocking. The rule iterates over samples, loads their spec, and checks that all required roles have at least one media entry. |
| **OFFSET_EXCEEDED_NO_REASON** | `offset-exceeded-no-reason.ts` | Flags when a sample's distance from the plan point exceeds the spec's `MAX_PLAN_OFFSET_M_BLOCK` threshold AND no `DEVIATION_REASON_CODE` was recorded. Severity: review. Visible to field: false (crew cannot act; reason must be provided at capture). |
| **MEDIA_GALLERY_SOURCED** | `media-gallery-sourced.ts` | Flags when a required photo role was sourced from the device gallery (`CAPTURE_SOURCE = 'device_gallery'`) instead of the in-app camera. Severity: review. Gallery photos are not evidence of being at the location at capture time. |
| **DEPTH_SHORTFALL** | `depth-shortfall.ts` | Flags when a recorded depth (`DEPTH_ACHIEVED_CM`, exception-only) is less than the spec's minimum depth (`DEPTH_BOTTOM_CM`). Severity: review. Visible to field: true (crew can see and may re-drill). |

### Tests

All four rules are covered by 22 tests in `tests/unit/defect-rules.test.ts`:
- **MISSING_REQUIRED_MEDIA:** 5 tests (fires on missing role, doesn't fire on complete set, handles specs with no required roles, allows multiple photos per role, handles missing spec)
- **OFFSET_EXCEEDED_NO_REASON:** 6 tests (fires on exceeded threshold without reason, doesn't fire when within threshold, doesn't fire when reason provided, handles null offset, handles missing spec, handles missing plan point)
- **MEDIA_GALLERY_SOURCED:** 5 tests (fires on gallery source for required role, doesn't fire for in-app camera, doesn't fire for optional roles, doesn't fire for media not attached to sample, flags multiple gallery photos)
- **DEPTH_SHORTFALL:** 6 tests (fires on shortfall, doesn't fire when depth meets minimum, doesn't fire on exceeding minimum, doesn't fire when depth is null, handles missing spec, handles null depth bottom)

## Contract or interface changes others need

None. All four rules conform to the existing `DefectRule` interface. The updated `index.ts` exports are internal to this module.

## Stopped, and why

Two of the six rules in `PENDING_A8_RULES` remain unimplemented:

### CLOCK_DRIFT_SUSPECTED
- **Blocker:** No drift tolerance threshold specified.
- **Where to find it:** Not in `SYNC_CONTRACT_v01.md` §6, not in `SAMPLING_SCHEMA_v01.md`, not in `snowflake_sampling_v01.sql`, not in `PROJECT_SAMPLING_SPEC` table.
- **Why:** The rule requires a tolerance window (in seconds) to determine when device clock changes become "suspected drift." Without this threshold, any implementation invents a value rather than transcribing a specification.
- **Example:** "If monotonic `device_uptime_ms` between two consecutive samples in a batch is inconsistent with the elapsed time between `captured_ts_device` timestamps, flag if drift exceeds 60 seconds" — but the 60-second threshold is unspecified.
- **Impact:** The rule cannot be written as a pure function of its context without making up the threshold. Per agent instructions §5 ("Stopping beats guessing"), this was the correct choice.

### EXIF_POSITION_MISMATCH
- **Blocker:** No distance threshold specified.
- **Where to find it:** Not in `SAMPLING_APP_PLAN_v02.md` (mentions "needs a distance threshold" at §9 but does not name it), not in any specification table or document.
- **Why:** The rule would flag when `EXIF_LAT/EXIF_LON` from photo EXIF data disagree with `LAT/LON` from the app's GPS fix by more than a threshold. Without the threshold distance (in meters), the rule either flags all mismatches or none.
- **Example:** "If distance between EXIF position and captured position exceeds 50 meters, flag" — but the 50-meter threshold is unspecified.
- **Impact:** Same as above; an unspecified threshold cannot be transcribed.

Both thresholds should be written into `PROJECT_SAMPLING_SPEC` or the contract before these rules are implemented in a future wave.

## Needs from another agent

None. All my paths are write-disjoint, and the defect rule interface is stable.

## Files touched

```
 M src/server/defects/rules/index.ts
?? src/server/defects/rules/missing-required-media.ts
?? src/server/defects/rules/offset-exceeded-no-reason.ts
?? src/server/defects/rules/media-gallery-sourced.ts
?? src/server/defects/rules/depth-shortfall.ts
?? tests/unit/defect-rules.test.ts
```

All under my owned paths (`src/server/defects/rules/**` and `tests/unit/defect-rules*.test.ts`).
