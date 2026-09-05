#!/usr/bin/env node
// Regenerates src/components/cards/artwork/decorated/courtFigures.ts from the SVG-cards master
// sheet (https://github.com/htdebeer/SVG-cards, LGPL-2.1 - see artwork/NOTICE.md and LICENSE).
// Run:
//
//   node scripts/generate-court-figures.mjs <path-to-svg-cards.svg>
//
// This is the full-colour counterpart to generate-court-silhouette.mjs: instead of flattening
// each rank's figure to one suit and one fill colour (for the "compact" style's tinted
// silhouette), it keeps every suit's own figure and every shape's own original colour, cropped to
// just the figure - no card border, corner index, or decorative flourish - so it can drop into
// the compact layout's existing corner-index-row + content-area in place of CourtFigure, for a
// "compact card, full-colour court figure" hybrid.
//
// The crop is capped at CARD_HALF_HEIGHT (see below, in main()) rather than the figure's full
// content extent - a close portrait crop, not a full standing figure. That reopens a real gap: the
// single upright body placement alone doesn't cover everything within even this shorter box (the
// deck's double-ended design relies on the two placements' overlap to read as complete), and
// beyond it, near the bottom corner, is a real hole with nothing drawn there at all.
//
// Two things fill that hole, both added back on top of the upright placement, unfiltered, and
// clipped to the crop rect: the sash (a thick diagonal <line> plus ~50 small pearl <circle>s,
// drawn once directly as a sibling of the body's two <use> placements - not part of the body, not
// shared via <use> - identified structurally, same rotation/scale on all 12 cards, only translate
// differs), and the body's OTHER (mirrored) placement in full.
//
// Including the mirrored placement in full, rather than pre-filtering it down to "shapes that are
// mostly within the crop rect", was a real back-and-forth: at the *full*-height crop (an earlier
// version of this script), no filter reliably separated the mirrored placement's own separate
// head/body from legitimate content - some fraction of it always escaped as a stray fragment on
// some figure. Against a full-size mirrored placement, an area-based filter (tried at both >50%
// and >30% of a shape's own bounding-box area) seemed like the fix for that at this shorter crop
// too, but empirically it just traded the problem: some real gap-filling shapes fell just under
// the threshold and got dropped, leaving three of twelve figures with the exact hole this is meant
// to close (confirmed by rendering and inspecting all 12 after each attempt). No filter at all -
// just the clip rect - closed it cleanly on all twelve, confirmed by the same process, without
// reopening the original stray-fragment problem: at this crop size, there's no room for the
// mirrored placement's own head/body to land mostly outside the rect while still poking a visible,
// disconnected-looking sliver in - it's either clipped away entirely or reads as part of the
// figure.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svgson';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '..', 'src', 'components', 'cards', 'artwork', 'decorated', 'courtFigures.ts');

const SUITS = [
  ['spade', 'spades'],
  ['heart', 'hearts'],
  ['diamond', 'diamonds'],
  ['club', 'clubs'],
];
const RANKS = ['king', 'queen', 'jack'];
// [sheetRank][sheetSuit] -> which numbered body-art variant that suit's card uses. NOT the same
// order per rank (confirmed by inspecting the sheet) - king's spade/heart/club/diamond order is
// 1/2/3/4, but queen's is heart/spade/club/diamond and jack's is diamond/heart/spade/club.
const BODY_VARIANT = {
  king: { spade: 1, heart: 2, club: 3, diamond: 4 },
  queen: { heart: 1, spade: 2, club: 3, diamond: 4 },
  jack: { diamond: 1, heart: 2, spade: 3, club: 4 },
};

function findGroupById(root, id) {
  if (root.name === 'g' && root.attributes?.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findGroupById(child, id);
    if (found) return found;
  }
  return null;
}

/** Parses a matrix()/translate() transform attribute into a full [a,b,c,d,e,f] affine - i.e.
 * (x,y) -> (a*x+c*y+e, b*x+d*y+f). Every transform in this sheet is one of these two forms. */
