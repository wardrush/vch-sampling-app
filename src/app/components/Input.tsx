/**
 * Input component — text, number, tel, etc.
 * 48 dp minimum touch target height
 */

import React from 'react';
import { SEMANTIC_COLORS, TOUCH_TARGETS, SPACING, BORDER_RADIUS, TRANSITIONS } from './tokens/index.js';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  fullWidth?: boolean;
  icon?: React.ReactNode;
  suffix?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, fullWidth = true, icon, suffix, className, style, disabled, ...props }, ref) => {
    const [focused, setFocused] = React.useState(false);

    const wrapperStyle: React.CSSProperties = {
      display: 'flex',
      flexDirection: 'column',
      gap: SPACING.sm,
      width: fullWidth ? '100%' : 'auto',
    };

    const labelStyle: React.CSSProperties = {
      fontSize: '14px',
      fontWeight: 500,
      color: disabled ? SEMANTIC_COLORS.textDisabled : SEMANTIC_COLORS.textPrimary,
    };

    const containerStyle: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      gap: SPACING.md,
      height: TOUCH_TARGETS.standard, // 48 dp minimum
      backgroundColor: disabled ? SEMANTIC_COLORS.bgDisabled : SEMANTIC_COLORS.inputBg,
      border: `1px solid ${error ? SEMANTIC_COLORS.inputBorderError : focused ? SEMANTIC_COLORS.inputBorderFocus : SEMANTIC_COLORS.inputBorder}`,
      borderRadius: BORDER_RADIUS.md,
      paddingLeft: SPACING.lg,
      paddingRight: SPACING.lg,
      transition: TRANSITIONS.base,
      ...style,
    };

    const inputStyle: React.CSSProperties = {
      flex: 1,
      border: 'none',
      background: 'none',
      outline: 'none',
      fontSize: '16px',
      color: disabled ? SEMANTIC_COLORS.inputPlaceholder : SEMANTIC_COLORS.inputText,
      padding: 0,
      fontFamily: 'inherit',
    };

    const inputPlaceholderStyle: React.CSSProperties = {
      color: SEMANTIC_COLORS.inputPlaceholder,
    };

    const hintStyle: React.CSSProperties = {
      fontSize: '12px',
      color: error ? SEMANTIC_COLORS.chipErrorBg : SEMANTIC_COLORS.textSecondary,
    };

    return (
      <div style={wrapperStyle}>
        {label && <label style={labelStyle}>{label}</label>}
        <div style={containerStyle}>
          {icon && <span style={{ display: 'flex', alignItems: 'center' }}>{icon}</span>}
          <input
            ref={ref}
            {...props}
            disabled={disabled}
            style={inputStyle}
            className={className}
            onFocus={(e) => {
              setFocused(true);
              props.onFocus?.(e);
            }}
            onBlur={(e) => {
              setFocused(false);
              props.onBlur?.(e);
            }}
            placeholder={props.placeholder}
          />
          {suffix && <span style={{ display: 'flex', alignItems: 'center' }}>{suffix}</span>}
        </div>
        {(error || hint) && <div style={hintStyle}>{error || hint}</div>}
      </div>
    );
  },
);

Input.displayName = 'Input';
