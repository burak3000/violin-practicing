import { describe, expect, it } from 'vitest';
import { parseAbc } from '../abc/abc-parser.js';
import { buildAbcPracticeSequence } from '../abc/abc-practice.js';
import {
  MAX_TEMPO_BPM,
  MIN_TEMPO_BPM,
  clampTempoBpm,
  describeTempoSettings,
} from './tempo-settings.js';

function pieceOf(header: string) {
  const tune = parseAbc(`X:1\n${header}\nK:C\nC D E F |]\n`).tunes[0]!;
  const built = buildAbcPracticeSequence(tune);
  if (built.status !== 'ok') throw new Error('expected ok');
  return built.piece;
}

describe('clampTempoBpm', () => {
  it('rounds and keeps the tempo in range', () => {
    expect(clampTempoBpm(92.4)).toBe(92);
    expect(clampTempoBpm(5)).toBe(MIN_TEMPO_BPM);
    expect(clampTempoBpm(5000)).toBe(MAX_TEMPO_BPM);
  });

  it('falls back for nonsense', () => {
    expect(clampTempoBpm(Number.NaN)).toBe(MIN_TEMPO_BPM);
    expect(clampTempoBpm(Number.NaN, 80)).toBe(80);
    expect(clampTempoBpm(Number.POSITIVE_INFINITY, 80)).toBe(80);
  });
});

describe('describeTempoSettings', () => {
  it('describes a tempo straight from the file', () => {
    const settings = describeTempoSettings(pieceOf('M:4/4\nL:1/4\nQ:1/4=100'), 100);
    expect(settings).toMatchObject({
      writtenBpm: 100,
      bpm: 100,
      unitSymbol: '♩',
      differs: false,
      writtenText: '♩ = 100',
      currentText: '♩ = 100',
      percentText: '100% of the written tempo',
      sliderMin: 25,
      sliderMax: 200,
    });
    expect(settings.hints).toEqual(['100% of the written tempo']);
  });

  it('reports a changed tempo as a percentage of the written one', () => {
    const settings = describeTempoSettings(pieceOf('M:4/4\nL:1/4\nQ:1/4=100'), 75);
    expect(settings).toMatchObject({ bpm: 75, differs: true, currentText: '♩ = 75' });
    expect(settings.percentText).toBe('75% of the written tempo');
    expect(settings.writtenText).toBe('♩ = 100');
  });

  it("counts in the piece's own beat: dotted quarter in 6/8, eighth when the file says so", () => {
    expect(describeTempoSettings(pieceOf('M:6/8\nL:1/8\nQ:3/8=60'), 60).unitSymbol).toBe('♩.');
    expect(describeTempoSettings(pieceOf('M:3/8\nL:1/16\nQ:1/8=120'), 120).unitSymbol).toBe('♪');
  });

  it('says so when the file has no tempo or no meter', () => {
    const settings = describeTempoSettings(pieceOf('L:1/4'), 80);
    expect(settings.percentText).toBe('100% of the default tempo');
    expect(settings.hints).toEqual([
      '100% of the default tempo',
      '(This file has no tempo marking; starting at ♩ = 80.)',
      '(No time signature in this file; assuming 4/4.)',
    ]);
    // A file with a meter but no tempo only mentions the tempo.
    expect(describeTempoSettings(pieceOf('M:3/4\nL:1/4'), 80).hints).toHaveLength(2);
  });

  it('keeps an out-of-range written tempo usable and the slider range sensible', () => {
    const fast = describeTempoSettings(pieceOf('M:4/4\nL:1/4\nQ:1/4=400'), 400);
    expect(fast.writtenBpm).toBe(MAX_TEMPO_BPM);
    expect(fast.bpm).toBe(MAX_TEMPO_BPM);
    expect(fast.sliderMax).toBe(MAX_TEMPO_BPM);
    expect(fast.sliderMin).toBeLessThanOrEqual(fast.sliderMax);
    const slow = describeTempoSettings(pieceOf('M:4/4\nL:1/4\nQ:1/4=30'), 30);
    expect(slow.sliderMin).toBe(MIN_TEMPO_BPM);
    expect(slow.sliderMax).toBe(60);
  });

  it('clamps a requested tempo and falls back to the written one for nonsense', () => {
    const piece = pieceOf('M:4/4\nL:1/4\nQ:1/4=100');
    expect(describeTempoSettings(piece, 9999).bpm).toBe(MAX_TEMPO_BPM);
    expect(describeTempoSettings(piece, Number.NaN).bpm).toBe(100);
  });
});
