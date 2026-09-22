import React from 'react'
import Svg, { G, Path } from 'react-native-svg'

import { courtArt, CourtRank } from './artwork/court'

interface CourtFigureProps {
  rank: CourtRank
  color: string
  width: number
  height: number
}

const FIGURE_WIDTH_FRACTION = 0.62

/**
 * The Jack/Queen/King illustration: a single silhouette (shared across all four
 * suits), tinted red/black by suit like a suit pip, centered on the card. Scaled
 * from the art's own viewBox, so it renders correctly regardless of how that
 * viewBox is authored - no manual centering needed when hand-drawing new art.
 *
 * Memoized: each figure is several Path elements, and game screens re-render every
 * second (the elapsed-time timer) - without this every court card on the board
 * would re-reconcile its tree on every tick for no reason, which can visibly
 * stutter an in-progress drag on web.
 */
export const CourtFigure = React.memo(function CourtFigure({ rank, color, width, height }: CourtFigureProps) {
  const art = courtArt[rank]
  const [vx, vy, vw, vh] = art.viewBox
  const cx = vx + vw / 2
  const cy = vy + vh / 2
  const scale = (width * FIGURE_WIDTH_FRACTION) / vw
  const transform = `translate(${width / 2}, ${height / 2}) scale(${scale}) translate(${-cx}, ${-cy})`

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <G transform={transform}>
        {art.paths.map((d, i) => (
          <Path key={i} d={d} fill={color} />
        ))}
      </G>
    </Svg>
  )
})
