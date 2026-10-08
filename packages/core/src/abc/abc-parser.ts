/**
 * ABC notation parser: ABC text -> the ordered list of pitches a violinist
 * would play, for ABC Notation practice mode.
 *
 * ## Scope: pitch only, and honest about what it skips
 *
 * Practice mode scores *pitch* (does the user hold the target note in tune
 * long enough), exactly like the scale/arpeggio modes -- it does not score
 * rhythm. So this parser resolves, with full correctness, everything that
 * decides *which pitch* a written note is:
 *
 * - the note letter, octave marks (`'` `,`), and case (`C` = C4, `c` = C5);
 * - explicit accidentals (`^` `^^` `_` `__` `=`) and their scope: they last
 *   until the end of the bar, for the same letter *and octave*. That is
 *   standard printed notation's rule and what abcjs (the renderer behind
 *   most ABC sites) does, i.e. what the player sees on the sheet. The ABC
 *   2.1 standard's own default (`%%propagate-accidentals pitch`, in a
 *   section it marks volatile) would carry an accidental to that letter in
 *   *every* octave; this parser deliberately does not;
 * - the key signature (`K:`, including modes -- `Ador`, `Gmix`, `Bm`... --
 *   explicit `exp` accidentals, `HP`/`Hp`), in the header and mid-tune via a
 *   `K:` line or an inline `[K:...]`;
 * - ties (`-`): tied notes are one note to play, not two, and an accidental
 *   carries across a tie into the next bar;
 * - voices (`V:`): each voice's notes are kept separate so a multi-voice
 *   score doesn't get its parts interleaved.
 *
 * Note *lengths* (`2`, `/2`, `3/2`, broken rhythm `>`/`<`, tuplets) are
 * consumed but not retained: nothing downstream scores rhythm, and keeping a
 * value nothing reads would just be one more thing to get wrong. Rests are
 * dropped (there is nothing to play).
 *
 * Things that *would* change what the player has to play but that this
 * parser can't represent are never silently mis-parsed -- each produces an
 * entry in the tune's `warnings`:
 *
 * - chords / double stops (`[CEG]`): monophonic app, so the top note is used;
 * - microtonal accidentals (`^/`, `_3/2`): treated as the plain semitone sign;
 * - voice overlays (`&`): the overlaid notes are skipped;
 * - macros (`m:`): not expanded;
 * - ties between different pitches, unterminated chords, characters it can't
 *   interpret, a bad/unknown key, notes after a blank line (which ends a
 *   tune in ABC).
 *
 * Repeats (`|:` `:|`, first/second endings) are recognized as bar lines and
 * not expanded: the notes are played once, as written.
 *
 * Pure TypeScript, zero DOM/Node/React-Native imports, like everything else
 * in this package. Never throws: bad input yields fewer/no tunes plus
 * warnings.
 */

/** Hard cap on input size (characters). An ABC tune book is a few hundred KB at the very most; anything bigger is almost certainly not an ABC file, and refusing it up front keeps a wrong-file pick from hanging a UI thread. */
export const MAX_ABC_TEXT_LENGTH = 1_000_000;

export interface AbcVoice {
  /** The `V:` identifier, or `''` for a tune that doesn't use voices. */
  readonly id: string;
  /** `name="..."` / `nm="..."` from the `V:` field, if given. */
  readonly name: string | undefined;
  /** MIDI note numbers in playing order (ties merged, rests dropped, chords reduced to their top note). */
  readonly notes: readonly number[];
}

export interface AbcTune {
  /** 0-based position of this tune within the file. */
  readonly index: number;
  /** The `X:` reference number as written, if any. */
  readonly referenceNumber: string | undefined;
  /** First `T:` title; `''` if the tune has none. */
  readonly title: string;
  readonly composer: string | undefined;
  /** The header `K:` value as written (e.g. `"G"`, `"Ador"`), `''` if absent. For display only. */
  readonly key: string;
  /** Always at least one voice. Voices appear in order of first mention; voices that never got a note are omitted unless that would leave none. */
  readonly voices: readonly AbcVoice[];
  readonly warnings: readonly string[];
}

