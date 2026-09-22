import React, { useId } from 'react'
import Svg from 'react-native-svg'

import { type BackStyleName, cardBacks } from './artwork/backs'
import { DecoratedShape } from './artwork/types'
import { TableColors } from './colors'
import { renderDecoratedShape } from './DecoratedShapeRenderer'

interface DecoratedCardBackProps {
  style: BackStyleName
  colors: TableColors
  width: number
  height: number
  /** Dark mode only: flips `base`'s own literal white/black frame to near-black/white (the same
   * treatment every decorated face card's #base already gets - see CardFace.tsx), and pulls
   * `body`'s BACK_ACCENT resolution darker (colors.cardBackPatternInverted) instead of leaving it
   * unchanged. A no-op in light mode. */
  invertDarkModeColors?: boolean
}

/** Substitutes backs.ts' two colour sentinels with the active profile's actual table colours -
 * the shapes themselves are static (see generate-card-back.mjs), only the paint changes per
 * render, the same live-recolour contract CardBack.tsx's own geometric design already has. */
function resolveBackColors(shape: DecoratedShape, cardBack: string, cardBackPattern: string): DecoratedShape {
  const resolve = (v?: string) => (v === 'BACK_BASE' ? cardBack : v === 'BACK_ACCENT' ? cardBackPattern : v)
  const resolved: DecoratedShape = { ...shape, fill: resolve(shape.fill), stroke: resolve(shape.stroke) }
  if (resolved.tag === 'g' && shape.tag === 'g') {
    resolved.children = shape.children.map((c) => resolveBackColors(c, cardBack, cardBackPattern))
  }
  return resolved
}

/**
 * An SVG-cards-derived card back (see artwork/NOTICE.md) - the "ornate" classic Bicycle-style
 * lattice/scrollwork/medallion design, or "plain", its minimal bordered-rectangle sibling. Both
 * `base` (the sheet's own white/black card-frame) and `body` (the recolourable design - card-
 * coloured reads `colors.cardBack`, its white accents read `colors.cardBackPattern`, see
 * resolveBackColors) render at their own natural size, unlike CardBack.tsx's own hand-drawn
 * geometric design, which has no margin of its own and needs one added (see its own MARGIN_FRACTION
 * note). This sheet already draws `body` with its own clean margin in from `base`'s edge - adding
 * another inset transform on top here would double it rather than match it (confirmed live: it did,
 * until this stopped doing that). The two are kept as separate shapes rather than one combined tree
 * (see BackArt's own doc in artwork/types.ts) only so `body`'s colour sentinels can be resolved
 * without also walking - and risking mutating - `base`'s own literal white/black. Unlike
 * CardBack.tsx's own geometric design, this has no player-tag monogram slot, since the sheet's
 * medallion has no room carved out for one.
 */
export const DecoratedCardBack = React.memo(function DecoratedCardBack({ style, colors, width, height, invertDarkModeColors }: DecoratedCardBackProps) {
  const idPrefix = useId()
  const art = cardBacks[style]
  const [minX, minY, vbWidth, vbHeight] = art.viewBox
  const patternColor = invertDarkModeColors ? colors.cardBackPatternInverted : colors.cardBackPattern
  // `base`'s own literal frame colors (see backs.ts's header comment - kept as literals, unlike
  // `body`'s BACK_BASE/BACK_ACCENT sentinels), confirmed via
  // `grep -oE "fill: '[^']*'|stroke: '[^']*'" backs.ts` - both back styles use the exact same three
  // values for their frame, so one fixed map (not per-style) covers both.
  const baseOverrides = invertDarkModeColors ? { black: colors.textBlackInverted, '#FFFFFF': colors.cardFaceInverted, '#000000': colors.textBlackInverted } : undefined

  return (
    <Svg width={width} height={height} viewBox={`${minX} ${minY} ${vbWidth} ${vbHeight}`}>
      {renderDecoratedShape(art.base, 0, `${idPrefix}-base`, undefined, undefined, baseOverrides)}
      {renderDecoratedShape(resolveBackColors(art.body, colors.cardBack, patternColor), 1, idPrefix)}
    </Svg>
  )
})
