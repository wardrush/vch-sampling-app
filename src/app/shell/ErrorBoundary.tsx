/**
 * B1 — one broken screen must not blank the whole app.
 *
 * A crew member mid-field with a crashed Field screen still needs the bottom
 * nav to reach Outbox and see that yesterday's work actually synced. React
 * unmounts the whole tree on an uncaught render error by default; this is the
 * one place that catches it instead.
 */

import React from 'react';
import { SEMANTIC_COLORS, SPACING } from '@app/components/tokens/index.js';
import { Button } from '@app/components/index.js';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('Screen crashed', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          padding: SPACING.xl,
          display: 'flex',
          flexDirection: 'column',
          gap: SPACING.lg,
          color: SEMANTIC_COLORS.textPrimary,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 18 }}>This screen hit a problem.</div>
        <div style={{ color: SEMANTIC_COLORS.textSecondary }}>
          Nothing already saved locally was touched. {this.state.error.message}
        </div>
        <Button onClick={this.reset}>Try again</Button>
      </div>
    );
  }
}