export interface AbcParseResult {
  readonly tunes: readonly AbcTune[];
  /** File-level problems (no tunes found, file too large, text outside any tune). Per-tune problems are on each tune. */
  readonly warnings: readonly string[];
}

// --- Pitch tables -------------------------------------------------------

type Letter = 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
type LetterOffsets = Record<Letter, number>;

const LETTER_SEMITONES: Readonly<Record<Letter, number>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** Order in which sharps are added to a key signature, then flats. */
const SHARP_ORDER: readonly Letter[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER: readonly Letter[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

/** Position on the circle of fifths (sharps count; negative = flats) of each *major* key's tonic letter, before any `#`/`b`. */
const MAJOR_FIFTHS: Readonly<Record<Letter, number>> = {
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  F: -1,
};

/** How far a mode moves the key signature from its parallel major's, keyed by the mode name's first three letters (lowercased). */
const MODE_FIFTHS_SHIFT: Readonly<Record<string, number>> = {
  maj: 0,
  ion: 0,
  min: -3,
  aeo: -3,
  mix: -1,
  dor: -2,
  phr: -4,
  lyd: 1,
  loc: -5,
};

/** More than two sharps/flats on one letter (beyond +-14 on the circle of fifths) can't be written. */
const MAX_ABS_FIFTHS = 14;

function modeShiftFor(word: string): number | undefined {
  const lower = word.toLowerCase();
  if (lower === 'm') return MODE_FIFTHS_SHIFT.min;
  return MODE_FIFTHS_SHIFT[lower.slice(0, 3)];
}

function emptyOffsets(): LetterOffsets {
  return { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
}

/** Per-letter semitone offsets for a key signature `fifths` steps around the circle (sharps positive, flats negative). Works past +-7 (double sharps/flats) so exotic keys like G# major still read their letters correctly. */
function offsetsForFifths(fifths: number): LetterOffsets {
  const offsets = emptyOffsets();
  if (fifths > 0) {
    SHARP_ORDER.forEach((letter, position) => {
      offsets[letter] = Math.floor((fifths - position + 6) / 7);
    });
  } else if (fifths < 0) {
    FLAT_ORDER.forEach((letter, position) => {
      offsets[letter] = -Math.floor((-fifths - position + 6) / 7);
    });
  }
  return offsets;
}

const KEY_ACCIDENTAL_TOKEN = /^(__|_|=|\^\^|\^)([A-Ga-g])$/;

/** Words that may follow the tonic in a `K:` field and mean something other than a mode (so they're never reported as an unknown key). */
const KEY_IGNORED_TOKEN =
  /^(exp|explicit|clef|treble|bass|alto|tenor|perc|none|stafflines|middle|transpose|octave|style|staffscale|[a-z-]+=.*)/i;

interface ParsedKey {
  readonly offsets: LetterOffsets;
  readonly warnings: readonly string[];
}

/** Parses the value of a `K:` field (or inline `[K:...]`) into per-letter offsets. */
function parseKeyField(raw: string): ParsedKey {
  const warnings: string[] = [];
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  let fifths = 0;
  let explicit = false;
  const accidentals: Array<readonly [Letter, number]> = [];
  let consumedFirst = false;

  const first = tokens[0];
  if (first !== undefined) {
    if (first === 'HP' || first === 'Hp') {
      // Highland bagpipe keys: played as D major (F#, C#); HP just doesn't print the signature.
      fifths = 2;
      consumedFirst = true;
    } else if (/^none$/i.test(first)) {
      consumedFirst = true;
    } else {
      const match = /^([A-Ga-g])([#b]?)(.*)$/.exec(first);
      if (match) {
        const letter = match[1]!.toUpperCase() as Letter;
        const accidental = match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0;
        let modeShift = 0;
        const attachedMode = match[3]!;
        if (attachedMode.length > 0) {
          const shift = modeShiftFor(attachedMode);
          if (shift === undefined) {
            warnings.push(`Unknown mode "${attachedMode}" in key "${raw}"; assuming major.`);
          } else {
            modeShift = shift;
          }
        } else {
          const second = tokens[1];
          if (second !== undefined) {
            const shift = modeShiftFor(second);
            if (shift !== undefined) {
              modeShift = shift;
              tokens.splice(1, 1);
            }
          }
        }
        fifths = MAJOR_FIFTHS[letter] + 7 * accidental + modeShift;
        consumedFirst = true;
      }
    }
  }

  for (const token of tokens.slice(consumedFirst ? 1 : 0)) {
    if (token === 'exp' || token === 'explicit') {
      explicit = true;
      continue;
    }
    const accidentalMatch = KEY_ACCIDENTAL_TOKEN.exec(token);
    if (accidentalMatch) {
      const sign = accidentalMatch[1]!;
      const value =
        sign === '^^' ? 2 : sign === '^' ? 1 : sign === '=' ? 0 : sign === '_' ? -1 : -2;
      accidentals.push([accidentalMatch[2]!.toUpperCase() as Letter, value]);
      continue;
    }
    if (!consumedFirst && token === tokens[0] && !KEY_IGNORED_TOKEN.test(token)) {
      warnings.push(`Unrecognized key "${raw}"; assuming no key signature.`);
    }
  }

  if (Math.abs(fifths) > MAX_ABS_FIFTHS) {
    warnings.push(`Key "${raw}" needs more sharps/flats than can be written; assuming none.`);
    fifths = 0;
  }

  const offsets = explicit ? emptyOffsets() : offsetsForFifths(fifths);
  for (const [letter, value] of accidentals) {
    offsets[letter] = value;
  }
  return { offsets, warnings };
}

// --- Per-tune parse state ------------------------------------------------

interface LastNote {
  readonly letter: Letter;
  readonly octave: number;
  readonly offset: number;
  readonly midi: number;
}

interface VoiceState {
  readonly id: string;
  name: string | undefined;
  readonly notes: number[];
  /** `undefined` => use the tune's header key. */
  key: LetterOffsets | undefined;
  /** `${letter}${octave}` -> semitone offset set by an accidental earlier in this bar. */
  readonly barAccidentals: Map<string, number>;
  last: LastNote | undefined;
  tiePending: boolean;
  /** True from a `&` voice overlay to the next bar line: notes are tokenized but not emitted. */
  muted: boolean;
}

interface NoteToken {
  readonly letter: Letter;
  readonly octave: number;
  /** Explicit accidental on this note: +-1/2, 0 for a natural; `undefined` if none was written. */
  readonly accidental: number | undefined;
  readonly microtonal: boolean;
  /** Index just past the note (after any octave marks), before its length. */
  readonly end: number;
}

const DECORATION_CHARS = new Set(['.', '~']);
/** `h`-`w` / `H`-`W` are the (user-redefinable) single-letter decorations: trill, fermata, etc. None affects pitch. */
const DECORATION_LETTER = /^[h-wH-W]$/;
const REST_CHARS = new Set(['z', 'Z', 'x', 'X', 'y']);
const MAX_REPORTED_UNKNOWN_CHARS = 6;

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isNoteLetter(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Ga-g]$/.test(ch);
}

function skipLength(s: string, from: number): number {
  let j = from;
  while (j < s.length && (isDigit(s[j]) || s[j] === '/')) j += 1;
  return j;
}

/** Reads `[accidental]letter[octave marks]` at `i`, or `undefined` if `s[i]` doesn't start a note. */
function readNote(s: string, i: number): NoteToken | undefined {
  let j = i;
  let accidental: number | undefined;
  let microtonal = false;

  const sign = s[j];
  if (sign === '^' || sign === '_') {
    let count = 0;
    while (s[j] === sign && count < 2) {
      count += 1;
      j += 1;
    }
    accidental = sign === '^' ? count : -count;
    if (!isNoteLetter(s[j]) && (s[j] === '/' || isDigit(s[j]))) {
      // `^/C`, `_3/2B`: a quarter-tone-style accidental.
      microtonal = true;
      j = skipLength(s, j);
    }
  } else if (sign === '=') {
    accidental = 0;
    j += 1;
  }

  const letterChar = s[j];
  if (!isNoteLetter(letterChar)) return undefined;
  const upper = letterChar!.toUpperCase() as Letter;
  let octave = letterChar === upper ? 4 : 5;
  j += 1;
  while (s[j] === "'" || s[j] === ',') {
    octave += s[j] === "'" ? 1 : -1;
    j += 1;
  }
  return { letter: upper, octave, accidental, microtonal, end: j };
}

function stripComment(line: string): string {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && line[i + 1] === '%') {
      i += 1;
    } else if (line[i] === '%') {
      return line.slice(0, i);
    }
  }
  return line;
}

const INFO_FIELD = /^([A-Za-z]):\s*(.*)$/;

function parseVoiceField(value: string): { id: string; name: string | undefined } | undefined {
  const id = value.trim().split(/\s+/)[0] ?? '';
  if (id.length === 0) return undefined;
  const nameMatch = /\b(?:name|nm)="([^"]*)"/.exec(value);
  return { id, name: nameMatch ? nameMatch[1] : undefined };
}

