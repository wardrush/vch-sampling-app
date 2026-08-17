/**
 * A8 — defect rules. Four rules implemented in wave 1.
 *
 * Each rule is tested with both a firing case and a clean case to ensure
 * false negatives and false positives are both prevented.
 */

import { describe, expect, it } from 'vitest';
import type { RuleContext, RuleSample, RuleBag, RuleMedia, RuleSpec } from '../../src/server/defects/types.js';
import {
  missingRequiredMediaRule,
  offsetExceededNoReasonRule,
  mediaGallerySourcedRule,
  depthShortfallRule,
} from '../../src/server/defects/rules/index.js';
import { DEFECT_CODE } from '../../src/shared/codes/index.js';

/**
 * Helper to build a minimal but valid context for testing.
 */
function makeContext(overrides: Partial<RuleContext>): RuleContext {
  return {
    sync_batch_id: 'batch_test',
    samples: [],
    bags: [],
    media: [],
    specs: new Map(),
    knownBarcodes: new Map(),
    ...overrides,
  };
}

function makeSample(overrides: Partial<RuleSample>): RuleSample {
  return {
    sample_uid: 'sample_test',
    visit_id: 'visit_test',
    plan_point_id: 'plan_test',
    boundary_id: 'boundary_test',
    lat: 47.9,
    lon: -103.2,
    gps_accuracy_m: 5,
    fix_count: 3,
    fix_spread_m: 0.5,
    position_source: 'gps',
    offset_from_plan_m: 5,
    deviation_reason_code: null,
    captured_ts_device: '2026-09-15T16:00:00Z',
    device_uptime_ms: 1000000,
    server_received_ts: '2026-09-15T16:00:05Z',
    depth_achieved_cm: null,
    spec_id: 'spec_test',
    ...overrides,
  };
}

function makeMedia(overrides: Partial<RuleMedia>): RuleMedia {
  return {
    media_id: 'media_test',
    sample_uid: 'sample_test',
    media_role: 'site_photo',
    is_required_role: true,
    capture_source: 'in_app_camera',
    exif_lat: null,
    exif_lon: null,
    exif_ts: null,
    ...overrides,
  };
}

function makeSpec(overrides: Partial<RuleSpec>): RuleSpec {
  return {
    spec_id: 'spec_test',
    required_media_roles: ['label_photo', 'core_photo', 'site_photo'],
    gps_accuracy_required_m: 10,
    min_gps_fix_count: 3,
    max_plan_offset_m_warn: 15,
    max_plan_offset_m_block: 30,
    depth_top_cm: 0,
    depth_bottom_cm: 30,
    ...overrides,
  };
}

