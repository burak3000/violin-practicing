/**
 * Synthetic test-tone generator, mirroring
 * packages/dsp-native/test/generate_synthetic_fixtures.cpp's envelope and
 * waveform design *exactly* (silence -> fade-in -> steady tone -> fade-out
 * -> silence; sine and additive-synthesis sawtooth carriers;
 * peak-normalized to 0.7) -- see that file for the C++ original this
 * mirrors line-for-line. The point is that this package's own test
 * fixtures are directly comparable to Phase 1's own published numbers
 * (packages/dsp-native/RESULTS.md), not an ad hoc approximation of "some
 * sine wave".
 *
 * Test-only: not imported by any shipped app code. Each consuming app's
 * own in-app latency self-test uses a real native oscillator/tone instead
 * (e.g. apps/desktop's capture-pipeline.ts uses a real Web Audio
 * `OscillatorNode`), since that exercises actual platform audio-graph
 * routing rather than a hand-rolled buffer.
 */

const SILENCE_LEAD_S = 0.2;
const FADE_S = 0.05;
const STEADY_S = 1.0;
const TARGET_PEAK = 0.7;

export interface SyntheticToneResult {
  readonly samples: Float32Array;
  readonly sampleRateHz: number;
  /** Start of the steady (fades/silence excluded) region, in seconds -- matches the C++ generator's ApplyEnvelope return value. */
  readonly toneStartS: number;
  readonly toneEndS: number;
}

export type SyntheticWaveform = 'sine' | 'sawtooth';

export interface SyntheticToneOptions {
  readonly sampleRateHz?: number;
  readonly waveform?: SyntheticWaveform;
  /** < 1 builds an "adversarial weak fundamental" tone, mirroring the C++ generator's adversarial fixture set (only meaningful for waveform: 'sawtooth'). */
  readonly fundamentalScale?: number;
}

function sineCarrier(frequencyHz: number, numSamples: number, sampleRateHz: number): Float64Array {
  const out = new Float64Array(numSamples);
  for (let n = 0; n < numSamples; n++) {
    const t = n / sampleRateHz;
    out[n] = Math.sin(2 * Math.PI * frequencyHz * t);
  }
  return out;
}

/** Additive-synthesis sawtooth (Fourier series: amplitude 1/k, alternating sign, per harmonic k), matching the C++ generator's SawtoothCarrier. */
function sawtoothCarrier(
  frequencyHz: number,
  numSamples: number,
  sampleRateHz: number,
  fundamentalScale: number,
): Float64Array {
  const numHarmonics = Math.max(1, Math.floor((0.45 * sampleRateHz) / frequencyHz));
  const out = new Float64Array(numSamples);
  for (let n = 0; n < numSamples; n++) {
    const t = n / sampleRateHz;
    let sample = 0;
    for (let k = 1; k <= numHarmonics; k++) {
      let amp = 1 / k;
      if (k === 1) {
        amp *= fundamentalScale;
      }
      const sign = k % 2 === 0 ? -1 : 1;
      sample += sign * amp * Math.sin(2 * Math.PI * k * frequencyHz * t);
    }
    out[n] = sample;
  }
  return out;
}

function normalizePeak(buf: Float64Array, targetPeak: number): void {
  let peak = 0;
  for (const v of buf) {
    peak = Math.max(peak, Math.abs(v));
  }
  if (peak <= 0) {
    return;
  }
  const scale = targetPeak / peak;
  for (let i = 0; i < buf.length; i++) {
    buf[i] *= scale;
  }
}

function applyEnvelope(
  buf: Float64Array,
  sampleRateHz: number,
): { toneStartS: number; toneEndS: number } {
  const leadN = Math.round(SILENCE_LEAD_S * sampleRateHz);
  const fadeN = Math.round(FADE_S * sampleRateHz);
  const fadeInStart = leadN;
  const steadyStart = fadeInStart + fadeN;
  const fadeOutStart = steadyStart + Math.round(STEADY_S * sampleRateHz);
  const fadeOutEnd = fadeOutStart + fadeN;

  for (let n = 0; n < buf.length; n++) {
    let gain: number;
    if (n < fadeInStart) {
      gain = 0;
    } else if (n < steadyStart) {
      gain = (n - fadeInStart) / fadeN;
    } else if (n < fadeOutStart) {
      gain = 1;
    } else if (n < fadeOutEnd) {
      gain = 1 - (n - fadeOutStart) / fadeN;
    } else {
      gain = 0;
    }
    buf[n] *= gain;
  }
  return { toneStartS: steadyStart / sampleRateHz, toneEndS: fadeOutStart / sampleRateHz };
}

export function generateSyntheticTone(
  frequencyHz: number,
  options: SyntheticToneOptions = {},
): SyntheticToneResult {
  const sampleRateHz = options.sampleRateHz ?? 44100;
  const waveform = options.waveform ?? 'sine';
  const totalSamples = Math.round((2 * SILENCE_LEAD_S + 2 * FADE_S + STEADY_S) * sampleRateHz);

  const carrier =
    waveform === 'sine'
      ? sineCarrier(frequencyHz, totalSamples, sampleRateHz)
      : sawtoothCarrier(frequencyHz, totalSamples, sampleRateHz, options.fundamentalScale ?? 1.0);

  normalizePeak(carrier, TARGET_PEAK);
  const { toneStartS, toneEndS } = applyEnvelope(carrier, sampleRateHz);

  return { samples: Float32Array.from(carrier), sampleRateHz, toneStartS, toneEndS };
}

/** midi 69 == A4. Test-helper-local so this file has no dependency on packages/core or dsp-native's note utilities. */
export function midiToFrequencyHz(midiNote: number, a4Hz = 440): number {
  return a4Hz * Math.pow(2, (midiNote - 69) / 12);
}
