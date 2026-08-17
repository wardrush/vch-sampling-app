/**
 * Ambient types for `virtual:pwa-register/react`, used by `UpdateBanner.tsx`.
 *
 * `vite-plugin-pwa` ships these under `vite-plugin-pwa/client.d.ts`, normally
 * wired in via `compilerOptions.types` — but `tsconfig.json` is
 * orchestrator-only (FLEET.md §4 rule 3), so this reference lives here
 * instead. Any `.d.ts` under an included path is picked up ambiently, which
 * is what makes this a one-file, no-tsconfig-edit way to get the same types.
 */
/// <reference types="vite-plugin-pwa/client" />
