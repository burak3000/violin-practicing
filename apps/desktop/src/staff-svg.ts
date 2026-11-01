/**
 * Draws a treble-clef staff with notes as an inline SVG, from
 * `packages/core`'s pure `layoutStaff` geometry (staff-space units, shared
 * with mobile) and its embedded Bravura glyph outlines -- so the staff looks
 * the same on every machine with no music font installed. Colors come from the
 * stylesheet (`.staff` / `.staff-note-*` in index.css), not from this file.
 */

import {
  STAFF_GLYPHS,
  formatSpelling,
  sizeStaff,
  type StaffGlyphName,
  type StaffNote,
} from '@violin/core';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
  return el;
}

function glyphPath(glyph: StaffGlyphName, x: number, y: number): SVGPathElement {
  return svgEl('path', {
    d: STAFF_GLYPHS[glyph].path,
    transform: `translate(${x} ${y})`,
    fill: 'currentColor',
  });
}

/** Accessible description: the target, then what follows it. */
function describe(notes: ReadonlyArray<Pick<StaffNote, 'spelling' | 'role'>>): string {
  const target = notes.find((n) => n.role === 'target');
  const upcoming = notes.filter((n) => n.role === 'upcoming');
  const parts = [target ? `Target note ${formatSpelling(target.spelling)}` : 'No target note'];
  if (upcoming.length > 0) {
    parts.push(`then ${upcoming.map((n) => formatSpelling(n.spelling)).join(' ')}`);
  }
  return parts.join(', ');
}

/**
 * `lookahead`: the notes after the first are a preview of what's coming --
 * draw as many as fit across the width (see `sizeStaff`), not all of them.
 */
export function renderStaff(
  notes: readonly StaffNote[],
  availableWidthPx: number,
  maxHeightPx: number,
  lookahead: boolean,
): SVGSVGElement {
  const size = sizeStaff(notes, availableWidthPx, { maxHeightPx, lookahead });
  const layout = size.layout;
  const [minX, minY, width, height] = layout.viewBox;
  const svg = svgEl('svg', {
    class: 'staff',
    width: size.widthPx,
    height: size.heightPx,
    viewBox: `${minX} ${minY} ${width} ${height}`,
    role: 'img',
    'aria-label': describe(layout.notes),
  });

  for (const y of layout.lineYs) {
    svg.append(
      svgEl('line', {
        class: 'staff-line',
        x1: layout.lineX1,
        x2: layout.lineX2,
        y1: y,
        y2: y,
        stroke: 'currentColor',
        'stroke-width': layout.lineWidth,
      }),
    );
  }

  svg.append(glyphPath(layout.clef.glyph, layout.clef.x, layout.clef.y));

  for (const note of layout.notes) {
    const group = svgEl('g', { class: `staff-note staff-note-${note.role}` });
    for (const ledger of note.ledgerLines) {
      group.append(
        svgEl('line', {
          x1: ledger.x1,
          x2: ledger.x2,
          y1: ledger.y,
          y2: ledger.y,
          stroke: 'currentColor',
          'stroke-width': layout.lineWidth,
        }),
      );
    }
    if (note.accidental) {
      group.append(glyphPath(note.accidental.glyph, note.accidental.x, note.y));
    }
    group.append(glyphPath('noteheadBlack', note.x, note.y));
    group.append(
      svgEl('line', {
        x1: note.stem.x,
        x2: note.stem.x,
        y1: note.stem.y1,
        y2: note.stem.y2,
        stroke: 'currentColor',
        'stroke-width': layout.stemWidth,
      }),
    );
    svg.append(group);
  }
  return svg;
}
