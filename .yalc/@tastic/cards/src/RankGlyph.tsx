import React from 'react'
import { Platform } from 'react-native'
import Svg, { Path } from 'react-native-svg'

import { RANK_FONT_SIZE_FRACTION, RANK_GLYPH_UNITS_PER_EM, RANK_GLYPHS, RankGlyphLabel } from './rankGlyphs'

// Width of the box every corner rank is centred in, as a fraction of card width. Fixed (rather
// than each rank sizing to its own ink) so the suit pip beside it sits at the same x whether the
// rank is one glyph or '10'.
export const RANK_BOX_FRACTION = 0.46
// The Svg is this much wider than the box on each side. The '10' run is a hair wider than the box
// (advance 0.475W against 0.46W, and its ink plus stroke reaches past that), and a native Svg
// clips to its own bounds on some platforms - so the Svg has to be big enough to hold all the ink.
// It only enlarges the Svg (transparent); where each rank centres is still decided by the box.
const RANK_SVG_PAD_FRACTION = 0.03
/** The rank Svg's width, as a fraction of card width. */
export const RANK_SVG_WIDTH_FRACTION = RANK_BOX_FRACTION + 2 * RANK_SVG_PAD_FRACTION
// Faux-bold: DejaVu Serif Bold, stroked in the ink colour, as a fraction of the font size (em).
// React Native's Text can't stroke, which is why the rank is drawn from glyph outlines at all.
export const RANK_STROKE_EM = 0.035
// Where the '10''s ink (stroke included) starts, as a fraction of card width from the card's own
// left edge - at EVERY card width. The frame border is 0.02W, so this leaves a clear margin of
// about 0.04W; a fixed-point offset (the old `left: -2`) shrank to nothing on small cards and let
// the '1's flag poke into the border. Everything else is derived from it (RANK_BOX_LEFT_FRACTION).
export const RANK_TEN_INK_LEFT_FRACTION = 0.062

const UNITS = RANK_GLYPH_UNITS_PER_EM
// Card widths per font unit: the whole corner rank is laid out in font units and scaled here, so
// every measure below is a pure fraction of card width.
const SCALE = RANK_FONT_SIZE_FRACTION / UNITS
const BOX_UNITS = RANK_BOX_FRACTION / SCALE
const PAD_UNITS = RANK_SVG_PAD_FRACTION / SCALE
const STROKE_UNITS = RANK_STROKE_EM * UNITS
const HALF_STROKE = STROKE_UNITS / 2

// A rank's glyph origin, in font units from the left of its box: the run (advance width, trailing
// letter spacing included, same as Text lays it out) centred in the box.
const originX = (label: RankGlyphLabel) => (BOX_UNITS - RANK_GLYPHS[label].advance) / 2
// The viewBox's left edge, in font units: the Svg starts one pad left of the box, so the run's origin
// (originX) sits that far in. It doesn't depend on the card width, which is what keeps every rank's ink
// at the same fraction of card width across sizes.
const viewBoxX = (label: RankGlyphLabel) => -originX(label) - PAD_UNITS

/** Left edge of the rank box, as a fraction of card width from the card's own left edge. Solved so
 * the '10' (the widest rank, whose '1' has the most left side-bearing) lands its ink at
 * RANK_TEN_INK_LEFT_FRACTION; every other rank is centred in the same box. */
export const RANK_BOX_LEFT_FRACTION = RANK_TEN_INK_LEFT_FRACTION - (originX('10') + RANK_GLYPHS['10'].x1 - HALF_STROKE) * SCALE

/** Left edge of the rank Svg, as a fraction of card width from the card's own left edge. */
export const RANK_SVG_LEFT_FRACTION = RANK_BOX_LEFT_FRACTION - RANK_SVG_PAD_FRACTION

/** The widest corner rank's ink ('10', stroke included) reaches this far from the card's own left
 * edge, as a fraction of card width. A layout that shows only the left strip of a covered card -
 * a horizontal fan such as the draw-3 waste - has to show at least this much of it, or the '10''s
 * '0' is clipped. Derived from the glyph table and the same layout constants the component draws
 * with, so it can't drift from what's on screen. */
export const RANK_INK_RIGHT_FRACTION = Math.max(...(Object.keys(RANK_GLYPHS) as RankGlyphLabel[]).map((label) => RANK_SVG_LEFT_FRACTION + (RANK_GLYPHS[label].x2 + HALF_STROKE - viewBoxX(label)) * SCALE))

/** Where a rank's ink lands, as fractions of card width: `left`/`right` measured from the rank
 * Svg's left edge, `top`/`bottom` from the corner row's top edge. Stroke included. */
export interface RankInk {
  left: number
  right: number
  top: number
  bottom: number
}

export interface RankGlyphGeometry {
  /** The Svg's size in whole points - see rankSvgSize. */
  width: number
  height: number
  /** The Svg's viewBox: its window onto the outline, in font units, at exactly the designed scale
   * (`width`/`height` px cover it 1:1, so "meet" has nothing to letterbox). Its x centres the run
   * in the rank box (the Svg's padded middle); its y puts the INK's vertical centre on the
   * Svg's - and so the row's - centre, per rank: digits, A and K sit on the baseline while J and
   * Q hang a descender below it, so one shared baseline would leave them off-centre by different
   * amounts. */
  viewBox: string
  ink: RankInk
}

