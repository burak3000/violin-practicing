/**
 * Minimal ambient type declarations for `AudioWorkletGlobalScope` -- the
 * restricted global scope `AudioWorkletProcessor` subclasses run in: own
 * thread, real-time audio-rendering priority, NO DOM, NO Node.js APIs, and
 * (per Hard Rule 3 of this phase) no native addons can be loaded there
 * either. See apps/desktop/CLAUDE.md's "DSP binding decision" section for
 * the full writeup of why this constraint shaped this phase's
 * architecture.
 *
 * TypeScript's built-in "DOM" lib does NOT include these -- they belong to
 * a genuinely different global object than `Window`, the same way
 * `lib: ["webworker"]` is a separate alternate lib for classic Web
 * Workers (there is no built-in `"audioworklet"` lib option). Rather than
 * add a third-party `@types/audioworklet` dependency for a handful of
 * names, this project declares just what `pitch-worklet-processor.ts`
 * actually uses.
 *
 * IMPORTANT: this file (and pitch-worklet-processor.ts, and everything it
 * imports from ../dsp/**) is typechecked ONLY via `tsconfig.worklet.json`
 * -- a separate `tsc` project with NO "DOM" lib and NO auto-included
 * `@types/*` packages (see that file's own comment), so these
 * declarations are the ONLY globals visible there. It is deliberately
 * EXCLUDED from the main `tsconfig.json` (which has "DOM"), because DOM's
 * own (incompatible) `performance`/`MessagePort` globals would otherwise
 * collide with these. Don't add this file to the main tsconfig's
 * `include` -- see apps/desktop/CLAUDE.md.
 */

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;

/** The owning AudioContext's sample rate (Hz) -- constant for the worklet's lifetime. */
declare const sampleRate: number;
/** AudioContext-clock time (seconds) as of the start of the current render quantum. Not comparable to `performance.now()` -- see worklet-messages.ts. */
declare const currentTime: number;
/** AudioContext-clock sample count as of the start of the current render quantum. */
declare const currentFrame: number;

/** Real in Chromium/Electron's AudioWorkletGlobalScope; used here only for the worklet-local compute-time measurement in pitch-worklet-processor.ts. */
declare const performance: { now(): number };

/** Only the one method this codebase actually calls -- not a full DOM MessagePort. */
interface MessagePort {
  postMessage(message: unknown): void;
}
