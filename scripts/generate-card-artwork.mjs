#!/usr/bin/env node
// Regenerates src/components/cards/artwork/decorated/*.ts from the SVG-cards master sheet
// (https://github.com/htdebeer/SVG-cards, LGPL-2.1 - see src/components/cards/artwork/NOTICE.md
// and LICENSE for attribution). The sheet itself isn't vendored into this repo, so pass its path
// on the command line:
//
//   node scripts/generate-card-artwork.mjs <path-to-svg-cards.svg>
//
// The sheet lays every card out as a top-level <g id="<suit>_<rank>"> (e.g. "spade_king"), built
// from <use xlink:href="#..."> references into shared pieces (card border, suit pips, corner rank
// glyphs, court figures) that are themselves <g id="..."> elements scattered through the document.
// This script resolves every <use> into literal, flattened geometry and converts inline
// style="fill:...;stroke:..." into per-shape fields, so the generated output renders as plain
// react-native-svg elements - no <use>, no runtime XML/CSS parsing.
//
// Jokers aren't extracted (unused - Solitaire has no game mode that draws one). Card backs are a
// separate script - see generate-card-back.mjs and NOTICE.md.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svgson';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'src', 'components', 'cards', 'artwork', 'decorated');

// Sheet suit/rank naming -> the app's own Suit/Rank types (engine/types.ts).
const SUITS = [
  ['spade', 'spades'],
  ['heart', 'hearts'],
  ['diamond', 'diamonds'],
  ['club', 'clubs'],
];
const RANKS = [
  ...Array.from({ length: 10 }, (_, i) => [String(i + 1), i + 1]),
  ['jack', 11],
  ['queen', 12],
  ['king', 13],
];

const VIEW_BOX = [0, 0, 169.075, 244.64];

function collectIds(node, map) {
  if (node.attributes?.id) map.set(node.attributes.id, node);
  for (const child of node.children ?? []) collectIds(child, map);
}

function findGroupById(root, id) {
  if (root.name === 'g' && root.attributes?.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findGroupById(child, id);
    if (found) return found;
  }
  return null;
}

function parseStyle(styleAttr) {
  const out = {};
  if (!styleAttr) return out;
  for (const decl of styleAttr.split(';')) {
    const [rawKey, rawValue] = decl.split(':');
    const key = rawKey?.trim();
    const value = rawValue?.trim();
    if (!key || !value) continue;
    if (key === 'fill') out.fill = value;
    else if (key === 'stroke') out.stroke = value;
    else if (key === 'stroke-width') out.strokeWidth = Number(value);
  }
  return out;
}

function paint(attrs) {
  const style = parseStyle(attrs.style);
  const out = {};
  // SVG's initial/default fill is black when no fill is specified anywhere (not "no paint") -
  // react-native-svg's <Path> etc. have no such CSS-cascade default, so a shape like this (there
  // are several in this deck - typically face/head outlines) would render invisible instead of
  // black if left unset.
  out.fill = style.fill ?? attrs.fill ?? 'black';
  const stroke = style.stroke ?? attrs.stroke;
  const strokeWidth = style.strokeWidth ?? (attrs['stroke-width'] !== undefined ? Number(attrs['stroke-width']) : undefined);
  if (stroke !== undefined) out.stroke = stroke;
  if (strokeWidth !== undefined) out.strokeWidth = strokeWidth;
  if (attrs.transform) out.transform = attrs.transform;
  return out;
}

/** Resolve a <use> into a flattened <g>: wraps the target's converted content in translate(x,y)
 *  (the use's own coordinate shift) then the use's own transform, per SVG's use semantics. */
