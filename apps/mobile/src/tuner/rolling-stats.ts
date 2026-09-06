/**
 * Small rolling-window mean tracker for the debug panel's compute-time
 * readout -- the mobile analogue of apps/desktop/src/renderer.ts's own
 * `RollingStats` class, trimmed down to just `last`/`mean`.
 *
 * Desktop's fuller `RollingStats` also tracks stddev/p99 across three
 * separate metrics (hop compute time, worklet->main relay latency, hop
 * arrival cadence) -- none of the latter two apply here: mobile's
 * `MicCaptureController` delivers analysis results from a single JS-thread
 * event callback (see that file's own doc comment on "DSP hosting: event
 * callback, not a worklet"), so there is no separate audio-thread-vs-
 * main-thread relay to measure, and no real device is available in this
 * phase to make hop-arrival-jitter numbers meaningful. Only per-hop
 * compute time (`MobileAnalysisResult.computeTimeMs`) is genuinely
 * comparable across hops here, so this class only tracks that.
 *
 * Extracted as its own pure, dependency-free class (rather than inline
 * `useRef`/`useState` array math in FingerTunerScreen.tsx, which is how
 * the Phase 4 debug UI originally did it) so the windowing/averaging
 * logic itself is independently unit-testable, per this phase's
 * verification requirement that new display-derivation logic gets real
 * tests -- see rolling-stats.test.ts.
 */

/** Matches apps/desktop/src/renderer.ts's `STATS_WINDOW` (~2.3s of hops at the validated 11.6ms desktop cadence; mobile's own hop cadence differs slightly per mic-capture-controller.ts's `CAPTURE_BUFFER_LENGTH` comment, but the same window size is a reasonable, easy-to-compare default). */
export const DEFAULT_ROLLING_STATS_WINDOW = 200;

export class RollingStats {
  private readonly values: number[] = [];

  constructor(private readonly windowSize: number = DEFAULT_ROLLING_STATS_WINDOW) {
    if (!Number.isInteger(windowSize) || windowSize <= 0) {
      throw new RangeError(
        `RollingStats: windowSize must be a positive integer, got ${windowSize}`,
      );
    }
  }

  /** Non-finite values (NaN/+-Infinity) are silently ignored -- a defensive measure mirroring desktop's own RollingStats.push, so one bad measurement never poisons mean/last. */
  push(value: number): void {
    if (!Number.isFinite(value)) return;
    this.values.push(value);
    if (this.values.length > this.windowSize) {
      this.values.shift();
    }
  }

  get count(): number {
    return this.values.length;
  }

  get last(): number | undefined {
    return this.values.at(-1);
  }

  get mean(): number | undefined {
    if (this.values.length === 0) return undefined;
    return this.values.reduce((sum, v) => sum + v, 0) / this.values.length;
  }

  /** Discards all history -- called whenever a capture session (re)starts, mirroring the framesAnalyzed-reset apps/desktop's own start button does. */
  reset(): void {
    this.values.length = 0;
  }
}
