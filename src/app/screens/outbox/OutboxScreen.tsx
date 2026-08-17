/**
 * Screen 5 · Outbox (v02 §2). B11.
 *
 * "A silently stuck outbox is the failure mode that loses a season, so it is
 * a screen rather than a spinner." Pending records, pending photo megabytes,
 * last successful sync, a manual sync button, and — the part a spinner
 * cannot give you — a per-record failure reason.
 *
 * The manual sync button is real: it builds an `OutboxWorker`
 * (`@sync/outbox-worker.js`, `sync-spine`'s A3) over a `fetch`-based
 * transport to `/v1/sync/batch` and calls `drain({ force: true })`. Under
 * plain `npm run dev` (`vite`, no functions runtime — see the wave-2 report)
 * that POST has nowhere real to land, and the transport below says so in the
 * failure reason rather than a generic "network error" — which is itself
 * this screen doing its job.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, SEMANTIC_COLORS, SPACING, FONT_SIZES, FONT_WEIGHTS } from '@app/components/index.js';
import { useDeviceDb } from '@app/shell/db/DeviceDbProvider.js';
import { getOrCreateDeviceId } from '@app/shell/device-id.js';
import { getLastSyncedTs, listRecentOutboxRecords, pendingPhotoBytes, type OutboxRecordRow } from '@app/shell/outbox-queries.js';
import { OutboxStore } from '@sync/outbox-store.js';
import { OutboxWorker, TransportError, type DrainResult, type SyncTransport } from '@sync/outbox-worker.js';
import type { SyncBatchResponse } from '@shared/contract/sync.js';

const APP_VERSION = '0.1.0-dev';

const fetchTransport: SyncTransport = {
  async postBatch(request) {
    let res: Response;
    try {
      res = await fetch('/v1/sync/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch (err) {
      throw new TransportError(err instanceof Error ? err.message : 'Network error reaching sync.', true);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!res.ok || !contentType.includes('application/json')) {
      throw new TransportError(
        `Sync endpoint unreachable (HTTP ${res.status}). Functions aren't served under plain "vite dev" — try "netlify dev" or a deployed preview.`,
        res.status >= 500,
      );
    }
    return (await res.json()) as SyncBatchResponse;
  },
};

export function OutboxScreen(): React.JSX.Element {
  const dbState = useDeviceDb();

  const [counts, setCounts] = useState<Record<'pending' | 'in_flight' | 'acked' | 'failed', number> | null>(null);
  const [photoBytes, setPhotoBytes] = useState<number | null>(null);
  const [lastSyncedTs, setLastSyncedTs] = useState<string | null>(null);
  const [records, setRecords] = useState<OutboxRecordRow[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [lastDrain, setLastDrain] = useState<DrainResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (dbState.status !== 'ready') return;
    const db = dbState.db;
    const store = new OutboxStore(db);
    const [c, bytes, synced, recent] = await Promise.all([
      store.counts(),
      pendingPhotoBytes(db),
      getLastSyncedTs(db),
      listRecentOutboxRecords(db),
    ]);
    setCounts(c);
    setPhotoBytes(bytes);
    setLastSyncedTs(synced);
    setRecords(recent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbState.status, dbState.status === 'ready' ? dbState.db : null]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSyncNow = async () => {
    if (dbState.status !== 'ready') return;
    setSyncing(true);
    setError(null);
    try {
      const store = new OutboxStore(dbState.db);
      const worker = new OutboxWorker({
        store,
        transport: fetchTransport,
        deviceId: getOrCreateDeviceId(),
        appVersion: APP_VERSION,
      });
      const result = await worker.drain({ force: true });
      setLastDrain(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed.');
    } finally {
      setSyncing(false);
      await refresh();
    }
  };

  const handleRetry = async (entityId: string) => {
    if (dbState.status !== 'ready') return;
    const store = new OutboxStore(dbState.db);
    await store.retryFailed(entityId);
    await refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.lg, padding: SPACING.lg }}>
      <div>
        <div style={{ fontSize: FONT_SIZES['2xl'], fontWeight: FONT_WEIGHTS.bold, color: SEMANTIC_COLORS.textPrimary }}>
          Outbox
        </div>
        <div style={{ fontSize: FONT_SIZES.sm, color: SEMANTIC_COLORS.textSecondary }}>
          {lastSyncedTs ? `Last synced ${formatRelative(lastSyncedTs)}` : 'Never synced yet'}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACING.sm }}>
        <Badge label={`Pending: ${counts?.pending ?? 0}`} status={counts && counts.pending > 0 ? 'warning' : 'success'} />
        <Badge label={`Syncing: ${counts?.in_flight ?? 0}`} status="info" />
        <Badge label={`Failed: ${counts?.failed ?? 0}`} status={counts && counts.failed > 0 ? 'error' : 'success'} />
        <Badge label={`Synced: ${counts?.acked ?? 0}`} status="neutral" />
        <Badge label={`Photos waiting: ${formatBytes(photoBytes ?? 0)}`} status="neutral" />
      </div>

      <Button variant="primary" size="lg" fullWidth onClick={handleSyncNow} disabled={syncing || dbState.status !== 'ready'}>
        {syncing ? 'Syncing…' : 'Sync now'}
      </Button>

      {error && <Badge label={error} status="error" />}
      {lastDrain && (
        <Badge
          label={`Last attempt — sent ${lastDrain.batchesSent} batch(es), accepted ${lastDrain.accepted}, retrying ${lastDrain.rejectedRetryable}, failed ${lastDrain.rejectedPermanent}${lastDrain.transportError ? `: ${lastDrain.transportError}` : ''}`}
          status={lastDrain.transportError ? 'warning' : 'info'}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.sm }}>
        <div style={{ fontWeight: FONT_WEIGHTS.semibold, color: SEMANTIC_COLORS.textPrimary }}>Records</div>
        {records.length === 0 && <Badge label="Nothing recorded yet — capture a point to see it here." status="neutral" />}
        {records.map((r) => (
          <div
            key={r.outbox_id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: SPACING.md,
              padding: SPACING.md,
              borderRadius: 8,
              border: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: FONT_WEIGHTS.semibold, color: SEMANTIC_COLORS.textPrimary }}>
                {r.entity_type} <span style={{ color: SEMANTIC_COLORS.textSecondary, fontWeight: FONT_WEIGHTS.regular }}>{r.entity_id.slice(0, 8)}</span>
              </div>
              {r.last_error && (
                <div style={{ fontSize: FONT_SIZES.xs, color: SEMANTIC_COLORS.chipErrorBg }}>{r.last_error}</div>
              )}
            </div>
            <Badge label={r.state} status={stateStatus(r.state)} />
            {r.state === 'failed' && (
              <Button variant="secondary" size="sm" onClick={() => handleRetry(r.entity_id)}>
                Retry
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function stateStatus(state: OutboxRecordRow['state']): 'success' | 'warning' | 'error' | 'info' {
  switch (state) {
    case 'acked':
      return 'success';
    case 'failed':
      return 'error';
    case 'in_flight':
      return 'info';
    default:
      return 'warning';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
