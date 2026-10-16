import { getContrastColor } from '@rific/auto-paper'
import { CARD_FONT_FAMILY, DecoratedCardBack, type TableColors } from '@tastic/cards'
import React from 'react'
import { StyleSheet, View, ViewStyle } from 'react-native'
import Svg, { Text as SvgText } from 'react-native-svg'

// The Monogram back (Jay, 2026-10-16): the selected player's tag, or S, as big as it fits, on the Plain
// back (its double-line border, Jay's pick). The Plain back is @tastic/cards' own DecoratedCardBack,
// drawn as is, and the monogram is a second Svg laid over it: the package doesn't take children or
// export the art.

// The widest and tallest the monogram's letters may be, as fractions of the card's width. The Plain
// back's inner line encloses 0.647W x 1.104W (backs.ts' innermost rect: 0.177W to 0.824W across), so
// this leaves ~0.06W of back either side of the widest tag.
const MAX_INK_WIDTH = 0.52
const MAX_CAP_HEIGHT = 0.6

// DejaVu Serif Bold (the card font, CARD_FONT_FAMILY) metrics in ems, measured from the bundled TTF
// (node_modules/dejavu-fonts-ttf/ttf/DejaVuSerif-Bold.ttf) with fontTools, so a tag is sized to fill the
// back exactly (a lone S is set at ~0.72W, MMM still fits inside the inner line). A character missing here gets the table's mean.
const CAP_HEIGHT_EM = 0.729
const ADVANCE_EM: Record<string, number> = {
  A: 0.776,
  B: 0.845,
  C: 0.796,
  D: 0.867,
  E: 0.762,
  F: 0.71,
  G: 0.854,
  H: 0.945,
  I: 0.468,
  J: 0.473,
  K: 0.869,
  L: 0.703,
  M: 1.107,
  N: 0.914,
  O: 0.871,
  P: 0.752,
  Q: 0.871,
  R: 0.831,
  S: 0.722,
  T: 0.744,
  U: 0.872,
  V: 0.776,
  W: 1.123,
  X: 0.776,
  Y: 0.714,
  Z: 0.73
}
const DIGIT_ADVANCE_EM = 0.696
const FALLBACK_ADVANCE_EM = 0.773

// An emoji is one roughly square glyph in its own colors, a little see-through so it reads as part of the
// card rather than a sticker on it, and centred by the baseline @tastic/cards measured for CardBack's tag.
const EMOJI_PRESENT = /\p{Extended_Pictographic}/u
const EMOJI_SIZE = 0.52
const EMOJI_OPACITY = 0.6
const EMOJI_BASELINE_FRACTION = 0.36

function advanceEm(char: string): number {
  if (char >= '0' && char <= '9') return DIGIT_ADVANCE_EM
  return ADVANCE_EM[char] ?? FALLBACK_ADVANCE_EM
}

/** The font size (in the card's units) that makes `letters` as big as the back allows. */
export function monogramFontSize(letters: string, width: number): number {
  const ems = Array.from(letters).reduce((sum, char) => sum + advanceEm(char), 0)
  return width * Math.min(MAX_INK_WIDTH / Math.max(ems, 1e-6), MAX_CAP_HEIGHT / CAP_HEIGHT_EM)
}

interface MonogramCardBackProps {
  colors: TableColors
  width: number
  height: number
  /** What goes on the back: letters (drawn in capitals) or one emoji. */
  monogram: string
  /** Dark mode only: the Plain back's rim goes near-black with a white edge, as on every back. */
  invertDarkModeColors?: boolean
}

/** Memoized like CardBack: `colors`/`width`/`height` are stable, and a board can show dozens of backs. */
export const MonogramCardBack = React.memo(function MonogramCardBack({ colors, width, height, monogram, invertDarkModeColors }: MonogramCardBackProps) {
  const isEmoji = EMOJI_PRESENT.test(monogram)
  const fontSize = isEmoji ? width * EMOJI_SIZE : monogramFontSize(monogram.toUpperCase(), width)
  // A letter's capitals are centred on the card (its cap height straddles the middle); an emoji's whole glyph is.
  const baseline = height / 2 + fontSize * (isEmoji ? EMOJI_BASELINE_FRACTION : CAP_HEIGHT_EM / 2)

  return (
    // Sized, so the overlay (only absolute children) never lays out as a zero frame: see CLAUDE.md's
    // Fabric view-recycling note.
    <View style={{ width, height }}>
      <DecoratedCardBack style='plain' colors={colors} width={width} height={height} invertDarkModeColors={invertDarkModeColors} />
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={styles.overlay}>
        {isEmoji ? (
          <SvgText x={width / 2} y={baseline} fontSize={fontSize} opacity={EMOJI_OPACITY} textAnchor='middle'>
            {monogram}
          </SvgText>
        ) : (
          <SvgText x={width / 2} y={baseline} fill={getContrastColor(colors.cardBack)} fontFamily={CARD_FONT_FAMILY} fontWeight='bold' fontSize={fontSize} textAnchor='middle'>
            {monogram.toUpperCase()}
          </SvgText>
        )}
      </Svg>
    </View>
  )
})

// Laid over the Plain back, and not text-selectable on web (react-native-web draws a real <svg>); see
// @tastic/cards' CardBack for why `userSelect` needs its own type.
const overlayStyle: ViewStyle & { userSelect?: 'none' } = { left: 0, position: 'absolute', top: 0, userSelect: 'none' }

const styles = StyleSheet.create({
  overlay: overlayStyle
})