class TuneParser {
  private readonly voices = new Map<string, VoiceState>();
  private headerKey: LetterOffsets = emptyOffsets();
  private currentVoiceId = '';
  private readonly warnings: string[] = [];
  private readonly unknownChars = new Set<string>();
  private chordsReduced = 0;
  private microtonalSeen = false;
  private overlaySeen = false;
  private tieMismatchSeen = false;
  private unterminatedSeen = false;
  private macroSeen = false;

  referenceNumber: string | undefined;
  title = '';
  composer: string | undefined;
  keyText = '';

  constructor(private readonly index: number) {}

  private voice(id: string): VoiceState {
    let state = this.voices.get(id);
    if (!state) {
      state = {
        id,
        name: undefined,
        notes: [],
        key: undefined,
        barAccidentals: new Map(),
        last: undefined,
        tiePending: false,
        muted: false,
      };
      this.voices.set(id, state);
    }
    return state;
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  // --- Header and field lines ----------------------------------------

  /** A header field line (everything before and including `K:`). Returns true once the key line ends the header. */
  headerField(letter: string, value: string): boolean {
    switch (letter) {
      case 'X':
        this.referenceNumber = value.trim() || undefined;
        return false;
      case 'T':
        if (this.title === '') this.title = value.trim();
        return false;
      case 'C':
        if (this.composer === undefined && value.trim() !== '') this.composer = value.trim();
        return false;
      case 'V': {
        const v = parseVoiceField(value);
        if (v) {
          const state = this.voice(v.id);
          state.name ??= v.name;
          if (this.voices.size === 1) this.currentVoiceId = v.id;
        }
        return false;
      }
      case 'm':
        this.noteMacro();
        return false;
      case 'K': {
        this.keyText = value.trim();
        const parsed = parseKeyField(this.keyText);
        this.headerKey = parsed.offsets;
        for (const w of parsed.warnings) this.warn(w);
        return true;
      }
      default:
        return false;
    }
  }

  private noteMacro(): void {
    if (!this.macroSeen) {
      this.macroSeen = true;
      this.warn('Macros (m: lines) are not expanded; notes written with a macro may be wrong.');
    }
  }

  /** Called when the header ended without a `K:` line. */
  noKeyLine(): void {
    this.warn('This tune has no K: (key) line; assuming no key signature.');
  }

  /** A field line inside the body (including via an inline `[X:...]`). */
  bodyField(letter: string, value: string): void {
    switch (letter) {
      case 'K': {
        const parsed = parseKeyField(value.trim());
        for (const w of parsed.warnings) this.warn(w);
        this.voice(this.currentVoiceId).key = parsed.offsets;
        return;
      }
      case 'V': {
        const v = parseVoiceField(value);
        if (v) {
          const state = this.voice(v.id);
          state.name ??= v.name;
          this.currentVoiceId = v.id;
        }
        return;
      }
      case 'm':
        this.noteMacro();
        return;
      default:
        return;
    }
  }

  // --- Music ------------------------------------------------------------

  private currentVoice(): VoiceState {
    return this.voice(this.currentVoiceId);
  }

  private resolveOffset(
    voice: VoiceState,
    token: NoteToken,
    tiedFrom: LastNote | undefined,
  ): number {
    const positionKey = `${token.letter}${token.octave}`;
    if (token.accidental !== undefined) {
      voice.barAccidentals.set(positionKey, token.accidental);
      return token.accidental;
    }
    if (tiedFrom && tiedFrom.letter === token.letter && tiedFrom.octave === token.octave) {
      // An accidental carries across a tie, even into the next bar.
      return tiedFrom.offset;
    }
    const inBar = voice.barAccidentals.get(positionKey);
    if (inBar !== undefined) return inBar;
    return (voice.key ?? this.headerKey)[token.letter];
  }

  private toLastNote(
    voice: VoiceState,
    token: NoteToken,
    tiedFrom: LastNote | undefined,
  ): LastNote {
    const offset = this.resolveOffset(voice, token, tiedFrom);
    return {
      letter: token.letter,
      octave: token.octave,
      offset,
      midi: 12 * (token.octave + 1) + LETTER_SEMITONES[token.letter] + offset,
    };
  }

  /** Emits one played note (or merges it into a tie). */
  private emit(voice: VoiceState, note: LastNote): void {
    const tied = voice.tiePending;
    voice.tiePending = false;
    if (tied && voice.last && voice.last.midi === note.midi) {
      voice.last = note;
      return;
    }
    if (tied && !this.tieMismatchSeen) {
      this.tieMismatchSeen = true;
      this.warn('A tie joins two different pitches; both notes are included.');
    }
    voice.notes.push(note.midi);
    voice.last = note;
  }

  private note(s: string, token: NoteToken): number {
    const voice = this.currentVoice();
    if (token.microtonal && !this.microtonalSeen) {
      this.microtonalSeen = true;
      this.warn(
        'Microtonal accidentals (like ^/ or _3/2) are not supported; the plain sharp/flat is used.',
      );
    }
    if (!voice.muted) {
      const tiedFrom = voice.tiePending ? voice.last : undefined;
      this.emit(voice, this.toLastNote(voice, token, tiedFrom));
    }
    return skipLength(s, token.end);
  }

  /** Parses a `[...]` chord starting at `i` (`s[i] === '['`). Returns the index to continue from. */
  private chord(s: string, i: number): number {
    const close = s.indexOf(']', i + 1);
    if (close === -1) {
      if (!this.unterminatedSeen) {
        this.unterminatedSeen = true;
        this.warn(
          'A chord ([...) is missing its closing bracket; the rest of that line was skipped.',
        );
      }
      return s.length;
    }
    const voice = this.currentVoice();
    const tiedFrom = voice.tiePending ? voice.last : undefined;
    const members: LastNote[] = [];
    let j = i + 1;
    while (j < close) {
      const ch = s[j]!;
      if (ch === '"') {
        const end = s.indexOf('"', j + 1);
        j = end === -1 || end > close ? close : end + 1;
        continue;
      }
      if (ch === '!') {
        const end = s.indexOf('!', j + 1);
        j = end === -1 || end > close ? j + 1 : end + 1;
        continue;
      }
      const token = readNote(s, j);
      if (token) {
        if (token.microtonal && !this.microtonalSeen) {
          this.microtonalSeen = true;
          this.warn(
            'Microtonal accidentals (like ^/ or _3/2) are not supported; the plain sharp/flat is used.',
          );
        }
        if (!voice.muted) members.push(this.toLastNote(voice, token, tiedFrom));
        j = skipLength(s, token.end);
        continue;
      }
      // Spaces, ties on individual chord notes, decorations, stray characters: nothing to play.
      j += 1;
    }
    if (members.length > 0 && !voice.muted) {
      const top = members.reduce((a, b) => (b.midi > a.midi ? b : a));
      if (members.some((m) => m.midi !== top.midi)) this.chordsReduced += 1;
      this.emit(voice, top);
    }
    return skipLength(s, close + 1);
  }

  private barLine(s: string, i: number): number {
    const voice = this.currentVoice();
    voice.barAccidentals.clear();
    voice.muted = false;
    let j = i;
    if (s[j] === '[') j += 1;
    while (s[j] === '|' || s[j] === ':') j += 1;
    if (s[j] === ']' && s[j - 1] === '|') j += 1;
    if (isDigit(s[j])) {
      // First/second ending number right after the bar (`|1`, `:|2`, `|1,2`).
      while (isDigit(s[j]) || s[j] === ',' || s[j] === '-') j += 1;
    }
    return j;
  }

  /** Tokenizes one music line (already comment-stripped and trimmed). */
  musicLine(raw: string): void {
    const s = raw.endsWith('\\') ? raw.slice(0, -1) : raw;
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;

      if (ch === ' ' || ch === '\t') {
        i += 1;
        continue;
      }
      if (ch === '"') {
        const end = s.indexOf('"', i + 1);
        i = end === -1 ? s.length : end + 1;
        continue;
      }
      if (ch === '!') {
        // `!trill!`-style decoration; a lone `!` is an old-style line break.
        const end = s.indexOf('!', i + 1);
        i = end === -1 ? i + 1 : end + 1;
        continue;
      }
      if (ch === '+') {
        const end = s.indexOf('+', i + 1);
        i = end === -1 ? i + 1 : end + 1;
        continue;
      }
      if (ch === '{') {
        const end = s.indexOf('}', i + 1);
        i = end === -1 ? s.length : end + 1;
        continue;
      }
      if (ch === '(') {
        i += 1;
        if (isDigit(s[i])) {
          // Tuplet marker `(3`, `(3:2`, `(3:2:3` -- not a slur.
          while (isDigit(s[i]) || s[i] === ':') i += 1;
        }
        continue;
      }
      if (ch === ')' || ch === '*' || ch === '\\' || ch === '>' || ch === '<') {
        i += 1;
        continue;
      }
      if (ch === '[') {
        const next = s[i + 1];
        if (next !== undefined && /^[A-Za-z]$/.test(next) && s[i + 2] === ':') {
          const end = s.indexOf(']', i + 1);
          if (end === -1) {
            i = s.length;
            continue;
          }
          this.bodyField(next, s.slice(i + 3, end));
          i = end + 1;
          continue;
        }
        if (next === '|') {
          i = this.barLine(s, i);
          continue;
        }
        if (isDigit(next)) {
          // `[1` / `[2` first/second ending.
          i += 1;
          while (isDigit(s[i]) || s[i] === ',' || s[i] === '-') i += 1;
          continue;
        }
        i = this.chord(s, i);
        continue;
      }
      if (ch === '|' || ch === ':') {
        i = this.barLine(s, i);
        continue;
      }
      if (ch === '-') {
        const voice = this.currentVoice();
        if (voice.last && !voice.muted) voice.tiePending = true;
        i += 1;
        continue;
      }
      if (ch === '&') {
        if (!this.overlaySeen) {
          this.overlaySeen = true;
          this.warn('Voice overlays (&) are not supported; the overlaid notes are skipped.');
        }
        this.currentVoice().muted = true;
        i += 1;
        continue;
      }
      if (REST_CHARS.has(ch)) {
        const voice = this.currentVoice();
        voice.tiePending = false;
        i = skipLength(s, i + 1);
        continue;
      }
      if (DECORATION_CHARS.has(ch) || DECORATION_LETTER.test(ch)) {
        i += 1;
        continue;
      }
      if (ch === '/' || isDigit(ch)) {
        // A stray length modifier with no note in front of it.
        i = skipLength(s, i);
        continue;
      }

      const token = readNote(s, i);
      if (token) {
        i = this.note(s, token);
        continue;
      }

      // Anything else is something this parser doesn't understand.
      if (this.unknownChars.size < MAX_REPORTED_UNKNOWN_CHARS) this.unknownChars.add(ch);
      i += 1;
    }
  }

