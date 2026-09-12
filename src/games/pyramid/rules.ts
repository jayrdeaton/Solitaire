// Pyramid solitaire game rules & controller.
//
// Board: 28 cards dealt face-up into a 7-row triangle (row 0 has 1 card,
// row 6 has 7), stored as a flat 28-length array. The card at (row, col)
// lives at flatIndex(row, col) = row*(row+1)/2 + col. Once removed, a slot
// is set to `null` (never spliced out) so the covering/exposure math below
// keeps working off stable indices.
//
// The remaining 24 cards are a face-down stock; draw-1 flips cards onto a
// face-up waste pile, exactly like Klondike's draw-1 mode.

import { shuffledDeck } from '@/engine/deck'
import { GameController, Move, PileRef } from '@/engine/gameTypes'
import { top } from '@/engine/pile'
import { Card } from '@/engine/types'

export interface PyramidState {
  /** Flat 28-slot triangle; `null` once that card has been removed. */
  pyramid: (Card | null)[]
  stock: Card[]
  waste: Card[]
  /** Every card ever removed via a pair or solo King, oldest first (array end = top, same
   * convention as stock/waste). Always face-up once here, regardless of its prior faceUp. Once the
   * pyramid is cleared, sweepRemainderOnWin also appends whatever was left in waste/stock, so a
   * won game's discard always holds all 52 cards. */
  discard: Card[]
  /** How many cards have been consumed via a pair or solo King, from either the pyramid or the
   * waste (NOT specifically pyramid cards - see isWon, which checks the triangle directly rather
   * than this counter, since a card can be consumed from waste too). Kept purely as a move-size
   * stat; nothing reads it to determine whether the game is won. */
  removedCount: number
}

const ROWS = 7
const TOTAL = 28 // 1+2+3+4+5+6+7

/** Flat array index for the card at (row, col), 0-indexed, col from 0..row. */
export function flatIndex(row: number, col: number): number {
  return (row * (row + 1)) / 2 + col
}

/** Inverse of flatIndex: which (row, col) a flat index corresponds to. */
export function rowColOf(index: number): { row: number; col: number } {
  let row = 0
  while (flatIndex(row + 1, 0) <= index) row++
  return { row, col: index - flatIndex(row, 0) }
}

/**
 * A pyramid card at (row, col) is exposed (removable) once the (up to) two
 * cards resting on it in the row below have both already been removed.
 * Row 6 (the bottom row) is always exposed if occupied.
 */
export function isExposed(pyramid: (Card | null)[], row: number, col: number): boolean {
  const idx = flatIndex(row, col)
  if (!pyramid[idx]) return false
  if (row === ROWS - 1) return true
  const childLeft = flatIndex(row + 1, col)
  const childRight = flatIndex(row + 1, col + 1)
  return !pyramid[childLeft] && !pyramid[childRight]
}

function isExposedAt(pyramid: (Card | null)[], index: number): boolean {
  const { row, col } = rowColOf(index)
  return isExposed(pyramid, row, col)
}

// Shallow: a fresh outer state object, but `pyramid`/`stock`/`waste`/`discard` all start out as
// the exact SAME array references as `state`'s own (mirroring Klondike's/Spider's stock/waste
// treatment - none of these four is an "array of piles" the way tableau/foundation are elsewhere,
// each is already a single flat pile, so there's no outer container to eagerly .slice()).
// consume/sweepRemainderOnWin/drawStock below each replace only the specific pile(s) they
// actually touch with a fresh array before mutating, and clone an individual card only at the
// spot its faceUp is actually flipped (or where it's genuinely moving into discard) - every
// pyramid/stock/waste card NOT touched by a given move keeps its exact pre-move object identity.
function cloneState(state: PyramidState): PyramidState {
  return {
    pyramid: state.pyramid,
    stock: state.stock,
    waste: state.waste,
    discard: state.discard,
    removedCount: state.removedCount
  }
}

function newGame(seed: number): PyramidState {
  const deck = shuffledDeck(seed, 1)
  const pyramid: (Card | null)[] = deck.slice(0, TOTAL).map((c) => ({ ...c, faceUp: true }))
  const stock: Card[] = deck.slice(TOTAL).map((c) => ({ ...c, faceUp: false }))
  return { pyramid, stock, waste: [], discard: [], removedCount: 0 }
}

