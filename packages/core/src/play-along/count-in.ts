/**
 * How many metronome clicks to count in before a piece, for "N bars".
 *
 * A piece that starts on a full bar is counted in with N full bars ("1 2 3 4"
 * before the first note on the next 1). A piece with a *pickup* (anacrusis)
 * starts partway through a bar: its first note is, say, beat 4. Counting a
 * full extra bar before it would read "4 1 2 3" and then the music on 4 -- the
 * wrong way round for a player. Musicians count "1 2 3" and come in on the
 * pickup, so the pickup's own beats are taken off the count: one bar of
 * count-in before a one-beat pickup in 4/4 is three clicks.
 *
 * The pickup is only subtracted when it is a whole number of beats; an
 * off-beat pickup (an eighth note in 4/4) has no clean "1 2 3", so it keeps
 * the full bars.
 */

import { sameWhole, type AbcPiece } from '../abc/abc-score.js';

export function countInBeatsForBars(piece: AbcPiece, bars: number): number {
  if (!Number.isFinite(bars) || bars <= 0) return 0;
  const full = Math.round(bars) * piece.meter.beatsPerBar;
  if (piece.pickupWhole <= 0) return full;
  const pickupBeats = piece.pickupWhole / piece.meter.beatLengthWhole;
  const wholeBeats = Math.round(pickupBeats);
  if (wholeBeats < 1 || !sameWhole(pickupBeats, wholeBeats)) return full;
  return Math.max(0, full - wholeBeats);
}
