# Spec Transcriber — Wave 1 Report

**Agent:** `spec-transcriber` (Haiku 4.5)  
**Wave:** 1 — Unblock  
**Date:** 2026-08-17  
**Tasks:** B2 (design primitives, palette, 48 dp targets), code-set remainder

---

## Summary

Delivered design primitives and form components under `src/app/components/**` meeting the 48 dp minimum touch target requirement for field use in gloves, wind, and low sun conditions. All interactive elements are keyboard-accessible with focus indicators. Code sets remain complete from F0.5 (condition, deviation, validation, priority, defect).

**Status:** Green. `npm run typecheck && npm test` passes (116/116 tests).

---

## Completed Work

### Design System Tokens (`src/app/components/tokens/`)

- **colors.ts** — Color palette and semantic token aliases
  - Base color scale (neutral, primary, success, warning, error, info)
  - Semantic tokens for text, backgrounds, interactive elements, status chips, inputs
  - Placeholder hex values pending design finalization (see "Stopped, and why")

- **index.ts** — Design system scale
  - Touch target sizing (48 dp standard, 56 dp preferred, 64 dp xlarge)
  - Spacing scale (4–48 px)
  - Typography (font sizes, weights, line heights)
  - Border radius, shadows, z-index, transitions

### Interactive Components

All components below use CSS-in-JS styles (no external CSS imports). All interactive elements meet 48 dp minimum touch target. All support focus rings for keyboard navigation.

- **Button.tsx** — Primary, secondary, danger, ghost variants
  - Sizes: sm (48 dp), md (56 dp), lg (64 dp)
  - Loading state, disabled state, full-width mode
  - Focus ring on focus event

- **Chip.tsx** — Status chips and tags
  - Selectable and dismissable modes
  - Status: success, warning, error, info, neutral
  - Keyboard-accessible (Enter/Space to select)
  - Delete button for removable chips

- **Badge.tsx** — Small labels and status indicators
  - Non-interactive inline display
  - Sizes: sm (20 px height), md (24 px height)
  - Dot mode for status indicators

- **Input.tsx** — Text input with label and validation
  - 48 dp minimum height
  - Optional icon and suffix
  - Error and hint text support
  - Focus ring visible on focus

- **ConditionChip.tsx** — Specialized chip for condition codes
  - Renders conditions from the versioned code set
  - Status color mapped by condition group (moisture, residue, crop, access, soil)
  - Selectable with keyboard support
  - Integrates with `src/shared/codes/condition.js`

- **DeviationChip.tsx** — Specialized chip for deviation reasons
  - Renders deviation reasons from the versioned code set
  - Status color mapped by reason code (warning, error, neutral)
  - Selectable with keyboard support
  - Integrates with `src/shared/codes/deviation.js`

- **index.ts** — Export barrel for all components and tokens

### Code Sets (Unchanged from F0.5)

All versioned reference data is complete and tested:

- `src/shared/codes/condition.ts` — Condition code structure and examples
- `src/shared/codes/deviation.ts` — Deviation reasons with skip/offset sub-filters
- `src/shared/codes/priority.ts` — Sync outbox entity priorities and dependencies
- `src/shared/codes/validation.ts` — Ingest and capture validation codes
- `src/shared/codes/index.ts` — Barrel with defect codes, severities, field visibility, audit actions

---

## Palette Tokens — Published for pwa-screens

The following token names are canonical and should be used in `src/app/styles/global.css`:

### Color Tokens

```typescript
// Base palette
COLORS.neutral900, neutral800, neutral700, neutral600, neutral500, neutral400, neutral300, neutral200, neutral100, neutral0
COLORS.primary700, primary600, primary500, primary400, primary300
COLORS.success700, success600, success500, success400
COLORS.warning700, warning600, warning500, warning400
COLORS.error700, error600, error500, error400
COLORS.info700, info600, info500, info400
```

### Semantic Color Tokens

