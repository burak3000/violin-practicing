#!/usr/bin/env node
/**
 * Regenerates `src/notation/staff-glyphs.ts` from the Bravura music font.
 *
 *   node scripts/generate-staff-glyphs.mjs \
 *     --font <path to Bravura.otf> \
 *     --metadata <path to Bravura.json (the SMuFL metadata file shipped with the font)> \
 *     --out <path of the .ts file to write> \
 *     [--opentype <path to the opentype.js ES module, e.g. .../opentype.js/dist/opentype.module.js>]
 *
 * Why a script and not hand-edited paths: the outlines must stay exactly what
 * the font draws (stem anchors and flag shapes are only correct against the
 * font's own geometry), so the file is always produced from the font, never
 * edited by hand. The font and its metadata are *inputs*, deliberately not
 * checked in (the generated outlines are; the font's licence travels with
 * them in the output's header). `opentype.js` is likewise not a dependency of
 * the repo -- point `--opentype` at any copy, or install it somewhere Node's
 * normal resolution finds it. Run it from a directory that is not the
 * download directory of the font.
 *
 * Units: SMuFL fixes one em at four staff spaces, so a font unit of Bravura
 * (1000 per em) is 1/250 of a staff space. The script flips y (fonts and the
 * SMuFL metadata point up, the notation layout points down) and rounds to
 * three decimals, which is far finer than a pixel at any size the app draws.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// --- Arguments ---------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    args[arg.slice(2)] = value;
    i += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.font || !args.metadata || !args.out) {
  console.error(
    'usage: generate-staff-glyphs.mjs --font <Bravura.otf> --metadata <Bravura.json> --out <staff-glyphs.ts> [--opentype <opentype module path>]',
  );
  process.exit(2);
}

const opentypeModule = args.opentype
  ? await import(pathToFileURL(resolve(args.opentype)).href)
  : await import('opentype.js');
const opentype = opentypeModule.default ?? opentypeModule;

// --- What to extract ----------------------------------------------------------------

/** One em is four staff spaces (SMuFL); Bravura has 1000 font units per em. */
const FONT_UNITS_PER_STAFF_SPACE = 250;
const DECIMALS = 3;

/**
 * The glyphs, in output order: [name, SMuFL code point, what it is for].
 * The first seven are the original set (clef, accidentals, quarter notehead);
 * the rest were added for the rhythmic score layout.
 */
const GLYPHS = [
  ['gClef', 0xe050, 'treble clef'],
  ['accidentalSharp', 0xe262, 'sharp'],
  ['accidentalFlat', 0xe260, 'flat'],
  ['accidentalNatural', 0xe261, 'natural'],
  ['accidentalDoubleSharp', 0xe263, 'double sharp'],
  ['accidentalDoubleFlat', 0xe264, 'double flat'],
  ['noteheadBlack', 0xe0a4, 'filled notehead (quarter note and shorter)'],
  ['noteheadWhole', 0xe0a2, 'whole-note head'],
  ['noteheadHalf', 0xe0a3, 'open half-note head'],
  ['flag8thUp', 0xe240, 'eighth-note flag on an up stem'],
  ['flag8thDown', 0xe241, 'eighth-note flag on a down stem'],
  ['flag16thUp', 0xe242, 'sixteenth-note flags on an up stem'],
  ['flag16thDown', 0xe243, 'sixteenth-note flags on a down stem'],
  ['flag32ndUp', 0xe244, 'thirty-second-note flags on an up stem'],
  ['flag32ndDown', 0xe245, 'thirty-second-note flags on a down stem'],
  ['restWhole', 0xe4e3, 'whole rest'],
  ['restHalf', 0xe4e4, 'half rest'],
  ['restQuarter', 0xe4e5, 'quarter rest'],
  ['rest8th', 0xe4e6, 'eighth rest'],
  ['rest16th', 0xe4e7, 'sixteenth rest'],
  ['rest32nd', 0xe4e8, 'thirty-second rest'],
  ...Array.from({ length: 10 }, (_, d) => [`timeSig${d}`, 0xe080 + d, `time-signature digit ${d}`]),
  ['timeSigCommon', 0xe08a, 'common-time C'],
  ['timeSigCutCommon', 0xe08b, 'cut-time C with a vertical stroke'],
  ['augmentationDot', 0xe1e7, 'augmentation dot'],
  ...Array.from({ length: 10 }, (_, d) => [`tuplet${d}`, 0xe880 + d, `tuplet digit ${d}`]),
];

