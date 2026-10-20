// FreeCell solitaire game rules & controller.

import { pickBestTableauTarget } from '@/engine/autoMove'
import { shuffledDeck } from '@/engine/deck'
import { canPlaceOnFoundation, suitIndex } from '@/engine/foundation'
import { AccessibleCard, GameController, Move, PileRef } from '@/engine/gameTypes'
import { isDescendingAltColor, top } from '@/engine/pile'
import { Card, cardColor } from '@/engine/types'

export interface FreeCellState {
  /** 8 tableau columns, all cards always face-up. */
  tableau: Card[][]
  /** 4 freecells, each holds 0 or 1 card. */
  freecells: (Card | null)[]
  /** 4 foundation piles, indexed to match engine/foundation's FOUNDATION_SUITS order (spades, diamonds, clubs, hearts). */
  foundation: Card[][]
}

const NUM_TABLEAU = 8
const NUM_FREECELLS = 4
const NUM_FOUNDATIONS = 4

// Shallow: fresh outer tableau/freecells/foundation arrays (so a caller can reassign
// state.tableau[i] / state.foundation[i] / state.freecells[i] to a brand-new value without
// touching the original state), but every pile - and every card inside it - starts out as the
// exact SAME reference as `state`'s own. tryMove below only ever replaces a touched pile with a
// freshly .slice()'d/.concat()'d array (never mutates one in place), so every untouched column,
// freecell, and foundation pile keeps its exact pre-move array identity too, not just its cards.
// Card-level cloning was never needed here in the first place, unlike Klondike/Spider: FreeCell
// deals every card face-up and never flips one back over (see FreeCellState's own doc comment
// and runLengthAtTop's), so there is no in-place `card.faceUp = ...` mutation anywhere in this
// file for a shared card reference to leak through.
function cloneState(state: FreeCellState): FreeCellState {
  return {
    tableau: state.tableau.slice(),
    freecells: state.freecells.slice(),
    foundation: state.foundation.slice()
  }
}

/** A single card (the top of the moving group) landing on a tableau column. */
function canPlaceOnTableau(dest: Card[], movingTop: Card): boolean {
  const destTop = top(dest)
  if (destTop === undefined) return true // any card, or the head of a valid run, may start an empty column
  return movingTop.rank === destTop.rank - 1 && cardColor(movingTop.suit) !== cardColor(destTop.suit)
}

/** Length of the maximal alternating-color, consecutive-descending run currently sitting at the
 * top of a tableau column - the "coherent asset" a player already holds there and could move as
 * one unit. 0 for an empty column. Unlike Klondike/Spider, FreeCell deals every card face-up and
 * never turns one back over (see FreeCellState's own doc comment), so there is no face-down check
 * here at all. Same pairwise relation canPlaceOnTableau/isDescendingAltColor already check. */
function runLengthAtTop(column: Card[]): number {
  if (column.length === 0) return 0
  let len = 1
  for (let i = column.length - 2; i >= 0; i--) {
    const cur = column[i]
    const next = column[i + 1]
    if (next.rank !== cur.rank - 1 || cardColor(next.suit) === cardColor(cur.suit)) break
    len++
  }
  return len
}

export function countEmptyFreecells(state: FreeCellState): number {
  return state.freecells.filter((c) => c === null).length
}

/** Count empty tableau columns, excluding `excludeIndex` (the move's own destination doesn't help).
 * Exported alongside countEmptyFreecells/maxSupermoveCount so a UI can explain a failed move in
 * terms of the exact numbers that produced its cap (see FreeCellScreen.tsx's completeMove). */
export function countEmptyTableauColumns(state: FreeCellState, excludeIndex: number): number {
  return state.tableau.filter((col, i) => i !== excludeIndex && col.length === 0).length
}

/** Max cards movable together in one tableau->tableau move (the "supermove" convention). Pass a
 * `destIndex` that matches no real column (e.g. -1) to get the best-case cap - the size achievable
 * when the destination isn't itself one of the empty columns - for previews that don't yet know
 * the destination (see FreeCellScreen.tsx's tableauRunCount, which dims a card whose own coherent
 * run exceeds even this generous cap). */
export function maxSupermoveCount(state: FreeCellState, destIndex: number): number {
  const emptyFreecells = countEmptyFreecells(state)
  const emptyCols = countEmptyTableauColumns(state, destIndex)
  return (emptyFreecells + 1) * 2 ** emptyCols
}

function newGame(seed: number): FreeCellState {
  const deck = shuffledDeck(seed, 1).map((c) => ({ ...c, faceUp: true }))
  const tableau: Card[][] = []
  let cursor = 0
  for (let col = 0; col < NUM_TABLEAU; col++) {
    const count = col < 4 ? 7 : 6
    tableau.push(deck.slice(cursor, cursor + count))
    cursor += count
  }
  const freecells: (Card | null)[] = [null, null, null, null]
  const foundation: Card[][] = [[], [], [], []]
  return { tableau, freecells, foundation }
}

