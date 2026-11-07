# packages/core — CLAUDE.md

Shared, platform-agnostic TypeScript domain package for the violin practice
project: note/cents math, violin-specific string/scale data, the procedural
Playing Practice sequence generator, scoring (tolerance + dwell-time +
confidence gating), the three session state machines (Finger Tuner / Playing
Practice / Drilling) and their composition, Phase 6's practice-attempt
give-up-policy tracker, and the v1 persistence-port interfaces + in-memory
adapter. See the root `CLAUDE.md` for full product context and
`temp/PLAN-violin-practice-app.md` for the phased plan — this file
documents this package only.

**No dependency on `packages/dsp-native`.** This package is pure TypeScript,
consumed as source directly by `apps/desktop` and `apps/mobile` (no build
step). It defines its own `PitchReading` shape (`voiced`/`frequencyHz`/
`confidence`) that intentionally mirrors dsp-native's `PitchResult`, but
there is no code-level link between the two — a future platform-integration
phase is what actually wires a real detector's output into this package's
`PitchReading` shape.

## Status (Phase 2 complete; Finger Tuner display smoothing added in Phase 5; practice-attempt give-up policy added in Phase 6)

Phase 0 left this package as an empty stub (`clamp.ts` + its test, proving
the Vitest harness works — see "Leftover from Phase 0" below). Phase 2 (see
the plan's Phase 2 section) implemented all of the actual domain logic
described above. Phase 5 (Finger Tuner mode; this package's half of it —
see `apps/desktop/CLAUDE.md` for the desktop UI that consumes it, and note
that Phase 5's mobile half is a separate, not-yet-done task) added one more
module: `tuner/tuner-display-smoother.ts`'s `TunerDisplaySmoother`, a
stateful, vibrato-aware smoothing layer that sits on top of the stateless
`analyzeTunerReading` below — see "Finger Tuner display smoothing" under
"Session state machines" for why this needed to be a separate class rather
than a change to Finger Tuner itself.

Phase 6 (Playing Practice mode; this package's half of it — see
`apps/desktop/CLAUDE.md`'s "Playing Practice UI (Phase 6)" section for the
desktop UI that consumes it, and note the mobile half is a separate,
not-yet-done task) added `practice/practice-attempt-tracker.ts`'s
`PracticeAttemptTracker` — see "Practice attempt tracking" under "Session
state machines" below. This resolves the one gap `drilling.ts` and
`playing-practice.ts` each explicitly flagged in their own doc comments
(now updated to point here): deciding _when to give up_ and call a Playing
Practice / Drilling attempt a failure, from a live reading stream, was
deliberately left open as a "session/UI-orchestration policy" for a later
platform-integration phase — this is that phase, and per the plan's Hard
Rule 3 the policy is decided and documented in that module rather than
guessed independently per platform.

**29 test files, 895 tests, all passing** (`pnpm --filter @violin/core test`; 197 / 11 files through Phase 8, +179 for ABC notation practice and the staff display -- see "ABC notation" and "Staff notation" -- and +503 for ABC rhythm, tempo, the timed play-along and the rhythmic score notation: see "ABC rhythm, meter and tempo", "Timed play-along" and "Score notation").

Two correctness fixes made during Phase 2 verification, worth knowing about:

1. `parseNoteName` originally wrapped the accidental-adjusted pitch-class index
   into `[0, 11]` _before_ computing the MIDI number, which silently dropped the
   octave carry for flat-below-C / sharp-above-B spellings (e.g. `"Cb4"`
   resolved to `B4` instead of the correct `B3`). Fixed by computing `midi`
   directly from the raw (possibly `-1` or `12`) pitch-class index and letting
   `midiNumberToNoteName` derive the final canonical pitch class _and_ octave
   from that midi value — see `note/note.ts`'s inline comment at that line and
   `note/note.test.ts`'s "handles flat-wrapping below C / sharp-wrapping above
   B" case.
2. `DrillingMachine` originally started its round-robin cursor at a fixed
   `pool[0]`, which meant drilling opened on the neighbor _below_ the failed
   note (for interior notes) instead of the failed note itself. Fixed to start
   on the pool's `center` entry — see "Drilling" below for the reasoning.

**Explicitly not done here** (later phases, per the plan): no audio capture,
no pitch-detector implementation (that's `packages/dsp-native`), no UI, no
real persistence backend (disk/AsyncStorage/IndexedDB — v1 is in-memory only
by confirmed decision, see "Persistence" below).

## Architecture

```
src/
  index.ts                       Public API barrel -- every export below is
                                  re-exported here; this is what apps import.
  clamp.ts / clamp.test.ts        Leftover Phase 0 placeholder (see below).
  note/
    note.ts                       Hz <-> MIDI <-> note-name <-> cents. A4 is
                                   a parameter everywhere (default 440),
                                   never hardcoded past the default.
    note.test.ts
    violin-strings.ts             Open strings (G3/D4/A4/E5) + first-position
                                   / one-octave major-scale semitone offsets,
                                   sourced from a real fingering chart (see
                                   its own doc comment for citations).
    violin-strings.test.ts
  sequence/
    sequence-generator.ts         generatePlayingPracticeSequence() -- the
                                   procedural Playing Practice note pool.
    sequence-generator.test.ts
  scoring/
    scoring.ts                    Tolerance band, confidence/range gating,
                                   dwell-time tracking (TargetNoteDwellTracker).
    scoring.test.ts
  tuner/
    finger-tuner.ts                Finger Tuner: stateless per-reading analysis.
    finger-tuner.test.ts
    tuner-display-smoother.ts      TunerDisplaySmoother -- stateful, vibrato-aware
                                    smoothing layered on top of finger-tuner.ts's
                                    output, for UI display only (Phase 5).
    tuner-display-smoother.test.ts
  practice/
    drilling.ts                    Drilling state machine + drill-pool builder.
    drilling.test.ts
    playing-practice.ts            Playing Practice state machine.
    playing-practice.test.ts
    practice-session-controller.ts Composes the two into the single machine
                                    a UI actually drives (the PP<->Drilling
                                    hand-off).
    practice-session-controller.test.ts
    practice-attempt-tracker.ts    Phase 6: PracticeAttemptTracker -- composes
                                    TargetNoteDwellTracker with a give-up
                                    policy (manual skip + timeout) into the
                                    per-frame success/failure decision a UI
                                    actually needs. See "Practice attempt
                                    tracking" under "Session state machines".
    practice-attempt-tracker.test.ts  Also covers full-sequence integration
                                    with PracticeSessionController +
                                    generatePlayingPracticeSequence (see that
                                    section).
  abc/
    abc-parser.ts                  parseAbc() -- ABC notation text -> per-tune,
                                    per-voice MIDI pitch lists (key signatures,
                                    accidentals, ties, voices) AND rhythm: note
                                    lengths, rests, bars, meter, tempo, tuplets,
                                    beaming (see "ABC notation" and "ABC rhythm,
                                    meter and tempo").
    abc-parser.test.ts             77 tests (hand-derived expectations).
    abc-rhythm.test.ts             66 tests for the rhythm half of the parser and
                                    for the AbcPiece buildAbcPracticeSequence returns.
    abc-score.ts                   The score data contract (AbcScoreElement, AbcPiece,
                                    AbcMeter, AbcTempoMark, KeyOffsets) shared by the
                                    parser, the play-along engine and the notation
                                    layout; positions/durations in whole notes.
    abc-practice.ts                buildAbcPracticeSequence() -- a parsed tune ->
                                    SequenceNote[] + AbcPiece with range checking +
                                    transposition; abcTuneLabel/abcPracticeSummary
                                    shared UI text.
    abc-practice.test.ts
  play-along/
    play-along-plan.ts             buildPlayAlongPlan(): tempo + piece -> note onsets in
                                    ms, the metronome beat grid, count-in (see "Timed
                                    play-along").
    play-along-session.ts          PlayAlongSession: scores frames against the plan
                                    (in tune AND on time), per-note hit/miss + reason.
    play-along-summary.ts          Run summary + the wording both apps show.
    play-along-runner.ts           PlayAlongRunner: one whole run, headless -- clock,
                                    click scheduling, render-ready view, results text.
    click-scheduler.ts             Look-ahead scheduler for the audible click.
    count-in.ts                    countInBeatsForBars(): "N bars" -> clicks (pickups).
    test-support/                  Test-only piece builder + synthetic detector frames.
  notation/
    note-spelling.ts               NoteSpelling (letter + accidental + octave):
                                    how a note is *written*, so B-flat stays
                                    B-flat. spellMidi/transposeSpelling/etc.
    staff-glyphs.ts                GENERATED: Bravura glyph outlines (clef,
                                    accidentals, notehead) as SVG paths in
                                    staff-space units. Don't edit by hand.
    score-layout.ts                layoutScore()/sizeScore() -- the rhythmic score layout
                                    for ABC pieces: a flat draw list + playhead mapping
                                    (see "Score notation").
    score-accidentals.ts           Printed-music accidental rules + key signature signs.
    score-svg.ts                   scoreLayoutToSvg() -- SVG markup of a layout.
    staff-layout.ts                layoutStaff() -- pure treble-staff geometry
                                    (lines, ledger lines, heads, stems,
                                    accidentals) that both apps draw.
    *.test.ts                      note-spelling 15, staff-layout 31 tests.
  persistence/
    ports.ts                       SessionStore<T> / ProgressRepository
                                    interfaces (v1 persistence decision).
    in-memory.ts                   InMemorySessionStore / InMemoryProgressRepository.
                                    (No test file yet -- flagged below.)
```

### Leftover from Phase 0: `clamp.ts`

`clamp(value, min, max)` is the placeholder Phase 0 used to prove the
package's build/test harness worked before any real domain logic existed
(see its doc comment). It is still exported from `index.ts` but is **not
used anywhere** in this package's own domain logic (verified by grep) — it's
harmless dead weight, not a bug, but flagged here so it isn't mistaken for
load-bearing code. Fine to remove in a later cleanup pass if nobody ends up
needing a generic numeric clamp; not removed during Phase 2 verification
since deleting still-exported public API wasn't this phase's job to decide
unilaterally.

## Note/frequency utilities (`note/note.ts`)

Core conversions, all pure functions:

- `midiToFrequencyHz(midiNote, a4Hz = 440)` / `frequencyHzToMidi(frequencyHz, a4Hz)` — inverses; `midiNote` may be fractional.
- `frequencyToCents(frequencyHz, referenceHz)` — signed cents between two arbitrary frequencies (not tied to a named note).
- `midiNumberToNoteName(midiNumber)` — rounds to the nearest integer MIDI, returns a `NoteName` (`{ pitchClass, octave, midi, label }`). Sharps-only canonical spelling (`PITCH_CLASS_NAMES`, index 0 = C), matching `packages/dsp-native`'s convention independently (no shared code).
- `analyzeFrequency(frequencyHz, a4Hz)` / `centsOffNearestNote(...)` — "what note is this nearest to, and by how many cents" (nearest-note, not a specific target — see scoring's `centsOffTarget` for the target-note variant).
- `parseNoteName(name)` — parses scientific pitch notation (`"G3"`, `"Bb4"`, `"C#5"`); case-insensitive letter, `#`/`b` (lowercase only, to disambiguate from the `B` natural), signed octave. Flats canonicalize to their sharp spelling in the result. Returns `undefined` on anything that doesn't match `/^([A-Ga-g])([#b]?)(-?\d+)$/`. **Correctly carries the octave across `Cb`/`B#` wrapping** — see the Phase 2 fix noted above.
- `noteNameToFrequencyHz(name, a4Hz)` — convenience combining the above two.
- `describeFrequency(frequencyHz, a4Hz)` — human-readable `"A4 +3c"` / `"(no pitch)"` debug label.

`DEFAULT_A4_HZ = 440`. Every function that needs a reference pitch takes
`a4Hz` as an optional last argument defaulting to this constant — never
hardcode 440 elsewhere; some players/orchestras tune to A442.

## Violin string/position data (`note/violin-strings.ts`)

- `VIOLIN_STRING_ORDER: ['G', 'D', 'A', 'E']` — canonical low-to-high order used everywhere a fixed iteration order is needed.
- `OPEN_STRING_NOTE_NAMES` — `{ G: 'G3', D: 'D4', A: 'A4', E: 'E5' }`.
- `openStringNote(stringName)` / `openStringFrequencyHz(stringName, a4Hz?)` — the open string's `NoteName` / Hz (derived from `midiToFrequencyHz` at the configured `a4Hz`, not a hardcoded Hz table).
- `MAJOR_SCALE_SEMITONE_OFFSETS = [0,2,4,5,7,9,11,12]` — full one-octave major scale starting on the open string.
- `FIRST_POSITION_SEMITONE_OFFSETS = [0,2,4,5,7]` — the bottom 5 (root through perfect 5th) — the practical first-position range on one string without shifting.

Sourced from a real first-position fingering chart (Violin Lounge /
Violinspiration, cited in the module doc comment), checked 2026-09-05: each
string's first-position range is exactly the bottom half of that string's
own one-octave major scale. This module generates **pitches only**, not
fingerings/positions — it doesn't model which physical string a note is
played on beyond "which major scale this note came from."

## Procedural sequence generator (`sequence/sequence-generator.ts`)

`generatePlayingPracticeSequence(config?: SequenceGeneratorConfig): SequenceNote[]`
— the confirmed-procedural (not song-based) Playing Practice note pool.

```ts
interface SequenceGeneratorConfig {
  strings?: readonly ViolinStringName[]; // default: all 4, G/D/A/E
  patternType?: SequencePatternType; // default: 'stepwise-first-position'
  direction?: SequenceDirection; // default: 'ascending'
  a4Hz?: number; // default: 440
  minFrequencyHz?: number; // default: 150
  maxFrequencyHz?: number; // default: 1600
}
type SequencePatternType = 'open-strings' | 'stepwise-first-position' | 'one-octave-scale';
type SequenceDirection = 'ascending' | 'descending' | 'both';

interface SequenceNote {
  note: NoteName;
  frequencyHz: number; // at config's resolved a4Hz
  sourceString: ViolinStringName; // which string's pattern this came from
}
```

Behavior notes:

- **String ordering is always low-to-high** (G, D, A, E, filtered to whichever are included), regardless of the order given in `config.strings` — a documented, simple, easily-changed choice, not something the plan specifies.
- **Direction applies per-string, before strings are concatenated** — e.g. `strings: ['G','D'], direction: 'descending'` walks all of G's notes top-to-bottom, then all of D's.
- `'both'` ascends then descends **without repeating the turnaround note** (top of the pattern appears once).
- **Range filtering is applied last**, over the fully-assembled sequence, and _drops_ out-of-range notes rather than clamping them. A config whose range excludes every note returns `[]` rather than throwing. The min/max Hz defaults (150/1600) intentionally match `packages/dsp-native`'s `PitchDetectorConfig::ForViolin` search range, so the domain layer's default practice range never asks the user to play outside what Phase 1 empirically validated the detector against.
- Throws `RangeError` only on structurally invalid config: an empty `strings` array, or `minFrequencyHz > maxFrequencyHz`.
- **Judgment call, flagged (not the plan's own wording):** `'stepwise-first-position'` was implemented as the bounded root-through-perfect-5th scale walk on one string, not as an open-string/step call-and-response ear-training pattern (an alternative reading of "stepwise interval drills" that was considered and rejected — see the doc comment in `sequence-generator.ts` for the reasoning). Worth confirming this reading matches intent if it ever seems off in practice.

## Scoring (`scoring/scoring.ts`)

Three independent pieces, composable:

1. **`gateReading(reading, config?) => GateResult`** — the confidence +
   plausible-range gate shared by Finger Tuner and target-note scoring.
   Rejects (`{ ok: false }`) an unvoiced reading, a reading below
   `minConfidence`, or a frequency outside `[minFrequencyHz, maxFrequencyHz]`
   — **never guesses a note**. Callers decide separately whether to surface a
   rejection as "no signal" (unvoiced) vs. "unclear" (voiced but
   untrustworthy) — see `tuner/finger-tuner.ts`.
2. **`centsOffTarget(frequencyHz, targetFrequencyHz)` + `isWithinTolerance(cents, config?)`** — cents from a _specific_ target (distinct from `note.ts`'s `centsOffNearestNote`, which finds the nearest note in general).
3. **`TargetNoteDwellTracker`** — stateful, one instance per attempt at a target note. Feed it readings in timestamp order via `update(reading, timestampMs)`; it returns `true` exactly once, the instant the pitch has stayed continuously gated-ok-and-in-tolerance for `minDwellTimeMs`. Any gate failure or out-of-tolerance reading **resets the held-duration clock to zero** (strict continuity, not a cumulative-with-gaps average) — this is "arrived and held," not a forgiving running average. Once satisfied, `isSatisfied` is a **sticky latch**: it stays `true` even if the signal drops out afterward (releasing the bow at the end of a note shouldn't un-succeed it). Call `reset()` to reuse an instance for a new attempt.

Defaults and the reasoning behind each (all overridable via `ScoringConfig`/`DwellTrackerConfig`, none are locked constants):

| Constant                                                | Default    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_IN_TUNE_CENTS_TOLERANCE`                       | 25 cents   | Deliberately looser than professional-tuner precision (~1-2c) or the perceptual threshold (~5c) — this is a learning tool for beginners, not a tuner. Also has to absorb the pitch detector's own real-signal jitter or genuinely-in-tune notes will read as "out of tune." Phase 1's real-recording YIN numbers found 3.3-4.2c std-dev on D/A/E strings but 33-72c on G — 25c comfortably covers the easy strings but is a known, documented tension on G (not papered over; a future phase could special-case a wider G-string tolerance). |
| `DEFAULT_MIN_CONFIDENCE`                                | 0.5        | YIN (dsp-native's chosen primary detector) already internally gates `voiced` at a stricter threshold (confidence >= ~0.85) before ever reporting `voiced: true`. This package's 0.5 is a permissive extra safety margin for a _decoupled_ consumer (no dependency on dsp-native) that might in principle receive readings from a weaker-confidence source. Re-tune once a real detector is actually wired in (Phase 3+).                                                                                                                     |
| `DEFAULT_MIN_FREQUENCY_HZ` / `DEFAULT_MAX_FREQUENCY_HZ` | 150 / 1600 | Matches dsp-native's `PitchDetectorConfig::ForViolin` search range exactly — never treat as plausible a frequency Phase 1 didn't validate the detector against.                                                                                                                                                                                                                                                                                                                                                                              |
| `DEFAULT_MIN_DWELL_TIME_MS`                             | 150ms      | Guards against bow-attack transients / fast slides registering as a deliberately-played note. Layered _on top of_ (not replacing) dsp-native's `OnsetSegmenter`, which already requires ~35ms of pitch stability before confirming a note _onset_ at all — this dwell time answers "has the target been _held_ long enough," a longer, separate timescale. 150ms is comfortably longer than a transient/slide, comfortably shorter than any deliberately-held practice note.                                                                 |

## Session state machines

Every session-flow class in the package: Finger Tuner's stateless analysis
plus Phase 5's stateful display-smoothing wrapper, the Playing Practice and
Drilling state machines plus their Phase 2 composition, and Phase 6's
practice-attempt give-up-policy tracker:

### Finger Tuner (`tuner/finger-tuner.ts`) — stateless

`analyzeTunerReading(reading, config?) => FingerTunerReading` is a **pure
function** — no session concept, no target note, no memory between calls, so
a slide/portamento shows continuously rather than being debounced (per the
plan's edge cases). Output is one of three states, freshly derived from each
input:

- `{ status: 'no-signal' }` — unvoiced reading.
- `{ status: 'unclear' }` — voiced but failed the confidence/range gate (double-stop, background noise, etc. — never guesses a note).
- `{ status: 'reading', note, cents, inTune, frequencyHz }` — a trustworthy reading, with `inTune` from `isWithinTolerance`.

`FingerTuner` is just a thin class wrapping the function to hold `config`
across calls — "state machine" here means the small set of discrete
_output_ states, not literal instance memory.

### Finger Tuner display smoothing (`tuner/tuner-display-smoother.ts`) — stateful, vibrato-aware (Phase 5)

`analyzeTunerReading` above is deliberately stateless/per-reading — correct
for that layer, but a raw per-hop `FingerTunerReading` fed straight to a UI
has a real problem: violin vibrato oscillates pitch ~5-7Hz with ~10-30
cents of _intentional_ modulation, which reads as the tuner flickering
in/out of tune many times a second rather than as a stable held note.
`TunerDisplaySmoother` is a separate, stateful class that sits on top of
`analyzeTunerReading`'s output (consumes `FingerTunerReading`s, not raw
`PitchReading`s, so it never re-implements confidence/range gating) and
produces a `SmoothedTunerReading` (same three-state shape as
`FingerTunerReading` — `no-signal` / `unclear` / `reading`, deliberately,
so a UI can reuse one renderer for both) for "what should the UI show right
now."

```ts
new TunerDisplaySmoother(config?: TunerDisplaySmootherConfig)
  .update(reading: FingerTunerReading, timestampMs: number): SmoothedTunerReading
  .reset(): void
```

Design, in brief (full reasoning, including the sinc-attenuation math and
documented limitations, is in the module's own doc comment — read that
before changing any of the constants below):

- Internally tracks pitch as a continuous MIDI float (`frequencyHzToMidi`),
  not as cents-relative-to-the-instantaneous-nearest-note, and only
  re-derives note/cents from the _smoothed_ value at the end — avoids
  averaging cents measured against two different nearest-note references
  across a moment where vibrato straddles a semitone boundary.
- **Vibrato / normal jitter**: averaged with a plain boxcar moving average
  over a trailing `windowMs` window (default `DEFAULT_TUNER_SMOOTHING_WINDOW_MS`,
  120ms — biased toward the more-smoothing end of the plan's cited 50-130ms
  range, since the worst case for attenuation is the _slow_ end of the
  cited 5-7Hz vibrato range).
- **A genuine pitch change** (slide-to-a-new-note, or stop/start): detected
  when a new sample deviates from the _currently-displayed_ smoothed value
  by more than `transitionThresholdCents` (default
  `DEFAULT_TUNER_TRANSITION_THRESHOLD_CENTS`, 50c — above the cited max
  vibrato depth, below a semitone). On a transition, the window is
  discarded and restarted from just the new sample, so the display snaps
  immediately instead of being dragged toward the new pitch by stale
  pre-transition samples.
- `'no-signal'`/`'unclear'` pass through immediately, unsmoothed, and clear
  the window — every dropout (even a single transient one) resets, which is
  a deliberate simplicity choice (see the module doc comment's "Documented
  limitations"), not an oversight.
- Call `reset()` whenever a capture session (re)starts/stops so one
  session's tail doesn't bleed into the next — `apps/desktop`'s
  `renderer.ts` does this on every non-"running"/"self-test" capture state.

Pure TypeScript, zero DOM/Node/RN imports — written specifically so
`apps/mobile`'s own Finger Tuner UI (Phase 5's still-not-done mobile half)
can reuse this exact class rather than re-deriving its own smoothing.

**Judgment calls made here, flagged per this package's own convention of
recording them rather than silently deciding (none rise to
architecturally-significant — see the module doc comment for the full
tradeoff discussion in each case):** the 120ms default window (vs. the
cited range's 50ms-130ms midpoint); the 50c transition threshold (vs. the
cited ~30c max vibrato depth); a plain boxcar average (vs. a proper
low-pass filter); and resetting on _every_ unclear/no-signal frame rather
than debouncing brief transient dropouts. All four are exposed as
overridable config / are easy to revisit if real playing ever demonstrates
a problem with the defaults.

### Playing Practice (`practice/playing-practice.ts`) — `PlayingPracticeMachine`

States: `{ status: 'active', index, targetNote }` | `{ status: 'complete' }`.

- `reportOutcome('success' | 'failure')` — the _decision_ of success/failure is made elsewhere (a live reading stream through `TargetNoteDwellTracker`, or a give-up policy); this machine only reacts to the already-decided outcome.
  - `'success'` on a non-last note → `{ type: 'advanced', index: index+1, targetNote }`, and `state` reflects the new index.
  - `'success'` on the last note → `{ type: 'sequence-complete' }`, `state` becomes `complete`.
  - `'failure'` → `{ type: 'failed', failedIndex, drillPool }` (pool from `computeDrillPool`, see Drilling below). **The machine does NOT advance on failure** — it stays "paused" at `failedIndex`; repeated `reportOutcome('failure')` calls are idempotent. The caller (typically `PracticeSessionController`) is responsible for resuming.
- `resumeAt(index)` — jumps to an arbitrary index (used to hand control back after Drilling ends). An index `>= notes.length` resolves to `complete` rather than throwing — a drill that masters on the sequence's last note correctly ends the session. Throws `RangeError` on a negative index. Can re-enter a completed machine (this class doesn't own "start a new session" policy).
- Throws if constructed with an empty `notes` array, or if `reportOutcome` is called after the sequence is already complete.

### Drilling (`practice/drilling.ts`) — `computeDrillPool` + `DrillingMachine`

`computeDrillPool(notes, centerIndex)` builds the failed note's drill pool:
the note itself plus its **array-adjacent** neighbors (one index back, one
forward), clamped at the sequence boundaries — `[neighbor-below?, center,
neighbor-above?]`. "Array-adjacent" is deliberately what "immediate
scale-neighbor" means here (the generated sequence already lays the pool out
in scale order); the one documented edge case is a multi-string sequence's
string boundary, where the array-adjacent note can be the _other_ string's
first/last note rather than a musical neighbor.

`DrillingMachine` states: `active` (tracking `consecutiveCorrect` /
`attemptsUsed`) → one of three terminal outcomes, each reached via
`reportOutcome` or `skip()`. Once terminal, further calls throw.

- `reportOutcome('success' | 'failure')`:
  - Success increments `consecutiveCorrect`; **on reaching `requiredConsecutiveCorrect` (default 3), returns `{ type: 'mastered', resumeAtIndex }` immediately** — checked _before_ the attempt cap, so mastering and hitting the cap on the same attempt resolves as mastered.
  - Failure resets `consecutiveCorrect` to 0.
  - Otherwise, once `attemptsUsed` reaches `maxAttempts` (default 12 — the plan's explicit "unbounded drilling is a real UX edge case" requirement), returns `{ type: 'max-attempts-reached', resumeAtIndex }`.
  - Else returns `{ type: 'continue', nextNote, consecutiveCorrect, attemptsUsed }` and rotates `currentNote` to the next pool entry (round-robin via `cursor % pool.length`).
- `skip()` — **manual escape hatch**: ends drilling immediately regardless of progress, `{ type: 'skipped', resumeAtIndex }`. Does not count as an attempt.
- **`resumeAtIndex` is always `centerIndex + 1`** for all three terminal outcomes (mastered/capped/skipped) — a documented judgment call (see the class's own doc comment): re-testing the just-failed note immediately risks recreating the exact stuck-loop the plan warns about, so all exits hand control to the note _after_ the failed one.
- **Drilling opens on the failed note itself**, then round-robins through its neighbors (`center -> neighbor-above -> neighbor-below -> center -> ...` for an interior note; a boundary note with only one neighbor just alternates with it). Fixed post-Phase-2-verification: the cursor previously started at a fixed `pool[0]`, i.e. index 0 of `[neighbor-below?, center, neighbor-above?]` — for an interior failed note (the common case) that meant the neighbor _below_ was presented first and the actually-failed note only 2nd, which was an unexamined default (no "approach from below" pedagogy was ever documented as intentional), not a deliberate design. `drilling.test.ts`'s "opens on the failed note itself, then rotates..." test pins down the corrected behavior.

### Composition (`practice/practice-session-controller.ts`) — `PracticeSessionController`

The single state machine a UI actually drives — composes
`PlayingPracticeMachine` + `DrillingMachine` and implements the
Playing-Practice-<->-Drilling hand-off the plan describes. `state` is one of:

```ts
{
  mode: ('playing-practice', index, targetNote);
}
{
  mode: ('drilling',
    targetNote,
    consecutiveCorrect,
    attemptsUsed,
    requiredConsecutiveCorrect,
    maxAttempts);
}
{
  mode: 'complete';
}
```

- `reportOutcome('success' | 'failure')` — routes to whichever machine is
  active. A Playing Practice failure constructs a fresh `DrillingMachine`
  from `computeDrillPool` and switches `mode` to `'drilling'`. Any of
  Drilling's three terminal outcomes calls `playingPractice.resumeAt(result.resumeAtIndex)`
  and clears the drilling machine, switching back to `'playing-practice'`
  (or `'complete'`, if `resumeAtIndex` reached the end of the sequence — e.g.
  mastering/skipping a drill on the sequence's last note correctly completes
  the session rather than erroring). Throws if called after the session is
  already complete.
- `skipDrill()` — the manual escape hatch, only valid while `state.mode === 'drilling'`; throws otherwise (a caller should only enable this control while drilling is active).

Each of `PlayingPracticeMachine` and `DrillingMachine` remains independently
usable and independently tested — this controller is one opinionated
hand-off policy, not the only way to wire them together.

### Practice attempt tracking (`practice/practice-attempt-tracker.ts`) — `PracticeAttemptTracker` (Phase 6)

`drilling.ts` and `playing-practice.ts` both explicitly left one question
open in their own doc comments: `TargetNoteDwellTracker` (scoring.ts)
already answers "has the target been held in tune long enough to count as
a _success_", but nothing decided _when to give up_ and call an attempt a
_failure_ — both files named this "a session/UI-orchestration policy left
to the platform-integration phases that wire this up." Phase 6 is that
phase; per the plan's Hard Rule 3, the policy is decided and documented
here rather than guessed independently per platform (both files' doc
comments now point here instead of describing it as unresolved).

**The give-up policy** — two mechanisms, both on by default, either one
alone ends an attempt as a failure:

1. **A manual escape hatch** (`giveUp()`) — a "Having trouble? Skip this
   note" UI affordance, one level up the flow from `DrillingMachine.skip()`.
2. **An elapsed-time timeout** (`timeoutMs`, default
   `DEFAULT_ATTEMPT_TIMEOUT_MS` = 10 seconds), measured from this tracker's
   first `update()` call (i.e. from whenever the target note is presented
   and the caller starts feeding it frames), so a session can't hang
   forever if the user never plays and never touches the manual skip
   either. Ten seconds matches this package's established generous
   -defaults-for-beginners tone (see `DEFAULT_IN_TUNE_CENTS_TOLERANCE`'s own
   reasoning). Pass `timeoutMs: Number.POSITIVE_INFINITY` to disable it and
   rely on the manual skip alone. The clock deliberately keeps running
   through no-signal/unclear frames (a user who never plays should still
   eventually time out, rather than the session hanging) — see the
   module's own doc comment for the full reasoning on both points.

```ts
new PracticeAttemptTracker(targetFrequencyHz: number, config?: PracticeAttemptTrackerConfig)
  .update(reading: PitchReading, timestampMs: number): PracticeAttemptStatus
  .giveUp(): PracticeAttemptStatus
  .isDecided: boolean
  .reset(): void
```

`PracticeAttemptStatus` is `{ status: 'in-progress', heldMs, elapsedMs } |
{ status: 'succeeded' } | { status: 'failed', reason: 'timeout' | 'manual' }`
— exactly the "still trying / succeeded / should we call this a failure
now" answer a UI needs every frame. `PracticeAttemptTrackerConfig extends
DwellTrackerConfig`, so every one of scoring.ts's tolerance/confidence/
range/dwell-time overrides passes straight through to the internal
`TargetNoteDwellTracker` unchanged — one source of truth for those
defaults, not re-declared here.

Once decided (`succeeded` or `failed`), the result is a **sticky latch**,
matching `TargetNoteDwellTracker.isSatisfied`'s own convention: success
always wins over a `giveUp()` call that arrives after the fact (never
retroactively turned into a failure), and success is checked before the
timeout on the same frame (mirrors `DrillingMachine.reportOutcome`'s own
"mastery is checked before the attempt cap" precedent). One instance per
attempt at one target note, mirroring `TargetNoteDwellTracker`'s own
"one instance per attempt" convention (it owns exactly one internally) —
construct a fresh instance whenever the target note changes; `reset()`
exists for reusing an instance for a fresh attempt at the _same_ note.

**Not consumed by `PlayingPracticeMachine`/`PracticeSessionController`
directly** — those machines still only react to an already-decided
`reportOutcome('success' | 'failure')`, unchanged from Phase 2. A caller
(as of Phase 6, `apps/desktop`'s Playing Practice UI — see
`apps/desktop/CLAUDE.md`) feeds live readings through a
`PracticeAttemptTracker` per target note and calls `reportOutcome` with
whatever it decides. `apps/mobile`'s Playing Practice UI (a later,
not-yet-done phase) is expected to reuse this exact class rather than
re-deriving its own give-up policy, matching this package's existing
"written once, shared verbatim" pattern (`TunerDisplaySmoother` above is
the precedent for Finger Tuner).

Pure TypeScript, zero DOM/Node/React-Native imports, like every other
class in this package.

**Tests**: 24 unit tests in `practice-attempt-tracker.test.ts` (clean
success path incl. success-beats-timeout-on-the-same-frame; both give-up
paths, manual and timeout, incl. stickiness/idempotence; no-signal/unclear
passthrough that resets held progress without resetting or pausing the
attempt clock; `reset()`; config passthrough) plus 4 integration tests in
the same file exercising the realistic end-to-end usage pattern with
`generatePlayingPracticeSequence` + `PracticeSessionController`: walking a
full generated sequence start to finish on synthetic in-tune readings, a
failed first attempt handing off to Drilling and being walked to mastery
with the correct resume index, and confirming that changing the sequence
config (strings included, pattern type) visibly changes what feeds the
session.

## ABC notation (`abc/`) -- sheet-music practice, added after Phase 8

At the user's explicit request the app can also practice a piece of sheet
music, not only the procedural scale patterns: the user imports an ABC
notation file and practices its notes in order, "similar to scale or arpeggio
training." This is a **second sequence source** feeding the unchanged session
machinery -- `parseAbc` + `buildAbcPracticeSequence` produce the same
`SequenceNote[]` that `generatePlayingPracticeSequence` does, so scoring, the
give-up policy and the Drilling hand-off all apply to a tune exactly as to a
scale. (`SequenceNote.sourceString` became optional for this: it only means
something for generated notes, and nothing outside the generator read it.)

**`parseAbc(text): { tunes, warnings }`** (never throws) resolves everything
that decides _which pitch_ a written note is: note letter and case
(`C` = C4, `c` = C5), octave marks, `^ ^^ _ __ =`, accidental scope, the `K:`
key signature (all modes, `exp`/explicit accidentals, `HP`/`Hp`, `none`, in
the header and mid-tune via a `K:` line or `[K:...]`), ties (merged into one
note; an accidental carries through a tie), voices (`V:`, kept separate), and
multi-tune files. It deliberately does **not** keep rhythm: lengths, broken
rhythm and tuplets are consumed and discarded (nothing scores rhythm), rests
are dropped, grace notes/decorations/chord symbols/lyrics are skipped, and
repeats/voltas are recognized as bar lines but **not expanded** (notes play
once, as written).

Anything it cannot represent is reported in the tune's `warnings`, never
silently mis-parsed: chords/double stops (top note used -- the app is
monophonic), microtonal accidentals, `&` voice overlays (skipped), `m:` macros,
ties between different pitches, unterminated chords, characters it doesn't
understand, a missing/unknown key, a blank line splitting a tune (ABC ends a
tune at a blank line, so later music is reported rather than dropped).

**Judgment calls to know about:**

- _Accidental scope is per octave_ (`^F f` -> F#4 then plain F5), as in printed
  notation and in abcjs. The ABC 2.1 standard's own default
  (`%%propagate-accidentals pitch`, in a section it marks volatile) would carry
  the accidental to every octave. We follow the renderer most ABC sites use,
  since that is the sheet the player is looking at.
- _`K:D exp _b _e` means exactly those accidentals_ (the standard); abcjs
  ignores `exp` as deprecated and adds them to D major.
- Keys beyond seven sharps/flats read their letters through double accidentals
  (G# major: F## G# A# ...); abcjs re-spells these enharmonically. Purely
  theoretical keys; the standard behavior was chosen.

**Validation beyond the unit tests.** The 77 parser tests use hand-derived
expected pitches. Independently, the parser was cross-checked against `abcjs`
(the reference ABC library, run from a scratch directory, not a dependency) by
extracting sounding pitches from its generated MIDI: a hand-written corpus
plus ~4,000 randomly generated tunes across 47 key spellings with accidentals,
octave marks, rests, lengths and valid ties. Pitches were identical, except
where behavior differs on purpose (the `exp` and beyond-seven-sharps items
above), abcjs expands trills/rolls into extra notes, and ties between
_different_ pitches (invalid ABC; abcjs silently drops one of the notes, we keep
both and warn). On accidental scope abcjs agrees with this parser.

**`buildAbcPracticeSequence(tune, options)`** returns `ok | empty |
out-of-range`. A tune with any note below the violin's open G (G3) or above the
detector ceiling (default 1600Hz, same as the generator) is **refused as a
whole** with a count and, when a whole-octave shift would fit, a suggested
`transposeSemitones` -- it never silently drops notes, because a melody with
notes removed no longer matches the sheet. Many ABC files are written an octave
off from where a violinist expects them, hence the transpose control in both UIs.

**`PracticeAttemptTracker` option `requireReleaseFirst`** (new): a tune can ask
for the same pitch twice in a row, and a player still holding the note they
just got credit for would satisfy the next, identical target instantly. With
the option on, in-tune readings count as silence until the first frame that is
not an in-tune reading of the target (a gap, bow-change dropout, or another
pitch); the timeout clock still runs. Both UIs set it only when the previous
attempt _succeeded_ and the next target has the same pitch (never after a
failure, so Drilling reopening on the missed note is unaffected, and generated
scale sequences never trigger it). Whether a real bow change on a real violin
reliably produces a detectable release is **not verified** -- if it doesn't, a
repeated note will time out into Drilling, which the manual skip buttons can
always escape.

## ABC rhythm, meter and tempo (`abc/abc-score.ts`, the parser's second half)

The parser used to throw note lengths away ("nothing scores rhythm"). The timed
play-along changed that, so `parseAbc` now returns, per voice, a **score**
(`AbcVoice.score: AbcVoiceScore`) next to the pitch lists, and per tune the
header `meter`, `tempo` and `unitNoteLength`. The contract is
`abc/abc-score.ts`; read it before touching the parser, the play-along
engine or the notation layout.

- **Time is in whole notes** (quarter = 0.25, triplet eighth = 1/12), plain floats
  compared with `WHOLE_EPSILON`. `AbcScoreElement` is a time-ordered list:
  `note` (points back into `notes` by `noteIndex`; `start`, `duration`,
  `notated` = the written length before tuplet scaling, `beamedToPrevious`,
  `tuplet`, `bar`), `rest` (visible or `x`-invisible), `bar` (style, `after` = the
  bar it closes), and `key` / `meter` / `tempo` changes (the header values are
  emitted at position 0). Ties are summed into one note to play.
- **What it reads**: `L:` (header, inline `[L:]`, body line; ABC's default from the
  meter when absent), note lengths (`2 /2 3/2 / // 3/ /3`), broken rhythm
  (`> >> >>> < << <<<`, applied to rests too, and to the _last part_ of a tied
  note only), tuplets (`(3`, `(p:q:r`, ABC's default q incl. compound time),
  rests (`z x`, multi-bar `Z`/`X` expanded into one rest per bar with bar lines
  between, `y` = no time), chords (first note's length times the length after
  the bracket, as abcjs), grace notes (no time), `M:` (`4/4 C C| (2+3+2)/8
none`), `Q:` (`1/4=120`, text before/after, `ca.`, several lengths summed, old
  `C=120`, bare number = meter's 1/denominator note as abcjs does), mid-tune
  changes of all of these. Bar lines are classified (`single double final
repeat-start repeat-end repeat-both`); consecutive ones merge; leading and doubled
  ones never create empty bars; repeats and voltas are still **not expanded**.
- **Bars and pickup**: bars are numbered from 0; a first bar shorter than the
  meter is a pickup (`pickupWhole`), so the first full bar is bar 1. The parser
  warns about interior bars that do not add up to the meter (not next to
  repeat/double/final lines, not with a meter change, not without an `M:`) --
  usually a wrong note length or `L:`, which would misplace every note in the
  timed mode.
- **Beaming** follows the writer: a note with no space before it is
  `beamedToPrevious` (decorations, chord symbols, slurs do not break it; a space,
  bar line or line end does).
- `KeyElement.fifths` records the key signature's place on the circle of fifths
  for standard keys (`undefined` for `exp` / extra-accidental keys).
- **`buildAbcPracticeSequence(...).piece: AbcPiece`** pairs the practice notes with
  that score: `meter` (4/4 and `meterAssumed` when the file has none), `tempo` (the
  file's, or `defaultTempoMark`: 80 quarter notes per minute expressed in the
  meter's own beat, `tempoSource: 'default'`), `pickupWhole`, `barStartsWhole`,
  `keyAtStart`. A whole-octave transposition keeps the key signature; any other
  shift drops it (every altered note then carries its own sign).
- **Flat-aware labels**: `formatSpellingLabel` ("B♭4", "F♯5") and
  `spellMidiInKey(midi, keyOffsets)` (how a piece in this key writes a heard pitch)
  live in `notation/note-spelling.ts`; `abcPracticeSummary` and the range labels
  (`lowestLabel` / `highestLabel`) use them, so a B-flat is never shown as A#.

**Validation.** Beyond the 66 hand-derived tests, the rhythm was cross-checked
against `abcjs` (scratch directory, not a dependency): ~12,000 random tunes
mixing every feature above across 11 meters, three unit lengths and several
keys produced identical (pitch, start, duration) for every note, and all 25 example
files in `abc-music/` match too (the script compares each file's first tune; the six tunes of
`monti-czardas.abc` were split into one file each and match once their `|:`/`:|` signs are turned into
plain bar lines, because abcjs's MIDI expands repeats and this parser plays them once). The _intentional_
differences from abcjs: a rest
longer than a bar (abcjs clamps it to one bar; the standard says the literal
length), `(7` in compound time (abcjs uses 2, the standard 3), tuplets of mixed
note lengths (abcjs derives the group length from the first note; we multiply each
note by q/p), broken rhythm directly after a tuplet, grace notes (abcjs plays them
in time; we skip them), and chords (abcjs sounds every note; we keep the top).
Differential bugs this found and fixed: broken rhythm after a tie dotted the whole
tie instead of its last part.

## Timed play-along (`play-along/`)

The timed mode of ABC practice: a metronome keeps a tempo, the piece advances on
the beat, and every note must be played in tune **and** on time; missed notes are
listed at the end (no Drilling -- the clock cannot stop). The user chose this over
a metronome-only mode; the untimed "Wait for me" flow remains as an option.

- **`buildPlayAlongPlan(piece, {tempoBpm, countInBeats})`** is the tempo-aware
  timeline: `notes` (onset/end in ms, bar number, beat in bar, beat length), the
  metronome `beats` (count-in first; accents on beat 1; grid origin = the first
  full bar's downbeat, so a pickup piece clicks on the pickup note), `countInMs`,
  `totalMs`, and `msAtWhole` / `wholeAtMs` through tempo changes. `tempoBpm` is
  in the _piece's own beat unit_ (♩, ♩., ♪ ...) and scales every tempo mark by the
  same ratio -- the UI edits one number; the file is never touched.
- **`PlayAlongSession`** scores frames (`update(reading, timestampMs)`) against a
  plan. Read its module comment: the rules (strict-continuity runs like
  `TargetNoteDwellTracker`, a run's _start_ must be within `tol` of the beat after
  removing `detectionLagMs` + output latency, hits resolve immediately, early /
  late / wrong-pitch / not-played reasons, same-pitch leniency because bow changes
  are not reliably detectable) and the constants with their reasoning:
  tolerance = 0.4 of a beat clamped to 100-250 ms, dwell = 0.6 of the note clamped
  to 40-150 ms, **detection lag 60 ms (a reasoned estimate, not a measurement --
  tune it against the real instrument)**. Known limits are in the comment
  (lateness is only diagnosed up to tol + dwell after the beat; one sounding can
  credit two consecutive same-pitch notes on fast passages).
- **`PlayAlongRunner`** is one whole run with no platform in it: it picks
  `zeroMs = now + lead + countIn`, starts the **`ClickScheduler`** (look-ahead
  scheduling, so a jittery main thread never makes the click uneven; the platform
  only turns `atMs` into an audio time), forwards frames to the session, and
  `getView()` returns a render-ready `PlayAlongRunView` (count-in number, beat,
  tempo text, "Bar 3 of 16", a per-note state array whose identity changes only
  when a state does, flat-aware "Hearing B♭4 (+8c from target)", `signalLost` when
  no frame has arrived for 1.5 s, and the end-of-run summary). **Display time comes
  from the platform clock, scoring time from the frames' timestamps** (both in the
  same domain: epoch ms on desktop, `performance.now()` on mobile), so the
  count-in and playhead keep moving if the analysis stream stalls while nothing is
  silently scored as missed. `notesAtIndices` builds the "practice the missed
  notes" list; `countInBeatsForBars(piece, bars)` turns "one bar" into a click
  count (a pickup takes its own beats off so the player counts "1 2 3" and comes in
  on 4).
- **Tests**: plan 44, session 60 (a perfect player, late/early/wrong/silent
  players, short notes, repeated pitch, resets, overlap, frame ordering...; the
  session was also checked with 17 deliberate mutations, all caught), summary 27,
  runner 22, click scheduler 9, count-in 6.

## Staff notation (`notation/`) -- the "Staff" display for target notes

Both practice modes can show the target note on a treble-clef staff instead of
as a letter name (and ABC practice also previews the notes that follow, as many as fit).
This package owns everything platform-independent about that; each app only
draws the result.

- **`NoteSpelling`** (`{ letter, accidental, octave }`) is how a note is
  _written_. `NoteName` only has a sharps-only label ("A#4") and cannot tell
  B-flat from A-sharp -- which sit on different staff lines. The ABC parser
  keeps the written spelling (`AbcVoice.spellings`, parallel to `notes`),
  `buildAbcPracticeSequence` carries it onto `SequenceNote.spelling` (a whole-
  octave transposition keeps letter and accidental; any other shift re-spells
  with sharps), and `staffSpellingOf(note)` returns it or, for generated notes
  (which only come from sharp keys), the sharps-only spelling of the MIDI
  number. **Letter-name labels are unchanged** -- they still read "A#4" for a
  B-flat, a known inconsistency between the two displays on flat tunes.
- **`layoutStaff(notes)`** returns pure geometry in _staff spaces_ (one space =
  the gap between two lines; top line y=0, bottom y=4, y down): line positions,
  the clef, and for each note its head, stem (up below the middle line, always
  long enough to reach it), ledger lines, and accidental. No key signature is
  drawn: every sharp/flat/double accidental is written on its own note, which is
  unambiguous for a one-note-at-a-time display; naturals carry no sign. Every
  note is a filled quarter-style head (rhythm isn't scored). The vertical extent
  is fixed to cover everything from the open G up to the detector's G6 ceiling
  (tested across all of it), so the staff never changes height as the target
  moves; only a note beyond that extends it.
- **Full width.** `layoutStaff(notes, { minWidth })` makes the staff at least
  that wide (in staff spaces): the lines run the full width and the notes
  spread out (spacing capped at 8 spaces, so a short piece doesn't scatter)
  and are centered after the clef -- a single note sits in the middle. It
  never squeezes below the notes' natural width. **`sizeStaff(notes,
availableWidthPx, { maxHeightPx })`** is the shared sizing step both apps
  use to fill the screen edge to edge: it picks the pixel size of one staff
  space (aimed at ~30 spaces across, clamped to 8-40px, never taller than
  `maxHeightPx`) and, if the notes can't fit the width even so, shrinks the
  whole staff instead of overflowing.
- **Lookahead.** With `sizeStaff(..., { lookahead: true })` (ABC practice) the
  notes after the first are a _preview_: it draws the longest run that fits the
  width at natural spacing (never fewer than the target), left-aligned
  (`layoutStaff`'s `align: 'start'`) so the **target stays in the same place as
  the piece advances**, and exposes how many fit via `layout.notes.length`. A
  window fits a dozen or more, a phone about eight; the apps hand it up to 40
  notes to choose from. (The letter-mode "Next:" text line still names four.)
- **`staff-glyphs.ts`** is _generated_ from the Bravura music font (SMuFL
  reference font, SIL Open Font License 1.1; attribution in the file): outlines
  of the G clef, sharp, flat, natural, double sharp, double flat and notehead,
  divided into staff-space units. Embedding outlines (instead of using a music
  font or Unicode music symbols) makes the staff identical on every platform
  with nothing to install -- React Native cannot count on a music font at all.
  If a glyph needs changing, regenerate it from the font rather than editing
  paths by hand.

A small fix made along the way: key signatures with flats produced `-0` for
unaltered letters (`-Math.floor(0)`); harmless for pitch math but it leaked into
the spelling data, so it is now `0 - Math.floor(...)`.

## Score notation (`notation/score-*.ts`) -- real notation for ABC practice

The single-note staff above (`layoutStaff`) stays for Playing Practice: one note,
a sign on every altered note, no key signature. ABC practice shows a _piece_, so
it uses a second, richer layout built from the score contract in `abc/abc-score.ts`:
key signature, time signature, note values, rests, bar lines, beams, ties,
tuplets, and accidentals printed only where the key does not already imply them.
Same conventions (staff-space units, y down, top line 0), same embedded Bravura
outlines, no music font anywhere.

- **`layoutScore(piece, {firstBar, widthSpaces, showTimeSignature?, maxBars?, justify?})`**
  lays out as many consecutive bars from `firstBar` as fit `widthSpaces` (at least
  one; `overflow` says if even one did not) and returns `ScoreLayout`: a `viewBox`,
  the per-note positions (`notes`), `barLines`, `xForWhole(whole)` (the playhead
  mapping, piecewise linear and clamped to the window) and **`primitives`, a flat
  draw list** (`line` / `glyph` / `polygon` / `path` / `circle`, each tagged with a
  `part` and, where it belongs to a practice note, its `noteIndex`). Both apps
  draw that list and nothing else (SVG on desktop, `react-native-svg` on mobile),
  so geometry is decided and tested once. `sizeScore` picks the pixel size of a
  staff space from the available width and height (shrinking if one bar needs more
  room). `barIndexAtWhole` maps a playhead position to a bar. `scoreLayoutToSvg`
  turns a layout into SVG markup (numbers and fixed tags only; `data-note` on
  note parts so a UI can recolour a note without rebuilding the drawing).
- **Accidentals** (`score-accidentals.ts`, `computeDisplayAccidentals`): the key
  signature in force gives each letter's default; an accidental holds for the rest
  of its bar for that letter _and octave_; a note whose real pitch equals what is
  in force draws nothing, otherwise it draws its sign (a natural where the key
  sharpened or flattened it). No courtesy accidentals. A tie continuation never
  repeats a sign. Mid-tune key changes get cancelling naturals. Key signatures with
  a double accidental on a letter cannot be printed, so notes on that letter carry
  their own signs. `keySignatureGlyphs` gives the signs in the standard order and
  treble-clef positions.
- **Notation details**: values from `notated` (a triplet eighth is drawn as an
  eighth inside a tuplet mark), split into tied pieces when not a single value or
  when crossing a bar line (greedy, double-dotted allowed); beams join notes the
  writer beamed (no space) within a bar with no rest between, with sloped
  beams capped at 1/4, secondary beams and stubs, one stem direction per group;
  tuplet numbers (bracket when not beamed); ties curve opposite the stem; rest
  glyphs per value, whole-bar rests centred; bar lines in all six styles; a
  rest-only or invisible-rest bar still takes room. Windows are justified (bars
  stretched up to 1.3x so the window fills the width exactly; not the last window
  of a piece). **No time signature is printed when `piece.meterAssumed`** (printing
  an assumed 4/4 would invent notation); a real meter change later is still drawn.
- **Glyphs**: `staff-glyphs.ts` now holds 44 glyphs (note heads, flags, rests, time
  signature digits and C / cut-C, augmentation dot, tuplet digits besides the
  original clef / accidentals / head). It is **generated**, not edited:
  `scripts/generate-staff-glyphs.mjs --font Bravura.otf --metadata Bravura.json --out
src/notation/staff-glyphs.ts [--opentype <opentype.js module>]` (the font, its
  SMuFL metadata and `opentype.js` are inputs, not dependencies; a test pins the
  original seven glyphs byte for byte). `SMUFL_ANCHORS` / `SMUFL_ENGRAVING` expose the
  stem/flag anchors and engraving defaults the layout uses.
- **Known imperfections** (left as they are): beams over very large leaps get long
  stems (cost of the slope cap), whole notes sit left-aligned in their bar, the
  tuplet digits are Bravura's italic ones and look a little large, and the default
  view-box height is fixed so there is empty space above and below the staff
  (it grows only for extreme notes).
- **Tests**: layout 181, accidentals 31, SVG 15, glyphs 9, including a test that
  lays out every tune of every file in `abc-music/` at every bar (not only the first tune: `monti-czardas.abc` holds six). Verified by eye in a browser
  across all 15 key signatures, the time signatures, every note value and rest,
  beam shapes, tuplets, ties, ledger lines, bar lines and real tunes.

## Finger numbers (`notation/fingering.ts`, parser `!1!`..`!4!`)

ABC practice can show which violin finger plays each note (0 = open string, 1-4),
as a small digit over the note on the score and as a line ("Finger 2", "Open
string") under the letter name. **The numbers come only from the file**: which finger
plays a pitch depends on the position, and pieces shift, so the app never works one out
(a first-position suggestion existed briefly and was removed at the user's request). A
note the file leaves unmarked shows no number.

- The parser reads the standard fingering decorations `!0!`-`!4!`
  (and the old `+1+` style) before a note into `AbcVoice.fingers`, parallel to
  `notes` (`undefined` where none). Other digits (`!5!`) are ignored; a decoration
  before a rest belongs to the rest; a tied note keeps the first part's number; in a
  chord a member's number goes with the top note (an outer `!2![CE]` is used when
  the member has none). `buildAbcPracticeSequence` carries it on `SequenceNote.finger`
  -- **only when `transposeSemitones` is 0**: after a shift the notes sit on other
  strings, so the file's numbers no longer apply and none are shown.

`fingerMarkFor(note)` turns the file's number into a mark (`undefined` when there is none);
`fingerMarksOf(notes)` does it for a
whole piece; `describeFinger` gives the words. `layoutScore`/`sizeScore` take
`fingers` (marks indexed by practice note) and draw one digit per note (the italic
tuplet digit glyphs) above the staff, the head and any stem/beam, centred on the
head, with part `finger` and the note's `noteIndex` (so it
takes the note's state colour); it needs no horizontal room, so spacing and
`widthSpaces` are identical with or without. `PlayAlongRunView.targetNoteIndex` (new)
says which note `targetLabel` names, so the Letters display can show its finger.
Tests: `notation/fingering.test.ts` (16).

## Persistence (`persistence/ports.ts`, `persistence/in-memory.ts`)

Confirmed v1 decision (plan's "Confirmed architectural decisions" #2): **no
real persistence in v1.** These interfaces exist purely so a later,
out-of-plan phase can add a real backend (disk / AsyncStorage / IndexedDB /
electron-store) by writing one new adapter class, without touching call
sites.

```ts
interface SessionStore<T = SessionSnapshot> {
  save(sessionId: string, snapshot: T): Promise<void>;
  load(sessionId: string): Promise<T | undefined>;
  clear(sessionId: string): Promise<void>;
}
type SessionSnapshot = Record<string, unknown>; // deliberately loose -- no concrete UI session shape exists yet to pin it down against

interface ProgressRepository {
  recordAttempt(noteLabel: string, outcome: PracticeOutcome, timestampMs: number): Promise<void>;
  getProgress(noteLabel: string): Promise<ProgressEntry | undefined>;
  getAllProgress(): Promise<readonly ProgressEntry[]>;
  clearAll(): Promise<void>;
}
interface ProgressEntry {
  noteLabel: string;
  attempts: number;
  successes: number;
  lastPracticedAtMs: number;
}
```

Both interfaces are `Promise`-returning even though `InMemorySessionStore` /
`InMemoryProgressRepository` (the v1 adapters, backed by a plain `Map`)
resolve synchronously — a real backend will almost certainly be async, and a
sync interface now would force a breaking change at every call site later.
"In-memory" describes _durability_ (nothing survives process exit), not
behavior: within one instance's lifetime these hold and return real data, so
in-session features (e.g. a running streak) work correctly.

**Coverage gap, flagged (not one of Phase 2's explicitly-checked items, but worth knowing):** `persistence/in-memory.ts` has no dedicated test file. The two classes are simple `Map` wrappers, but they're currently exercised only incidentally (they aren't even consumed by the state machines above — nothing in this package wires progress-recording into `PracticeSessionController` yet, since that wiring is real-time session/UI policy per the plan, left to a later phase). Worth adding direct unit tests whenever a consumer first lands, if not sooner.

## Commands

From the repo root:

- `pnpm --filter @violin/core test` — run the full Vitest suite once (`vitest run`). Currently **29 test files, 895 tests**, all passing.
- `pnpm --filter @violin/core test:watch` — Vitest watch mode.
- `pnpm --filter @violin/core typecheck` — `tsc --noEmit`.
- `pnpm test` / `pnpm typecheck` / `pnpm lint` from the repo root also cover this package (via `pnpm -r --if-present`) alongside every other workspace package.

Or directly from this directory: `pnpm test`, `pnpm test:watch`, `pnpm typecheck`.

Test files, one per source module (co-located, `*.test.ts`):
`clamp.test.ts`, `note/note.test.ts`, `note/violin-strings.test.ts`,
`sequence/sequence-generator.test.ts`, `scoring/scoring.test.ts`,
`tuner/finger-tuner.test.ts`, `tuner/tuner-display-smoother.test.ts`,
`practice/drilling.test.ts`, `practice/playing-practice.test.ts`,
`practice/practice-session-controller.test.ts`.

## Code navigation: CodeGraph

This repo has a CodeGraph index at `../../.codegraph/` (see root
`CLAUDE.md`). Reach for `codegraph_explore` / `codegraph explore` before
grep/find when tracing how the state machines call into each other (e.g.
`PracticeSessionController.reportOutcome` -> `DrillingMachine.reportOutcome`
-> `PlayingPracticeMachine.resumeAt`) or how `SequenceNote`/`NoteName` flow
from the generator through scoring into the practice machines.
