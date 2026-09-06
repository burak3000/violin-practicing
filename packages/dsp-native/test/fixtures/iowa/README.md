# Iowa violin fixtures — provenance

Real acoustic violin recordings from the **University of Iowa Musical
Instrument Samples (MIS)** database, used by the Phase 1 validation harness
as the "plausibility/stability, no exact ground truth" tier (see
`../../../CLAUDE.md` and `../../../RESULTS.md`). These recordings are
produced by the University of Iowa Electronic Music Studios and distributed
for free, unrestricted (including commercial) use — see the "Usage" note on
the source pages linked below.

Source pages (2012 pitched-sample set):

- Listing page: <https://theremin.music.uiowa.edu/MISviolin2012.html>
- Direct sound-file directory:
  `https://theremin.music.uiowa.edu/sound files/MIS/Strings/violin2012/`
  (space in `sound files` is part of the real path; URL-encode it as `%20`)

## What was downloaded, and why these six

Each Iowa MIS string file is a **chromatic run** (an ascending scale across
a labelled note range), not a single held note — e.g.
`Violin.arco.mf.sulG.G3B3.mono.aif` is an arco, mezzo-forte, G-string run
from G3 up to B3. That's fine for this harness: without exact per-instant
ground truth, we only need _plausibility_ (does the detected pitch stay in
the right octave/range for the string being played) and _stability_ (how
jittery is the detector within what the onset/duration layer identifies as
one held note) — both of which a chromatic run exercises well, and a run
also gives many real note-attack transients per file for the onset detector
to chew on.

Six files were picked to cover all four strings, a soft dynamic (harder
signal), and the most extreme high-register/harmonic-dense case:

| File                                      | String | Dynamic | Why                                                                   |
| ----------------------------------------- | ------ | ------- | --------------------------------------------------------------------- |
| `Violin.arco.mf.sulG.G3B3.mono.{aif,wav}` | G      | mf      | Lowest string — hardest case (longest period).                        |
| `Violin.arco.pp.sulG.G3B3.mono.{aif,wav}` | G      | pp      | Same range, quiet/breathy — stresses the confidence/harmonicity gate. |
| `Violin.arco.mf.sulD.D4B4.mono.{aif,wav}` | D      | mf      | Second string, baseline case.                                         |
| `Violin.arco.mf.sulA.A4B4.mono.{aif,wav}` | A      | mf      | Third string, baseline case.                                          |
| `Violin.arco.mf.sulE.E5B5.mono.{aif,wav}` | E      | mf      | Highest string, first position — normal high case.                    |
| `Violin.arco.ff.sulE.C7E7.mono.{aif,wav}` | E      | ff      | Extreme high position (C7–E7, ~2093–2637 Hz) — see caveat below.      |

No separate vibrato-vs-non-vibrato files exist for violin in this dataset
(checked both `MISviolin.html` and `MISviolin2012.html` — no "vibrato"
filenames or mentions for strings); the plan's "with and without vibrato if
available as separate files" is therefore satisfied as "not available," not
silently skipped.

**Caveat on the `C7E7` file:** its content (~2093–2637 Hz) is _above_ this
package's configured pitch-search ceiling (`maxFrequencyHz = 1600 Hz`,
chosen to comfortably cover the violin's practical first-position range up
to ~D6 — see `../../CLAUDE.md`). Both detectors are therefore structurally
unable to report the true fundamental for this file; its results measure
**graceful degradation under out-of-range input** (does the detector fail
safely/plausibly, or emit wild garbage), not tracking accuracy. It was kept
specifically for that purpose, not removed, once this became clear — see
`../../RESULTS.md` for how its numbers are interpreted.

## Format

Originals are 16-bit PCM mono AIFF at 44.1kHz (confirmed via `afinfo`).
Converted to 16-bit PCM mono WAV (same sample rate, same bit depth — a
lossless container change, not a re-encode) via macOS's `afconvert`:

```
afconvert -f WAVE -d LEI16 Violin.arco.mf.sulG.G3B3.mono.aif Violin.arco.mf.sulG.G3B3.mono.wav
```

Both the original `.aif` (provenance/authenticity) and the converted `.wav`
(what `validation_harness` actually reads — this package's WAV reader does
not parse AIFF) are kept side by side here.

## Ground truth used by the harness

The harness parses the note-range token from each filename (e.g. `G3B3` ->
G3 to B3) via `ExtractNoteRangeFromFilename` in `../../test/validation_harness.cpp`,
using the same scientific-pitch-notation parser (`ParseScientificPitchToHz`
in `../../include/dsp_native/note_utils.h`) written for this purpose. This
gives a coarse _acceptable band_ per file, not an exact per-frame ground
truth — see `../../RESULTS.md` for exactly how that's used.
