/**
 * Button component — 48 dp minimum touch target
 * Usable in gloves, wind, and low sun conditions
 */

import React from 'react';
import { SEMANTIC_COLORS, TOUCH_TARGETS, SPACING, FONT_WEIGHTS, TRANSITIONS } from './tokens/index.js';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  children: React.ReactNode;
}

const sizeMap: Record<ButtonSize, { height: string; padding: string; fontSize: string }> = {
  sm: {
    height: TOUCH_TARGETS.standard, // 48 dp minimum
    padding: `0 ${SPACING.lg}`,
    fontSize: '14px',
  },
  md: {
    height: TOUCH_TARGETS.large, // 56 dp
    padding: `0 ${SPACING.xl}`,
    fontSize: '16px',
  },
  lg: {
    height: TOUCH_TARGETS.xlarge, // 64 dp
    padding: `0 ${SPACING.xl}`,
    fontSize: '16px',
  },
};

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    backgroundColor: SEMANTIC_COLORS.buttonPrimaryBg,
    color: SEMANTIC_COLORS.buttonPrimaryText,
  },
  secondary: {
    backgroundColor: SEMANTIC_COLORS.buttonSecondaryBg,
    color: SEMANTIC_COLORS.buttonSecondaryText,
    border: `1px solid ${SEMANTIC_COLORS.inputBorder}`,
  },
  danger: {
    backgroundColor: SEMANTIC_COLORS.buttonDangerBg,
    color: SEMANTIC_COLORS.buttonDangerText,
  },
  ghost: {
    backgroundColor: 'transparent',
    color: SEMANTIC_COLORS.textPrimary,
  },
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      fullWidth = false,
      loading = false,
      disabled = false,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    const sizeStyles = sizeMap[size];
    const variantStyle = variantStyles[variant];

    const baseStyle: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: SPACING.md,
      borderRadius: '8px',
      border: 'none',
      cursor: disabled || loading ? 'not-allowed' : 'pointer',
      fontWeight: FONT_WEIGHTS.semibold,
      transition: TRANSITIONS.base,
      opacity: disabled || loading ? 0.6 : 1,
      minWidth: 'fit-content',
      width: fullWidth ? '100%' : 'auto',
      ...sizeStyles,
      ...variantStyle,
    };

    // Add focus ring style
    const finalStyle: React.CSSProperties = {
      ...baseStyle,
      outline: 'none',
    };

    return (
      <button
        ref={ref}
        {...props}
        disabled={disabled || loading}
        style={finalStyle}
        className={className}
        onFocus={(e) => {
          e.currentTarget.style.boxShadow = `0 0 0 3px ${SEMANTIC_COLORS.focusRing}40`;
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          e.currentTarget.style.boxShadow = 'none';
          props.onBlur?.(e);
        }}
      >
        {loading && <span aria-hidden="true">⟳</span>}
        {children}
      </button>
    );
  },
);

Button.displayName = 'Button';
