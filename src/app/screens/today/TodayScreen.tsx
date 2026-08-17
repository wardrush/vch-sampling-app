/**
 * Screen 1 · Today (v02 §2). B4.
 *
 * Assigned boundaries sorted by route, each with a progress ring, acres, and
 * a tap-to-call access contact. Permanently visible: outbox count and days
 * until bundle expiry. "Yesterday's flags" is a v1.5 feature (needs the
 * down-sync endpoint `/v1/defects/open`, currently a 501 stub per
 * `netlify/functions/sync-defects-open.ts`) — the slot is built below,
 * gated by `FEATURE_YESTERDAYS_FLAGS = false`, so wiring it later is a flag
 * flip plus a data source, not new layout work.
 *
 * First screen a sampler sees, so it also owns the one-time assignment
 * bundle download: if the device has never applied one, it fetches and
 * applies it here (`@app/shell/bundle/{client,apply}.js`) before rendering
 * the boundary list. Every screen downstream (Field, Capture) reads what
 * this write already put in the device database — nothing else in this
 * lane re-fetches it.
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, SEMANTIC_COLORS, SPACING, FONT_SIZES, FONT_WEIGHTS, TOUCH_TARGETS } from '@app/components/index.js';
import { useDeviceDb } from '@app/shell/db/DeviceDbProvider.js';
import { fieldPath } from '@app/shell/routes.js';
import { fetchAssignmentBundle } from '@app/shell/bundle/client.js';
import { applyBundleToDevice } from '@app/shell/bundle/apply.js';
import {
  getLatestBundleManifest,
  listBoundarySummaries,
  type BoundarySummary,
} from '@app/shell/bundle/queries.js';
import { OutboxStore } from '@sync/outbox-store.js';

/** v1.5 — off until the down-sync endpoint is real. See module header. */
const FEATURE_YESTERDAYS_FLAGS = false;

export function TodayScreen(): React.JSX.Element {
  const dbState = useDeviceDb();

  const [boundaries, setBoundaries] = useState<BoundarySummary[] | null>(null);
  const [expiresTs, setExpiresTs] = useState<string | null>(null);
  const [outboxPending, setOutboxPending] = useState<number | null>(null);
  const [bundleSource, setBundleSource] = useState<'network' | 'local_fixture' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (dbState.status !== 'ready') return;
    let cancelled = false;
    const db = dbState.db;

    (async () => {
      try {
        let manifest = await getLatestBundleManifest(db);
        if (!manifest) {
          // First run — nothing downloaded yet. Contract §2: replace, never
          // patch, so this only ever runs once per device until a real
          // "refresh assignments" action exists (not built this wave).
          const { bundle, source } = await fetchAssignmentBundle();
          if (cancelled) return;
          setBundleSource(source);
          await applyBundleToDevice(db, bundle);
          manifest = await getLatestBundleManifest(db);
        }
        if (cancelled) return;
        setExpiresTs(manifest?.expires_ts ?? null);

        const [summaries, counts] = await Promise.all([
          listBoundarySummaries(db),
          new OutboxStore(db).counts(),
        ]);
        if (cancelled) return;
        setBoundaries(summaries);
        setOutboxPending(counts.pending + counts.in_flight + counts.failed);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load assignments.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dbState.status, dbState.status === 'ready' ? dbState.db : null]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.lg, padding: SPACING.lg }}>
      <StatusStrip
        outboxPending={outboxPending}
        expiresTs={expiresTs}
        bundleSource={bundleSource}
        dbReady={dbState.status === 'ready'}
      />

      {FEATURE_YESTERDAYS_FLAGS && <YesterdaysFlagsSlot flags={[]} />}

      {error && <Badge label={error} status="error" />}

      {dbState.status === 'loading' && <Badge label="Opening device database…" status="neutral" />}
      {dbState.status === 'error' && (
        <Badge label={`Device database unavailable: ${dbState.error.message}`} status="error" />
      )}

      {boundaries === null && dbState.status === 'ready' && !error && (
        <Badge label="Loading assignments…" status="neutral" />
      )}

      {boundaries !== null && boundaries.length === 0 && (
        <Badge label="No boundaries assigned for this period." status="info" />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.md }}>
        {boundaries?.map((b) => (
          <BoundaryCard key={b.boundary_id} boundary={b} />
        ))}
      </div>
    </div>
  );
}

