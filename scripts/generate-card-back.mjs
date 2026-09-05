#!/usr/bin/env node
// Regenerates src/components/cards/artwork/backs.ts from the SVG-cards master sheet
// (https://github.com/htdebeer/SVG-cards, LGPL-2.1 - see src/components/cards/artwork/NOTICE.md
// and LICENSE for attribution). Run:
//
//   node scripts/generate-card-back.mjs <path-to-svg-cards.svg>
//
// Extracts the sheet's #back ("ornate") and #alternate-back ("plain") card-back designs. Both
// compose the shared #base card-frame (kept literal white fill/black stroke - the same treatment
// generate-card-artwork.mjs already gives every face card, so a decorated back's outer edge
// matches a decorated face's) around a recolorable body: shapes styled fill:inherit in the sheet
// become the 'BACK_BASE' sentinel, and its literal-white fill/stroke accents (the dot lattice,
// scrollwork border, medallion) become 'BACK_ACCENT' - see DecoratedCardBack.tsx's
// resolveBackColors, which substitutes both sentinels with the active profile's actual
// cardBack/cardBackPattern at render time, not baked in here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svgson';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '..', 'src', 'components', 'cards', 'artwork', 'backs.ts');
const VIEW_BOX = [0, 0, 169.075, 244.64];

// sheet id -> this app's own style name.
const BACKS = [
  ['back', 'ornate'],
  ['alternate-back', 'plain'],
];

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
    // parseFloat, not Number: the sheet has at least one stroke-width written with a unit suffix
    // ("0.25pt") that Number() can't parse at all (-> NaN) but parseFloat reads the leading number
    // from correctly. Harmless on the plain-number case (parseFloat("1.5") === 1.5 too).
    else if (key === 'stroke-width') out.strokeWidth = parseFloat(value);
  }
  return out;
}

// fill:inherit -> BACK_BASE (the caller's cardBack); any white fill/stroke -> BACK_ACCENT
// (cardBackPattern); 'none' omits the property entirely, same convention
// generate-card-artwork.mjs uses.
function resolveSentinel(value) {
  if (value === undefined || value === 'none') return undefined;
  if (value === 'inherit') return 'BACK_BASE';
  if (value.toLowerCase() === '#ffffff' || value.toLowerCase() === 'white') return 'BACK_ACCENT';
  return value;
}

function paintRecolorable(attrs) {
  const style = parseStyle(attrs.style);
  const out = {};
  const fill = resolveSentinel(style.fill ?? attrs.fill);
  if (fill !== undefined) out.fill = fill;
  const stroke = resolveSentinel(style.stroke ?? attrs.stroke);
  if (stroke !== undefined) out.stroke = stroke;
  // Only meaningful (and only ever reliably parseable - see parseStyle's own note) alongside an
  // actual stroke; several shapes carry a stroke-width even where their own stroke is 'none'.
  if (stroke !== undefined) {
    const strokeWidth = style.strokeWidth ?? (attrs['stroke-width'] !== undefined ? parseFloat(attrs['stroke-width']) : undefined);
    if (strokeWidth !== undefined) out.strokeWidth = strokeWidth;
  }
  if (attrs.transform) out.transform = attrs.transform;
  return out;
}

// #base's own treatment: literal colours, unchanged - see generate-card-artwork.mjs's identical
// `paint()`, which every face card's own #base already goes through.
function paintLiteral(attrs) {
  const style = parseStyle(attrs.style);
  const out = {};
  out.fill = style.fill ?? attrs.fill ?? 'black';
  const stroke = style.stroke ?? attrs.stroke;
  if (stroke !== undefined) {
    out.stroke = stroke;
    const strokeWidth = style.strokeWidth ?? (attrs['stroke-width'] !== undefined ? parseFloat(attrs['stroke-width']) : undefined);
    if (strokeWidth !== undefined) out.strokeWidth = strokeWidth;
  }
  if (attrs.transform) out.transform = attrs.transform;
  return out;
}

/** Resolve a <use> into a flattened <g> - same semantics as generate-card-artwork.mjs's identical
 *  helper, plus one addition: a <use> of #base always renders through paintLiteral regardless of
 *  which paint mode the referencing context is using, since the card frame itself is never part
 *  of the recolorable body. */