function parseTransform(transformAttr) {
  const asMatrix = transformAttr?.match(/matrix\(([^,]+),([^,]+),([^,]+),([^,]+),([^,]+),([^)]+)\)/);
  if (asMatrix) return asMatrix.slice(1).map(Number);
  const asTranslate = transformAttr?.match(/translate\(([^,]+),([^)]+)\)/);
  if (asTranslate) {
    const [x, y] = asTranslate.slice(1).map(Number);
    return [1, 0, 0, 1, x, y];
  }
  throw new Error(`unsupported transform: ${transformAttr}`);
}

function findBodyUseTransforms(cardGroup, bodyId) {
  const matrices = [];
  function walk(node) {
    if (node.name === 'use' && node.attributes?.['xlink:href'] === `#${bodyId}`) {
      matrices.push(parseTransform(node.attributes.transform));
    }
    for (const child of node.children ?? []) walk(child);
  }
  walk(cardGroup);
  if (matrices.length !== 2) throw new Error(`expected exactly 2 <use> placements of #${bodyId}, found ${matrices.length}`);
  return matrices;
}

/** Finds the card's sash group - see file header - identified structurally (a direct child <g>
 * whose first child is a <line>) rather than by its transform, which is incidental. */
function findSashGroup(cardGroup) {
  const candidates = (cardGroup.children ?? []).filter((c) => c.name === 'g' && c.children?.[0]?.name === 'line');
  if (candidates.length !== 1) throw new Error(`expected exactly 1 sash group, found ${candidates.length}`);
  const unexpected = candidates[0].children.filter((c) => c.name !== 'line' && c.name !== 'circle');
  if (unexpected.length > 0) throw new Error(`sash group has unexpected child element(s): ${unexpected.map((c) => c.name).join(', ')}`);
  return { transform: parseTransform(candidates[0].attributes.transform), children: candidates[0].children };
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
  // react-native-svg's <Path> has no such CSS-cascade default, so this has to be explicit or a
  // path like this (there are several among these figures - typically the face/head outline)
  // renders invisible instead of black.
  out.fill = style.fill ?? attrs.fill ?? 'black';
  const stroke = style.stroke ?? attrs.stroke;
  const strokeWidth = style.strokeWidth ?? (attrs['stroke-width'] !== undefined ? Number(attrs['stroke-width']) : undefined);
  if (stroke !== undefined) out.stroke = stroke;
  if (strokeWidth !== undefined) out.strokeWidth = strokeWidth;
  return out;
}

// Arity (numeric args per repetition) for every path command used across all 12 figures.
const ARITY = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, z: 0 };

/** Normalizes an M/L/H/V/C/S path into absolute M/L/C commands with every coordinate passed
 * through the given affine [a,b,c,d,e,f] - i.e. (x,y) -> (a*x+c*y+e, b*x+d*y+f). See
 * generate-court-silhouette.mjs for why H/V/S need this rather than a naive number-for-number
 * replace once a translate and/or reflected control point is involved. */
