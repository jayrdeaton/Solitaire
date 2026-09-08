import { useEffect, useRef } from 'react'
import { StyleSheet, View } from 'react-native'

import { useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { FoundationSlot, PlayingCard } from '@/components/PlayingCard'
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden'
import { Card, Suit } from '@/engine/types'

// Plain (theme-independent) style - FoundationCell is a module-level component, so it can't reach
// its caller's own theme-derived `styles`.
export const HIDDEN_CARD_STYLE = { opacity: 0 }

/** One foundation pile's display. The real `card` stays mounted and registered in CardRegistry
 * the whole time (just invisible while `isFlyingHere`) - the tap-to-move flight measures its
 * destination by looking up exactly this registration, so hiding it by swapping it out entirely
 * (rather than by opacity) would leave the flight with nothing to measure and no real target to
 * land on. A frozen copy of whatever was on top before is shown instead while flying, so the slot
 * doesn't go blank for the whole flight - purely decorative, not itself registered.
 *
 * `slotRef`, separately, always points at this same outer container regardless of whether `card`
 * is hidden - the win cascade (see runWinCascade) needs to measure this slot's position AFTER the
 * real King has already been hidden (won-gated, see the caller), by which point it's no longer
 * CardRegistry-registered at all. */
export function FoundationCell({ card, isFlyingHere, suit, slotRef }: { card: Card | undefined; isFlyingHere: boolean; suit: Suit; slotRef?: (el: View | null) => void }) {
  const ghost = useDragGhost()
  const viewRef = useRef<View>(null)
  const frozen = useFrozenWhileHidden(card, isFlyingHere)

  useEffect(() => {
    if (!card) return
    const id = card.id
    ghost.cardRegistry.register(id, viewRef)
    return () => ghost.cardRegistry.unregister(id, viewRef)
  }, [card, ghost.cardRegistry])

  return (
    <View
      ref={(el) => {
        viewRef.current = el
        slotRef?.(el)
      }}
      collapsable={false}
    >
      {card ? <PlayingCard card={card} style={isFlyingHere && HIDDEN_CARD_STYLE} /> : <FoundationSlot suit={suit} />}
      {isFlyingHere && (
        <View style={StyleSheet.absoluteFill} pointerEvents='none'>
          {frozen ? <PlayingCard card={frozen} /> : <FoundationSlot suit={suit} />}
        </View>
      )}
    </View>
  )
}
