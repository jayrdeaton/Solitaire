import { getContrastColor } from '@rific/auto-paper'
import React from 'react'
import { StyleSheet, ViewStyle } from 'react-native'
import Svg, { G, Path, Rect, Text as SvgText } from 'react-native-svg'

import { TableColors } from './colors'

// Scraped from the SVG-cards sheet's own #base-to-body spacing (measured live via getBBox, 7.94
// units on a 169.075-wide viewBox), not guessed, so this hand-drawn design reads with the exact
// same frame width as the sheet-derived back styles (see DecoratedCardBack.tsx) rather than an
// approximately-similar one. Exported and reused by DecoratedCardFace.tsx/DecoratedCourtFigure.tsx
// for the same reason: one consistent card-wide margin, not a different guess per component.
export const MARGIN_FRACTION = 0.047

interface CardBackProps {
  colors: TableColors
  width: number
  height: number
  /** Active player's short profile tag (<=3 chars or one emoji), centered in the medallion as a
   * monogram. Omit (or pass empty/whitespace) to keep the plain nested-diamond medallion
   * pixel-identical to before - the guest/no-active-profile case. */
  tag?: string
  /** Dark mode only: flips the frame's white fill/black stroke to near-black/white (see
   * stores/settings.tsx's invertDarkModeColors), and pulls the pattern's own accent color darker
   * (colors.cardBackPatternInverted) instead of leaving it unchanged. A no-op in light mode. */
  invertDarkModeColors?: boolean
}

function diamondPath(cx: number, cy: number, half: number): string {
  return `M${cx},${cy - half} L${cx + half},${cy} L${cx},${cy + half} L${cx - half},${cy} Z`
}

/** How many cells fit in `size` at `cell` each, plus the margin needed to center them. */
function fitCentered(size: number, cell: number) {
  const count = Math.max(1, Math.floor(size / cell))
  const gridSize = count * cell
  return { count, offset: (size - gridSize) / 2 }
}

/**
 * An original geometric card back: a centered two-tone diamond weave (solid
 * diamonds alternating with outlined ones) with a nested-diamond medallion at
 * the middle, inside a double border frame. The grid is inset evenly from the
 * frame on every side, rather than stretched edge-to-edge on one axis.
 *
 * Memoized: `colors`/`width`/`height` are stable references, so this can skip re-rendering (and
 * recomputing the whole diamond grid) on unrelated re-renders like the per-second elapsed timer.
 */
export const CardBack = React.memo(function CardBack({ colors, width, height, tag, invertDarkModeColors }: CardBackProps) {
  const patternColor = invertDarkModeColors ? colors.cardBackPatternInverted : colors.cardBackPattern
  const inset = width * 0.09
  const rx = width * 0.06
  const innerW = width - inset * 2
  const innerH = height - inset * 2

  const cell = width * 0.145
  const { count: cols, offset: marginX } = fitCentered(innerW, cell)
  const { count: rows, offset: marginY } = fitCentered(innerH, cell)
  const xOffset = inset + marginX
  const yOffset = inset + marginY

  const solidCells: string[] = []
  const outlineCells: string[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = xOffset + c * cell + cell / 2
      const cy = yOffset + r * cell + cell / 2
      const d = diamondPath(cx, cy, cell / 2)
      if ((r + c) % 2 === 0) solidCells.push(d)
      else outlineCells.push(d)
    }
  }

  const centerX = width / 2
  const centerY = height / 2

  const hasTag = !!tag && tag.trim().length > 0
  // Slightly larger medallion when it needs to host a monogram - the no-tag roundel stays exactly
  // cell*0.5 (unchanged from before), so that path never redraws at a different size.
  const medallionHalf = hasTag ? cell * 0.95 : cell * 0.5

  // Equal pixel margin on every side, not one uniform scale factor - width/height aren't equal (a
  // card is taller than it is wide), so the same *proportion* shaved off each axis leaves more
  // margin (in actual pixels) top/bottom than left/right. See DecoratedCardBack.tsx's identical
  // note for why a non-uniform scale is what actually fixes that on a non-square box.
  const margin = width * MARGIN_FRACTION
  const scaleX = (width - margin * 2) / width
  const scaleY = (height - margin * 2) / height

  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={styles.svg}>
      {/* The card's own white/black rounded-rect frame, matching the SVG-cards-derived
      ornate/plain backs' identical #base treatment (see artwork/backs.ts) - baked into this
      design's own SVG rather than left to PlayingCard's outer View clip, so every back style
      reads with the same built-in edge regardless of which one's active. */}
      <Rect x={0} y={0} width={width} height={height} rx={rx} fill={invertDarkModeColors ? colors.cardFaceInverted : '#FFFFFF'} stroke={invertDarkModeColors ? colors.textBlackInverted : '#000000'} strokeWidth={width * 0.02} />
      <G transform={`translate(${margin},${margin}) scale(${scaleX},${scaleY})`}>
        <Rect x={0} y={0} width={width} height={height} fill={colors.cardBack} />
        <Rect x={inset} y={inset} width={innerW} height={innerH} rx={rx} fill='none' stroke={patternColor} strokeWidth={1} strokeOpacity={0.6} />

        <Path d={solidCells.join(' ')} fill={patternColor} opacity={0.55} />
        <Path d={outlineCells.join(' ')} fill='none' stroke={patternColor} strokeWidth={1} strokeOpacity={0.55} />

        <Path d={diamondPath(centerX, centerY, cell * 1.45)} fill={colors.cardBack} stroke={patternColor} strokeWidth={1.5} />
        <Path d={diamondPath(centerX, centerY, medallionHalf)} fill={patternColor} />
        {hasTag && (
          <SvgText x={centerX} y={centerY} dy={medallionHalf * 0.35} fill={getContrastColor(patternColor)} fontSize={medallionHalf * 1.15} fontWeight='700' textAnchor='middle'>
            {tag!.trim().toUpperCase()}
          </SvgText>
        )}

        <Rect x={inset} y={inset} width={innerW} height={innerH} rx={rx} fill='none' stroke={patternColor} strokeWidth={1.5} />
      </G>
    </Svg>
  )
})

// `userSelect` only exists on RN's own TextStyle, not ViewStyle - and Svg's own `style` prop is
// typed StyleProp<ViewStyle>. It's real on web (react-native-web renders Svg as an actual DOM
// <svg>, where this stops the card back's own artwork from being text-selectable) and a harmless
// no-op on native. Needs its own explicit type here, since plain ViewStyle doesn't include it and
// TypeScript's "weak type" check rejects an object sharing zero properties with an all-optional
// target type otherwise.
const svgStyle: ViewStyle & { userSelect?: 'none' } = { userSelect: 'none' }

const styles = StyleSheet.create({
  svg: svgStyle
})
