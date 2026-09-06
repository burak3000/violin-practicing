#pragma once

#include <optional>
#include <string>

namespace dsp_native {

inline constexpr double kDefaultA4Hz = 440.0;

// midiNote 69 == A4 (== a4Hz). Standard equal-tempered mapping, matching the
// scientific-pitch-notation convention where C4 is "middle C" (MIDI 60).
double MidiToFrequencyHz(double midiNote, double a4Hz = kDefaultA4Hz);
double FrequencyHzToMidi(double frequencyHz, double a4Hz = kDefaultA4Hz);

// cents = 1200 * log2(frequencyHz / referenceHz). Positive => sharp of the
// reference, negative => flat. `frequencyHz` must be > 0.
double FrequencyToCents(double frequencyHz, double referenceHz);

// Cents offset from the nearest equal-tempered note (nearest rounded MIDI
// number), referenced to a4Hz. E.g. 445 Hz with a4Hz=440 => ~+19.6 cents.
double CentsOffNearestNote(double frequencyHz, double a4Hz = kDefaultA4Hz);

// Parses scientific pitch notation (e.g. "G3", "Bb4", "C#5", "Db6") to Hz.
// Returns nullopt if `name` doesn't parse. Accepts '#' (sharp) or 'b' (flat,
// lowercase only, to avoid ambiguity with the 'B' natural note letter);
// octave is a plain non-negative integer. This is primarily written to
// parse the University of Iowa fixture filenames (see
// test/fixtures/iowa/README.md) and any future user-violin fixture manifest
// entries — not a general-purpose music-notation parser.
std::optional<double> ParseScientificPitchToHz(const std::string& name,
                                                double a4Hz = kDefaultA4Hz);

// Human-readable "NoteName+cents" label, e.g. "A4 -3c". For logging/reports
// only.
std::string DescribeFrequency(double frequencyHz, double a4Hz = kDefaultA4Hz);

}  // namespace dsp_native
