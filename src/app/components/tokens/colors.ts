/**
 * Design tokens for the sampling app.
 * Veteran's Carbon Holdings brand palette — sand, moss, and gold scales
 * optimized for field conditions with high contrast and readability
 * in bright outdoor light, glove use, and wind.
 *
 * Token names published for consumption by pwa-screens in src/app/styles/global.css
 * Font: Quicksand (400/600/700)
 */

// Brand color scales from Veteran's Carbon Holdings corporate identity
// Note: Scale gaps (e.g., no sand-500, no moss-200/400/600) are intentional per brand spec
export const COLORS = {
  // Sand scale — neutral ground
  sand50: '#f8f3ea',
  sand100: '#efe5d4',
  sand200: '#e1d2b8',
  sand300: '#c7b08a',
  sand400: '#af8f67',
  sand600: '#755b3d',
  sand700: '#5c462f',
  sand800: '#46331f',
  sand900: '#312213',
  sand950: '#1f1408',

  // Moss scale — primary action color
  moss100: '#dfe8d5',
  moss300: '#afc49a',
  moss500: '#6f8a59',
  moss700: '#2f5332',
  moss800: '#203b24',
  moss900: '#132719',

  // Gold scale — accent and large text only
  // WARNING: gold-700 and gold-500 fail outdoor legibility per WCAG contrast audits
  // and are demoted to accent, large text, and borders only
  gold500: '#d4a832',
  gold700: '#a67c17',
  gold800: '#86640f',

  // Functional red — not brand-sanctioned but required for blocking defects and errors
  // TODO: Design review and official brand red pending
  red600: '#cc0000',
  red700: '#800000',

  // White (used for inverse text and form backgrounds)
  white: '#ffffff',
} as const;

// Semantic token aliases for different contexts
export const SEMANTIC_COLORS = {
  // Text colors
  textPrimary: COLORS.sand900,
  textSecondary: COLORS.sand700,
  textTertiary: COLORS.sand600,
  textInverse: COLORS.white,
  textDisabled: COLORS.sand400,

  // Background colors
  bgPrimary: COLORS.sand50,
  bgSecondary: COLORS.sand100,
  bgTertiary: COLORS.sand200,
  bgInverse: COLORS.moss900,
  bgDisabled: COLORS.sand200,

  // Interactive element colors
  buttonPrimaryBg: COLORS.moss700,
  buttonPrimaryText: COLORS.white, // 8.73:1 contrast
  buttonSecondaryBg: COLORS.sand100,
  buttonSecondaryText: COLORS.sand900,
  buttonDangerBg: COLORS.red600,
  buttonDangerText: COLORS.white,
  buttonDisabledBg: COLORS.sand200,
  buttonDisabledText: COLORS.sand600,

  // Input and form colors
  inputBg: COLORS.white,
  inputBorder: COLORS.sand300,
  inputBorderFocus: COLORS.moss700,
  inputBorderError: COLORS.red600,
  inputText: COLORS.sand900,
  inputPlaceholder: COLORS.sand600, // must stay legible in low sun

  // Status chip colors
  chipSuccessBg: COLORS.moss100,
  chipSuccessText: COLORS.moss900,
  chipWarningBg: '#f5e6c0', // gold-tinted ground per brand spec
  chipWarningText: COLORS.gold800,
  chipErrorBg: COLORS.red600,
  chipErrorText: COLORS.white,
  chipInfoBg: COLORS.sand100,
  chipInfoText: COLORS.sand900,
  chipNeutralBg: COLORS.sand100,
  chipNeutralText: COLORS.sand700,

  // Border colors
  borderDefault: COLORS.sand300,
  borderStrong: COLORS.sand400,
  borderSubtle: COLORS.sand200,

  // Divider colors
  divider: COLORS.sand200,

  // Focus ring — gold accent, non-text use (ring, not label)
  focusRing: COLORS.gold700,

  // Shadows
  shadowLight: 'rgba(0, 0, 0, 0.05)',
  shadowMedium: 'rgba(0, 0, 0, 0.1)',
  shadowStrong: 'rgba(0, 0, 0, 0.15)',
} as const;

export type ColorToken = keyof typeof COLORS;
export type SemanticColorToken = keyof typeof SEMANTIC_COLORS;
