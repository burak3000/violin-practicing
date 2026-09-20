// Synthetic WAV fixture generator for the Phase 1 pitch-detection
// validation harness (see ../CLAUDE.md). Produces:
//
//  - A "chromatic" set: sine AND sawtooth tones at every semitone from G3
//    (~196 Hz, the violin's lowest open string) to D6 (~1175 Hz, just above
//    the practical first-position ceiling) — the sawtooth set is what
//    stresses octave-error resistance, since a bowed string's real
//    waveform is sawtooth-like (harmonically rich), not a pure sine.
//  - An "adversarial" set: sawtooth-like tones at a few notes with the
//    fundamental deliberately attenuated *below* its 2nd harmonic — a
//    direct synthetic stand-in for the "piezo pickups are documented as
//    top-heavy, emphasizing upper harmonics over the fundamental" concern
//    cited in temp/PLAN-violin-practice-app.md as part of MPM's specific
//    violin-relevant evidence. This is the single most direct test of
//    "does the algorithm avoid octave error when the fundamental is weak
//    relative to a harmonic" in this fixture set.
//
// Every fixture is silence -> fade-in -> steady tone -> fade-out -> silence,
// so the same files also exercise the onset/offset segmentation layer
// (OnsetSegmenter) in the harness, not just raw per-frame pitch accuracy.
// Ground truth is exact by construction (we generated the frequency), and
// is recorded in manifest.csv alongside each file so the harness never has
// to re-derive it from the filename.
//
// Usage: generate_synthetic_fixtures <output-dir>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "dsp_native/note_utils.h"
#include "dsp_native/wav_file.h"

namespace {

namespace fs = std::filesystem;
constexpr double kPi = 3.14159265358979323846;
constexpr double kSampleRateHz = 44100.0;
constexpr double kSilenceLeadS = 0.2;
constexpr double kFadeS = 0.05;
constexpr double kSteadyS = 1.0;
constexpr double kTargetPeak = 0.7;

const char* kPitchClassNames[12] = {"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"};

std::string MidiToName(int midi) {
  const int pitchClass = ((midi % 12) + 12) % 12;
  const int octave = midi / 12 - 1;
  return std::string(kPitchClassNames[pitchClass]) + std::to_string(octave);
}

// Full-duration (including silence/fade regions) sine carrier at constant
// amplitude; envelope is applied afterward so phase stays continuous.
std::vector<double> SineCarrier(double frequencyHz, std::size_t numSamples) {
  std::vector<double> out(numSamples);
  for (std::size_t n = 0; n < numSamples; ++n) {
    const double t = static_cast<double>(n) / kSampleRateHz;
    out[n] = std::sin(2.0 * kPi * frequencyHz * t);
  }
  return out;
}

// Band-limited sawtooth-like carrier via additive synthesis (Fourier
// series of a sawtooth: amplitude 1/k, alternating sign, per harmonic k).
// `fundamentalScale` multiplies only the k==1 term — used to build the
// "adversarial weak fundamental" fixtures (fundamentalScale < 1 makes H2
// louder than H1). numHarmonics is capped well below Nyquist (0.45 *
// sampleRate / f) so this never itself introduces aliasing artifacts that
// would confound the "is the algorithm reacting to real harmonic content"
// question the fixture is meant to test.
std::vector<double> SawtoothCarrier(double frequencyHz, std::size_t numSamples,
                                     double fundamentalScale = 1.0) {
  const int numHarmonics = std::max(1, static_cast<int>(std::floor(0.45 * kSampleRateHz / frequencyHz)));
  std::vector<double> out(numSamples, 0.0);
  for (std::size_t n = 0; n < numSamples; ++n) {
    const double t = static_cast<double>(n) / kSampleRateHz;
    double sample = 0.0;
    for (int k = 1; k <= numHarmonics; ++k) {
      double amp = 1.0 / static_cast<double>(k);
      if (k == 1) {
        amp *= fundamentalScale;
      }
      const double sign = (k % 2 == 0) ? -1.0 : 1.0;
      sample += sign * amp * std::sin(2.0 * kPi * k * frequencyHz * t);
    }
    out[n] = sample;
  }
  return out;
}

void NormalizePeak(std::vector<double>& buf, double targetPeak) {
  double peak = 0.0;
  for (double v : buf) {
    peak = std::max(peak, std::abs(v));
  }
  if (peak <= 0.0) {
    return;
  }
  const double scale = targetPeak / peak;
  for (double& v : buf) {
    v *= scale;
  }
}

// Applies silence -> fade-in -> steady -> fade-out -> silence in place, and
// returns [toneStartS, toneEndS) marking the steady region (fades and
// silence excluded) for ground-truth comparison in the harness.
std::pair<double, double> ApplyEnvelope(std::vector<double>& buf) {
  const auto leadN = static_cast<std::size_t>(std::llround(kSilenceLeadS * kSampleRateHz));
  const auto fadeN = static_cast<std::size_t>(std::llround(kFadeS * kSampleRateHz));
  const auto steadyN = static_cast<std::size_t>(std::llround(kSteadyS * kSampleRateHz));
  const std::size_t fadeInStart = leadN;
  const std::size_t steadyStart = fadeInStart + fadeN;
  const std::size_t fadeOutStart = steadyStart + steadyN;
  const std::size_t fadeOutEnd = fadeOutStart + fadeN;

  for (std::size_t n = 0; n < buf.size(); ++n) {
    double gain;
    if (n < fadeInStart) {
      gain = 0.0;
    } else if (n < steadyStart) {
      gain = static_cast<double>(n - fadeInStart) / static_cast<double>(fadeN);
    } else if (n < fadeOutStart) {
      gain = 1.0;
    } else if (n < fadeOutEnd) {
      gain = 1.0 - static_cast<double>(n - fadeOutStart) / static_cast<double>(fadeN);
    } else {
      gain = 0.0;
    }
    buf[n] *= gain;
  }
  return {static_cast<double>(steadyStart) / kSampleRateHz, static_cast<double>(fadeOutStart) / kSampleRateHz};
}

std::size_t TotalNumSamples() {
  return static_cast<std::size_t>(std::llround((2 * kSilenceLeadS + 2 * kFadeS + kSteadyS) * kSampleRateHz));
}

struct ManifestRow {
  std::string relativePath;
  std::string category;
  std::string waveform;
  std::string noteName;
  double frequencyHz;
  double toneStartS;
  double toneEndS;
};

void WriteFixture(const fs::path& outDir, const std::string& relativePath, std::vector<double> carrier,
                   const std::string& category, const std::string& waveform, const std::string& noteName,
                   double frequencyHz, std::vector<ManifestRow>& manifest) {
  NormalizePeak(carrier, kTargetPeak);
  const auto [toneStartS, toneEndS] = ApplyEnvelope(carrier);

  std::vector<float> samples(carrier.size());
  for (std::size_t i = 0; i < carrier.size(); ++i) {
    samples[i] = static_cast<float>(carrier[i]);
  }

  const fs::path fullPath = outDir / relativePath;
  fs::create_directories(fullPath.parent_path());
  dsp_native::WriteMonoWavFile(fullPath.string(), samples, kSampleRateHz);

  manifest.push_back({relativePath, category, waveform, noteName, frequencyHz, toneStartS, toneEndS});
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: %s <output-dir>\n", argv[0]);
    return 1;
  }
  const fs::path outDir(argv[1]);
  fs::create_directories(outDir);

