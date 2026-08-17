/**
 * The tutorial path's public surface — **a second door, not a wider first one.**
 *
 * `src/app/capture/index.ts` is unchanged by this work, including its
 * enumerated export list, because widening the production barrel to carry a
 * tutorial is the first step towards a screen reaching for a tutorial image in
 * a production session. A separate module means a screen's import line says
 * which branch it is on, and a reviewer can see it in the diff without reading
 * the body.
 *
 * Screens import from `@app/capture/tutorial/index.js` and nothing else under
 * `src/app/capture/tutorial/`.
 */

export {
  TutorialCaptureSession,
  createTutorialCaptureSession,
  type TutorialAttachedPhoto,
  type TutorialCaptureResult,
  type TutorialCaptureSessionOptions,
  type TutorialCaptureSessionState,
  type TutorialMediaRecord,
  type TutorialPhotoOutcome,
  type TutorialPosition,
  type TutorialSampleRecord,
} from './session.js';

export {
  TUTORIAL_GPS_TRACK,
  TUTORIAL_PLAN_POINT,
  TUTORIAL_SPEC,
  type TutorialPlanPoint,
} from './model-data.js';

export { scriptedTutorialGeolocation, type ScriptedGpsOptions } from './scripted-gps.js';

export {
  TUTORIAL_NOTICE,
  TUTORIAL_WATERMARK,
  canvasSyntheticImages,
  type SyntheticFrame,
  type SyntheticImageSource,
  type TutorialImage,
} from './synthetic.js';

export {
  TUTORIAL_ID_PREFIX,
  TutorialLeakError,
  isTutorialId,
  type TutorialCaptureSource,
  type TutorialPositionSource,
} from '../tutorial-boundary.js';

export { capturePhotoView, type CapturePhotoView } from './photo-view.js';

/**
 * Deliberately **not** exported here: `intakeSyntheticImage`.
 *
 * It is the one function that stamps `tutorial_synthetic` onto bytes, exactly
 * as `intakeFromCamera` is the one that stamps the in-app-camera value — and
 * for the same reason, it is not reachable from outside
 * `src/app/capture/`. `separation.test.ts` fails the build if a file outside
 * the capture path imports `tutorial/synthetic.js` directly.
 */
