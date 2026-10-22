import { useCallback, useRef } from 'react'

/** A press on a card held at least this long, and released without the finger moving far enough to start a drag (the
 * card pans' minDistance), is the player picking the card up and putting it back, not a tap: it plays nothing. The same
 * 400ms a held Undo or Hint takes to start (GameChrome's HOLD_LONG_PRESS_MS). */
export const HOLD_CANCELS_TAP_MS = 400

/**
 * Tells a tap from a press held in place, for a card that plays itself on a tap (tap-to-move). A Pressable calls onPress
 * on release however long the finger was down, so a player who pressed a card meaning to drag it, held it while deciding,
 * then let go without moving, had it sent off to wherever tap-to-move chose (a coworker of Jay's in Spider, 2026-10-22:
 * "it auto-drops when I want to hold"). `onPressIn` goes on the card's Pressable; `wasHeld()` is asked once, at the
 * press, and forgets the press.
 */
export function useHoldGuard(): { onPressIn: () => void; wasHeld: () => boolean } {
  const pressedAtRef = useRef<number | null>(null)
  const onPressIn = useCallback(() => {
    pressedAtRef.current = Date.now()
  }, [])
  const wasHeld = useCallback(() => {
    const pressedAt = pressedAtRef.current
    pressedAtRef.current = null
    return pressedAt !== null && Date.now() - pressedAt >= HOLD_CANCELS_TAP_MS
  }, [])
  return { onPressIn, wasHeld }
}
