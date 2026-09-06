#include "dsp_native/harmonicity.h"

#include <algorithm>
#include <cmath>

namespace dsp_native {

namespace {
constexpr double kHnrFloorDb = -20.0;
constexpr double kHnrCeilDb = 40.0;
}  // namespace

HarmonicityResult ComputeHarmonicity(const float* samples, std::size_t numSamples,
                                      double periodSamples) {
  HarmonicityResult result;
  result.harmonicToNoiseRatioDb = kHnrFloorDb;
  if (periodSamples <= 0.0 || numSamples < 4) {
    return result;
  }

  const long tau = std::lround(periodSamples);
  if (tau <= 0 || static_cast<std::size_t>(tau) >= numSamples) {
    return result;
  }

  double acf = 0.0;
  double energy = 0.0;
  const std::size_t limit = numSamples - static_cast<std::size_t>(tau);
  for (std::size_t j = 0; j < limit; ++j) {
    const double xj = static_cast<double>(samples[j]);
    const double xjt = static_cast<double>(samples[j + static_cast<std::size_t>(tau)]);
    acf += xj * xjt;
    energy += xj * xj + xjt * xjt;
  }

  const double r = energy > 0.0 ? std::clamp(2.0 * acf / energy, -1.0, 1.0) : 0.0;
  result.normalizedPeriodicity = std::max(0.0, r);

  // Boersma (1993) autocorrelation-based HNR: HNR(dB) = 10*log10(r/(1-r)).
  if (r <= 0.0) {
    result.harmonicToNoiseRatioDb = kHnrFloorDb;
  } else if (r >= 1.0) {
    result.harmonicToNoiseRatioDb = kHnrCeilDb;
  } else {
    const double hnr = 10.0 * std::log10(r / (1.0 - r));
    result.harmonicToNoiseRatioDb = std::clamp(hnr, kHnrFloorDb, kHnrCeilDb);
  }
  return result;
}

}  // namespace dsp_native
