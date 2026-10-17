import { faceUpFanOffset } from '@tastic/cards'

import type { DragFlightHandle, DragGhostController } from '@/components/dragdrop/DragGhostLayer'
import { FLIGHT_SPRING, springSettleMs } from '@/components/dragdrop/dragSpring'
import { PileRef } from '@/engine/gameTypes'
import { Card } from '@/engine/types'

/**
 * A tapped tableau run can reach into cards still flying in to its column: a quick tap right after a move put them there (Jay's
 * Yukon recording, 2026-10-16: a run tapped onto the 9C, then the QH above that 9C tapped before the run had landed). Those cards
 * are not on the board to lift. They are in the air, in that move's ghost. Lifting the whole run from the column drew them twice
 * (the old ghost landing them, the new one carrying them off), and the column's landing count, still waiting for them, hid every
 * card left in it (the face-down cards, the card just turned up) until the old flight landed.
 *
 * So such a run takes off in pieces: its cards on the board in a ghost of their own, as every tap does, and its cards in the air
 * taken out of the flights carrying them (DragGhostController.peel), turning toward the new destination from wherever they are,
 * as a held Undo's cards do. When they can't be taken out of the air yet (a flight whose ghost isn't on screen yet, a drag's drop
 * still settling), the tap waits for them to land first.
 *
 * A drag never picks up such a run (PileView's `liftable`): its ghost follows the finger, with nothing to hand the cards in the air to.
 */

/** How long a tap waits for cards still flying in to its run to land, when they can't be taken out of the air: two flights. */
export const RUN_LANDING_WAIT_MS = 2 * springSettleMs(FLIGHT_SPRING)

const POLL_MS = 16

/** How many of the run's top cards are still flying in to `from`: only a tableau column's run can reach into them (anything else
 * moves its one top card, which a landing card hides). */
function runCardsInAir(from: PileRef, landingCount: (pile: PileRef) => number): number {
  return from.zone === 'tableau' ? landingCount(from) : 0
}

/** The fan step for a ghost of `count` cards: none for a single card. */
function ghostStep(count: number, offsetStep: number): number {
  return count > 1 ? offsetStep : 0
}

/**
 * The run's top `inAir` cards split into the pieces the flights still carrying them hold, bottom to top: [] when none of the run is
 * in the air, null when some of it can't be taken out of the air (see the file comment). Usually one piece: a second only when two
 * moves are landing on the column at once.
 */
export function inAirPieces(ghost: Pick<DragGhostController, 'canPeel'>, run: readonly Card[], inAir: number, offsetStep: number, cardWidth: number): Card[][] | null {
  if (inAir <= 0) return []
  // The tapped card itself still in the air: it can't be tapped (it is hidden until it lands), so nothing here to lift.
  if (inAir >= run.length) return null
  const start = run.length - inAir
  const pieces: Card[][] = []
  let end = run.length
  while (end > start) {
    // The top piece is the newest flight's: the longest stretch from the top that one flight still carries.
    let from = start
    while (from < end && !ghost.canPeel({ cards: run.slice(from, end), offsetStep: ghostStep(end - from, offsetStep), cardWidth })) from++
    if (from === end) return null
    pieces.unshift(run.slice(from, end))
    end = from
  }
  return pieces
}

/** Resolves true once `ready()` holds (checked now, then every frame), false if it still doesn't after `maxMs`. */
export async function whenReady(ready: () => boolean, maxMs = RUN_LANDING_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (!ready()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return true
}

export interface TappedRunTakeOff {
  /** The ghost of the run's cards on the board, shown where the tap measured the tapped card. */
  flight: DragFlightHandle
  /** The run's cards still in the air, bottom to top (inAirPieces) - for the caller's completeMove to send on (peelInAir). */
  inAir: Card[][]
}

/**
 * A tap's take-off, from the tap's own claim (startFlights) to its ghost: waits while part of the run is in the air and can't be taken
 * out of it, measures the tapped card, then shows the ghost of the run's cards on the board. Null when the tap should do nothing after
 * all (the board is gone, `cancelled` - an undo started meanwhile - or the wait ran out): the caller settles its claim.
 */
export async function liftTappedRun(opts: {
  ghost: Pick<DragGhostController, 'show' | 'canPeel'>
  from: PileRef
  count: number
  measure: () => Promise<{ x: number; y: number }>
  /** The source pile as the board has it now (read through stateRef, never a render closure: this runs across awaits). */
  pile: () => Card[] | null
  landingCount: (pile: PileRef) => number
  cancelled: () => boolean
  cardWidth: number
}): Promise<TappedRunTakeOff | null> {
  const { ghost, from, count, cardWidth } = opts
  const offsetStep = count > 1 ? faceUpFanOffset(cardWidth) : 0
  function pieces(): Card[][] | null {
    const pile = opts.pile()
    // A board that moved on is left to the caller's applyMove, which refuses a move whose tapped card is no longer at the head of it.
    if (!pile || pile.length < count) return []
    return inAirPieces(ghost, pile.slice(pile.length - count), runCardsInAir(from, opts.landingCount), offsetStep, cardWidth)
  }
  if (!(await whenReady(() => pieces() !== null))) return null
  const origin = await opts.measure()
  const pile = opts.pile()
  const inAir = pieces()
  if (!pile || !inAir || opts.cancelled()) return null
  const run = pile.slice(Math.max(0, pile.length - count))
  const onBoard = run.slice(0, run.length - inAir.reduce((n, piece) => n + piece.length, 0))
  const flight = ghost.show({ cards: onBoard, offsetStep: ghostStep(onBoard.length, offsetStep), cardWidth }, { x: origin.x, y: origin.y })
  return { flight, inAir }
}

/** A piece of a run in the air, taken out of the flight carrying it: its own flight, the card its landing is measured by (its
 * bottom card) and how many cards it carries. */
export interface PeeledPiece {
  flight: DragFlightHandle
  anchorCardId: string
  count: number
}

/**
 * Takes each piece out of the flight carrying it. Only once the move sending them on has committed (a card taken out of the air
 * doesn't go back), in the same synchronous stretch as the take-off found them (liftTappedRun, no await since), and after the ghost of
 * the run's cards on the board: the pieces are taken bottom to top, so with that ghost first they start - and, every flight taking the
 * same time, land - in stacking order, which the destination's landing count (hiding its top cards until they land) relies on. The
 * caller takes them out of their old column's landing count (useFlightConcurrency's shrinkLanding) and flies each to its anchor card.
 */
export function peelInAir(ghost: Pick<DragGhostController, 'peel'>, pieces: readonly (readonly Card[])[], cardWidth: number): PeeledPiece[] {
  return pieces.flatMap((cards) => {
    const flight = ghost.peel({ cards: [...cards], offsetStep: ghostStep(cards.length, faceUpFanOffset(cardWidth)), cardWidth })
    return flight ? [{ flight, anchorCardId: cards[0].id, count: cards.length }] : []
  })
}
