import { MaterialCommunityIcons } from '@expo/vector-icons'
import MaskedView from '@react-native-masked-view/masked-view'
import { ReactElement } from 'react'
import { Platform, StyleSheet, TextStyle, View } from 'react-native'
import { Text } from 'react-native-paper'

import { ParMedal } from '@/engine/par'

/**
 * Each medal's metal, top to bottom: a touch lighter at the top, a touch deeper at the bottom, no hard step. Jay, 2026-10-17: the
 * flat medal colors read as "poop brown" and dull silver and gold in light mode, so he asked for a sheen; a polished-chrome version
 * (a pale highlight and a hard horizon just below the middle) read as old-school WordArt and cut the trophy into two bands. The
 * same metals in both modes: the drop shadow under each glyph (SHADOW) is what keeps them readable on the light card.
 */
export const MEDAL_METALS: Record<ParMedal, string> = {
  bronze: 'linear-gradient(180deg, #F2B27C 0%, #DB8A4A 55%, #B96A2E 100%)',
  silver: 'linear-gradient(180deg, #F4F7FA 0%, #CAD3DD 55%, #A2AEBB 100%)',
  gold: 'linear-gradient(180deg, #FFE27A 0%, #F2BE2E 55%, #D69A12 100%)'
}

/** A copy of each glyph this far below it, in this color: the stamped edge that keeps a bright metal readable on a light card. */
const SHADOW_OFFSET = 2
const SHADOW = 'rgba(0, 0, 0, 0.45)'

// DialogHeader's own sizes (@tastic/hud), so this header sits exactly where every other dialog's does.
const ICON_SIZE = 64
const COMPACT_ICON_SIZE = 32

/** Hidden from screen readers: the copies of a glyph that only draw it (the header carries the label). */
const DECORATIVE = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const

/**
 * One glyph (`render` draws it with the style it is handed) filled with `metal`, over its drop shadow. Native masks a gradient
 * View with the glyph (MaskedView, the pair auto-paper's FadingScrollView uses); the web has no masked view (its MaskedView only
 * draws the mask), so there the glyph clips a CSS gradient to its own letters (background-clip: text).
 */
function MetalGlyph({ metal, render }: { metal: string; render: (style: TextStyle) => ReactElement }) {
  const shadow = <View style={styles.shadow}>{render({ color: SHADOW })}</View>
  if (Platform.OS === 'web') {
    const clipped = { color: 'transparent', backgroundImage: metal, backgroundClip: 'text', WebkitBackgroundClip: 'text' } as TextStyle
    return (
      <View {...DECORATIVE}>
        {shadow}
        {render(clipped)}
      </View>
    )
  }
  return (
    <View {...DECORATIVE}>
      {shadow}
      <MaskedView maskElement={render({ color: '#000' })}>
        {/* Sizes the masked view to the glyph; the gradient fills it and the mask cuts it to the glyph's shape. */}
        {render({ opacity: 0 })}
        <View style={[StyleSheet.absoluteFill, { experimental_backgroundImage: metal }]} />
      </MaskedView>
    </View>
  )
}

/**
 * The win card's header: hud's DialogHeader (the trophy over the title, side by side when `compact`), with both in the metal of
 * the medal the score earned (parMedal) instead of a flat color. DialogHeader takes one flat color for both, so this draws the
 * same layout itself.
 */
export function MedalHeader({ medal, title, compact }: { medal: ParMedal; title: string; compact: boolean }) {
  const metal = MEDAL_METALS[medal]
  const iconSize = compact ? COMPACT_ICON_SIZE : ICON_SIZE
  return (
    <View style={compact ? styles.compact : styles.full} accessible accessibilityRole='header' accessibilityLabel={title} testID={`medal-header-${medal}`}>
      <MetalGlyph metal={metal} render={(style) => <MaterialCommunityIcons name='trophy' size={iconSize} style={[{ lineHeight: iconSize }, style]} />} />
      <View style={compact && styles.titleCompact}>
        <MetalGlyph
          metal={metal}
          render={(style) => (
            <Text variant={compact ? 'headlineSmall' : 'headlineLarge'} style={[styles.title, style]}>
              {title}
            </Text>
          )}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  compact: {
    alignItems: 'center',
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center'
  },
  full: {
    alignItems: 'center',
    alignSelf: 'stretch',
    gap: 16
  },
  shadow: {
    left: 0,
    position: 'absolute',
    right: 0,
    top: SHADOW_OFFSET
  },
  // textAlign matters once a title wraps (DialogHeader's own note).
  title: {
    fontWeight: 'bold',
    textAlign: 'center'
  },
  titleCompact: {
    flexShrink: 1
  }
})