function tryMove(state: FreeCellState, move: Move): FreeCellState | null {
  const { from, to, count } = move
  if (count < 1) return null
  if (from.zone === to.zone && from.index === to.index) return null
  if (from.zone === 'foundation') return null // cards never move back out of foundation

  let movingCards: Card[]
  if (from.zone === 'tableau') {
    const col = state.tableau[from.index]
    if (!col || col.length < count) return null
    movingCards = col.slice(col.length - count)
  } else if (from.zone === 'freecell') {
    if (count !== 1) return null
    const card = state.freecells[from.index]
    if (!card) return null
    movingCards = [card]
  } else {
    return null
  }

  // Only tableau->tableau moves may carry more than one card.
  if (count > 1 && (from.zone !== 'tableau' || to.zone !== 'tableau')) return null
  if (count > 1 && !isDescendingAltColor(movingCards)) return null

  if (to.zone === 'tableau') {
    const destCol = state.tableau[to.index]
    if (!destCol) return null
    if (count > 1 && count > maxSupermoveCount(state, to.index)) return null
    if (!canPlaceOnTableau(destCol, movingCards[0])) return null
  } else if (to.zone === 'foundation') {
    if (count !== 1) return null
    const destPile = state.foundation[to.index]
    if (!destPile) return null
    const movingCard = movingCards[0]
    if (suitIndex(movingCard.suit) !== to.index) return null
    if (!canPlaceOnFoundation(destPile, movingCard)) return null
  } else if (to.zone === 'freecell') {
    if (count !== 1) return null
    if (to.index < 0 || to.index >= NUM_FREECELLS) return null
    if (state.freecells[to.index] !== null) return null
  } else {
    return null
  }

  const next = cloneState(state)

  if (from.zone === 'tableau') {
    next.tableau[from.index] = next.tableau[from.index].slice(0, next.tableau[from.index].length - count)
  } else if (from.zone === 'freecell') {
    next.freecells[from.index] = null
  }

  if (to.zone === 'tableau') {
    next.tableau[to.index] = next.tableau[to.index].concat(movingCards)
  } else if (to.zone === 'foundation') {
    next.foundation[to.index] = next.foundation[to.index].concat(movingCards)
  } else if (to.zone === 'freecell') {
    next.freecells[to.index] = movingCards[0]
  }

  return next
}

function isWon(state: FreeCellState): boolean {
  return state.foundation.every((pile) => {
    const t = top(pile)
    return t !== undefined && t.rank === 13
  })
}

function legalMoves(state: FreeCellState): Move[] {
  const moves: Move[] = []

  const tryAdd = (from: PileRef, to: PileRef, count: number) => {
    const result = tryMove(state, { from, to, count })
    if (result) moves.push({ from, to, count })
  }

  // Freecell -> foundation / tableau
  for (let fc = 0; fc < NUM_FREECELLS; fc++) {
    if (state.freecells[fc] === null) continue
    const from: PileRef = { zone: 'freecell', index: fc }
    for (let f = 0; f < NUM_FOUNDATIONS; f++) tryAdd(from, { zone: 'foundation', index: f }, 1)
    for (let t = 0; t < NUM_TABLEAU; t++) tryAdd(from, { zone: 'tableau', index: t }, 1)
  }

  // Tableau -> foundation / freecell / tableau (single card and valid runs)
  for (let col = 0; col < NUM_TABLEAU; col++) {
    const pile = state.tableau[col]
    if (pile.length === 0) continue
    const from: PileRef = { zone: 'tableau', index: col }

    for (let f = 0; f < NUM_FOUNDATIONS; f++) tryAdd(from, { zone: 'foundation', index: f }, 1)
    for (let fc = 0; fc < NUM_FREECELLS; fc++) tryAdd(from, { zone: 'freecell', index: fc }, 1)

    // Find the longest alternating-color run at the top of the column.
    let runStart = pile.length - 1
    while (runStart > 0 && isDescendingAltColor(pile.slice(runStart - 1))) {
      runStart -= 1
    }
    const maxRun = pile.length - runStart
    for (let count = 1; count <= maxRun; count++) {
      // Collapse straight to the single destination autoMoveHint would also pick for this same
      // (from, count) - same candidate filter (including the supermove-size limit), same
      // pickBestTableauTarget call - so a move surfaced here (e.g. for the Hint button) always
      // matches where tapping that card actually sends it.
      const movingCards = pile.slice(pile.length - count)
      const movingTop = movingCards[0]
      const candidates = state.tableau
        .map((destPile, index) => ({ index, pile: destPile }))
        .filter((c) => c.index !== col)
        .filter((c) => canPlaceOnTableau(c.pile, movingTop))
        .filter((c) => count === 1 || count <= maxSupermoveCount(state, c.index))
      const best = pickBestTableauTarget(candidates, isDescendingAltColor)
      if (best) tryAdd(from, { zone: 'tableau', index: best.index }, count)
    }
  }

  return moves
}

