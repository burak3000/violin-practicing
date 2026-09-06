#include "dsp_native/types.h"

#include <cmath>

namespace dsp_native {

int PitchDetectorConfig::MinRecommendedFrameSize() const {
  const int tauMax = static_cast<int>(std::ceil(sampleRateHz / minFrequencyHz));
  // Want at least ~2 full periods of the lowest searched frequency within
  // the shrinking integration window (numSamples - tauMax); numSamples ==
  // 3 * tauMax gives (3*tauMax - tauMax) == 2*tauMax samples of integration
  // window at the worst case (lowest) frequency, i.e. exactly 2 periods.
  return 3 * tauMax;
}

PitchDetectorConfig PitchDetectorConfig::ForViolin(double sampleRateHz) {
  PitchDetectorConfig config;
  config.sampleRateHz = sampleRateHz;
  return config;
}

}  // namespace dsp_native
