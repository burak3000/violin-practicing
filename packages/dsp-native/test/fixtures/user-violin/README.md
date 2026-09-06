# User-violin fixtures — PENDING (this directory is intentionally empty)

This tier of the Phase 1 validation harness is reserved for real recordings
from **your actual HVPV-30 electro-violin**, captured through its onboard
piezo pickup's line-out. Neither the synthetic tones nor the University of
Iowa acoustic recordings in `../iowa/` can substitute for this: piezo
pickups have documented instrument-specific harmonic coloration (a
"top-heavy" emphasis on upper harmonics relative to the fundamental — see
`temp/PLAN-violin-practice-app.md`'s citation [20]), which is exactly the
condition the plan's research flagged as potentially favoring MPM over YIN.
The empirical bake-off in `../../RESULTS.md` currently recommends YIN as
primary based on synthetic tones and the Iowa _acoustic_ recordings — real
piezo-pickup audio is the one untested condition the literature specifically
motivated as MPM's strongest case, so it's worth re-checking once real
files exist here, per `../../RESULTS.md`'s "what would change this
recommendation" section.

**Nothing has been fabricated or simulated for this tier.** The validation
harness checks this directory on every run and explicitly reports
`PENDING: 0 .wav files found` when empty (see the last `ctest` run's
`../../test/results/summary.txt`) rather than silently skipping it or
inventing placeholder data.

## What to record

A handful of short, clean recordings, each isolating one clear situation:

1. **Each open string held ~2-3 seconds**: G3, D4, A4, E5 — four files (or
   one per string at minimum; more repetitions are fine and only help).
2. **A slow one-octave scale** on at least one string (e.g. G major starting
   on open G), played slowly enough that each note is clearly held before
   moving to the next.
3. **One held note with deliberate vibrato** — pick any comfortable note,
   hold it for a few seconds while applying normal vibrato technique. This
   is the one condition nothing else in this fixture set covers at all.

Optional but useful if you have the patience: a few notes played _quietly_
(tests the confidence/harmonicity gate) and a couple of intentionally
scratchy/noisy bow attacks (tests that the gate correctly suppresses those
rather than reporting a confident wrong note).

## File format

- **WAV**, mono, 16-bit PCM (or 32-bit float) — any standard sample rate is
  fine (44.1kHz and 48kHz are both handled; the harness reads the rate from
  the file itself). If your recording software only exports stereo, that's
  fine too — the reader downmixes to mono automatically.
- Keep each file to one continuous idea (e.g. one open string, or one
  scale run) rather than concatenating unrelated takes.

## Naming (so the harness can auto-derive rough ground truth)

Where practical, include the note being played in **scientific pitch
notation** somewhere in the filename (e.g. `openG_G3.wav`,
`scale_G3_to_A4.wav`, `vibrato_A4.wav`). The harness's filename parser
(`ExtractNoteRangeFromFilename` in `../../test/validation_harness.cpp`)
recognizes a single note (`G3`) or a two-note range (`G3A4`) written with a
letter A-G, an optional `#`/`b` accidental, and an octave number, separated
from the rest of the filename by `.`, `_`, `-`, or a space. Sharps/flats
other than plain `#`/lowercase `b` are not recognized. If a filename
doesn't parse, the harness still runs it (stability/timing diagnostics
only, clearly labeled "no ground truth" in the report) — a manifest-driven
approach isn't required, but naming files this way gets you the fuller
in-range/octave-error report for free.

## Re-running the harness once files exist

Nothing else needs to change. Drop the `.wav` file(s) directly into this
directory and re-run:

```
pnpm build:dsp-native   # only if you haven't built since adding files — the
                         # harness binary itself doesn't need rebuilding for
                         # new fixtures, only re-running:
pnpm test:dsp-native
```

or directly: `ctest --test-dir packages/dsp-native/build --output-on-failure`.

The harness scans this directory automatically on every run
(`ListWavFiles(userViolinDir)` in `validation_harness.cpp`) and writes
`packages/dsp-native/test/results/user_violin_results.csv` alongside the
existing synthetic/Iowa results. Once real numbers exist here, the
primary-algorithm recommendation in `../../RESULTS.md` should be revisited
against them specifically (see that file's closing section).
