import React, { useId } from 'react'
import Svg from 'react-native-svg'

import { TableColors } from '../theme'
import { type BackStyleName, cardBacks } from './artwork/backs'
import { DecoratedShape } from './artwork/types'
import { renderDecoratedShape } from './DecoratedShapeRenderer'

interface DecoratedCardBackProps {
  style: BackStyleName
  colors: TableColors
  width: number
  height: number
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
export const DecoratedCardBack = React.memo(function DecoratedCardBack({ style, colors, width, height }: DecoratedCardBackProps) {
  const idPrefix = useId()
  const art = cardBacks[style]
  const [minX, minY, vbWidth, vbHeight] = art.viewBox

  return (
    <Svg width={width} height={height} viewBox={`${minX} ${minY} ${vbWidth} ${vbHeight}`}>
      {renderDecoratedShape(art.base, 0, `${idPrefix}-base`)}
      {renderDecoratedShape(resolveBackColors(art.body, colors.cardBack, colors.cardBackPattern), 1, idPrefix)}
    </Svg>
  )
})
