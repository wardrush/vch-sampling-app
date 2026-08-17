/**
 * The line between the tutorial sandbox and the audit record.
 *
 * This file is on the **production** side of that line deliberately: nothing
 * under `tutorial/` is imported here, and the guards below are what the real
 * capture path uses to refuse anything the tutorial minted. A one-way
 * dependency, so deleting the whole tutorial directory would leave the
 * production guarantees intact rather than removing them.
 *
 * Plan v02 D18 gives every surface a first-run tutorial branch "on model data",
 * and says the tutorial sandbox commit is **discarded, never written to a real
 * plan**. That sentence is a requirement about what cannot happen, not about
 * what the app should try to avoid. Three mechanisms make it structural, and
 * they are all here or named from here:
 *
 *  1. **A reserved identifier namespace.** Every id the tutorial mints starts
 *     `tutorial-`. `assertNoTutorialIdentity` runs in the production
 *     `CaptureSession` constructor and again in `writeCaptureLocally` **before
 *     the transaction opens**, so a tutorial id cannot reach SQLite even if a
 *     screen hands one over by mistake.
 *  2. **A capture source that is not a `CaptureSource`.** `'tutorial_synthetic'`
 *     is deliberately *absent* from the wire union in
 *     `src/shared/contract/common.ts`. That is not an oversight to be tidied
 *     up later — it is the guarantee. Because the value does not exist in
 *     `CaptureSource`, a tutorial image cannot be widened into a
 *     `MediaMetaPayload`, and `MediaMetaPayload` is the only thing
 *     `writeCaptureLocally` will write. The compiler enforces it; no runtime
 *     check is load-bearing.
 *  3. **No database handle.** `createTutorialCaptureSession` takes no
 *     `SqlDatabase` and no `MediaBlobStore`. A module with nothing to write to
 *     cannot write.
 *
 * Why a prefix and not a boolean column: a boolean is a claim the row makes
 * about itself, and in 2029 the person reading it has no way to check it. A
 * `sample_uid` of `tutorial-sample-0192f…` is self-describing in a `SELECT`
 * with no join, in a CSV extract, and in a screenshot.
 */

/**
 * Reserved. No real capture may produce an id beginning with this, and every
 * tutorial id must.
 */
export const TUTORIAL_ID_PREFIX = 'tutorial-';

/**
 * The tutorial's capture source, as a **type**.
 *
 * The string literal itself is minted in exactly one function, in
 * `tutorial/synthetic.ts`, mirroring how `in_app_camera` and `device_gallery`
 * are each minted in exactly one function in `camera/intake.ts`. Both facts are
 * asserted by a source scan — see `tutorial/separation.test.ts`.
 */
export type TutorialCaptureSource = 'tutorial_synthetic';

/**
 * Position provenance inside the tutorial.
 *
 * Two values, not one, because "a satellite fix and a dropped pin are different
 * things" holds inside the sandbox too — a tutorial that blurred them would be
 * teaching the wrong thing on the one distinction v02 §9 is least willing to
 * lose. Neither value is a `PositionSource`, so neither can be written to
 * `sample_point.position_source`.
 */
export type TutorialPositionSource = 'tutorial_simulated_gps' | 'tutorial_manual_map_pin';

export function isTutorialId(id: string | null | undefined): boolean {
  if (typeof id !== 'string') return false;
  return id.toLowerCase().startsWith(TUTORIAL_ID_PREFIX);
}

/** Builds a tutorial id from an ordinary generated id. Prefix, never suffix. */
export function tutorialId(kind: string, base: string): string {
  return `${TUTORIAL_ID_PREFIX}${kind}-${base}`;
}

/**
 * Thrown, not returned.
 *
 * Every other refusal in the capture path is a discriminated result, because
 * the caller is a screen standing between a sampler and a field and the answer
 * belongs next to a tile. This one is different: it can only happen if the code
 * is wrong, there is no sampler action that fixes it, and swallowing it would
 * mean a tutorial photograph silently entering an evidence chain. It should
 * take the screen down.
 */
export class TutorialLeakError extends Error {
  constructor(
    readonly where: string,
    readonly field: string,
    readonly value: string,
  ) {
    super(
      `${where}: ${field} is a tutorial identifier (${value}). Tutorial records are ` +
        `discarded, never written to a real plan (plan v02 D18).`,
    );
    this.name = 'TutorialLeakError';
  }
}

/**
 * Refuses tutorial identifiers on the production path.
 *
 * Called from the `CaptureSession` constructor — so the refusal happens before
 * a camera is opened, before a byte is read, and before a row exists — and
 * again from `writeCaptureLocally` before its transaction opens, because the
 * session is not the only caller of the writer.
 */
export function assertNoTutorialIdentity(
  where: string,
  ids: Readonly<Record<string, string | null | undefined>>,
): void {
  for (const [field, value] of Object.entries(ids)) {
    if (isTutorialId(value)) {
      throw new TutorialLeakError(where, field, value as string);
    }
  }
}
