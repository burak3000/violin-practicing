# Phase 1 results: YIN vs. MPM empirical bake-off

**Status: primary-algorithm decision made — YIN.** This document is the
"results doc" required by `temp/PLAN-violin-practice-app.md`'s Phase 1
scope; the plan file's own Solution Concept / provenance-note section has
been updated to point here with the outcome (see that file's "Phase 1
outcome" note). Regenerate the numbers below with `pnpm test:dsp-native`
(builds are gitignored; this file is a snapshot of one specific run,
committed so the reasoning is reviewable without rebuilding — re-run and
diff if you suspect drift after a code change).

Full methodology, config defaults, and code pointers: `CLAUDE.md` in this
directory. This file is the _decision_; that one is the _reference_.

## Run configuration

- Sample rate 44.1kHz, analysis frame 2048 samples (~46.4ms), hop 512
  samples (~11.6ms, 75% overlap).
- Pitch search range 150-1600 Hz (covers the violin's practical G3-~D6
  range with margin on both ends).
- YIN absolute threshold 0.15; MPM peak-picking clarity threshold 0.93
  (both are the de-facto standard defaults from their respective papers).
- Harmonicity gate (HNR, Boersma 1993 formula) at 0 dB — a frame is only
  "confirmed voiced" if its detector says voiced _and_ periodic energy at
  the reported period is at least equal to non-periodic energy.
- Full run: 68 synthetic fixtures (64 chromatic G3-D6 sine+sawtooth, 4
  adversarial weak-fundamental) + 6 real University-of-Iowa recordings
  (~230s of real violin audio) + 0 user-violin recordings (pending tier,
  see `test/fixtures/user-violin/README.md`).
- `ctest` run: both tests pass (`generate_synthetic_fixtures`,
  `dsp_native_validation_harness`), total harness time ~30s.

## 1. Synthetic accuracy (exact ground truth)

Mean absolute cents error, aggregated across all 32 chromatic notes (G3-D6)
per waveform:

| Waveform                                               | YIN mean\|cents\| | MPM mean\|cents\| | Octave errors (either algo) |
| ------------------------------------------------------ | ----------------: | ----------------: | --------------------------: |
| Sine                                                   |              0.13 |          **0.01** |                       0 / 0 |
| Sawtooth                                               |              0.65 |              0.63 |                       0 / 0 |
| Adversarial weak-fundamental (4 notes: A4, E5, A5, D6) |              0.72 |              0.74 |                       0 / 0 |

Explicit hardest-case call-outs the plan asked for:

| Note                                                | Waveform | YIN mean\|cents\| | MPM mean\|cents\| |
| --------------------------------------------------- | -------- | ----------------: | ----------------: |
| G3 (196 Hz, lowest string, longest period)          | sine     |             0.027 |             0.016 |
| G3                                                  | sawtooth |             0.021 |         **0.007** |
| D6 (1175 Hz, highest note, harmonic-dense sawtooth) | sine     |             0.207 |         **0.009** |
| D6                                                  | sawtooth |         **0.506** |             0.798 |

**Reading this:** on clean synthetic signal, MPM is consistently a hair
more accurate than YIN (fractions of a cent) except on the highest sawtooth
note, where YIN is actually better (0.51c vs 0.80c) — and _both_ are
roughly two orders of magnitude below the ~5-cent threshold generally cited
as the smallest pitch difference an average listener can reliably perceive.
**Neither algorithm produced a single octave error on any synthetic fixture,
including the four adversarial ones built specifically to bait an
octave-up error** (fundamental deliberately attenuated to 20% amplitude
against a natural sawtooth harmonic series, so the 2nd harmonic is ~2.5x
louder than the true fundamental). This means the specific hypothesis behind
MPM's violin-relevant citations — that a weak-fundamental/harmonic-rich
signal would cause YIN-style octave errors that MPM's peak-picking resists —
**did not differentiate the two algorithms on synthetic signal**: both
handled it cleanly. Synthetic accuracy alone does not settle the primary
choice; it rules out neither.

## 2. Real recordings (University of Iowa, no exact ground truth)

Per-file, using the harmonicity-gated voiced stream (raw/pre-gate numbers
are in `test/results/iowa_results.csv` for comparison — the gate makes at
most a few points of difference in voiced-frame count, doesn't change the
qualitative picture below):

| File                                                                                                    | Algo    | Voiced % | In-range % (of voiced) | Octave-err % (of voiced) | Onsets | Mean within-note stddev (cents) |
| ------------------------------------------------------------------------------------------------------- | ------- | -------: | ---------------------: | -----------------------: | -----: | ------------------------------: |
| G3B3 mf (G string)                                                                                      | YIN     |     48.2 |                   80.2 |                  **0.0** |      7 |                        **71.6** |
|                                                                                                         | MPM     |     44.5 |                   93.7 |                      0.1 |      5 |                           110.1 |
| G3B3 pp (G string, quiet)                                                                               | YIN     |     45.6 |                   77.9 |                  **0.0** |      8 |                            33.4 |
|                                                                                                         | MPM     |     29.4 |                   66.2 |                      0.0 |      6 |                            42.1 |
| D4B4 mf (D string)                                                                                      | YIN     | **46.2** |                  100.0 |                  **0.0** |     14 |                         **3.3** |
|                                                                                                         | MPM     |     39.8 |                   99.6 |                      0.2 |     10 |                            60.9 |
| A4B4 mf (A string)                                                                                      | YIN     | **64.9** |                   99.7 |                  **0.0** |      4 |                             3.4 |
|                                                                                                         | MPM     |     64.6 |                   99.4 |                      0.5 |      4 |                             3.4 |
| E5B5 mf (E string)                                                                                      | YIN     | **53.3** |                   99.9 |                  **0.0** |     13 |                         **4.2** |
|                                                                                                         | MPM     |     35.2 |                   97.6 |                      2.1 |      9 |                           228.7 |
| C7E7 ff (E string, extreme high — beyond the 1600Hz search ceiling, see `test/fixtures/iowa/README.md`) | YIN     |     17.1 |                   0.0† |                     59.1 |      5 |                             8.0 |
|                                                                                                         | MPM     |     15.8 |                   0.0† |                     60.4 |      5 |                           101.7 |
| **Aggregate (all 6 files)**                                                                             | **YIN** | **47.6** |               **91.0** |                 **1.78** |      — |                       **20.66** |
|                                                                                                         | **MPM** |     38.9 |                   91.1 |                     2.61 |      — |                           91.16 |

† C7E7's content (~2093-2637 Hz) is entirely above this package's
configured 1600 Hz search ceiling — see the caveat in
`test/fixtures/iowa/README.md`. 0% in-range is expected/structural here,
not a tracking failure; both algorithms are equally hampered by the same
cap, so this row measures _graceful degradation_, not accuracy. The nonzero
octave-error rate here means, of the frames each algorithm _did_ report a
confident pitch for, most landed implausibly outside even a generous octave
band around the (unreachable) true range — i.e. both algorithms, when
pushed past their designed range, degrade into occasional wrong-octave
guesses rather than refusing to answer. Neither crashed or produced NaNs.

**Reading this:** this is where the two algorithms actually separate, and
the direction is the opposite of what the plan's citations predicted:

- **YIN reports a pitch more often** (47.6% vs. 38.9% of frames, aggregate) —
  on every single file, YIN's voiced-frame count is equal to or higher
  than MPM's, sometimes by a wide margin (E5B5: 53.3% vs. 35.2%; pp.G3B3:
  45.6% vs. 29.4%).
