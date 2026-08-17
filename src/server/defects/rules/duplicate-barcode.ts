/**
 * `BARCODE_DUPLICATE` — the same barcode on two bags.
 *
 * Reference implementation for A8. Note what it does *not* do: it does not
 * normalise the barcode, and it does not void either bag. A duplicate barcode
 * on a bag that is already in a box is a real fact about the physical world,
 * and the analyst queue owns deciding which one is which. The rule's job is to
 * make sure a human sees it.
 *
 * Both scopes matter and they fail differently:
 *   - **within the batch** — two bags from the same day, usually a scanner
 *     re-read or a mis-picked label;
 *   - **against the warehouse** — a label reused across visits, which the crew
 *     cannot see and only this check will catch.
 */

import { DEFECT_CODE } from '../../../shared/codes/index.js';
import type { DefectFinding, DefectRule, RuleContext } from '../types.js';

export const duplicateBarcodeRule: DefectRule = {
  code: DEFECT_CODE.BARCODE_DUPLICATE,
  description: 'This barcode is already on another bag',

  run(ctx: RuleContext): DefectFinding[] {
    const findings: DefectFinding[] = [];
    const seenInBatch = new Map<string, string>();

    for (const bag of ctx.bags) {
      if (bag.void_flag) continue;
      if (!bag.barcode_raw) continue;

      const key = `${bag.lab_id ?? ''}|${bag.barcode_raw}`;

      const priorInBatch = seenInBatch.get(key);
      if (priorInBatch) {
        findings.push({
          bag_id: bag.bag_id,
          sample_uid: bag.sample_uid,
          defect_code: DEFECT_CODE.BARCODE_DUPLICATE,
          severity: 'review',
          detail: `barcode ${bag.barcode_raw} is also on bag ${priorInBatch} in this batch`,
        });
        continue;
      }
      seenInBatch.set(key, bag.bag_id);

      const priorInWarehouse = ctx.knownBarcodes.get(key);
      if (priorInWarehouse && priorInWarehouse !== bag.bag_id) {
        findings.push({
          bag_id: bag.bag_id,
          sample_uid: bag.sample_uid,
          defect_code: DEFECT_CODE.BARCODE_DUPLICATE,
          severity: 'review',
          detail: `barcode ${bag.barcode_raw} is already recorded on bag ${priorInWarehouse}`,
        });
      }
    }
    return findings;
  },
};