export function cardAt(state: PyramidState, ref: PileRef): Card | null {
  if (ref.zone === 'pyramid') {
    return state.pyramid[ref.index] ?? null
  }
  if (ref.zone === 'waste') {
    return top(state.waste) ?? null
  }
  return null
}

/** True if `ref` currently points at a removable ("available") card: an
 * exposed pyramid card, or the top card of the waste pile. */
function isAvailable(state: PyramidState, ref: PileRef): boolean {
  if (ref.zone === 'waste') {
    return top(state.waste) !== undefined
  }
  if (ref.zone === 'pyramid') {
    const card = state.pyramid[ref.index]
    if (!card) return false
    return isExposedAt(state.pyramid, ref.index)
  }
  return false
}

/** Removes the card at `ref` (mutated onto `state`, which is always a fresh shallow-cloned state
 * the caller owns) and appends a face-up copy of it to discard - the source pile gets a fresh
 * array (so the pre-move state's pile, still sitting in the undo stack, is untouched), and only
 * the one card actually relocating gets a new object (its faceUp may be flipping); every other
 * card in every other pile keeps its exact pre-move reference. */
function consume(state: PyramidState, ref: PileRef): void {
  const card = cardAt(state, ref)
  if (ref.zone === 'pyramid') {
    const pyramid = state.pyramid.slice()
    pyramid[ref.index] = null
    state.pyramid = pyramid
  } else if (ref.zone === 'waste') {
    const waste = state.waste.slice()
    waste.pop()
    state.waste = waste
  }
  if (card) {
    const discard = state.discard.slice()
    discard.push({ ...card, faceUp: true })
    state.discard = discard
  }
}

/** Once the triangle itself is empty the game is won (see isWon) - sweeps every card still
 * sitting in waste/stock into discard so the win-cascade animation (see components/winning/) has
 * the full 52-card deck to chain through, not just whatever subset was ever exposed in the
 * pyramid. Order (waste-then-stock) doesn't matter gameplay-wise, only the animation's own
 * reverse-order read of `discard` at win time. No-op unless this exact move just emptied the last
 * pyramid slot. Does not touch removedCount - that still only reflects real pairing/King moves. */
function sweepRemainderOnWin(state: PyramidState): void {
  if (!state.pyramid.every((c) => c === null)) return
  if (state.waste.length === 0 && state.stock.length === 0) return
  // Every card still in waste/stock genuinely relocates to discard here (a full transfer, not a
  // touch-one-leave-the-rest move) - cloning all of them is correct, not the pattern being
  // eliminated elsewhere in this file.
  const discard = state.discard.slice()
  for (const c of state.waste) discard.push({ ...c, faceUp: true })
  for (const c of state.stock) discard.push({ ...c, faceUp: true })
  state.discard = discard
  state.waste = []
  state.stock = []
}

/**
 * Two move shapes are supported:
 *  - solo King: from === to, both {zone:'pyramid', index:i}, count 1.
 *  - pair summing to 13: from/to are two distinct available cards, each
 *    either {zone:'pyramid', index} or {zone:'waste', index:0}, count 1.
 */
function tryMove(state: PyramidState, move: Move): PyramidState | null {
  const { from, to, count } = move
  if (count !== 1) return null
  if (from.zone !== 'pyramid' && from.zone !== 'waste') return null
  if (to.zone !== 'pyramid' && to.zone !== 'waste') return null

  // Solo King case: `from` and `to` both point at the same available card (pyramid or waste -
  // both zones are already validated above), and it removes on its own since nothing sums to 13
  // with a King.
  if (from.zone === to.zone && from.index === to.index) {
    if (!isAvailable(state, from)) return null
    const card = cardAt(state, from)
    if (!card || card.rank !== 13) return null
    const next = cloneState(state)
    consume(next, from)
    next.removedCount += 1
    sweepRemainderOnWin(next)
    return next
  }

  if (!isAvailable(state, from) || !isAvailable(state, to)) return null

  const fromCard = cardAt(state, from)
  const toCard = cardAt(state, to)
  if (!fromCard || !toCard) return null
  if (fromCard.id === toCard.id) return null // same physical card, can't pair with itself
  if (fromCard.rank + toCard.rank !== 13) return null

  const next = cloneState(state)
  consume(next, from)
  consume(next, to)
  next.removedCount += 2
  sweepRemainderOnWin(next)
  return next
}

