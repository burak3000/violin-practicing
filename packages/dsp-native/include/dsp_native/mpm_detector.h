#pragma once

#include <cstddef>
#include <vector>

#include "dsp_native/types.h"

namespace dsp_native {

// McLeod Pitch Method (MPM) detector (McLeod & Wyvill, "A Smarter Way to
// Find Pitch", 2005): normalized square difference function (NSDF),
// key-maxima peak-picking with a fractional-of-global-max threshold
// (favors the lowest-lag qualifying peak, i.e. resists octave-down
// errors), parabolic interpolation for sub-sample lag accuracy.
//
// Co-equal candidate to YinDetector for this app's bake-off (see
// ../../CLAUDE.md) — implemented independently, not as a thin wrapper
// around YIN's difference function, since the two normalizations differ
// (NSDF vs. cumulative-mean-normalized difference).
//
// Not thread-safe: each instance owns a scratch buffer reused across calls.
class MpmDetector {
 public:
  explicit MpmDetector(const PitchDetectorConfig& config);

  // See YinDetector::Detect for the frame-size recommendation; the same
  // MinRecommendedFrameSize() applies to both detectors since it's derived
  // from the shared PitchDetectorConfig, not algorithm-specific.
  [[nodiscard]] PitchResult Detect(const float* samples, std::size_t numSamples) const;
  [[nodiscard]] PitchResult Detect(const std::vector<float>& samples) const {
    return Detect(samples.data(), samples.size());
  }

  [[nodiscard]] const PitchDetectorConfig& config() const { return config_; }

 private:
  PitchDetectorConfig config_;
  int tauMin_;
  int tauMax_;
  mutable std::vector<double> nsdfBuffer_;  // n'(tau), reused across calls
};

}  // namespace dsp_native