  std::vector<ManifestRow> manifest;
  const std::size_t numSamples = TotalNumSamples();

  // Chromatic sweep: G3 (MIDI 55) to D6 (MIDI 86) inclusive, sine + sawtooth.
  constexpr int kFirstMidi = 55;  // G3
  constexpr int kLastMidi = 86;   // D6
  for (int midi = kFirstMidi; midi <= kLastMidi; ++midi) {
    const double freq = dsp_native::MidiToFrequencyHz(midi);
    const std::string name = MidiToName(midi);
    char freqLabel[32];
    std::snprintf(freqLabel, sizeof(freqLabel), "%.2fHz", freq);

    WriteFixture(outDir, "chromatic/sine_" + name + "_" + freqLabel + ".wav", SineCarrier(freq, numSamples),
                 "chromatic", "sine", name, freq, manifest);
    WriteFixture(outDir, "chromatic/saw_" + name + "_" + freqLabel + ".wav", SawtoothCarrier(freq, numSamples),
                 "chromatic", "sawtooth", name, freq, manifest);
  }

  // Adversarial weak-fundamental set: fundamental at 20% amplitude vs. the
  // natural sawtooth series (so H2, at its natural 50% amplitude, ends up
  // 2.5x louder than H1) at a handful of notes spanning the upper range,
  // where the plan's piezo "top-heavy" coloration concern is most relevant.
  const std::vector<std::string> adversarialNotes = {"A4", "E5", "A5", "D6"};
  for (const std::string& name : adversarialNotes) {
    const auto freqOpt = dsp_native::ParseScientificPitchToHz(name);
    if (!freqOpt) {
      std::fprintf(stderr, "internal error: could not parse adversarial note '%s'\n", name.c_str());
      return 1;
    }
    const double freq = *freqOpt;
    char freqLabel[32];
    std::snprintf(freqLabel, sizeof(freqLabel), "%.2fHz", freq);
    WriteFixture(outDir, "adversarial/sawWeakFund_" + name + "_" + freqLabel + ".wav",
                 SawtoothCarrier(freq, numSamples, /*fundamentalScale=*/0.2), "adversarial", "sawtooth_weak_fundamental",
                 name, freq, manifest);
  }

  const fs::path manifestPath = outDir / "manifest.csv";
  std::ofstream manifestFile(manifestPath);
  manifestFile << "relative_path,category,waveform,note_name,frequency_hz,sample_rate_hz,tone_start_s,tone_end_s\n";
  for (const auto& row : manifest) {
    manifestFile << row.relativePath << ',' << row.category << ',' << row.waveform << ',' << row.noteName << ','
                 << row.frequencyHz << ',' << kSampleRateHz << ',' << row.toneStartS << ',' << row.toneEndS << '\n';
  }

  std::printf("generate_synthetic_fixtures: wrote %zu fixtures + manifest.csv to %s\n", manifest.size(),
              outDir.string().c_str());
  return 0;
}
