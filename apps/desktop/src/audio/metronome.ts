/**
 * The audible click for the timed ABC play-along (desktop).
 *
 * Plays short woodblock-like ticks through a Web Audio `AudioContext` of its
 * own -- deliberately *not* the capture pipeline's context (see
 * `capture-pipeline.ts`): that graph is analysis-only and muted, and sharing it
 * would couple the click's lifetime and latency hints to the pitch worklet's.
 * Playback and capture are independent on desktop (the click goes to the
 * default output, the instrument arrives on the input interface), so unlike on
 * mobile there is no shared audio-session category to worry about.
 *
 * ## Clocks
 *
 * `ClickScheduler` (packages/core) says *when* each click is due, in the same
 * millisecond clock the pitch frames carry (`Date.now()` on desktop: the
 * worklet stamps frames with it, see `apps/desktop/CLAUDE.md`). Web Audio plays
 * things at a time on its own audio clock (`ctx.currentTime`), so each click
 * is converted at the moment it is scheduled -- one fresh reading of both
 * clocks per click, so the two clocks can drift apart over a long session
 * without the error ever accumulating. The click is then sounded exactly at
 * that audio time regardless of main-thread jitter.
 *
 * ## Output latency
 *
 * What the player *hears* lags what is scheduled by the device's output
 * latency, and a player follows what they hear. `outputLatencyMs` lets the
 * play-along shift its scoring window by the same amount so the "beat" it
 * judges against is the beat that was heard. (Browsers report 0 when they do
 * not know; Bluetooth headphones add far more than any browser reports, which
 * is why the UI offers a way around: turn the click off and use the visual
 * beat, or use wired output.)
 */

/** Pitch of a normal beat and of the first beat of a bar, in Hz. A fifth apart so the downbeat is unmistakable at any tempo. */
const BEAT_HZ = 1000;
const ACCENT_HZ = 1500;
/** Peak gain of a click. Loud enough to hear over a violin practiced next to the speaker, well clear of clipping. */
const BEAT_GAIN = 0.35;
const ACCENT_GAIN = 0.55;
/** A click is a short sine burst with an instant attack and an exponential decay; ~40ms reads as a tick rather than a beep. */
const CLICK_DURATION_S = 0.04;
const ATTACK_S = 0.001;
/**
 * How long `prepare` waits for the audio context to start before giving up. A
 * context normally resumes within a few ms of a user gesture, but in some hosts
 * (the in-app browser used to verify the UI) `resume()` simply never settles, and
 * the Start button must never hang on audio: after this the play-along runs
 * silent, on the visual beat alone.
 */
const PREPARE_TIMEOUT_MS = 1500;

/** `state` is re-read through a function so the compiler does not keep an earlier `'running'` check's narrowing across the `await` in `prepare`. */
function isRunning(context: AudioContext): boolean {
  return context.state === 'running';
}

export class Metronome {
  private context: AudioContext | undefined;
  /** Clicks handed to Web Audio and not finished yet, so `cancelPending` can silence the few already scheduled when a run is stopped. */
  private readonly pending = new Set<OscillatorNode>();

  /** `nowMs` must be the clock the click times are given in (desktop: `Date.now`). */
  constructor(private readonly nowMs: () => number = Date.now) {}

  /**
   * Creates (if needed) and resumes the audio context. Call from a user
   * gesture (the Start button): browsers keep a new context suspended until
   * then. Resolves `false` if audio output is unavailable or does not start
   * within `timeoutMs`, in which case `click` is a no-op and the visual beat is
   * all the player gets. Never rejects and never takes longer than the timeout.
   */
  async prepare(timeoutMs: number = PREPARE_TIMEOUT_MS): Promise<boolean> {
    try {
      this.context ??= new AudioContext({ latencyHint: 'interactive' });
      const context = this.context;
      if (isRunning(context)) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      try {
        await Promise.race([context.resume(), timedOut]);
      } finally {
        clearTimeout(timer);
      }
      return isRunning(context);
    } catch {
      return false;
    }
  }

  /** How long a scheduled sound takes to reach the player's ears, in ms (0 if the browser does not know). */
  get outputLatencyMs(): number {
    const context = this.context;
    if (!context) return 0;
    const seconds = (context.baseLatency || 0) + (context.outputLatency || 0);
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
  }

  /** Sounds a click at `atMs` (the frame clock). A click already in the past by more than a few ms is dropped rather than played late. */
  click(atMs: number, accent: boolean): void {
    const context = this.context;
    if (!context || context.state !== 'running') return;
    const when = context.currentTime + (atMs - this.nowMs()) / 1000;
    if (when < context.currentTime - 0.005) return;
    const start = Math.max(when, context.currentTime);

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = accent ? ACCENT_HZ : BEAT_HZ;
    const peak = accent ? ACCENT_GAIN : BEAT_GAIN;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peak, start + ATTACK_S);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + CLICK_DURATION_S);
    oscillator.connect(gain).connect(context.destination);
    this.pending.add(oscillator);
    oscillator.onended = () => {
      this.pending.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(start);
    oscillator.stop(start + CLICK_DURATION_S + 0.01);
  }

  /** Silences clicks that were handed to the audio engine but have not sounded yet (the look-ahead window): called when a run is stopped, so it does not keep ticking for a moment afterwards. */
  cancelPending(): void {
    for (const oscillator of this.pending) {
      try {
        oscillator.stop();
      } catch {
        // Already ended; nothing to cancel.
      }
    }
  }

  /** Releases the audio context. Safe to call more than once. */
  dispose(): void {
    this.cancelPending();
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }
}