  finish(): AbcTune {
    if (this.chordsReduced > 0) {
      this.warn(
        `${this.chordsReduced} chord${this.chordsReduced === 1 ? '' : 's'}/double-stop${
          this.chordsReduced === 1 ? '' : 's'
        } found; only the top note of each is practiced.`,
      );
    }
    if (this.unknownChars.size > 0) {
      const shown = [...this.unknownChars].map((c) => `"${c}"`).join(', ');
      this.warn(`Skipped characters this parser doesn't understand: ${shown}.`);
    }

    let voices: AbcVoice[] = [...this.voices.values()]
      .filter((v) => v.notes.length > 0)
      .map((v) => ({ id: v.id, name: v.name, notes: v.notes }));
    if (voices.length === 0) {
      const only = this.voices.get(this.currentVoiceId) ?? [...this.voices.values()][0];
      voices = [{ id: only?.id ?? '', name: only?.name, notes: [] }];
    }
    if (voices.length > 1) {
      const labels = voices
        .map((v) => (v.name ? `${v.id} (${v.name})` : v.id || '(default)'))
        .join(', ');
      this.warn(
        `This tune has ${voices.length} voices (${labels}); the first one (${voices[0]!.id || 'default'}) is used for practice.`,
      );
    }

    return {
      index: this.index,
      referenceNumber: this.referenceNumber,
      title: this.title,
      composer: this.composer,
      key: this.keyText,
      voices,
      warnings: this.warnings,
    };
  }
}

