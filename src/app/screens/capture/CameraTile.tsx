/**
 * B7 wiring — one of the three (or more) photo tiles on Capture (v02 §2).
 *
 * Purely presentational: the actual `getUserMedia` lifecycle and the
 * `capture_source` = `'in_app_camera'` guarantee live in `CaptureSession`
 * (`@app/capture/index.js`, `capture-integrity`'s wave-2 landing) — this
 * component only shows a role's current count/thumbnail and asks the parent
 * screen to open the shared camera panel (`CaptureCameraPanel.tsx`) for it.
 * One camera lifecycle, one `<video>` element, shared across every role — a
 * tile choosing to own a second `getUserMedia` stream is exactly the
 * duplicate-camera-instance bug `<BoundaryMap>`'s own "one instance per
 * mount" rule exists to prevent in the map, applied here to the camera.
 */

import React from 'react';
import { Badge, SEMANTIC_COLORS, SPACING, TOUCH_TARGETS, FONT_WEIGHTS } from '@app/components/index.js';

export interface CameraTileProps {
  label: string;
  required: boolean;
  count: number;
  thumbnailUrl?: string | null;
  onOpen: () => void;
  disabled?: boolean;
  error?: string | null;
}

export function CameraTile({
  label,
  required,
  count,
  thumbnailUrl,
  onOpen,
  disabled = false,
  error,
}: CameraTileProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: SPACING.md,
        minHeight: TOUCH_TARGETS.xlarge,
        width: '100%',
        padding: SPACING.md,
        borderRadius: 8,
        border: `1px solid ${count > 0 ? SEMANTIC_COLORS.buttonPrimaryBg : SEMANTIC_COLORS.borderDefault}`,
        background: SEMANTIC_COLORS.bgPrimary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        textAlign: 'left',
      }}
    >
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt=""
          width={48}
          height={48}
          style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0 }}
        />
      ) : (
        <div
          aria-hidden="true"
          style={{
            width: 48,
            height: 48,
            borderRadius: 6,
            background: SEMANTIC_COLORS.bgSecondary,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 20,
          }}
        >
          📷
        </div>
      )}
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: FONT_WEIGHTS.semibold, color: SEMANTIC_COLORS.textPrimary }}>
          {label} {required && <span style={{ color: SEMANTIC_COLORS.textSecondary }}>*</span>}
        </div>
        <div style={{ fontSize: 13, color: SEMANTIC_COLORS.textSecondary }}>
          {count === 0 ? 'Tap to take a photo' : `${count} photo${count === 1 ? '' : 's'} — tap for another`}
        </div>
        {error && <Badge label={error} status="error" size="sm" />}
      </div>
      {count > 0 && <Badge label={count} status="success" />}
    </button>
  );
}
