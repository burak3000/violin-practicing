/**
 * Play-along plan: turns a practicable ABC piece (`AbcPiece`, whole-note
 * positions, tempo-independent) into the *timeline* of a timed play-along --
 * when every note should start and end in milliseconds, and when the
 * metronome clicks (count-in included). This is the only place in the
 * play-along feature where a tempo enters; `PlayAlongSession` (scoring) and
 * both apps' metronome schedulers consume the result and never touch whole
 * notes or beats again.
 *
 * Pure TypeScript, no platform imports; building a plan is not a per-frame
 * path, so invalid arguments throw `RangeError` (nothing here runs per frame).
 *
 * ## Clock convention
 *
 * Plan time `t` is in milliseconds with **t = 0 at the start of the music**
 * (the first note or rest of the piece). Count-in beats therefore have
 * negative times. The caller maps plan time to its own clock with one number
 * (`PlayAlongSession.start(zeroMs)`), which differs per platform (epoch ms on
 * desktop, `performance.now()` on mobile).
 *
 * ## Tempo
 *
 * The user changes the tempo as "beats per minute of the piece's own tempo
 * beat" (`tempoBpm`, in terms of `piece.tempo.beatLengthWhole`: a dotted
 * quarter for a `Q:3/8=60` tune). That is turned into one ratio,
 * `tempoBpm / piece.tempo.bpm`, and every tempo mark in the piece is scaled by
 * it: a tune that speeds up mid-way still speeds up by the same factor at a
 * different overall pace. A tempo mark may be written in a different beat
 * unit than the opening one (`Q:1/4=120` then `[Q:3/8=80]`); each mark is
 * converted to whole notes per minute on its own
 * (`bpm * beatLengthWhole * ratio`), so mixed units are exact. The timeline is
 * piecewise linear: constant speed between tempo marks, with `msAtWhole` /
 * `wholeAtMs` as an exact pair of inverses (and extrapolating with the first /
 * last tempo outside the piece, so a count-in before it has real negative
 * times).
 *
 * ## The beat grid (the metronome) and pickups
 *
 * Beats are spaced `meter.beatLengthWhole` apart *within each meter segment*:
 * the opening `piece.meter`, then each `{ type: 'meter' }` element from its
 * position on. The grid of a segment is anchored at its **origin**:
 *
 *  - first segment: `piece.pickupWhole` -- the first FULL bar's downbeat (0 if
 *    the piece has no pickup);
 *  - later segments: the position of the meter-change element.
 *
 * Grid beats sit at `origin + j * beatLength` for every integer `j`; negative
 * `j` reach back before the origin (into the pickup bar, and before the music
 * for the count-in). The beat is a downbeat (accented) exactly when `j` is a
 * multiple of `beatsPerBar`; its number in the bar is `(j mod beatsPerBar) + 1`.
 * A segment's beats run until the next meter change, or the end of the music.
 *
 * Worked example -- 4/4, tempo quarter = 60 (1000 ms per beat), with a
 * one-quarter pickup (`pickupWhole` = 0.25) and the default count-in of one
 * bar (4 beats). Origin = 0.25, beat length = 0.25:
 *
 * ```
 * position (whole)  -1.00  -0.75  -0.50  -0.25   0.00   0.25   0.50  ...
 * plan time (ms)    -4000  -3000  -2000  -1000      0   1000   2000
 * grid j               -5     -4     -3     -2     -1      0      1
 * beat in bar           4      1      2      3      4      1      2
 * accent                       X                           X
 * what                 count-in clicks (4)         pickup  bar 1 downbeat
 * ```
 *
 * The pickup note sits at position 0, which is itself a grid beat (beat 4 of
 * the pickup bar), so it gets a click that coincides with the note -- exactly
 * as a metronome would play it. A pickup that is not a whole number of beats
 * (an eighth-note pickup in 4/4: origin 0.125) simply has no click at
 * position 0; the first click after it is the downbeat. Only grid beats at
 * position >= 0 belong to the music; the `countInBeats` nearest ones strictly
 * before position 0 are the count-in (`countIn: true`, bar number 0). Note
 * that for a pickup piece the default one-bar count-in starts one click
 * earlier than "counting to the pickup" would (`4 1 2 3` before a pickup on
 * beat 4); pass `countInBeats` explicitly for a shorter one.
 *
 * Bar numbers are the *human* ones: the pickup bar is 0 and the first full bar
 * is 1; with no pickup the first bar is 1. They come from the piece's own bar
 * starts (`barStartsWhole`), so they stay right across meter changes.
 */

