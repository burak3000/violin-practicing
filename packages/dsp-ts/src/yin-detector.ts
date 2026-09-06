import type { PitchDetectorConfig, PitchResult } from './pitch-types.js';

function computeTauMin(config: PitchDetectorConfig): number {
  return Math.max(2, Math.floor(config.sampleRateHz / config.maxFrequencyHz));
}

function computeTauMax(config: PitchDetectorConfig): number {
  return Math.ceil(config.sampleRateHz / config.minFrequencyHz);
}

/**
 * Faithful TypeScript port of packages/dsp-native's `YinDetector`
 * (`include/dsp_native/yin_detector.h` / `src/yin_detector.cpp`) --
 * de Cheveigne & Kawahara, "YIN, a fundamental frequency estimator for
 * speech and music", 2002. See apps/desktop/CLAUDE.md's "DSP binding
 * decision" section for why Phase 3 built a TS port rather than binding
 * the validated C++ directly (WASM toolchain unavailable in that phase's
 * environment; AudioWorklet-scope constraints rule out a native Node
 * addon), and this package's own CLAUDE.md for why Phase 4 promoted that
 * port out of apps/desktop into a shared package apps/mobile also uses.
 *
 * Same four steps, same constants, same control flow, same variable names
 * where practical, as the validated C++ implementation -- this is
 * deliberately NOT a "rewrite in the spirit of," it's a line-for-line
 * mirror, so it can be trusted to the same degree the C++ was validated to
 * (see this file's test, which checks accuracy against Phase 1's own
 * published numbers):
 *
 *  1. difference function d(tau) = sum (x[j] - x[j+tau])^2
 *  2. cumulative mean normalized difference function (CMNDF)
 *  3. first dip below `yinThreshold` within [tauMin, tauMax], descended to
 *     its local minimum (falls back to the global in-range minimum, still
 *     marked unvoiced, if nothing clears the threshold anywhere)
 *  4. parabolic interpolation around the chosen lag for sub-sample
 *     accuracy
 *
 * Not safe to share across concurrent analysis streams (owns a reused
 * scratch buffer, mirroring the C++ class's own documented constraint) --
 * construct one instance per capture session (one AudioWorkletProcessor
 * instance on desktop; one capture-controller instance on mobile).
 */
export class YinDetector {
  private readonly config: PitchDetectorConfig;
  private readonly tauMin: number;
  private readonly tauMax: number;
  private diffBuffer: Float64Array;

  constructor(config: PitchDetectorConfig) {
    this.config = config;
    this.tauMin = computeTauMin(config);
    this.tauMax = computeTauMax(config);
    this.diffBuffer = new Float64Array(this.tauMax + 1);
  }

  /**
   * `samples` must have at least `minRecommendedFrameSize(config)` entries
   * for `minFrequencyHz` to be reliably reachable; shorter buffers still
   * work but bias low-frequency detection (mirrors the C++ doc comment).
   */
  detect(samples: Float32Array, numSamples: number = samples.length): PitchResult {
    // Local, frame-specific ceiling -- mirrors the C++ `Detect`'s own
    // `tauMax` local variable, which shadows the member `tauMax_` when the
    // frame is shorter than the configured search ceiling.
    const tauMaxForFrame = Math.min(this.tauMax, numSamples - 1);
    if (tauMaxForFrame <= this.tauMin || numSamples < 4) {
      return { voiced: false, frequencyHz: 0, confidence: 0, periodSamples: 0 };
    }
    if (tauMaxForFrame + 1 > this.diffBuffer.length) {
      this.diffBuffer = new Float64Array(tauMaxForFrame + 1);
    }
    const diff = this.diffBuffer;

    // Step 1 (eq. 6): difference function. Shrinking integration window as
    // tau grows, not the paper's fixed-window formulation -- the same
    // standard practical simplification dsp-native's C++ uses (see its
    // inline comment); safe here for the same reason: tauMax is a small
    // fraction of the recommended frame size.
    diff[0] = 0;
    for (let tau = 1; tau <= tauMaxForFrame; tau++) {
      let sum = 0;
      const limit = numSamples - tau;
      for (let j = 0; j < limit; j++) {
        const d = samples[j] - samples[j + tau];
        sum += d * d;
      }
      diff[tau] = sum;
    }

    // Step 2 (eq. 8): cumulative mean normalized difference function.
    diff[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= tauMaxForFrame; tau++) {
      runningSum += diff[tau];
      diff[tau] = runningSum === 0 ? 1 : (diff[tau] * tau) / runningSum;
    }

    // Step 3 (eq. 4, "absolute threshold"): first dip below yinThreshold
    // within [tauMin, tauMaxForFrame], descended to that dip's local
    // minimum.
    let chosenTau = -1;
    for (let tau = this.tauMin; tau <= tauMaxForFrame; tau++) {
      if (diff[tau] < this.config.yinThreshold) {
        let t = tau;
        while (t + 1 <= tauMaxForFrame && diff[t + 1] < diff[t]) {
          t++;
        }
        chosenTau = t;
        break;
      }
    }

    const thresholdMet = chosenTau !== -1;
    if (!thresholdMet) {
      // Fallback: nothing cleared the threshold anywhere in range. Report
      // the global in-range minimum as a best-effort estimate but mark
      // unvoiced -- callers must not trust this as a confirmed pitch.
      let bestVal = diff[this.tauMin];
      chosenTau = this.tauMin;
      for (let tau = this.tauMin + 1; tau <= tauMaxForFrame; tau++) {
        if (diff[tau] < bestVal) {
          bestVal = diff[tau];
          chosenTau = tau;
        }
      }
    }

    // Step 4 (eq. 9): parabolic interpolation around chosenTau.
    let betterTau = chosenTau;
    if (chosenTau > 0 && chosenTau < tauMaxForFrame) {
      const y0 = diff[chosenTau - 1];
      const y1 = diff[chosenTau];
      const y2 = diff[chosenTau + 1];
      const denom = y0 - 2 * y1 + y2;
      if (Math.abs(denom) > 1e-12) {
        const offset = (0.5 * (y0 - y2)) / denom;
        if (offset > -1 && offset < 1) {
          betterTau += offset;
        }
      }
    }

    const periodSamples = betterTau;
    const frequencyHz = betterTau > 0 ? this.config.sampleRateHz / betterTau : 0;
    const confidence = Math.min(1, Math.max(0, 1 - diff[chosenTau]));

    return { voiced: thresholdMet, frequencyHz, confidence, periodSamples };
  }

  get resolvedConfig(): PitchDetectorConfig {
    return this.config;
  }
}
