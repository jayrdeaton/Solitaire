import { useEffect, useRef } from 'react'
import { View } from 'react-native'

import { DraggableCard } from '@/components/dragdrop/DraggableCard'
import { DragFlightHandle, useDragGhost } from '@/components/dragdrop/DragGhostLayer'
import { PileOverlay } from '@/components/PileOverlay'
import { FoundationSlot, PlayingCard } from '@/components/PlayingCard'
import { useFrozenWhileHidden } from '@/components/useFrozenWhileHidden'
import { useTakeOffHold } from '@/components/useTakeOffHold'
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
  /** Lets the player drag the top card off the pile (never tap it: a stray tap would undo progress) - Klondike, Yukon and
   * Canfield, whose foundation cards may come back down to the tableau. DraggableCard's onDrop contract: anchor the move on
   * `dragged`, not on the pile's top at drop time (a card auto-played here meanwhile would be moved instead). Omitted (FreeCell,
   * Forty Thieves, or a won board) the card can't be picked up. Turning it on or off never remounts the card: the top card
   * is always a DraggableCard, its drag merely disabled, since a remount is a fresh face Image, blank for a frame or two
   * (cardFacePaint.ts). Never offered while a card is landing here (the card under the finger would be one still in the
   * air) or while the slot still draws a card that has left (useTakeOffHold). */
  onDrop?: (absoluteX: number, absoluteY: number, flight: DragFlightHandle, dragged: Card) => Promise<boolean> | boolean
  /** The card under `card` in this pile (null: none), drawn in the slot while `card` is lifted - see DraggableCard's
   * underCard. Only matters with `onDrop`. */
  under?: Card | null
}

export function FoundationCell({ card, isFlyingHere, suit, rank, highlighted, slotRef, settledCard, onDrop, under }: FoundationCellProps) {
  const ghost = useDragGhost()
  const viewRef = useRef<View>(null)
  const frozenCopy = useFrozenWhileHidden(card, isFlyingHere)
  const frozen = settledCard === undefined ? frozenCopy : settledCard
  const underlay = isFlyingHere ? frozen : card
  // Take-off hold: keeps drawing a card that has just left while its ghost is not on screen yet (useTakeOffHold).
  const { shown, holding, revealing } = useTakeOffHold(card)
  // The overlay stands in for the real card while a flight is landing here (not over a held card: that is still the
  // painted copy of the card that just left, and must stay drawn until its ghost shows), and while the card an undo
  // uncovered is revealed (useTakeOffHold's `revealing`: the real card's Image has just been re-sourced from the departed
  // card and would show its stale bitmap; the overlay's has shown `card` since the undo's own commit).
  const overlayVisible = (isFlyingHere && !holding) || revealing

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
      {/* Registered by this cell (the pile's real top, `card`, above), never by the DraggableCard itself (registryId null).
      While the slot still draws a card that has left, the card under it is the pile's top. */}
      {shown ? <DraggableCard card={shown} hinted={highlighted && !holding} hidden={overlayVisible} disabled={holding} registryId={null} underCard={holding ? card : under} emptyFallback={<FoundationSlot suit={suit} rank={rank} />} onDrop={holding || isFlyingHere ? undefined : onDrop} /> : <FoundationSlot suit={suit} rank={rank} hinted={highlighted} />}
      {/* Mounted (invisible) whenever there is a card, not just while a flight is in the air: the copy that shows under an
      incoming ghost is then the card that was already on top, already painted, instead of a new Image that would show a
      blank face for a frame or two as the flight starts (see PileOverlay). */}
      {(isFlyingHere || card) && <PileOverlay visible={overlayVisible}>{underlay ? <PlayingCard card={underlay} disabled /> : <FoundationSlot suit={suit} rank={rank} />}</PileOverlay>}
    </View>
  )
}
