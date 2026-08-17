/**
 * B14 — the sampler tutorial branch. v02 D18 / §4.5: "First run is guided,
 * ~3 minutes, against model data with deliberate, instructive faults, and
 * ends by setting … `tutorial_completed_ts`. Skipping the tutorial still
 * sets the flag."
 *
 * Four brief steps mirroring the four screens a sampler actually touches in
 * order (Today → Field → Capture → Outbox) — Skip and Storage are not walked
 * through here; they are reached the same way Field/Capture are, and D18
 * asks for "verbose … exactly once", not a tour of every screen.
 *
 * **Today and Field reuse the real ambient demo data** — `demoBundleFromFixture()`
 * (`@app/shell/bundle/client.js`), the same F0.7 fixture (six points, one
 * boundary — v02 §4.5's own description of this app's model dataset) that
 * answers `fetchAssignmentBundle()` whenever no assignments server is
 * reachable. This screen never calls `applyBundleToDevice` — it reads the
 * fixture directly and renders it, so **nothing here touches the device
 * database**, which is a stronger and simpler guarantee than "discarded" for
 * these two steps: there is nothing to discard.
 *
 * **Capture reuses `capture-integrity`'s `TutorialCaptureSession`**
 * (`TutorialCaptureStep.tsx`) — a separate, purpose-built example point in
 * the reserved `tutorial-` namespace, because that step needs a session
 * object (GPS acquisition, photo capture) the read-only fixture data cannot
 * give it. The two data sources are not reconciled into one story on
 * purpose: Today/Field teach "here is what your real assignments will look
 * like"; Capture teaches "here is what happens when you tap a point",
 * clearly on its own example.
 */

import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  SEMANTIC_COLORS,
  SPACING,
  FONT_SIZES,
  FONT_WEIGHTS,
  BORDER_RADIUS,
  TOUCH_TARGETS,
} from '@app/components/index.js';
import { BoundaryMap, type MapBoundary, type MapPoint } from '@shared/map';
import { ROUTE_PATHS } from '@app/shell/routes.js';
import { markTutorialCompleted } from '@app/shell/tutorial.js';
import { demoBundleFromFixture } from '@app/shell/bundle/client.js';
import { TutorialCaptureStep } from './TutorialCaptureStep.js';

const STEP_LABELS = ['Today', 'Field', 'Capture', 'Outbox'] as const;
type StepIndex = 0 | 1 | 2 | 3;

export function TutorialScreen(): React.JSX.Element {
  const navigate = useNavigate();
  const [step, setStep] = useState<StepIndex>(0);
  const [finishing, setFinishing] = useState(false);
  const [wouldQueue, setWouldQueue] = useState<number | null>(null);

  // Read-only — never applied to the device database. See module header.
  const bundle = useMemo(() => demoBundleFromFixture(), []);

  async function leave(): Promise<void> {
    setFinishing(true);
    try {
      await markTutorialCompleted();
    } finally {
      navigate(ROUTE_PATHS.today, { replace: true });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: SPACING.md,
          padding: SPACING.lg,
          paddingTop: `calc(${SPACING.lg} + env(safe-area-inset-top))`,
          borderBottom: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
        }}
      >
        <div>
          <div style={{ fontSize: FONT_SIZES.lg, fontWeight: FONT_WEIGHTS.bold, color: SEMANTIC_COLORS.textPrimary }}>
            Quick walkthrough
          </div>
          <div style={{ fontSize: FONT_SIZES.xs, color: SEMANTIC_COLORS.textSecondary }}>
            Step {step + 1} of {STEP_LABELS.length} · {STEP_LABELS[step]} · demo data only
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => leave()} disabled={finishing}>
          Skip
        </Button>
      </header>

      <StepDots step={step} />

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {step === 0 && <TutorialTodayStep bundle={bundle} />}
        {step === 1 && <TutorialFieldStep bundle={bundle} />}
        {step === 2 && <TutorialCaptureStep onSaved={(r) => setWouldQueue(r.wouldQueue)} />}
        {step === 3 && <TutorialOutboxStep wouldQueue={wouldQueue} />}
      </div>

      <footer
        style={{
          display: 'flex',
          gap: SPACING.md,
          padding: SPACING.lg,
          paddingBottom: `calc(${SPACING.lg} + env(safe-area-inset-bottom))`,
          borderTop: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
        }}
      >
        {step > 0 && (
          <Button variant="secondary" size="lg" onClick={() => setStep((s) => (s - 1) as StepIndex)} disabled={finishing}>
            Back
          </Button>
        )}
        {step < 3 ? (
          <Button variant="primary" size="lg" fullWidth onClick={() => setStep((s) => (s + 1) as StepIndex)}>
            Next: {STEP_LABELS[step + 1]} →
          </Button>
        ) : (
          <Button variant="primary" size="lg" fullWidth onClick={() => leave()} disabled={finishing}>
            {finishing ? 'Starting…' : 'Start using the app'}
          </Button>
        )}
      </footer>
    </div>
  );
}

function StepDots({ step }: { step: StepIndex }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', gap: SPACING.sm, padding: SPACING.sm }} aria-hidden="true">
      {STEP_LABELS.map((label, i) => (
        <span
          key={label}
          style={{
            width: 8,
            height: 8,
            borderRadius: BORDER_RADIUS.full,
            background: i === step ? SEMANTIC_COLORS.buttonPrimaryBg : SEMANTIC_COLORS.borderDefault,
          }}
        />
      ))}
    </div>
  );
}

// ── Step 1: Today ─────────────────────────────────────────────────────────

