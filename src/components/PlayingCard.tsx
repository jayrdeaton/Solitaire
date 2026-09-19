import { Pressable } from '@rific/feedback-press'
import { CardBack, CardFace, DecoratedCardBack, type TableColors, useCardSize } from '@tastic/cards'
import React from 'react'
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'

import { Card, Rank, Suit } from '@/engine/types'
import { useProfiles } from '@/stores/profiles'
import { useSettings } from '@/stores/settings'

import { startHintPulse, stopHintPulse } from './hintAnimation'
import { CARD_RADIUS, cardRadiusForWidth, useTableColors } from './theme'

interface PlayingCardProps {
  card: Card
  /** Highlight this card as part of the current selection. */
  selected?: boolean
  /** Highlight this card as the Hint feature's suggested source/destination - a pulsing ring in
   * `colors.hintGreen`, distinct from `selected`'s static gold ring since Pyramid already uses
   * `selected` for its own real tap-to-pair-selection state. */
  hinted?: boolean
  /** Disable pressing (e.g. cards buried under others). */
  disabled?: boolean
  /** Not yet playable (e.g. a buried Pyramid card) - draws a translucent scrim on top of the
   * still-full-opacity face instead of fading the card itself, so its rank/suit stay legible. */
  dimmed?: boolean
  onPress?: () => void
  style?: StyleProp<ViewStyle>
  testID?: string
}

// The border is drawn as an absolutely-positioned overlay rather than a Pressable borderWidth so
// that toggling `selected`/`hinted` (a thicker, different-colored border) never changes the box's
// content area - RN sizes borders inward from a fixed width/height, so swapping 1px for 3px would
// nudge the card's own SVG content by a couple pixels every time it's (de)selected/(un)hinted.
export function PlayingCard({ card, selected, hinted, disabled, dimmed, onPress, style, testID }: PlayingCardProps) {
  const colors = useTableColors()
  const { activeProfile } = useProfiles()
  const { settings } = useSettings()
  const { width, height } = useCardSize()
  const cardRadius = cardRadiusForWidth(width)
  const styles = React.useMemo(() => makeStyles(colors, settings.invertDarkModeColors, cardRadius), [colors, settings.invertDarkModeColors, cardRadius])
  const cardSize = { width, height }
  const hintOpacity = useSharedValue(1)
  const hintAnimatedStyle = useAnimatedStyle(() => ({ opacity: hintOpacity.value }))
  React.useEffect(() => {
    if (hinted) startHintPulse(hintOpacity)
    else stopHintPulse(hintOpacity)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hinted])
  const borderOverlay = selected ? <View pointerEvents='none' style={styles.selectedRing} /> : hinted ? <Animated.View pointerEvents='none' style={[styles.hintRing, hintAnimatedStyle]} /> : <View pointerEvents='none' style={styles.border} />
  const dimOverlay = dimmed ? <View pointerEvents='none' style={styles.dim} /> : null

  if (!card.faceUp) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        disabled={disabled || !onPress}
        // Cards have their own precise sound logic (fired the instant a move is confirmed rather
        // than when it lands, plus an explicit invalid sound on a rejected one - see
        // useCardSounds.ts/DragGhostLayer.tsx) - the provider's generic onPressIn "selection" blip
        // would otherwise ALSO fire the instant any card is touched, playing alongside (and ahead
        // of) that logic on every tap. Haptics are deliberately left untouched here - only sound
        // doubled up, since it's the only one of the two this app is wiring for the first time.
        soundDisabled
        style={[styles.card, styles.shadow, cardSize, style]}
      >
        <View style={[styles.clip, styles.back]}>
          {settings.cardBackStyle === 'geometric' ? <CardBack colors={colors} width={width} height={height} tag={activeProfile?.tag} invertDarkModeColors={settings.invertDarkModeColors} /> : <DecoratedCardBack style={settings.cardBackStyle} colors={colors} width={width} height={height} invertDarkModeColors={settings.invertDarkModeColors} />}
          <CardSheen />
        </View>
        {dimOverlay}
        {borderOverlay}
      </Pressable>
    )
  }

  return (
    <Pressable testID={testID} onPress={onPress} disabled={disabled} soundDisabled style={[styles.card, styles.shadow, cardSize, style]}>
      <View style={[styles.clip, styles.face]}>
        <CardFace card={card} colors={colors} width={width} height={height} cardStyle={settings.cardStyle} invertDarkModeColors={settings.invertDarkModeColors} />
        <CardSheen />
      </View>
      {dimOverlay}
      {borderOverlay}
    </Pressable>
  )
}

/** A faint diagonal gloss over the card's own flat face/back fill, like light catching glossy
 * cardstock - the same static gradient for every card regardless of suit/rank/colors (no props),
 * so it's one cheap shared element tree rather than something recomputed per card. Lives inside
 * `clip` (see both call sites above), which already clips its children to the card's own rounded
 * radius, so this doesn't need its own corner rounding. */
