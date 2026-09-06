#pragma once

namespace dsp_native {

// Shared configuration for both pitch-detection algorithms (YIN and MPM).
// Both operate on mono float32 PCM frames in [-1, 1] and share this exact
// config shape so the validation harness can run identical parameters
// through both detectors for a fair, apples-to-apples comparison — see
// ../../CLAUDE.md for how these defaults were chosen/validated.
struct PitchDetectorConfig {
  double sampleRateHz = 44100.0;

  // Search range for the fundamental period, derived from the violin's
  // practical range (G3 ~= 196 Hz to ~D6 ~= 1175 Hz) with margin on both
  // ends so notes right at the edges of the range aren't clipped by the
  // search window itself.
  double minFrequencyHz = 150.0;
  double maxFrequencyHz = 1600.0;

  // YIN: absolute threshold on the cumulative mean normalized difference
  // function. de Cheveigne & Kawahara (2002) recommend 0.10-0.15.
  double yinThreshold = 0.15;

  // MPM: peak-picking "k" threshold — the fraction of the highest NSDF
  // peak's height that the *first* (lowest-lag, i.e. highest-frequency)
  // peak must reach to be chosen as the fundamental. This is the mechanism
  // that gives MPM its resistance to octave-down errors (McLeod & Wyvill,
  // "A Smarter Way to Find Pitch", 2005).
  double mpmClarityThreshold = 0.93;

  // Minimum samples a detector needs to see to honor minFrequencyHz: the
  // integration window has to comfortably exceed the longest period being
  // searched for. Analysis frames shorter than this will have degraded
  // low-note accuracy (fewer periods observed) even though both detectors
  // will still return *a* result.
  [[nodiscard]] int MinRecommendedFrameSize() const;

  // Build a config from just a sample rate, using the violin-range defaults
  // above for everything else.
  static PitchDetectorConfig ForViolin(double sampleRateHz);
};

// Result of analyzing one frame with either detector. Both YIN and MPM fill
// in every field so the harness (and, eventually, downstream consumers in
// packages/core) can treat them identically.
struct PitchResult {
  bool voiced = false;         // false => no confident periodic pitch found
  double frequencyHz = 0.0;    // fundamental frequency estimate; 0 if !voiced
  double confidence = 0.0;     // 0..1, higher = more confident. YIN reports
                                // 1 - CMNDF at the chosen lag; MPM reports the
                                // NSDF peak height at the chosen lag. The two
                                // are NOT numerically comparable to each other
                                // (different quantities) — see CLAUDE.md.
  double periodSamples = 0.0;  // sub-sample-interpolated lag; 0 if !voiced
};

}  // namespace dsp_native
