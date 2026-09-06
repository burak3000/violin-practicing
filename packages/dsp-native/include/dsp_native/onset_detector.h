#pragma once

#include <cstddef>
#include <deque>

namespace dsp_native {

// Computes RMS level in dBFS (full-scale sine at amplitude 1.0 == 0 dBFS).
// Returns a floor value (see kSilenceFloorDbfs in the .cpp) for all-zero
// input rather than -infinity.
[[nodiscard]] double ComputeRmsDbfs(const float* samples, std::size_t numSamples);

struct OnsetConfig {
  // RMS-envelope silence/noise gate: frames at or below this level are
  // treated as silence regardless of what the pitch detector reported.
  // Default matches the plan's "~-50dBFS default, configurable".
  double silenceThresholdDbfs = -50.0;

  // A frame-to-frame RMS rise at or above this many dB, while not already
  // in a confirmed Sustained note, flags a new attack (bow-noise transient
  // zone) rather than being ignored as steady-state noise.
  double onsetRiseDb = 6.0;

  // Number of consecutive voiced frames, all within
  // stabilityCentsTolerance of their own mean, required before an Attack is
  // promoted to a confirmed Sustained note (the "onset"). This is the
  // "pitch-stability confirmation" the plan calls for instead of trusting
  // the very first frame (bow-attack transients are frequently mistracked).
  int stabilityConfirmFrames = 3;
  double stabilityCentsTolerance = 35.0;
};

enum class FrameState { kSilence, kAttack, kSustained };

struct FrameEvent {
  FrameState state = FrameState::kSilence;
  bool noteOnset = false;   // true exactly on the frame a note is confirmed
  bool noteOffset = false;  // true exactly on the frame a sustained note ends
};

// RMS-gate + onset/offset segmentation layer described in Phase 1 point 4:
// silence/noise gate, then energy-rise attack detection, then
// pitch-stability confirmation before accepting a note has actually
// started. Deliberately NOT spectral-flux based — the plan rejects that as
// unneeded compute for this monophonic bowed-string case; RMS envelope +
// already-computed pitch stream is enough signal.
//
// Stateful and stream-oriented: call ProcessFrame once per analysis hop, in
// order. Not thread-safe.
class OnsetSegmenter {
 public:
  explicit OnsetSegmenter(const OnsetConfig& config);

  // `rmsDbfs` from ComputeRmsDbfs for this frame's samples. `pitchVoiced`
  // and `frequencyHz` should already reflect the harmonicity gate (i.e. the
  // caller has already suppressed pitch output on low-HNR frames) — this
  // class only adds the *temporal* onset/offset/stability logic on top.
  FrameEvent ProcessFrame(double rmsDbfs, bool pitchVoiced, double frequencyHz);

  [[nodiscard]] FrameState state() const { return state_; }

 private:
  OnsetConfig config_;
  FrameState state_ = FrameState::kSilence;
  std::deque<double> recentVoicedHz_;
  double lastRmsDbfs_ = -120.0;

  [[nodiscard]] bool RecentPitchIsStable() const;
};

}  // namespace dsp_native
