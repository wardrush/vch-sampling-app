/**
 * Design tokens for the sampling app.
 * Glove/wind/low-sun palette — optimized for field conditions with high contrast
 * and readability in bright outdoor light.
 *
 * Token names published for consumption by pwa-screens in src/app/styles/global.css
 */

// Color palette - placeholder values pending design finalization
// These token names are canonical; hex values should be coordinated with design review
export const COLORS = {
  // Neutral grays
  neutral900: '#1a1a1a',
  neutral800: '#2d2d2d',
  neutral700: '#404040',
  neutral600: '#595959',
  neutral500: '#808080',
  neutral400: '#a6a6a6',
  neutral300: '#cccccc',
  neutral200: '#e6e6e6',
  neutral100: '#f5f5f5',
  neutral0: '#ffffff',

  // Primary action colors
  primary700: '#004d99',
  primary600: '#0066cc',
  primary500: '#0080ff',
  primary400: '#4da6ff',
  primary300: '#99ccff',

  // Success colors (e.g., sampled points, valid uploads)
  success700: '#1b5c0f',
  success600: '#2d8a1a',
  success500: '#40b824',
  success400: '#6dd447',

  // Warning colors (e.g., offset exceeded, deviation needed)
  warning700: '#994c00',
  warning600: '#cc6600',
  warning500: '#ff8800',
  warning400: '#ffaa33',

  // Error colors (e.g., blocking defects, missing required fields)
  error700: '#800000',
  error600: '#cc0000',
  error500: '#ff3333',
  error400: '#ff6666',

  // Info colors (e.g., advisory defects, information badges)
  info700: '#003d99',
  info600: '#0052cc',
  info500: '#0066ff',
  info400: '#4d94ff',
} as const;

// Semantic token aliases for different contexts
export const SEMANTIC_COLORS = {
  // Text colors
  textPrimary: COLORS.neutral900,
  textSecondary: COLORS.neutral600,
  textTertiary: COLORS.neutral500,
  textInverse: COLORS.neutral0,
  textDisabled: COLORS.neutral400,

  // Background colors
  bgPrimary: COLORS.neutral0,
  bgSecondary: COLORS.neutral100,
  bgTertiary: COLORS.neutral200,
  bgInverse: COLORS.neutral900,
  bgDisabled: COLORS.neutral200,

  // Interactive element colors
  buttonPrimaryBg: COLORS.primary600,
  buttonPrimaryText: COLORS.neutral0,
  buttonSecondaryBg: COLORS.neutral200,
  buttonSecondaryText: COLORS.neutral900,
  buttonDisabledBg: COLORS.neutral300,
  buttonDisabledText: COLORS.neutral500,

  // Input and form colors
  inputBg: COLORS.neutral0,
  inputBorder: COLORS.neutral400,
  inputBorderFocus: COLORS.primary600,
  inputBorderError: COLORS.error600,
  inputText: COLORS.neutral900,
  inputPlaceholder: COLORS.neutral500,

  // Status chip colors
  chipSuccessBg: COLORS.success500,
  chipSuccessText: COLORS.neutral0,
  chipWarningBg: COLORS.warning500,
  chipWarningText: COLORS.neutral0,
  chipErrorBg: COLORS.error500,
  chipErrorText: COLORS.neutral0,
  chipInfoBg: COLORS.info500,
  chipInfoText: COLORS.neutral0,
  chipNeutralBg: COLORS.neutral300,
  chipNeutralText: COLORS.neutral900,

  // Border colors
  borderDefault: COLORS.neutral300,
  borderStrong: COLORS.neutral600,
  borderSubtle: COLORS.neutral200,

  // Divider colors
  divider: COLORS.neutral200,

  // Shadow/focus colors
  focusRing: COLORS.primary600,
  shadowLight: 'rgba(0, 0, 0, 0.05)',
  shadowMedium: 'rgba(0, 0, 0, 0.1)',
  shadowStrong: 'rgba(0, 0, 0, 0.15)',
} as const;

export type ColorToken = keyof typeof COLORS;
export type SemanticColorToken = keyof typeof SEMANTIC_COLORS;