- **In-range plausibility is a near-tie** (91.0% vs. 91.1% aggregate) — when
  both algorithms _do_ commit to a pitch, they're about equally likely to
  be in the right ballpark.
- **YIN has fewer octave errors on real audio** (1.78% vs. 2.61% aggregate;
  YIN is exactly 0.0% on every non-extreme-range file, MPM has small but
  consistently nonzero rates on 4 of 5). This is the opposite of the a
  priori hypothesis in `temp/PLAN-violin-practice-app.md` (MPM's citations
  specifically claimed octave-error resistance on high-harmonic-content
  signal like a bowed string) — on _this_ real dataset, that advantage did
  not materialize.
- **YIN is dramatically more stable within a single held note on the D, A,
  and E strings** (D4B4: 3.3 vs. 60.9 cents; A4B4: 3.4 vs. 3.4, tied;
  E5B5: 4.2 vs. **228.7** cents). 60-229 cents of within-note jitter is on
  the order of a semitone or more of wobble in what a human would perceive
  as one held note — that would read as a visibly shaky, untrustworthy
  Finger Tuner display; YIN's 3-4 cents on those same files is
  imperceptible. **On the G string specifically, both algorithms are
  noticeably less stable than elsewhere** (YIN 33.4-71.6 cents, MPM
  42.1-110.1 cents) — expected, since the lowest string's longer periods
  leave the least margin inside a 2048-sample window — but YIN still comes
  out ahead there too, by roughly 1.3-1.5x rather than the ~4x-50x gap seen
  on the other three strings. Aggregated across all six files: 20.66 vs.
  91.16 cents (MPM ~4.4x jumpier overall).

