import { defineConfig } from 'vite';

// https://vitejs.dev/config
//
// No custom entries needed here: capture-pipeline.ts loads
// pitch-worklet-processor.ts via a `?worker&url` import (see that file's
// comment), which is Vite's own built-in mechanism for bundling a
// worker-shaped module and getting a URL to the *bundled* output (its own
// imports resolved, TS transpiled) in both dev and production -- correct
// and sufficient in both modes with no extra Rollup input configuration
// here.
//
// A manual `build.rollupOptions.input` entry for the worklet file plus a
// plain `new URL('./pitch-worklet-processor.ts', import.meta.url)` +
// `audioWorklet.addModule()` call was tried first and does NOT work for a
// packaged build: inspecting `pnpm package`'s actual output showed the
// built renderer bundle's `new URL(...)` call still resolved to a raw,
// untranspiled `.ts` asset copy (Vite's generic static-asset handling for
// `new URL(...)`), not the separately-bundled `.js` chunk the manual Rollup
// entry produced -- the two mechanisms don't automatically connect to each
// other. Loading that raw `.ts` file as a worklet module would fail at
// runtime (TypeScript-only syntax isn't valid JavaScript). See
// apps/desktop/CLAUDE.md for the full writeup of what was tried, what
// broke, and why `?worker&url` is what actually works.
export default defineConfig({});
