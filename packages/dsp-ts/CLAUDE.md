# packages/dsp-ts — CLAUDE.md

Shared, platform-agnostic TypeScript port of `packages/dsp-native`'s
validated YIN pitch-detection pipeline. See the root `CLAUDE.md` for full
product context and `temp/PLAN-violin-practice-app.md` for the phased plan
— this file documents this package only.

## Status (created in Phase 4, expanded in Phase 8)

This package did not exist before Phase 4. Every file under `src/` was
originally written, tested, and validated **inside `apps/desktop` during
Phase 3** (`apps/desktop/src/dsp/*`) as a faithful TypeScript port of
`packages/dsp-native`'s validated YIN pipeline, specifically because
Phase 3's `AudioWorkletProcessor` couldn't load a native Node addon and
Emscripten (for a WASM binding) wasn't installed in that phase's
environment — see `apps/desktop/CLAUDE.md`'s "DSP binding decision"
section for the full reasoning, which still applies unchanged; nothing
about _why_ this is a TS port was revisited in this move.

Phase 4 needed the identical, already-validated pipeline for
`apps/mobile`'s mic capture. Rather than writing a second, independent
port of the same algorithm (real risk: the two copies silently drifting
apart over time, and directly against the plan's "share core logic where
it doesn't hurt performance" principle), this package is that code
**promoted out of `apps/desktop` into a shared workspace package**, with
`apps/desktop` updated to import it from here instead of a local path.
This was a mechanical move, not a rewrite:

- Every source file's logic is byte-for-byte identical to its
  `apps/desktop/src/dsp/*` predecessor (only doc comments referencing
  "this app"/"apps/desktop" were adjusted to reflect the new shared
  location — see each file's own header).
- All **37 tests moved with the code** and were re-run from this new
  location immediately after the move: **7 test files, 37 tests, all
  passing**, identical count to before the move.
- `apps/desktop` was re-typechecked and re-packaged (`pnpm package`) after
  switching its import from `../dsp/*.js` to `@violin/dsp-ts`, to confirm
  both the worklet-scope typecheck enforcement and the packaged-build
  worklet-bundling behavior (see apps/desktop/CLAUDE.md's "Vite
  worklet-loading gotcha") survived the move unchanged — both did; see
  "Verification" below for the specific commands and what they proved.

**Phase 8 added the first real end-to-end conformance check against the
original C++ reference implementation** — not a second algorithm port, and
not any app-facing behavior change. The live risk after Phase 4 was no
longer "desktop vs. mobile drift" (both apps consume this exact same
package), but this hand-written TS port quietly drifting from
`packages/dsp-native`'s already-validated C++ YIN pipeline over time. To
close that gap:

- `src/conformance.test.ts` now runs the **actual checked-in WAV fixtures**
  under `packages/dsp-native/test/fixtures/` (the full 68-file synthetic
  tier plus all 6 Iowa violin recordings) through this package's real
  `PitchAnalysisPipeline`.
- The suite compares the TS output against **checked-in YIN reference CSV
  snapshots** under `packages/dsp-native/test/reference/`, copied from a
  validated `pnpm test:dsp-native` run so the Vitest suite stays
  headlessly runnable without needing a fresh C++ build first.
- For synthetic fixtures, it asserts exact note-label agreement on every
  voiced frame in the scored region and matches dsp-native's per-fixture
  voiced/onset counts plus mean/median/max cents error within tight,
  documented tolerances (0.1c on mean/median, 0.25c on max, one hop on
  onset duration) — far tighter than the ~5c perceptual threshold cited
  elsewhere in the project, but wide enough to allow tiny C++ vs.
  JS floating-point drift.
- For Iowa fixtures, it matches dsp-native's gated-voicing, in-range,
  octave-error, onset-count, mean segment-duration, and within-segment
  stability metrics, with a 1.0c tolerance on the stability summary and
  one hop on duration summaries.
- **Outcome:** clean pass, no TS-vs-C++ divergence found, and no shipped
  algorithm changes were needed.

**No dependency on `packages/dsp-native`** (this is an independent,
hand-written TS mirror of that C++, not a binding/wrapper — same relationship
`packages/core` has to `dsp-native`, just for the DSP layer instead of the
domain layer) and **no dependency on `packages/core`** in its shipped code
(`@violin/core` is a devDependency used only by `pitch-pipeline.test.ts`,
which verifies this package's output actually wires correctly into
`packages/core`'s `analyzeTunerReading` — see "Testing the
`packages/core` integration contract" below).

## Why this package is safe to share between an AudioWorkletProcessor and a React Native capture callback

Every file in `src/` (excluding tests and `test-support/`) has **zero
DOM, zero Node.js, and zero React-Native imports** — pure, dependency-free
TypeScript operating on `Float32Array`/`Float64Array` and plain numbers.
This was already a hard requirement in Phase 3 (AudioWorkletGlobalScope
has no DOM and can't load Node addons) and turns out to be exactly the
right shape for Phase 4's mobile consumer too, even though mobile's own
DSP-hosting choice (see `apps/mobile/CLAUDE.md`'s "DSP hosting: event
callback, not a worklet" section) ended up being a plain JS-thread event
callback rather than a real audio-thread worklet — the code doesn't care
which JS execution context it runs in, only that it's plain JS/TS with no
host-API dependencies.

**Enforcement, not just intent**: `apps/desktop/tsconfig.worklet.json`
(lib: `["ES2022"]`, `types: []`, no DOM) includes
`apps/desktop/src/audio/pitch-worklet-processor.ts` as a root file, which
imports from `@violin/dsp-ts`. TypeScript pulls a package's actual source
into the _same_ compilation "program" as whatever imports it (module
resolution, not a separate project reference), so this package's source
is typechecked under that restricted `lib`/`types` config every time
`apps/desktop`'s own `pnpm typecheck` runs — a stray `document`/`window`
or Node global accidentally introduced here would fail **there**, at
compile time, exactly as it would have before the Phase 4 move (verified
directly during this phase: `tsc --noEmit -p tsconfig.worklet.json
--listFiles` was run and confirmed it lists this package's actual
`src/*.ts` files as part of that compilation). This package does **not**
duplicate that restrictive tsconfig locally (its own `tsconfig.json` is a
plain, `packages/core`-style config, matching this package's own stated
discipline rather than inventing new machinery) — the enforcement that
matters lives at each consuming app's own worklet/audio-thread tsconfig,
which is also where it should live, since different consumers may have
different restricted-scope shapes (desktop's `AudioWorkletGlobalScope` vs.
whatever a future mobile worklet runtime's ambient surface would be).

## Architecture

```
src/
  index.ts                       Public API barrel -- every export below.
  pitch-types.ts                  PitchDetectorConfig / PitchResult / forViolin()
                                   / minRecommendedFrameSize() -- mirrors
                                   packages/dsp-native's types.h exactly
                                   (minus mpmClarityThreshold; MPM was never
                                   ported -- see "What was NOT ported" below).
  yin-detector.ts                  YinDetector -- line-for-line port of
                                   dsp-native's yin_detector.cpp.
  onset-detector.ts                computeRmsDbfs + OnsetSegmenter -- port of
                                   onset_detector.cpp (silence gate,
                                   energy-rise attack, pitch-stability
                                   confirmation).
  harmonicity.ts                   computeHarmonicity -- port of
                                   harmonicity.cpp (Boersma HNR).
  clip-detector.ts                 ClipDetector + computePeakDbfs -- NOT a
                                   port (dsp-native's WAV-file harness never
                                   had a live input-gain knob to reason
                                   about); built fresh in apps/desktop's
                                   Phase 3 for live-capture clipping warnings,
                                   reused as-is by apps/mobile in Phase 4.
  hop-buffer.ts                    HopBuffer -- accumulates arbitrary-sized
                                   input blocks into the validated
                                   2048-sample/512-hop sliding analysis
                                   window. Written from the start to accept
                                   *any* block size, not just Web Audio's
                                   fixed 128-sample render quantum -- this is
                                   exactly what made reusing it unchanged for
                                   apps/mobile's differently-shaped native
                                   delivery granularity mechanical rather
                                   than a rewrite.
  pitch-pipeline.ts                PitchAnalysisPipeline -- composes the
                                   above in the exact order
                                   packages/dsp-native/test/
                                   validation_harness.cpp validated: YIN ->
                                   harmonicity gate (HNR >= 0dB) ->
                                   OnsetSegmenter -> ClipDetector. Exports
                                   ANALYSIS_FRAME_SIZE=2048 /
                                   ANALYSIS_HOP_SIZE=512, matching
                                   dsp-native's validated settings exactly --
                                   both apps/desktop and apps/mobile import
                                   these constants rather than
                                   re-hardcoding them.
  test-support/synthetic-tone.ts  Test-only: mirrors packages/dsp-native/
                                   test/generate_synthetic_fixtures.cpp's
                                   envelope/waveform design exactly, so this
                                   package's own test fixtures are directly
                                   comparable to Phase 1's published numbers.
  test-support/wav-fixture.ts     Test-only RIFF/WAVE reader for the shared
                                   dsp-native fixture assets used by the
                                   Phase 8 conformance suite.
  *.test.ts                       One test file per module, plus
                                   pitch-pipeline.test.ts (full HopBuffer ->
                                   pipeline -> packages/core integration),
                                   conformance.test.ts (shared WAV-fixture
                                   parity vs. dsp-native's validated YIN
                                   outputs), and timing.test.ts (the latency
                                   benchmark). 8 test files, 113 tests total
                                   after Phase 8 (up from 7 / 37).
```

## What was NOT ported: MPM

Only YIN was ported, per Phase 3's explicit scope and Phase 1's own
empirical primary-algorithm decision (`packages/dsp-native/RESULTS.md`).
`MpmDetector` stays C++-only in `packages/dsp-native`, was never run as an
always-on cross-check even there, and there was no reason to port it here
either. Nothing in Phase 4 revisits this.

## Testing the `packages/core` integration contract

`pitch-pipeline.test.ts` feeds a synthetic tone through
`HopBuffer` -> `PitchAnalysisPipeline` and asserts the result wires
correctly into `packages/core`'s real `analyzeTunerReading` (silence ->
`no-signal`, a steady in-tune A4 -> a `reading` status with the right
note/cents). This is why `@violin/core` is a **devDependency** of this
package: the shipped `src/index.ts` and everything it exports has zero
dependency on `packages/core` (verified by grep -- only the test file
imports it), but the test suite itself is the one place that actively
proves this package's output shape is what `packages/core` expects,
protecting **both** of this package's real consumers (`apps/desktop` and
`apps/mobile`) with one shared assertion instead of each app re-deriving
its own version of this same check.

## Phase 8 conformance suite

`src/conformance.test.ts` is the repo's answer to the plan's "shared
conformance suite" bullet, adapted to the architecture that Phase 4
actually produced. The plan assumed desktop and mobile would each end up
with their own native DSP binding that could disagree on the same audio
input. In the code that shipped, both apps instead consume this one shared
TS package, so the meaningful remaining parity risk became **this TS port
vs. `packages/dsp-native`'s original validated C++**.

The suite therefore uses the same fixture assets `packages/dsp-native`
already validated:

- `packages/dsp-native/test/fixtures/synthetic/manifest.csv` + the 68 WAVs
  it describes
- `packages/dsp-native/test/fixtures/iowa/*.wav`
- `packages/dsp-native/test/reference/{synthetic_results,iowa_results}.csv`
  — checked-in YIN-only reference snapshots copied from a successful
  `pnpm test:dsp-native` run

It does **not** reimplement the DSP in test code. It constructs the real
`PitchAnalysisPipeline`, runs the fixture WAVs across the exact same
2048-sample / 512-hop frame grid the C++ harness uses, and compares the TS
results to the reference metrics:

- **Synthetic:** exact note-name agreement for every voiced frame in the
  scored steady-state window; exact voiced/onset/octave-error counts; and
  mean/median/max cents parity within 0.1c / 0.1c / 0.25c respectively.
- **Iowa:** exact total/gated-voiced/in-range/octave-error/onset-segment
  counts; mean segment duration within one hop (~11.6ms); and mean
  within-segment stability within 1.0c.

Those tolerances are intentionally much tighter than the project's
user-facing ~5c perceptual threshold: they are implementation-parity
guards, not musical-acceptability thresholds. At the same time, they avoid
being unrealistically bit-for-bit by allowing the tiny floating-point and
interpolation differences that can exist between C++ and JS math on the
same algorithm.

## Numbers

Unchanged from Phase 3 (same code, same algorithm, same validated
constants) -- see `packages/dsp-native/CLAUDE.md`'s "Numbers" section for
the underlying C++ reference numbers this port was validated against.
This package's own `timing.test.ts` re-confirms per-frame compute cost
(YIN + harmonicity + onset + clip, 2048-sample frame) comfortably fits
inside the ~11.6ms hop budget when run in Node via Vitest -- see that
file's own doc comment for exactly what this does and doesn't prove about
either consuming app's _real_ runtime environment (V8 in Electron's
renderer/worklet for desktop; Hermes on-device for mobile -- neither is
literally reproduced by a Node/Vitest measurement).

## Commands

From the repo root:

- `pnpm --filter @violin/dsp-ts test` — run the full Vitest suite once
  (`vitest run`). **8 test files, 113 tests** after Phase 8, including the
  shared-fixture conformance suite against `packages/dsp-native`'s YIN
  reference outputs.
- `pnpm --filter @violin/dsp-ts test:watch` — Vitest watch mode.
- `pnpm --filter @violin/dsp-ts typecheck` — `tsc --noEmit` (this
  package's own, non-worklet-restricted tsconfig — see "Why this package
  is safe to share..." above for where the _stricter_ worklet-scope check
  actually lives).
- `pnpm test` / `pnpm typecheck` / `pnpm lint` from the repo root also
  cover this package (via `pnpm -r --if-present`) alongside every other
  workspace package.

## Verification performed during the Phase 4 promotion

- `pnpm --filter @violin/dsp-ts test` — 37/37 passing from the new location
  (same count as `apps/desktop`'s pre-move 37).
- `pnpm --filter @violin/dsp-ts typecheck` and
  `pnpm --filter @violin/desktop typecheck` (both the main and
  `tsconfig.worklet.json` projects) — all clean after switching
  `apps/desktop`'s import from a relative path to `@violin/dsp-ts`.
- `tsc --noEmit -p apps/desktop/tsconfig.worklet.json --listFiles | grep
dsp-ts` — confirmed this package's actual `src/*.ts` files are pulled into
  that restricted compilation, i.e. the worklet-scope safety guarantee is
  still real, not merely assumed, after the move.
- `pnpm --filter @violin/desktop run package` (a full production Electron
  build) — succeeded; the packaged app's asar archive was inspected
  directly (`npx @electron/asar list`) and confirmed to contain a single
  bundled `pitch-worklet-processor-<hash>.js` chunk whose content includes
  this package's actual compiled logic (`registerProcessor`,
  `yinThreshold` both found in the bundled output), proving Vite's
  `?worker&url` bundling mechanism (see `apps/desktop/CLAUDE.md`'s "Vite
  worklet-loading gotcha") correctly resolves and bundles a workspace
  package's raw TypeScript source the same way it already did for a local
  relative path.
- Whole-repo `pnpm typecheck` / `pnpm lint` / `pnpm format:check` /
  `pnpm test` all re-run clean after the move (see root `CLAUDE.md`).

## Verification performed during the Phase 8 conformance work

- `pnpm --filter @violin/dsp-ts run test` — **113/113 passing** (37 -> 113:
  +1 new test file, +76 new tests).
- `pnpm build:dsp-native && pnpm test:dsp-native` — re-confirmed the C++
  reference harness still passes and the checked-in reference CSV snapshots
  match a current validated run.
- Whole-repo `pnpm typecheck` / `pnpm lint` / `pnpm format:check` /
  `pnpm test` all re-run clean after adding the suite (see root
  `CLAUDE.md` for the repo-wide counts).

## Code navigation: CodeGraph

This repo has a CodeGraph index at `../../.codegraph/` (see root
`CLAUDE.md`). Reach for `codegraph_explore` / `codegraph explore` before
grep/find when tracing how `HopBuffer.push` -> `PitchAnalysisPipeline.analyzeFrame`
data flows, or how each consuming app's own capture glue
(`apps/desktop/src/audio/pitch-worklet-processor.ts`,
`apps/mobile/src/audio/mic-capture-controller.ts`) constructs and drives
this package's classes.
