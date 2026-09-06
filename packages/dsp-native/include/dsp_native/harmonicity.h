#pragma once

#include <cstddef>

namespace dsp_native {

struct HarmonicityResult {
  double normalizedPeriodicity = 0.0;  // 0..1 NSDF-style periodicity strength
  double harmonicToNoiseRatioDb = -20.0;  // dB; floored at -20 for silence/noise
};

// Computes a harmonicity / harmonic-to-noise-ratio signal at a *known*
// candidate period (typically the period a YIN or MPM detector already
// found), independent of which detector produced it. This is the "confidence
// signal usable to suppress pitch output on bow noise / scratchy attacks"
// called for in the Phase 1 plan: a low HNR at the reported period means
// the frame is mostly non-periodic energy (bow noise, string scratch) even
// if the detector still emitted *a* frequency, and callers should treat the
// frame as unvoiced rather than reporting a wrong or unreliable note.
//
// Uses the classic autocorrelation-based HNR formula (Boersma 1993):
// HNR(dB) = 10*log10(r / (1 - r)), where r is the normalized periodicity at
// the candidate lag (the same NSDF quantity MPM already computes — see
// mpm_detector.cpp — recomputed here standalone so this works regardless of
// which detector supplied the candidate period, including YIN's).
//
// `periodSamples` may be fractional (sub-sample-interpolated); it is
// rounded to the nearest integer lag for the correlation sums.
[[nodiscard]] HarmonicityResult ComputeHarmonicity(const float* samples, std::size_t numSamples,
                                                     double periodSamples);

}  // namespace dsp_native
