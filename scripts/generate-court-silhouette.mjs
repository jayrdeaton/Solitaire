#!/usr/bin/env node
// Regenerates src/components/cards/artwork/court.ts from the SVG-cards master sheet
// (https://github.com/htdebeer/SVG-cards, LGPL-2.1 - see artwork/NOTICE.md and LICENSE). Run:
//
//   node scripts/generate-court-silhouette.mjs <path-to-svg-cards.svg>
//
// Unlike generate-card-artwork.mjs (the full-colour "decorated" deck), this produces the
// "compact" style's single-colour court silhouette: one shape per rank, shared across all four
// suits and tinted red/black by the caller (see CourtFigure.tsx), the same contract as the suit
// pips in pips.ts. COURT_SOURCE below picks a single suit's figure per rank, arbitrarily (the
// output is suit-agnostic), and every one of its paths is filled with one colour so the
// individually-coloured costume/body regions merge into a single outline.
//
// The source deck draws each figure's body ONLY ONCE (e.g. "king_1"), then places it on the card
// via two <use> references - one upright, one rotated 180 degrees for the card's other half - and
// relies on their overlap to read as one complete figure: some regions (confirmed by rendering,
// e.g. the collar/chest area right where the sash crosses) are only covered by one placement's
// paths, not both, so using just one <use> leaves real gaps, not merely a duplicated head. This
// script instead uses BOTH real <use> transforms from the sheet - the upright one for the whole
// figure, and the other one (which contributes the gap-filling overlap, but also carries its own
// second head/body further down the card) clipped to the upright copy's own bounding box, so only
// its contribution to the shared figure is kept.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svgson';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(__dirname, '..', 'src', 'components', 'cards', 'artwork', 'court.ts');

// rank -> { cardId: the <suit>_<rank> card whose two <use> placements we read transforms from,
//           bodyId: that card's body-art id (see generate-card-artwork.mjs's SUITS/RANKS for the
//           id scheme) }. Picked for cleanest source content - no polygon-only figures - not for
// any suit-consistency reason, since the output is suit-agnostic.
const COURT_SOURCE = {
  king: { cardId: 'spade_king', bodyId: 'king_1' },
  queen: { cardId: 'heart_queen', bodyId: 'queen_1' },
  jack: { cardId: 'club_jack', bodyId: 'jack_4' },
};

function findGroupById(root, id) {
  if (root.name === 'g' && root.attributes?.id === id) return root;
  for (const child of root.children ?? []) {
    const found = findGroupById(child, id);
    if (found) return found;
  }
  return null;
}

function findBodyUseTransforms(cardGroup, bodyId) {
  const matrices = [];
  function walk(node) {
    if (node.name === 'use' && node.attributes?.['xlink:href'] === `#${bodyId}`) {
      const m = node.attributes.transform?.match(/matrix\(([^,]+),0,0,([^,]+),([^,]+),([^)]+)\)/);
      if (!m) throw new Error(`<use> of #${bodyId} has no plain scale+translate matrix() transform`);
      matrices.push(m.slice(1).map(Number));
    }
    for (const child of node.children ?? []) walk(child);
  }
  walk(cardGroup);
  if (matrices.length !== 2) throw new Error(`expected exactly 2 <use> placements of #${bodyId}, found ${matrices.length}`);
  return matrices;
}

function collectDrawable(node, out) {
  if (node.name === 'path' || node.name === 'polyline') out.push(node);
  for (const child of node.children ?? []) collectDrawable(child, out);
}

function polylineToPathData(points) {
  const pairs = points
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number));
  return 'M' + pairs.map(([x, y]) => `${x},${y}`).join('L');
}

// Arity (numeric args per repetition) for every command this source data actually uses. S
// (smooth cubic) has an implicit first control point - the previous command's C/S second control
// point reflected about the current point, or the current point itself if there wasn't one - so
// it's rewritten below into a regular, explicit C rather than tracked as its own case throughout.
const ARITY = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, z: 0 };

/** Normalizes an M/L/H/V/C/S path (any mix of absolute/relative commands) into absolute M/L/C
 * commands with every coordinate passed through the given affine (a,0,0,d,e,f) - i.e.
 * (x,y) -> (a*x+e, d*y+f). Re-expressing H/V as L is necessary once a translate is involved: an
 * H's untouched y-coordinate is only "keep cy as-is" in the pre-transform space, not the post-
 * transform one. */
