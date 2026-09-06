#include "dsp_native/onset_detector.h"

#include <algorithm>
#include <cmath>

namespace dsp_native {

namespace {
constexpr double kSilenceFloorDbfs = -120.0;
}  // namespace

double ComputeRmsDbfs(const float* samples, std::size_t numSamples) {
  if (numSamples == 0) {
    return kSilenceFloorDbfs;
  }
  double sumSq = 0.0;
  for (std::size_t i = 0; i < numSamples; ++i) {
    const double s = static_cast<double>(samples[i]);
    sumSq += s * s;
  }
  const double rms = std::sqrt(sumSq / static_cast<double>(numSamples));
  if (rms <= 0.0) {
    return kSilenceFloorDbfs;
  }
  return std::max(kSilenceFloorDbfs, 20.0 * std::log10(rms));
}

OnsetSegmenter::OnsetSegmenter(const OnsetConfig& config) : config_(config) {}

bool OnsetSegmenter::RecentPitchIsStable() const {
  if (static_cast<int>(recentVoicedHz_.size()) < config_.stabilityConfirmFrames) {
    return false;
  }
  double sum = 0.0;
  for (double f : recentVoicedHz_) {
    sum += f;
  }
  const double mean = sum / static_cast<double>(recentVoicedHz_.size());
  if (mean <= 0.0) {
    return false;
  }
  for (double f : recentVoicedHz_) {
    const double cents = 1200.0 * std::log2(f / mean);
    if (std::abs(cents) > config_.stabilityCentsTolerance) {
      return false;
    }
  }
  return true;
}

FrameEvent OnsetSegmenter::ProcessFrame(double rmsDbfs, bool pitchVoiced, double frequencyHz) {
  FrameEvent event;
  const bool aboveSilence = rmsDbfs > config_.silenceThresholdDbfs;
  const double riseDb = rmsDbfs - lastRmsDbfs_;
  lastRmsDbfs_ = rmsDbfs;

  if (!aboveSilence) {
    if (state_ == FrameState::kSustained) {
      event.noteOffset = true;
    }
    state_ = FrameState::kSilence;
    recentVoicedHz_.clear();
    event.state = state_;
    return event;
  }

  // A big-enough energy rise while already Sustained means a new bow
  // attack started with no intervening silence (e.g. a slurred note
  // change) — close out the previous note and re-open Attack so the new
  // pitch gets its own stability confirmation rather than silently
  // overwriting the previous note's duration.
  if (state_ == FrameState::kSustained && riseDb >= config_.onsetRiseDb) {
    event.noteOffset = true;
    state_ = FrameState::kAttack;
    recentVoicedHz_.clear();
  } else if (state_ == FrameState::kSilence) {
    state_ = FrameState::kAttack;
    recentVoicedHz_.clear();
  }

  if (state_ == FrameState::kAttack) {
    if (pitchVoiced && frequencyHz > 0.0) {
      recentVoicedHz_.push_back(frequencyHz);
      while (static_cast<int>(recentVoicedHz_.size()) > config_.stabilityConfirmFrames) {
        recentVoicedHz_.pop_front();
      }
    } else {
      recentVoicedHz_.clear();
    }
    if (RecentPitchIsStable()) {
      state_ = FrameState::kSustained;
      event.noteOnset = true;
    }
  }

  event.state = state_;
  return event;
}

}  // namespace dsp_native
