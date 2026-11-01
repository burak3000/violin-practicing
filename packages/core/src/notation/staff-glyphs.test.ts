import { describe, expect, it } from 'vitest';
import {
  SMUFL_ANCHORS,
  SMUFL_ENGRAVING,
  STAFF_GLYPHS,
  type StaffGlyphName,
} from './staff-glyphs.js';

/** FNV-1a, 32 bit: enough to pin a path string without embedding it twice. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const names = Object.keys(STAFF_GLYPHS) as StaffGlyphName[];

describe('STAFF_GLYPHS (generated from Bravura)', () => {
  it('still has the seven original outlines exactly as first generated', () => {
    // Hashes of the path data of the first version of the file (before the rhythm glyphs were added):
    // regenerating from the font must not move the clef, accidentals or notehead.
    const original: Record<string, string> = {
      gClef: '206729bc',
      accidentalSharp: '31398fe3',
      accidentalFlat: 'b89c74f8',
      accidentalNatural: 'd6e6354a',
      accidentalDoubleSharp: 'fa4ad3fb',
      accidentalDoubleFlat: 'ef415855',
      noteheadBlack: 'db1f9845',
    };
    for (const [name, hash] of Object.entries(original)) {
      expect(fnv1a(STAFF_GLYPHS[name as StaffGlyphName].path), name).toBe(hash);
    }
    expect(STAFF_GLYPHS.gClef.width).toBe(2.684);
    expect(STAFF_GLYPHS.noteheadBlack.width).toBe(1.18);
    expect(STAFF_GLYPHS.noteheadBlack.bounds).toEqual([0, -0.5, 1.18, 0.5]);
  });

  it('has every glyph the score layout draws', () => {
    const wanted: StaffGlyphName[] = [
      'noteheadWhole',
      'noteheadHalf',
      'flag8thUp',
      'flag8thDown',
      'flag16thUp',
      'flag16thDown',
      'flag32ndUp',
      'flag32ndDown',
      'restWhole',
      'restHalf',
      'restQuarter',
      'rest8th',
      'rest16th',
      'rest32nd',
      'timeSigCommon',
      'timeSigCutCommon',
      'augmentationDot',
      ...Array.from({ length: 10 }, (_, d) => `timeSig${d}` as StaffGlyphName),
      ...Array.from({ length: 10 }, (_, d) => `tuplet${d}` as StaffGlyphName),
    ];
    for (const name of wanted) expect(STAFF_GLYPHS[name], name).toBeDefined();
  });

  it('gives every glyph a closed outline, a positive advance and non-empty bounds', () => {
    expect(names.length).toBeGreaterThanOrEqual(44);
    for (const name of names) {
      const glyph = STAFF_GLYPHS[name];
      expect(glyph.path.startsWith('M'), name).toBe(true);
      expect(glyph.path.endsWith('Z'), name).toBe(true);
      expect(glyph.path, name).not.toMatch(/NaN|undefined/);
      expect(glyph.width, name).toBeGreaterThan(0);
      const [minX, minY, maxX, maxY] = glyph.bounds;
      expect(minX, name).toBeLessThan(maxX);
      expect(minY, name).toBeLessThan(maxY);
    }
  });

  it('uses staff-space units: a notehead is about a space tall, the clef about seven', () => {
    const head = STAFF_GLYPHS.noteheadBlack.bounds;
    expect(head[3] - head[1]).toBeCloseTo(1, 1);
    const clef = STAFF_GLYPHS.gClef.bounds;
    expect(clef[3] - clef[1]).toBeGreaterThan(6.5);
    expect(clef[3] - clef[1]).toBeLessThan(7.5);
  });

  it('has the time-signature digits two spaces tall around the origin, so they center on a staff position', () => {
    for (let d = 0; d <= 9; d += 1) {
      const [, minY, , maxY] = STAFF_GLYPHS[`timeSig${d}` as StaffGlyphName].bounds;
      expect(maxY - minY, `timeSig${d}`).toBeGreaterThan(1.9);
      expect(maxY - minY, `timeSig${d}`).toBeLessThan(2.2);
      expect((maxY + minY) / 2, `timeSig${d}`).toBeCloseTo(0, 1);
    }
  });

  it('hangs flags from the stem tip: up flags extend downward (+y), down flags upward (-y)', () => {
    for (const n of ['8th', '16th', '32nd']) {
      expect(STAFF_GLYPHS[`flag${n}Up` as StaffGlyphName].bounds[3], n).toBeGreaterThan(3);
      expect(STAFF_GLYPHS[`flag${n}Down` as StaffGlyphName].bounds[1], n).toBeLessThan(-3);
    }
  });
});

describe('SMUFL_ANCHORS and SMUFL_ENGRAVING', () => {
  it('attaches an up stem at the right edge of the head, slightly above its center (y points down)', () => {
    expect(SMUFL_ANCHORS.noteheadBlack.stemUpSE[0]).toBeCloseTo(
      STAFF_GLYPHS.noteheadBlack.width,
      3,
    );
    expect(SMUFL_ANCHORS.noteheadBlack.stemUpSE[1]).toBeLessThan(0);
    expect(SMUFL_ANCHORS.noteheadBlack.stemDownNW[0]).toBe(0);
    expect(SMUFL_ANCHORS.noteheadBlack.stemDownNW[1]).toBeGreaterThan(0);
    expect(SMUFL_ANCHORS.noteheadHalf.stemUpSE[0]).toBeCloseTo(STAFF_GLYPHS.noteheadHalf.width, 3);
  });

  it('gives every flag its stem corner', () => {
    expect(SMUFL_ANCHORS.flag8thUp.stemUpNW[0]).toBe(0);
    expect(SMUFL_ANCHORS.flag16thUp.stemUpNW).toBeDefined();
    expect(SMUFL_ANCHORS.flag32ndUp.stemUpNW).toBeDefined();
    expect(SMUFL_ANCHORS.flag8thDown.stemDownSW).toBeDefined();
    expect(SMUFL_ANCHORS.flag16thDown.stemDownSW).toBeDefined();
    expect(SMUFL_ANCHORS.flag32ndDown.stemDownSW).toBeDefined();
  });

  it('carries the font thicknesses the layout draws with', () => {
    expect(SMUFL_ENGRAVING.stemThickness).toBe(0.12);
    expect(SMUFL_ENGRAVING.beamThickness).toBe(0.5);
    expect(SMUFL_ENGRAVING.beamSpacing).toBe(0.25);
    expect(SMUFL_ENGRAVING.staffLineThickness).toBe(0.13);
    expect(SMUFL_ENGRAVING.thinBarlineThickness).toBeLessThan(
      SMUFL_ENGRAVING.thickBarlineThickness,
    );
    for (const [name, value] of Object.entries(SMUFL_ENGRAVING)) {
      expect(value, name).toBeGreaterThan(0);
      expect(value, name).toBeLessThan(1.5);
    }
  });
});
