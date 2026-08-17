/**
 * Screen 3 · Capture (v02 §2). Placeholder for B1 — real content is B7 plus
 * the Screen-3 wiring, wave 2/3.
 *
 * `src/app/capture/gps.ts` (`GpsAcquisition`) and `src/app/capture/camera/**`
 * (B6/B8, already real per `SONNET_TASKS_STATUS.md`) are the logic this
 * screen wires up — GPS acquisition starts on mount here, not at submit,
 * which is why that module's `start()`/`stop()` contract exists.
 */

import { useParams } from 'react-router-dom';
import { ScreenPlaceholder } from '@app/shell/ScreenPlaceholder.js';

export function CaptureScreen() {
  const { boundaryId, pointId } = useParams<{ boundaryId: string; pointId: string }>();
  return (
    <ScreenPlaceholder
      name="Capture"
      screenNumber={3}
      owner="pwa-screens (B7 + wiring, wave 2/3)"
      note={`Boundary ${boundaryId}, point ${pointId}. GPS on open (capture/gps.ts), scan/photo/conditions, deviation picker above the block threshold.`}
    />
  );
}
