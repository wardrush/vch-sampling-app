/**
 * Screen 3 · Capture (v02 §2, §3, §4.3). B7 + the capture wiring.
 *
 * Owns: layout, barcode capture (this file's `BarcodeField`), conditions /
 * deviation / depth-cores UI (this screen +
 * `spec-transcriber`'s `ConditionChip`/`DeviationPicker`/`DepthCoresToggle`),
 * and driving `CaptureSession` (`@app/capture/index.js`,
 * `capture-integrity`'s wave-2 landing) for everything audit-bearing: GPS
 * acquisition, the live camera, `capture_source` provenance, and the local
 * write (`field_visit` → `sample_point` → `sample_bag` → `sample_condition`s
 * → `media`s → outbox, one transaction).
 *
 * **This screen does not touch SQLite for the write path at all** — that is
 * the point of importing `@app/capture/index.js` rather than reaching past
 * it. `structural-guarantee.test.ts` (capture-integrity's) enforces the one
 * door: only files inside `src/app/capture/` may import the function that
 * mints `capture_source` = `'in_app_camera'`, and this file does not.
 *
 * **Never blocks on the network** (v02 §3): `session.save()` is a local
 * SQLite transaction plus outbox enqueues, nothing else. The outbox worker —
 * not this screen — is the only thing that later talks to a server.
 *
 * **Missing data flags, it does not drop** (v02 §3): a missing barcode, a
 * missing required photo, or no GPS fix never disables Save — `session`
 * surfaces each as an advisory instead. The one thing this screen actually
 * gates Save on is the block-threshold deviation reason, because v02 §2 says
 * so explicitly ("must be answered"), not because of a network or storage
 * concern.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  ConditionChip,
  DeviationPicker,
  DepthCoresToggle,
  Input,
  SEMANTIC_COLORS,
  SPACING,
  FONT_SIZES,
  FONT_WEIGHTS,
} from '@app/components/index.js';
import type { ConditionCode, ConditionGroup, ConditionValueType, DeviationReason } from '@shared/codes/index.js';
import { OFFSET_REASONS } from '@shared/codes/index.js';
import type { BarcodeCaptureMethod } from '@shared/contract/common.js';
import {
  createCaptureSession,
  OpfsMediaBlobStore,
  REQUIRED_ROLES,
  type AttachedPhoto,
  type CaptureSession,
  type CaptureSessionState,
  type RequiredMediaRole,
} from '@app/capture/index.js';
import { getOrCreateDeviceId } from '@app/shell/device-id.js';
import { resolveVisitForBoundary } from '@app/shell/visit.js';
import { useDeviceDb } from '@app/shell/db/DeviceDbProvider.js';
import { fieldPath, skipPath } from '@app/shell/routes.js';
import {
  getBoundary,
  getPlanPoint,
  getPrimarySpec,
  getRefConditionCodes,
  getRefLabs,
  setPlanPointStatus,
  type DeviceBoundary,
  type DeviceConditionCode,
  type DevicePlanPoint,
  type DeviceRefLab,
  type DeviceSpec,
} from '@app/shell/bundle/queries.js';
import { classifyOffset } from './offset.js';
import { BarcodeField } from './BarcodeField.js';
import { CameraTile } from './CameraTile.js';
import { CaptureCameraPanel } from './CaptureCameraPanel.js';

const REQUIRED_ROLE_LABELS: Record<RequiredMediaRole, string> = {
  label_photo: 'Label',
  core_photo: 'Core',
  site_photo: 'Site',
};

export function CaptureScreen(): React.JSX.Element {
  const { boundaryId, pointId } = useParams<{ boundaryId: string; pointId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const dbState = useDeviceDb();

  // `pointId` is only present on `/capture/:boundaryId/:pointId` — the
  // long-press route `/capture/:boundaryId/new` has no `:pointId` segment at
  // all (`routes.ts`), so this is the correct discriminator, not a string
  // comparison against the literal "new".
  const isFieldAdded = !pointId;
  const longPressState = location.state as { lat?: number; lon?: number } | null;

  const [deviceId] = useState(() => getOrCreateDeviceId());

  const [planPoint, setPlanPoint] = useState<DevicePlanPoint | null>(null);
  const [boundary, setBoundary] = useState<DeviceBoundary | null>(null);
  const [spec, setSpec] = useState<DeviceSpec | null>(null);
  const [labs, setLabs] = useState<DeviceRefLab[]>([]);
  const [conditionCodes, setConditionCodes] = useState<DeviceConditionCode[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // --- The capture session: GPS + camera + the local write. -----------------
  // Constructed exactly once per point — `session.sample_uid` is minted at
  // construction, so rebuilding it on every render would orphan any photos
  // already attached to the first one. Load + construct are **one effect**,
  // not two: splitting them (an earlier version of this file did) races
  // "spec/planPoint finished loading" against "session already built", and
  // the loser is a session permanently missing the advisory-offset seed
  // (`planned`) it needed at construction. One effect, one linear sequence,
  // no race.
  const sessionRef = useRef<CaptureSession | null>(null);
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [sessionState, setSessionState] = useState<CaptureSessionState | null>(null);

  useEffect(() => {
    if (dbState.status !== 'ready' || !boundaryId) return;
    if (sessionRef.current) return; // already built for this mount
    let cancelled = false;
    (async () => {
      try {
        const [b, s, l, c, p] = await Promise.all([
          getBoundary(dbState.db, boundaryId),
          getPrimarySpec(dbState.db),
          getRefLabs(dbState.db),
          getRefConditionCodes(dbState.db),
          pointId ? getPlanPoint(dbState.db, pointId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setBoundary(b);
        setLabs(l);
        setConditionCodes(c);
        setPlanPoint(p);
        if (!s) {
          setLoadError('No sampling spec is available for this boundary — cannot capture.');
          return;
        }
        setSpec(s);

        const nowIso = new Date().toISOString();
        const { visitId, visit } = await resolveVisitForBoundary(dbState.db, {
          boundaryId,
          planId: null,
          specId: s.spec_id,
          crewOrgId: null,
          deviceId,
          nowIso,
        });
        if (cancelled) return;
        const session = createCaptureSession({
          db: dbState.db,
          // `DeviceSpec.period_code`/`protocol_version` are nullable on the
          // device (the column allows it); `CaptureSpec` isn't, because a
          // synced sample without a period code is meaningless server-side.
          // Coerced here rather than at the schema/query layer, which has
          // legitimate other readers that want the honest nullable value.
          spec: { ...s, period_code: s.period_code ?? '', protocol_version: s.protocol_version ?? '' },
          visit_id: visitId,
          visit,
          plan_point_id: isFieldAdded ? null : (pointId ?? null),
          planned: !isFieldAdded && p ? { lat: p.planned_lat, lon: p.planned_lon } : null,
          device_id: deviceId,
          blobs: new OpfsMediaBlobStore(),
        });
        sessionRef.current = session;
        setSession(session);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load capture data.');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbState.status, dbState.status === 'ready' ? dbState.db : null, boundaryId, pointId]);

  useEffect(() => {
    if (!session) return undefined;
    session.start();
    const unsubscribe = session.subscribe(setSessionState);
    return () => {
      unsubscribe();
      void session.stop();
    };
  }, [session]);

  // --- Conditions ---------------------------------------------------------
  const [selectedConditions, setSelectedConditions] = useState<Map<string, string | null>>(new Map());

  function toggleCondition(code: DeviceConditionCode, value: string | null = null): void {
    setSelectedConditions((prev) => {
      const next = new Map(prev);
      if (next.has(code.condition_code) && next.get(code.condition_code) === value) {
        next.delete(code.condition_code);
      } else {
        next.set(code.condition_code, value);
      }
      return next;
    });
  }

  // --- Deviation / depth-cores / barcode / note ---------------------------
  const [deviationReason, setDeviationReasonState] = useState<DeviationReason | null>(null);
  const [depthAchievedCm, setDepthAchievedCm] = useState<number | null>(null);
  const [coresTaken, setCoresTaken] = useState<number | null>(null);
  const [barcodeRaw, setBarcodeRaw] = useState('');
  const [barcodeMethod, setBarcodeMethod] = useState<BarcodeCaptureMethod | null>(null);
  const [barcodeScannedTs, setBarcodeScannedTs] = useState<string | null>(null);
  const [note, setNote] = useState('');

  function setDeviationReason(reason: DeviationReason | null): void {
    setDeviationReasonState(reason);
    session?.setDeviationReason(reason?.code ?? null);
  }

  function handleBarcodeChange(value: string, method: BarcodeCaptureMethod): void {
    // Verbatim, never trimmed/uppercased/reformatted (v02 §3: "never
    // normalized in place").
    setBarcodeRaw(value);
    setBarcodeMethod(method);
    setBarcodeScannedTs(new Date().toISOString());
  }

  const [activeCameraRole, setActiveCameraRole] = useState<RequiredMediaRole | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const offsetM = sessionState?.offset_from_plan_m ?? null;
  const severity =
    offsetM !== null && spec ? classifyOffset(offsetM, spec.max_plan_offset_m_warn, spec.max_plan_offset_m_block) : 'ok';

  const photosByRole = useMemo(() => {
    const map = new Map<RequiredMediaRole, AttachedPhoto[]>();
    for (const role of REQUIRED_ROLES) {
      map.set(role, (sessionState?.photos ?? []).filter((p) => p.media_role === role));
    }
    return map;
  }, [sessionState]);

  async function handleSave(): Promise<void> {
    if (!session || !sessionState || dbState.status !== 'ready' || !boundaryId) return;
    if (severity === 'block' && !deviationReason) {
      setSaveError('This point is well outside the plan — pick a reason before saving.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      // Last-resort fallback only: a real GPS fix always wins (the session's
      // own `pin ?? gps.result()` ordering — see CaptureSession.state()), so
      // this only takes effect when GPS never acquired anything at all.
      if (isFieldAdded && !sessionState.position && typeof longPressState?.lat === 'number' && typeof longPressState?.lon === 'number') {
        session.dropPin(longPressState.lat, longPressState.lon);
      }

      await session.save({
        conditions: [...selectedConditions.entries()].map(([condition_code, condition_value]) => ({
          condition_code,
          condition_value,
          code_set_version: '1.0',
        })),
        bags: [
          {
            bag_seq: 1,
            bag_role: 'composite',
            depth_top_cm: spec?.depth_top_cm ?? null,
            depth_bottom_cm: spec?.depth_bottom_cm ?? null,
            lab_id: spec?.default_lab_id ?? labs[0]?.lab_id ?? null,
            barcode_raw: barcodeRaw || null,
            barcode_symbology: labs[0]?.barcode_symbology ?? null,
            barcode_capture_method: barcodeMethod,
            barcode_scanned_ts: barcodeScannedTs,
            void_flag: false,
            void_reason_code: null,
          },
        ],
        note: note || null,
        depth_achieved_cm: depthAchievedCm,
        cores_taken: coresTaken,
        bd_core_taken: null,
      });

      if (!isFieldAdded && pointId) {
        await setPlanPointStatus(dbState.db, pointId, 'sampled');
      }

      navigate(fieldPath(boundaryId));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save. Nothing was lost — try again.');
    } finally {
      setSaving(false);
    }
  }

  if (!boundaryId) {
    return <CaptureMessage text="Missing boundary — go back and pick a point again." />;
  }
  if (dbState.status === 'loading') {
    return <CaptureMessage text="Opening device database…" />;
  }
  if (dbState.status === 'error') {
    return <CaptureMessage text={`Device database unavailable: ${dbState.error.message}`} />;
  }
  if (loadError) {
    return <CaptureMessage text={loadError} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: SPACING.md,
          padding: SPACING.lg,
          paddingTop: `calc(${SPACING.lg} + env(safe-area-inset-top))`,
          borderBottom: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
        }}
      >
        <Button variant="ghost" size="sm" onClick={() => navigate(fieldPath(boundaryId))}>
          ← Field
        </Button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: FONT_SIZES.lg, fontWeight: FONT_WEIGHTS.bold, color: SEMANTIC_COLORS.textPrimary }}>
            {isFieldAdded ? 'New point' : (planPoint?.plan_point_label ?? pointId)}
          </div>
          <div style={{ fontSize: FONT_SIZES.sm, color: SEMANTIC_COLORS.textSecondary }}>
            {boundary?.property_name ?? boundaryId}
          </div>
        </div>
        {!isFieldAdded && pointId && (
          <Button variant="ghost" size="sm" onClick={() => navigate(skipPath(boundaryId, pointId))} disabled={saving}>
            Can&rsquo;t sample — skip
          </Button>
        )}
      </header>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: SPACING.lg,
          display: 'flex',
          flexDirection: 'column',
          gap: SPACING.xl,
        }}
      >
        <section aria-label="Position" style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
          <SectionLabel>Position</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm }}>
            {!sessionState?.position && sessionState?.gps.acquiring && <Badge label="Acquiring GPS…" status="info" />}
            {sessionState?.position && (
              <Badge
                label={
                  sessionState.position.position_source === 'gps'
                    ? `GPS ±${sessionState.position.gps_accuracy_m}m · ${sessionState.position.fix_count} fixes · spread ${sessionState.position.fix_spread_m}m`
                    : 'Dropped pin (no GPS fix)'
                }
                status={sessionState.position.position_source === 'gps' && sessionState.gps.meetsSpec ? 'success' : 'warning'}
              />
            )}
            {!sessionState?.position && sessionState?.gps.lastError && (
              <Badge label={`GPS unavailable (${sessionState.gps.lastError}) — you can still save`} status="warning" />
            )}
            {offsetM !== null && (
              <Badge
                label={`${Math.round(offsetM)} m from plan`}
                status={severity === 'block' ? 'error' : severity === 'warn' ? 'warning' : 'success'}
              />
            )}
          </div>
        </section>

        <section aria-label="Barcode" style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
          <SectionLabel>Sample barcode</SectionLabel>
          <BarcodeField
            value={barcodeRaw}
            captureMethod={barcodeMethod}
            barcodePattern={labs[0]?.barcode_pattern ?? null}
            onChange={handleBarcodeChange}
            disabled={saving}
          />
        </section>

        <section aria-label="Photos" style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
          <SectionLabel>Photos</SectionLabel>
          {REQUIRED_ROLES.map((role) => {
            const forRole = photosByRole.get(role) ?? [];
            const latest = forRole[forRole.length - 1];
            return (
              <CameraTile
                key={role}
                label={REQUIRED_ROLE_LABELS[role]}
                required
                count={forRole.length}
                thumbnailUrl={latest?.preview_url ?? null}
                onOpen={() => setActiveCameraRole(role)}
                disabled={saving || !session}
              />
            );
          })}
          {activeCameraRole && session && (
            <CaptureCameraPanel
              key={activeCameraRole}
              session={session}
              role={activeCameraRole}
              label={REQUIRED_ROLE_LABELS[activeCameraRole]}
              onDone={() => setActiveCameraRole(null)}
            />
          )}
          {sessionState && sessionState.missing_required_roles.length > 0 && (
            <Badge
              label={`Missing: ${sessionState.missing_required_roles.join(', ')} — saving anyway will flag it`}
              status="warning"
            />
          )}
        </section>

        <section aria-label="Conditions" style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
          <SectionLabel>Conditions</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.md }}>
            {groupConditionCodes(conditionCodes).map(([group, codes]) => (
              <div key={group} style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm }}>
                {codes.flatMap((c) => {
                  const shape = toConditionShape(c);
                  const options = c.value_type === 'band' && c.value_options?.length ? c.value_options : [null];
                  return options.map((opt) => (
                    <ConditionChip
                      key={`${c.condition_code}:${opt ?? ''}`}
                      condition={shape}
                      value={opt ?? undefined}
                      selected={selectedConditions.get(c.condition_code) === opt}
                      onSelect={() => toggleCondition(c, opt)}
                      onDeselect={() => toggleCondition(c, opt)}
                      disabled={saving}
                    />
                  ));
                })}
              </div>
            ))}
          </div>
        </section>

        {severity !== 'ok' && (
          <section aria-label="Deviation reason" style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
            <DeviationPicker
              reasons={OFFSET_REASONS}
              selectedCode={deviationReason?.code}
              onSelect={setDeviationReason}
              onClear={() => setDeviationReason(null)}
              disabled={saving}
              label={
                severity === 'block'
                  ? 'Reason for offset — required, this point is beyond the block threshold *'
                  : 'Reason for offset (optional at this distance)'
              }
            />
          </section>
        )}

        <section aria-label="Depth and cores" style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
          <SectionLabel>Depth &amp; cores</SectionLabel>
          <DepthCoresToggle
            depthAchievedCm={depthAchievedCm}
            coresTaken={coresTaken}
            specDepthTopCm={spec?.depth_top_cm ?? undefined}
            specDepthBottomCm={spec?.depth_bottom_cm ?? undefined}
            specCoresMin={spec?.cores_per_composite_min ?? undefined}
            specCoresMax={spec?.cores_per_composite_max ?? undefined}
            onDepthChange={setDepthAchievedCm}
            onCoresChange={setCoresTaken}
            disabled={saving}
          />
        </section>

        <section aria-label="Note">
          <Input
            label="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything else worth recording"
            disabled={saving}
          />
        </section>
      </div>

      <footer
        style={{
          padding: SPACING.lg,
          paddingBottom: `calc(${SPACING.lg} + env(safe-area-inset-bottom))`,
          borderTop: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
          display: 'flex',
          flexDirection: 'column',
          gap: SPACING.sm,
        }}
      >
        {saveError && <Badge label={saveError} status="error" />}
        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={handleSave}
          disabled={saving || !session || (severity === 'block' && !deviationReason)}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </footer>
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

function CaptureMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div style={{ padding: SPACING.xl, color: SEMANTIC_COLORS.textPrimary }}>
      <Badge label={text} status="info" />
    </div>
  );
}

function toConditionShape(c: DeviceConditionCode): ConditionCode {
  return {
    code: c.condition_code,
    group: (c.condition_group ?? 'soil') as ConditionGroup,
    displayLabel: c.display_label ?? c.condition_code,
    valueType: (c.value_type ?? 'none') as ConditionValueType,
    valueOptions: c.value_options ?? undefined,
    sortOrder: c.sort_order ?? 0,
    isActive: true,
  };
}

function groupConditionCodes(codes: DeviceConditionCode[]): Array<[string, DeviceConditionCode[]]> {
  const groups = new Map<string, DeviceConditionCode[]>();
  for (const c of codes) {
    const key = c.condition_group ?? 'other';
    const list = groups.get(key);
    if (list) list.push(c);
    else groups.set(key, [c]);
  }
  return [...groups.entries()];
}