function transformPathData(d, [a, b, c, dd, e, f]) {
  const tokens = d.match(/[MLHVCSZmlhvcsz]|-?[0-9]*\.?[0-9]+(?:[eE]-?[0-9]+)?/g) ?? [];
  let cx = 0,
    cy = 0,
    startX = 0,
    startY = 0,
    lastControl2 = null,
    lastWasCurve = false,
    i = 0;
  let out = '';
  const point = (x, y) => `${(a * x + c * y + e).toFixed(3)},${(b * x + dd * y + f).toFixed(3)}`;
  const emitCubic = (c1x, c1y, c2x, c2y, ex, ey) => {
    out += 'C' + [point(c1x, c1y), point(c2x, c2y), point(ex, ey)].join(' ');
    lastControl2 = [c2x, c2y];
    cx = ex;
    cy = ey;
  };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    const letter = cmd.toLowerCase();
    const arity = ARITY[letter];
    if (arity === undefined) throw new Error(`unsupported path command: ${cmd}`);
    if (arity === 0) {
      out += 'Z';
      cx = startX;
      cy = startY;
      lastWasCurve = false;
      continue;
    }
    const relative = cmd === letter;
    do {
      const args = tokens.slice(i, i + arity).map(Number);
      i += arity;
      if (letter === 'h') {
        cx = relative ? cx + args[0] : args[0];
        out += 'L' + point(cx, cy);
        lastWasCurve = false;
      } else if (letter === 'v') {
        cy = relative ? cy + args[0] : args[0];
        out += 'L' + point(cx, cy);
        lastWasCurve = false;
      } else if (letter === 'c') {
        const c1x = relative ? cx + args[0] : args[0];
        const c1y = relative ? cy + args[1] : args[1];
        const c2x = relative ? cx + args[2] : args[2];
        const c2y = relative ? cy + args[3] : args[3];
        const ex = relative ? cx + args[4] : args[4];
        const ey = relative ? cy + args[5] : args[5];
        emitCubic(c1x, c1y, c2x, c2y, ex, ey);
        lastWasCurve = true;
      } else if (letter === 's') {
        const c1x = lastWasCurve ? 2 * cx - lastControl2[0] : cx;
        const c1y = lastWasCurve ? 2 * cy - lastControl2[1] : cy;
        const c2x = relative ? cx + args[0] : args[0];
        const c2y = relative ? cy + args[1] : args[1];
        const ex = relative ? cx + args[2] : args[2];
        const ey = relative ? cy + args[3] : args[3];
        emitCubic(c1x, c1y, c2x, c2y, ex, ey);
        lastWasCurve = true;
      } else {
        cx = relative ? cx + args[0] : args[0];
        cy = relative ? cy + args[1] : args[1];
        out += (letter === 'm' ? 'M' : 'L') + point(cx, cy);
        if (letter === 'm') {
          startX = cx;
          startY = cy;
        }
        lastWasCurve = false;
      }
    } while (i < tokens.length && !isNaN(Number(tokens[i])));
  }
  return out;
}

function transformPoints(pointsAttr, [a, b, c, d, e, f]) {
  return pointsAttr
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return `${(a * x + c * y + e).toFixed(3)},${(b * x + d * y + f).toFixed(3)}`;
    })
    .join(' ');
}

/** Converts one raw drawable element (path/polyline/polygon/rect/circle/line) into a transformed
 * DecoratedShape. `rect` assumes an axis-aligned (no rotation/skew) matrix - true for every rect
 * in this deck (only inside body groups, which are never rotated) - since a real rotation would
 * turn it into a parallelogram this shape can't represent; it throws rather than silently
 * producing a wrong axis-aligned box if that ever stops being true. */
