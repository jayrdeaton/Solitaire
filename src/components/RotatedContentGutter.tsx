import { computeContentBounds } from '@tastic/core'
import { ReactNode } from 'react'
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native'

import { useGameLayout } from './gameLayout'

interface RotatedContentGutterProps {
  maxContentWidth: number
  style?: StyleProp<ViewStyle>
  children: ReactNode
}

/** Rotation-aware stand-in for @tastic/hud's ContentGutter - same centered, width-capped column,
 * but sized from useRotatedWindowDimensions() instead of a raw useWindowDimensions() read.
 *
 * ContentGutter's own width read never changes under a fake rotation (the OS still thinks the
 * window is portrait-locked), so inside a rotated game screen it kept capping the play area at the
 * portrait window width (e.g. 402pt) while every card-size calculation below it - which does read
 * useRotatedWindowDimensions() - was already sized for the swapped landscape width (874pt). The
 * board laid out at landscape size inside a portrait-width box, clipping everything past the first
 * ~402pt. Exact identity with ContentGutter at rotation 0.
 *
 * hud's ContentGutter reads the rotated width itself since 0.13.0, but it still can't replace this:
 * it caps against the WHOLE window and splits the leftover equally, while the wide layout needs each
 * side's chrome column (useGameLayout's leftGutter/rightGutter, which differ per side) reserved out of
 * the width first. hud's leftGutter/rightGutter props are decorations drawn inside the leftover, not
 * reserved widths - swapped in, the board would run under the footer and readout columns. */
export function RotatedContentGutter({ maxContentWidth, style, children }: RotatedContentGutterProps) {
  // Wide (landscape) layout: the leading/trailing gutters double as the chrome columns (footer icons,
  // moves/timer), so each is reserved out of the width before capping - see gameLayout.ts. Any width
  // left over once the content hits its cap is split equally on top of them, keeping the board centred
  // between the two chrome columns. Portrait: both are 0 - exactly the plain rotated width, as before.
  const { windowWidth, leftGutter, rightGutter } = useGameLayout()
  const { contentWidth, gutterWidth } = computeContentBounds(windowWidth - leftGutter - rightGutter, maxContentWidth)
  return (
    <View style={[styles.row, style]}>
      <View style={[styles.gutter, { width: leftGutter + gutterWidth }]} />
      <View style={{ width: contentWidth }}>{children}</View>
      <View style={[styles.gutter, { width: rightGutter + gutterWidth }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  gutter: {
    overflow: 'hidden'
  },
  row: {
    flexDirection: 'row'
  }
})
