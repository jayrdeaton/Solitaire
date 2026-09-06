import React from 'react'
import { StyleProp, ViewStyle } from 'react-native'
import Svg, { G, Path } from 'react-native-svg'

import { Suit } from '@/engine/types'

import { suitPipArt } from './artwork/pips'
import { tarotPipArt } from './artwork/tarotPips'

interface SuitPipProps {
  suit: Suit
  color: string
  size: number
  style?: StyleProp<ViewStyle>
  /** Boost diamond to the same width-fill as the other suits (see SIZE_COMPENSATION below),
   * so its glyph's edge lines up with the other suits' in a row that's anchored by its box
   * rather than its ink - e.g. CardFace's corner row, right-aligned via justifyContent. Opt-in
   * rather than diamond's default, since it also grows the glyph to fill that width - fine for
   * a small corner pip, but it would undo the big center pip's deliberate elongated shape (see
   * pips.ts), which CardFace doesn't pass this for. */
  edgeFill?: boolean
  /** 'tarot' swaps in tarotPipArt (cups/coins/wands/swords) instead of the standard four suits.
   * Its glyphs were drawn to a consistent width-fill from the start, so neither SIZE_COMPENSATION
   * nor DIAMOND_EDGE_FILL_COMPENSATION nor HEART_NUDGE apply - those are corrections for the
   * standard art's specific geometry, not a property of "suit" in general. Defaults to 'standard'. */
  theme?: 'standard' | 'tarot'
}

// A square box scaled uniformly (SVG's default "meet" fit) is height-constrained for any
// glyph taller than it is wide, so a suit that's proportionally narrower than the rest
// ends up visibly thinner/smaller at the same nominal `size`. Spades' natural shape is
// narrower than clubs/hearts (an artifact of the source art, not intentional) and always gets
// boosted to match clubs' width-fill. Diamond is narrower still, but deliberately so (see
// pips.ts) - it only gets the same boost where a caller opts in via `edgeFill`.
const widthFillOf = (suit: Suit) => {
  const [, , w, h] = suitPipArt[suit].viewBox
  return w / h
}
const REFERENCE_WIDTH_FILL = widthFillOf('clubs')
const SIZE_COMPENSATION: Partial<Record<Suit, number>> = {
  spades: REFERENCE_WIDTH_FILL / widthFillOf('spades')
}
// Matching diamond's width-fill exactly to clubs over-corrects: a solid rhombus with no
// internal negative space reads heavier/more dominant than the curvier glyphs at the same
// box size, and since the corner row anchors the pip's box to the row's right edge, the
// extra width it grows into also drags its ink visibly further left than the other suits'.
// Splitting the difference keeps the edge closer to lined-up without either side effect.
const DIAMOND_EDGE_FILL_COMPENSATION = 1 + (REFERENCE_WIDTH_FILL / widthFillOf('diamonds') - 1) * 0.5

// The heart glyph's cropped bounding box doesn't match its visual weight - the two lobes'
// curvature leaves the ink sitting a hair right of center - so it reads as nudged right at
// any size. Corrected with a fixed one-pixel shift rather than a proportional one: this is a
// perceptual straightening of the art itself, not a size-dependent alignment like the
// compensations above.
const HEART_NUDGE: StyleProp<ViewStyle> = { transform: [{ translateX: -1 }] }

/**
 * A single suit glyph (heart/diamond/club/spade), tinted by the caller.
 * Memoized: game screens re-render every second (the elapsed-time timer), and without this every
 * pip on the board would re-render its SVG path along with them - card content never changes
 * except when a move actually happens, so that work is pure waste that can visibly stutter an
 * in-progress drag on web, where reconciliation runs on the same thread as the gesture.
 */
export const SuitPip = React.memo(function SuitPip({ suit, color, size, style, edgeFill, theme = 'standard' }: SuitPipProps) {
  const art = theme === 'tarot' ? tarotPipArt[suit] : suitPipArt[suit]
  const [x, y, w, h] = art.viewBox
  const compensation = theme === 'tarot' ? 1 : (SIZE_COMPENSATION[suit] ?? (edgeFill && suit === 'diamonds' ? DIAMOND_EDGE_FILL_COMPENSATION : 1))
  const renderSize = size * compensation
  return (
    <Svg width={renderSize} height={renderSize} viewBox={`${x} ${y} ${w} ${h}`} style={[style, theme === 'standard' && suit === 'hearts' && HEART_NUDGE]}>
      {/* The source paths are authored upside-down (their stem/cusp points the wrong
          way at 0deg) - rotate 180 about the viewBox's own center (which is the
          origin for every suit here) to get the conventional upright glyph. */}
      <G transform='rotate(180)'>
        {art.paths.map((d, i) => (
          <Path key={i} d={d} fill={color} />
        ))}
      </G>
    </Svg>
  )
})