function TutorialTodayStep({ bundle }: { bundle: ReturnType<typeof demoBundleFromFixture> }): React.JSX.Element {
  const boundary = bundle.boundaries[0];
  const points = bundle.plan_points;
  const done = 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.lg, padding: SPACING.lg }}>
      <p style={{ margin: 0, fontSize: FONT_SIZES.sm, color: SEMANTIC_COLORS.textSecondary }}>
        <strong>Today</strong> is the first screen you see. Your assigned boundaries are sorted by
        route, each with a progress ring, acres, and a tap-to-call access contact.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm }}>
        <Badge label="Outbox: 0 pending" status="success" />
        <Badge label="Assignments valid 27d" status="neutral" />
      </div>
      {boundary && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: SPACING.lg,
            minHeight: TOUCH_TARGETS.xlarge,
            padding: SPACING.lg,
            borderRadius: BORDER_RADIUS.lg,
            border: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
          }}
        >
          <ProgressRing percent={0} />
          <div>
            <div style={{ fontSize: FONT_SIZES.lg, fontWeight: FONT_WEIGHTS.bold, color: SEMANTIC_COLORS.textPrimary }}>
              {boundary.property_name}
            </div>
            <div style={{ fontSize: FONT_SIZES.sm, color: SEMANTIC_COLORS.textSecondary }}>
              {boundary.geom_acres?.toFixed(1)} ac · {done} of {points.length} points
            </div>
          </div>
        </div>
      )}
      <p style={{ margin: 0, fontSize: FONT_SIZES.xs, color: SEMANTIC_COLORS.textSecondary }}>
        Tapping a card opens Field for that boundary — next.
      </p>
    </div>
  );
}

// ── Step 2: Field ────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pending: SEMANTIC_COLORS.focusRing,
  sampled: SEMANTIC_COLORS.buttonPrimaryBg,
  skipped: SEMANTIC_COLORS.textSecondary,
};

function TutorialFieldStep({ bundle }: { bundle: ReturnType<typeof demoBundleFromFixture> }): React.JSX.Element {
  const boundary = bundle.boundaries[0];

  const mapBoundaries = useMemo<MapBoundary[]>(
    () => (boundary ? [{ id: boundary.boundary_id, geojson: boundary.geojson, label: boundary.property_name }] : []),
    [boundary],
  );
  const mapPoints = useMemo<MapPoint[]>(
    () =>
      bundle.plan_points.map((p) => ({
        id: p.plan_point_id,
        lat: p.planned_lat,
        lon: p.planned_lon,
        status: 'pending',
        label: p.plan_point_label,
      })),
    [bundle],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <p style={{ margin: 0, padding: SPACING.lg, paddingBottom: 0, fontSize: FONT_SIZES.sm, color: SEMANTIC_COLORS.textSecondary }}>
        <strong>Field</strong> shows the boundary and every planned point, coloured by status. Tap a
        pin to capture it; long-press bare ground for a point that isn&rsquo;t on the plan.
      </p>
      <div style={{ flex: 1, position: 'relative', minHeight: 220, margin: SPACING.lg }}>
        <BoundaryMap
          tilePackUrl={null}
          boundaries={mapBoundaries}
          points={mapPoints}
          statusColors={STATUS_COLORS}
          ariaLabel={`Map of ${boundary?.property_name ?? 'the demo boundary'}`}
        />
      </div>
      <div style={{ display: 'flex', overflowX: 'auto', gap: SPACING.sm, padding: SPACING.lg, paddingTop: 0 }}>
        {bundle.plan_points.map((p) => (
          <div
            key={p.plan_point_id}
            style={{
              flexShrink: 0,
              minHeight: 48,
              display: 'flex',
              alignItems: 'center',
              padding: `${SPACING.sm} ${SPACING.md}`,
              borderRadius: BORDER_RADIUS.md,
              border: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
              fontWeight: FONT_WEIGHTS.semibold,
              color: SEMANTIC_COLORS.textPrimary,
            }}
          >
            {p.plan_point_label}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Step 4: Outbox ───────────────────────────────────────────────────────

function TutorialOutboxStep({ wouldQueue }: { wouldQueue: number | null }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.lg, padding: SPACING.lg }}>
      <p style={{ margin: 0, fontSize: FONT_SIZES.sm, color: SEMANTIC_COLORS.textSecondary }}>
        Every screen works with the radio off — capture never waits on the network. The{' '}
        <strong>Outbox</strong> is the one screen that knows the network exists: pending records,
        pending photo megabytes, last successful sync, a manual sync button, and — for each record
        that failed — why. A silently stuck outbox is the failure mode that loses a season, so it
        is a screen, not a spinner.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm }}>
        <Badge
          label={`Pending: ${wouldQueue ?? 0}`}
          status={wouldQueue ? 'warning' : 'success'}
        />
        <Badge label="Syncing: 0" status="info" />
        <Badge label="Failed: 0" status="success" />
        <Badge label="Photos waiting: 0 KB" status="neutral" />
      </div>
      {wouldQueue !== null && (
        <Badge
          label={`The example point you captured would show up here as ${wouldQueue} pending record${wouldQueue === 1 ? '' : 's'}.`}
          status="info"
        />
      )}
      <Button variant="secondary" size="lg" fullWidth disabled>
        Sync now (disabled here — this is a demo)
      </Button>
    </div>
  );
}

function ProgressRing({ percent }: { percent: number }): React.JSX.Element {
  const size = 48;
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - percent / 100);
  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }} role="img" aria-label={`${percent}% sampled`}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={SEMANTIC_COLORS.bgTertiary} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={SEMANTIC_COLORS.buttonPrimaryBg}
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fontSize={12} fontWeight={700} fill={SEMANTIC_COLORS.textPrimary}>
        {percent}%
      </text>
    </svg>
  );
}