/** SMuFL metadata anchors to export (all are in the font's y-up space; they are flipped here). */
const ANCHOR_GLYPHS = [
  'noteheadBlack',
  'noteheadHalf',
  'noteheadWhole',
  'flag8thUp',
  'flag8thDown',
  'flag16thUp',
  'flag16thDown',
  'flag32ndUp',
  'flag32ndDown',
];

/** `engravingDefaults` entries the layout uses (staff spaces, thicknesses and separations). */
const ENGRAVING_KEYS = [
  'staffLineThickness',
  'stemThickness',
  'beamThickness',
  'beamSpacing',
  'legerLineThickness',
  'legerLineExtension',
  'thinBarlineThickness',
  'thickBarlineThickness',
  'barlineSeparation',
  'thinThickBarlineSeparation',
  'repeatBarlineDotSeparation',
  'tieEndpointThickness',
  'tieMidpointThickness',
  'tupletBracketThickness',
];

// --- Formatting --------------------------------------------------------------------

/** Rounds to three decimals and prints integers with ".0", matching the first version of this file. */
function round(n) {
  const r = Math.round(n * 10 ** DECIMALS) / 10 ** DECIMALS;
  return Object.is(r, -0) ? 0 : r;
}

function num(n) {
  const r = round(n);
  return Number.isInteger(r) ? r.toFixed(1) : String(r);
}

/**
 * Serializes an opentype.js path as compact SVG path data: a command letter
 * followed by its numbers (space-separated, trailing zeros trimmed), with
 * axis-aligned lines written as H/V. (opentype.js's own toPathData pads
 * decimals and runs numbers together, which is neither short nor stable.)
 */
function pathData(commands) {
  let out = '';
  let x = 0;
  let y = 0;
  const coords = (...values) => values.map((v) => String(round(v))).join(' ');
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        out += `M${coords(c.x, c.y)}`;
        break;
      case 'L':
        if (round(c.x) === round(x)) out += `V${coords(c.y)}`;
        else if (round(c.y) === round(y)) out += `H${coords(c.x)}`;
        else out += `L${coords(c.x, c.y)}`;
        break;
      case 'C':
        out += `C${coords(c.x1, c.y1, c.x2, c.y2, c.x, c.y)}`;
        break;
      case 'Q':
        out += `Q${coords(c.x1, c.y1, c.x, c.y)}`;
        break;
      case 'Z':
        out += 'Z';
        break;
      default:
        throw new Error(`Unexpected path command ${c.type}`);
    }
    if (c.type !== 'Z') {
      x = c.x;
      y = c.y;
    }
  }
  return out;
}

function pair(p) {
  return `[${num(p[0])}, ${num(p[1])}]`;
}

// --- Extraction ---------------------------------------------------------------------

const fontBytes = readFileSync(resolve(args.font));
// parse() instead of loadSync(): the ES-module build of opentype.js 1.3.x calls require() inside loadSync.
const font = opentype.parse(
  fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength),
);
if (font.unitsPerEm !== 1000) {
  throw new Error(`Expected Bravura's 1000 units per em, got ${font.unitsPerEm}`);
}
const metadata = JSON.parse(readFileSync(resolve(args.metadata), 'utf8'));

function extractGlyph([name, codePoint]) {
  const glyph = font.charToGlyph(String.fromCodePoint(codePoint));
  if (!glyph || glyph.unicode !== codePoint) {
    throw new Error(`Font has no glyph for U+${codePoint.toString(16).toUpperCase()} (${name})`);
  }
  // fontSize = four staff spaces (one em); opentype.js already flips y to point down.
  const path = glyph.getPath(0, 0, 4);
  const box = path.getBoundingBox();
  return {
    name,
    path: pathData(path.commands),
    width: glyph.advanceWidth / FONT_UNITS_PER_STAFF_SPACE,
    bounds: [box.x1, box.y1, box.x2, box.y2],
  };
}

const glyphs = GLYPHS.map(extractGlyph);

function flipAnchor([x, y]) {
  return [x, -y];
}

