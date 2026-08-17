/**
 * B14 — tutorial step 3, "Capture". v02 D18 / §2 Screen 3.
 *
 * Drives the **real** `TutorialCaptureSession` from `capture-integrity`'s
 * `@app/capture/tutorial/index.js` — the purpose-built, zero-write, no-camera
 * simulation that makes this demonstrable on a phone with the camera denied,
 * a laptop in a screen-share, or a headless browser. It is not this screen
 * pretending to capture; `capturePhoto()` runs the real downscale/hash
 * pipeline over a drawn (watermarked) frame, and `save()` returns the record
 * a real save *would* have produced without writing anything — see that
 * module's own header for the four independent reasons it cannot leak into
 * a real plan.
 *
 * Deliberately smaller than the real `CaptureScreen`: no barcode scanner (it
 * would open a real camera stream, which is exactly what this step exists to
 * avoid needing), no depth/cores toggle. Three photo tiles, conditions, an
 * offset-driven deviation prompt, and Save — enough to show the shape of the
 * screen a sampler actually uses, per the brief the task asked for.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Chip, Input, SEMANTIC_COLORS, SPACING, FONT_SIZES, FONT_WEIGHTS, BORDER_RADIUS, TOUCH_TARGETS } from '@app/components/index.js';
import type { MediaRole } from '@shared/contract/common.js';
import {
  createTutorialCaptureSession,
  capturePhotoView,
  TUTORIAL_SPEC,
  type TutorialCaptureSession,
  type TutorialCaptureSessionState,
  type TutorialCaptureResult,
} from '@app/capture/tutorial/index.js';
import { classifyOffset } from '@app/screens/capture/offset.js';

const ROLES = ['label_photo', 'core_photo', 'site_photo'] as const satisfies readonly MediaRole[];
const ROLE_LABELS: Record<(typeof ROLES)[number], string> = {
  label_photo: 'Label',
  core_photo: 'Core',
  site_photo: 'Site',
};

const ADVISORY_LABELS: Record<string, string> = {
  NO_GPS_FIX: 'No usable position yet',
  GPS_ACCURACY_EXCEEDED: 'Position wider than the spec asks for',
  MISSING_REQUIRED_MEDIA: 'Missing a required photo',
  OFFSET_EXCEEDED_NO_REASON: 'Well outside the plan, no reason given yet',
  MANUAL_POSITION: 'Position placed by hand, not a fix',
};

const CONDITION_OPTIONS = ['Dry', 'Compacted', 'Rocky'] as const;

export interface TutorialCaptureStepProps {
  onSaved: (result: { wouldQueue: number }) => void;
}

export function TutorialCaptureStep({ onSaved }: TutorialCaptureStepProps): React.JSX.Element {
  const session = useMemo<TutorialCaptureSession>(() => createTutorialCaptureSession(), []);
  const [state, setState] = useState<TutorialCaptureSessionState>(() => session.state());
  const [note, setNote] = useState('');
  const [conditions, setConditions] = useState<Set<string>>(new Set());
  const [deviationNote, setDeviationNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TutorialCaptureResult | null>(null);

  useEffect(() => {
    session.start();
    const unsubscribe = session.subscribe(setState);
    return () => {
      unsubscribe();
      session.discard();
    };
  }, [session]);

  const offsetM = state.offset_from_plan_m;
  const severity =
    offsetM !== null
      ? classifyOffset(offsetM, TUTORIAL_SPEC.max_plan_offset_m_warn, TUTORIAL_SPEC.max_plan_offset_m_block)
      : 'ok';

  async function handleSave(): Promise<void> {
    if (state.saved) return;
    setSaving(true);
    try {
      const r = await session.save({
        note: note || null,
        bag_count: 1,
        condition_count: conditions.size,
      });
      setResult(r);
      onSaved({ wouldQueue: r.would_queue });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.lg, padding: SPACING.lg }}>
      <p style={{ margin: 0, fontSize: FONT_SIZES.sm, color: SEMANTIC_COLORS.textSecondary }}>
        This is a real capture session — the same GPS averaging and photo pipeline a field capture
        uses — pointed at a made-up example point instead of a real one. Tap the photo tiles; no
        camera opens. Nothing here is saved.
      </p>

      <Badge label={state.notice} status="warning" />

      <section aria-label="Position" style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
        <SectionLabel>Position — {state.plan_point.plan_point_label}</SectionLabel>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm }}>
          {!state.position && <Badge label="Acquiring simulated GPS…" status="info" />}
          {state.position && (
            <Badge
              label={
                state.position.position_source === 'tutorial_simulated_gps'
                  ? `GPS ±${state.position.gps_accuracy_m}m · ${state.position.fix_count} fixes`
                  : 'Dropped pin (example)'
              }
              status={state.position.position_source === 'tutorial_simulated_gps' && state.gps.meetsSpec ? 'success' : 'warning'}
            />
          )}
          {offsetM !== null && (
            <Badge
              label={`${Math.round(offsetM)} m from plan`}
              status={severity === 'block' ? 'error' : severity === 'warn' ? 'warning' : 'success'}
            />
          )}
        </div>
        {severity !== 'ok' && (
          <>
            <div style={{ fontSize: FONT_SIZES.xs, color: SEMANTIC_COLORS.textSecondary }}>
              This is the deliberate fault v02 D18 asks a tutorial for: an offset past the warn
              threshold, so the deviation prompt appears here — once — instead of for the first
              time in a field.
            </div>
            <Input
              label="Reason for offset (example)"
              value={deviationNote}
              onChange={(e) => {
                setDeviationNote(e.target.value);
                session.setDeviationReason(e.target.value || null);
              }}
              placeholder="e.g. boundary drawn slightly off the fence line"
              disabled={state.saved}
            />
          </>
        )}
      </section>

      <section aria-label="Photos" style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
        <SectionLabel>Photos</SectionLabel>
        <div style={{ display: 'flex', gap: SPACING.md, flexWrap: 'wrap' }}>
          {ROLES.map((role) => (
            <TutorialPhotoTile
              key={role}
              role={role}
              label={ROLE_LABELS[role]}
              session={session}
              disabled={state.saved}
            />
          ))}
        </div>
        {state.missing_required_roles.length > 0 && (
          <Badge label={`Missing: ${state.missing_required_roles.join(', ')} — saving anyway will flag it`} status="warning" />
        )}
      </section>

      <section aria-label="Conditions" style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
        <SectionLabel>Conditions (example)</SectionLabel>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm }}>
          {CONDITION_OPTIONS.map((label) => (
            <Chip
              key={label}
              label={label}
              selectable
              selected={conditions.has(label)}
              disabled={state.saved}
              onClick={() =>
                setConditions((prev) => {
                  const next = new Set(prev);
                  if (next.has(label)) next.delete(label);
                  else next.add(label);
                  return next;
                })
              }
            />
          ))}
        </div>
      </section>

      <section aria-label="Note">
        <Input
          label="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Anything else worth recording"
          disabled={state.saved}
        />
      </section>

      {state.advisories.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.xs }}>
          {state.advisories.map((a, i) => (
            <Badge key={`${a.code}-${i}`} label={ADVISORY_LABELS[a.code] ?? a.code} status="warning" size="sm" />
          ))}
        </div>
      )}

      {!state.saved ? (
        <Button variant="primary" size="lg" fullWidth onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      ) : (
        result && (
          <div
            style={{
              padding: SPACING.lg,
              borderRadius: BORDER_RADIUS.lg,
              border: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
              display: 'flex',
              flexDirection: 'column',
              gap: SPACING.sm,
            }}
          >
            <Badge label="Saved — in the tutorial only" status="success" />
            <div style={{ fontSize: FONT_SIZES.sm, color: SEMANTIC_COLORS.textPrimary }}>
              A real save would have queued <strong>{result.would_queue}</strong> record
              {result.would_queue === 1 ? '' : 's'} in the Outbox (the point, its bag, its
              conditions, and {state.photos.length} photo{state.photos.length === 1 ? '' : 's'}
              ). <strong>{result.rows_written} rows were actually written.</strong>
            </div>
          </div>
        )
      )}
    </div>
  );
}

function TutorialPhotoTile({
  role,
  label,
  session,
  disabled,
}: {
  role: MediaRole;
  label: string;
  session: TutorialCaptureSession;
  disabled: boolean;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState(() => session.state());

  useEffect(() => session.subscribe(setState), [session]);

  const photos = state.photos.filter((p) => p.media_role === role);
  const latest = photos[photos.length - 1];
  const view = latest ? capturePhotoView(latest) : null;

  async function handleTap(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const outcome = await session.capturePhoto(role);
      if (!outcome.ok) setError(outcome.detail ?? outcome.reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.xs, width: 120 }}>
      <button
        type="button"
        onClick={handleTap}
        disabled={disabled || busy}
        aria-label={`Tutorial photo — ${label}`}
        style={{
          width: 120,
          height: 120,
          minHeight: TOUCH_TARGETS.xlarge,
          borderRadius: BORDER_RADIUS.md,
          border: `1px dashed ${SEMANTIC_COLORS.borderDefault}`,
          background: view?.preview_url ? `url(${view.preview_url}) center/cover` : SEMANTIC_COLORS.bgSecondary,
          cursor: disabled ? 'not-allowed' : 'pointer',
          position: 'relative',
          padding: 0,
        }}
      >
        {!view && (
          <span style={{ fontSize: FONT_SIZES.sm, color: SEMANTIC_COLORS.textSecondary }}>
            {busy ? 'Drawing…' : `Tap for ${label.toLowerCase()}`}
          </span>
        )}
      </button>
      <div style={{ fontSize: FONT_SIZES.xs, color: SEMANTIC_COLORS.textSecondary }}>
        {label} {photos.length > 0 ? `(${photos.length})` : '— required'}
      </div>
      {view && (
        <Badge label={view.provenance_label} status="warning" size="sm" />
      )}
      {error && <Badge label={error} status="error" size="sm" />}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ fontSize: FONT_SIZES.base, fontWeight: FONT_WEIGHTS.semibold, color: SEMANTIC_COLORS.textPrimary }}>
      {children}
    </div>
  );
}