function StatusStrip({
  outboxPending,
  expiresTs,
  bundleSource,
  dbReady,
}: {
  outboxPending: number | null;
  expiresTs: string | null;
  bundleSource: 'network' | 'local_fixture' | null;
  dbReady: boolean;
}): React.JSX.Element {
  const daysLeft = expiresTs ? daysUntil(expiresTs) : null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm }}>
      <Link to="/outbox" style={{ textDecoration: 'none' }}>
        <Badge
          label={outboxPending === null ? 'Outbox —' : `Outbox: ${outboxPending} pending`}
          status={outboxPending && outboxPending > 0 ? 'warning' : 'success'}
        />
      </Link>
      {daysLeft !== null && (
        <Badge
          label={daysLeft <= 7 ? `Assignments expire in ${daysLeft}d` : `Assignments valid ${daysLeft}d`}
          status={daysLeft <= 7 ? 'warning' : 'neutral'}
        />
      )}
      {dbReady && bundleSource === 'local_fixture' && (
        <Badge label="Demo data (no assignments server reachable)" status="info" />
      )}
    </div>
  );
}

function BoundaryCard({ boundary }: { boundary: BoundarySummary }): React.JSX.Element {
  const total = boundary.totalPoints;
  const done = boundary.sampledPoints + boundary.skippedPoints;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <Link
      to={fieldPath(boundary.boundary_id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: SPACING.lg,
        minHeight: TOUCH_TARGETS.xlarge,
        padding: SPACING.lg,
        borderRadius: 12,
        border: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
        background: SEMANTIC_COLORS.bgPrimary,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <ProgressRing percent={pct} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: FONT_SIZES.lg, fontWeight: FONT_WEIGHTS.bold, color: SEMANTIC_COLORS.textPrimary }}>
          {boundary.property_name ?? boundary.boundary_id}
        </div>
        <div style={{ fontSize: FONT_SIZES.sm, color: SEMANTIC_COLORS.textSecondary }}>
          {boundary.geom_acres ? `${boundary.geom_acres.toFixed(1)} ac · ` : ''}
          {done} of {total} points
        </div>
        {boundary.primaryContactPhone && (
          <a
            href={`tel:${boundary.primaryContactPhone}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: TOUCH_TARGETS.minimal,
              marginTop: SPACING.xs,
              fontSize: FONT_SIZES.sm,
              color: SEMANTIC_COLORS.buttonPrimaryBg,
              fontWeight: FONT_WEIGHTS.semibold,
              textDecoration: 'none',
            }}
          >
            📞 {boundary.primaryContactName ?? boundary.primaryContactPhone}
          </a>
        )}
      </div>
    </Link>
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

/** The v1.5 empty slot. Never rendered while `FEATURE_YESTERDAYS_FLAGS` is
 *  false — exists so the down-sync endpoint has somewhere to land without a
 *  second pass at this screen's layout. */
function YesterdaysFlagsSlot({ flags }: { flags: never[] }): React.JSX.Element {
  return (
    <div style={{ padding: SPACING.md, border: `1px dashed ${SEMANTIC_COLORS.borderDefault}`, borderRadius: 8 }}>
      <div style={{ fontWeight: FONT_WEIGHTS.semibold, color: SEMANTIC_COLORS.textPrimary }}>
        Yesterday&rsquo;s flags
      </div>
      <div style={{ fontSize: FONT_SIZES.sm, color: SEMANTIC_COLORS.textSecondary }}>
        {flags.length === 0 ? 'None yet.' : `${flags.length} flagged overnight.`}
      </div>
    </div>
  );
}

function daysUntil(isoTs: string): number {
  const ms = Date.parse(isoTs) - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}
