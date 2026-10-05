import { useLayoutEffect, useState } from 'react'

import { Card } from '@/engine/types'

import { isGhostPending, REVEAL_MAX_MS, useGhostPendingAmong, whenFacesPainted } from './cardFacePaint'

const NO_IDS: readonly string[] = []

export interface TakeOffHoldState<C extends Card> {
  /** The card to draw: the pile's card, or the departing one while `holding`. */
  shown: C | null | undefined
  /** `shown` has already left (its ghost is not on screen yet): draw it inert - no tap, no drag, no hint, no shake. (The
   * stock alone still takes a tap while it has cards: every back looks the same, so the next draw sends a card nobody
   * could tell apart from the held one - see StockWaste.) */
  holding: boolean
  /** A hold has just ended and the slot switched to the card under it, whose face is not painted yet: keep the real card
   * hidden and show the pile's overlay (already painted, showing that same card) instead. */
  revealing: boolean
}

interface HoldRecord<C extends Card> {
  /** The card drawn last (state, so a departing card can be kept after `card` has moved on). */
  shown: C | null | undefined
  /** `shown` is being held - so the render that lets it go knows a hold ended there. */
  held: boolean
  /** The card the slot switched to when a hold ended, until its face has painted (see `revealing`). */
  revealId: string | null
}

/**
 * The card a single-card pile (waste top, foundation, freecell, reserve, discard, a Pyramid/TriPeaks cell) should draw:
 * `card`, except while the card it drew last has just LEFT and that card's ghost is not on screen yet - then the departing
 * card, so the very same (already painted) Image stays put until the ghost takes over (cardFacePaint.ts's ghost pending).
 * Without it the pile switched to the next card, or its empty slot, in the commit the move started, under a ghost that
 * was still a blank Image - the take-off flash. `holding` is true for that moment: draw the held card inert (no drag, no
 * hint, no shake). A card that changes for any other reason (one landing here, an undo, a new deal) is followed at once.
 *
 * When the hold ends and the pile still has a card (the waste's next card, the foundation card under an undone one), the
 * slot's one face Image is RE-SOURCED from the departed card to that one, and on iOS a re-sourced Image keeps showing its
 * previous bitmap until the new one arrives (RCTImageComponentView only replaces it in didReceiveImage) - so the departed
 * card would be drawn at its source for a frame or two again, right beside its now visible ghost. `revealing` covers that
 * moment: from the commit the hold ends until the new card's face reports painted (whenFacesPainted, at most
 * REVEAL_MAX_MS), the slot keeps its real card hidden and makes its PileOverlay visible instead - the overlay has shown
 * the pile's current card (invisibly) since the move's own commit, so its bitmap has had the whole hold to arrive. The
 * wait is armed from a layout effect of the commit that re-sources the card, after the face's own layout effect (a child)
 * has reported it loading. A hold that ends on an empty pile needs no reveal (the empty slot is drawn at once), and a
 * card that changes again ends the reveal.
 *
 * Known residual, accepted: a card that takes off AGAIN before its reveal has ended (an auto-play 96ms behind the move
 * that uncovered it, or a quick tap on it) ends the reveal and is held by the real card, whose Image may still show the
 * bitmap of the card before it until its own load arrives. That needs a load slower than the gap between the two
 * take-offs - a reveal lasts a frame or two unless loads are slow, as in a Metro-served dev build, which serves assets
 * uncached - and it is no worse than before the reveal existed. Holding it through the overlay instead (the painted
 * copy of that card) was considered and not done: the overlay would then have to stay on the held card for the whole
 * hold and be re-sourced to the next card only when it ends, so the reveal at that hold's end would have no copy that
 * had loaded in the meantime - the departing card's stale bitmap drawn beside its just-shown ghost for a whole load,
 * instead of the remainder of a load that started at the previous reveal. As it is, the overlay follows the pile's card
 * from the take-off on, so that next reveal still has the hold's length of head start. Doing better needs the real card
 * and the overlay to report their loads apart (cardFacePaint.ts tracks faces by card id).
 */
export function useTakeOffHold<C extends Card>(card: C | null | undefined): TakeOffHoldState<C> {
  const [record, setRecord] = useState<HoldRecord<C>>(() => ({ shown: card, held: false, revealId: null }))
  const leavingId = record.shown && record.shown.id !== card?.id ? record.shown.id : null
  // Subscribed so this re-renders the moment the departing card's ghost shows (or goes).
  useGhostPendingAmong(leavingId ? [leavingId] : NO_IDS)
  const holding = !!leavingId && isGhostPending(leavingId)
  let next = record
  if (holding) {
    if (!record.held) next = { shown: record.shown, held: true, revealId: null }
  } else {
    // Following `card` again. The render a hold ends in re-sources the slot to `card` (a different card - the hold was of
    // one that left), so that card is revealed; a reveal already running survives a re-render only for its own card.
    const revealId = record.held && card && card.id !== record.shown?.id ? card.id : record.revealId === card?.id ? record.revealId : null
    if (record.shown !== card || record.held || record.revealId !== revealId) next = { shown: card, held: false, revealId }
  }
  if (next !== record) setRecord(next)
  useLayoutEffect(() => {
    const id = record.revealId
    if (id === null) return
    return whenFacesPainted([id], REVEAL_MAX_MS, () => setRecord((r) => (r.revealId === id ? { ...r, revealId: null } : r)))
  }, [record.revealId])
  return { shown: holding ? record.shown : card, holding, revealing: next.revealId !== null }
}