/**
 * Foundation first, then the best tableau destination (shared logic with the other games), and
 * finally - FreeCell-only - an empty freecell as the last resort, so tapping a card that has
 * nowhere better to go still does something instead of sitting inert. Skipped when the card is
 * already sitting in a freecell: shuffling it into a different empty cell makes no progress, and
 * legalMoves() doesn't offer freecell->freecell moves either.
 */
function autoMoveHint(state: FreeCellState, from: PileRef, cardId: string): Move | null {
  let movingCards: Card[]
  if (from.zone === 'tableau') {
    const col = state.tableau[from.index]
    if (!col) return null
    const cardIndex = col.findIndex((c) => c.id === cardId)
    if (cardIndex === -1) return null
    movingCards = col.slice(cardIndex)
    if (movingCards.length > 1 && !isDescendingAltColor(movingCards)) return null
  } else if (from.zone === 'freecell') {
    const c = state.freecells[from.index]
    if (!c || c.id !== cardId) return null
    movingCards = [c]
  } else {
    return null
  }

  const count = movingCards.length
  const movingTop = movingCards[0]

  if (count === 1) {
    const f = suitIndex(movingTop.suit)
    if (canPlaceOnFoundation(state.foundation[f], movingTop)) {
      return { from, to: { zone: 'foundation', index: f }, count: 1 }
    }
  }

  const candidates = state.tableau
    .map((destPile, index) => ({ index, pile: destPile }))
    .filter((c) => !(from.zone === 'tableau' && from.index === c.index))
    .filter((c) => canPlaceOnTableau(c.pile, movingTop))
    .filter((c) => count === 1 || count <= maxSupermoveCount(state, c.index))
  const best = pickBestTableauTarget(candidates, isDescendingAltColor)
  if (best) return { from, to: { zone: 'tableau', index: best.index }, count }

  if (count === 1 && from.zone !== 'freecell') {
    const emptyFreecell = state.freecells.findIndex((c) => c === null)
    if (emptyFreecell !== -1) {
      return { from, to: { zone: 'freecell', index: emptyFreecell }, count: 1 }
    }
  }

  return null
}

/**
 * Ranks a legal non-foundation move for the Hint button (see engine/hint.ts's findHint) -
 * foundation-bound moves already sort first there, unconditionally, so this only ever ranks the
 * rest: tableau->tableau (single card or a supermove-eligible run), tableau->freecell, and
 * freecell->tableau (legalMoves() never offers freecell->freecell, so that shape can't reach here
 * in practice; the fallback below scores it defensively rather than assuming it can't happen).
 *
 * Same "opportunity-cost run valuation" shape Spider/Klondike/Canfield/FortyThieves all use, with
 * Klondike's own run rule (isDescendingAltColor, not Spider's same-suit one): the longest run either
 * touched pile shows before the move against the longest either shows after it. `a` is the run the
 * moving group's base card was continuing at its source (0 for a freecell, or when the card under it
 * isn't part of its run) and `b` the run it lands on (0 for an empty column or a freecell), so before
 * the move the source shows `count + a` and the destination `b`, and after it the source shows `a`
 * and the destination `count + b` - zero if the group relocated intact onto nothing longer, positive
 * if it built something longer, negative if it tore a run apart for no compensating gain. Measured
 * the same way on both sides, a move and its exact reverse always score as opposites: the old
 * version compared only the source's run before with the better of the two after, and added the
 * size tiebreak to every move, so moving a card from one matching card to an equal one scored above
 * 0 both ways and Hint offered it, then offered moving it straight back. As with Klondike,
 * canPlaceOnTableau already enforces the alt-color-descending relation as part of legality, so a
 * legal move onto a non-empty column is, by construction, always a coherent extension of whatever
 * run sits there - no extra suit/color check needed before crediting `b`. No reveal-a-hidden-card
 * bonus exists here (unlike Klondike/Spider): every FreeCell card is face-up from the very first
 * deal and stays that way, so there is never a face-down card to expose.
 *
 * A freecell is treated as holding a trivially complete "run" of whatever is in or going into it on
 * BOTH ends of this formula, the same way Canfield's scoreHintMove treats its single-card
 * waste/reserve sources - it's "the coherent thing already sitting at this move's
 * source/destination," so the same comparison falls out correctly without a per-shape special case:
 * moving a freecell's card onto an existing tableau run scores exactly like extending that run from
 * a tableau source would, and moving a lone/whole-run card INTO a freecell nets to 0 (relocated
 * intact, same as any other whole-run relocation) rather than being scored as if the destination
 * held nothing at all -
 * that asymmetry would otherwise treat routine, non-fragmenting freecell storage (an extremely
 * common move - a source column's own top run is very often just 1 card, since the tableau's
 * initial deal has no internal alternating-color-descending guarantee below it) as if it fragmented
 * a run down to zero.
 *
 * FreeCell has two independent scarce resources instead of every sibling's one: empty tableau
 * columns AND empty freecells (both are the classic FreeCell "workspace"). They are NOT weighted
 * equally: freeing a column is worth roughly twice as much per unit as freeing a freecell, because
 * of a real asymmetry already baked into this file's own supermove math (see maxSupermoveCount
 * above) - an extra empty freecell only adds +1 to the `(emptyFreecells + 1)` factor, while an extra
 * empty column DOUBLES the whole result via `2 ** emptyCols`. A move can free (or spend) at most one
 * of each kind at once, so the two deltas never double-count against each other; they're just added.
 *
 * The tiebreak, the length of the run the move builds at its destination (`count + b`), is only added
 * to a move that already gains something, so it never lifts a relocation (or its reverse) above 0,
 * and among moves that do gain it prefers building onto the longer run.
 */
