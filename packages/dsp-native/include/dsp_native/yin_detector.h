#pragma once

#include <cstddef>
#include <vector>

#include "dsp_native/types.h"

namespace dsp_native {

// YIN pitch detector (de Cheveigne & Kawahara, "YIN, a fundamental
// frequency estimator for speech and music", 2002): autocorrelation-style
// difference function, cumulative mean normalization, absolute-threshold
// dip search, parabolic interpolation for sub-sample lag accuracy.
//
// Not thread-safe: each instance owns a scratch buffer reused across calls
// to avoid a per-frame heap allocation. Use one instance per analysis
// thread.
class YinDetector {
 public:
  explicit YinDetector(const PitchDetectorConfig& config);

  // `samples` must have at least MinRecommendedFrameSize() entries for
  // minFrequencyHz to be reliably reachable; shorter buffers still work but
  // bias low-frequency detection. Extra samples beyond the minimum improve
  // low-note accuracy (more periods observed) at proportionally higher
  // compute cost.
  [[nodiscard]] PitchResult Detect(const float* samples, std::size_t numSamples) const;
  [[nodiscard]] PitchResult Detect(const std::vector<float>& samples) const {
    return Detect(samples.data(), samples.size());
  }

  [[nodiscard]] const PitchDetectorConfig& config() const { return config_; }

 private:
  PitchDetectorConfig config_;
  int tauMin_;
  int tauMax_;
  mutable std::vector<double> diffBuffer_;  // d(tau), reused across calls
};

}  // namespace dsp_native