import { WHOLE_EPSILON } from '../abc/abc-score.js';
import type {
  AbcMeter,
  AbcMeterElement,
  AbcPiece,
  AbcScoreElement,
  AbcTempoElement,
} from '../abc/abc-score.js';
import { formatSpellingLabel } from '../notation/note-spelling.js';
import { staffSpellingOf } from '../sequence/sequence-generator.js';

/**
 * Safety cap on the number of metronome beats in one plan. A real piece has
 * hundreds to a few thousand (a 300-bar 12/8 piece is 600 beats); the cap
 * exists only so a corrupt meter (`M:1/1000000`) fails with a clear error
 * instead of allocating until the tab dies.
 */
export const MAX_PLAN_BEATS = 50_000;

export interface PlayAlongPlanOptions {
  /** Beats per minute of the piece's own tempo beat (`piece.tempo.beatLengthWhole`). Default `piece.tempo.bpm`. Must be finite and > 0, else `RangeError`. */
  readonly tempoBpm?: number;
  /** Metronome clicks before the music. Default `piece.meter.beatsPerBar` (one bar). 0 = none. Non-negative integer, else `RangeError`. */
  readonly countInBeats?: number;
}

export interface PlayAlongNote {
  /** Index into the piece's practice sequence (`piece.notes`). */
  readonly index: number;
  readonly midi: number;
  readonly frequencyHz: number;
  /** How the note reads on screen ("B♭4"), in the spelling the sheet uses. */
  readonly label: string;
  readonly startWhole: number;
  readonly durationWhole: number;
  /** Start of the note, in plan milliseconds (0 = start of the music). */
  readonly onsetMs: number;
  /** End of the note, in plan milliseconds. */
  readonly endMs: number;
  /** Human bar number: pickup bar = 0, first full bar = 1 (with no pickup, the first bar is 1). */
  readonly barNumber: number;
  /** 1-based beat in the bar, fractional, rounded to 2 decimals (the "and" of 2 is 2.5). */
  readonly beatInBar: number;
  /** Length of one metronome beat at this note, in ms (what lateness is judged against). */
  readonly beatMs: number;
}

export interface PlayAlongBeat {
  /** Plan time of the click, in ms (negative for the count-in). */
  readonly tMs: number;
  readonly countIn: boolean;
  /** True on beat 1 of a bar. */
  readonly accent: boolean;
  /** 1-based, integer. */
  readonly beatInBar: number;
  /** Human bar number; 0 for count-in beats. */
  readonly barNumber: number;
}

export interface PlayAlongPlan {
  readonly notes: readonly PlayAlongNote[];
  /** Count-in beats first (`tMs < 0`, ascending), then every grid beat until the end of the music. */
  readonly beats: readonly PlayAlongBeat[];
  /** Time from the first count-in beat to the start of the music; 0 when there is no count-in. */
  readonly countInMs: number;
  /** End of the last note/rest, in plan ms. */
  readonly totalMs: number;
  /** The tempo the plan was built at, in beats per minute of the piece's tempo beat. */
  readonly tempoBpm: number;
  /** The piece's own tempo (`piece.tempo.bpm`). */
  readonly fileTempoBpm: number;
  /** `tempoBpm / fileTempoBpm`: 1 = as written, 0.5 = half speed. */
  readonly tempoRatio: number;
  /** Whole-note position -> plan ms. Piecewise linear through tempo changes; extrapolates outside the piece with the first / last tempo (so a negative position gives negative ms). */
  msAtWhole(whole: number): number;
  /** Inverse of `msAtWhole`. */
  wholeAtMs(ms: number): number;
}

// --- Validation helpers ---------------------------------------------------------

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isTempoElement(element: AbcScoreElement): element is AbcTempoElement {
  return element.type === 'tempo';
}

function isMeterElement(element: AbcScoreElement): element is AbcMeterElement {
  return element.type === 'meter';
}

