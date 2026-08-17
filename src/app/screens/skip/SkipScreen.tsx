/**
 * Screen 4 · Skip (v02 §2, B10)
 *
 * A plan point that cannot be sampled is recorded with:
 * - A reason code (from SKIP_ONLY_REASONS, source: SAMPLING_SCHEMA_v01.md §4.5)
 * - Optional photo (captured in-app to establish point presence)
 * - Optional note (free text explaining the skip)
 *
 * An unsampled point that is never explicitly skipped becomes a defect
 * at the plan's close date, so this screen is mandatory for offline-first sync.
 *
 * Route params: boundaryId, pointId (plan_point_id)
 */

import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Input, DeviationPicker, SPACING } from '@app/components/index.js';
import { SKIP_ONLY_REASONS } from '@shared/codes/index.js';
import type { DeviationReason } from '@shared/codes/index.js';

export function SkipScreen() {
  const { boundaryId, pointId } = useParams<{ boundaryId: string; pointId: string }>();

  const [selectedReason, setSelectedReason] = useState<DeviationReason | null>(null);
  const [note, setNote] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  if (!boundaryId || !pointId) {
    return (
      <div style={{ padding: SPACING.lg }}>
        <p style={{ color: '#d32f2f', fontWeight: 600 }}>Error: Missing boundary or point ID</p>
      </div>
    );
  }

  const handleSave = async () => {
    // Validation: reason is required
    if (!selectedReason) {
      alert('Please select a reason for skipping this point.');
      return;
    }

    setIsSaving(true);
    try {
      // TODO: Write to local database via DeviceDb
      // const db = useDeviceDb();
      // await db.insertSampleSkip({
      //   plan_point_id: pointId,
      //   boundary_id: boundaryId,
      //   deviation_reason_code: selectedReason.code,
      //   skip_note: note || null,
      //   created_ts: new Date().toISOString(),
      // });
      // Then navigate back to Field screen
      console.log('Skip recorded:', {
        boundaryId,
        pointId,
        reason: selectedReason.code,
        note: note || null,
      });
      alert('Point skipped. (Local save not yet wired.)');
      // TODO: navigate back to field screen
    } catch (error) {
      console.error('Failed to save skip:', error);
      alert('Failed to save skip. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = () => {
    setSelectedReason(null);
    setNote('');
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: '#f5f5f0',
      }}
    >
      {/* Header */}
      <div
        style={{
          backgroundColor: '#fff',
          borderBottom: '1px solid #ddd',
          padding: SPACING.lg,
          textAlign: 'center',
        }}
      >
        <h1
          style={{
            fontSize: '18px',
            fontWeight: 700,
            margin: 0,
            color: '#333',
          }}
        >
          Skip Point
        </h1>
        <p
          style={{
            fontSize: '13px',
            color: '#666',
            margin: `${SPACING.sm} 0 0 0`,
          }}
        >
          {boundaryId} · {pointId}
        </p>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: SPACING.lg,
          display: 'flex',
          flexDirection: 'column',
          gap: SPACING.lg,
        }}
      >
        {/* Reason picker */}
        <section>
          <DeviationPicker
            reasons={SKIP_ONLY_REASONS}
            selectedCode={selectedReason?.code}
            onSelect={setSelectedReason}
            onClear={() => setSelectedReason(null)}
            label="Reason for skipping *"
          />
        </section>

        {/* Selected reason details */}
        {selectedReason && selectedReason.requiresNote && (
          <section>
            <p
              style={{
                fontSize: '12px',
                color: '#d97706',
                fontWeight: 500,
                margin: `0 0 ${SPACING.sm} 0`,
              }}
            >
              Note required for this reason
            </p>
          </section>
        )}

        {/* Optional note */}
        <section>
          <Input
            label="Additional notes (optional)"
            placeholder="e.g., Locked gate, water across field"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={isSaving}
          />
        </section>

        {/* Photo guidance (optional feature, MVP may not have camera integration) */}
        <section
          style={{
            padding: SPACING.md,
            backgroundColor: '#fff8f0',
            border: '1px solid #d4a574',
            borderRadius: '6px',
          }}
        >
          <p style={{ fontSize: '13px', margin: 0, color: '#333' }}>
            Optional: Take a photo to establish point presence (not yet implemented in this wave)
          </p>
        </section>
      </div>

      {/* Footer buttons */}
      <div
        style={{
          display: 'flex',
          gap: SPACING.md,
          padding: SPACING.lg,
          backgroundColor: '#fff',
          borderTop: '1px solid #ddd',
          justifyContent: 'flex-end',
        }}
      >
        <Button variant="secondary" onClick={handleClear} disabled={isSaving} size="md">
          Clear
        </Button>
        <Button
          variant="primary"
          onClick={handleSave}
          disabled={isSaving || !selectedReason}
          size="md"
        >
          {isSaving ? 'Saving...' : 'Save & Close'}
        </Button>
      </div>
    </div>
  );
}

SkipScreen.displayName = 'SkipScreen';