```typescript
// Text
SEMANTIC_COLORS.textPrimary, textSecondary, textTertiary, textInverse, textDisabled

// Background
SEMANTIC_COLORS.bgPrimary, bgSecondary, bgTertiary, bgInverse, bgDisabled

// Button
SEMANTIC_COLORS.buttonPrimaryBg, buttonPrimaryText
SEMANTIC_COLORS.buttonSecondaryBg, buttonSecondaryText
SEMANTIC_COLORS.buttonDisabledBg, buttonDisabledText

// Input
SEMANTIC_COLORS.inputBg, inputBorder, inputBorderFocus, inputBorderError, inputText, inputPlaceholder

// Status chips
SEMANTIC_COLORS.chipSuccessBg, chipSuccessText
SEMANTIC_COLORS.chipWarningBg, chipWarningText
SEMANTIC_COLORS.chipErrorBg, chipErrorText
SEMANTIC_COLORS.chipInfoBg, chipInfoText
SEMANTIC_COLORS.chipNeutralBg, chipNeutralText

// Other
SEMANTIC_COLORS.borderDefault, borderStrong, borderSubtle
SEMANTIC_COLORS.divider, focusRing
SEMANTIC_COLORS.shadowLight, shadowMedium, shadowStrong
```

**Import pattern for pwa-screens:**
```typescript
import { COLORS, SEMANTIC_COLORS } from '@/app/components/tokens';
```

---

## Test Results

```
 Test Files  11 passed (11)
      Tests  116 passed (116)
   Duration  2.00s
```

All tests pass. No failures introduced by the new components.

---

## Git Status

```
 M src/server/defects/rules/index.ts
?? src/app/components/
?? src/server/defects/rules/depth-shortfall.ts
?? src/server/defects/rules/media-gallery-sourced.ts
?? src/server/defects/rules/missing-required-media.ts
?? src/server/defects/rules/offset-exceeded-no-reason.ts
?? src/shared/map/
?? tests/unit/defect-rules.test.ts
```

**New files created (this agent):**
- `src/app/components/Button.tsx`
- `src/app/components/Badge.tsx`
- `src/app/components/Chip.tsx`
- `src/app/components/Input.tsx`
- `src/app/components/ConditionChip.tsx`
- `src/app/components/DeviationChip.tsx`
- `src/app/components/index.ts`
- `src/app/components/tokens/colors.ts`
- `src/app/components/tokens/index.ts`

All files are under `src/app/components/`, which I own exclusively. No files flattened to repo root.

---

## Stopped, and Why

### 1. Palette Hex Values Not Specified

**Stopped at:** Color palette definition  
**Why:** The source document (SAMPLING_APP_PLAN_v02.md §4.3) refers to a "glove/wind/low-sun palette" as a usability requirement (readable in bright sun, operable in gloves, clear in wind) but does not specify the actual hex values for this palette.

**What I delivered instead:**
- A complete token structure with semantic color aliases
- Placeholder hex values following WCAG accessibility guidelines (sufficient contrast for outdoor use)
- Clear token names for pwa-screens to consume
- The constraint "48 dp minimum touch targets" fully implemented

**Next step:** Design review should confirm:
1. Specific hex values for each color in the glove/wind/low-sun palette
2. Whether the placeholder values are acceptable or need replacement
3. Whether any additional semantic tokens are needed for conditions chips, defect badges, etc.

Once confirmed, update `src/app/components/tokens/colors.ts` with the final values.

---

## Needs from Another Agent

**None.** Components are standalone. The ConditionChip and DeviationChip components import types from `src/shared/codes/`, which was completed in F0.5.

Wave 2 tasks (B9 condition chips, B10 skip screen, B12 storage screen) will consume the `Chip`, `Badge`, `Button`, `Input` components and the color tokens. They may require additional semantic tokens for their specific use cases — file a request if needed.

---

## Notes

- **CSS-in-JS approach:** All components use inline styles. No external CSS files, no CSS modules, no Tailwind. This keeps them portable and self-contained for use by other agents.

- **Keyboard accessibility:** All interactive components support:
  - Tab navigation
  - Enter/Space activation
  - Focus rings (visible on focus, hidden on click)
  - Role attributes where needed

- **Touch target math:**
  - Standard: 48 dp (6mm at 160 DPI) — minimum per Material Design and accessibility guidance
  - Preferred: 56 dp (7mm) for common actions
  - XLarge: 64 dp (8mm) for buttons and high-precision use

- **Code sets:** F0.5 transcription is complete and remains unchanged. All six reference files are in place and tested.

---

## Acceptance

**Definition of done — all met:**
- ✅ B2 primitives exist under `src/app/components/**` with 48 dp targets
- ✅ glove/wind/low-sun palette transcribed as token structure (hex values pending design review)
- ✅ Code sets under `src/shared/codes/**` complete and versioned
- ✅ `npm run typecheck && npm test` green (116/116 tests)
- ✅ `git status --short` pasted above
- ✅ Palette token names published in this report
- ✅ Unspecified item named: hex values for the palette

---

## Brand pass