function drawStock(state: PyramidState): PyramidState | null {
  if (state.stock.length > 0) {
    const next = cloneState(state)
    const stock = next.stock.slice()
    const card = stock.pop()!
    const waste = next.waste.slice()
    waste.push(card.faceUp ? card : { ...card, faceUp: true })
    next.stock = stock
    next.waste = waste
    return next
  }
  if (state.waste.length > 0) {
    // Unlimited recycling: once stock is empty, flip waste back over face-down
    // (reversed, so re-drawing reproduces the same sequence). Real physical
    // Pyramid often limits redeals, but that can permanently strand a digital
    // game with no way to clear the pyramid, so we allow infinite recycling.
    // Every recycled card's faceUp genuinely flips here - unlike the draw above, there's no
    // untouched subset to preserve identity for; all of them really do change.
    const next = cloneState(state)
    const recycled = state.waste
      .slice()
      .reverse()
      .map((c) => ({ ...c, faceUp: false }))
    next.stock = recycled
    next.waste = []
    return next
  }
  return null
}

function isWon(state: PyramidState): boolean {
  return state.pyramid.every((c) => c === null)
}

function legalMoves(state: PyramidState): Move[] {
  const moves: Move[] = []
  const availableRefs: PileRef[] = []

  for (let i = 0; i < TOTAL; i++) {
    if (state.pyramid[i] && isExposedAt(state.pyramid, i)) {
      availableRefs.push({ zone: 'pyramid', index: i })
    }
  }
  if (top(state.waste)) {
    availableRefs.push({ zone: 'waste', index: 0 })
  }

  // Solo kings - available in either zone, since nothing sums to 13 with a King.
  for (const ref of availableRefs) {
    const card = cardAt(state, ref)
    if (card && card.rank === 13) {
      moves.push({ from: ref, to: ref, count: 1 })
    }
  }

  // Pairs summing to 13.
  for (let a = 0; a < availableRefs.length; a++) {
    for (let b = a + 1; b < availableRefs.length; b++) {
      const refA = availableRefs[a]
      const refB = availableRefs[b]
      const cardA = cardAt(state, refA)
      const cardB = cardAt(state, refB)
      if (cardA && cardB && cardA.rank + cardB.rank === 13) {
        moves.push({ from: refA, to: refB, count: 1 })
      }
    }
  }

  return moves
}

/**
 * Ranks legal moves by how many NEW pyramid cards they expose - cards that were still covered
 * before the move (one or both of their two covering children in the row below still present)
 * but become exposed once this move's pyramid-side card(s) are gone. Pyramid has no
 * run/reveal/empty-pile concept like the tableau games (see the Spider/Klondike/FreeCell
 * scorers) - unlocking more of the triangle for future pairing is the only lever available here,
 * so it's the entire signal. A pair's waste-side card (if any) never contributes: consuming the
 * waste can never change any pyramid card's exposure.
 *
 * Concretely, this matters because two cards can be simultaneously legal to remove (both already
 * exposed) while only one of them is also the LAST card blocking some card further up the
 * triangle - e.g. two siblings that are both children of the same still-covered parent, where
 * pairing them together instantly exposes that parent, versus some other equally-legal pair
 * elsewhere on the board that exposes nothing. Both are "fine" moves (removing any legal pair is
 * always genuine progress in Pyramid - unlike Spider, there's no way a legal removal here can be
 * actively counterproductive), so every move keeps a positive +1 baseline regardless of exposure;
 * this must never trigger findHint's "prefer a stock draw over every available move" fallback,
 * which is reserved for games where a legal move can be a worse-than-nothing choice.
 */
function scoreHintMove(state: PyramidState, move: Move): number {
  const refs = move.from.zone === move.to.zone && move.from.index === move.to.index ? [move.from] : [move.from, move.to]
  const removedPyramidIndices = refs.filter((r) => r.zone === 'pyramid').map((r) => r.index)
  if (removedPyramidIndices.length === 0) return 1

  const nextPyramid = state.pyramid.slice()
  for (const idx of removedPyramidIndices) nextPyramid[idx] = null

  let newlyExposed = 0
  for (let i = 0; i < TOTAL; i++) {
    if (state.pyramid[i] && !isExposedAt(state.pyramid, i) && isExposedAt(nextPyramid, i)) {
      newlyExposed++
    }
  }
  return 1 + newlyExposed * 10
}

export const PyramidController: GameController<PyramidState> = {
  id: 'pyramid',
  title: 'Pyramid',
  newGame,
  legalMoves,
  tryMove,
  drawStock,
  isWon,
  scoreHintMove
}
