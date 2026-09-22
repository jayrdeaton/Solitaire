import React from 'react'
import { StyleProp, ViewStyle } from 'react-native'
import Svg, { G, Path } from 'react-native-svg'

import { suitPipArt } from './artwork/pips'
import { tarotPipArt } from './artwork/tarotPips'
import { Suit } from './types'

interface SuitPipProps {
  suit: Suit
  color: string
  size: number
  style?: StyleProp<ViewStyle>
  /** Opt in to this pip being right-anchored by its own BOX rather than its ink - e.g. CardFace's
   * corner row (right-aligned via justifyContent), where several suits sit stacked in the same
   * column and any misalignment between them is compared directly. Drives two corrections, both
   * only meaningful in that context and skipped otherwise (CardFace's big centre pip doesn't pass
   * this): (1) boosts diamond to the same width-fill as the other suits (see SIZE_COMPENSATION
   * below), so its glyph's edge lines up with theirs - full width-fill would also undo the big
   * centre pip's deliberate elongated shape (see pips.ts), hence this being opt-in rather than
   * diamond's default; (2) applies CORNER_NUDGE_PX, this row's own empirically-measured per-suit
   * touch-ups (unrelated to HEART_NUDGE_PX, which is skipped here instead - see both below). */
  edgeFill?: boolean
  /** 'tarot' swaps in tarotPipArt (cups/coins/wands/swords) instead of the standard four suits.
   * Its glyphs were drawn to a consistent width-fill from the start, so neither SIZE_COMPENSATION
   * nor DIAMOND_EDGE_FILL_COMPENSATION nor HEART_NUDGE_PX nor CORNER_NUDGE_PX apply - those are
   * corrections for the standard art's specific geometry, not a property of "suit" in general.
   * Defaults to 'standard'. */
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
// compensations above. Applied only to the big single-face pip (no edgeFill) - see
// CORNER_NUDGE_PX below for why the corner row doesn't use it.
const HEART_NUDGE_PX = -1

// A second, SEPARATE round of perceptual nudges, on top of the geometric recentring below and
// unrelated to HEART_NUDGE_PX's - needed only in the corner row (edgeFill), where all four suits
// sit right-anchored down the same column and any residual sub-pixel misalignment reads clearly
// once compared suit-to-suit, in a way a single standalone glyph never is. Measured directly off
// real rendered corner pips (ink centroid position relative to the card's own right edge, not
// derivable from the viewBox geometry the way the width-fill compensations above are): with only
// the geometric recentring applied, spades measured about 0.4pt right of clubs/diamonds (their own
// art's centroid doesn't fall exactly where SIZE_COMPENSATION's aspect-ratio math assumes) and
// hearts measured about 1pt left of them - almost entirely HEART_NUDGE_PX itself, since a heart's
// own geometric centroid (unnudged) already lands within a few hundredths of a point of clubs'.
// That confirms HEART_NUDGE_PX is a genuinely perceptual correction with no geometric counterpart
// to cancel here, so the corner row simply omits it rather than needing an offsetting value.
const CORNER_NUDGE_PX: Partial<Record<Suit, number>> = {
  spades: -0.4
}

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
  // `edgeFill` doesn't just pick diamond's compensation above - CardFace passes it (suit-independent)
  // on exactly the ONE call that sits in a row anchoring this pip by its BOX's right edge, not its
  // ink (space-between flex - the corner row); the other call (the big centre pip) centres it both
  // ways instead, where a bigger box stays self-centred with no correction needed - applying this
  // unconditionally once regressed exactly that call for spades (the only suit compensated there
  // too, unconditionally via SIZE_COMPENSATION). Only in the right-anchored case does growing the box
  // for width-fill grow it LEFTWARD from that fixed anchor, dragging the (still box-centred) ink left
  // by half the growth - more for spades (always compensated) than diamond (edgeFill only); shifting
  // back right by that same half-growth cancels it, landing every suit's ink on the same centre as
  // the uncompensated suits' (clubs; hearts keep their own separate nudge below) regardless of
  // width-fill. Composes with HEART_NUDGE_PX into one transform: the two are mutually exclusive
  // (hearts never carry a size compensation).
  const recenter = edgeFill ? (renderSize - size) / 2 : 0
  // Mutually exclusive by construction: the corner row (edgeFill) uses CORNER_NUDGE_PX and never
  // HEART_NUDGE_PX; the big single pip (no edgeFill) uses HEART_NUDGE_PX and never CORNER_NUDGE_PX
  // (undefined for every suit but spades, and spades' compensation there needs no correction - see
  // the big-pip half of CardFace, which never passes edgeFill).
  const perceptualNudge = theme !== 'standard' ? 0 : edgeFill ? (CORNER_NUDGE_PX[suit] ?? 0) : suit === 'hearts' ? HEART_NUDGE_PX : 0
  const translateX = perceptualNudge + recenter
  return (
    <Svg width={renderSize} height={renderSize} viewBox={`${x} ${y} ${w} ${h}`} style={[style, translateX !== 0 && { transform: [{ translateX }] }]}>
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
