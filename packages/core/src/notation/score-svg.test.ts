import { describe, expect, it } from 'vitest';
import { layoutScore, type ScoreLayout, type ScorePrimitive } from './score-layout.js';
import { scoreLayoutToSvg } from './score-svg.js';
import { STAFF_GLYPHS } from './staff-glyphs.js';
import { buildPiece } from './test-support/piece-builder.js';

const SPEC =
  'F#4:3/8 G3:1/8 ^A4:1/8 ^B4:1/8 z:1/4 | (3 C5:1/8 ^D5:1/8 ^E5:1/8 G4:5/8 A4:1/4 | G4:1/2 ^G4:1/16 ^A4:1/16 ^B4:1/8 z:1/4 |]';

function layout(spec = SPEC, firstBar = 0): ScoreLayout {
  return layoutScore(buildPiece(spec, { key: 1 }), { firstBar, widthSpaces: 120 });
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('scoreLayoutToSvg', () => {
  const l = layout();
  const svg = scoreLayoutToSvg(l, { unitPx: 20 });

  it('is one complete svg element with the layout view box and a pixel size from the unit', () => {
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    const [x, y, w, h] = l.viewBox;
    const num = (n: number) => String(Math.round(n * 1000) / 1000);
    expect(svg).toContain(`viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}"`);
    expect(svg).toContain(`width="${num(w * 20)}"`);
    expect(svg).toContain(`height="${num(h * 20)}"`);
  });

  it('uses only the fixed set of tags and is well formed', () => {
    const tags = new Set([...svg.matchAll(/<\/?([a-zA-Z]+)/g)].map((m) => m[1]));
    expect([...tags].sort()).toEqual(
      ['circle', 'defs', 'line', 'path', 'polygon', 'svg', 'use'].filter((t) => tags.has(t)),
    );
    // Remove every self-closing element, the svg wrapper and the defs wrapper: nothing may be left.
    const stripped = svg
      .replace(/<(path|line|use|polygon|circle)\b[^<>]*\/>/g, '')
      .replace(/<svg\b[^<>]*>/, '')
      .replace('</svg>', '')
      .replace('<defs>', '')
      .replace('</defs>', '');
    expect(stripped).toBe('');
  });

  it('contains no stray values (NaN, undefined, Infinity, null)', () => {
    expect(svg).not.toMatch(/NaN|undefined|Infinity|null/);
  });

  it('writes each glyph outline once, in defs, and reuses it with a translate transform', () => {
    expect(count(svg, 'id="sg-noteheadBlack"')).toBe(1);
    expect(count(svg, STAFF_GLYPHS.noteheadBlack.path)).toBe(1);
    const heads = l.primitives.filter(
      (p) => p.kind === 'glyph' && p.glyph === 'noteheadBlack',
    ).length;
    expect(heads).toBeGreaterThan(3);
    expect(count(svg, '<use href="#sg-noteheadBlack"')).toBe(heads);
    expect(svg).toMatch(/<use href="#sg-noteheadBlack" transform="translate\(-?[\d.]+ -?[\d.]+\)"/);
  });

  it('defines only the glyphs the layout uses', () => {
    expect(svg).not.toContain('id="sg-timeSig7"');
    expect(svg).not.toContain('id="sg-restWhole"');
    expect(svg).toContain('id="sg-gClef"');
    expect(svg).toContain('id="sg-restQuarter"');
  });

  it('marks every drawn element with its part, and note parts with their note index', () => {
    const elements = svg
      .match(/<(?:line|use|polygon|path|circle)\b[^<>]*\/>/g)!
      .filter((e) => !e.includes('id="sg-'));
    expect(elements).toHaveLength(l.primitives.length);
    for (const element of elements) expect(element).toMatch(/data-part="[a-z-]+"/);

    const withNote = l.primitives.filter((p) => p.noteIndex !== undefined);
    expect(withNote.length).toBeGreaterThan(10);
    expect(count(svg, 'data-note="')).toBe(withNote.length);
    for (const primitive of l.primitives.filter(
      (p) => p.part === 'staff-line' || p.part === 'beam',
    )) {
      expect(primitive.noteIndex).toBeUndefined();
    }
    expect(svg).toMatch(/<use href="#sg-noteheadBlack"[^>]*data-part="head" data-note="1"/);
  });

  it('lets a UI restyle one note by selector: exactly that note carries its data-note', () => {
    const forNote1 = l.primitives.filter((p) => p.noteIndex === 1).length;
    expect(count(svg, 'data-note="1"')).toBe(forNote1);
  });

  it('defaults to currentColor', () => {
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('fill="currentColor"');
  });

  it('colors primitives through colorFor (fill for shapes, stroke for lines)', () => {
    const colored = scoreLayoutToSvg(l, {
      unitPx: 20,
      colorFor: (p: ScorePrimitive) => (p.noteIndex === 2 ? '#0a7d2f' : undefined),
    });
    const wanted = l.primitives.filter((p) => p.noteIndex === 2).length;
    expect(wanted).toBeGreaterThan(1);
    expect(count(colored, '#0a7d2f')).toBe(wanted);
    // Every element with the color has that note index.
    for (const element of colored.match(/<[^<>]*#0a7d2f[^<>]*\/>/g)!) {
      expect(element).toContain('data-note="2"');
    }
    const stem = colored.match(/<line[^>]*data-part="stem" data-note="2"\/>/)![0];
    expect(stem).toContain('stroke="#0a7d2f"');
    const head = colored.match(/<use[^>]*data-part="head" data-note="2"\/>/)![0];
    expect(head).toContain('fill="#0a7d2f"');
  });

  it('escapes a hostile colour string instead of injecting markup', () => {
    const hostile = scoreLayoutToSvg(l, {
      unitPx: 10,
      colorFor: () => '"><script>alert(1)</script><x a="',
    });
    expect(hostile).not.toContain('<script');
    expect(hostile).not.toContain('<x ');
    expect(hostile).toContain('&lt;script&gt;');
    expect(hostile).toContain('&quot;');
  });

  it('uses the id prefix for glyph ids and references', () => {
    const prefixed = scoreLayoutToSvg(l, { unitPx: 10, idPrefix: 'score7' });
    expect(prefixed).toContain('id="score7-gClef"');
    expect(prefixed).toContain('href="#score7-gClef"');
    expect(prefixed).not.toContain('"sg-');
  });

  it('draws ties as filled paths and tuplet brackets as stroked open paths', () => {
    const tie = svg.match(/<path d="[^"]*" fill="currentColor" data-part="tie"[^>]*\/>/);
    expect(tie).not.toBeNull();
    const bracketLayout = layout('(3 G4:1/4 A4:1/4 B4:1/4 C5:1/2 |');
    const bracketSvg = scoreLayoutToSvg(bracketLayout, { unitPx: 10 });
    expect(bracketSvg).toMatch(
      /<path d="[^"]*" fill="none" stroke="currentColor" stroke-width="0.16"[^>]*data-part="tuplet"\/>/,
    );
  });

  it('is deterministic and compact', () => {
    expect(scoreLayoutToSvg(l, { unitPx: 20 })).toBe(svg);
    expect(svg.length).toBeLessThan(40_000);
  });

  it('survives a bad unit and an empty layout', () => {
    const bad = scoreLayoutToSvg(l, { unitPx: Number.NaN });
    expect(bad).not.toMatch(/NaN/);
    const empty = scoreLayoutToSvg(layout(''), { unitPx: 12 });
    expect(empty.startsWith('<svg ')).toBe(true);
    expect(empty.endsWith('</svg>')).toBe(true);
  });

  it('renders a later window too', () => {
    const later = scoreLayoutToSvg(layout(SPEC, 2), { unitPx: 14 });
    expect(later).toContain('data-part="clef"');
    expect(later).not.toMatch(/NaN/);
  });
});
