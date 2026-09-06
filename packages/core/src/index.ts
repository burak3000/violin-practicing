// packages/core public API. Platform-agnostic domain logic shared by
// apps/desktop and apps/mobile, consumed as TypeScript source directly (see
// this package's CLAUDE.md for the full architecture writeup).
export { clamp } from './clamp.js';

// Note/frequency utilities
export {
  DEFAULT_A4_HZ,
  PITCH_CLASS_NAMES,
  analyzeFrequency,
  centsOffNearestNote,
  describeFrequency,
  frequencyHzToMidi,
  frequencyToCents,
  midiNumberToNoteName,
  midiToFrequencyHz,
  noteNameToFrequencyHz,
  parseNoteName,
} from './note/note.js';
export type { FrequencyAnalysis, NoteName, PitchClassName } from './note/note.js';

// Violin open strings / first-position scale content
export {
  FIRST_POSITION_SEMITONE_OFFSETS,
  MAJOR_SCALE_SEMITONE_OFFSETS,
  OPEN_STRING_NOTE_NAMES,
  VIOLIN_STRING_ORDER,
  openStringFrequencyHz,
  openStringNote,
} from './note/violin-strings.js';
export type { ViolinStringName } from './note/violin-strings.js';

// Procedural sequence generator (Playing Practice)
export {
  DEFAULT_SEQUENCE_MAX_FREQUENCY_HZ,
  DEFAULT_SEQUENCE_MIN_FREQUENCY_HZ,
  generatePlayingPracticeSequence,
} from './sequence/sequence-generator.js';
export type {
  SequenceDirection,
  SequenceGeneratorConfig,
  SequenceNote,
  SequencePatternType,
} from './sequence/sequence-generator.js';

// Scoring: tolerance bands, confidence gating, dwell time
export {
  DEFAULT_IN_TUNE_CENTS_TOLERANCE,
  DEFAULT_MAX_FREQUENCY_HZ,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MIN_DWELL_TIME_MS,
  DEFAULT_MIN_FREQUENCY_HZ,
  TargetNoteDwellTracker,
  centsOffTarget,
  gateReading,
  isWithinTolerance,
} from './scoring/scoring.js';
export type {
  DwellTrackerConfig,
  GateResult,
  PitchReading,
  ScoringConfig,
} from './scoring/scoring.js';

// Finger Tuner (stateless/continuous)
export { FingerTuner, analyzeTunerReading } from './tuner/finger-tuner.js';
export type { FingerTunerConfig, FingerTunerReading } from './tuner/finger-tuner.js';

// Finger Tuner display smoothing (stateful, vibrato-aware -- layered on
// top of the stateless analyzeTunerReading above; see its own doc comment)
export {
  DEFAULT_TUNER_SMOOTHING_WINDOW_MS,
  DEFAULT_TUNER_TRANSITION_THRESHOLD_CENTS,
  TunerDisplaySmoother,
} from './tuner/tuner-display-smoother.js';
export type {
  SmoothedTunerReading,
  TunerDisplaySmootherConfig,
} from './tuner/tuner-display-smoother.js';

// Playing Practice state machine
export { PlayingPracticeMachine } from './practice/playing-practice.js';
export type { PlayingPracticeOutcome, PlayingPracticeState } from './practice/playing-practice.js';

// Drilling state machine
export {
  DEFAULT_MAX_DRILL_ATTEMPTS,
  DEFAULT_REQUIRED_CONSECUTIVE_CORRECT,
  DrillingMachine,
  computeDrillPool,
} from './practice/drilling.js';
export type {
  DrillPoolNote,
  DrillPoolRole,
  DrillingConfig,
  DrillingOutcome,
} from './practice/drilling.js';

// Composed session controller (Playing Practice <-> Drilling hand-off)
export { PracticeSessionController } from './practice/practice-session-controller.js';
export type { PracticeSessionState } from './practice/practice-session-controller.js';

// Practice attempt tracking (per-frame success/give-up decision -- composes
// TargetNoteDwellTracker with the give-up policy from Phase 6)
export {
  DEFAULT_ATTEMPT_TIMEOUT_MS,
  PracticeAttemptTracker,
} from './practice/practice-attempt-tracker.js';
export type {
  PracticeAttemptStatus,
  PracticeAttemptTrackerConfig,
} from './practice/practice-attempt-tracker.js';

// Persistence ports (v1: in-memory only, see ./persistence/ports.ts)
export { InMemoryProgressRepository, InMemorySessionStore } from './persistence/in-memory.js';
export type {
  PracticeOutcome,
  ProgressEntry,
  ProgressRepository,
  SessionSnapshot,
  SessionStore,
} from './persistence/ports.js';
