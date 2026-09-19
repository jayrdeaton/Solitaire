import { useId } from 'react'
import { StyleSheet, View } from 'react-native'
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg'

import { useTableColors } from './theme'

/** The one felt table the whole app plays on - every top-level screen (each game via GameChrome,
 * the main menu, achievements, profiles) renders this as its own root background instead of each
 * independently painting a flat `colors.tableFelt` fill, so navigating between them reads as one
 * continuous table rather than several screens that happen to agree on a color. `colors.tableFelt`
 * fills the frame; a radial vignette layers a gentle dim toward the edges in the theme's own
 * `tableFeltDark` accent on top, brighter through the middle where it's fully transparent.
 *
 * Callers render this as an absolutely-positioned first child behind their real content (it fills
 * whatever positioned/flex-sized parent it's given, same as StyleSheet.absoluteFill) rather than
 * painting `tableFelt` themselves - see GameChrome/app/index.tsx/app/achievements.tsx/
 * app/profiles.tsx. */
export function TableBackground() {
  const colors = useTableColors()
  // Every screen that renders this mounts its own instance, and React Navigation on web keeps a
  // popped screen mounted (hidden, not unmounted) across a stack pop rather than unmounting it -
  // see .claude/CLAUDE.md's ProfilesManager finding - so more than one instance can genuinely
  // coexist in the DOM at once there. A shared literal id would make every instance's
  // fill="url(#...)" resolve to whichever one's <Defs> happens to come first in the document.
  const gradientId = useId()
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents='none'>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.tableFelt }]} />
      <Svg style={StyleSheet.absoluteFill} width='100%' height='100%'>
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
