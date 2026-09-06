/**
 * Faithful TypeScript port of packages/dsp-native's harmonicity/HNR
 * confidence gate (`include/dsp_native/harmonicity.h` /
 * `src/harmonicity.cpp`). Computes the harmonic-to-noise ratio in dB from
 * the normalized periodicity at a *given* candidate period (typically
 * whatever YinDetector just reported), using the classic
 * autocorrelation-based HNR formula (Boersma 1993):
 * `HNR(dB) = 10*log10(r / (1-r))`. A detector can report a confident-
 * looking frequency on a noisy attack transient; if HNR at that period is
 * low (periodic energy doesn't dominate), the frame should be treated as
 * unvoiced rather than a wrong/unreliable note -- see pitch-pipeline.ts
 * for how this gates `confirmedVoiced`, matching
 * packages/dsp-native/test/validation_harness.cpp's own composition.
 */

const HNR_FLOOR_DB = -20;
const HNR_CEIL_DB = 40;

export interface HarmonicityResult {
  readonly normalizedPeriodicity: number;
  readonly harmonicToNoiseRatioDb: number;
}

export const SILENT_HARMONICITY_RESULT: HarmonicityResult = Object.freeze({
  normalizedPeriodicity: 0,
  harmonicToNoiseRatioDb: HNR_FLOOR_DB,
});

/**
 * `periodSamples` may be fractional (sub-sample-interpolated); it is
 * rounded to the nearest integer lag for the correlation sums, mirroring
 * the C++'s `std::lround`.
 */
export function computeHarmonicity(
  samples: Float32Array,
  numSamples: number,
  periodSamples: number,
): HarmonicityResult {
  if (periodSamples <= 0 || numSamples < 4) {
    return SILENT_HARMONICITY_RESULT;
  }

  const tau = Math.round(periodSamples);
  if (tau <= 0 || tau >= numSamples) {
    return SILENT_HARMONICITY_RESULT;
  }

  let acf = 0;
  let energy = 0;
  const limit = numSamples - tau;
  for (let j = 0; j < limit; j++) {
    const xj = samples[j];
    const xjt = samples[j + tau];
    acf += xj * xjt;
    energy += xj * xj + xjt * xjt;
  }

  const r = energy > 0 ? Math.min(1, Math.max(-1, (2 * acf) / energy)) : 0;
  const normalizedPeriodicity = Math.max(0, r);

  let harmonicToNoiseRatioDb: number;
  if (r <= 0) {
    harmonicToNoiseRatioDb = HNR_FLOOR_DB;
  } else if (r >= 1) {
    harmonicToNoiseRatioDb = HNR_CEIL_DB;
  } else {
    const hnr = 10 * Math.log10(r / (1 - r));
    harmonicToNoiseRatioDb = Math.min(HNR_CEIL_DB, Math.max(HNR_FLOOR_DB, hnr));
  }
  return { normalizedPeriodicity, harmonicToNoiseRatioDb };
}