describe('A8 — Defect Rules', () => {
  // ========================================================================
  // MISSING_REQUIRED_MEDIA
  // ========================================================================

  describe('MISSING_REQUIRED_MEDIA', () => {
    it('fires when a required role is missing', () => {
      const spec = makeSpec({ required_media_roles: ['label_photo', 'core_photo', 'site_photo'] });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1' })],
        media: [
          makeMedia({ sample_uid: 'sample_1', media_role: 'label_photo', is_required_role: true }),
          makeMedia({ sample_uid: 'sample_1', media_role: 'core_photo', is_required_role: true }),
          // site_photo is missing
        ],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = missingRequiredMediaRule.run(ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.defect_code).toBe(DEFECT_CODE.MISSING_REQUIRED_MEDIA);
      expect(findings[0]!.sample_uid).toBe('sample_1');
      expect(findings[0]!.detail).toContain('site_photo');
    });

    it('does not fire when all required roles are present', () => {
      const spec = makeSpec({ required_media_roles: ['label_photo', 'core_photo', 'site_photo'] });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1' })],
        media: [
          makeMedia({ sample_uid: 'sample_1', media_role: 'label_photo', is_required_role: true }),
          makeMedia({ sample_uid: 'sample_1', media_role: 'core_photo', is_required_role: true }),
          makeMedia({ sample_uid: 'sample_1', media_role: 'site_photo', is_required_role: true }),
        ],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = missingRequiredMediaRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('does not fire when sample has no spec', () => {
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: null })],
        media: [
          makeMedia({ sample_uid: 'sample_1', media_role: 'label_photo', is_required_role: true }),
        ],
        specs: new Map(),
      });

      const findings = missingRequiredMediaRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('does not fire when spec has no required roles', () => {
      const spec = makeSpec({ required_media_roles: [] });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1' })],
        media: [],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = missingRequiredMediaRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('allows multiple photos of the same role', () => {
      const spec = makeSpec({ required_media_roles: ['site_photo'] });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1' })],
        media: [
          makeMedia({ sample_uid: 'sample_1', media_role: 'site_photo', is_required_role: true, media_id: 'media_1' }),
          makeMedia({ sample_uid: 'sample_1', media_role: 'site_photo', is_required_role: true, media_id: 'media_2' }),
          makeMedia({ sample_uid: 'sample_1', media_role: 'site_photo', is_required_role: true, media_id: 'media_3' }),
        ],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = missingRequiredMediaRule.run(ctx);
      expect(findings).toHaveLength(0);
    });
  });

  // ========================================================================
  // OFFSET_EXCEEDED_NO_REASON
  // ========================================================================

  describe('OFFSET_EXCEEDED_NO_REASON', () => {
    it('fires when offset exceeds block threshold with no reason', () => {
      const spec = makeSpec({ max_plan_offset_m_block: 30 });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1', offset_from_plan_m: 50, deviation_reason_code: null, plan_point_id: 'plan_1' })],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = offsetExceededNoReasonRule.run(ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.defect_code).toBe(DEFECT_CODE.OFFSET_EXCEEDED_NO_REASON);
      expect(findings[0]!.sample_uid).toBe('sample_1');
    });

    it('does not fire when offset is within block threshold', () => {
      const spec = makeSpec({ max_plan_offset_m_block: 30 });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1', offset_from_plan_m: 25, deviation_reason_code: null, plan_point_id: 'plan_1' })],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = offsetExceededNoReasonRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('does not fire when offset exceeds threshold but reason is provided', () => {
      const spec = makeSpec({ max_plan_offset_m_block: 30 });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1', offset_from_plan_m: 50, deviation_reason_code: 'access_denied', plan_point_id: 'plan_1' })],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = offsetExceededNoReasonRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('does not fire when sample has no plan point', () => {
      const spec = makeSpec({ max_plan_offset_m_block: 30 });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1', offset_from_plan_m: 50, plan_point_id: null })],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = offsetExceededNoReasonRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('does not fire when spec has no block threshold', () => {
      const spec = makeSpec({ max_plan_offset_m_block: null });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1', offset_from_plan_m: 50, deviation_reason_code: null, plan_point_id: 'plan_1' })],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = offsetExceededNoReasonRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('does not fire when offset is null', () => {
      const spec = makeSpec({ max_plan_offset_m_block: 30 });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1', offset_from_plan_m: null, plan_point_id: 'plan_1' })],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = offsetExceededNoReasonRule.run(ctx);
      expect(findings).toHaveLength(0);
    });
  });

  // ========================================================================
  // MEDIA_GALLERY_SOURCED
  // ========================================================================

  describe('MEDIA_GALLERY_SOURCED', () => {
    it('fires when required media came from device gallery', () => {
      const ctx = makeContext({
        media: [
          makeMedia({ sample_uid: 'sample_1', media_role: 'label_photo', is_required_role: true, capture_source: 'device_gallery' }),
        ],
      });

      const findings = mediaGallerySourcedRule.run(ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.defect_code).toBe(DEFECT_CODE.MEDIA_GALLERY_SOURCED);
      expect(findings[0]!.sample_uid).toBe('sample_1');
      expect(findings[0]!.detail).toContain('label_photo');
    });

    it('does not fire when required media came from in-app camera', () => {
      const ctx = makeContext({
        media: [
          makeMedia({ sample_uid: 'sample_1', media_role: 'label_photo', is_required_role: true, capture_source: 'in_app_camera' }),
        ],
      });

      const findings = mediaGallerySourcedRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('does not fire for optional media from gallery', () => {
      const ctx = makeContext({
        media: [
          makeMedia({ sample_uid: 'sample_1', media_role: 'issue_photo', is_required_role: false, capture_source: 'device_gallery' }),
        ],
      });

      const findings = mediaGallerySourcedRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('does not fire for media not attached to a sample', () => {
      const ctx = makeContext({
        media: [
          makeMedia({ sample_uid: null, media_role: 'label_photo', is_required_role: true, capture_source: 'device_gallery' }),
        ],
      });

      const findings = mediaGallerySourcedRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('flags multiple gallery photos on the same sample', () => {
      const ctx = makeContext({
        media: [
          makeMedia({ sample_uid: 'sample_1', media_role: 'label_photo', is_required_role: true, capture_source: 'device_gallery', media_id: 'media_1' }),
          makeMedia({ sample_uid: 'sample_1', media_role: 'core_photo', is_required_role: true, capture_source: 'device_gallery', media_id: 'media_2' }),
        ],
      });

      const findings = mediaGallerySourcedRule.run(ctx);
      expect(findings).toHaveLength(2);
      const details = findings.map((f) => f.detail).join(' ');
      expect(details).toContain('label_photo');
      expect(details).toContain('core_photo');
    });
  });

  // ========================================================================
  // DEPTH_SHORTFALL
  // ========================================================================

  describe('DEPTH_SHORTFALL', () => {
    it('fires when achieved depth is less than spec minimum', () => {
      const spec = makeSpec({ depth_bottom_cm: 30 });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1', depth_achieved_cm: 25 })],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = depthShortfallRule.run(ctx);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.defect_code).toBe(DEFECT_CODE.DEPTH_SHORTFALL);
      expect(findings[0]!.sample_uid).toBe('sample_1');
    });

    it('does not fire when achieved depth meets spec minimum', () => {
      const spec = makeSpec({ depth_bottom_cm: 30 });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1', depth_achieved_cm: 30 })],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = depthShortfallRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('does not fire when achieved depth exceeds spec minimum', () => {
      const spec = makeSpec({ depth_bottom_cm: 30 });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1', depth_achieved_cm: 35 })],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = depthShortfallRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('does not fire when depth is null (per spec)', () => {
      const spec = makeSpec({ depth_bottom_cm: 30 });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1', depth_achieved_cm: null })],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = depthShortfallRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('does not fire when sample has no spec', () => {
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: null, depth_achieved_cm: 25 })],
        specs: new Map(),
      });

      const findings = depthShortfallRule.run(ctx);
      expect(findings).toHaveLength(0);
    });

    it('does not fire when spec has no depth bottom', () => {
      const spec = makeSpec({ depth_bottom_cm: null });
      const ctx = makeContext({
        samples: [makeSample({ sample_uid: 'sample_1', spec_id: 'spec_1', depth_achieved_cm: 25 })],
        specs: new Map([['spec_1', spec]]),
      });

      const findings = depthShortfallRule.run(ctx);
      expect(findings).toHaveLength(0);
    });
  });
});
