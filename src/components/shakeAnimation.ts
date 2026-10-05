import { useEffect, useRef } from 'react'
import { SharedValue, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated'

/** A quick left-right wiggle, settling back to 0 - the visual cue for "that tap registered, but
 * this card has nowhere legal to go" (see each screen's handleCardTap/handlePressCard), so tapping
 * a stuck card doesn't read as an unresponsive dead press. Shared by PileView's tableau cards and
 * DraggableCard's single-card slots (freecell/foundation/waste) so both shake identically. */
export function playShake(shakeX: SharedValue<number>) {
  shakeX.value = withSequence(withTiming(-8, { duration: 50 }), withTiming(8, { duration: 50 }), withTiming(-6, { duration: 50 }), withTiming(6, { duration: 50 }), withTiming(0, { duration: 50 }))
}

/**
 * A card's shake transform, played whenever `shakeToken` turns into a token this card has not played yet.
 *
 * Most screens keep their last `shake` ({ cardId, count, token }) for good (only Pyramid and TriPeaks clear it, on New
 * Game/restore), so the token
 * of the last card that was shaken keeps reaching that card. A card must therefore play a token once, not every time
 * the prop is truthy: a card is remounted when it lands after a move (PileView swaps a FlyingCardSlot for the real
 * card), after an undo, or in the next deal (card ids are reused), and it used to shake again then - right after it
 * landed, the "stutters at the end" of a move. A shake is only ever set off by tapping a card that is already shown, so
 * the token a card arrives with - mounted, or shown by a reused slot (the waste top, Canfield's reserve: one
 * DraggableCard showing whichever card is on top) - is one it has already played; so is one that comes back after the
 * card was out of the shake's range for a while (a run card back under the shaken card). Hence the record is per CARD
 * (`cardId`), re-seeded without playing whenever the instance starts showing a different card.
 */
export function useShakeStyle(shakeToken: number | undefined, cardId: string) {
  const shakeX = useSharedValue(0)
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shakeX.value }] }))
  const playedRef = useRef({ cardId, token: shakeToken })
  useEffect(() => {
    const played = playedRef.current
    if (played.cardId !== cardId) {
      playedRef.current = { cardId, token: shakeToken }
      return
    }
    if (!shakeToken || shakeToken === played.token) return
    playedRef.current = { cardId, token: shakeToken }
    playShake(shakeX)
  }, [shakeToken, cardId, shakeX])
  return shakeStyle
}