/** The rank Svg's size in whole points at this card width: the designed box (RANK_SVG_WIDTH_FRACTION
 * wide, the corner row tall) rounded UP. react-native-svg's root Svg truncates a fractional
 * width/height with parseInt before it reaches native (its own Svg.tsx, and only iOS/Android -
 * the web <svg> keeps fractions), and the viewBox keeps its exact aspect, so a fractional size
 * would draw the whole rank at floor(w)/w of its designed scale - 0.916x at a 28pt card, and the
 * '10''s left edge would wander with the card width. A whole size survives the truncation intact;
 * rounding up (never down) keeps all the ink inside the box. */
export function rankSvgSize(cardWidth: number, rowFraction: number) {
  return { width: Math.ceil(cardWidth * RANK_SVG_WIDTH_FRACTION), height: Math.ceil(cardWidth * rowFraction) }
}

/** Layout of one rank's glyph in a corner row `rowFraction` * card width tall, on a card
 * `cardWidth` wide. The ink measures are pure fractions of card width (the same at every size);
 * only the Svg's whole-point size depends on the width. */
export function rankGlyphGeometry(label: RankGlyphLabel, cardWidth: number, rowFraction: number): RankGlyphGeometry {
  const g = RANK_GLYPHS[label]
  const { width, height } = rankSvgSize(cardWidth, rowFraction)
  // The box as fractions of card width (the designed ones for a zero-width card, which has no ratio).
  const boxWidth = cardWidth > 0 ? width / cardWidth : RANK_SVG_WIDTH_FRACTION
  const boxHeight = cardWidth > 0 ? height / cardWidth : rowFraction
  const vx = viewBoxX(label)
  // Extra width is added on the right and extra height on both sides, so every ink x stays where
  // the unrounded box put it and the ink stays centred on the row.
  const vw = boxWidth / SCALE
  const vh = boxHeight / SCALE
  const vy = (g.y1 + g.y2) / 2 - vh / 2
  const rowUnits = rowFraction / SCALE
  const rowTop = (g.y1 + g.y2) / 2 - rowUnits / 2
  return {
    width,
    height,
    viewBox: `${vx} ${vy} ${vw} ${vh}`,
    ink: {
      left: (g.x1 - HALF_STROKE - vx) * SCALE,
      right: (g.x2 + HALF_STROKE - vx) * SCALE,
      top: (g.y1 - HALF_STROKE - rowTop) * SCALE,
      bottom: (g.y2 + HALF_STROKE - rowTop) * SCALE
    }
  }
}

interface RankGlyphProps {
  label: RankGlyphLabel
  color: string
  cardWidth: number
  /** The corner row's height as a fraction of card width (CORNER_ROW_FRACTION). */
  rowFraction: number
}

// Screen readers used to announce the rank because it was a Text; a drawn glyph has to say so. Native
// only reaches a view that is `accessible`, with the legacy accessibility* props (RN turns aria-*/role
// into them inside View, which a native Svg root never goes through). On web the <svg> takes role/aria-label
// instead: react-native-web has no use for `accessible` and would hand it to the DOM as an unknown attribute
// (React warns "non-boolean attribute `accessible`"), and it deprecates accessibilityRole/accessibilityLabel.
// Exported: BigRankGlyph.tsx (the 'numeric' style's big centre glyph) is the same kind of Svg-drawn
// rank standing in for what used to be a Text, and needs exactly the same announcement.
export const rankA11yProps = (label: RankGlyphLabel) => Platform.select({ web: { role: 'img', 'aria-label': label } as const, default: { accessible: true, accessibilityRole: 'image', accessibilityLabel: label } as const })

/**
 * A card's corner rank, drawn from DejaVu Serif Bold's glyph outlines (see rankGlyphs.ts) with a
 * faux-bold stroke - two native views (Svg + Path), identical on every platform because it never
 * touches a font. The Svg is about RANK_SVG_WIDTH_FRACTION wide (rounded up to whole points, see
 * rankSvgSize) and the corner row tall or a hair more, so it slots into the row as a flex child -
 * `alignItems: 'center'` keeps the rounded-up height centred on the row - and the per-rank
 * centring lives entirely in its viewBox. Memoized for the same reason as SuitPip: card content
 * only changes when a move happens.
 */
export const RankGlyph = React.memo(function RankGlyph({ label, color, cardWidth, rowFraction }: RankGlyphProps) {
  const { width, height, viewBox } = rankGlyphGeometry(label, cardWidth, rowFraction)
  return (
    <Svg width={width} height={height} viewBox={viewBox} {...rankA11yProps(label)}>
      <Path d={RANK_GLYPHS[label].d} fill={color} stroke={color} strokeWidth={STROKE_UNITS} strokeLinejoin='round' />
    </Svg>
  )
})
