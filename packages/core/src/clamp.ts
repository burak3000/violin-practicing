/**
 * Clamp a numeric value into an inclusive [min, max] range.
 *
 * Phase 0 placeholder: this proves the packages/core build + test harness
 * works end to end (see clamp.test.ts). It is not part of the pitch-
 * detection domain logic itself — that lands in later phases per
 * temp/PLAN-violin-practice-app.md (note/cents math, scoring, etc. arrive
 * in Phase 2, built on Phase 1's empirically-validated thresholds).
 */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError(`clamp: min (${min}) must be <= max (${max})`);
  }
  return Math.min(Math.max(value, min), max);
}