function checkMeter(meter: AbcMeter, where: string): void {
  if (
    !isPositiveFinite(meter.beatLengthWhole) ||
    !Number.isInteger(meter.beatsPerBar) ||
    meter.beatsPerBar < 1
  ) {
    throw new RangeError(
      `buildPlayAlongPlan: ${where} has an unusable meter (beatLengthWhole=${meter.beatLengthWhole}, beatsPerBar=${meter.beatsPerBar})`,
    );
  }
}

/** Rounds to two decimals (beat positions: 2.5, 1.33). */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Largest index `i` with `values[i] <= x`, or -1 if there is none. `values` ascending. */
function lastIndexAtOrBefore(values: readonly number[], x: number): number {
  let lo = 0;
  let hi = values.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! <= x) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

// --- Tempo timeline -------------------------------------------------------------

interface TempoTimeline {
  msAtWhole(whole: number): number;
  wholeAtMs(ms: number): number;
}

/**
 * Builds the piecewise-linear whole-note <-> millisecond mapping.
 *
 * Segment 0 starts at whole 0 with `piece.tempo`; every tempo element then
 * starts a new segment at its position. A tempo element at (or before) 0, or at
 * the same position as the previous one, *replaces* that segment's tempo
 * (the later mark wins, as in a score). A mark whose `bpm` or `beatLengthWhole`
 * is not finite and positive is ignored rather than aborting the whole plan:
 * the parser should never produce one, and "keep the previous tempo" is the
 * only sensible reading of a mark we cannot interpret.
 */
function buildTempoTimeline(piece: AbcPiece, ratio: number): TempoTimeline {
  const starts: number[] = [0];
  const msPerWhole: number[] = [60000 / (piece.tempo.bpm * piece.tempo.beatLengthWhole * ratio)];

  const tempoElements = piece.elements
    .filter(isTempoElement)
    // Array.prototype.sort is stable (ES2019): equal positions keep file order.
    .sort((a, b) => a.at - b.at);

  for (const el of tempoElements) {
    const { bpm, beatLengthWhole } = el.mark;
    if (!isPositiveFinite(bpm) || !isPositiveFinite(beatLengthWhole) || !Number.isFinite(el.at)) {
      continue;
    }
    const at = Math.max(0, el.at);
    const wholeNotesPerMinute = bpm * beatLengthWhole * ratio;
    const last = starts.length - 1;
    if (at - starts[last]! <= WHOLE_EPSILON) {
      msPerWhole[last] = 60000 / wholeNotesPerMinute;
    } else {
      starts.push(at);
      msPerWhole.push(60000 / wholeNotesPerMinute);
    }
  }

  // startMs[k]: plan time at which segment k begins.
  const startMs: number[] = [0];
  for (let k = 1; k < starts.length; k++) {
    startMs.push(startMs[k - 1]! + (starts[k]! - starts[k - 1]!) * msPerWhole[k - 1]!);
  }

  return {
    msAtWhole(whole: number): number {
      // Before the first segment (negative positions) -> segment 0, extrapolated.
      const k = Math.max(0, lastIndexAtOrBefore(starts, whole));
      return startMs[k]! + (whole - starts[k]!) * msPerWhole[k]!;
    },
    wholeAtMs(ms: number): number {
      const k = Math.max(0, lastIndexAtOrBefore(startMs, ms));
      return starts[k]! + (ms - startMs[k]!) / msPerWhole[k]!;
    },
  };
}

// --- Beat grid ------------------------------------------------------------------

/** One stretch of constant meter: where its grid is anchored and how it ticks. */
interface GridSegment {
  /** Position of beat 1 of a bar in this segment (grid index j = 0). */
  readonly origin: number;
  readonly beatLengthWhole: number;
  readonly beatsPerBar: number;
}

/**
 * The meter segments of a piece, ascending. Segment 0 is `piece.meter`,
 * anchored at the first full bar. Meter elements at (or before) position 0 are
 * the declaration of that same opening meter -- `piece.meter` is authoritative
 * -- and are skipped; any other meter element starts a segment at its own
 * position (a second element at the same position replaces the first).
 */
