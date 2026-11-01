/**
 * Summary and wording helpers for the timed play-along, shared verbatim by
 * both apps so desktop and mobile say the same thing: the end-of-run summary
 * numbers, the tempo-mark text ("♩ = 120"), and the friendly one-line
 * description of each missed note.
 *
 * The audience is a beginner using a learning tool, so the phrasing is
 * encouraging and concrete ("late by 310 ms", "played the wrong note") rather
 * than clinical, and it never blames: a miss is something to practice.
 *
 * Pure functions, no platform imports, never throw (any input yields some
 * text), because they run while rendering.
 */

import { sameWhole } from '../abc/abc-score.js';
import type { AbcTempoMark } from '../abc/abc-score.js';
import type { PlayAlongNote } from './play-along-plan.js';
import type { PlayAlongNoteResult } from './play-along-session.js';

/** The true minus sign (U+2212), used for early offsets instead of a hyphen. */
const MINUS = '−';

/**
 * Mean timing offset (ms) beyond which a performance is called "early" or
 * "late" overall. 25 ms is about the smallest asynchrony listeners notice in
 * a steady pulse, and well inside the per-note tolerance (100-250 ms): a
 * player averaging +25 ms is genuinely steady, one averaging +60 is
 * consistently behind the click and worth telling.
 */
export const TENDENCY_THRESHOLD_MS = 25;

/**
 * Hits needed before a tendency is reported at all. With fewer, a mean is
 * mostly noise (two notes can easily both be a little late by chance) and
 * telling a beginner "you rush" from three notes would be unfair.
 */
export const TENDENCY_MIN_HITS = 4;

/** A mean offset at or beyond this (ms) is described as "noticeably" early/late rather than "a little". */
export const NOTICEABLE_TENDENCY_MS = 100;

export interface PlayAlongSummary {
  /** Notes in the piece. */
  readonly total: number;
  readonly hits: number;
  /** Notes finally judged missed. */
  readonly misses: number;
  /** Notes with no result yet (the run was stopped before they were reached). */
  readonly pending: number;
  /** `hits / total`, 0..1 (0 for an empty piece). */
  readonly accuracy: number;
  /** Mean signed timing offset over the hits, ms (negative early, positive late); `undefined` with no hits. */
  readonly meanOffsetMs: number | undefined;
  /** Indices of the missed notes, ascending. */
  readonly missedIndices: readonly number[];
  /** `'early'` / `'late'` when the mean offset exceeds `TENDENCY_THRESHOLD_MS` across at least `TENDENCY_MIN_HITS` hits, `'steady'` when it does not; `undefined` with too few hits to say. */
  readonly tendency: 'early' | 'late' | 'steady' | undefined;
}

/** Folds per-note results into the end-of-run summary. */
export function summarizePlayAlongResults(
  results: readonly PlayAlongNoteResult[],
): PlayAlongSummary {
  let hits = 0;
  let pending = 0;
  let offsetSum = 0;
  const missedIndices: number[] = [];
  for (const result of results) {
    if (result.status === 'hit') {
      hits++;
      offsetSum += result.timingOffsetMs;
    } else if (result.status === 'missed') {
      missedIndices.push(result.index);
    } else {
      pending++;
    }
  }
  const total = results.length;
  const meanOffsetMs = hits > 0 ? offsetSum / hits : undefined;
  let tendency: PlayAlongSummary['tendency'];
  if (meanOffsetMs !== undefined && hits >= TENDENCY_MIN_HITS) {
    tendency =
      Math.abs(meanOffsetMs) > TENDENCY_THRESHOLD_MS
        ? meanOffsetMs < 0
          ? 'early'
          : 'late'
        : 'steady';
  }
  return {
    total,
    hits,
    misses: missedIndices.length,
    pending,
    accuracy: total > 0 ? hits / total : 0,
    meanOffsetMs,
    missedIndices,
    tendency,
  };
}

// --- Tempo text -----------------------------------------------------------------

/**
 * The symbol for a tempo beat: a quarter note is "♩", a dotted quarter "♩.",
 * an eighth "♪", a dotted eighth "♪.". Other lengths have no dependable
 * Unicode glyph (a half note's lives outside the font coverage of both
 * platforms), so they read as a fraction of a whole note: "1/2", "3/4", "1/16".
 */
export function beatUnitSymbol(beatLengthWhole: number): string {
  if (sameWhole(beatLengthWhole, 1 / 4)) return '♩';
  if (sameWhole(beatLengthWhole, 3 / 8)) return '♩.';
  if (sameWhole(beatLengthWhole, 1 / 8)) return '♪';
  if (sameWhole(beatLengthWhole, 3 / 16)) return '♪.';
  return formatFraction(beatLengthWhole);
}