## 3. Timing (real-time budget check)

| Algorithm | n (detect() calls) |     Mean |   Median |      p95 |      p99 |        Max |
| --------- | -----------------: | -------: | -------: | -------: | -------: | ---------: |
| YIN       |             28,284 | 510.7 us | 501.0 us | 550.1 us | 609.3 us | 6581.6 us* |
| MPM       |             28,284 | 523.7 us | 512.9 us | 566.8 us | 629.1 us | 5017.8 us* |

\* single-frame outliers (almost certainly OS scheduling jitter on this
shared dev machine, not algorithmic) — p99 for both is well under 1ms,
so these maxima aren't representative.

**Reading this:** both algorithms take ~0.5ms per 2048-sample frame —
about **4.4% of the 11.6ms hop interval** and about 1% of the 46.4ms
analysis window itself. Both clear the real-time budget with enormous
margin; this is not a differentiator. MPM is ~2.5% slower than YIN on
mean, which is real but practically irrelevant at these absolute magnitudes
(a full order of magnitude of extra safety margin would still leave both
comfortably real-time).

## Decision: YIN is primary

Per `temp/PLAN-violin-practice-app.md`'s instruction, this is decided from
the numbers above, not from the literature review that motivated testing
MPM in the first place:

- Synthetic accuracy is a near-tie (both far below perceptual relevance)
  and does not favor either algorithm strongly enough to decide anything on
  its own.
- On real acoustic violin recordings — the condition that actually matters
  for this app — **YIN reports a pitch more often, has fewer octave errors,
  and is dramatically more stable within a held note** than MPM. The
  stability gap in particular (up to ~4.4x on aggregate, and as much as
  ~50x on the worst individual file) is large enough to be a real,
  user-visible quality difference for a continuous-feedback Finger Tuner,
  not noise.
- Compute cost is a rounding error either way (both ~0.5ms against an
  11.6ms hop budget); it does not factor into the decision.

**MPM is not recommended as an always-on cross-check for octave-error
rejection.** The plan's proposed rationale for keeping it — resistance to
octave errors on high-harmonic-content signal — is exactly the property
that did _not_ show up in MPM's favor on real recordings (it had _more_
octave errors than YIN there, not fewer), so paying MPM's extra ~2.5%
compute for that specific benefit isn't empirically justified by this data.
`MpmDetector` stays in the codebase (fully implemented, tested, sharing
`PitchDetectorConfig`/`PitchResult` with `YinDetector` — see `CLAUDE.md`) so
it's available to re-test cheaply, not deleted.

### What would change this recommendation

This decision is made from synthetic tones and University-of-Iowa
**acoustic** recordings only — the user-violin tier
(`test/fixtures/user-violin/`) is still pending real input (see that
directory's README) and is explicitly the one condition the original MPM
citations were about: a **piezo pickup's** documented "top-heavy" harmonic
coloration, not a microphone recording of an acoustic instrument. Acoustic
and piezo signals are not guaranteed to behave the same way here. Once real
HVPV-30 recordings exist, re-run `pnpm test:dsp-native` and specifically
check `test/results/user_violin_results.csv`'s octave-error and
within-note-stability columns for YIN vs. MPM before treating this decision
as final for the shipped app. If MPM shows a real, repeatable advantage on
piezo audio specifically, it's worth re-opening this call — but that's a
new empirical finding to make then, not a guess to make now.
