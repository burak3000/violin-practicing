// Shared ESLint flat config for the whole pnpm workspace (apps/*, packages/*).
//
// Phase 0 scope: a baseline that keeps `pnpm lint` meaningful and fast
// across three very different TS runtimes (Electron/Node, Expo/Metro,
// Vitest/Node) without wiring type-aware linting per project. Deliberately
// uses typescript-eslint's non-type-checked `recommended` preset rather
// than `recommendedTypeChecked`, since a single `parserOptions.project`
// can't cleanly span apps/mobile's Metro tsconfig, apps/desktop's
// Vite/Node tsconfig, and packages/core's Vitest tsconfig at once. Revisit
// per-package if/when type-aware lint rules become worth the extra wiring.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/.vite/**',
      '**/.expo/**',
      '**/.expo-shared/**',
      '**/ios/**',
      '**/android/**',
      '**/coverage/**',
      'packages/dsp-native/build/**',
      'temp/**',
      '.codegraph/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Phase 0 placeholders intentionally log to prove boot/build works;
      // real UI code can tighten this per package in later phases.
      'no-console': 'off',
    },
  },
  {
    // Electron renderer code runs in a browser-like context.
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
  {
    // pitch-worklet-processor.ts runs inside AudioWorkletGlobalScope, not
    // the renderer's browser/window context above -- it has its own global
    // surface (see apps/desktop/src/audio/audioworklet-globals.d.ts, and
    // apps/desktop/tsconfig.worklet.json, which typechecks this file
    // separately for the same reason). ESLint's `no-undef` doesn't read
    // ambient .d.ts declarations (this repo deliberately doesn't use
    // typescript-eslint's type-aware linting -- see this file's top
    // comment), so these globals need to be listed explicitly here too.
    files: [
      'apps/desktop/src/audio/pitch-worklet-processor.ts',
      'apps/desktop/src/audio/audioworklet-globals.d.ts',
    ],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        sampleRate: 'readonly',
        currentTime: 'readonly',
        currentFrame: 'readonly',
        performance: 'readonly',
      },
    },
  },
  {
    // Expo/React Native app code.
    files: ['apps/mobile/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals['shared-node-browser'],
        __DEV__: 'readonly',
      },
    },
  },
  {
    // Metro/Babel config files (metro.config.js, babel.config.js if one is
    // added later) are CommonJS by the tooling's own convention -- Metro
    // loads this file directly with Node's `require`, so it cannot be
    // ESM. Phase 4 (apps/mobile/metro.config.js) is the first plain-JS
    // CommonJS config file in this otherwise TS/ESM-first repo (every
    // other config -- vite.*.config.ts, forge.config.ts, vitest.config.ts
    // -- is TypeScript using `import`), so this override didn't exist
    // before it.
    files: ['apps/mobile/metro.config.js', 'apps/mobile/babel.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  eslintConfigPrettier,
);