function buildGridSegments(piece: AbcPiece, pickupWhole: number): GridSegment[] {
  checkMeter(piece.meter, 'the opening meter');
  const segments: GridSegment[] = [
    {
      origin: pickupWhole,
      beatLengthWhole: piece.meter.beatLengthWhole,
      beatsPerBar: piece.meter.beatsPerBar,
    },
  ];
  const meterElements = piece.elements
    .filter(isMeterElement)
    .filter((el) => Number.isFinite(el.at) && el.at > WHOLE_EPSILON)
    .sort((a, b) => a.at - b.at);
  for (const el of meterElements) {
    checkMeter(el.meter, `the meter change at ${el.at}`);
    const next: GridSegment = {
      origin: el.at,
      beatLengthWhole: el.meter.beatLengthWhole,
      beatsPerBar: el.meter.beatsPerBar,
    };
    const last = segments.length - 1;
    // Replace only a *later* segment: a change exactly at the pickup's end is a
    // real second segment (the pickup bar keeps the opening meter's grid).
    if (last >= 1 && Math.abs(el.at - segments[last]!.origin) <= WHOLE_EPSILON) {
      segments[last] = next;
    } else {
      segments.push(next);
    }
  }
  return segments;
}

/** The segment whose grid governs a position: the last one whose origin has been reached. */
function gridSegmentAt(segments: readonly GridSegment[], position: number): GridSegment {
  for (let k = segments.length - 1; k >= 1; k--) {
    if (segments[k]!.origin <= position + WHOLE_EPSILON) {
      return segments[k]!;
    }
  }
  return segments[0]!;
}

/** Smallest grid index `j` whose beat is at position >= 0 (within the epsilon). */
function firstMusicBeatIndex(origin: number, beatLength: number): number {
  let j = Math.ceil(-origin / beatLength);
  // Division and ceil can be off by one at exact boundaries; settle it with the real positions.
  while (origin + (j - 1) * beatLength >= -WHOLE_EPSILON) j--;
  while (origin + j * beatLength < -WHOLE_EPSILON) j++;
  return j;
}

/** Number of the beat within its bar (0-based), for grid index `j`. */
function beatSlot(j: number, beatsPerBar: number): number {
  return ((j % beatsPerBar) + beatsPerBar) % beatsPerBar;
}

/** Human bar number of a position (pickup bar 0, first full bar 1), from the piece's own bar starts. */
function makeBarNumberAt(piece: AbcPiece, hasPickup: boolean): (position: number) => number {
  const starts = piece.barStartsWhole;
  return (position) => {
    // An empty list should not happen (the contract says [0] is always there);
    // treat the whole piece as one bar rather than guessing.
    const index = Math.max(0, lastIndexAtOrBefore(starts, position + WHOLE_EPSILON));
    return index + (hasPickup ? 0 : 1);
  };
}

// --- The plan -------------------------------------------------------------------

/**
 * Builds the play-along timeline for `piece`. See the module comment for the
 * tempo, beat-grid and pickup conventions.
 *
 * @throws RangeError for a non-finite / non-positive `tempoBpm`, a negative or
 *   non-integer `countInBeats`, an unusable tempo or meter in the piece, a
 *   piece whose `notes` and `noteElements` disagree, or more than
 *   `MAX_PLAN_BEATS` beats.
 */