function scoreHintMove(state: FreeCellState, move: Move): number {
  if (move.to.zone === 'foundation') return 0 // already sorted first by findHint - not scored here

  const fromCol = move.from.zone === 'tableau' ? state.tableau[move.from.index] : undefined
  const toCol = move.to.zone === 'tableau' ? state.tableau[move.to.index] : undefined
  if (move.from.zone === 'tableau' && !fromCol) return 0
  if (move.to.zone === 'tableau' && !toCol) return 0

  // A legal tableau group is always a clean run (see tryMove), so it is the whole of `count`.
  let a = 0
  if (fromCol && fromCol.length >= move.count) {
    const remainder = fromCol.slice(0, fromCol.length - move.count)
    const below = remainder[remainder.length - 1]
    const base = fromCol[fromCol.length - move.count]
    if (below !== undefined && isDescendingAltColor([below, base])) a = runLengthAtTop(remainder)
  }
  const b = toCol ? runLengthAtTop(toCol) : 0
  const netRunStructureChange = Math.max(move.count + b, a) - Math.max(move.count + a, b)

  const fromBecomesEmpty = fromCol !== undefined && move.count === fromCol.length
  const toWasEmpty = toCol !== undefined && toCol.length === 0
  const netEmptyColumnDelta = (fromBecomesEmpty ? 1 : 0) - (toWasEmpty ? 1 : 0)

  const freesFreecell = move.from.zone === 'freecell' ? 1 : 0
  const consumesFreecell = move.to.zone === 'freecell' ? 1 : 0
  const netFreecellDelta = freesFreecell - consumesFreecell

  let score = netRunStructureChange * 30
  score += netEmptyColumnDelta * 50
  score += netFreecellDelta * 25
  // The tiebreak only orders moves that already gain something.
  if (score <= 0) return score
  return score + (move.count + b) * 2
}

/** The card at the head of a `count`-card move from `from` - the first of the run, the one a
 * player grabs and a flight is drawn for - or undefined if `from` holds fewer than `count` cards.
 * tryMove itself only knows positions, so callers use this to check a move is still about the card
 * they meant. */
export function moveHeadCard(state: FreeCellState, from: PileRef, count: number): Card | undefined {
  if (from.zone === 'tableau') return state.tableau[from.index]?.[state.tableau[from.index].length - count]
  if (from.zone === 'freecell') return count === 1 ? (state.freecells[from.index] ?? undefined) : undefined
  return undefined
}

/** Every card currently reachable - every freecell's contents plus each tableau column's top card
 * (FreeCell has no stock/waste) - for the auto-play-to-foundation feature (see
 * engine/autoFoundation.ts). */
function accessibleCards(state: FreeCellState): AccessibleCard[] {
  const result: AccessibleCard[] = []
  state.freecells.forEach((card, index) => {
    if (card) result.push({ ref: { zone: 'freecell', index }, card })
  })
  state.tableau.forEach((pile, index) => {
    const t = top(pile)
    if (t) result.push({ ref: { zone: 'tableau', index }, card: t })
  })
  return result
}

export const FreeCellController: GameController<FreeCellState> = {
  id: 'freecell',
  title: 'FreeCell',
  newGame,
  legalMoves,
  tryMove,
  isWon,
  autoMoveHint,
  scoreHintMove,
  accessibleCards
}