const anchorLines = ANCHOR_GLYPHS.map((name) => {
  const anchors = metadata.glyphsWithAnchors?.[name];
  if (!anchors) throw new Error(`Metadata has no anchors for ${name}`);
  const wanted = Object.keys(anchors).filter((key) => /^stem(Up|Down)(NW|NE|SW|SE)$/.test(key));
  if (wanted.length === 0) return `  ${name}: {},`;
  const entries = wanted.sort().map((key) => `${key}: ${pair(flipAnchor(anchors[key]))}`);
  return `  ${name}: { ${entries.join(', ')} },`;
});

const engravingLines = ENGRAVING_KEYS.map((key) => {
  const value = metadata.engravingDefaults?.[key];
  if (typeof value !== 'number') throw new Error(`Metadata has no engravingDefaults.${key}`);
  return `  ${key}: ${num(value)},`;
});

// --- Output -------------------------------------------------------------------------

const codePointList = GLYPHS.map(
  ([name, cp]) => `U+${cp.toString(16).toUpperCase()} (${name})`,
).join(', ');

const header = `/**
 * Music-notation glyph outlines for the staff display, as SVG path data in
 * **staff-space units** (one unit = the distance between two staff lines),
 * y pointing down, each glyph's origin at its SMuFL reference point (the G
 * line for the clef; the pitch position for accidentals and noteheads; the
 * left edge on the pitch position for the noteheads; the stem attachment
 * point's flag origin for flags; the rest's staff reference point for rests;
 * the vertical center of the digit for time-signature and tuplet digits).
 *
 * Generated from the Bravura font -- the SMuFL reference music font,
 * Copyright (c) Steinberg Media Technologies GmbH, licensed under the SIL
 * Open Font License 1.1 (https://openfontlicense.org) -- by
 * \`scripts/generate-staff-glyphs.mjs\`, which extracts the outlines of
 * ${codePointList} and divides the font units by 250 (SMuFL: one em is four
 * staff spaces; Bravura is 1000 units per em). The stem-attachment anchors and
 * engraving thicknesses below are read from the font's SMuFL metadata
 * (bravura_metadata.json) by the same script and flipped to y down.
 * Embedding outlines instead of relying on a music font keeps the staff
 * identical on every platform and removes any font-installation dependency
 * (the Unicode musical-symbols block is not reliably present on every OS,
 * and React Native cannot count on it at all).
 *
 * Do not edit by hand; regenerate from the font if a glyph needs to change.
 */
`;

const nameUnion = glyphs.map((g) => `  | '${g.name}'`).join('\n');

const glyphEntries = glyphs
  .map(
    (g) => `  ${g.name}: {
    path: '${g.path}',
    width: ${num(g.width)},
    bounds: [${g.bounds.map(num).join(', ')}],
  },`,
  )
  .join('\n');

const output = `${header}
export type StaffGlyphName =
${nameUnion};

export interface StaffGlyph {
  /** SVG path data, staff-space units, y down. */
  readonly path: string;
  /** Advance width in staff spaces. */
  readonly width: number;
  /** [minX, minY, maxX, maxY] of the outline, in staff spaces, relative to the glyph origin. */
  readonly bounds: readonly [number, number, number, number];
}

export const STAFF_GLYPHS: Readonly<Record<StaffGlyphName, StaffGlyph>> = {
${glyphEntries}
};

/**
 * Stem attachment points from the SMuFL metadata, in staff spaces relative to
 * each glyph's origin with y pointing down (the metadata itself points up).
 * Names follow SMuFL: the corner of the *stem* that touches the glyph, so
 * \`stemUpSE\` on a notehead is where the bottom-right corner of an up stem
 * meets the head, and \`stemUpNW\` on a flag is where the top-left corner of
 * the stem meets the flag (put the flag's origin at the stem tip minus this).
 */
export const SMUFL_ANCHORS = {
${anchorLines.join('\n')}
} as const satisfies Record<string, Readonly<Record<string, readonly [number, number]>>>;

/** The font's recommended thicknesses and separations (SMuFL \`engravingDefaults\`), in staff spaces. */
export const SMUFL_ENGRAVING = {
${engravingLines.join('\n')}
} as const;
`;

writeFileSync(resolve(args.out), output);
console.log(`wrote ${glyphs.length} glyphs to ${args.out}`);
