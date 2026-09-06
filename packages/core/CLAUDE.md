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

**11 test files, 197 tests, all passing** (`pnpm --filter @violin/core test`).

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

- `pnpm --filter @violin/core test` — run the full Vitest suite once (`vitest run`). Currently **10 test files, 169 tests**, all passing.
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
