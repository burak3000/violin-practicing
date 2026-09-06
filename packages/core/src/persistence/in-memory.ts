/**
 * In-memory, no-op-with-respect-to-real-persistence implementations of the
 * ports in ./ports.ts (confirmed v1 decision — see that file's doc
 * comment). "No-op" describes durability (nothing is ever written to disk
 * or network), not behavior: within one instance's lifetime these actually
 * hold and return real data via a plain Map, so in-session features (e.g.
 * "current streak this session") work correctly — they just forget
 * everything on process exit / instance disposal, by design.
 */

import type {
  PracticeOutcome,
  ProgressEntry,
  ProgressRepository,
  SessionSnapshot,
  SessionStore,
} from './ports.js';

export class InMemorySessionStore<T = SessionSnapshot> implements SessionStore<T> {
  private readonly sessions = new Map<string, T>();

  save(sessionId: string, snapshot: T): Promise<void> {
    this.sessions.set(sessionId, snapshot);
    return Promise.resolve();
  }

  load(sessionId: string): Promise<T | undefined> {
    return Promise.resolve(this.sessions.get(sessionId));
  }

  clear(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    return Promise.resolve();
  }
}

export class InMemoryProgressRepository implements ProgressRepository {
  private readonly progress = new Map<string, ProgressEntry>();

  recordAttempt(noteLabel: string, outcome: PracticeOutcome, timestampMs: number): Promise<void> {
    const existing = this.progress.get(noteLabel);
    const attempts = (existing?.attempts ?? 0) + 1;
    const successes = (existing?.successes ?? 0) + (outcome === 'success' ? 1 : 0);
    this.progress.set(noteLabel, {
      noteLabel,
      attempts,
      successes,
      lastPracticedAtMs: timestampMs,
    });
    return Promise.resolve();
  }

  getProgress(noteLabel: string): Promise<ProgressEntry | undefined> {
    return Promise.resolve(this.progress.get(noteLabel));
  }

  getAllProgress(): Promise<readonly ProgressEntry[]> {
    return Promise.resolve([...this.progress.values()]);
  }

  clearAll(): Promise<void> {
    this.progress.clear();
    return Promise.resolve();
  }
}
