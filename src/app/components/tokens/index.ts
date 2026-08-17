/**
 * Design system tokens for the sampling app.
 * Spacing, typography, and touch target sizing for field use.
 */

export * from './colors.js';

// Touch target sizing - 48 dp minimum per Material Design guidelines and muddy-hands requirement
export const TOUCH_TARGETS = {
  minimal: '32px', // sub-target, used within a larger clickable area
  standard: '48px', // minimum interactive element size
  large: '56px', // preferred for primary actions
  xlarge: '64px', // for high-precision targets or grouped controls
} as const;

// Spacing scale
export const SPACING = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  xxl: '32px',
  xxxl: '48px',
} as const;

// Border radius for consistency
export const BORDER_RADIUS = {
  none: '0',
  sm: '4px',
  md: '8px',
  lg: '12px',
  full: '9999px',
} as const;

// Typography
export const FONT_SIZES = {
  xs: '12px',
  sm: '13px',
  base: '14px',
  lg: '16px',
  xl: '18px',
  '2xl': '20px',
  '3xl': '24px',
} as const;

export const FONT_WEIGHTS = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

// Line heights
export const LINE_HEIGHTS = {
  tight: 1.2,
  normal: 1.5,
  relaxed: 1.75,
} as const;

// Z-index scale
export const Z_INDEX = {
  base: 0,
  dropdown: 100,
  sticky: 200,
  fixed: 300,
  modal: 400,
  tooltip: 500,
  notification: 600,
} as const;

// Shadows
export const SHADOWS = {
  none: 'none',
  sm: '0 1px 2px 0 rgba(0, 0, 0, 0.05)',
  md: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
  lg: '0 10px 15px -3px rgba(0, 0, 0, 0.1)',
  xl: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
} as const;

// Focus ring styles
export const FOCUS = {
  outline: '2px solid',
  outlineOffset: '2px',
} as const;

// Transitions
export const TRANSITIONS = {
  fast: '150ms ease-in-out',
  base: '200ms ease-in-out',
  slow: '300ms ease-in-out',
} as const;