export function buildPlayAlongPlan(
  piece: AbcPiece,
  options: PlayAlongPlanOptions = {},
): PlayAlongPlan {
  const fileTempoBpm = piece.tempo.bpm;
  if (!isPositiveFinite(fileTempoBpm) || !isPositiveFinite(piece.tempo.beatLengthWhole)) {
    throw new RangeError(
      `buildPlayAlongPlan: the piece's tempo is unusable (bpm=${fileTempoBpm}, beatLengthWhole=${piece.tempo.beatLengthWhole})`,
    );
  }
  const tempoBpm = options.tempoBpm ?? fileTempoBpm;
  if (!isPositiveFinite(tempoBpm)) {
    throw new RangeError(`buildPlayAlongPlan: tempoBpm must be finite and > 0, got ${tempoBpm}`);
  }
  const countInBeats = options.countInBeats ?? piece.meter.beatsPerBar;
  if (!Number.isInteger(countInBeats) || countInBeats < 0) {
    throw new RangeError(
      `buildPlayAlongPlan: countInBeats must be a non-negative integer, got ${countInBeats}`,
    );
  }
  if (piece.notes.length !== piece.noteElements.length) {
    throw new RangeError(
      `buildPlayAlongPlan: piece has ${piece.notes.length} notes but ${piece.noteElements.length} note elements`,
    );
  }

  const tempoRatio = tempoBpm / fileTempoBpm;
  const timeline = buildTempoTimeline(piece, tempoRatio);
  const { msAtWhole, wholeAtMs } = timeline;

  const pickupWhole =
    Number.isFinite(piece.pickupWhole) && piece.pickupWhole > WHOLE_EPSILON ? piece.pickupWhole : 0;
  const hasPickup = pickupWhole > 0;
  const barNumberAt = makeBarNumberAt(piece, hasPickup);
  const segments = buildGridSegments(piece, pickupWhole);

  // --- Notes ---
  const notes: PlayAlongNote[] = piece.noteElements.map((element, index) => {
    const note = piece.notes[index]!;
    const segment = gridSegmentAt(segments, element.start);
    const beatLength = segment.beatLengthWhole;

    // Fractional beat index within the bar, snapped when it is a whole beat to within the epsilon.
    const { beatsPerBar } = segment;
    let slot =
      ((((element.start - segment.origin) / beatLength) % beatsPerBar) + beatsPerBar) % beatsPerBar;
    const nearest = Math.round(slot);
    if (Math.abs(slot - nearest) * beatLength <= WHOLE_EPSILON) {
      slot = nearest % beatsPerBar;
    }

    const onsetMs = msAtWhole(element.start);
    return {
      index,
      midi: note.note.midi,
      frequencyHz: note.frequencyHz,
      label: formatSpellingLabel(staffSpellingOf(note)),
      startWhole: element.start,
      durationWhole: element.duration,
      onsetMs,
      endMs: msAtWhole(element.start + element.duration),
      barNumber: barNumberAt(element.start),
      beatInBar: round2(slot + 1),
      beatMs: msAtWhole(element.start + beatLength) - onsetMs,
    };
  });

  // --- Beats ---
  const beats: PlayAlongBeat[] = [];
  const totalWhole = Number.isFinite(piece.totalWhole) ? piece.totalWhole : 0;
  let expectedBeats = 0;
  for (let k = 0; k < segments.length; k++) {
    const segment = segments[k]!;
    const from = k === 0 ? 0 : segment.origin;
    const to = k + 1 < segments.length ? segments[k + 1]!.origin : totalWhole;
    expectedBeats += Math.max(0, (to - from) / segment.beatLengthWhole);
  }
  if (expectedBeats + countInBeats > MAX_PLAN_BEATS) {
    throw new RangeError(
      `buildPlayAlongPlan: the piece would need ${Math.ceil(expectedBeats)} metronome beats (limit ${MAX_PLAN_BEATS}); is its meter corrupt?`,
    );
  }

  // Count-in: the nearest `countInBeats` grid beats of the first segment before position 0.
  const first = segments[0]!;
  const firstMusicJ = firstMusicBeatIndex(first.origin, first.beatLengthWhole);
  for (let j = firstMusicJ - countInBeats; j < firstMusicJ; j++) {
    const slot = beatSlot(j, first.beatsPerBar);
    beats.push({
      tMs: msAtWhole(first.origin + j * first.beatLengthWhole),
      countIn: true,
      accent: slot === 0,
      beatInBar: slot + 1,
      barNumber: 0,
    });
  }
  const countInMs = beats.length > 0 ? -beats[0]!.tMs : 0;

  // Music beats, segment by segment.
  for (let k = 0; k < segments.length; k++) {
    const segment = segments[k]!;
    const end = k + 1 < segments.length ? segments[k + 1]!.origin : totalWhole;
    let j = k === 0 ? firstMusicJ : 0;
    for (;;) {
      const position = segment.origin + j * segment.beatLengthWhole;
      if (position >= end - WHOLE_EPSILON) break;
      if (beats.length > MAX_PLAN_BEATS) {
        throw new RangeError(`buildPlayAlongPlan: more than ${MAX_PLAN_BEATS} metronome beats`);
      }
      const slot = beatSlot(j, segment.beatsPerBar);
      const clamped = Math.max(0, position); // a beat a hair before 0 is the beat at 0
      beats.push({
        tMs: msAtWhole(clamped),
        countIn: false,
        accent: slot === 0,
        beatInBar: slot + 1,
        barNumber: barNumberAt(clamped),
      });
      j++;
    }
  }

  return {
    notes,
    beats,
    countInMs,
    totalMs: msAtWhole(totalWhole),
    tempoBpm,
    fileTempoBpm,
    tempoRatio,
    msAtWhole,
    wholeAtMs,
  };
}
