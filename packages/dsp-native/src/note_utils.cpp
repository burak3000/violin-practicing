#include "dsp_native/note_utils.h"

#include <array>
#include <cmath>
#include <cstdio>
#include <regex>

namespace dsp_native {

namespace {

// Index 0 = C, matching standard pitch-class numbering used throughout.
constexpr std::array<const char*, 12> kNoteNames = {"C",  "C#", "D",  "D#", "E",  "F",
                                                      "F#", "G",  "G#", "A",  "A#", "B"};

}  // namespace

double MidiToFrequencyHz(double midiNote, double a4Hz) {
  return a4Hz * std::pow(2.0, (midiNote - 69.0) / 12.0);
}

double FrequencyHzToMidi(double frequencyHz, double a4Hz) {
  return 69.0 + 12.0 * std::log2(frequencyHz / a4Hz);
}

double FrequencyToCents(double frequencyHz, double referenceHz) {
  return 1200.0 * std::log2(frequencyHz / referenceHz);
}

double CentsOffNearestNote(double frequencyHz, double a4Hz) {
  const double midi = FrequencyHzToMidi(frequencyHz, a4Hz);
  const double nearestMidi = std::round(midi);
  return (midi - nearestMidi) * 100.0;
}

std::optional<double> ParseScientificPitchToHz(const std::string& name, double a4Hz) {
  // [A-G] then optional '#' (sharp) or 'b' (flat), then a non-negative
  // integer octave. E.g. "G3", "Bb4", "C#5", "Db6".
  static const std::regex kPattern(R"(^([A-Ga-g])([#b]?)(\d+)$)");
  std::smatch match;
  if (!std::regex_match(name, match, kPattern)) {
    return std::nullopt;
  }

  const char letter = static_cast<char>(std::toupper(match[1].str()[0]));
  static const std::array<int, 7> kBasePitchClass = {
      9,  // A
      11, // B
      0,  // C
      2,  // D
      4,  // E
      5,  // F
      7,  // G
  };
  const int letterIndex = letter - 'A';
  if (letterIndex < 0 || letterIndex >= 7) {
    return std::nullopt;
  }
  int pitchClass = kBasePitchClass[static_cast<std::size_t>(letterIndex)];

  const std::string accidental = match[2].str();
  if (accidental == "#") {
    pitchClass += 1;
  } else if (accidental == "b") {
    pitchClass -= 1;
  }

  const int octave = std::stoi(match[3].str());
  // Scientific pitch notation: MIDI = (octave + 1) * 12 + pitchClass, so
  // C4 ("middle C") == MIDI 60. Matches the plan's stated open-string
  // frequencies (G3 == 196.00 Hz, A4 == 440.00 Hz, etc.) at a4Hz == 440.
  const int midi = (octave + 1) * 12 + pitchClass;
  return MidiToFrequencyHz(static_cast<double>(midi), a4Hz);
}

std::string DescribeFrequency(double frequencyHz, double a4Hz) {
  if (frequencyHz <= 0.0) {
    return "(no pitch)";
  }
  const double midi = FrequencyHzToMidi(frequencyHz, a4Hz);
  const int nearestMidi = static_cast<int>(std::lround(midi));
  const double cents = (midi - nearestMidi) * 100.0;
  const int pitchClass = ((nearestMidi % 12) + 12) % 12;
  const int octave = nearestMidi / 12 - 1;

  char buffer[32];
  std::snprintf(buffer, sizeof(buffer), "%s%d %+.0fc", kNoteNames[static_cast<std::size_t>(pitchClass)],
                octave, cents);
  return std::string(buffer);
}

}  // namespace dsp_native
