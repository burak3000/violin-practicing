import { describe, expect, it } from 'vitest';
import { ClickScheduler, type ScheduledClick } from './click-scheduler.js';

/** A hand-driven clock and timer: nothing here uses real time. */
function harness(clicks: readonly ScheduledClick[], options: { lookaheadMs?: number } = {}) {
  let now = 0;
  let timerCallback: (() => void) | undefined;
  let intervalMs: number | undefined;
  let cleared = 0;
  const scheduled: Array<{ atMs: number; accent: boolean; handedOverAt: number }> = [];
  const scheduler = new ClickScheduler({
    clicks,
    now: () => now,
    schedule: (atMs, accent) => scheduled.push({ atMs, accent, handedOverAt: now }),
    lookaheadMs: options.lookaheadMs ?? 100,
    tickMs: 25,
    setIntervalFn: (callback, ms) => {
      timerCallback = callback;
      intervalMs = ms;
      return 1;
    },
    clearIntervalFn: () => {
      cleared += 1;
      timerCallback = undefined;
    },
  });
  return {
    scheduler,
    scheduled,
    advanceTo(ms: number) {
      now = ms;
      timerCallback?.();
    },
    get intervalMs() {
      return intervalMs;
    },
    get timerActive() {
      return timerCallback !== undefined;
    },
    get cleared() {
      return cleared;
    },
  };
}

const CLICKS: ScheduledClick[] = [
  { atMs: 1000, accent: true },
  { atMs: 1500, accent: false },
  { atMs: 2000, accent: false },
  { atMs: 2500, accent: true },
];

describe('ClickScheduler', () => {
  it('hands each click over once, only when it falls inside the look-ahead window', () => {
    const h = harness(CLICKS);
    h.scheduler.start();
    expect(h.scheduled).toEqual([]);
    h.advanceTo(850); // horizon 950: still nothing
    expect(h.scheduled).toEqual([]);
    h.advanceTo(925); // horizon 1025: the first click
    expect(h.scheduled).toEqual([{ atMs: 1000, accent: true, handedOverAt: 925 }]);
    h.advanceTo(950); // same click must not be handed over twice
    expect(h.scheduled).toHaveLength(1);
    h.advanceTo(1425);
    expect(h.scheduled.map((c) => c.atMs)).toEqual([1000, 1500]);
    expect(h.scheduled[1]).toMatchObject({ accent: false });
  });

  it('keeps order and carries the accent flag through', () => {
    const h = harness(CLICKS);
    h.scheduler.start();
    h.advanceTo(2450);
    expect(h.scheduled.map((c) => [c.atMs, c.accent])).toEqual([
      [1000, true],
      [1500, false],
      [2000, false],
      [2500, true],
    ]);
  });

  it('catches up after a late tick by handing over everything now due, in order', () => {
    const h = harness(CLICKS);
    h.scheduler.start();
    h.advanceTo(1900); // a long stall: clicks at 1000 and 1500 are already past, 2000 is in the window
    expect(h.scheduled.map((c) => c.atMs)).toEqual([1000, 1500, 2000]);
  });

  it('schedules what is already inside the window at start, without waiting for a tick', () => {
    const h = harness([{ atMs: 50, accent: true }]);
    h.scheduler.start();
    expect(h.scheduled).toHaveLength(1);
  });

  it('stops its own timer once the last click has been handed over', () => {
    const h = harness(CLICKS);
    h.scheduler.start();
    expect(h.timerActive).toBe(true);
    expect(h.intervalMs).toBe(25);
    h.advanceTo(2450);
    expect(h.scheduler.remaining).toBe(0);
    expect(h.timerActive).toBe(false);
    expect(h.scheduler.isRunning).toBe(false);
  });

  it('does not start a timer at all when everything is already handed over', () => {
    const h = harness([{ atMs: 10, accent: false }]);
    h.scheduler.start();
    expect(h.timerActive).toBe(false);
    expect(h.scheduler.isRunning).toBe(false);
  });

  it('stop() cancels the timer and hands over nothing more', () => {
    const h = harness(CLICKS);
    h.scheduler.start();
    h.advanceTo(925);
    h.scheduler.stop();
    expect(h.timerActive).toBe(false);
    expect(h.cleared).toBeGreaterThan(0);
    h.advanceTo(5000);
    expect(h.scheduled).toHaveLength(1);
  });

  it('ignores a second start() while running', () => {
    const h = harness(CLICKS);
    h.scheduler.start();
    h.scheduler.start();
    h.advanceTo(925);
    expect(h.scheduled).toHaveLength(1);
  });

  it('handles an empty click list', () => {
    const h = harness([]);
    h.scheduler.start();
    expect(h.timerActive).toBe(false);
    expect(h.scheduled).toEqual([]);
  });
});