// --- File-level parse ----------------------------------------------------

interface RawTune {
  readonly lines: string[];
}

/**
 * Parses an ABC file (one or more tunes) into pitch sequences. Never
 * throws; see the module doc comment for what is and isn't interpreted.
 */
export function parseAbc(text: string): AbcParseResult {
  if (text.length > MAX_ABC_TEXT_LENGTH) {
    return {
      tunes: [],
      warnings: [
        `This file is too large to be an ABC tune (over ${MAX_ABC_TEXT_LENGTH.toLocaleString('en-US')} characters).`,
      ],
    };
  }

  const fileWarnings: string[] = [];
  const rawTunes: RawTune[] = [];
  let current: RawTune | undefined;
  let strayLines = 0;
  // After a blank line ends a tune, anything that isn't the start of a new tune is stray.
  let afterTuneEnd = false;

  const source = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  for (const rawLine of source) {
    const trimmedRaw = rawLine.trim();
    if (trimmedRaw.startsWith('%')) continue; // comment or %%directive
    const line = stripComment(rawLine).trim();

    if (line === '') {
      if (current) {
        rawTunes.push(current);
        current = undefined;
        afterTuneEnd = true;
      }
      continue;
    }

    const isTuneStart = /^X:/.test(line);
    if (isTuneStart) {
      if (current) rawTunes.push(current);
      current = { lines: [line] };
      afterTuneEnd = false;
      continue;
    }
    if (current) {
      current.lines.push(line);
      continue;
    }
    if (INFO_FIELD.test(line)) {
      // A tune without an X: line (or a file header): start collecting at the first field.
      current = { lines: [line] };
      afterTuneEnd = false;
      continue;
    }
    if (afterTuneEnd) strayLines += 1;
  }
  if (current) rawTunes.push(current);

  const tunes: AbcTune[] = [];
  for (const raw of rawTunes) {
    const tune = parseTune(raw.lines, tunes.length);
    if (tune) tunes.push(tune);
  }

  if (strayLines > 0) {
    fileWarnings.push(
      `Ignored ${strayLines} line${strayLines === 1 ? '' : 's'} of text after a blank line outside any tune (a blank line ends an ABC tune).`,
    );
  }
  if (tunes.length === 0) {
    fileWarnings.unshift(
      'No ABC tune was found in this file (expected X:/K: header lines followed by notes).',
    );
  }
  return { tunes, warnings: fileWarnings };
}

/** Returns `undefined` for a chunk that is only a file header (fields but no key line and no music). */
function parseTune(lines: readonly string[], index: number): AbcTune | undefined {
  const parser = new TuneParser(index);

  let bodyStart = lines.length;
  let sawKey = false;
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n]!;
    const field = INFO_FIELD.exec(line);
    if (!field) {
      bodyStart = n;
      break;
    }
    if (parser.headerField(field[1]!, field[2]!)) {
      sawKey = true;
      bodyStart = n + 1;
      break;
    }
  }

  const bodyLines = lines.slice(bodyStart);
  const hasMusicLine = bodyLines.some((l) => !INFO_FIELD.test(l));
  if (!sawKey && !hasMusicLine) return undefined;
  if (!sawKey) parser.noKeyLine();

  let continued = false;
  for (const line of bodyLines) {
    const field = continued ? null : INFO_FIELD.exec(line);
    if (field) {
      parser.bodyField(field[1]!, field[2]!);
      continued = false;
      continue;
    }
    parser.musicLine(line);
    continued = line.endsWith('\\');
  }

  return parser.finish();
}
