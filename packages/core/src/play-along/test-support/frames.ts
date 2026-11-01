/**
 * Test-only helpers for the session tests: a model of "what the pitch detector
 * reports" over time, and a driver that feeds it to a `PlayAlongSession` at the
 * real analysis hop (512 samples at 44.1 kHz = ~11.6 ms).
 */

import { midiToFrequencyHz } from '../../note/note.js';
import type { PitchReading } from '../../scoring/scoring.js';
import type { PlayAlongPlan } from '../play-along-plan.js';
import type { PlayAlongSession, PlayAlongUpdate } from '../play-along-session.js';

/** The real analysis hop. */
export const HOP_MS = 11.6;

/** Detector output in plan time: `frequencyHz` is sounding over `[fromMs, toMs)`; everywhere else it is silent. */
export interface Sounding {
  readonly fromMs: number;
  readonly toMs: number;
  readonly frequencyHz: number;
  /** Detector confidence; default 1. */
  readonly confidence?: number;
}

export const SILENCE: PitchReading = { voiced: false, frequencyHz: 0, confidence: 0 };

export function voicedAt(frequencyHz: number, confidence = 1): PitchReading {
  return { voiced: true, frequencyHz, confidence };
}

/** Frequency of a MIDI note, with an optional detune in cents (positive = sharp). */
export function hz(midi: number, cents = 0): number {
  return midiToFrequencyHz(midi + cents / 100);
}

export interface PerformanceOptions {
  /**
   * How late the whole performance is relative to a perfect player, in plan ms,
   * **on top of** the detector lag. Default 0 = a perfect player: the bow lands
   * on the click and the detector reports it `detectionLagMs` later.
   */
  readonly lateMs?: number;
  /** The detector lag the "perfect" player incurs. Default 60 (the session default). */
  readonly detectionLagMs?: number;
  /** Silence at the end of each note (articulation), ms. Default 0. */
  readonly gapMs?: number;
  /** Per-note overrides: late offset (ms), detune (cents), pitch change (semitones), or `skip`. */
  readonly perNote?: Readonly<
    Record<
      number,
      {
        readonly lateMs?: number;
        readonly cents?: number;
        readonly semitones?: number;
        readonly skip?: boolean;
        /** Play only the first `holdMs` ms of the note. */
        readonly holdMs?: number;
      }
    >
  >;
}

/** What the detector reports for a player performing every note of `plan`. */
export function performPlan(plan: PlayAlongPlan, options: PerformanceOptions = {}): Sounding[] {
  const lag = options.detectionLagMs ?? 60;
  const sounding: Sounding[] = [];
  for (const note of plan.notes) {
    const override = options.perNote?.[note.index];
    if (override?.skip) continue;
    const late = override?.lateMs ?? options.lateMs ?? 0;
    const fromMs = note.onsetMs + lag + late;
    const full = note.endMs - note.onsetMs - (options.gapMs ?? 0);
    const toMs = fromMs + (override?.holdMs ?? full);
    sounding.push({
      fromMs,
      toMs,
      frequencyHz: hz(note.midi + (override?.semitones ?? 0), override?.cents ?? 0),
    });
  }
  return sounding;
}

/** The detector reading at plan time `tMs` for a set of sounding intervals (later entries win on overlap). */
export function readingAt(sounding: readonly Sounding[], tMs: number): PitchReading {
  let reading: PitchReading = SILENCE;
  for (const s of sounding) {
    if (tMs >= s.fromMs && tMs < s.toMs) {
      reading = voicedAt(s.frequencyHz, s.confidence ?? 1);
    }
  }
  return reading;
}

export interface Run {
  readonly updates: PlayAlongUpdate[];
  /** Plan time of each update, parallel to `updates`. */
  readonly times: number[];
}

/**
 * Starts `session` at `zeroMs` and feeds frames on a hop grid from `fromMs` to
 * `toMs` (plan time, inclusive of `fromMs`), the detector output being
 * `sounding`. Returns every update.
 */
export function runSession(
  session: PlayAlongSession,
  sounding: readonly Sounding[],
  options: { zeroMs?: number; fromMs?: number; toMs: number; hopMs?: number; start?: boolean },
): Run {
  const zeroMs = options.zeroMs ?? 1_000_000;
  const hop = options.hopMs ?? HOP_MS;
  const fromMs = options.fromMs ?? -session.plan.countInMs;
  if (options.start !== false) session.start(zeroMs);
  const updates: PlayAlongUpdate[] = [];
  const times: number[] = [];
  for (let k = 0; fromMs + k * hop <= options.toMs; k++) {
    const t = fromMs + k * hop;
    updates.push(session.update(readingAt(sounding, t), zeroMs + t));
    times.push(t);
  }
  return { updates, times };
}

/** Plan time of the end of the piece plus enough slack for every deadline to pass. */
export function endOfPiece(plan: PlayAlongPlan): number {
  return plan.totalMs + 1500;
}

/** Every note result of a run, flattened from the per-update `resolved` lists. */
export function allResolved(run: Run): PlayAlongUpdate['resolved'][number][] {
  return run.updates.flatMap((u) => [...u.resolved]);
}