function resolveUse(attrs, idMap, seen, paint) {
  const href = attrs['xlink:href'] ?? attrs.href;
  const refId = href?.replace(/^#/, '');
  if (!refId) throw new Error('<use> with no xlink:href');
  if (seen.has(refId)) throw new Error(`cyclic <use> reference: #${refId}`);
  const target = idMap.get(refId);
  if (!target) throw new Error(`unresolved <use> reference: #${refId}`);

  const nextSeen = new Set(seen).add(refId);
  const childPaint = refId === 'base' ? paintLiteral : paint;

  let node;
  if (target.name === 'g') {
    const resolvedChildren = (target.children ?? []).map((c) => convert(c, idMap, nextSeen, childPaint)).filter(Boolean);
    if (resolvedChildren.length === 0) return null;
    // The target <g>'s own paint/transform (e.g. #twist's style="stroke:#ffffff;...") has to carry
    // through too - convert() already captures this for a <g> it meets directly in the tree, but
    // resolving a <use> of a <g> recurses straight into its children, bypassing that path entirely
    // (silently dropping any group-level style the target itself carries) unless applied here.
    node = { tag: 'g', ...childPaint(target.attributes ?? {}), children: resolvedChildren };
  } else {
    const resolvedChildren = [convert(target, idMap, nextSeen, childPaint)].filter(Boolean);
    if (resolvedChildren.length === 0) return null;
    node = { tag: 'g', children: resolvedChildren };
  }

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

function convert(node, idMap, seen, paint) {
  const tag = node.name;
  const attrs = node.attributes ?? {};

  if (tag === 'defs') return null;
  if (tag === 'use') return resolveUse(attrs, idMap, seen, paint);

  if (tag === 'g') {
    const children = (node.children ?? []).map((c) => convert(c, idMap, seen, paint)).filter(Boolean);
    if (children.length === 0) return null;
    // Full paint(), not just transform: a group-level fill (e.g. #lys, a corner flourish styled
    // once on its wrapping <g> rather than repeated on every child path) has to carry through to
    // DecoratedShapeRenderer's own <G fill=.../> or its unfilled children fall back to SVG's
    // default fill (black) instead of inheriting it.
    return { tag: 'g', ...paint(attrs), children };
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

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error('Usage: node scripts/generate-card-back.mjs <path-to-svg-cards.svg>');
    process.exit(1);
  }

  const xml = readFileSync(sourcePath, 'utf-8');
  const root = await parse(xml);

  const idMap = new Map();
  collectIds(root, idMap);

  const entries = [];
  for (const [sheetId, appName] of BACKS) {
    const group = findGroupById(root, sheetId);
    if (!group) throw new Error(`missing back group: ${sheetId}`);

    const children = group.children ?? [];
    const isBaseUse = (c) => c.name === 'use' && (c.attributes?.['xlink:href'] ?? c.attributes?.href) === '#base';
    const baseNode = children.find(isBaseUse);
    if (!baseNode) throw new Error(`#${sheetId} has no direct <use href="#base"> child`);

    // Split #base out from the rest (the recolourable design) rather than converting group.children
    // as one flat list - DecoratedCardBack.tsx insets *only* the body within a margin, and #base
    // already carries its own inset from the sheet's true edge, so folding both into the same list
    // would leave the body inset twice (once by its own margin, once again inside #base's).
    let baseShape = convert(baseNode, idMap, new Set(), paintRecolorable);
    let bodyShapes = children.filter((c) => c !== baseNode).map((c) => convert(c, idMap, new Set(), paintRecolorable)).filter(Boolean);

    // The sheet positions #back/#alternate-back in its own global coordinate space (translated far
    // from 0,0, same as every card group) - re-apply that group's own transform to both pieces, same
    // as generate-card-artwork.mjs does for every face card, or they land hundreds of units outside
    // VIEW_BOX and nothing renders.
    if (group.attributes?.transform) {
      baseShape = { tag: 'g', transform: group.attributes.transform, children: [baseShape] };
      bodyShapes = [{ tag: 'g', transform: group.attributes.transform, children: bodyShapes }];
    }
    const bodyShape = bodyShapes.length === 1 ? bodyShapes[0] : { tag: 'g', children: bodyShapes };

    entries.push(`  ${appName}: {\n    viewBox: ${JSON.stringify(VIEW_BOX)},\n    base: ${shapeToTs(baseShape, 2).trim()},\n    body: ${shapeToTs(bodyShape, 2).trim()},\n  },`);
    console.log(`${appName} (#${sheetId}): base + body extracted`);
  }

  const content = `import type { BackArt } from './types';

// AUTO-GENERATED by scripts/generate-card-back.mjs from SVG-cards
// (https://github.com/htdebeer/SVG-cards), LGPL-2.1 - see NOTICE.md and LICENSE for attribution.
// Do not hand-edit; regenerate with: node scripts/generate-card-back.mjs <svg-cards.svg>
//
// Fill/stroke values 'BACK_BASE'/'BACK_ACCENT' are sentinels, not real colours - see
// DecoratedCardBack.tsx's resolveBackColors, which substitutes both with the active profile's
// actual cardBack/cardBackPattern at render time. \`base\` is the one exception, kept as its own
// literal white/black (same treatment every decorated face card's own #base already gets from
// generate-card-artwork.mjs) and rendered at natural size rather than \`body\`'s own inset margin -
// see BackArt's own doc in ./types.
export type BackStyleName = 'ornate' | 'plain';
export const cardBacks: Record<BackStyleName, BackArt> = {
${entries.join('\n')}
};
`;

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, content);
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
