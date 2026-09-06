#pragma once

#include <string>
#include <vector>

namespace dsp_native {

struct WavAudio {
  std::vector<float> samples;  // mono, normalized to [-1, 1]
  double sampleRateHz = 0.0;
};

// Reads a canonical RIFF/WAVE file: PCM (8/16/24/32-bit int) or IEEE float
// (32/64-bit). Multi-channel files are downmixed to mono by averaging
// channels. Throws std::runtime_error on any parse failure (missing/garbled
// chunks, unsupported format) — this is test/tooling code reading a small,
// curated set of fixtures, so failing loudly beats guessing.
WavAudio ReadWavFile(const std::string& path);

// Writes mono float32 samples (expected range [-1, 1]; out-of-range values
// are clamped) as a 16-bit PCM mono WAV file. Used by the synthetic-fixture
// generator; not needed by production pitch-detection code.
void WriteMonoWavFile(const std::string& path, const std::vector<float>& samples,
                       double sampleRateHz);

}  // namespace dsp_native
