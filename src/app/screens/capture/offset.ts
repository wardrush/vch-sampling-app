/**
 * B7 wiring — v02 §2: "Beyond the spec's block threshold from plan, a
 * deviation reason picker appears and must be answered. Under the warn
 * threshold it never appears."
 *
 * Pure classification, kept separate from the screen so it is testable
 * without a DOM, a camera, or a GPS fix.
 */

export type OffsetSeverity = 'ok' | 'warn' | 'block';

export function classifyOffset(offsetM: number, warnM: number, blockM: number): OffsetSeverity {
  if (offsetM > blockM) return 'block';
  if (offsetM > warnM) return 'warn';
  return 'ok';
}