const CardSheen = React.memo(function CardSheen() {
  // Every card mounts its own CardSheen instance (dozens at once, on web literally the same real
  // DOM <svg> id-lookup semantics as any other document) - a shared literal id here would make
  // every card's fill="url(#...)" resolve to whichever instance's <Defs> happens to be first in
  // the document, silently working today only because every instance's gradient is byte-identical.
  const gradientId = React.useId()
  return (
    <Svg pointerEvents='none' style={StyleSheet.absoluteFill} width='100%' height='100%'>
      <Defs>
        <LinearGradient id={gradientId} x1='0%' y1='0%' x2='65%' y2='85%'>
          <Stop offset='0%' stopColor='#FFFFFF' stopOpacity={0.24} />
          <Stop offset='28%' stopColor='#FFFFFF' stopOpacity={0.07} />
          <Stop offset='50%' stopColor='#FFFFFF' stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width='100%' height='100%' fill={`url(#${gradientId})`} />
    </Svg>
  )
})

export function EmptySlot({ onPress, hinted, style, children, testID }: { onPress?: () => void; hinted?: boolean; style?: StyleProp<ViewStyle>; children?: React.ReactNode; testID?: string }) {
  const colors = useTableColors()
  const { width, height } = useCardSize()
  const styles = React.useMemo(() => makeStyles(colors), [colors])
  return (
    // disabled when there's nothing to press - otherwise this Pressable still claims the tap (just
    // does nothing with it), silently blocking taps meant for whatever's behind it (e.g. GameChrome's
    // table-tap-to-hide-footer catcher) from ever reaching them.
    <Pressable testID={testID} onPress={onPress} disabled={!onPress} soundDisabled style={[styles.card, { width, height }, hinted ? styles.emptyHinted : styles.empty, style]}>
      {children}
    </Pressable>
  )
}

/** An empty foundation slot, ghosted with the ace it's waiting for. Foundation piles are
 * suit-locked by position (see games/*\/rules.ts's `suitIndex`), but that lock was otherwise
 * invisible until a drop silently failed - this shows which suit belongs here up front. Uses
 * EmptySlot's own plain transparent/dashed styling unmodified - CardFace's `muted` rendering is
 * already just faint linework (see its own MUTED_OPACITY), so a tinted backdrop here would put a
 * card-shaped block back behind it, which is exactly what muted is meant to avoid. */
interface FoundationSlotProps {
  suit: Suit
  /** The rank an empty foundation actually needs first - defaults to Ace, true for every game
   * except Canfield, whose foundations start at a variable "Canfield rank" instead (see
   * CanfieldScreen.tsx, the only caller that ever passes something other than the default). */
  rank?: Rank
  onPress?: () => void
  /** Highlight this empty slot as the Hint feature's suggested destination - see PlayingCard's own
   * `hinted` prop. */
  hinted?: boolean
  style?: StyleProp<ViewStyle>
}

export function FoundationSlot({ suit, rank = 1, onPress, hinted, style }: FoundationSlotProps) {
  const colors = useTableColors()
  const { settings } = useSettings()
  const { width, height } = useCardSize()
  return (
    <EmptySlot onPress={onPress} hinted={hinted} style={style}>
      <CardFace card={{ id: 'foundation-hint', suit, rank, faceUp: true }} colors={colors} width={width} height={height} muted cardStyle={settings.cardStyle} invertDarkModeColors={settings.invertDarkModeColors} />
    </EmptySlot>
  )
}

function makeStyles(colors: TableColors, invertDarkModeColors?: boolean, radius: number = CARD_RADIUS) {
  return StyleSheet.create({
    back: {
      backgroundColor: colors.cardBack
    },
    border: {
      borderColor: colors.cardBorder,
      borderRadius: radius,
      borderWidth: 1,
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0
    },
    card: {
      borderRadius: radius
    },
    clip: {
      borderRadius: radius,
      bottom: 0,
      left: 0,
      overflow: 'hidden',
      position: 'absolute',
      right: 0,
      top: 0
    },
    dim: {
      backgroundColor: invertDarkModeColors ? colors.dimOverlayInverted : colors.dimOverlay,
      borderRadius: radius,
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0
    },
    empty: {
      alignItems: 'center',
      backgroundColor: 'transparent',
      borderColor: colors.emptySlot,
      borderStyle: 'dashed',
      borderWidth: 2,
      justifyContent: 'center'
    },
    emptyHinted: {
      alignItems: 'center',
      backgroundColor: 'transparent',
      borderColor: colors.hintGreen,
      borderStyle: 'dashed',
      borderWidth: 2,
      justifyContent: 'center'
    },
    face: {
      backgroundColor: colors.cardFace
    },
    hintRing: {
      borderColor: colors.hintGreen,
      borderRadius: radius,
      borderWidth: 3,
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0
    },
    selectedRing: {
      borderColor: colors.selectedGlow,
      borderRadius: radius,
      borderWidth: 3,
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0
    },
    // Shadow lives on the outer Pressable, never on the same node as `clip`'s overflow: 'hidden' -
    // iOS draws a view's shadow and its overflow clip on the same layer, so a masked layer clips
    // away its own shadow rather than just its content.
    shadow: {
      elevation: 4,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 3
    }
  })
}
