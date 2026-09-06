#!/usr/bin/env node
// Generates src/components/cards/artwork/decoratedCustom/*.ts: a relabeled duplicate of
// decorated/*.ts where every baked color literal is replaced by a named constant from
// decoratedCustom/colors.ts, so this copy accepts color overrides as props (see colors.ts's
// buildColorOverrideMap) instead of being permanently fixed - used for the "invert dark mode
// colors" setting (see stores/settings.tsx). The original decorated/ pack is never modified by
// this script and stays as a preserved fallback.
//
//   node scripts/generate-decorated-custom-pack.mjs
//
// Re-run this whenever decorated/*.ts changes (e.g. regenerated from a new source sheet via
// generate-card-artwork.mjs/generate-court-figures.mjs) to pick up the change here too.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARTWORK_DIR = join(__dirname, '..', 'src', 'components', 'cards', 'artwork');
const SRC_DIR = join(ARTWORK_DIR, 'decorated');
const OUT_DIR = join(ARTWORK_DIR, 'decoratedCustom');
const DATA_FILES = ['hearts.ts', 'diamonds.ts', 'clubs.ts', 'spades.ts', 'courtFigures.ts'];

// Exact literal -> constant-name substitutions, confirmed against the source data via:
//   grep -ohE '"?fill"?[[:space:]]*:[[:space:]]*"[^"]*"' decorated/*.ts | sort | uniq -c
//   grep -ohE '"?stroke"?[[:space:]]*:[[:space:]]*"[^"]*"' decorated/*.ts | sort | uniq -c
// Two distinct formats are mixed in the source data: unquoted-key-with-space (hearts/diamonds/
// clubs/spades.ts, and most of courtFigures.ts) and quoted-key-no-space (a minority of
// courtFigures.ts specifically - see generate-court-figures.mjs's "second copy, for the overlap it
// contributes" mechanism, per types.ts's DecoratedShape.clipRect doc comment; apparently a
// different code path that serializes some shapes via plain JSON.stringify rather than the
// pretty-printed style everything else uses). A first version of this script only handled the
// first format and silently missed ~800 quoted-style literals in courtFigures.ts - both are
// covered now. Every literal below is distinct and non-overlapping - order doesn't matter.
// `fill: "none"` (either format) is deliberately absent: it's an SVG sentinel ("no fill"), not a
// color, and must pass through unchanged.
const SUBSTITUTIONS = [
  // unquoted key, space after colon
  ['fill: "black"', 'fill: INK_BLACK'],
  ['fill: "#000000"', 'fill: INK_BLACK'],
  ['stroke: "#000000"', 'stroke: INK_BLACK'],
  ['fill: "#1C1585"', 'fill: NAVY'],
  ['fill: "#E61408"', 'fill: INK_RED_ALT'],
  ['fill: "#E6180A"', 'fill: INK_RED'],
  ['fill: "#e6180a"', 'fill: INK_RED'],
  ['fill: "#F8C20F"', 'fill: GOLD'],
  ['fill: "#FFFFFF"', 'fill: CARD_WHITE'],
  ['fill: "#ffffff"', 'fill: CARD_WHITE'],
  // quoted key, no space after colon
  ['"fill":"black"', '"fill":INK_BLACK'],
  ['"fill":"#000000"', '"fill":INK_BLACK'],
  ['"stroke":"#000000"', '"stroke":INK_BLACK'],
  ['"fill":"#1C1585"', '"fill":NAVY'],
  ['"fill":"#E61408"', '"fill":INK_RED_ALT'],
  ['"fill":"#E6180A"', '"fill":INK_RED'],
  ['"fill":"#e6180a"', '"fill":INK_RED'],
  ['"fill":"#F8C20F"', '"fill":GOLD'],
  ['"fill":"#FFFFFF"', '"fill":CARD_WHITE'],
  ['"fill":"#ffffff"', '"fill":CARD_WHITE']
];

// Every constant name a substitution above might introduce - only the ones that actually show up
// in a given file's output get imported there, since not every suit/court file uses every color
// (e.g. a black suit's file never had a red literal to begin with, so importing INK_RED into it
// would be flagged as unused under this repo's noUnusedLocals).
const ALL_CONSTANTS = ['CARD_WHITE', 'GOLD', 'INK_BLACK', 'INK_RED_ALT', 'INK_RED', 'NAVY'];

function noteFor(filename) {
  return (
    `// Relabeled by scripts/generate-decorated-custom-pack.mjs from decorated/${filename}: every\n` +
    `// baked color literal below is replaced by a named constant from ./colors.ts, so this copy\n` +
    `// accepts color overrides as props. decorated/${filename} (this file's un-relabeled source) is\n` +
    `// untouched and stays as a fallback. Do not hand-edit; regenerate with the script above if the\n` +
    `// source changes.\n\n`
  );
}

for (const filename of DATA_FILES) {
  const src = readFileSync(join(SRC_DIR, filename), 'utf8');

  let out = src;
  for (const [literal, replacement] of SUBSTITUTIONS) {
    out = out.split(literal).join(replacement);
  }

  // Only import constants this specific file actually ended up using (see ALL_CONSTANTS'
  // comment) - \b-bounded so INK_RED doesn't false-positive on INK_RED_ALT.
  const usedConstants = ALL_CONSTANTS.filter((name) => new RegExp(`\\b${name}\\b`).test(out));
  const colorImport = `import { ${usedConstants.join(', ')} } from './colors';\n`;

  const exportIdx = out.indexOf('\nexport const');
  if (exportIdx === -1) throw new Error(`${filename}: couldn't find "export const" to insert the color import before`);
  out = out.slice(0, exportIdx + 1) + colorImport + out.slice(exportIdx + 1);

  out = noteFor(filename) + out;
  writeFileSync(join(OUT_DIR, filename), out);
  console.log(`wrote decoratedCustom/${filename}`);
}

// index.ts is a pure barrel re-export (no color literals) - copy verbatim.
writeFileSync(join(OUT_DIR, 'index.ts'), readFileSync(join(SRC_DIR, 'index.ts'), 'utf8'));
console.log('wrote decoratedCustom/index.ts (verbatim)');