/** "♩ = 120", "♩. = 60", "1/2 = 80". */
export function formatTempoMark(mark: Pick<AbcTempoMark, 'beatLengthWhole' | 'bpm'>): string {
  return `${beatUnitSymbol(mark.beatLengthWhole)} = ${Math.round(mark.bpm)}`;
}

/** Largest denominator tried when turning a beat length into a fraction (1/64 is the smallest note a score uses; 3-tuplets of it still fit). */
const MAX_FRACTION_DENOMINATOR = 192;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function formatFraction(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return String(value);
  for (let denominator = 1; denominator <= MAX_FRACTION_DENOMINATOR; denominator++) {
    const numerator = Math.round(value * denominator);
    if (numerator >= 1 && sameWhole(numerator / denominator, value)) {
      const divisor = gcd(numerator, denominator);
      return `${numerator / divisor}/${denominator / divisor}`;
    }
  }
  return String(Number(value.toFixed(3)));
}

// --- Misses ---------------------------------------------------------------------

/** "12", "2.5", "1.33" -- no trailing zeros. */
function formatBeat(beat: number): string {
  return String(Number(beat.toFixed(2)));
}

/** "123 ms", rounded, sign dropped (the sentence carries the direction). */
function formatMs(ms: number): string {
  return `${Math.round(Math.abs(ms))} ms`;
}

/** "Bar 3, beat 2 · F♯4" (bar 0 reads "Pickup"): where in the piece a note is, and which. */
export function describeNoteLocation(note: PlayAlongNote): string {
  const bar = note.barNumber === 0 ? 'Pickup' : `Bar ${note.barNumber}`;
  return `${bar}, beat ${formatBeat(note.beatInBar)} · ${note.label}`;
}

/**
 * One friendly line about a note's result, for the end-of-run list of notes to
 * work on:
 *
 *  - `"Bar 3, beat 2 · F♯4 — late by 310 ms"`
 *  - `"Bar 3, beat 2 · F♯4 — started early (−240 ms)"`
 *  - `"Bar 3, beat 2 · F♯4 — played the wrong note"`
 *  - `"Bar 3, beat 2 · F♯4 — not played"`
 *
 * Meant for missed notes; a hit or a still-pending note gets a sensible line
 * too ("on time", "not reached yet") so a caller can map over every result.
 */
export function describeMiss(note: PlayAlongNote, result: PlayAlongNoteResult): string {
  const where = describeNoteLocation(note);
  switch (result.status) {
    case 'pending':
      return `${where} — not reached yet`;
    case 'hit':
      return `${where} — on time`;
    case 'missed':
      switch (result.reason) {
        case 'late':
          return result.timingOffsetMs === undefined
            ? `${where} — late`
            : `${where} — late by ${formatMs(result.timingOffsetMs)}`;
        case 'early':
          return result.timingOffsetMs === undefined
            ? `${where} — started early`
            : `${where} — started early (${MINUS}${formatMs(result.timingOffsetMs)})`;
        case 'wrong-pitch':
          return `${where} — played the wrong note`;
        case 'not-played':
          return `${where} — not played`;
      }
  }
}

// --- Summary text ---------------------------------------------------------------

/** "12 of 16 notes on time (75%)", plus " · 3 not reached" if the run was stopped early. */
export function describeSummary(summary: PlayAlongSummary): string {
  if (summary.total === 0) {
    return 'No notes to play';
  }
  // Never round a miss up to a perfect 100%, nor a hit down to a flat 0%.
  let percent = Math.round(summary.accuracy * 100);
  if (summary.hits < summary.total) percent = Math.min(percent, 99);
  if (summary.hits > 0) percent = Math.max(percent, 1);
  const noun = summary.total === 1 ? 'note' : 'notes';
  const base = `${summary.hits} of ${summary.total} ${noun} on time (${percent}%)`;
  return summary.pending > 0 ? `${base} · ${summary.pending} not reached` : base;
}

/**
 * A sentence about the player's overall timing, or `undefined` when there were
 * too few hits to say (see `TENDENCY_MIN_HITS`). "You tend to play a little
 * late (+45 ms on average)"; a steady player gets a compliment instead.
 */
export function describeTendency(summary: PlayAlongSummary): string | undefined {
  if (summary.tendency === undefined || summary.meanOffsetMs === undefined) {
    return undefined;
  }
  if (summary.tendency === 'steady') {
    return 'Your timing was nicely steady';
  }
  const size = Math.abs(summary.meanOffsetMs) >= NOTICEABLE_TENDENCY_MS ? 'noticeably' : 'a little';
  const rounded = Math.round(Math.abs(summary.meanOffsetMs));
  return summary.tendency === 'late'
    ? `You tend to play ${size} late (+${rounded} ms on average)`
    : `You tend to play ${size} early (${MINUS}${rounded} ms on average)`;
}
