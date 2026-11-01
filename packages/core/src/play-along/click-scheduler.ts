/**
 * Look-ahead scheduling for the play-along metronome click.
 *
 * ## Why not "click when a frame says a beat has passed"
 *
 * The pitch pipeline delivers an analysis frame roughly every 11.6ms, but
 * through the main thread, whose scheduling jitter easily reaches tens of
 * milliseconds under load. A click triggered by "the latest frame crossed a
 * beat" would wobble by that much, which is audible as an uneven metronome and
 * defeats the point of practicing to one. Audio APIs can instead play a sound
 * at a precise future *audio-clock* time, so the standard approach (Chris
 * Wilson's "A Tale of Two Clocks") is a coarse timer that wakes often and, each
 * time, hands the audio engine every click due within the next short window
 * ("look-ahead"). The timer's own jitter then only has to stay below the
 * look-ahead, not below the click's accuracy.
 *
 * This class is that coarse timer, kept free of any audio API: it knows only
 * *when* clicks are due (in the same millisecond clock the pitch frames are
 * stamped with) and calls `schedule(atMs, accent)` for each one exactly once.
 * The platform turns `atMs` into an audio-clock time and plays the sound
 * (desktop: a Web Audio oscillator; see `apps/desktop/src/audio/metronome.ts`).
 * Clock, timer and sink are injected, so it is testable without real time.
 */

export interface ScheduledClick {
  /** When the click should sound, in the platform's frame-timestamp clock (the same one `PlayAlongSession.start`'s `zeroMs` is in). */
  readonly atMs: number;
  /** True for the first beat of a bar (a higher, louder click). */
  readonly accent: boolean;
}

export interface ClickSchedulerOptions {
  readonly clicks: readonly ScheduledClick[];
  /** The current time in the same clock as `ScheduledClick.atMs`. */
  readonly now: () => number;
  /** Called once per click, as soon as it falls inside the look-ahead window (which may be a little after `atMs` if the first tick is late; never before the window). */
  readonly schedule: (atMs: number, accent: boolean) => void;
  /** How far ahead of `now()` to hand clicks over. Default `DEFAULT_CLICK_LOOKAHEAD_MS`. */
  readonly lookaheadMs?: number;
  /** How often the timer wakes. Default `DEFAULT_CLICK_TICK_MS`. Keep it well under `lookaheadMs`. */
  readonly tickMs?: number;
  /** Injected timer (defaults to the global `setInterval`/`clearInterval`), so tests can drive ticks by hand. */
  readonly setIntervalFn?: (callback: () => void, ms: number) => unknown;
  readonly clearIntervalFn?: (handle: unknown) => void;
}

/**
 * 150ms: long enough that a main thread stall of ~100ms (a busy frame, GC)
 * still leaves every click scheduled in time, short enough that stopping the
 * session cancels almost nothing that was already handed to the audio engine.
 */
export const DEFAULT_CLICK_LOOKAHEAD_MS = 150;

/** 25ms: a few ticks per look-ahead window, so one late tick cannot skip a click. */
export const DEFAULT_CLICK_TICK_MS = 25;

export class ClickScheduler {
  private readonly clicks: readonly ScheduledClick[];
  private readonly now: () => number;
  private readonly schedule: (atMs: number, accent: boolean) => void;
  private readonly lookaheadMs: number;
  private readonly tickMs: number;
  private readonly setIntervalFn: (callback: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  private nextIndex = 0;
  private handle: unknown;
  private running = false;

  constructor(options: ClickSchedulerOptions) {
    this.clicks = options.clicks;
    this.now = options.now;
    this.schedule = options.schedule;
    this.lookaheadMs = options.lookaheadMs ?? DEFAULT_CLICK_LOOKAHEAD_MS;
    this.tickMs = options.tickMs ?? DEFAULT_CLICK_TICK_MS;
    this.setIntervalFn =
      options.setIntervalFn ?? ((callback, ms) => globalThis.setInterval(callback, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
  }

  /** Starts ticking. Schedules whatever is already in the look-ahead window immediately. Does nothing if already running. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
    // The first tick may already have handed over the last click.
    if (this.running && this.nextIndex < this.clicks.length) {
      this.handle = this.setIntervalFn(() => this.tick(), this.tickMs);
    } else {
      this.running = false;
    }
  }

  /** Stops ticking. Clicks already handed to `schedule` cannot be recalled (the platform may cancel its own audio nodes). */
  stop(): void {
    if (this.handle !== undefined) this.clearIntervalFn(this.handle);
    this.handle = undefined;
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Clicks not yet handed to `schedule`. */
  get remaining(): number {
    return this.clicks.length - this.nextIndex;
  }

  /** One timer wake-up: hand over every click now inside the look-ahead window. Public so tests (and a platform that prefers its own timer) can drive it. */
  tick(): void {
    const horizon = this.now() + this.lookaheadMs;
    while (this.nextIndex < this.clicks.length) {
      const click = this.clicks[this.nextIndex]!;
      if (click.atMs > horizon) break;
      this.nextIndex += 1;
      this.schedule(click.atMs, click.accent);
    }
    if (this.nextIndex >= this.clicks.length && this.running) {
      // Nothing left: stop the timer by itself.
      this.stop();
    }
  }
}
