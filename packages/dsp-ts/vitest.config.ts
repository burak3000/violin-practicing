import { defineConfig } from 'vitest/config';

// Mirrors packages/core/vitest.config.ts. 'node' environment is sufficient
// and correct here: everything under src/ is plain, dependency-free
// TypeScript by design (it has to be safe to run inside a real-time audio
// callback on either platform -- see CLAUDE.md), and this package has no
// browser-API-touching glue of its own (that lives in each consuming app:
// apps/desktop/src/audio/**, apps/mobile/src/audio/**).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