function resolveUse(attrs, idMap, seen) {
  const href = attrs['xlink:href'] ?? attrs.href;
  const refId = href?.replace(/^#/, '');
  if (!refId) throw new Error('<use> with no xlink:href');
  if (seen.has(refId)) throw new Error(`cyclic <use> reference: #${refId}`);
  const target = idMap.get(refId);
  if (!target) throw new Error(`unresolved <use> reference: #${refId}`);

  const nextSeen = new Set(seen).add(refId);
  const resolvedChildren =
    target.name === 'g'
      ? (target.children ?? []).map((c) => convert(c, idMap, nextSeen)).filter(Boolean)
      : [convert(target, idMap, nextSeen)].filter(Boolean);
  if (resolvedChildren.length === 0) return null;

  let node = { tag: 'g', children: resolvedChildren };

  const x = attrs.x !== undefined ? Number(attrs.x) : 0;
  const y = attrs.y !== undefined ? Number(attrs.y) : 0;
  if (x !== 0 || y !== 0) node = { tag: 'g', transform: `translate(${x},${y})`, children: [node] };

  if (attrs.transform) node = { tag: 'g', transform: attrs.transform, children: [node] };

  return node;
}

const NUMERIC_ATTRS = {
  circle: ['cx', 'cy', 'r'],
  rect: ['x', 'y', 'width', 'height'],
  line: ['x1', 'y1', 'x2', 'y2'],
};

function convert(node, idMap, seen) {
  const tag = node.name;
  const attrs = node.attributes ?? {};

  if (tag === 'defs') return null;
  if (tag === 'use') return resolveUse(attrs, idMap, seen);

  if (tag === 'g') {
    const children = (node.children ?? []).map((c) => convert(c, idMap, seen)).filter(Boolean);
    if (children.length === 0) return null;
    const p = paint(attrs);
    return { tag: 'g', ...(p.transform ? { transform: p.transform } : {}), children };
  }

  if (tag === 'path') return { tag: 'path', d: attrs.d, ...paint(attrs) };

  if (tag === 'circle' || tag === 'rect' || tag === 'line') {
    const out = { tag, ...paint(attrs) };
    for (const a of NUMERIC_ATTRS[tag]) out[a] = Number(attrs[a]);
    return out;
  }

  if (tag === 'polygon' || tag === 'polyline') {
    return { tag, points: attrs.points, ...paint(attrs) };
  }

  if (tag === 'text') {
    const textNode = (node.children ?? []).find((c) => c.type === 'text');
    const p = paint(attrs);
    return {
      tag: 'text',
      content: textNode?.value ?? '',
      ...(attrs.x !== undefined ? { x: Number(attrs.x) } : {}),
      ...(attrs.y !== undefined ? { y: Number(attrs.y) } : {}),
      ...(attrs['font-family'] ? { fontFamily: attrs['font-family'] } : {}),
      ...(attrs['font-weight'] ? { fontWeight: attrs['font-weight'] } : {}),
      ...(attrs['font-size'] ? { fontSize: Number(attrs['font-size']) } : {}),
      ...p,
    };
  }

  // Unsupported tag (none expected in the source sheet's card groups) - drop rather than guess.
  console.warn(`  (skipping unsupported <${tag}> element)`);
  return null;
}

function shapeToTs(shape, indent) {
  const pad = '  '.repeat(indent);
  const entries = Object.entries(shape)
    .filter(([k]) => k !== 'children')
    .map(([k, v]) => `${pad}  ${k}: ${JSON.stringify(v)},`)
    .join('\n');
  if (shape.tag === 'g') {
    const children = shape.children.map((c) => shapeToTs(c, indent + 1)).join(',\n');
    return `${pad}{\n${entries}\n${pad}  children: [\n${children}\n${pad}  ],\n${pad}}`;
  }
  return `${pad}{\n${entries}\n${pad}}`;
}

function artToTs(art) {
  const shapes = art.shapes.map((s) => shapeToTs(s, 2)).join(',\n');
  return `{\n    viewBox: ${JSON.stringify(art.viewBox)},\n    shapes: [\n${shapes}\n    ],\n  }`;
}

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error('Usage: node scripts/generate-card-artwork.mjs <path-to-svg-cards.svg>');
    process.exit(1);
  }

  console.log(`Parsing ${sourcePath}...`);
  const xml = readFileSync(sourcePath, 'utf-8');
  const root = await parse(xml);

  const idMap = new Map();
  collectIds(root, idMap);

  mkdirSync(OUT_DIR, { recursive: true });

  const indexEntries = [];

  for (const [sheetSuit, appSuit] of SUITS) {
    console.log(`Extracting ${appSuit}...`);
    const rankEntries = [];
    for (const [sheetRank, appRank] of RANKS) {
      const id = `${sheetSuit}_${sheetRank}`;
      const group = findGroupById(root, id);
      if (!group) throw new Error(`missing card group in sheet: ${id}`);

      const children = group.children ?? [];
      let shapes = children.map((c) => convert(c, idMap, new Set())).filter(Boolean);
      if (group.attributes?.transform) {
        shapes = [{ tag: 'g', transform: group.attributes.transform, children: shapes }];
      }

      const art = { viewBox: VIEW_BOX, shapes };

      rankEntries.push(`  ${appRank}: ${artToTs(art)},`);
    }

    const fileName = `${appSuit}.ts`;
    const content = `// AUTO-GENERATED by scripts/generate-card-artwork.mjs from SVG-cards
// (https://github.com/htdebeer/SVG-cards), LGPL-2.1 - see ../NOTICE.md and ../LICENSE.
// Do not hand-edit; regenerate with: node scripts/generate-card-artwork.mjs <svg-cards.svg>

import type { DecoratedArt } from '../types';
import type { Rank } from '@/engine/types';

export const ${appSuit}: Record<Rank, DecoratedArt> = {
${rankEntries.join('\n')}
};
`;
    writeFileSync(join(OUT_DIR, fileName), content);
    indexEntries.push(appSuit);
  }

  const indexContent = `// AUTO-GENERATED by scripts/generate-card-artwork.mjs - see NOTICE.md and LICENSE.
// Do not hand-edit; regenerate with: node scripts/generate-card-artwork.mjs <svg-cards.svg>

import type { DecoratedArt } from '../types';
import type { Rank, Suit } from '@/engine/types';
${indexEntries.map((s) => `import { ${s} } from './${s}';`).join('\n')}

export const decoratedDeck: Record<Suit, Record<Rank, DecoratedArt>> = {
${indexEntries.map((s) => `  ${s},`).join('\n')}
};
`;
  writeFileSync(join(OUT_DIR, 'index.ts'), indexContent);

  console.log(`Wrote ${indexEntries.length} suit files + index.ts to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