**Date:** 2026-08-17  
**Task:** Transcribe extracted Veteran's Carbon Holdings brand palette (sand/moss/gold scales) into tokens; verify contrast and accessibility; fix hard-coded hex in Button.tsx

### Completed Work

**Colors.ts palette transcription**

Replaced placeholder neutral/primary/success/warning/error/info palette with the canonical brand scales from VCH corporate identity:

- **Sand scale** — ten stops (sand-50, sand-100, sand-200, sand-300, sand-400, sand-600, sand-700, sand-800, sand-900, sand-950). Gaps at sand-500 intentional per brand spec.
- **Moss scale** — six stops (moss-100, moss-300, moss-500, moss-700, moss-800, moss-900). Gaps at moss-200/400/600 intentional per brand spec.
- **Gold scale** — three stops (gold-500, gold-700, gold-800). No gold-100..400/600/900 per brand spec.
- **White** — explicit for inverse text and form backgrounds.
- **Functional red** (red-600, red-700) — NOT brand-sanctioned, but required for blocking defects and errors (flagged as TODO for design review below).

**Semantic token mapping per brand spec**

All tokens remapped to exact spec assignments:
- `textPrimary` → sand-900 (#312213)
- `bgPrimary` → sand-50 (#f8f3ea)
- `buttonPrimaryBg` → moss-700 (#2f5332) with white text (8.73:1 contrast)
- `inputBorder` → sand-300; `inputBorderFocus` → moss-700
- `inputPlaceholder` → sand-600 (NOT sand-400 — must stay legible in low sun)
- `chipSuccess` → moss-100 bg / moss-900 text
- `chipWarning` → #f5e6c0 (gold-tinted ground) / gold-800 text
- `focusRing` → gold-700 (#a67c17) — non-text use (ring, not label)

Font family constraint transcribed: Quicksand (400/600/700) — vendored under `public/fonts/` by pwa-screens, not wired by this agent.

**Button.tsx hard-coded hex removed**

Line 49 previously had `backgroundColor: '#cc0000'` (hard-coded functional red). Now references `SEMANTIC_COLORS.buttonDangerBg` and uses `SEMANTIC_COLORS.buttonDangerText`, consistent with other variants.

### Contrast and Accessibility — Brand Design Trade-off

The orchestrator pre-computed WCAG contrast for every pair (documented in the task prompt). Gold fails outdoor legibility:
- `bg-gold-700` with white text: 3.81:1 (fails AA for normal text)
- `.text-gold-700` on sand-50 ground: 3.44:1 (fails AA for normal text)

**Design decision:** Gold is demoted to accent, large text, and borders only (already implemented in semantic mapping). This is a deliberate adaptation *not* a transcription error — the site's own gold usage fails outdoor legibility, and a field app in gloves, wind and low sun (v02 §4.3) cannot afford that deficit.

All other assignments meet or exceed AA for normal text; this branch enforces the constraint.

### Open Item — Functional Red

The brand CSS contains no red scale. Tailwind's defaults (`red`/`amber`/`emerald`) appear in the CSS but never in the site's actual class usage — only sand, moss, and gold are used.

A field app must show a blocking defect unmistakably, so I kept functional red for `chipError` / `Button` danger and `buttonDangerBg`. **This is flagged as TODO pending design confirmation** — the spec says "keep a functional red for `chipError` / `Button` danger, but do not present it as a brand colour".

Token names: `red600` (#cc0000), `red700` (#800000); semantic assignments: `buttonDangerBg`, `buttonDangerText`, `chipErrorBg`, `chipErrorText`.

### Test Results

```
 Test Files  20 passed (20)
      Tests  166 passed | 1 skipped (167)
   Duration  3.72s
```

TypeCheck: Clean. All tests pass.

### Git Status

```
 M src/app/components/Button.tsx
 M src/app/components/tokens/colors.ts
```

All changes under `src/app/components/`, which I own exclusively. No files created outside owned paths.

### Definition of Done — All Met

- ✅ `src/app/components/tokens/colors.ts` carries real brand scales with exact hex values; no placeholder hexes remain; scale gaps are not invented
- ✅ `Button.tsx:49` references `SEMANTIC_COLORS.buttonDangerBg` instead of hard-coded `#cc0000`
- ✅ `npm run typecheck && npm test` green (166 passed, 1 skipped, 0 failed)
- ✅ `git status --short` pasted above
- ✅ Functional red open item named and documented
- ✅ Contrast math and design rationale documented
- ✅ No hexes anywhere except `colors.ts`; no token names changed; 48 dp targets unchanged
