#!/usr/bin/env node
/**
 * Differential test of the ABC parser's rhythm against `abcjs`, the reference
 * ABC library. Not part of the test suite (abcjs is not a dependency of this
 * repo and a randomized comparison against a third party does not belong in
 * CI); run it by hand after changing `src/abc/abc-parser.ts`:
 *
 *   mkdir /tmp/abcjs-ref && cd /tmp/abcjs-ref && npm init -y && npm i abcjs
 *   cd <repo>/packages/core
 *   node scripts/abcjs-crosscheck.mjs --abcjs /tmp/abcjs-ref [--count 4000] [--seed 1] [--files ../../abc-music]
 *
 * It bundles the parser with the repo's own esbuild, then compares the
 * (pitch, start, duration) of every note -- chords reduced to their top note,
 * as the app does -- for (a) every `.abc` file under `--files`, and (b) `--count`
 * random tunes mixing rests, ties, broken rhythm, tuplets, chords, multi-bar
 * rests and bar lines across several meters, unit lengths and keys.
 *
 * The generator deliberately stays inside the constructs where abcjs and the
 * ABC standard agree. Known, intentional differences (see
 * `packages/core/CLAUDE.md`, "ABC rhythm, meter and tempo") are *not*
 * generated or are skipped: rests longer than a bar (abcjs clamps them to a
 * bar), `(5` / `(7` / `(9` in compound time (abcjs ignores the compound
 * rule), tuplets whose notes differ in length, broken rhythm directly after a
 * tuplet, and grace notes.
 *
 * Exit status is non-zero if anything differs.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!flag?.startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`Usage: ${flag ?? ''} needs a value (see the header of this file)`);
    }
    args[flag.slice(2)] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.abcjs) throw new Error('--abcjs <directory with abcjs installed> is required');
const count = Number(args.count ?? 2000);
let seed = Number(args.seed ?? 1);

const here = resolve(fileURLToPath(import.meta.url), '..');
const repoRoot = resolve(here, '../../..');

// Bundle the parser (TypeScript) to CommonJS in a temp dir, then load it next to abcjs.
const esbuildPath = createRequire(join(repoRoot, 'package.json')).resolve('esbuild');
const { build } = await import(pathToFileURL(esbuildPath).href);
const outDir = mkdtempSync(join(tmpdir(), 'abc-parser-'));
const bundle = join(outDir, 'parser.cjs');
await build({
  entryPoints: [join(here, '../src/abc/abc-parser.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  outfile: bundle,
  logLevel: 'error',
});
const requireHere = createRequire(join(resolve(args.abcjs), 'package.json'));
const abcjs = requireHere('abcjs');
const { parseAbc } = createRequire(import.meta.url)(bundle);

// --- Comparison -----------------------------------------------------------------------

function oursOf(abc) {
  const tune = parseAbc(abc).tunes[0];
  const voice = tune.voices[0];
  const barLength = tune.meter ? tune.meter.barLengthWhole : 1;
  const longRest = voice.score.elements.some(
    (e) => e.type === 'rest' && e.duration > barLength + 1e-9,
  );
  const notes = voice.score.elements
    .filter((e) => e.type === 'note')
    .map((e) => [voice.notes[e.noteIndex], e.start, e.duration]);
  return { notes, longRest };
}

function theirsOf(abc) {
  const audio = abcjs.parseOnly(abc)[0].setUpAudio({});
  const byStart = new Map();
  for (const track of audio.tracks) {
    for (const e of track) {
      if (e.cmd !== 'note') continue;
      const key = e.start.toFixed(6);
      const current = byStart.get(key);
      if (!current || e.pitch > current[0]) byStart.set(key, [e.pitch, e.start, e.duration]);
    }
  }
  return [...byStart.values()].sort((a, b) => a[1] - b[1]);
}

function same(a, b) {
  return (
    a.length === b.length &&
    a.every(
      (x, i) =>
        x[0] === b[i][0] && Math.abs(x[1] - b[i][1]) < 1e-4 && Math.abs(x[2] - b[i][2]) < 1e-4,
    )
  );
}

let compared = 0;
let skipped = 0;
const failures = [];

function check(label, abc) {
  let ours;
  let theirs;
  try {
    ours = oursOf(abc);
    theirs = theirsOf(abc);
  } catch {
    skipped += 1;
    return;
  }
  if (ours.longRest) {
    skipped += 1;
    return;
  }
  compared += 1;
  if (!same(ours.notes, theirs)) failures.push({ label, abc, ours: ours.notes, theirs });
}

// (a) real files
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
if (args.files) {
  for (const file of walk(resolve(args.files)).filter((f) => f.endsWith('.abc'))) {
    check(file, readFileSync(file, 'utf8'));
  }
}

// (b) random tunes
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
const pick = (list) => list[Math.floor(random() * list.length)];
const LETTERS = 'CDEFGABcdefgab'.split('');
const LENGTHS = ['', '', '', '2', '3', '4', '/2', '/', '//', '3/2', '/4', '3/4', '6'];
const METERS = ['4/4', '3/4', '6/8', '2/4', 'C', 'C|', '9/8', '5/8', '3/8', '12/8', '2/2'];
const COMPOUND = new Set(['6/8', '9/8', '12/8']);
const UNITS = ['1/4', '1/8', '1/16', null, null];
const KEYS = ['C', 'G', 'D', 'F', 'Bb', 'Am', 'Edor'];
const note = () =>
  (random() < 0.15 ? pick(['^', '_', '=']) : '') +
  pick(LETTERS) +
  (random() < 0.2 ? pick([',', "'"]) : '');

function randomTune() {
  const meter = pick(METERS);
  const unit = pick(UNITS);
  const head =
    `X:1\nM:${meter}\n${unit ? `L:${unit}\n` : ''}` +
    (random() < 0.5 ? `Q:${pick(['1/4=90', '1/8=140', '3/8=50', '120', '1/2=60'])}\n` : '') +
    `K:${pick(KEYS)}\n`;
  const out = [];
  let previousWasNote = false;
  const length = 4 + Math.floor(random() * 24);
  for (let k = 0; k < length; k += 1) {
    const r = random();
    if (r < 0.12) {
      const group = pick(
        COMPOUND.has(meter)
          ? ['(3', '(3', '(2', '(4', '(6']
          : ['(3', '(3', '(2', '(4', '(5', '(6', '(7'],
      );
      const size = Number(/\((\d+)/.exec(group)[1]);
      const noteLength = pick(['', '', '2']); // equal lengths: abcjs and the standard agree
      out.push(group);
      for (let q = 0; q < size; q += 1) {
        out.push(note() + noteLength + (q < size - 1 && random() < 0.4 ? ' ' : ''));
      }
      out.push(' ');
      previousWasNote = false; // no broken rhythm straight after a tuplet
      continue;
    }
    let token;
    if (r < 0.2) {
      token = pick(['z', 'x']) + pick(LENGTHS);
      previousWasNote = false;
    } else if (r < 0.24) {
      token = `Z${pick(['', '2'])} `;
      previousWasNote = false;
    } else if (r < 0.32) {
      const plain = () => note().replace(/[\^_=]/g, '');
      token = `[${plain()}${plain()}]${pick(['', '2', '/2'])}`;
      previousWasNote = true;
    } else if (r < 0.42) {
      const first = note();
      token = `${first}${pick(LENGTHS)}-${random() < 0.5 ? '' : '|'}${first.replace(/[\^_=]/g, '')}${pick(LENGTHS)}`;
      previousWasNote = true;
    } else if (r < 0.52 && previousWasNote) {
      out.push(pick(['>', '<', '>>', '<<']) + note() + pick(LENGTHS));
      previousWasNote = true;
      continue;
    } else if (r < 0.62) {
      token = '|';
      previousWasNote = false;
    } else {
      token = note() + pick(LENGTHS);
      previousWasNote = true;
    }
    out.push(token, random() < 0.6 ? ' ' : '');
  }
  return `${head}${out.join('')} |]\n`;
}

for (let i = 0; i < count; i += 1) check(`random #${i}`, randomTune());

console.log(
  `compared ${compared} tunes with abcjs (${skipped} skipped: abcjs error or a rest longer than a bar), ${failures.length} differ`,
);
for (const failure of failures.slice(0, 5)) {
  console.log(`\n--- ${failure.label}\n${failure.abc}`);
  const show = (notes) =>
    notes.map((n) => `${n[0]}@${n[1].toFixed(4)}+${n[2].toFixed(4)}`).join(' ');
  console.log(`ours : ${show(failure.ours)}\nabcjs: ${show(failure.theirs)}`);
}
process.exit(failures.length === 0 ? 0 : 1);
