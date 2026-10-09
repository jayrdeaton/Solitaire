import { useId } from 'react'
import { StyleSheet, useWindowDimensions, View } from 'react-native'
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg'

import { useTableColors } from './theme'

/** The one felt table the whole app plays on - mounted ONCE, at the root (`ThemedStack` in
 * app/_layout.tsx), behind the navigation Stack, whose screens are transparent. Every screen - each
 * game (GameChrome and its GameLoading), the main menu, achievements, profiles - just draws its content
 * over it, so navigating between them reads as one continuous table rather than several screens that
 * each happen to paint the same color, and a screen that hasn't rendered its content yet (a game
 * waiting on its saved-board read) shows felt instead of a flash of the Stack's black. `colors.tableFelt`
 * fills the frame; a radial vignette layers a gentle dim toward the edges in the theme's own
 * `tableFeltDark` accent on top, brighter through the middle where it's fully transparent.
 *
 * Fills whatever positioned/flex-sized parent it's given (same as StyleSheet.absoluteFill). It is
 * deliberately NOT inside FakeLandscapeView: a fake landscape rotation turns the game frame, not the
 * device screen, and an ellipse fitted to the portrait screen reads as the same wide ellipse once the
 * phone is held sideways - so the one root felt is right at every angle, with nothing to re-key. */
export function TableBackground() {
  const colors = useTableColors()
  // Every screen used to mount its own instance, and React Navigation on web keeps a popped screen
  // mounted (hidden, not unmounted) across a stack pop rather than unmounting it - see
  // .claude/CLAUDE.md's ProfilesManager finding - so more than one instance could genuinely coexist
  // in the DOM at once there, and a shared literal id would make every instance's fill="url(#...)"
  // resolve to whichever one's <Defs> came first in the document. Now there is only the one, but a
  // per-instance id is still the correct way to reference a gradient and costs nothing.
  const gradientId = useId()
  // Remounts the Svg when the window is resized. react-native-svg doesn't re-resolve this gradient's
  // percentage-based Rect against a resized view on iOS - it kept painting at the previous size,
  // leaving a hard-edged band across the felt (first seen returning from landscape to portrait, back
  // when the felt lived inside the rotating game frame; a real window resize - iPad, web - is the
  // same failure).
  const { width, height } = useWindowDimensions()
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents='none'>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.tableFelt }]} />
      <Svg key={`${width}x${height}`} style={StyleSheet.absoluteFill} width='100%' height='100%'>
        <Defs>
          <RadialGradient id={gradientId} cx='50%' cy='50%' rx='75%' ry='75%'>
            <Stop offset='55%' stopColor={colors.tableFeltDark} stopOpacity={0} />
            <Stop offset='100%' stopColor={colors.tableFeltDark} stopOpacity={0.55} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width='100%' height='100%' fill={`url(#${gradientId})`} />
      </Svg>
    </View>
  )
}
