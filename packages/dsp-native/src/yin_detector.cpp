#include "dsp_native/yin_detector.h"

#include <algorithm>
#include <cmath>

namespace dsp_native {

namespace {

int ComputeTauMin(const PitchDetectorConfig& c) {
  return std::max(2, static_cast<int>(std::floor(c.sampleRateHz / c.maxFrequencyHz)));
}

int ComputeTauMax(const PitchDetectorConfig& c) {
  return static_cast<int>(std::ceil(c.sampleRateHz / c.minFrequencyHz));
}

}  // namespace

YinDetector::YinDetector(const PitchDetectorConfig& config)
    : config_(config), tauMin_(ComputeTauMin(config)), tauMax_(ComputeTauMax(config)) {
  diffBuffer_.resize(static_cast<std::size_t>(tauMax_) + 1, 0.0);
}

PitchResult YinDetector::Detect(const float* samples, std::size_t numSamples) const {
  PitchResult result;
  const int tauMax = std::min(tauMax_, static_cast<int>(numSamples) - 1);
  if (tauMax <= tauMin_ || numSamples < 4) {
    return result;  // not enough samples to search any in-range lag at all
  }
  if (static_cast<std::size_t>(tauMax) + 1 > diffBuffer_.size()) {
    diffBuffer_.resize(static_cast<std::size_t>(tauMax) + 1, 0.0);
  }

  // Step 1 (de Cheveigne & Kawahara 2002, eq. 6): difference function
  // d(tau) = sum_j (x[j] - x[j+tau])^2, summed over j in
  // [0, numSamples - tau). This is a shrinking integration window as tau
  // grows rather than the paper's fixed-window formulation — a standard
  // practical simplification (also used by e.g. aubio's YIN) that's safe
  // here because tauMax_ is a small fraction of the recommended frame size
  // (see PitchDetectorConfig::MinRecommendedFrameSize), so the bias it
  // introduces is small and further attenuated by step 2's normalization.
  diffBuffer_[0] = 0.0;
  for (int tau = 1; tau <= tauMax; ++tau) {
    double sum = 0.0;
    const int limit = static_cast<int>(numSamples) - tau;
    for (int j = 0; j < limit; ++j) {
      const double diff = static_cast<double>(samples[j]) - static_cast<double>(samples[j + tau]);
      sum += diff * diff;
    }
    diffBuffer_[static_cast<std::size_t>(tau)] = sum;
  }

  // Step 2 (eq. 8): cumulative mean normalized difference function.
  diffBuffer_[0] = 1.0;
  double runningSum = 0.0;
  for (int tau = 1; tau <= tauMax; ++tau) {
    runningSum += diffBuffer_[static_cast<std::size_t>(tau)];
    diffBuffer_[static_cast<std::size_t>(tau)] =
        (runningSum == 0.0) ? 1.0 : diffBuffer_[static_cast<std::size_t>(tau)] * tau / runningSum;
  }

  // Step 3 (eq. 4 "absolute threshold"): first dip below yinThreshold within
  // [tauMin_, tauMax] (restricted to the violin's plausible period range),
  // descending to that dip's local minimum.
  int chosenTau = -1;
  for (int tau = tauMin_; tau <= tauMax; ++tau) {
    if (diffBuffer_[static_cast<std::size_t>(tau)] < config_.yinThreshold) {
      int t = tau;
      while (t + 1 <= tauMax &&
             diffBuffer_[static_cast<std::size_t>(t + 1)] < diffBuffer_[static_cast<std::size_t>(t)]) {
        ++t;
      }
      chosenTau = t;
      break;
    }
  }

  const bool thresholdMet = chosenTau != -1;
  if (!thresholdMet) {
    // Fallback: nothing cleared the threshold anywhere in range. Report the
    // global minimum in-range as a best-effort estimate but mark unvoiced —
    // the caller should not trust this as a confirmed pitch.
    double bestVal = diffBuffer_[static_cast<std::size_t>(tauMin_)];
    chosenTau = tauMin_;
    for (int tau = tauMin_ + 1; tau <= tauMax; ++tau) {
      if (diffBuffer_[static_cast<std::size_t>(tau)] < bestVal) {
        bestVal = diffBuffer_[static_cast<std::size_t>(tau)];
        chosenTau = tau;
      }
    }
  }

  // Step 5 (eq. 9): parabolic interpolation around chosenTau.
  double betterTau = static_cast<double>(chosenTau);
  if (chosenTau > 0 && chosenTau < tauMax) {
    const double y0 = diffBuffer_[static_cast<std::size_t>(chosenTau - 1)];
    const double y1 = diffBuffer_[static_cast<std::size_t>(chosenTau)];
    const double y2 = diffBuffer_[static_cast<std::size_t>(chosenTau + 1)];
    const double denom = y0 - 2.0 * y1 + y2;
    if (std::abs(denom) > 1e-12) {
      const double offset = 0.5 * (y0 - y2) / denom;
      if (offset > -1.0 && offset < 1.0) {
        betterTau += offset;
      }
    }
  }

  result.periodSamples = betterTau;
  result.frequencyHz = betterTau > 0.0 ? config_.sampleRateHz / betterTau : 0.0;
  result.confidence = std::clamp(1.0 - diffBuffer_[static_cast<std::size_t>(chosenTau)], 0.0, 1.0);
  result.voiced = thresholdMet;
  return result;
}

}  // namespace dsp_native