function convertShape(node, matrix) {
  const [a, b, c, d, e, f] = matrix;
  const attrs = node.attributes ?? {};
  const p = paint(attrs);
  if (node.name === 'path') return { tag: 'path', d: transformPathData(attrs.d, matrix), ...p };
  if (node.name === 'polyline') return { tag: 'polyline', points: transformPoints(attrs.points, matrix), ...p };
  if (node.name === 'polygon') return { tag: 'polygon', points: transformPoints(attrs.points, matrix), ...p };
  if (node.name === 'circle') {
    const [cx, cy] = [a * Number(attrs.cx) + c * Number(attrs.cy) + e, b * Number(attrs.cx) + d * Number(attrs.cy) + f];
    const scale = Math.sqrt(a * a + b * b);
    return { tag: 'circle', cx, cy, r: Number(attrs.r) * scale, ...p };
  }
  if (node.name === 'line') {
    const [x1, y1] = [a * Number(attrs.x1) + c * Number(attrs.y1) + e, b * Number(attrs.x1) + d * Number(attrs.y1) + f];
    const [x2, y2] = [a * Number(attrs.x2) + c * Number(attrs.y2) + e, b * Number(attrs.x2) + d * Number(attrs.y2) + f];
    return { tag: 'line', x1, y1, x2, y2, ...p };
  }
  if (node.name === 'rect') {
    // A handful of this sheet's placements carry a ~1e-3 radian rotation - float noise, not an
    // intentional tilt (same as generate-court-silhouette.mjs's ROTATION_EPSILON). Negligible for
    // a path/circle/line, which handle real rotation exactly regardless - only rect needs an
    // explicit tolerance, since it fundamentally can't represent a rotated rectangle.
    const ROTATION_EPSILON = 0.01;
    if (Math.abs(b) > ROTATION_EPSILON || Math.abs(c) > ROTATION_EPSILON) {
      throw new Error('convertShape: <rect> under a non-negligible rotated/skewed matrix is not representable');
    }
    const x0 = Number(attrs.x),
      y0 = Number(attrs.y);
    const x1 = x0 + Number(attrs.width),
      y1 = y0 + Number(attrs.height);
    const tx0 = a * x0 + e,
      tx1 = a * x1 + e;
    const ty0 = d * y0 + f,
      ty1 = d * y1 + f;
    return {
      tag: 'rect',
      x: Math.min(tx0, tx1),
      y: Math.min(ty0, ty1),
      width: Math.abs(tx1 - tx0),
      height: Math.abs(ty1 - ty0),
      ...p,
    };
  }
  throw new Error(`unsupported shape element: <${node.name}>`);
}

function shapeBoundingBox(shape) {
  let nums;
  if (shape.tag === 'rect') nums = [shape.x, shape.y, shape.x + shape.width, shape.y + shape.height];
  else if (shape.tag === 'circle') nums = [shape.cx - shape.r, shape.cy - shape.r, shape.cx + shape.r, shape.cy + shape.r];
  else if (shape.tag === 'line') nums = [shape.x1, shape.y1, shape.x2, shape.y2];
  else nums = (shape.d ?? shape.points).match(/-?[0-9.]+/g).map(Number);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < nums.length; i += 2) {
    x0 = Math.min(x0, nums[i]);
    x1 = Math.max(x1, nums[i]);
    y0 = Math.min(y0, nums[i + 1]);
    y1 = Math.max(y1, nums[i + 1]);
  }
  return [x0, y0, x1, y1];
}

function unionBoundingBox(shapes) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const shape of shapes) {
    const [a, b, c, d] = shapeBoundingBox(shape);
    x0 = Math.min(x0, a);
    y0 = Math.min(y0, b);
    x1 = Math.max(x1, c);
    y1 = Math.max(y1, d);
  }
  return [x0, y0, x1, y1];
}

function collectDrawable(node, out) {
  if (['path', 'polyline', 'polygon', 'rect'].includes(node.name)) out.push(node);
  for (const child of node.children ?? []) collectDrawable(child, out);
}

