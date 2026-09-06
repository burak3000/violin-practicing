import { defineConfig } from 'vitest/config';

// Mirrors packages/core/vitest.config.ts and packages/dsp-ts/vitest.config.ts
// in substance (same 'node' environment, same test-file glob). Named
// `.mts` rather than `.ts` (unlike those two) specifically because this
// package.json has no `"type": "module"` -- unlike packages/core/dsp-ts,
// apps/mobile can't safely add that: it would make Node load
// metro.config.js (plain CommonJS, `require()`-based, loaded directly by
// Metro's own tooling) as ESM and break it. Vite's own config loader warns
// about a `.ts` config using ESM syntax under a CommonJS-default package
// without this, so `.mts` (an explicit, unambiguous ES-module extension)
// sidesteps the whole question without touching package.json at all.
//
// 'node' environment is correct and sufficient: the only test
// files in this app live under src/tuner/*.test.ts, covering the pure,
// RN-import-free view-model/formatting/stats helpers extracted alongside
// Phase 5's FingerTunerScreen.tsx (see apps/mobile/CLAUDE.md's "Phase 5:
// Finger Tuner UI" section) -- never the .tsx components themselves.
// Scoping `include` to `*.test.ts` (not `*.test.tsx`) means Vitest never
// has to load React/React Native/Metro's own transform pipeline at all,
// matching this phase's own verification scope: React Native UI component
// *rendering* doesn't need exhaustive tests here, only the pure logic
// underneath it does.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
