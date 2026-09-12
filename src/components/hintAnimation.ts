import { cancelAnimation, Easing, SharedValue, withRepeat, withTiming } from 'react-native-reanimated'

/** A slow, continuous opacity pulse - the visual cue for "the hint feature is pointing at this
 * card/slot" (see PlayingCard's own `hinted` prop), so a hint reads as "look here" rather than a
 * static highlight easy to miss against a busy board. Distinct from shakeAnimation's one-shot
 * wiggle - this loops for as long as the hint stays active, so it's start/stop rather than
 * fire-and-forget. */
export function startHintPulse(opacity: SharedValue<number>) {
  opacity.value = withRepeat(withTiming(0.35, { duration: 550, easing: Easing.inOut(Easing.quad) }), -1, true)
}

export function stopHintPulse(opacity: SharedValue<number>) {
  cancelAnimation(opacity)
  opacity.value = withTiming(1, { duration: 150 })
}
