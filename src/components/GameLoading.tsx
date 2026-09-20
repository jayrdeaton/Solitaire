import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { cancelAnimation, Easing, SharedValue, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated'

// The four suits, in the order the wave sweeps across them.
const SUITS = ['♠', '♥', '♦', '♣']
// A suit at rest between pulses - dim, not gone, so the row always reads as four things.
const SUIT_REST_OPACITY = 0.25
// One suit's rest -> lit half-cycle (withRepeat reverses it, so a full pulse is twice this), and how
// much later each next suit starts than the one before it. Shorter than one half-cycle, so the next
// suit lights while the previous is still mid-pulse - a continuous sweep rather than a take-turns blink.
const SUIT_PULSE_MS = 420
const SUIT_STAGGER_MS = 140
// Nothing is shown for this long, then the row fades in over REVEAL_FADE_MS. Every load this stands in
// for is one AsyncStorage round trip (a game's saved-board read, which `preloadGameInProgress` already
// starts on finger-down; the stats read) - normally a few dozen ms - so an indicator shown at once would
// just be a flash of text/motion that's gone before it reads. Held back, the common case is simply the
// felt (which the board that replaces it also paints), and the indicator only appears if the wait is
// genuinely long enough to warrant one.
const REVEAL_DELAY_MS = 250
const REVEAL_FADE_MS = 200

/** One suit's looping pulse, phase-shifted by its position in the row (see SUIT_STAGGER_MS) so the
 * four together make a wave. Reversing repeat with no end (`-1`) - the owner cancels it on unmount. */
function startSuitPulse(opacity: SharedValue<number>, index: number) {
  opacity.value = withDelay(index * SUIT_STAGGER_MS, withRepeat(withTiming(1, { duration: SUIT_PULSE_MS, easing: Easing.inOut(Easing.quad) }), -1, true))
}

/** The row's fade-in once REVEAL_DELAY_MS has passed - see there. */
function startReveal(opacity: SharedValue<number>) {
  opacity.value = withDelay(REVEAL_DELAY_MS, withTiming(1, { duration: REVEAL_FADE_MS }))
}

function Suit({ glyph, index }: { glyph: string; index: number }) {
  const opacity = useSharedValue(SUIT_REST_OPACITY)
  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }))
  useEffect(() => {
    startSuitPulse(opacity, index)
    return () => cancelAnimation(opacity)
  }, [opacity, index])
  return (
    <Animated.Text allowFontScaling={false} style={[styles.suit, animatedStyle]}>
      {glyph}
    </Animated.Text>
  )
}

/** The app's one loading indicator: four suit symbols pulsing in a wave. Cheap on purpose - five shared
 * values and a handful of native views, every animated property being opacity, so it runs entirely on the
 * UI thread and costs the (busy) JS thread nothing while it waits. Sized by its content, so the caller
 * places it (GameLoading centers it on the felt; a screen that is already laid out can drop it inline).
 * Fades in after REVEAL_DELAY_MS rather than showing at once - see there. */
export function LoadingIndicator() {
  const reveal = useSharedValue(0)
  const revealStyle = useAnimatedStyle(() => ({ opacity: reveal.value }))
  useEffect(() => {
    startReveal(reveal)
    return () => cancelAnimation(reveal)
  }, [reveal])
  return (
    // One accessible element, so a screen reader announces "Loading" rather than four suit names.
    <Animated.View accessible accessibilityRole='progressbar' accessibilityLabel='Loading' style={[styles.row, revealStyle]}>
      {SUITS.map((glyph, index) => (
        <Suit key={glyph} glyph={glyph} index={index} />
      ))}
    </Animated.View>
  )
}

/** The full-screen loading state every game screen returns while it waits on its saved-board read
 * (`if (!state) return <GameLoading />`): the indicator dead center both ways, over the app-wide felt
 * (TableBackground, mounted once behind the whole Stack - so this needs no background of its own, and
 * the felt doesn't change when the board replaces it). Fills whatever it's rendered in, so it sits
 * inside the rotated frame (see RotatedGameView) and centers within it at any angle. */
export function GameLoading() {
  return (
    <View style={styles.screen}>
      <LoadingIndicator />
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 16
  },
  screen: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center'
  },
  suit: {
    color: '#fff',
    fontSize: 30
  }
})
