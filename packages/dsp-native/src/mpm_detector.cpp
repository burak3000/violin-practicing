#include "dsp_native/mpm_detector.h"

#include <algorithm>
#include <cmath>

namespace dsp_native {

namespace {

int ComputeTauMin(const PitchDetectorConfig& c) {
  return std::max(1, static_cast<int>(std::floor(c.sampleRateHz / c.maxFrequencyHz)));
}

int ComputeTauMax(const PitchDetectorConfig& c) {
  return static_cast<int>(std::ceil(c.sampleRateHz / c.minFrequencyHz));
}

struct Peak {
  int tau;
  double value;
};

}  // namespace

MpmDetector::MpmDetector(const PitchDetectorConfig& config)
    : config_(config), tauMin_(ComputeTauMin(config)), tauMax_(ComputeTauMax(config)) {
  nsdfBuffer_.resize(static_cast<std::size_t>(tauMax_) + 1, 0.0);
}

PitchResult MpmDetector::Detect(const float* samples, std::size_t numSamples) const {
  PitchResult result;
  const int tauMax = std::min(tauMax_, static_cast<int>(numSamples) - 1);
  if (tauMax <= tauMin_ || numSamples < 4) {
    return result;
  }
  if (static_cast<std::size_t>(tauMax) + 1 > nsdfBuffer_.size()) {
    nsdfBuffer_.resize(static_cast<std::size_t>(tauMax) + 1, 0.0);
  }

  // Normalized square difference function (McLeod & Wyvill 2005, eq. 8/9):
  // n'(tau) = 2 * sum_j(x[j]*x[j+tau]) / sum_j(x[j]^2 + x[j+tau]^2), summed
  // over j in [0, numSamples - tau). n'(0) == 1 by construction.
  for (int tau = 0; tau <= tauMax; ++tau) {
    double acf = 0.0;
    double energy = 0.0;
    const int limit = static_cast<int>(numSamples) - tau;
    for (int j = 0; j < limit; ++j) {
      const double xj = static_cast<double>(samples[j]);
      const double xjt = static_cast<double>(samples[j + tau]);
      acf += xj * xjt;
      energy += xj * xj + xjt * xjt;
    }
    nsdfBuffer_[static_cast<std::size_t>(tau)] = energy > 0.0 ? (2.0 * acf / energy) : 0.0;
  }

  // Key-maxima peak picking: within each lobe between a positive-going and
  // the following negative-going zero crossing, keep only the local max.
  // The trivial tau==0 peak (always 1.0) is naturally excluded because no
  // positive-going crossing precedes it. Restricted to [tauMin_, tauMax] —
  // the violin-range search window — so an out-of-range lobe can never be
  // picked even if it happens to be tallest.
  std::vector<Peak> peaks;
  int tau = 1;
  while (tau < tauMax) {
    const bool crossingUp =
        nsdfBuffer_[static_cast<std::size_t>(tau - 1)] <= 0.0 && nsdfBuffer_[static_cast<std::size_t>(tau)] > 0.0;
    if (!crossingUp) {
      ++tau;
      continue;
    }
    int peakTau = tau;
    double peakVal = nsdfBuffer_[static_cast<std::size_t>(tau)];
    ++tau;
    while (tau <= tauMax && nsdfBuffer_[static_cast<std::size_t>(tau)] > 0.0) {
      if (nsdfBuffer_[static_cast<std::size_t>(tau)] > peakVal) {
        peakVal = nsdfBuffer_[static_cast<std::size_t>(tau)];
        peakTau = tau;
      }
      ++tau;
    }
    if (peakTau >= tauMin_ && peakTau <= tauMax) {
      peaks.push_back({peakTau, peakVal});
    }
  }

  int chosenTau;
  double chosenVal;
  bool foundQualifyingPeak = false;
  if (!peaks.empty()) {
    double globalMax = peaks.front().value;
    for (const Peak& p : peaks) {
      globalMax = std::max(globalMax, p.value);
    }
    const double threshold = config_.mpmClarityThreshold * globalMax;
    // First (lowest-lag == highest-frequency) peak clearing the threshold —
    // this is the mechanism that resists octave-down errors: a taller peak
    // at 2x the true period (a genuine sub-harmonic-strength artifact) is
    // skipped in favor of the earlier, still-qualifying true-period peak.
    Peak chosen = peaks.front();
    for (const Peak& p : peaks) {
      if (p.value >= threshold) {
        chosen = p;
        break;
      }
    }
    chosenTau = chosen.tau;
    chosenVal = chosen.value;
    foundQualifyingPeak = true;
  } else {
    // Fallback: no lobe structure at all in range (signal not periodic
    // enough to even form a peak) — report the raw max in range as a
    // best-effort estimate, marked unvoiced.
    chosenTau = tauMin_;
    chosenVal = nsdfBuffer_[static_cast<std::size_t>(tauMin_)];
    for (int t = tauMin_ + 1; t <= tauMax; ++t) {
      if (nsdfBuffer_[static_cast<std::size_t>(t)] > chosenVal) {
        chosenVal = nsdfBuffer_[static_cast<std::size_t>(t)];
        chosenTau = t;
      }
    }
  }

  // Parabolic interpolation around chosenTau for sub-sample lag.
  double betterTau = static_cast<double>(chosenTau);
  if (chosenTau > 0 && chosenTau < tauMax) {
    const double y0 = nsdfBuffer_[static_cast<std::size_t>(chosenTau - 1)];
    const double y1 = nsdfBuffer_[static_cast<std::size_t>(chosenTau)];
    const double y2 = nsdfBuffer_[static_cast<std::size_t>(chosenTau + 1)];
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
  result.confidence = std::clamp(chosenVal, 0.0, 1.0);
  result.voiced = foundQualifyingPeak;
  return result;
}

}  // namespace dsp_native