function transformPath(d, a, dd, e, f) {
  const tokens = d.match(/[MLHVCSZmlhvcsz]|-?[0-9]*\.?[0-9]+(?:[eE]-?[0-9]+)?/g) ?? [];
  let cx = 0,
    cy = 0,
    startX = 0,
    startY = 0,
    lastControl2 = null, // previous C/S command's second control point, in pre-transform space
    lastWasCurve = false,
    i = 0;
  let out = '';
  const point = (x, y) => `${(a * x + e).toFixed(3)},${(dd * y + f).toFixed(3)}`;
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
      // An SVG path command letter repeats implicitly while more of its own arg-groups follow.
    } while (i < tokens.length && !isNaN(Number(tokens[i])));
  }
  return out;
}

function boundingBox(paths) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const d of paths) {
    const nums = d.match(/-?[0-9.]+/g).map(Number);
    for (let i = 0; i < nums.length; i += 2) {
      x0 = Math.min(x0, nums[i]);
      x1 = Math.max(x1, nums[i]);
      y0 = Math.min(y0, nums[i + 1]);
      y1 = Math.max(y1, nums[i + 1]);
    }
  }
  return [x0, y0, x1, y1];
}

/** Keeps only the overlap copy's shapes that land ENTIRELY within the upright copy's own bounding
 * box - a coarse per-shape clip (not true geometric clipping against the upright figure's actual
 * silhouette), but enough here: the overlap only needs to contribute small gap-filling regions
 * (e.g. under the sash), while its own head/body are large shapes that inherently extend well
 * outside that box and get dropped whole rather than leaking a partially-clipped fragment in. */
function keepPathsWithinRect(paths, rect) {
  const [rx0, ry0, rx1, ry1] = rect;
  return paths.filter((d) => {
    const nums = d.match(/-?[0-9.]+/g).map(Number);
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
    return x0 >= rx0 && x1 <= rx1 && y0 >= ry0 && y1 <= ry1;
  });
}

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error('Usage: node scripts/generate-court-silhouette.mjs <path-to-svg-cards.svg>');
    process.exit(1);
  }

  const xml = readFileSync(sourcePath, 'utf-8');
  const root = await parse(xml);

  const entries = [];
  for (const [rank, { cardId, bodyId }] of Object.entries(COURT_SOURCE)) {
    const cardGroup = findGroupById(root, cardId);
    if (!cardGroup) throw new Error(`missing card group: ${cardId}`);
    const bodyGroup = findGroupById(root, bodyId);
    if (!bodyGroup) throw new Error(`missing body group: ${bodyId}`);

    const [m1, m2] = findBodyUseTransforms(cardGroup, bodyId);
    // The upright placement is always the one with a negative scale (confirmed by rendering,
    // king/queen/jack alike) - the source body art is authored in the orientation the OTHER
    // placement (positive scale, no flip) uses as-is, i.e. upside-down relative to how the card
    // actually displays it.
    const [upright, overlap] = m1[0] < 0 ? [m1, m2] : [m2, m1];

    const drawable = [];
    collectDrawable(bodyGroup, drawable);
    const rawPaths = drawable.map((n) => (n.name === 'polyline' ? polylineToPathData(n.attributes.points) : n.attributes.d));

    const uprightPaths = rawPaths.map((d) => transformPath(d, ...upright));
    const uprightBbox = boundingBox(uprightPaths);

    const overlapPaths = keepPathsWithinRect(
      rawPaths.map((d) => transformPath(d, ...overlap)),
      uprightBbox
    );

    const paths = [...uprightPaths, ...overlapPaths];
    const PAD = 10;
    const [x0, y0, x1, y1] = uprightBbox;
    const viewBox = [x0 - PAD, y0 - PAD, x1 - x0 + 2 * PAD, y1 - y0 + 2 * PAD];

    entries.push(`  ${rank}: {\n    viewBox: [${viewBox.join(', ')}],\n    paths: [\n${paths.map((d) => `      '${d}',`).join('\n')}\n    ],\n  },`);
    console.log(`${rank} (${cardId} / ${bodyId}): ${uprightPaths.length} + ${overlapPaths.length} overlap shapes`);
  }

  const content = `import type { OutlineArt } from './types';

export type CourtRank = 'jack' | 'queen' | 'king';

// AUTO-GENERATED by scripts/generate-court-silhouette.mjs from SVG-cards
// (https://github.com/htdebeer/SVG-cards), LGPL-2.1 - see NOTICE.md and LICENSE for attribution.
// Do not hand-edit; regenerate with: node scripts/generate-court-silhouette.mjs <svg-cards.svg>
export const courtArt: Record<CourtRank, OutlineArt> = {
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
