/**
 * Screen 2 · Field (v02 §2). Placeholder for B1 — real content is B5, wave 2.
 *
 * B5 needs `<BoundaryMap>` (`map-surface`'s B3, `src/shared/map/**`) real
 * before it can render the boundary polygon and planned points; this route
 * exists now so B5 has somewhere to import it into.
 */

import { useParams } from 'react-router-dom';
import { ScreenPlaceholder } from '@app/shell/ScreenPlaceholder.js';

export function FieldScreen() {
  const { boundaryId } = useParams<{ boundaryId: string }>();
  return (
    <ScreenPlaceholder
      name="Field"
      screenNumber={2}
      owner="pwa-screens (B5, wave 2)"
      note={`Boundary ${boundaryId} — polygon, planned points by state, live position. Waits on <BoundaryMap> (B3).`}
    />
  );
}