function shapeToTs(shape, indent) {
  const pad = '  '.repeat(indent);
  const entries = Object.entries(shape)
    .map(([k, v]) => `${pad}  ${k}: ${JSON.stringify(v)},`)
    .join('\n');
  return `${pad}{\n${entries}\n${pad}}`;
}

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error('Usage: node scripts/generate-court-figures.mjs <path-to-svg-cards.svg>');
    process.exit(1);
  }

  const xml = readFileSync(sourcePath, 'utf-8');
  const root = await parse(xml);

  const suitEntries = [];
  for (const [sheetSuit, appSuit] of SUITS) {
    const rankEntries = [];
    for (const sheetRank of RANKS) {
      const cardId = `${sheetSuit}_${sheetRank}`;
      const bodyId = `${sheetRank}_${BODY_VARIANT[sheetRank][sheetSuit]}`;

      const cardGroup = findGroupById(root, cardId);
      if (!cardGroup) throw new Error(`missing card group: ${cardId}`);
      const bodyGroup = findGroupById(root, bodyId);
      if (!bodyGroup) throw new Error(`missing body group: ${bodyId}`);

      const [m1, m2] = findBodyUseTransforms(cardGroup, bodyId);
      const [upright, overlap] = m1[0] < 0 ? [m1, m2] : [m2, m1];
      const sash = findSashGroup(cardGroup);

      const drawable = [];
      collectDrawable(bodyGroup, drawable);

      const uprightShapes = drawable.map((n) => convertShape(n, upright));
      const uprightBbox = unionBoundingBox(uprightShapes);
      const overlapShapes = drawable.map((n) => convertShape(n, overlap));
      const sashShapes = sash.children.map((n) => convertShape(n, sash.transform));

      // No padding - the crop should fill its rendering box edge to edge, the way it does on a
      // real double-ended card. Height is capped at CARD_HALF_HEIGHT rather than the figure's own
      // full content extent (which reaches roughly down to the hem/knees - about 183-190 units for
      // a typical figure) - "half the card" is what a court card's own upright placement actually
      // occupies before the mirrored second half begins, i.e. a close portrait crop (crown down to
      // roughly the sash/waist), not a full standing figure. Derived from the sheet's own "base"
      // card-border shape (236.52 - 1.25 = 235.27 local units for one full card - see
      // generate-card-artwork.mjs's net-offset math) halved; empirically matches a manually-cropped
      // reference card face (a real single-placement crop, ~116 units tall) almost exactly.
      //
      // Cropping this short reopens the gap that using the overlap copy was originally meant to
      // fix (see NOTICE below) - the sash reaches nearly this whole height, and beyond it there's a
      // real triangular region content is expected but the single upright copy alone doesn't reach
      // (confirmed: its own content extends well past this crop line if given the room - the crop
      // just cuts if off first). Unlike the full-height crop, where the overlap copy's own head/
      // body reliably escaped every per-shape filter tried (see file header), a region this small
      // leaves it nowhere to hide: at most a sliver of it can even be >50% inside such a tight
      // rect, so the same filter that failed there works here.
      const CARD_HALF_HEIGHT = 235.27 / 2;
      const [x0, y0, x1] = uprightBbox;
      const viewBox = [x0, y0, x1 - x0, CARD_HALF_HEIGHT];
      const clipRect = [x0, y0, x1 - x0, CARD_HALF_HEIGHT];

      const clipGroup = { tag: 'g', clipRect, children: [...overlapShapes, ...sashShapes] };
      const shapes = [...uprightShapes, clipGroup];

      rankEntries.push(
        `  ${sheetRank}: {\n    viewBox: [${viewBox.join(', ')}],\n    shapes: [\n${shapes.map((s) => shapeToTs(s, 3)).join(',\n')}\n    ],\n  },`
      );
      console.log(
        `${appSuit} ${sheetRank} (${cardId} / ${bodyId}): ${uprightShapes.length} upright + ${overlapShapes.length} overlap + ${sashShapes.length} sash (clipped)`
      );
    }
    suitEntries.push(`  ${appSuit}: {\n${rankEntries.join('\n')}\n  },`);
  }

  const content = `// AUTO-GENERATED by scripts/generate-court-figures.mjs from SVG-cards
// (https://github.com/htdebeer/SVG-cards), LGPL-2.1 - see ../NOTICE.md and ../LICENSE.
// Do not hand-edit; regenerate with: node scripts/generate-court-figures.mjs <svg-cards.svg>
//
// Full-colour court figures, cropped to just the figure (no card border/corner index/flourish) -
// for the "compact" card style's court cards, unlike decorated/{suit}.ts which is the whole card.

import type { DecoratedArt } from '../types';
import type { Suit } from '@/engine/types';
import type { CourtRank } from '../court';

export const courtFigures: Record<Suit, Record<CourtRank, DecoratedArt>> = {
${suitEntries.join('\n')}
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
