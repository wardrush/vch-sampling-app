/**
 * B1 — React edge of the device database bootstrap.
 *
 * Mounted once, at the root of `App.tsx`, above the router — every screen
 * (this wave's placeholders and wave 2/3's real screens alike) reads local
 * state through `useDeviceDb()`, never by calling `getDeviceDb()` directly,
 * so there is exactly one place that knows what "not ready yet" and "failed
 * to open" look like on screen.
 *
 * **Never blocks capture on the database being ready either** — a screen that
 * needs the DB shows its own loading/error state via the hook; this provider
 * does not gate rendering of the tree beneath it. `AppShell` still renders
 * (nav, SW update banner) while the database opens in the background.
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import type { SqlDatabase } from '../../../shared/db/types.js';
import { getDeviceDb, type DeviceDbHandle } from './device-db.js';

type DeviceDbState =
  | { status: 'loading' }
  | { status: 'ready'; db: SqlDatabase; migration: DeviceDbHandle['migration'] }
  | { status: 'error'; error: Error };

const DeviceDbContext = createContext<DeviceDbState>({ status: 'loading' });

export function DeviceDbProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [state, setState] = useState<DeviceDbState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    getDeviceDb()
      .then(({ db, migration }) => {
        if (!cancelled) setState({ status: 'ready', db, migration });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <DeviceDbContext.Provider value={state}>{children}</DeviceDbContext.Provider>;
}

/**
 * The device database, or the reason it isn't available yet.
 *
 * Every screen that touches local data — Today's boundary list, the Outbox's
 * counts, Field's plan points — reads this rather than importing
 * `getDeviceDb()` itself, so a screen under test can supply its own state via
 * a bespoke provider without touching OPFS.
 */
export function useDeviceDb(): DeviceDbState {
  return useContext(DeviceDbContext);
}
