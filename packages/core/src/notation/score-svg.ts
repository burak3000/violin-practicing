/**
 * Turns a `ScoreLayout` into a complete SVG document string.
 *
 * Desktop sets it as `innerHTML`; mobile does not use it (it maps the same
 * primitives onto `react-native-svg` elements), but keeping the string
 * renderer here, next to the layout and tested with it, means the two
 * renderers cannot drift in what a primitive means.
 *
 * ## Why a string is safe to inject
 *
 * The markup is built only from numbers and a fixed set of tag and attribute
 * names. There is no user text in a score drawing (titles, lyrics and chord
 * symbols are not rendered), so nothing needs escaping except the colours a
 * caller passes in, which are escaped anyway.
 *
 * ## Shape of the output
 *
 * - Each glyph outline used is written **once** in `<defs>` and every
 *   occurrence is a `<use href>` with a `transform="translate(x y)"`, so a
 *   window with forty noteheads carries one notehead path.
 * - Every element has `data-part` (what the primitive is part of); those that
 *   belong to a practice note also have `data-note="<noteIndex>"`, so a UI can
 *   restyle one note with a selector (`[data-note="12"] { color: green }`)
 *   without re-rendering.
 * - Colour defaults to `currentColor` (set `color` on the container). A
 *   `colorFor(primitive)` callback overrides it per primitive: the fill for
 *   shapes, the stroke for lines and open paths.
 */

import type { ScoreLayout, ScorePrimitive } from './score-layout.js';
import { STAFF_GLYPHS, type StaffGlyphName } from './staff-glyphs.js';

export interface ScoreSvgOptions {
  /** px per staff space: sets the `width`/`height` attributes from the layout's view box. */
  readonly unitPx: number;
  /** A CSS colour for a primitive, or `undefined` for the default (`currentColor`). */
  readonly colorFor?: (primitive: ScorePrimitive) => string | undefined;
  /** Prefix of the glyph ids in `<defs>` (default `sg`). Use distinct prefixes only if the outlines could ever differ; identical definitions with the same id are harmless on one page. */
  readonly idPrefix?: string;
}

/** A finite number as short text (at most 3 decimals); anything else becomes 0 rather than leaking `NaN` into markup. */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `data-part` / `data-note` attributes. */
function dataAttributes(p: ScorePrimitive): string {
  const note = p.noteIndex === undefined ? '' : ` data-note="${num(p.noteIndex)}"`;
  return ` data-part="${p.part}"${note}`;
}

export function scoreLayoutToSvg(layout: ScoreLayout, options: ScoreSvgOptions): string {
  const unit = Number.isFinite(options.unitPx) && options.unitPx > 0 ? options.unitPx : 1;
  const prefix = options.idPrefix ?? 'sg';
  const [minX, minY, width, height] = layout.viewBox;

  const used = new Set<StaffGlyphName>();
  for (const p of layout.primitives) if (p.kind === 'glyph') used.add(p.glyph);

  const colour = (p: ScorePrimitive): string => {
    const custom = options.colorFor?.(p);
    return custom === undefined ? 'currentColor' : escapeAttribute(custom);
  };

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(minX)} ${num(minY)} ${num(width)} ${num(height)}"` +
      ` width="${num(width * unit)}" height="${num(height * unit)}" preserveAspectRatio="xMinYMin meet"` +
      ` fill="currentColor" stroke="none">`,
  );

  if (used.size > 0) {
    parts.push('<defs>');
    for (const name of [...used].sort()) {
      parts.push(`<path id="${prefix}-${name}" d="${STAFF_GLYPHS[name].path}"/>`);
    }
    parts.push('</defs>');
  }

  for (const p of layout.primitives) {
    const data = dataAttributes(p);
    switch (p.kind) {
      case 'line':
        parts.push(
          `<line x1="${num(p.x1)}" y1="${num(p.y1)}" x2="${num(p.x2)}" y2="${num(p.y2)}"` +
            ` stroke="${colour(p)}" stroke-width="${num(p.width)}"${data}/>`,
        );
        break;
      case 'glyph':
        parts.push(
          `<use href="#${prefix}-${p.glyph}" transform="translate(${num(p.x)} ${num(p.y)})"` +
            ` fill="${colour(p)}"${data}/>`,
        );
        break;
      case 'polygon':
        parts.push(
          `<polygon points="${p.points.map((pt) => `${num(pt[0])},${num(pt[1])}`).join(' ')}"` +
            ` fill="${colour(p)}"${data}/>`,
        );
        break;
      case 'path':
        parts.push(
          p.filled
            ? `<path d="${p.d}" fill="${colour(p)}"${data}/>`
            : `<path d="${p.d}" fill="none" stroke="${colour(p)}" stroke-width="${num(p.width)}"` +
                ` stroke-linecap="round" stroke-linejoin="round"${data}/>`,
        );
        break;
      case 'circle':
        parts.push(
          `<circle cx="${num(p.cx)}" cy="${num(p.cy)}" r="${num(p.r)}" fill="${colour(p)}"${data}/>`,
        );
        break;
    }
  }

  parts.push('</svg>');
  return parts.join('');
}
