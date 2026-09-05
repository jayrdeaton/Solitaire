import { SharedValue, withSequence, withTiming } from 'react-native-reanimated';

/** A quick left-right wiggle, settling back to 0 - the visual cue for "that tap registered, but
 * this card has nowhere legal to go" (see each screen's handleCardTap/handlePressCard), so tapping
 * a stuck card doesn't read as an unresponsive dead press. Shared by PileView's tableau cards and
 * DraggableCard's single-card slots (freecell/foundation/waste) so both shake identically. */
export function playShake(shakeX: SharedValue<number>) {
  shakeX.value = withSequence(
    withTiming(-8, { duration: 50 }),
    withTiming(8, { duration: 50 }),
    withTiming(-6, { duration: 50 }),
    withTiming(6, { duration: 50 }),
    withTiming(0, { duration: 50 })
  );
}
