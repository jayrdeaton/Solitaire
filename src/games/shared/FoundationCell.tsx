import { useEffect, useRef } from 'react'
import { StyleSheet, View } from 'react-native'

import { useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { FoundationSlot, PlayingCard } from '@/components/PlayingCard'
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden'
import { Card, Rank, Suit } from '@/engine/types'

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
interface FoundationCellProps {
  card: Card | undefined
  isFlyingHere: boolean
  suit: Suit
  /** Passed straight through to FoundationSlot's own empty-hint rank - see its doc comment
   * (defaults to Ace; only Canfield ever passes something else). */
  rank?: Rank
  /** Highlight this cell as the Hint feature's suggested source/destination - see PlayingCard's
   * own `hinted` prop. */
  highlighted?: boolean
  slotRef?: (el: View | null) => void
  /** What to show under the incoming ghost(s) while `isFlyingHere`: the top card that has already
   * LANDED (`null` = the empty slot). Omit it (every game but FreeCell's finish) to use the frozen
   * copy of whatever was on top before the flight began, which is right for one flight at a time
   * but goes stale once flights to the same pile OVERLAP: `isFlyingHere` never drops in between, so
   * the frozen copy is never refreshed and every ghost that lands vanishes onto a pile still
   * showing the card from before the whole stream. The caller derives it from the pile and how
   * many of its cards are still in the air: `pile[pile.length - 1 - flightsInAir] ?? null`. */
  settledCard?: Card | null
}

export function FoundationCell({ card, isFlyingHere, suit, rank, highlighted, slotRef, settledCard }: FoundationCellProps) {
  const ghost = useDragGhost()
  const viewRef = useRef<View>(null)
  const frozenCopy = useFrozenWhileHidden(card, isFlyingHere)
  const frozen = settledCard === undefined ? frozenCopy : settledCard

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
      {card ? <PlayingCard card={card} hinted={highlighted} style={isFlyingHere && HIDDEN_CARD_STYLE} /> : <FoundationSlot suit={suit} rank={rank} hinted={highlighted} />}
      {isFlyingHere && (
        <View style={StyleSheet.absoluteFill} pointerEvents='none'>
          {frozen ? <PlayingCard card={frozen} /> : <FoundationSlot suit={suit} rank={rank} />}
        </View>
      )}
    </View>
  )
}
