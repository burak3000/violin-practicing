import { describe, expect, it } from 'vitest';
import { parseAbc } from '../abc/abc-parser.js';
import { buildAbcPracticeSequence } from '../abc/abc-practice.js';
import type { AbcPiece } from '../abc/abc-score.js';
import { buildPlayAlongPlan } from './play-along-plan.js';
import { PlayAlongSession } from './play-along-session.js';
import { summarizePlayAlongResults } from './play-along-summary.js';
import { HOP_MS, SILENCE, hz, voicedAt } from './test-support/frames.js';

/**
 * Does a *competent human*, not a mathematically perfect player, get scored
 * fairly? The session tests use exact synthetic performances; these add what a
 * real player and detector do -- notes that land a little early or late,
 * pitch that wobbles around the target, and now and then a frame the detector
 * drops -- on real tunes at several tempi. They pin the product promise ("a
 * player who is playing the piece reasonably is not marked down") and the
 * flip side (a player who is clearly not following is).
 *
 * The random numbers come from a seeded generator, so a failure is
 * reproducible, not flaky.
 */

const ODE_TO_JOY = `X:1
T:Ode to Joy
M:4/4
L:1/4
Q:1/4=100
K:D
F F G A | A G F E | D D E F | F3/2 E/2 E2 |
F F G A | A G F E | D D E F | E3/2 D/2 D2 |]
`;

const HAPPY_BIRTHDAY_PICKUP = `X:1
T:Pickup waltz
M:3/4
L:1/4
Q:1/4=90
K:G
D | G3/2 D/2 E | G2 c | B3 | D3/2 D/2 | G2 A | G2 d | c3 |]
`;

const SCALE_EIGHTHS = `X:1
T:Scale in eighths
M:4/4
L:1/8
Q:1/4=60
K:G
G, A, B, C D E F G | A B c d e f g f | e d c B A G F E | D C B, A, G, |]
`;

function pieceOf(abc: string): AbcPiece {
  const tune = parseAbc(abc).tunes[0]!;
  const built = buildAbcPracticeSequence(tune);
  if (built.status !== 'ok') throw new Error(`expected ok, got ${built.status}`);
  return built.piece;
}

/** Small deterministic PRNG (mulberry32) and a Box-Muller normal on top. */
function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = (sigma: number) => {
    const u = Math.max(uniform(), 1e-12);
    return sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uniform());
  };
  return { uniform, normal };
}

interface Player {
  /** Standard deviation of how far each onset lands from the beat, ms. */
  readonly onsetJitterMs: number;
  /** A constant lead (negative) or lag (positive) of the whole performance, ms. */
  readonly biasMs: number;
  /** Standard deviation of each note's pitch error, cents. */
  readonly pitchSigmaCents: number;
  /** Probability that any single frame is dropped by the detector. */
  readonly dropoutRate: number;
  /** Fraction of the note's length that is actually sounded (the rest is the gap before the next). */
  readonly sustain?: number;
}

const COMPETENT: Player = {
  onsetJitterMs: 30,
  biasMs: 0,
  pitchSigmaCents: 8,
  dropoutRate: 0.005,
  sustain: 0.92,
};

/** Runs a simulated performance of the whole plan and returns the summary. */
function perform(piece: AbcPiece, tempoBpm: number, player: Player, seed: number) {
  const plan = buildPlayAlongPlan(piece, { tempoBpm });
  const session = new PlayAlongSession(plan);
  const random = rng(seed);
  const lag = 60; // the detector's lag the session assumes -- a competent player triggers the detector this long after the bow lands

  const intervals = plan.notes.map((note) => {
    const length = note.endMs - note.onsetMs;
    const from = note.onsetMs + player.biasMs + random.normal(player.onsetJitterMs) + lag;
    const to = from + Math.max(40, length * (player.sustain ?? 1)) - lag * 0;
    return {
      from,
      to: Math.min(to, note.endMs + player.biasMs + lag - 20),
      frequencyHz: hz(note.midi, random.normal(player.pitchSigmaCents)),
    };
  });

  const zeroMs = 1_000_000;
  session.start(zeroMs);
  for (let t = -plan.countInMs; t <= plan.totalMs + 1500; t += HOP_MS) {
    let reading = SILENCE;
    for (const interval of intervals) {
      if (t >= interval.from && t < interval.to) reading = voicedAt(interval.frequencyHz);
    }
    if (reading.voiced && random.uniform() < player.dropoutRate) reading = SILENCE;
    session.update(reading, zeroMs + t);
  }
  return summarizePlayAlongResults(session.results);
}

