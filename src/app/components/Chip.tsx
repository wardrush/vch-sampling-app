/**
 * Chip component for conditions, statuses, and tags
 * Interactive chips with 48 dp minimum touch target
 */

import React from 'react';
import { SEMANTIC_COLORS, TOUCH_TARGETS, SPACING, BORDER_RADIUS, TRANSITIONS } from './tokens/index.js';

type ChipStatus = 'success' | 'warning' | 'error' | 'info' | 'neutral';

interface ChipProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  status?: ChipStatus;
  icon?: React.ReactNode;
  onDelete?: () => void;
  selectable?: boolean;
  selected?: boolean;
  disabled?: boolean;
}

const statusColorMap: Record<ChipStatus, { bg: string; text: string; border: string }> = {
  success: {
    bg: SEMANTIC_COLORS.chipSuccessBg,
    text: SEMANTIC_COLORS.chipSuccessText,
    border: SEMANTIC_COLORS.chipSuccessBg,
  },
  warning: {
    bg: SEMANTIC_COLORS.chipWarningBg,
    text: SEMANTIC_COLORS.chipWarningText,
    border: SEMANTIC_COLORS.chipWarningBg,
  },
  error: {
    bg: SEMANTIC_COLORS.chipErrorBg,
    text: SEMANTIC_COLORS.chipErrorText,
    border: SEMANTIC_COLORS.chipErrorBg,
  },
  info: {
    bg: SEMANTIC_COLORS.chipInfoBg,
    text: SEMANTIC_COLORS.chipInfoText,
    border: SEMANTIC_COLORS.chipInfoBg,
  },
  neutral: {
    bg: SEMANTIC_COLORS.chipNeutralBg,
    text: SEMANTIC_COLORS.chipNeutralText,
    border: SEMANTIC_COLORS.borderDefault,
  },
};

export const Chip = React.forwardRef<HTMLDivElement, ChipProps>(
  (
    {
      label,
      status = 'neutral',
      icon,
      onDelete,
      selectable = false,
      selected = false,
      disabled = false,
      className,
      style,
      onClick,
      ...props
    },
    ref,
  ) => {
    const colors = statusColorMap[status];
    const isClickable = selectable || onDelete || onClick;

    const baseStyle: React.CSSProperties = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: SPACING.sm,
      minHeight: TOUCH_TARGETS.standard, // 48 dp minimum for interactive chips
      paddingLeft: SPACING.md,
      paddingRight: SPACING.md,
      borderRadius: BORDER_RADIUS.full,
      backgroundColor: colors.bg,
      color: colors.text,
      border: `1px solid ${colors.border}`,
      fontSize: '14px',
      fontWeight: 500,
      cursor: disabled ? 'not-allowed' : isClickable ? 'pointer' : 'default',
      transition: TRANSITIONS.base,
      opacity: disabled ? 0.6 : 1,
      userSelect: 'none',
      ...style,
    };

    if (selected && selectable) {
      baseStyle.boxShadow = `0 0 0 2px ${colors.border}`;
    }

    return (
      <div
        ref={ref}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable && !disabled ? 0 : undefined}
        {...props}
        style={baseStyle}
        className={className}
        onClick={(e) => {
          if (!disabled) {
            onClick?.(e);
          }
        }}
        onKeyDown={(e) => {
          if (!disabled && isClickable && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onClick?.(e as any);
          }
        }}
      >
        {icon && <span aria-hidden="true">{icon}</span>}
        <span>{label}</span>
        {onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '0',
              margin: '0',
              marginLeft: SPACING.xs,
              display: 'flex',
              alignItems: 'center',
              color: 'inherit',
              fontSize: '18px',
              lineHeight: 1,
            }}
            aria-label={`Remove ${label}`}
          >
            ×
          </button>
        )}
      </div>
    );
  },
);

Chip.displayName = 'Chip';
