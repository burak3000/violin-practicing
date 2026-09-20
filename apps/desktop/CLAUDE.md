# apps/desktop — CLAUDE.md

Electron desktop app for the violin practice project. See the root `CLAUDE.md` for full product context (what the app is, hardware reality, priorities) and `temp/PLAN-violin-practice-app.md` for the phased implementation plan — this file only documents this package.

## Status (Phase 3 complete; DSP code promoted out in Phase 4; Finger Tuner UI in Phase 5; Playing Practice UI in Phase 6; Drilling UI in Phase 7; eager-boot/device-unplug polish in Phase 8; multichannel-input + worklet-clock fixes from the first real-hardware test, 2026-09-15)

Phase 0 left this as a placeholder window. Phase 3 (see the plan's Phase 3 section) built the full capture -> DSP -> `packages/core` pipeline:

- Input-device enumeration + microphone-permission flow (`src/audio/device-enumeration.ts`).
- `getUserMedia` capture with `echoCancellation`/`noiseSuppression`/`autoGainControl` explicitly `false` (`src/audio/capture-pipeline.ts`).
- A **pure-TypeScript port** of `packages/dsp-native`'s validated YIN pipeline (YIN detector, harmonicity/HNR gate, onset/silence segmentation), running inside a real `AudioWorkletProcessor` (`src/audio/pitch-worklet-processor.ts`). See "DSP binding decision" below for why this is a TS port rather than a WASM/Node-addon binding to the C++ — this was **not** a default/lazy choice, it was made in view of the AudioWorklet-scope constraint and verified empirically (numbers below).
- Sustained input-gain-clipping detection and RMS-based silence/"no signal" detection, reusing `packages/dsp-native`'s validated `-50dBFS` silence gate via the onset segmenter port.
- Each analysis hop wired into `packages/core`'s `PitchReading` shape and fed through `analyzeTunerReading` (`src/renderer.ts`).

**Phase 4 update:** the TS DSP pipeline itself (everything that used to live at `src/dsp/*.ts`) was **promoted out of this app into a new shared package, `packages/dsp-ts`**, so `apps/mobile` could reuse the exact same validated code instead of independently re-porting the algorithm a second time. This app now imports it as `@violin/dsp-ts` (a normal workspace dependency) instead of a local relative path. This was a mechanical move — same code, same tests (all 37 re-run and re-passing from the new location), same behavior — not a rewrite or a re-litigation of the DSP-binding decision below, which still fully applies. See `packages/dsp-ts/CLAUDE.md` for the package itself, and "TypeScript project split" below for how the worklet-scope safety guarantee (no DOM/Node in the DSP code) survived the move.

**Phase 5 update (this app's half of Finger Tuner mode — the mobile half is a separate, not-yet-done task): the Phase 3 debug UI was replaced with a real Finger Tuner UI.** `src/renderer.ts`/`index.html`/`index.css` were rewritten; the capture/DSP pipeline files above were **not touched at all** (same `AudioCaptureController`, same `@violin/dsp-ts` pipeline, same `analyzeTunerReading` call). New this phase: `packages/core` gained a stateful, vibrato-aware `TunerDisplaySmoother` (see `packages/core/CLAUDE.md`'s "Finger Tuner display smoothing" section for its design), and this app's renderer now feeds every hop's raw `FingerTunerReading` through one shared `TunerDisplaySmoother` instance before it reaches the primary display, rather than showing raw per-hop output directly. See "Finger Tuner UI (Phase 5)" below for the full writeup of what the UI looks like and how it's wired.

**Phase 6 update (this app's half of Playing Practice mode — the mobile half is a separate, not-yet-done task): a second mode was added alongside Finger Tuner, sharing the same capture pipeline.** New file `src/playing-practice-ui.ts`; `renderer.ts`/`index.html`/`index.css` gained a mode-switcher and the Playing Practice section but Finger Tuner's own code/markup/behavior is otherwise untouched. New this phase in `packages/core`: `PracticeAttemptTracker`, resolving the give-up-policy gap `drilling.ts`/`playing-practice.ts` deliberately left open (see `packages/core/CLAUDE.md`'s "Practice attempt tracking" section). Phase 6 deliberately left `PracticeSessionController.state.mode === 'drilling'` as a minimal, honest placeholder (see "Drilling UI (Phase 7)" below for what replaced it and exactly what that placeholder used to look like).

**Phase 7 update (this app's half of the Drilling submode — the mobile half, Part B, is a separate, not-yet-done task): the Phase 6 Drilling placeholder was replaced with a real Drilling UI, entirely within `src/playing-practice-ui.ts` plus additive `index.html`/`index.css` markup.** `packages/core`'s `DrillingMachine` (Phase 2) was not touched — this phase is UI wiring on top of already-implemented, already-tested domain logic, per its scope. See "Drilling UI (Phase 7)" below for the full writeup: live scoring feedback and the dwell-progress bar are reused verbatim from Playing Practice's own attempt scoring (not re-derived), the existing progress line now also carries Drilling's "N of M correct in a row / attempt A of B" counters, a new "Skip this drill" button wires `DrillingMachine.skip()`, and mastery/max-attempts-reached each get a brief, differently-toned banner reusing the same element as Playing Practice's own "Nice!" flow.

**Phase 8 update:** this app's capture layer is now eager at boot rather than fully lazy on the first Start click. `src/renderer.ts` requests microphone permission and enumerates input devices during launch, while `src/audio/capture-pipeline.ts` exposes `prepare()` and now preloads a suspended `AudioContext` + worklet module for reuse by the first real session or self-test instead of paying that cost on demand. The same Phase 8 pass also explicitly re-assessed the existing `MediaStreamTrack` `ended` device-unplug path against the plan's app-level bar ("visible error state, no silent fallback, no stuck running UI") and kept it: for desktop's current scope, it already does the right thing without inventing a second, parallel unplug detector.

**Explicitly not done here** (later phases, per the plan): no persistence wiring, no cross-platform conformance suite inside this package, and no richer reconnect workflow beyond the now-confirmed visible "Input device disconnected." error state (e.g. a dedicated reconnect button or auto-retry flow).

**What's verified vs. what still needs the user** — see "Verification" near the end of this file. Short version: the DSP algorithm itself, the buffering/composition logic, and the wiring into `packages/core` are all verified programmatically (Vitest, against synthetic tones, comparable to Phase 1's own numbers) — as of Phase 4, from `packages/dsp-ts`'s own test suite rather than a local one, re-confirmed against this app after the move. The app builds, typechecks, and boots (both `pnpm start` and a full `pnpm package`) without errors — re-verified after the Phase 4 import-path change specifically because that's exactly the kind of thing the "Vite worklet-loading gotcha" below already proved can break silently. **Real microphone/line-in capture with a real signal has not been exercised** — that needs a human running the packaged app.

## Architecture

```
apps/desktop/
  src/
    main.ts                       Electron main process. Phase 3 addition: session
                                   permission handlers so getUserMedia's 'media'
                                   permission request is actually granted (Electron
                                   denies all permission requests by default).
    preload.ts                    Still empty -- no IPC needed yet (everything Phase 3
                                   needs, getUserMedia/AudioContext/AudioWorklet, is a
                                   normal renderer-side Web API, no main-process bridge
                                   required).
    renderer.ts                   Phase 5: the real Finger Tuner UI. Wires
                                   device-enumeration.ts + capture-pipeline.ts +
                                   packages/core's analyzeTunerReading +
                                   TunerDisplaySmoother together, updates
                                   index.html's DOM directly (no framework --
                                   still true post-Phase-5, a framework was not
                                   judged necessary for this UI's complexity).
                                   Phase 8 added eager boot wiring here:
                                   permission/device enumeration now runs on
                                   launch, and the AudioCaptureController's
                                   new prepare() path is called up front so the
                                   first Start/self-test click reuses a warmed
                                   audio engine. See "Finger Tuner UI (Phase
                                   5)" below and the Phase 8 status note above.
    index.css / index.html        Phase 5: the Finger Tuner's markup/styling
                                   (note/cents display, in-tune meter, tri-state
                                   coloring, collapsible debug panel) -- see
                                   "Finger Tuner UI (Phase 5)" below. Phase 6
                                   added the mode-tabs nav and the Playing
                                   Practice section/styling alongside it.
    playing-practice-ui.ts        Phase 6: PlayingPracticeUi -- the Playing
                                   Practice mode's whole lifecycle (config ->
                                   sequence -> PracticeSessionController ->
                                   per-note PracticeAttemptTracker scoring).
                                   Phase 7 extended the same class with a
                                   real Drilling UI for
                                   state.mode === 'drilling' (previously a
                                   placeholder) -- reusing, not duplicating,
                                   Playing Practice's own live-feedback/
                                   dwell-bar/success-banner rendering. See
                                   "Playing Practice UI (Phase 6)" and
                                   "Drilling UI (Phase 7)" below.

    (no local dsp/ directory anymore -- see "Phase 4 update" above. The
     pure, dependency-free TypeScript port of packages/dsp-native's
     validated pipeline that used to live at src/dsp/*.ts now lives in
     ../../packages/dsp-ts/src/, imported here as `@violin/dsp-ts`. See
     packages/dsp-ts/CLAUDE.md for that package's own architecture
     breakdown -- pitch-types.ts, yin-detector.ts, onset-detector.ts,
     harmonicity.ts, clip-detector.ts, hop-buffer.ts, pitch-pipeline.ts,
     index.ts, test-support/, and all 37 tests, all identical in content
     to what used to be documented in this section.)

    audio/                         Platform/browser-API glue -- main-thread code except
                                   pitch-worklet-processor.ts, which runs in the worklet.
      audioworklet-globals.d.ts      Ambient types for AudioWorkletGlobalScope
                                     (registerProcessor, sampleRate, currentTime,
                                     performance, a minimal MessagePort). See "TypeScript
                                     project split" below for why this is a SEPARATE
                                     tsconfig project, not part of the main one.
      pitch-worklet-processor.ts     The actual AudioWorkletProcessor subclass. Buffers
                                     input via HopBuffer, runs PitchAnalysisPipeline per
                                     hop, posts a WorkletAnalysisMessage back to the main
                                     thread. Zero DOM/Node dependency, by construction.
      worklet-messages.ts             WorkletAnalysisMessage shape + PITCH_PROCESSOR_NAME
                                     constant, shared between the worklet file and
                                     capture-pipeline.ts (they can't share a normal
                                     import the way most modules do, since they live in
                                     different tsconfig "projects" -- this file is
                                     included in both).
      device-enumeration.ts           requestMicPermissionAndListInputDevices() -- task
                                     point 1. Requests a momentary generic-audio
                                     permission (to unlock device labels), enumerates
                                     `audioinput` devices, never throws (every failure
                                     path resolves to a typed `{ ok: false, error, message }`).
      capture-pipeline.ts             AudioCaptureController -- owns the live Web Audio
                                     graph (AudioContext + MediaStreamSource-or-
                                     OscillatorNode -> AudioWorkletNode -> muted GainNode
                                     -> destination). Phase 8 added prepare(),
                                     which preloads a suspended AudioContext +
                                     worklet module for later reuse, and kept
                                     the existing MediaStreamTrack `ended`
                                     transition as the desktop-side device-
                                     unplug path after explicitly reviewing it
                                     against the plan's hardware edge cases.
                                     See "Vite worklet-loading gotcha" and
                                     "The mute-gain requirement" below for two
                                     other non-obvious things this file works
                                     around.

  tsconfig.json                  Main project. Adds "DOM"/"DOM.Iterable" to the shared
                                 root's ES2022-only lib (needed for navigator/document/
                                 AudioContext/etc.) -- packages/core and
                                 packages/dsp-native never needed this. Excludes the
                                 worklet-scope files (see below).
  tsconfig.worklet.json          Second project, no DOM lib, no auto-included @types/*
                                 packages -- typechecks pitch-worklet-processor.ts (and,
                                 transitively, everything it imports from
                                 @violin/dsp-ts -- TypeScript pulls an imported
                                 package's actual source into the SAME compilation
                                 program as whatever imports it, so this restricted
                                 lib/types config still applies to packages/dsp-ts's
                                 code even though it no longer lives under this app's
                                 own src/dsp/ path; verified directly during Phase 4's
                                 promotion via `tsc --noEmit -p tsconfig.worklet.json
                                 --listFiles`) against ONLY audioworklet-globals.d.ts's
                                 ambient surface. This is the compiler enforcement of
                                 the AudioWorklet-scope constraint -- see "TypeScript
                                 project split" below. (Phase 4: this file's own
                                 "include" list no longer needs to name
                                 packages/dsp-ts's files explicitly -- only this app's
                                 own two worklet-scope files are roots; dsp-ts's
                                 source is pulled in transitively, as above.)
  (no vitest.config.ts anymore -- see "Commands" below: this app has no
   test files of its own since Phase 4 moved everything under src/dsp/
   into packages/dsp-ts, so there's nothing left here for Vitest to run.)
  vite.renderer.config.ts        No custom config needed (see its own comment) -- the
                                 worklet loads via a `?worker&url` import, not a manual
                                 Rollup entry. Read this file's comment before touching
                                 it; a manual-entry approach was tried first and does
                                 NOT work correctly for a packaged build (see "Vite
                                 worklet-loading gotcha").
  forge.config.ts                Phase 3 addition: packagerConfig.extendInfo sets
                                 NSMicrophoneUsageDescription (macOS Info.plist) --
                                 required before macOS will even show the mic-permission
                                 prompt.
```

## Finger Tuner UI (Phase 5)

This phase's job was narrowly scoped: replace the Phase 3 debug UI with a
real, usable Finger Tuner, **without touching the capture/DSP pipeline
underneath it.** Only `src/renderer.ts`, `index.html`, and `src/index.css`
changed — `capture-pipeline.ts`, `device-enumeration.ts`,
`pitch-worklet-processor.ts`, `worklet-messages.ts`, and everything in
`packages/dsp-ts` are byte-for-byte what Phase 3/4 left them.

### What it looks like

A single-window layout, top to bottom:

1. **Header** -- "Finger Tuner" title, plus a small "Debug info" toggle
   button in the top-right corner (see "Debug panel" below).
2. **Control bar** -- a compact toolbar: "Detect input devices" button +
   device `<select>` on the left, "Start" / "Stop" / "Self-test (440Hz
   tone)" buttons on the right, with a device-status line and a
   capture-status line underneath. Functionally identical to Phase 3's
   controls, just laid out as a toolbar instead of two numbered sections
   with debug-style headings.
3. **The tuner itself** (`#tuner`, the primary view, most of the vertical
   space):
   - A small uppercase state-label line, visible **only** for `no-signal`
     ("No signal") and `unclear` ("Unclear signal (bow noise, double-stop,
     or background noise?)") -- hidden entirely once a trustworthy reading
     arrives, since the note display below speaks for itself then.
   - A large (4.5rem) note name (e.g. "A4") next to a signed cents readout
     (e.g. "+12c", formatted with the same sign-handling as `note.ts`'s
     `describeFrequency`) -- both render as an em-dash placeholder and stay
     gray during `no-signal`/`unclear`. **A note name is never shown for
     `no-signal` or `unclear`** -- this is the one hard requirement from the
     plan ("must never guess") and is structurally guaranteed by
     `renderTuner()`'s early-return branches for those two statuses, not
     just a styling convention.
   - A horizontal +/-50-cent meter bar: a shaded "in-tune zone" band
     (its half-width is set from `packages/core`'s actual
     `DEFAULT_IN_TUNE_CENTS_TOLERANCE`, via a CSS custom property computed
     once at startup -- not a hardcoded, independently-drifting CSS number),
     a center tick, and a needle that moves continuously with the smoothed
     cents value and is hidden (opacity 0) during `no-signal`/`unclear`.
   - A small monospace frequency readout (e.g. "440.02Hz"), shown only
     while `reading`.
   - A "Clipping -- reduce input gain" warning line, shown whenever the
     current hop's `clipping` flag is set, independent of tuner status
     (clipping is an actionable signal-quality issue, not a debug-only
     concern, so it's visible in the primary view, not buried in the debug
     panel).
   - **Color** (a single `data-tone` attribute on `#tuner`, cascading to
     the note/cents text and the meter needle together): gray for
     `no-signal`, amber for `unclear`, green for an in-tune `reading`,
     amber for a `reading` that's out of tune but within a presentation-only
     "close" band, red beyond that. The close/out split
     (`CLOSE_OUT_BOUNDARY_CENTS`, the midpoint between the tolerance and the
     meter's 50c edge) is purely cosmetic -- it does not feed back into
     anything `packages/core` scores, it only changes which color the
     needle/text render.
4. **Debug panel** (`#debug-panel`, `hidden` by default, toggled by the
   header button) -- everything Phase 3's debug UI used to show as the
   primary view: the **raw (unsmoothed) reading side by side with the
   smoothed one** (both rendered through one shared formatter, since
   `FingerTunerReading` and `SmoothedTunerReading` are the same shape),
   onset state, clipping (repeated here in raw form), and the full latency
   panel (hop compute time, worklet-&gt;main relay latency, hop arrival
   cadence, AudioContext base latency/sample rate, frames analyzed) --
   unchanged in substance from Phase 3, just moved out of the primary view.

### Smoothing integration

`renderer.ts` creates one `TunerDisplaySmoother` (`@violin/core`, default
config -- no overrides) for the app's lifetime. Per hop:

```
message (WorkletAnalysisMessage)
  -> PitchReading                          (unchanged from Phase 3)
  -> analyzeTunerReading(reading)          -> rawReading   (unchanged from Phase 3)
  -> smoother.update(rawReading, message.workletTimestampMs) -> smoothedReading  (NEW)
  -> renderTuner(smoothedReading)          (primary view)
  -> formatForDebug(rawReading / smoothedReading)  (debug panel, side by side)
```

`message.workletTimestampMs` (a `performance.now()` reading taken inside
the worklet -- see `worklet-messages.ts`) is used as the smoother's
timestamp input; it's monotonic for the renderer process's whole lifetime,
including across a stop/restart, so the smoother's own defensive
"timestamp went backward" handling (see its doc comment) shouldn't
normally trigger here in practice. `smoother.reset()` is still called
explicitly on every non-actively-capturing state (`idle`, `starting`,
`stopped`, `error`) as a deliberate belt-and-suspenders measure -- see
`resetTunerDisplay()` -- rather than relying solely on that timing
argument, so a restart is guaranteed to start the display from a clean
slate regardless of exactly how much wall-clock time elapsed.

### Verification specific to this phase

- All of Phase 3/4's own verification still applies unchanged (this phase
  didn't touch the pipeline) -- see "Verification" below.
- `pnpm --filter @violin/core test` -- 169/169 passing, including 11 new
  tests for `TunerDisplaySmoother` (vibrato stability, abrupt/gradual
  transitions, no-signal/unclear passthrough, config overrides, reset).
- Whole-repo `pnpm typecheck`, `pnpm lint`, `pnpm format:check` all re-run
  clean after this phase's changes.
- `pnpm --filter @violin/desktop run start` was run and its process tree
  inspected directly (not just "it didn't print an error"): main Electron
  process + 2 renderer helpers + GPU helper + network-service utility, the
  same healthy shape Phase 0/3 documented, stable for the full observation
  window with nothing alarming in stdout/stderr (only pre-existing
  Vite/electron-forge config-loader warnings, unrelated to this phase's
  changes). Every DOM id `renderer.ts` looks up via `byId()` was
  cross-checked mechanically against `index.html`'s actual ids (no
  mismatches) -- `byId()` throws immediately on a missing id, so this rules
  out the single most likely class of bug from restructuring both files
  together in the same phase.
- **Not verified: the actual rendered appearance.** This phase's environment
  has no visual/screenshot tooling for a real Electron window -- process
  health and a clean console are as far as this phase could confirm
  programmatically. Whether the meter/colors/layout actually look right,
  and whether real microphone/line-in input produces a correct, smoothly-
  updating display end to end, both still need a human (or a tool with
  Electron screenshot access) to actually look at the running app -- this
  was true of Phase 3's own capture pipeline already (see "Verification"
  below) and is now also true of this phase's UI on top of it.

## Playing Practice UI (Phase 6)

This phase's job: add the second required mode alongside Finger Tuner, sharing the same live capture pipeline, **without touching Finger Tuner's own code or the capture/DSP layer underneath either**. Only `src/playing-practice-ui.ts` (new), plus additive changes to `renderer.ts`/`index.html`/`index.css` (a mode-tabs nav + a new Playing Practice section) — `capture-pipeline.ts`, `device-enumeration.ts`, `pitch-worklet-processor.ts`, `worklet-messages.ts`, `packages/dsp-ts`, and Finger Tuner's own rendering code are byte-for-byte what Phase 5 left them.

### Mode switcher

Two tabs (`#mode-tab-tuner` / `#mode-tab-practice`) toggle which section is visible (`hidden` attribute); Finger Tuner stays the default active mode so its existing appearance/behavior is unchanged for anyone who never touches the new tab. **Both modes share one running capture session** — there's no separate "start capture" per mode. `renderer.ts`'s single `handleAnalysisFrame` (fed by the one live pipeline) calls both Finger Tuner's own rendering AND `playingPracticeUi.handleAnalysisFrame(...)` on every hop, unconditionally, regardless of which tab is currently visible. This is deliberate: switching back to the Playing Practice tab should not have lost your place in a sequence (`PlayingPracticeUi` keeps scoring in the background even while its section is hidden), and there's no reason to run two separate audio graphs for one microphone.

### Integration point: `PracticeSessionController`, not the bare `PlayingPracticeMachine`

`packages/core`'s `PracticeSessionController` already composes `PlayingPracticeMachine` + `DrillingMachine` into "the single state machine a UI actually drives" (its own doc comment). Wiring that in now — not the bare `PlayingPracticeMachine` — means Phase 7 (real Drilling UI) only has to change what this file renders for `state.mode === 'drilling'`, not replace the integration itself.

**What Phase 6 left for `'drilling'` (historical — superseded by Phase 7):** while `controller.state.mode === 'drilling'`, the UI showed only the same big target-note element Playing Practice uses, plus a plain "Drilling" label — no live hearing-feedback line, no dwell-progress bar, no "nice!" flash, and no manual skip button. The automatic attempt-timeout (see `PracticeAttemptTracker` below) still functioned underneath even with the button hidden, so a stuck drilling rep was never _unrecoverable_, just without a manual escape hatch or visible progress. `DrillingMachine`'s own `consecutiveCorrect`/`attemptsUsed` counters and its `skip()` escape hatch were already fully implemented and tested in `packages/core` (Phase 2) — only the UI chrome for them was left for Phase 7. **See "Drilling UI (Phase 7)" below for what replaced this placeholder.**

### New shared logic: `PracticeAttemptTracker` (`packages/core`)

`drilling.ts`/`playing-practice.ts` both deliberately left one question unanswered: `TargetNoteDwellTracker` (Phase 2) already decides "has the target been held in tune long enough to count as a success," but nothing decided when to give up and call an attempt a _failure_ — that was explicitly left as "a session/UI-orchestration policy" for a platform-integration phase. This phase resolves it, in `packages/core` (not per-platform, since both desktop and mobile need the identical answer), via `PracticeAttemptTracker`:

- **The give-up policy** (the actual Hard-Rule-3 decision): two mechanisms, both on by default, either sufficient alone — a manual `giveUp()` escape hatch (this UI's "Having trouble? Skip this note" button), and a `DEFAULT_ATTEMPT_TIMEOUT_MS` = 10s inactivity/elapsed timeout measured from the tracker's first `update()` call, running regardless of signal quality (so a session with the mic capturing only silence still eventually recovers). Full reasoning for both the mechanism and the 10s default: the class's own doc comment in `packages/core/src/practice/practice-attempt-tracker.ts`.
- One `PracticeAttemptTracker` instance per attempt at one target note — `playing-practice-ui.ts` constructs a fresh one every time `renderCurrentState()` runs (i.e. every time the target note changes, including a Drilling rotation landing back on a repeated note label), never reusing a stale one via `reset()`, so every attempt gets a clean dwell/timeout clock.
- This class only _decides_ success/failure from a live reading stream — it does not act on that decision. `playing-practice-ui.ts`'s `applyResult()` is what calls `controller.reportOutcome('success' | 'failure')` in response.

### What it looks like

A second top-level section (`#playing-practice`, hidden until its tab is active):

1. **Sequence settings** (`<details>`, open by default) — checkboxes for which strings to include (G/D/A/E), a pattern-type `<select>` (open strings only / stepwise first-position / one-octave scale), a direction `<select>` (ascending/descending/both), and min/max frequency number inputs — directly surfacing `packages/core`'s `SequenceGeneratorConfig`, per the plan's explicit "range/pattern configuration surfaced to the user" requirement. A live preview line (note count + first few labels, or a friendly message for a config that produces zero notes) updates on every control change, so "changing the config visibly changes the generated sequence" is true even before clicking Start. `generatePlayingPracticeSequence` only throws on a _structurally_ invalid config (no strings selected, or min > max) — both an empty-but-valid config and a genuine throw are handled with an inline message, neither crashes the UI.
2. **Session view** (shown after "Start sequence," config collapses):
   - A progress line, shared by both modes as of Phase 7 (see "Drilling UI (Phase 7)" below): "Note 3 of 12" for Playing Practice, "Drilling: N of M correct in a row · attempt A of B" while drilling.
   - The target note, large, shared between Playing Practice and Drilling.
   - **Live scoring chrome, shared by both modes as of Phase 7** (previously Playing-Practice-only — see "Drilling UI (Phase 7)" below): a live "Hearing A4 (+8c from target)"-style feedback line (cents measured via `centsOffTarget` against the _target_ frequency, not the nearest note in general, so the sign directly tells the player which way to adjust); a dwell-progress bar filling as `PracticeAttemptTracker`'s `heldMs` climbs toward the dwell threshold; a "Having trouble? Skip this note" button wired to `tracker.giveUp()` (Playing Practice only — hidden while drilling in favor of "Skip this drill", see below).
   - A "Nice!" success banner, shown briefly (700ms, `SUCCESS_PAUSE_MS`) on a non-final success before advancing — except a sequence-completing success skips the pause and goes straight to the complete screen (see the source's own comment on why: the pause has no real timer backing it, only a later analysis frame clears it, so pausing on the very last note risks never revealing "complete" if capture happens to stop right then).
   - A "Sequence complete!" screen with a "Start a new sequence" button, returning to the config view.

### Verification specific to this phase

- All of Phase 3/4/5's own verification still applies unchanged (this phase didn't touch the pipeline or Finger Tuner).
- `pnpm --filter @violin/core test` — 197/197 passing, including new tests for `PracticeAttemptTracker` (clean success, both give-up paths, no-signal/unclear passthrough without falsely advancing) alongside all prior suites.
- Whole-repo `pnpm typecheck`, `pnpm lint`, `pnpm format:check` all re-run clean after this phase's changes.
- `pnpm --filter @violin/desktop run start` boots to a healthy process tree with nothing alarming in stdout/stderr, same shape as every prior phase's check.
- **Not verified: the actual rendered appearance, or a full sequence walked start-to-finish against a real signal.** Same limitation as Phase 5 — no visual/screenshot tooling for a real Electron window in the environment that built this. Whether the config controls/meter actually look and feel right, and whether a real practice session (including Drilling actually triggering on a real failure, walking its pool, and exiting via mastery/cap/skip) behaves correctly end to end, both still need a human to look at and play through the running app. **Superseded by Phase 7** for everything Drilling-specific — see "Drilling UI (Phase 7)" below.

## Drilling UI (Phase 7)

This phase's job: replace Phase 6's deliberately minimal Drilling placeholder (see "Playing Practice UI (Phase 6)" above) with a real one, **without touching `packages/core`'s `DrillingMachine`/`PracticeSessionController`, Finger Tuner, or Playing Practice's own non-drilling code paths.** Only `src/playing-practice-ui.ts` (extended, not replaced), plus additive `index.html` markup (one new button, a couple of comments) and `index.css` (one modifier class) changed — `capture-pipeline.ts`, `device-enumeration.ts`, `pitch-worklet-processor.ts`, `worklet-messages.ts`, `packages/dsp-ts`, Finger Tuner's own rendering, and `packages/core` are byte-for-byte what Phase 6 left them. `renderer.ts` changed only to bind one new DOM element (`#pp-skip-drill-btn`) to the object passed into `PlayingPracticeUi`'s constructor.

### What it looks like

Drilling reuses `#pp-target` — the exact same section Playing Practice renders into — rather than a separate screen, so it reads as a natural extension, not a different UI:

1. **Mode label** (`#pp-mode-label`, unchanged from Phase 6) — "Drilling", replacing Playing Practice's empty label.
2. **Progress line** (`#pp-progress`, reused from Playing Practice's own "Note X of Y" — not a second, parallel element) — "Drilling: _N_ of _M_ correct in a row · attempt _A_ of _B_", from `PracticeSessionController.state`'s `consecutiveCorrect`/`requiredConsecutiveCorrect`/`attemptsUsed`/`maxAttempts` fields (all already implemented/tested in `packages/core` since Phase 2). `attemptsUsed` counts _completed_ attempts, so the display adds 1 for a human-friendly "attempt 1 of 12" on the very first rep.
3. **Target note** (`#pp-target-note`, unchanged element) — the active drill-pool note. Which pool role (center / neighbor-below / neighbor-above) is active is **deliberately not surfaced as its own label** — a documented judgment call, see "Judgment calls" below.
4. **Live feedback + dwell-progress bar** (`#pp-live-feedback`, `#pp-dwell-fill`, reused verbatim from Playing Practice) — the exact same "Hearing A4 (+8c from target)" line and dwell bar a normal target-note attempt gets, now also driven during drilling (Phase 6 had explicitly suppressed both for `isDrilling`).
5. **"Skip this drill" button** (`#pp-skip-drill-btn`, new) — replaces `#pp-giveup-btn` while drilling (the two are mutually exclusive, never shown together); wired directly to `PracticeSessionController.skipDrill()` (-> `DrillingMachine.skip()`), bypassing `PracticeAttemptTracker` entirely since it abandons the whole drill, not just the current rep.
6. **"Mastered!" / "Moving on" banner** (`#pp-success-banner`, reused from Playing Practice's "Nice!") — shown briefly (`SUCCESS_PAUSE_MS`, same 700ms constant) when a drill ends via mastery or the attempt cap, before handing back to Playing Practice at `resumeAtIndex`. "Mastered!" reuses the banner's default green; "Moving on" (the cap case) gets a neutral blue via a new `.pp-banner-neutral` modifier class — capping isn't a failure to punish, matching this codebase's established "learning tool, not a tuner" tone (see `packages/core/CLAUDE.md`'s `DEFAULT_IN_TUNE_CENTS_TOLERANCE` reasoning for the precedent). A manual "Skip this drill" click gets no banner, mirroring the existing no-flourish convention for Playing Practice's own manual give-up.

### Judgment calls made this phase (flagged, not silently decided)

- **No per-drill-note role indicator** (e.g. a "(neighbor below)"-style label). `PracticeSessionController.state`'s `'drilling'` variant exposes `targetNote: SequenceNote` only — no `DrillPoolNote.role` — by design (see `packages/core/src/practice/practice-session-controller.ts`). Adding `targetNoteRole` would be small and additive, but it's still a change to a composed, already-tested `packages/core` state machine's public shape, which this phase's own instructions said to avoid without stopping to flag it first — and explicitly offered "just rely on the note name changing" as an equally acceptable alternative. That's what's implemented: the target-note text and the progress line's counters always change together in the same `renderCurrentState()` call, so a rotation reads as synchronized progress, not a glitch. Worth reconsidering if real use shows users are confused by an unlabeled note change.
- **Mastered-vs-capped inference, not a `packages/core` API change.** `PracticeSessionController.reportOutcome()`/`skipDrill()` both return `void`, so this file cannot directly observe which of Drilling's three terminal outcomes fired. A drill-ending _failure_ is unambiguous (`DrillingMachine.reportOutcome` can never reach `'mastered'` on a failure), but a drill-ending _success_ could be either mastery or a cap-on-a-success, so `playing-practice-ui.ts`'s `applyResult()` mirrors `packages/core`'s own documented tie-break ("mastery is checked before the attempt cap" — see `drilling.ts`'s and `practice-session-controller.ts`'s doc comments) using only the already-public `consecutiveCorrect`/`requiredConsecutiveCorrect` state fields. This is a one-line mirror of a _stable, documented_ contract, not a re-implementation of undocumented internals, but it would need updating if that tie-break rule ever changes. The cleaner long-term fix — `reportOutcome`/`skipDrill` returning the terminal `DrillingOutcome` — was deliberately not made without flagging it first, per this phase's own instructions about not silently widening `packages/core`'s public API.
- **Exactly one give-up-style control at a time**, not both. Playing Practice's existing per-attempt `#pp-giveup-btn` (give up on just the current rep) is hidden while drilling, same as Phase 6; the new `#pp-skip-drill-btn` (abandon the whole drill) is hidden while not drilling. A second, per-rep give-up affordance during drilling was deliberately not added beyond what this phase's scope asked for — the automatic `PracticeAttemptTracker` timeout already recovers a single stuck rep without a manual trigger, exactly as it did under Phase 6's placeholder.

### Verification specific to this phase

- **This phase is pure UI wiring against already-tested `packages/core` logic, plus one small display-only inference (mastered-vs-capped) proven correct by direct inspection of `DrillingMachine.reportOutcome`'s source** (see "Judgment calls" above) — no new `packages/core` logic, so no new `packages/core` tests were needed or added.
- `pnpm --filter @violin/core test` — **197/197 passing, unchanged** (this phase did not modify `drilling.ts`/`practice-session-controller.ts`/any other `packages/core` file).
- Whole-repo `pnpm typecheck`, `pnpm lint`, `pnpm format:check` all re-run clean after this phase's changes.
- Every DOM id `renderer.ts`/`playing-practice-ui.ts` look up via `byId()` was cross-checked mechanically against `index.html`'s actual ids (no mismatches, including the new `#pp-skip-drill-btn`) — `byId()` throws immediately on a missing id, so this rules out the single most likely class of bug from adding a new element binding. `#pp-dwell-track` (the dwell bar's container `<div>`) is now the one id present in HTML but never looked up in JS — expected and intentional: it's permanently visible whenever `#pp-target` is (both modes use it as of this phase), so it no longer needs a JS handle to toggle its `hidden` state (previously toggled per-mode in Phase 6).
- `pnpm --filter @violin/desktop run start` was run and its process tree inspected directly: main Electron process + 2 renderer helpers + GPU helper + network-service utility — the same healthy shape every prior phase documented — stable for the full observation window with nothing alarming in stdout/stderr (only the same pre-existing Vite/electron-forge config-loader warnings every prior phase has already seen and documented as harmless).
- **Not verified: the actual rendered appearance, or a real drilling session played through end to end** (mastery, the attempt cap, and manual skip all reached with a real signal). Same limitation as every UI phase before this one — no visual/screenshot tooling for a real Electron window in the environment that built this. Whether the progress text/banners/buttons actually look and feel right, and whether the reused live-feedback/dwell-bar rendering genuinely reads as a natural extension of Playing Practice rather than a bolted-on afterthought, both still need a human to look at and play through the running app — see "To actually validate this phase end-to-end" below.

## DSP binding decision: TypeScript port, not WASM or a Node addon

This was flagged as an implementation-level call the plan deliberately left open (not a re-litigation of the already-approved architecture), to be made "with the worklet-scope constraint in view" and documented either way. Full reasoning:

**The constraint that shaped this decision:** `AudioWorkletProcessor` runs in `AudioWorkletGlobalScope` -- its own real-time thread, with no DOM and (per the same sandboxing) no access to Node.js APIs. A native Node addon (N-API, which is what wrapping `packages/dsp-native`'s C++ directly would require) **cannot be loaded inside a worklet at all**. The only way to use a native addon here would be to run it on the main/renderer thread instead, with the worklet only relaying raw audio buffers over via `port.postMessage` -- which reintroduces the main-thread-jank risk `AudioWorklet` exists specifically to avoid. A WASM build of the same C++, by contrast, genuinely _can_ be instantiated and run directly inside the worklet's own scope, no Node bindings needed.

**Given that, WASM looks like the obvious choice on paper.** It wasn't picked, for a concrete, verified-not-assumed reason:

- **Emscripten is not installed in this environment**, and none of the standard install paths (`emcc`, `emcmake`, a Homebrew keg) were present -- checked directly, not inferred. `emsdk` is a large toolchain (LLVM + Binaryen), and installing it fresh in a sandboxed, ephemeral environment for this one phase is slow and its success isn't guaranteed here.
- Even if it _had_ installed cleanly here, a WASM build adds a **new required toolchain for the whole project** — every future contributor building `apps/desktop` from source would need `emsdk` on `PATH`, in addition to the `pnpm`/`cmake`/`watchman` already documented at the repo root. That's a real, ongoing cost, not a one-time inconvenience, and it wasn't something to accept silently just because it was the theoretically-cleaner architecture.
- Critically: **without Emscripten, the WASM path could not have been verified at all** in this pass -- and this phase's own instructions require verifying the chosen binding against synthetic tones. A binding I can't build is a binding I can't check, which conflicts with "correctness is this project's top priority" harder than the toolchain-footprint concern does on its own.
- The plan explicitly pre-approved a fallback: _"if both options prove annoying, a pure-TypeScript port of YIN inside the worklet is also on the table as a simplification — correctness-first, and desktop has room to spare... mirror the validated algorithm faithfully (same threshold, same interpolation) rather than a rough approximation."_ That is exactly what was built: `src/dsp/yin-detector.ts` is a line-for-line mirror of `yin_detector.cpp` (same `yinThreshold=0.15`, same parabolic-interpolation formula, same tauMin/tauMax derivation, same best-effort-unvoiced fallback), not an approximation.
- A Node addon was never seriously in the running given the jank tradeoff above, so it wasn't benchmarked as an alternative.

**This is a reversible choice, not a permanent one.** If a future phase (e.g. Phase 4b's mobile TurboModule fallback, which wraps the same `packages/dsp-native` C++) ends up needing a WASM build anyway for some other reason, revisiting whether desktop should switch to share that artifact is reasonable — nothing here is architecturally locked in. Flagging this explicitly per Hard Rule 3 rather than treating it as settled forever.

**Verification of the TS port** (this is what actually justifies trusting it, not the reasoning above on its own). **Phase 4 update**: the specific files below now live in `packages/dsp-ts/src/` (promoted out of this app, see "Phase 4 update" at the top of this file) — the tests and results themselves are unchanged, re-run and re-confirmed from the new location:

1. **Algorithm correctness** — `yin-detector.test.ts` runs the TS `YinDetector` against a full synthetic G3-D6 chromatic sweep (32 notes, sine _and_ sawtooth, mirroring `packages/dsp-native/test/generate_synthetic_fixtures.cpp`'s exact envelope/waveform design via `test-support/synthetic-tone.ts`) plus the adversarial weak-fundamental case. Result: **zero octave errors, mean cents error well under the ~5-cent perceptual threshold**, directly comparable to Phase 1's own C++ numbers (mean 0.13c sine / 0.65c sawtooth — this port isn't claimed bit-identical, but is faithful to the same algorithm and lands in the same regime).
2. **Full-pipeline wiring** — `pitch-pipeline.test.ts` feeds a synthetic tone through `HopBuffer` -> `PitchAnalysisPipeline` exactly as the worklet does (128-sample chunks, matching Web Audio's real render-quantum size), and confirms: silence correctly gates to no-signal, the steady region resolves to a stable in-tune A4 reading once fed into `packages/core`'s real `analyzeTunerReading`, exactly one onset/one offset fire across the whole tone (matching Phase 1's own synthetic-fixture finding), and a deliberately hot (near-full-scale) tone flags sustained clipping.
3. **Timing** — `timing.test.ts` measures the TS pipeline's own per-frame compute cost (YIN + harmonicity + onset + clip, 2048-sample frame, 2000 iterations after JIT warmup): **mean 0.54-0.57ms, p99 ~0.65-1.4ms across runs**, against an 11.61ms hop budget (512/44100). This is a genuinely surprising result worth calling out: it's **not** an order of magnitude slower than Phase 1's C++ numbers (YIN mean 0.51ms) the way a naive "JS is always much slower than C++" assumption would predict — V8's JIT does very well on this kind of tight, array-indexed numeric loop. Both land at roughly 4-5% of the hop budget. (Measured in Node via Vitest, not inside an actual worklet thread — V8's JIT behavior should be comparable, but real worklet-thread scheduling isn't reproduced by this measurement; see "Latency" below for the in-app numbers that do run inside a real worklet.)

**What was NOT ported: MPM.** Only YIN was ported, per Phase 3's explicit scope ("reuse the algorithm Phase 1 already validated (YIN...)") and Phase 1's own empirical primary-algorithm decision (`packages/dsp-native/RESULTS.md`). `MpmDetector` was kept in `packages/dsp-native` but was never run as an always-on cross-check even there; there was no reason to port it here (or later, in `packages/dsp-ts`) either.

## TypeScript project split (main vs. worklet)

Two separate `tsc` invocations cover this package with **no overlap and no gaps**:

- `tsconfig.json` (`lib: ["ES2022", "DOM", "DOM.Iterable"]`) covers everything except the two worklet-scope files.
- `tsconfig.worklet.json` (`lib: ["ES2022"]` only, `types: []`) covers `src/audio/{audioworklet-globals.d.ts,worklet-messages.ts,pitch-worklet-processor.ts}`, plus — transitively, via `pitch-worklet-processor.ts`'s `@violin/dsp-ts` import — `packages/dsp-ts/src/**` (excluding that package's own tests, which are never pulled in since nothing under this restricted program imports them). See that tsconfig file's own comment and `packages/dsp-ts/CLAUDE.md`'s "Why this package is safe to share..." section for why a workspace-package import gets typechecked under the _importing_ program's compiler options, not the imported package's own tsconfig — this is what lets the worklet-scope guarantee survive Phase 4's move without this app needing to re-list `packages/dsp-ts`'s files anywhere.

This isn't just tidiness — it's real compiler enforcement of the AudioWorklet-scope constraint that this phase's whole DSP-binding decision turns on. Two things make it necessary rather than optional:

1. **Correctness**: without a DOM-free project, a stray `document`/`window` reference accidentally introduced into worklet code would typecheck fine and then throw a confusing `ReferenceError` at runtime, inside the audio thread, the first time that code path actually ran.
2. **A genuine naming collision, not just a style preference**: `audioworklet-globals.d.ts` declares `performance` and `MessagePort` as ambient globals matching `AudioWorkletGlobalScope`'s real (narrower) shape. `lib.dom.d.ts` already declares both of those names with a different (richer) shape. Including both declarations in the _same_ `tsc` program is a duplicate-identifier error, not a warning — the two projects have to stay separate. This repo's `nodeLinker: hoisted` setting also means every workspace package's `@types/*` (e.g. `packages/core`'s `@types/node`) is visible to every tsconfig unless explicitly excluded, which is why `tsconfig.worklet.json` also sets `types: []` -- otherwise Node globals like `process`/`require` would leak into worklet-scope typechecking too, undermining the whole point.

Root `pnpm typecheck` covers both automatically -- `apps/desktop`'s own `typecheck` script chains them: `tsc --noEmit && tsc --noEmit -p tsconfig.worklet.json`.

## Vite worklet-loading gotcha (read before touching capture-pipeline.ts or vite.renderer.config.ts)

`capture-pipeline.ts` loads the worklet via:

```ts
import workletModuleUrl from './pitch-worklet-processor.ts?worker&url';
// ...
await audioContext.audioWorklet.addModule(workletModuleUrl);
```

**This specific pattern was arrived at empirically, after a more commonly-suggested approach was tried and found broken for packaged builds.** The first attempt used the pattern most Vite/AudioWorklet writeups suggest:

```ts
const url = new URL('./pitch-worklet-processor.ts', import.meta.url).href;
await audioContext.audioWorklet.addModule(url);
```

plus a manual `build.rollupOptions.input` entry in `vite.renderer.config.ts` to make sure the worklet got bundled for production. This **worked in dev mode** (Vite's dev server transforms any `.ts` file it serves, regardless of how it's requested) but **silently produced a broken packaged build**: inspecting `pnpm package`'s actual output (`.vite/renderer/main_window/assets/`) showed the built main-window bundle's `new URL(...)` call still pointed at a raw, untranspiled `.ts` asset copy (`pitch-worklet-processor-<hash>.ts`, containing literal TypeScript syntax like `import { type X }`), not the separately-bundled `.js` chunk the manual Rollup entry produced. The two mechanisms — Vite's generic "explicit URL asset" handling for `new URL(...)`, and a manual `rollupOptions.input` entry — don't automatically connect to each other. Loading that raw `.ts` file as a worklet module in a real packaged app would have failed at runtime with a syntax error, invisible in dev mode and invisible unless someone actually inspected the build output.

The fix: Vite's `?worker&url` query suffix (documented in `vite/client.d.ts`'s `declare module '*?worker&url'`) is Vite's own purpose-built mechanism for "bundle this file as a worker-shaped module (imports resolved, TS transpiled) and give me a URL string to the result" — in both dev and production, no manual Rollup entry needed at all. `vite.renderer.config.ts` is back to `defineConfig({})`.

**Verified, not assumed**: after switching to `?worker&url`, `pnpm package`'s output was re-inspected and confirmed correct — exactly one `pitch-worklet-processor-<hash>.js` file (valid bundled JS, no stray `.ts` asset), and the main bundle's reference resolves to that `.js` file. The file is present inside the packaged `app.asar` (checked via `asar list`), at the same relative path the renderer's own `index.html`/main bundle live at, so Electron's transparent asar path resolution should serve it identically to any other renderer asset.

## The mute-gain requirement

`capture-pipeline.ts`'s `createWorkletNode` connects the `AudioWorkletNode`'s output to a zero-gain `GainNode` -> `audioContext.destination`, even though the app never wants to play the input back audibly. This isn't cosmetic: **a Web Audio node with no path (direct or indirect) to the context's destination is not guaranteed to have its `process()` called at all** — Chromium's audio graph is pulled from the destination outward, and an unconnected-to-destination analysis-only node can simply never run. Muting via a zero-gain node keeps the graph "live" (so `PitchProcessor.process()` actually fires) without the user hearing their own input, or the self-test oscillator, played back. Don't remove this connection as a "simplification" — it would silently stop the whole pipeline from producing any analysis messages at all, with no error anywhere to explain why.

## Electron-specific permission wiring

Two separate things had to be added, both required, neither sufficient alone:

1. **`main.ts`**: `session.defaultSession.setPermissionRequestHandler` / `setPermissionCheckHandler`, both allowing only the `'media'` permission. Electron denies every permission request by default — without this, `getUserMedia()` rejects with `NotAllowedError` immediately, regardless of what the OS would have allowed.
2. **`forge.config.ts`**: `packagerConfig.extendInfo.NSMicrophoneUsageDescription`. macOS requires this Info.plist key before it will even show the OS-level mic-permission prompt to the user — without it, the OS denies access before the app (or Electron's own permission handler above) gets a say. `extendInfo` is a no-op on non-macOS packaging targets, so it's set unconditionally rather than gated per-platform.

Neither of these was exercised against a real permission grant in this environment (no interactive session to click "Allow" on the OS prompt) — see "Verification" below.

## Multichannel input and the worklet clock (first real-hardware test, 2026-09-15)

The first time this app was run against the user's actual instrument (HVPV-30 preamp LINE OUT → Arturia MiniFuse 1 → USB → macOS), it showed "No signal" while the interface's own meter and `MiniFuse Control Center` both showed a healthy level. Two genuine bugs, neither reachable by any of the sandboxed verification earlier phases could run:

**Bug 1 — forced-mono capture on a 4-channel interface.** `capture-pipeline.ts` requested `getUserMedia({ audio: { channelCount: 1, ... } })`. The MiniFuse 1 exposes **4 input channels** on macOS (`MIC/LINE/INST 1`, `MIC/LINE/INST 2`, `LOOPBACK Left`, `LOOPBACK Right`; the analog input is mirrored onto 1+2, 3+4 are silent unless loopback is used — and installing Control Center is what switched the device from 2 to 4 channels). With mono requested, Chromium's macOS input path failed every render call and eventually gave up, logged in its own output (visible with `ELECTRON_ENABLE_LOGGING=1`) as `media/audio/apple/audio_low_latency_input.cc: Too long sequence of kAudioUnitErr_CannotDoInCurrentContext errors!` — and the worklet never received a single render quantum. Diagnosis was confirmed from outside Chromium: `ffmpeg -f avfoundation -i ":0"` recorded the device fine (peak -19.6 dBFS on channels 1+2, `-inf` on 3+4). **Fix:** no `channelCount` constraint at all (Chromium then opens the device at a layout it can serve — it delivered a 2-channel track); the `AudioWorkletNode` uses `channelCountMode: 'max'` so the worklet receives every channel the source provides; and `PitchProcessor.chooseChannel()` analyzes the channel with the most energy per render quantum, with 3 dB hysteresis (`CHANNEL_SWITCH_ENERGY_RATIO = 0.5`) so a mono input mirrored onto two channels never flip-flops while a channel that goes silent is abandoned immediately. This is also the right behavior for any interface where the instrument sits on input 2+ — pitch detection stays monophonic; only the _choice_ of channel became adaptive.

**Bug 2 — `performance.now()` inside the worklet (latent since Phase 3).** `pitch-worklet-processor.ts` used `performance.now()` for compute timing and message timestamps. `performance` does **not** exist in `AudioWorkletGlobalScope`; the moment Bug 1 was fixed and real audio reached the worklet, it threw `Uncaught ReferenceError: performance is not defined`. This had been invisible because (a) `audioworklet-globals.d.ts` falsely declared `performance` as a real worklet global, so the worklet-scope typecheck accepted it, and (b) every prior verification ran the DSP under Node/Vitest, where `performance` exists. It would have failed identically for the built-in mic and for the self-test. **Fix:** worklet timestamps and compute timing use `Date.now()` (a plain ECMAScript built-in); `capture-pipeline.ts`'s relay-latency measurement and `playing-practice-ui.ts`'s manual give-up path use `Date.now()` too so every clock that gets compared is the same epoch clock; and the false `performance` declaration was **removed** from `audioworklet-globals.d.ts`, so the worklet-scope typecheck now rejects any recurrence at compile time. Cost: 1 ms resolution on `computeTimeMs`/relay latency (per-frame values read 0 or 1; means over many frames remain meaningful).

**Debug panel additions made during this diagnosis** (kept — they are exactly what's needed to troubleshoot remotely): "Input level (RMS / peak, dBFS)", "Opened input track (channels / device rate / id)" — which also shows how many channels the worklet actually sees and which one it is analyzing — and a throttled (1/s) `[diag] ...` console line with the same numbers plus track settings, emitted **only while the debug panel is open**, readable from the process's stdout when launched with `ELECTRON_ENABLE_LOGGING=1`.

**Outcome:** with both fixes, the app's own logged readings on the real instrument were `frames` climbing at the expected hop cadence, RMS ≈ -32 to -38 dBFS, `voiced=true`, `f ≈ 438 Hz`, `conf 0.99–1.00`, `onset=sustained` — the open A string, ~8 cents flat, detected correctly, with Chromium delivering a 2-channel 44.1 kHz track into the 48 kHz `AudioContext` (Chromium resamples) and the worklet analyzing channel 1.

## Pitch reading: continuous, not onset-gated

`renderer.ts` feeds **every** hop's `PitchAnalysisPipeline` output into `packages/core`'s `analyzeTunerReading`, using `AnalysisFrameResult.voiced` (`confirmedVoiced` AND not RMS/onset-gated silent) as `PitchReading.voiced` — deliberately **not** additionally requiring `onsetState === 'sustained'`. Requiring the fuller onset-confirmed state would reintroduce exactly the debounce/lag `packages/core/CLAUDE.md`'s Finger Tuner section documents as a deliberate non-goal ("should show a slide as it happens rather than debouncing it"). `onsetState` (`silence`/`attack`/`sustained`) is still surfaced separately in the debug UI and the worklet message for visibility, and is there for a future consumer (e.g. Playing Practice's dwell-time scoring, out of scope this phase) that _does_ want the stricter distinction.

## Clipping and silence detection (task point 4)

- **Silence / "no signal"**: `OnsetSegmenter`'s RMS gate, same `-50dBFS` default as `packages/dsp-native`'s validated `OnsetConfig`. Surfaced as `packages/core`'s `'no-signal'` tuner state.
- **Clipping**: new (`packages/dsp-ts/src/clip-detector.ts` as of Phase 4, promoted from this app's own `src/dsp/clip-detector.ts` — not a dsp-native port either way; Phase 1's WAV-file harness never had a live gain knob). Peak dBFS per hop, flagged once `sustainedFrames` (default 3, matching `OnsetSegmenter`'s stability-confirmation convention) consecutive hops sit at or above `-1dBFS` — deliberately a hair below true 0dBFS, and requiring sustain rather than a single hot transient (e.g. a pizzicato pluck), so a genuinely-too-hot input gain is what gets flagged, not a one-off loud attack. `apps/mobile` reuses this exact same class (Phase 4 task point 5) rather than re-deriving clip detection independently.

## Latency measurement (task point 6)

Three separate numbers are measured, each with a clearly different (and honestly stated) confidence level, rather than one composite "capture to UI" figure that would rest on a shakier assumption than any of its parts:

1. **Worklet-internal compute time** (`WorkletAnalysisMessage.computeTimeMs`, `Date.now()` deltas entirely inside the worklet, no cross-thread anything — `Date.now()` rather than `performance.now()` because `performance` does not exist in `AudioWorkletGlobalScope`, see "Multichannel input and the worklet clock" above; 1 ms resolution, so read the _mean_, not single frames): this is the number directly comparable to Phase 1's C++ per-frame timing. Measured standalone in Node/Vitest (`timing.test.ts`): **mean 0.54-0.57ms, p99 ~0.65-1.4ms**, vs. dsp-native's C++ YIN mean 0.51ms — both around 4-5% of the 11.61ms hop budget. The in-app worklet number should be in the same regime (same V8 engine).
2. **Worklet -> main-thread relay latency** (`Date.now()` on both sides, `capture-pipeline.ts`'s `onmessage` handler): epoch time is shared by every thread of the process, so this is a like-for-like subtraction with no time-origin assumption at all — at 1 ms resolution. Surfaced in the debug UI.
3. **Hop arrival cadence** (wall-clock time between consecutive messages, measured entirely on the main thread — no cross-thread clock assumption at all): should hover near the 11.61ms hop duration; a drifting or irregular cadence would indicate the audio thread falling behind. Surfaced in the debug UI as mean/stddev.

The debug panel (`#debug-panel` in `index.html`, hidden by default — see "Finger Tuner UI (Phase 5)" above) also has a **self-test path** (`AudioCaptureController.startSelfTest`) that routes a synthetic `OscillatorNode` tone through the _exact same_ `AudioContext -> AudioWorkletNode -> PitchProcessor` graph real capture uses, with no microphone involved — this is the one way this environment could exercise the real worklet-thread numbers above, but doing so requires actually running the packaged/dev app interactively (see Verification; this pass did not click through the live UI).

## Commands

Run from this directory, or as `pnpm --filter @violin/desktop <script>` from the repo root:

- `pnpm start` — dev mode: Vite dev server + hot reload, launches Electron. Verified in this phase: boots to a healthy process tree (main + GPU + 2x renderer + network utility, matching Phase 0's documented pattern) with nothing in stdout/stderr.
- `pnpm package` — production build; output in `out/<name>-<platform>-<arch>/` (gitignored). Verified in this phase (macOS arm64): builds cleanly, and the worklet chunk was confirmed present and correctly referenced (see "Vite worklet-loading gotcha").
- `pnpm make` — `package` plus platform installers. Exercised on macOS arm64 when the CI/release pipeline was added (produces `out/make/zip/darwin/arm64/Violin Practice-darwin-arm64-<version>.zip`). **The Windows makers have never been run locally** — Squirrel (`ViolinPractice-Setup.exe`) and the portable `win32` zip only build on a Windows host, so GitHub Actions (`.github/workflows/`, see root `CLAUDE.md`'s "CI and releases") is the only place they are verified. Two `forge.config.ts` settings exist for that build: the Squirrel maker's explicit `name: 'violin_practice'` (the default, `@violin/desktop`, is not a legal NuGet package id) and `win32` in the ZIP maker's platform list. `main.ts` also only opens DevTools when `!app.isPackaged`, so installed builds don't launch with DevTools open.
- `pnpm typecheck` — `tsc --noEmit && tsc --noEmit -p tsconfig.worklet.json` (see "TypeScript project split").
- No per-package `pnpm lint`/`pnpm format` — both run from the repo root and cover this package (see root `CLAUDE.md`).

**No `pnpm test` here anymore (Phase 4 change).** This app has no test files of its own: every test that used to live at `src/dsp/*.test.ts` (37 tests) moved to `packages/dsp-ts` along with the code it tests — run `pnpm --filter @violin/dsp-ts test` instead (or plain `pnpm test` from the repo root, which covers it via `pnpm -r --if-present`). The `vitest`/`test`/`test:watch` entries that used to be in this package's `package.json` were removed rather than left as dead weight.

**Historical note, resolved by the above (kept for anyone who remembers the old tension):** this package used to have to pin `vitest: ^3.2.7` instead of the `^5.0.0` `packages/core` uses, because `@electron-forge/plugin-vite` requires `vite: ^5.0.12` directly while `vitest@^5.0.0` requires `vite: ^6.4.0 || ^7.0.0 || ^8.0.0` — the two couldn't coexist as this package's own dependencies. Since this package no longer has any tests of its own, it no longer depends on `vitest` at all, and that whole version-pin conflict is now moot here rather than merely worked around. `packages/dsp-ts` (where the tests now live) has no Electron/Vite dependency of its own, so it uses plain `vitest: ^5.0.0` like `packages/core` with no conflict.

## Verification: what's confirmed vs. what needs a human

**Phase 8 re-verification**: `pnpm --filter @violin/desktop run typecheck` still passes after the eager-boot refactor (`renderer.ts` + `capture-pipeline.ts`), and `pnpm --filter @violin/desktop run package` still produces a clean macOS arm64 package after moving the first-session worklet/context setup earlier in app boot. There are still no per-package tests here (unchanged Phase 4 decision; the DSP tests live in `packages/dsp-ts`), so Phase 8's desktop verification remains "typecheck + production package + manual hardware follow-up" rather than inventing a new local test runner for browser/native glue.

**Phase 4 re-verification, after promoting the DSP code into `packages/dsp-ts`** (see "Phase 4 update" at the top of this file): `pnpm --filter @violin/dsp-ts test` (37/37 passing from the new location), `pnpm --filter @violin/desktop typecheck` (both the main and worklet projects, the latter confirmed via `--listFiles` to still genuinely cover `packages/dsp-ts`'s source), and `pnpm --filter @violin/desktop run package` followed by inspecting the packaged `app.asar` directly (`npx @electron/asar list`) to confirm the worklet chunk still bundles as one real `.js` file containing the actual pipeline logic (not a stray `.ts` asset — the exact failure mode "Vite worklet-loading gotcha" above already found once). All of this passed; nothing about Phase 3's original findings below needed correction, only re-confirmation from the new file locations.

**Verified programmatically in Phase 3** (re-run and independently confirmed, not just reported by whoever wrote the code):

- The TS YIN port's accuracy against synthetic reference tones, comparable to Phase 1's own numbers (zero octave errors, sub-few-cent mean error across a full G3-D6 chromatic sweep).
- The full buffering + pipeline-composition + `packages/core`-wiring logic, end to end, via synthetic tones (silence -> onset -> sustained in-tune reading -> offset -> silence; clipping detection on a hot tone).
- The TS pipeline's own compute-time budget (comfortably inside the validated hop budget).
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check` all pass clean across the _whole_ repo (not just this package).
- The app boots cleanly in dev mode (`pnpm start`) and packages cleanly (`pnpm package`), including the worklet module actually being present and correctly referenced in the packaged output.
- Device-enumeration and permission-request code paths are structured to fail gracefully (typed `{ ok: false, error, message }` results, never a thrown exception) when no device/permission is available — this environment has no real microphone, so `requestMicPermissionAndListInputDevices()` was exercised structurally (code review + the type-safe never-throws design) rather than against an actual OS permission dialog.

**Verified on real hardware (2026-09-15, user's electro-violin → Arturia MiniFuse 1)** — after fixing the two bugs described in "Multichannel input and the worklet clock" above:

- The OS-level microphone permission is granted and `getUserMedia` succeeds (macOS TCC shows grants for both launch paths — Terminal via the Desktop launcher, and Claude Code — and the capture reached `running`).
- The HVPV-30's LINE OUT signal through the MiniFuse produces correct readings end to end: the app's own logged diagnostics showed the open A detected at ~438 Hz with confidence 1.00 and `onset=sustained`, at a healthy RMS ≈ -32 to -38 dBFS. (Visual confirmation of the tuner display itself was still pending from the user when this was written.)

**NOT verified — needs the user's own hands-on test, on a real machine, with a real signal:**

- Real-world clipping-detection behavior against an actual too-hot preamp gain setting.
- Real device-disconnect behavior (the interface being unplugged mid-session) — the app now deliberately relies on the existing `MediaStreamTrack` `ended` -> visible error transition as its Phase 8 desktop unplug path, but that still needs an actual USB/interface unplug test in a real interactive session.
- The self-test path's _displayed_ numbers in the actual running debug UI (the underlying self-test code was written and typechecks, and its identical graph-construction code path is exercised by the `start()` method which IS covered structurally, but nobody has clicked the button and read the screen).

**To actually validate this phase end-to-end**: run `pnpm --filter @violin/desktop run start` (or open the packaged `.app` in `apps/desktop/out/`), click "Detect input devices," grant the OS permission prompt, select the HVPV-30's actual input device, click "Start," and play some notes. Compare the displayed note/cents against a known reference; open the "Debug info" toggle to eyeball the latency panel against the numbers above. **For Phase 6**: switch to the "Playing Practice" tab, try different string/pattern/direction/range combinations and confirm the preview updates sensibly, click "Start sequence," play the target note and confirm it advances on success (dwell bar filling, "Nice!" banner), let one time out or hit "Having trouble? Skip" and confirm Drilling starts with the right target note. **For Phase 7**: once in Drilling, confirm the progress line reads "Drilling: 0 of 3 correct in a row · attempt 1 of 12" (or your configured thresholds) and updates each rep; confirm the live feedback line and dwell bar behave identically to a normal Playing Practice attempt; play the pool correctly `requiredConsecutiveCorrect` times in a row and confirm a green "Mastered!" banner appears before returning to Playing Practice one note past the one that failed; separately, deliberately fail enough reps to hit `maxAttempts` and confirm a neutral blue "Moving on" banner instead; and click "Skip this drill" mid-drill and confirm it exits immediately with no banner. Finally, confirm the note name changes visibly (without any "(neighbor below)"-style label) each time the pool rotates, and that this doesn't read as a bug given the surrounding progress-line update — see "Drilling UI (Phase 7)"'s "Judgment calls" section above for why that indicator was deliberately left out.

## What's deliberately not here yet

- Nothing UI-phase-related remains outstanding for this app specifically -- Finger Tuner (Phase 5), Playing Practice (Phase 6), and Drilling (Phase 7) are all real as of this phase; see their respective sections above. (Mobile's own Drilling UI, Part B of Phase 7, is a separate, not-yet-done task tracked in `apps/mobile/CLAUDE.md`.)
- Any persistence wiring — out of scope for this phase per the plan, and `packages/core`'s persistence ports are still backed only by the in-memory no-op adapter.
- A richer device-disconnect UX beyond the visible error state already in place — for example, a dedicated reconnect affordance or automatic re-enumeration/retry flow once an interface is plugged back in.
- Audio-session-interruption handling (this is a mobile concept per the plan — n/a to desktop).
- A cross-platform conformance suite comparing `packages/dsp-ts`'s output against `packages/dsp-native`'s C++ output on identical fixtures — not asked for by this phase, but would be a natural Phase 8 addition now that `packages/dsp-ts` is shared by both `apps/desktop` and `apps/mobile` (Phase 4) and `packages/dsp-native`'s C++ remains the reference implementation.

## Code navigation: CodeGraph

This repo has a CodeGraph index at `../../.codegraph/` (see root `CLAUDE.md`). Reach for `codegraph_explore` / `codegraph explore` before grep/find when tracing how `AudioCaptureController` wires into `PitchProcessor` (they don't share a normal import graph — only `worklet-messages.ts`'s types and the `port.postMessage`/`port.onmessage` boundary connect them), or how a hop's data flows `HopBuffer.push` -> `PitchAnalysisPipeline.analyzeFrame` -> `WorkletAnalysisMessage` -> `analyzeTunerReading`.
