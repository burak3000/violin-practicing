/**
 * What the tempo control of the ABC practice screen shows and allows, decided
 * once for both apps.
 *
 * The tempo is UI state: the file's `Q:` is read when a piece is chosen, the
 * player can change it freely, and nothing is ever written back to the file
 * (the app does not even keep the file's text). The number is always in the
 * piece's *own beat unit* ("♩ = 100", "♩. = 60"), the unit the file used, so
 * "75% of the written tempo" means the same in every meter.
 */

import type { AbcPiece } from '../abc/abc-score.js';
import { beatUnitSymbol, formatTempoMark } from './play-along-summary.js';

/** Slower than this is not a tempo a player follows along with. */
export const MIN_TEMPO_BPM = 20;
/** Faster than this is beyond what the timing window can meaningfully judge. */
export const MAX_TEMPO_BPM = 300;
/** A slider covers a quarter to double the written tempo (within the field's bounds); typing can go beyond it. */
export const TEMPO_SLIDER_LOW_RATIO = 0.25;
export const TEMPO_SLIDER_HIGH_RATIO = 2;

/** Rounds to a whole number and keeps it in range. Non-finite input gives `fallback` (default: the minimum). */
export function clampTempoBpm(value: number, fallback: number = MIN_TEMPO_BPM): number {
  if (!Number.isFinite(value)) return clampTempoBpm(fallback, MIN_TEMPO_BPM);
  return Math.min(MAX_TEMPO_BPM, Math.max(MIN_TEMPO_BPM, Math.round(value)));
}

export interface TempoSettings {
  /** The file's tempo as the number field can hold it (a file's `Q:` may be fractional or out of range). */
  readonly writtenBpm: number;
  /** The chosen tempo, clamped. */
  readonly bpm: number;
  /** "♩", "♩.", "♪" ... (or a fraction such as "1/2"): the beat the number counts. */
  readonly unitSymbol: string;
  readonly sliderMin: number;
  readonly sliderMax: number;
  /** True when the chosen tempo differs from the written one (show a "reset" control). */
  readonly differs: boolean;
  /** "♩ = 100": the written tempo, for a reset button's label. */
  readonly writtenText: string;
  /** "♩ = 92": the chosen tempo. */
  readonly currentText: string;
  /** "92% of the written tempo" ("default tempo" when the file has no marking). */
  readonly percentText: string;
  /**
   * Short notes for the player, in order: the percentage, then -- only when
   * true -- that the file has no tempo marking (so the number is the app's
   * default) and that it has no time signature (so 4/4 is assumed).
   */
  readonly hints: readonly string[];
}

export function describeTempoSettings(piece: AbcPiece, requestedBpm: number): TempoSettings {
  const fileBpm = piece.tempo.bpm;
  const writtenBpm = clampTempoBpm(fileBpm);
  const bpm = clampTempoBpm(requestedBpm, writtenBpm);
  const fromFile = piece.tempoSource === 'file';
  const sliderMin = Math.max(MIN_TEMPO_BPM, Math.round(fileBpm * TEMPO_SLIDER_LOW_RATIO));
  const sliderMax = Math.max(
    sliderMin,
    Math.min(MAX_TEMPO_BPM, Math.round(fileBpm * TEMPO_SLIDER_HIGH_RATIO)),
  );
  const percent = Math.round((bpm / fileBpm) * 100);
  const percentText = `${percent}% of the ${fromFile ? 'written' : 'default'} tempo`;

  const hints = [percentText];
  if (!fromFile) {
    hints.push(`(This file has no tempo marking; starting at ${formatTempoMark(piece.tempo)}.)`);
  }
  if (piece.meterAssumed) hints.push('(No time signature in this file; assuming 4/4.)');

  const beat = piece.tempo.beatLengthWhole;
  return {
    writtenBpm,
    bpm,
    unitSymbol: beatUnitSymbol(beat),
    sliderMin,
    sliderMax,
    differs: bpm !== writtenBpm,
    writtenText: formatTempoMark({ beatLengthWhole: beat, bpm: writtenBpm }),
    currentText: formatTempoMark({ beatLengthWhole: beat, bpm }),
    percentText,
    hints,
  };
}
