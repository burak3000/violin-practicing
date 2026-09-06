/**
 * Persistence-port interfaces. Confirmed v1 decision (see
 * temp/PLAN-violin-practice-app.md, "Confirmed architectural decisions" #2):
 * no real persistence in v1 — all practice-session state lives in memory
 * for the lifetime of the app session only. These interfaces exist so a
 * *later* phase (outside the current plan) can add a real adapter (disk,
 * AsyncStorage, IndexedDB, electron-store, ...) by writing a new class that
 * implements one of these, without changing call sites.
 *
 * Both are defined as async (Promise-returning) even though the v1
 * in-memory implementation (../persistence/in-memory.ts) can resolve
 * synchronously — a real backend will almost certainly be async (disk/
 * network/native-storage I/O), and designing the interface as sync now
 * would force a breaking change at every call site when a real adapter
 * eventually lands, defeating the reason these interfaces exist.
 */

/**
 * Whatever a session needs to remember to resume later (current mode,
 * sequence config, index, drilling state, ...). Left as a loose, generic
 * bag for v1 rather than a concrete shape: pinning down "the exact
 * resumable session shape" is a decision better made once there's a real
 * UI session producing one (Phase 5/6+) — guessing it now, with no
 * consumer yet, risks locking in the wrong shape. `SessionStore<T>` lets a
 * future concrete usage parameterize it with a real type without changing
 * this interface.
 */
export type SessionSnapshot = Record<string, unknown>;

export interface SessionStore<T = SessionSnapshot> {
  save(sessionId: string, snapshot: T): Promise<void>;
  load(sessionId: string): Promise<T | undefined>;
  clear(sessionId: string): Promise<void>;
}

export type PracticeOutcome = 'success' | 'failure';

/** Aggregate practice history for one note (identified by its `NoteName.label`, e.g. "G3", "C#4"). */
export interface ProgressEntry {
  readonly noteLabel: string;
  readonly attempts: number;
  readonly successes: number;
  readonly lastPracticedAtMs: number;
}

export interface ProgressRepository {
  recordAttempt(noteLabel: string, outcome: PracticeOutcome, timestampMs: number): Promise<void>;
  getProgress(noteLabel: string): Promise<ProgressEntry | undefined>;
  getAllProgress(): Promise<readonly ProgressEntry[]>;
  clearAll(): Promise<void>;
}
