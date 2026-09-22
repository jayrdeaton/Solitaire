import React from 'react'
import Svg, { Path } from 'react-native-svg'

import { RANK_STROKE_EM, rankA11yProps } from './RankGlyph'
import { RANK_GLYPH_UNITS_PER_EM, RANK_GLYPHS, RankGlyphLabel } from './rankGlyphs'
import { Rank, rankLabel } from './types'

const UNITS = RANK_GLYPH_UNITS_PER_EM
// Same faux-bold treatment as the corner rank (RankGlyph.tsx): a stroke in em units, so it reads
// equally bold at any size rather than needing its own tuning here.
const STROKE_UNITS = RANK_STROKE_EM * UNITS
// Margin around the ink+stroke, as a fraction of THIS glyph's own em size (not card width - it
// scales with whichever of the two font sizes below is in play). Purely so native's whole-point
// Svg rounding (see bigRankGlyphGeometry) has somewhere to grow into without ever touching the ink
// - not a designed gap meant to be visible.
const PAD_EM = 0.04
const PAD_UNITS = PAD_EM * UNITS

// 'numeric' style's big centre rank glyph, as a fraction of card width - unchanged from the
// original Text-based rendering's own tuning (see git history for the fitting arithmetic). '10' is
// the only non-court rank whose label is two characters (see rankLabel), so it gets its own smaller
// scale, chosen so its ink comfortably fits the card on its own; every other rank (a single glyph)
// reads well at the larger, shared scale.
export function bigRankFontScale(rank: Rank): number {
  return rank === 10 ? 0.65 : 0.85
}

export interface BigRankGlyphGeometry {
  /** The Svg's size in whole points - see rankSvgSize's own doc comment (RankGlyph.tsx) for why. */
  width: number
  height: number
  viewBox: string
}

/** Layout for one rank's BIG centre glyph (the 'numeric' card style's stand-in for the big suit
 * pip) on a card `cardWidth` wide - self-centred, ink centre on the Svg's own centre, both axes.
 * Unlike the corner row's RankGlyph, there's no fixed anchor for a bigger box to drift from here:
 * CardFace's `centerFill` centres this both ways already, so growing the Svg to whole points can
 * only ever grow it evenly outward from the ink, with nothing to re-derive from a box or a suit
 * pip the way the corner rank's left/right fractions do. */
export function bigRankGlyphGeometry(label: RankGlyphLabel, cardWidth: number, rank: Rank): BigRankGlyphGeometry {
  const g = RANK_GLYPHS[label]
  // Card-width FRACTION per font unit (mirrors RankGlyph.tsx's own SCALE - deliberately not
  // multiplied by cardWidth yet, so it stays usable both to size the box in points below and, from
  // the ACTUAL rounded point size, to convert back into font units for the viewBox).
  const emScale = bigRankFontScale(rank) / UNITS
  const boxWidthUnits = g.x2 - g.x1 + STROKE_UNITS + 2 * PAD_UNITS
  const boxHeightUnits = g.y2 - g.y1 + STROKE_UNITS + 2 * PAD_UNITS
  // Whole points, rounded up - react-native-svg truncates a fractional root Svg size with parseInt
  // before it reaches native (only iOS/Android - the web <svg> keeps fractions), and the viewBox
  // keeps its exact aspect, so a fractional size would draw the whole glyph smaller than designed
  // (see RankGlyph.tsx's rankSvgSize, the same fix at the corner's own scale).
  const width = Math.ceil(cardWidth * boxWidthUnits * emScale)
  const height = Math.ceil(cardWidth * boxHeightUnits * emScale)
  // Convert back to font units at the ACTUAL (rounded) box size, so one font unit maps to exactly
  // `emScale` card-width-fraction regardless of the rounding - the designed scale survives intact.
  const vw = cardWidth > 0 ? width / cardWidth / emScale : boxWidthUnits
  const vh = cardWidth > 0 ? height / cardWidth / emScale : boxHeightUnits
  const vx = (g.x1 + g.x2) / 2 - vw / 2
  const vy = (g.y1 + g.y2) / 2 - vh / 2
  return { width, height, viewBox: `${vx} ${vy} ${vw} ${vh}` }
}

interface BigRankGlyphProps {
  rank: Rank
  color: string
  cardWidth: number
}

/**
 * The 'numeric' card style's big centre glyph (A, 2-10 - court ranks keep their own figure and
 * never reach this component): the same DejaVu Serif Bold outlines and faux-bold stroke as the
 * corner rank (RankGlyph.tsx), just laid out self-centred and at a much larger size instead of
 * right-anchored in a row. Drawing both from the same glyph table and the same em-relative stroke
 * is what keeps them reading as one consistent typeface rather than two different weights sharing
 * a card. Memoized for the same reason as RankGlyph/SuitPip: card content only changes on a move.
 */
export const BigRankGlyph = React.memo(function BigRankGlyph({ rank, color, cardWidth }: BigRankGlyphProps) {
  const label = rankLabel(rank) as RankGlyphLabel
  const { width, height, viewBox } = bigRankGlyphGeometry(label, cardWidth, rank)
  return (
    <Svg width={width} height={height} viewBox={viewBox} {...rankA11yProps(label)}>
      <Path d={RANK_GLYPHS[label].d} fill={color} stroke={color} strokeWidth={STROKE_UNITS} strokeLinejoin='round' />
    </Svg>
  )
})
