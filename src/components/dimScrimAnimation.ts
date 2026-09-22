import { SharedValue, withTiming } from 'react-native-reanimated'

/** How long the "not playable" scrim takes to fade in once a card that was held back (see PlayingCard's `dimHold`) is
 * revealed. Kept shorter than the ~270-400ms before the next card of a column lands on top and covers the card, so the
 * scrim has always finished by the time the card is no longer the one being looked at. */
export const DIM_FADE_MS = 160

/** Fades PlayingCard's dim scrim in across a hand-off from a flying ghost (which is never dimmed) to the real card it lands
 * on: the scrim mounts transparent (so the real card is pixel-identical to the ghost it replaces) and this ramps it to
 * fully dim instead of it popping on at the landing frame. Lives here rather than inline in the component's effect for the
 * same reason as startHintPulse - a direct `.value` write in a component body is flagged by react-hooks/immutability. */
export function fadeInDimScrim(opacity: SharedValue<number>) {
  opacity.value = withTiming(1, { duration: DIM_FADE_MS })
}
