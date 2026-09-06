import { describe, expect, it } from 'vitest';
import { forViolin } from './pitch-types.js';
import { ANALYSIS_FRAME_SIZE, ANALYSIS_HOP_SIZE, PitchAnalysisPipeline } from './pitch-pipeline.js';
import { generateSyntheticTone } from './test-support/synthetic-tone.js';

const SAMPLE_RATE = 44100;
const HOP_BUDGET_MS = (ANALYSIS_HOP_SIZE / SAMPLE_RATE) * 1000; // ~11.6ms, matching packages/dsp-native's validated hop

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Measures this package's own per-frame compute cost (YIN + harmonicity +
 * onset + clip, the exact same composition each consuming app's capture
 * glue runs per hop), using the same methodology
 * packages/dsp-native/RESULTS.md used for its C++ numbers (many frames,
 * mean/median/p99 against the hop budget) so the two are directly
 * comparable.
 *
 * This measures pure JS compute cost in Node via Vitest -- not a real
 * AudioWorkletProcessor thread (desktop) or a real device's JS/audio
 * thread (mobile). V8/Hermes JIT behavior should be broadly similar, but
 * real thread scheduling/priority is not reproduced here. See
 * apps/desktop/CLAUDE.md and apps/mobile/CLAUDE.md for how this number
 * factors into each platform's own DSP-hosting decision and what it
 * does/doesn't prove.
 */
describe('PitchAnalysisPipeline timing (TS port) vs. Phase 1 hop budget', () => {
  it('analyzes a 2048-sample frame far under the 11.6ms hop budget, on average and at p99', () => {
    const pipeline = new PitchAnalysisPipeline(forViolin(SAMPLE_RATE));
    // A real 440Hz tone, not silence/noise -- exercises the full voiced
    // path (YIN's threshold search + harmonicity's correlation sum), which
    // is more representative of sustained-note practice than measuring
    // silence (silence still runs the full difference-function loop, so it
    // is *not* meaningfully cheaper, but using a real tone keeps this
    // directly comparable to dsp-native's own RESULTS.md methodology).
    const tone = generateSyntheticTone(440, { sampleRateHz: SAMPLE_RATE, waveform: 'sine' });
    const steadyStartSample = Math.round(tone.toneStartS * SAMPLE_RATE);
    const frame = tone.samples.subarray(steadyStartSample, steadyStartSample + ANALYSIS_FRAME_SIZE);

    const warmupIterations = 50; // let V8's JIT warm up before measuring, same rationale as any microbenchmark
    for (let i = 0; i < warmupIterations; i++) pipeline.analyzeFrame(frame);

    const iterations = 2000;
    const timingsMs: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      pipeline.analyzeFrame(frame);
      timingsMs.push(performance.now() - start);
    }

    timingsMs.sort((a, b) => a - b);
    const mean = timingsMs.reduce((a, b) => a + b, 0) / timingsMs.length;
    const median = percentile(timingsMs, 0.5);
    const p99 = percentile(timingsMs, 0.99);

    // Deliberate: this is the human-readable timing report Phase 3's task
    // explicitly asked to be measured and documented (no-console is off
    // repo-wide -- see eslint.config.mjs), mirrored into
    // apps/desktop/CLAUDE.md.
    console.log(
      `[timing] TS YIN+harmonicity+onset+clip pipeline, ${ANALYSIS_FRAME_SIZE}-sample frame: ` +
        `mean=${mean.toFixed(3)}ms median=${median.toFixed(3)}ms p99=${p99.toFixed(3)}ms ` +
        `(hop budget=${HOP_BUDGET_MS.toFixed(3)}ms)`,
    );

    // Generous regression guard, not a tight performance assertion: this
    // TS port only needs to comfortably fit inside the ~11.6ms hop budget,
    // same bar Phase 1's C++ numbers were held to (packages/dsp-native's
    // YIN: ~0.51ms mean, ~4.4% of budget). A pure-JS port is expected to be
    // slower than native C++, but should still have a very wide margin.
    expect(mean).toBeLessThan(HOP_BUDGET_MS * 0.5);
    expect(p99).toBeLessThan(HOP_BUDGET_MS);
  });
});
