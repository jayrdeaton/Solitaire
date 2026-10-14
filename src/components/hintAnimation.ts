import { Easing, SharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated'

/** A slow, continuous opacity breath (the ring and its glow brighten and dim) - the visual cue for
 * "the hint feature is pointing at this card" (see PlayingCard's own `hinted` prop), so a hint reads as "look here" rather than a
 * static highlight easy to miss against a busy board. Distinct from shakeAnimation's one-shot
 * wiggle - this loops for as long as the hint stays active, so the owner (PlayingCard's HintRing,
 * mounted only while hinted) cancels it on unmount rather than it being fire-and-forget. */
export function startHintPulse(opacity: SharedValue<number>) {
  opacity.value = withRepeat(withTiming(0.4, { duration: 1100, easing: Easing.inOut(Easing.quad) }), -1, true)
}

/** The hint glide's whole motion (see hinting/HintGlideLayer.tsx): fade the copy in, glide it to `to`, hold a beat, fade
 * it out. Fire-and-forget: the layer unmounts the copy on its own timer once it has faded. */
export function startHintGlide(x: SharedValue<number>, y: SharedValue<number>, opacity: SharedValue<number>, to: { x: number; y: number }, timing: { opacity: number; fadeInMs: number; glideMs: number; holdMs: number; fadeOutMs: number }) {
  const ease = { duration: timing.glideMs, easing: Easing.inOut(Easing.cubic) }
  opacity.value = withSequence(withTiming(timing.opacity, { duration: timing.fadeInMs }), withDelay(timing.glideMs + timing.holdMs, withTiming(0, { duration: timing.fadeOutMs })))
  x.value = withDelay(timing.fadeInMs, withTiming(to.x, ease))
  y.value = withDelay(timing.fadeInMs, withTiming(to.y, ease))
}
