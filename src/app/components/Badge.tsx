/**
 * Badge component for small labels, counts, and status indicators
 * Non-interactive inline status display
 */

import React from 'react';
import { SEMANTIC_COLORS, SPACING, BORDER_RADIUS } from './tokens/index.js';

type BadgeStatus = 'success' | 'warning' | 'error' | 'info' | 'neutral';
type BadgeSize = 'sm' | 'md';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  label: string | number;
  status?: BadgeStatus;
  size?: BadgeSize;
  dot?: boolean;
  icon?: React.ReactNode;
}

const statusColorMap: Record<BadgeStatus, { bg: string; text: string }> = {
  success: {
    bg: SEMANTIC_COLORS.chipSuccessBg,
    text: SEMANTIC_COLORS.chipSuccessText,
  },
  warning: {
    bg: SEMANTIC_COLORS.chipWarningBg,
    text: SEMANTIC_COLORS.chipWarningText,
  },
  error: {
    bg: SEMANTIC_COLORS.chipErrorBg,
    text: SEMANTIC_COLORS.chipErrorText,
  },
  info: {
    bg: SEMANTIC_COLORS.chipInfoBg,
    text: SEMANTIC_COLORS.chipInfoText,
  },
  neutral: {
    bg: SEMANTIC_COLORS.chipNeutralBg,
    text: SEMANTIC_COLORS.chipNeutralText,
  },
};

export const Badge: React.FC<BadgeProps> = ({
  label,
  status = 'neutral',
  size = 'md',
  dot = false,
  icon,
  className,
  style,
  ...props
}) => {
  const colors = statusColorMap[status];

  const sizeStyles: React.CSSProperties =
    size === 'sm'
      ? {
          fontSize: '12px',
          height: '20px',
          paddingLeft: dot ? SPACING.sm : SPACING.md,
          paddingRight: SPACING.md,
          lineHeight: '20px',
        }
      : {
          fontSize: '13px',
          height: '24px',
          paddingLeft: dot ? SPACING.md : SPACING.lg,
          paddingRight: SPACING.lg,
          lineHeight: '24px',
        };

  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.xs,
    backgroundColor: colors.bg,
    color: colors.text,
    borderRadius: dot ? '50%' : BORDER_RADIUS.full,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    userSelect: 'none',
    ...sizeStyles,
    ...style,
  };

  return (
    <span {...props} style={baseStyle} className={className}>
      {icon && <span aria-hidden="true">{icon}</span>}
      {!dot && label}
    </span>
  );
};

Badge.displayName = 'Badge';