describe('a competent player is scored fairly', () => {
  for (const [name, abc, tempos] of [
    ['Ode to Joy', ODE_TO_JOY, [50, 80, 100, 120]],
    ['a waltz with a pickup', HAPPY_BIRTHDAY_PICKUP, [60, 90, 110]],
    ['a scale in eighth notes', SCALE_EIGHTHS, [40, 60, 80]],
  ] as const) {
    for (const tempo of tempos) {
      it(`${name} at ${tempo} bpm: at least 90% of the notes count (over several players)`, () => {
        const piece = pieceOf(abc);
        let totalHits = 0;
        let total = 0;
        for (let seed = 1; seed <= 6; seed += 1) {
          const summary = perform(piece, tempo, COMPETENT, seed);
          totalHits += summary.hits;
          total += summary.total;
          expect(summary.pending).toBe(0);
        }
        expect(totalHits / total).toBeGreaterThanOrEqual(0.9);
      });
    }
  }

  it('a player who is consistently a little late (+100 ms) or early (-80 ms) still counts at a moderate tempo', () => {
    const piece = pieceOf(ODE_TO_JOY);
    for (const biasMs of [100, -80]) {
      let hits = 0;
      let total = 0;
      for (let seed = 1; seed <= 4; seed += 1) {
        const summary = perform(piece, 80, { ...COMPETENT, biasMs }, seed);
        hits += summary.hits;
        total += summary.total;
      }
      expect(hits / total).toBeGreaterThanOrEqual(0.85);
    }
  });

  it('reports a late tendency for a player who is consistently late', () => {
    const piece = pieceOf(ODE_TO_JOY);
    const summary = perform(piece, 80, { ...COMPETENT, biasMs: 110, onsetJitterMs: 15 }, 3);
    expect(summary.tendency).toBe('late');
    expect(summary.meanOffsetMs).toBeGreaterThan(60);
    expect(summary.meanOffsetMs).toBeLessThan(160);
  });
});

describe('a player who is not following the piece is not rewarded', () => {
  it('a player who is a whole beat late scores almost nothing', () => {
    const piece = pieceOf(ODE_TO_JOY);
    const beatMs = 60000 / 100;
    const summary = perform(piece, 100, { ...COMPETENT, biasMs: beatMs }, 1);
    // The tune repeats pitches, so a few notes can still land by coincidence; it must be a small minority.
    expect(summary.accuracy).toBeLessThan(0.35);
  });

  it('a player who is a semitone sharp on every note scores nothing', () => {
    const piece = pieceOf(ODE_TO_JOY);
    const summary = perform(piece, 100, { ...COMPETENT, pitchSigmaCents: 0 }, 1);
    expect(summary.hits).toBeGreaterThanOrEqual(27); // sanity: the same player, in tune, scores (30 notes)
    // 100 cents sharp is far outside the 25-cent tolerance.
    const plan = buildPlayAlongPlan(piece, { tempoBpm: 100 });
    const session = new PlayAlongSession(plan);
    session.start(0);
    for (let t = -plan.countInMs; t <= plan.totalMs + 1500; t += HOP_MS) {
      const note = plan.notes.find((n) => t >= n.onsetMs + 60 && t < n.endMs + 40);
      session.update(note ? voicedAt(hz(note.midi, 100)) : SILENCE, t);
    }
    expect(summarizePlayAlongResults(session.results).hits).toBe(0);
  });

  it('a silent run scores zero and every note reads "not played"', () => {
    const piece = pieceOf(ODE_TO_JOY);
    const plan = buildPlayAlongPlan(piece);
    const session = new PlayAlongSession(plan);
    session.start(0);
    for (let t = -plan.countInMs; t <= plan.totalMs + 1500; t += HOP_MS) session.update(SILENCE, t);
    const summary = summarizePlayAlongResults(session.results);
    expect(summary.hits).toBe(0);
    expect(summary.misses).toBe(plan.notes.length);
    expect(session.results.every((r) => r.status === 'missed' && r.reason === 'not-played')).toBe(
      true,
    );
  });
});
