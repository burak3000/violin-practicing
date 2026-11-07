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
export { staffSpellingOf } from './sequence/sequence-generator.js';

// Staff (treble clef) notation: note spelling + pure layout geometry + glyph outlines
export {
  NOTE_LETTERS,
  formatSpelling,
  formatSpellingLabel,
  spellMidi,
  spellMidiInKey,
  spellingToMidi,
  transposeSpelling,
} from './notation/note-spelling.js';
export type { NoteLetter, NoteSpelling } from './notation/note-spelling.js';
export { STAFF_GLYPHS } from './notation/staff-glyphs.js';
export type { StaffGlyph, StaffGlyphName } from './notation/staff-glyphs.js';
export { layoutStaff, sizeStaff, staffPosition } from './notation/staff-layout.js';
export { describeFinger, fingerMarkFor, fingerMarksOf } from './notation/fingering.js';
export type { FingerMark } from './notation/fingering.js';
export type {
  StaffLayout,
  StaffLayoutOptions,
  StaffLedgerLine,
  StaffNote,
  StaffNoteLayout,
  StaffSize,
  StaffSizeOptions,
} from './notation/staff-layout.js';

// ABC notation (sheet-music practice): parser + conversion to a practice sequence
export { MAX_ABC_TEXT_LENGTH, parseAbc } from './abc/abc-parser.js';
export type { AbcParseResult, AbcTune, AbcVoice } from './abc/abc-parser.js';
// Rhythm/notation data the parser reads: durations, bars, key/meter/tempo (see ./abc/abc-score.ts)
export {
  DEFAULT_METER,
  DEFAULT_TEMPO_QUARTERS_PER_MINUTE,
  NO_KEY_OFFSETS,
  WHOLE_EPSILON,
  createMeter,
  defaultTempoMark,
  sameWhole,
} from './abc/abc-score.js';
export type {
  AbcBarElement,
  AbcBarStyle,
  AbcKeyElement,
  AbcMeter,
  AbcMeterElement,
  AbcNoteElement,
  AbcPiece,
  AbcRestElement,
  AbcScoreElement,
  AbcTempoElement,
  AbcTempoMark,
  AbcTuplet,
  AbcVoiceScore,
  KeyOffsets,
} from './abc/abc-score.js';
export { abcPracticeSummary, abcTuneLabel, buildAbcPracticeSequence } from './abc/abc-practice.js';
export type { AbcPracticeOptions, AbcPracticeSequence } from './abc/abc-practice.js';

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

// Timed play-along (metronome + scored-in-time ABC practice): plan, scoring
// session, and the summary/wording helpers both apps share
export { MAX_PLAN_BEATS, buildPlayAlongPlan } from './play-along/play-along-plan.js';
export type {
  PlayAlongBeat,
  PlayAlongNote,
  PlayAlongPlan,
  PlayAlongPlanOptions,
} from './play-along/play-along-plan.js';
export {
  DEFAULT_PLAY_ALONG_DETECTION_LAG_MS,
  MAX_TIMING_TOLERANCE_MS,
  MIN_NOTE_DWELL_MS,
  MIN_TIMING_TOLERANCE_MS,
  NOTE_DWELL_FRACTION,
  PlayAlongSession,
  TIMING_TOLERANCE_BEAT_FRACTION,
} from './play-along/play-along-session.js';
export type {
  PlayAlongConfig,
  PlayAlongMissReason,
  PlayAlongNoteResult,
  PlayAlongPhase,
  PlayAlongUpdate,
} from './play-along/play-along-session.js';
export {
  NOTICEABLE_TENDENCY_MS,
  TENDENCY_MIN_HITS,
  TENDENCY_THRESHOLD_MS,
  beatUnitSymbol,
  describeMiss,
  describeNoteLocation,
  describeSummary,
  describeTendency,
  formatTempoMark,
  summarizePlayAlongResults,
} from './play-along/play-along-summary.js';
export type { PlayAlongSummary } from './play-along/play-along-summary.js';

// Play-along run controller (clock, click scheduling, view model, results text),
// the look-ahead click scheduler, and the count-in helper
export {
  DEFAULT_PLAY_ALONG_LEAD_MS,
  PlayAlongRunner,
  SIGNAL_LOST_AFTER_MS,
  notesAtIndices,
} from './play-along/play-along-runner.js';
export type {
  PlayAlongBeatView,
  PlayAlongMissView,
  PlayAlongNoteDisplayState,
  PlayAlongRunPhase,
  PlayAlongRunView,
  PlayAlongRunnerOptions,
  PlayAlongSummaryView,
} from './play-along/play-along-runner.js';
export {
  ClickScheduler,
  DEFAULT_CLICK_LOOKAHEAD_MS,
  DEFAULT_CLICK_TICK_MS,
} from './play-along/click-scheduler.js';
export type { ClickSchedulerOptions, ScheduledClick } from './play-along/click-scheduler.js';
export { countInBeatsForBars } from './play-along/count-in.js';

// Rhythmic score layout: notes with values, rests, bars, key/time signatures,
// beams, ties and tuplets as a flat list of drawing primitives (see
// ./notation/score-layout.ts), the printed-music accidental rules, the SVG
// string renderer, and the font constants the layout is built on
export { SMUFL_ANCHORS, SMUFL_ENGRAVING } from './notation/staff-glyphs.js';
export {
  barIndexAtWhole,
  exactNoteValue,
  layoutScore,
  primitiveBounds,
  sizeScore,
  spaceForDuration,
  splitIntoNoteValues,
} from './notation/score-layout.js';
export type {
  NoteValue,
  ScoreBarLine,
  ScoreLayout,
  ScoreLayoutOptions,
  ScoreNoteLayout,
  ScorePart,
  ScorePrimitive,
  ScoreSize,
  ScoreSizeOptions,
} from './notation/score-layout.js';
export {
  computeDisplayAccidentals,
  displayedKeyOffsets,
  keySignatureGlyphs,
} from './notation/score-accidentals.js';
export type {
  DisplayAccidentalOptions,
  KeySignatureAccidental,
} from './notation/score-accidentals.js';
export { scoreLayoutToSvg } from './notation/score-svg.js';
export type { ScoreSvgOptions } from './notation/score-svg.js';

// Tempo control model shared by both apps' ABC screens (clamping + hint wording)
export {
  MAX_TEMPO_BPM,
  MIN_TEMPO_BPM,
  TEMPO_SLIDER_HIGH_RATIO,
  TEMPO_SLIDER_LOW_RATIO,
  clampTempoBpm,
  describeTempoSettings,
} from './play-along/tempo-settings.js';
export type { TempoSettings } from './play-along/tempo-settings.js';
