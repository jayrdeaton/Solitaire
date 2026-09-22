import React from 'react'
import { StyleSheet, ViewStyle } from 'react-native'
import Svg from 'react-native-svg'

import { CourtRank } from './artwork/court'
import { buildColorOverrideMap, DecoratedPackColors } from './artwork/decoratedCustom/colors'
import { courtFigures } from './artwork/decoratedCustom/courtFigures'
import { MARGIN_FRACTION } from './CardBack'
import { renderDecoratedShape } from './DecoratedShapeRenderer'
import { Suit } from './types'

interface DecoratedCourtFigureProps {
  suit: Suit
  rank: CourtRank
  width: number
  height: number
  /** Substitutes named colors from the baked art (see artwork/decoratedCustom/colors.ts) for the
   * "invert dark mode colors" setting. Omit to render the pack's own default colors unchanged. */
  colorOverrides?: Partial<DecoratedPackColors>
}

// The generated crop (see artwork/decorated/courtFigures.ts) is deliberately edge-to-edge with no
// padding - regenerating it with padding would need the original SVG-cards master sheet, which
// isn't checked into this repo (see generate-court-figures.mjs's usage comment). Padding here
// instead, by inflating the viewBox symmetrically around the same, unmoved shapes: since
// preserveAspectRatio="none" below maps viewBox linearly onto width/height, a larger viewBox just
// reads as blank margin on all sides rather than shrinking or cropping the art itself. Reuses
// CardBack's own MARGIN_FRACTION (rather than a separately-tuned number) so every card - back,
// whole-face, and just-the-figure - reads with the same margin.

/**
 * The compact card style's court figure, full-colour (see artwork/decoratedCustom/courtFigures.ts
 * - a relabeled duplicate of artwork/decorated/courtFigures.ts, see
 * generate-decorated-custom-pack.mjs) rather than CourtFigure's single-tone silhouette - cropped
 * to just the figure, no card border/corner index, so it drops into CardFace's existing corner-
 * index-row + content-area layout the same way CourtFigure does. Colour is baked into the art
 * (it's a specific suit's own illustration, not a shared shape), so unlike CourtFigure this has no
 * `color` prop and can't render a muted/neutral form - CardFace falls back to CourtFigure for that
 * - it can only be selectively recolored via `colorOverrides` (see DecoratedCourtFigureProps).
 */
export const DecoratedCourtFigure = React.memo(function DecoratedCourtFigure({ suit, rank, width, height, colorOverrides }: DecoratedCourtFigureProps) {
  const art = courtFigures[suit][rank]
  const [ax, ay, aw, ah] = art.viewBox
  const marginX = aw * MARGIN_FRACTION
  const marginY = ah * MARGIN_FRACTION
  const vx = ax - marginX
  const vy = ay - marginY
  const vw = aw + marginX * 2
  const vh = ah + marginY * 2
  const idPrefix = React.useId()
  const valueOverrides = buildColorOverrideMap(colorOverrides)

  return (
    // preserveAspectRatio="none" stretches to exactly fill width/height rather than the SVG
    // default (contain + center) - the art's own crop aspect doesn't exactly match the content
    // area's, and "contain" left a thin letterboxed gap at the bottom (the matching gap at the top
    // was invisible, sitting under CardFace's own corner-index row). The mismatch is small enough
    // that the stretch itself isn't noticeable, unlike the gap it replaces.
    <Svg width={width} height={height} viewBox={`${vx} ${vy} ${vw} ${vh}`} preserveAspectRatio='none' style={styles.svg}>
      {art.shapes.map((shape, i) => renderDecoratedShape(shape, i, idPrefix, undefined, undefined, valueOverrides))}
    </Svg>
  )
})

// `userSelect` only exists on RN's own TextStyle, not ViewStyle - and Svg's own `style` prop is
// typed StyleProp<ViewStyle>. It's real on web (react-native-web renders Svg as an actual DOM
// <svg>, where this stops the court figure's own artwork from being text-selectable) and a
// harmless no-op on native. Needs its own explicit type here, since plain ViewStyle doesn't
// include it and TypeScript's "weak type" check rejects an object sharing zero properties with an
// all-optional target type otherwise.
const svgStyle: ViewStyle & { userSelect?: 'none' } = { userSelect: 'none' }

const styles = StyleSheet.create({
  svg: svgStyle
})
