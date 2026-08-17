/**
 * B7 wiring — the live camera preview + shutter, shared by every photo tile.
 *
 * One `<video>` element, owned and created by `CaptureSession`
 * (`@app/capture/index.js`) — this component only mounts it into its own
 * container and drives `openCamera()`/`capturePhoto()`/`closeCamera()`. It
 * never touches `getUserMedia` itself, which is what keeps the "only a live
 * camera frame can satisfy a required role" guarantee a property of the
 * capture path rather than of this component's discipline.
 *
 * Opens on mount (framing the shot), shuts on unmount or Cancel; the shutter
 * calls `session.capturePhoto(role)`, which grabs the frame already live in
 * the preview rather than opening a second stream.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Badge, SEMANTIC_COLORS, SPACING, TOUCH_TARGETS, FONT_WEIGHTS } from '@app/components/index.js';
import type { CaptureSession, CameraUnavailableReason } from '@app/capture/index.js';
import type { MediaRole } from '@shared/contract/common.js';

export interface CaptureCameraPanelProps {
  session: CaptureSession;
  role: MediaRole;
  label: string;
  onDone: () => void;
}

const CAMERA_ERROR_TEXT: Record<CameraUnavailableReason, string> = {
  no_media_devices: 'No camera API on this browser.',
  no_dom: 'No document to attach the camera to.',
  permission_denied: 'Camera permission was denied.',
  no_camera: 'No camera found on this device.',
  not_open: 'Camera is not open.',
  track_ended: 'Camera feed stopped — try again.',
  frame_not_ready: 'Camera has not produced a frame yet — hold still a moment.',
  encode_failed: 'Could not process the camera frame.',
  other: 'Camera unavailable.',
};

export function CaptureCameraPanel({ session, role, label, onDone }: CaptureCameraPanelProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'opening' | 'live' | 'error'>('opening');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await session.openCamera();
      if (cancelled) return;
      if (!result.ok) {
        setStatus('error');
        setError(CAMERA_ERROR_TEXT[result.reason]);
        return;
      }
      setStatus('live');
    })();
    return () => {
      cancelled = true;
    };
    // Opens exactly once per mount — a fresh panel per role (`key={role}` at
    // the call site) is what makes re-running this safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status !== 'live') return;
    const video = session.cameraView();
    const container = containerRef.current;
    if (video && container && video.parentElement !== container) {
      container.replaceChildren(video);
      video.style.width = '100%';
      video.style.maxHeight = '320px';
      video.style.borderRadius = '8px';
      video.style.background = '#000';
      video.style.objectFit = 'cover';
    }
  }, [status, session]);

  const shutter = async () => {
    setBusy(true);
    setError(null);
    const outcome = await session.capturePhoto(role);
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.detail ?? outcome.reason);
      return;
    }
    session.closeCamera();
    onDone();
  };

  const cancel = () => {
    session.closeCamera();
    onDone();
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: SPACING.md,
        padding: SPACING.md,
        background: SEMANTIC_COLORS.bgSecondary,
        borderRadius: 8,
      }}
    >
      <div style={{ fontWeight: FONT_WEIGHTS.semibold, color: SEMANTIC_COLORS.textPrimary }}>{label}</div>
      <div ref={containerRef} aria-label={`${label} camera viewfinder`} />
      {error && <Badge label={error} status="error" />}
      <div style={{ display: 'flex', gap: SPACING.md }}>
        <button
          type="button"
          onClick={shutter}
          disabled={status !== 'live' || busy}
          aria-label={`Take ${label} photo`}
          style={{
            flex: 1,
            minHeight: TOUCH_TARGETS.xlarge,
            borderRadius: 999,
            border: 'none',
            background: SEMANTIC_COLORS.buttonPrimaryBg,
            color: SEMANTIC_COLORS.buttonPrimaryText,
            fontWeight: FONT_WEIGHTS.bold,
            fontSize: 16,
            cursor: status !== 'live' || busy ? 'not-allowed' : 'pointer',
            opacity: status !== 'live' || busy ? 0.6 : 1,
          }}
        >
          {busy ? 'Saving…' : status === 'opening' ? 'Opening camera…' : '● Shutter'}
        </button>
        <button
          type="button"
          onClick={cancel}
          style={{
            minHeight: TOUCH_TARGETS.xlarge,
            minWidth: TOUCH_TARGETS.xlarge,
            borderRadius: 8,
            border: `1px solid ${SEMANTIC_COLORS.borderDefault}`,
            background: SEMANTIC_COLORS.bgPrimary,
            color: SEMANTIC_COLORS.textPrimary,
            cursor: 'pointer',
          }}
          aria-label="Cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
