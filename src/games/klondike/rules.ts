// Klondike solitaire game rules & controller.

import { pickBestTableauTarget } from '@/engine/autoMove'
import { shuffledDeck } from '@/engine/deck'
import { canPlaceOnFoundation, suitIndex } from '@/engine/foundation'
import { AccessibleCard, GameController, Move, PileRef } from '@/engine/gameTypes'
import { isDescendingAltColor, top } from '@/engine/pile'
import { Card, cardColor } from '@/engine/types'

export interface KlondikeState {
  /** 7 tableau columns. */
  tableau: Card[][]
  /** 4 foundation piles, indexed to match engine/types SUITS order (clubs, diamonds, hearts, spades). */
  foundation: Card[][]
  stock: Card[]
  waste: Card[]
}

// Shallow: fresh outer tableau/foundation arrays (so a caller can reassign state.tableau[i] /
// state.foundation[i] to a brand-new pile without touching the original state), but every pile
// and every card inside starts out as the exact SAME reference as `state`'s own. tryMove/
// drawStock below replace only the specific pile(s) a move actually touches (via setPile), and
// clone an individual card only at the one spot its faceUp is actually flipped in place (see
// flipFaceUp) - every one of the ~45+ untouched cards elsewhere on the board keeps its exact
// pre-move object identity. This used to be a full deep clone (every pile AND every card, on
// every move) - simpler, but it meant @tastic/cards' own React.memo on CardFace/CardBack (whose
// whole point is skipping re-renders for a card that hasn't actually changed) could never
// actually help during real gameplay, since literally every card's `card` prop was a fresh object
// on every single move, foundation play, undo, or auto-play step - confirmed as a real,
// measurable perf cost via a dedicated audit, not just a theoretical one.
function cloneState(state: KlondikeState): KlondikeState {
  return {
    tableau: state.tableau.slice(),
    foundation: state.foundation.slice(),
    stock: state.stock,
    waste: state.waste
  }
}

function getPile(state: KlondikeState, ref: PileRef): Card[] | null {
  switch (ref.zone) {
    case 'tableau':
      return state.tableau[ref.index] ?? null
    case 'foundation':
      return state.foundation[ref.index] ?? null
    case 'stock':
      return state.stock
    case 'waste':
      return state.waste
    default:
      return null
  }
}

/** Writes a (already-fresh, caller-owned) pile back into `state` at `ref` - state's own top-level
 * tableau/foundation arrays are always fresh per cloneState above, so this is a safe in-place
 * assignment on `state` itself, never on the original pre-move state. */
function setPile(state: KlondikeState, ref: PileRef, pile: Card[]): void {
  switch (ref.zone) {
    case 'tableau':
      state.tableau[ref.index] = pile
      break
    case 'foundation':
      state.foundation[ref.index] = pile
      break
    case 'stock':
      state.stock = pile
      break
    case 'waste':
      state.waste = pile
      break
  }
}

/** Replaces the last card of `pile` (mutated in place, since `pile` is always already a fresh
 * array the caller owns) with a face-up clone, if it isn't face-up already - never mutates the
 * card object itself, so a still-face-down copy of the same card sitting in an undo entry (or in
 * the pre-move state) is never affected. */
function flipFaceUp(pile: Card[]): void {
  const i = pile.length - 1
  const c = pile[i]
  if (c && !c.faceUp) pile[i] = { ...c, faceUp: true }
}

function canPlaceOnTableau(dest: Card[], moving: Card[]): boolean {
  if (moving.length === 0) return false
  const movingTop = moving[0] // first card of the run being moved (the one that lands on dest)
  const destTop = top(dest)
  if (destTop === undefined) {
    return movingTop.rank === 13
  }
  if (!destTop.faceUp) return false
  const destColor = cardColor(destTop.suit)
  const movingColor = cardColor(movingTop.suit)
  return movingTop.rank === destTop.rank - 1 && destColor !== movingColor
}

/** Length of the maximal alternating-color, consecutive-descending, face-up run currently sitting
 * at the top of a tableau column - the "coherent asset" a player already holds there and could
 * move as one unit. 0 for an empty column or one whose top card is face-down. Klondike's own
 * run-validity rule (isDescendingAltColor) walked pairwise, same relation legalMoves/canPlaceOnTableau
 * already check when deciding what can move/land together. */
function runLengthAtTop(column: Card[]): number {
  if (column.length === 0) return 0
  if (!column[column.length - 1].faceUp) return 0
  let len = 1
  for (let i = column.length - 2; i >= 0; i--) {
    const cur = column[i]
    const next = column[i + 1]
    if (!cur.faceUp) break
    if (next.rank !== cur.rank - 1 || cardColor(next.suit) === cardColor(cur.suit)) break
    len++
  }
  return len
}

/**
 * Ranks a legal tableau-to-tableau move for the Hint button (see engine/hint.ts's findHint).
 * Klondike has a real foundation zone - a foundation-bound move (the actual "completion" mechanic
 * here) already sorts first in findHint, unconditionally, so unlike Spider's synthetic 13-card
 * completion check, there is no completion case to special-case here at all; this only ever ranks
 * the remaining tableau moves (and, defensively, scores 0 for any move it wasn't designed for - a
 * waste->tableau move, since waste has no "coherent run" of its own to preserve or fragment).
 *
 * Same opportunity-cost shape as Spider's scoreHintMove, adapted to Klondike's own run-validity
 * rule (alternating-color descending, not same-suit descending) and to a real difference in what
 * "legal" already guarantees: Spider's tableau-move legality only requires a matching rank at the
 * destination (suit is irrelevant to legality, only to whether it forms a genuine same-suit run),
 * so Spider had to separately check `sameSuitExtension` before crediting a destination-side
 * extension. Klondike's own canPlaceOnTableau already enforces the alternating-color-descending
 * relation as part of legality - so any legal move onto a non-empty column is, by construction,
 * already a coherent extension of whatever run sits there; no extra suit/color check is needed
 * before crediting `newRunLenAtDest`.
 *
 * `R` = the coherent run already at the top of the source column. A move scores 0 if it relocates
 * that whole run intact, positive if it builds something longer (extending the destination's run,
 * or leaving a longer remainder behind than expected), negative if it fragments R for no
 * compensating gain. `netEmptyDelta` is the actual before/after change in empty tableau columns
 * (freeing one is a real gain; a lateral shuffle into the one empty column nets to zero).
 * `revealsHiddenCard` is a flat bonus, only reachable when count === R (going past the source's own
 * run boundary is the only way to expose a face-down card underneath).
 */
function scoreHintMove(state: KlondikeState, move: Move): number {
  if (move.from.zone !== 'tableau' || move.to.zone !== 'tableau') return 0
  const fromCol = state.tableau[move.from.index]
  const toCol = state.tableau[move.to.index]
  if (!fromCol || !toCol) return 0

  const runLen = runLengthAtTop(fromCol)
  const destRunLenBefore = runLengthAtTop(toCol)
  // A legal move onto a non-empty column is already a coherent alt-color-descending extension of
  // whatever run sits there (canPlaceOnTableau enforced that to make the move legal at all) - unlike
  // Spider, no extra same-suit check is needed to credit the extension.
  const newRunLenAtDest = move.count + (toCol.length > 0 ? destRunLenBefore : 0)
  const remainderRunLen = move.count < runLen ? runLen - move.count : 0
  const netRunStructureChange = Math.max(newRunLenAtDest, remainderRunLen) - runLen

  const fromBecomesEmpty = move.count === fromCol.length
  const toWasEmpty = toCol.length === 0
  const netEmptyDelta = (fromBecomesEmpty ? 1 : 0) - (toWasEmpty ? 1 : 0)

  const newFromTop = fromCol[fromCol.length - move.count - 1]
  const revealsHiddenCard = newFromTop !== undefined && !newFromTop.faceUp

  let score = revealsHiddenCard ? 500 : 0
  score += netRunStructureChange * 30
  score += netEmptyDelta * 40
  score += move.count * 2
  return score
}

export function createKlondikeController(drawCount: 1 | 3): GameController<KlondikeState> {
  function newGame(seed: number): KlondikeState {
    const deck = shuffledDeck(seed, 1)
    let cursor = 0
    const tableau: Card[][] = []
    for (let col = 0; col < 7; col++) {
      const count = col + 1
      const cards: Card[] = []
      for (let i = 0; i < count; i++) {
        const card = deck[cursor++]
        const faceUp = i === count - 1
        cards.push({ ...card, faceUp })
      }
      tableau.push(cards)
    }
    const stock: Card[] = deck.slice(cursor).map((c) => ({ ...c, faceUp: false }))
    const foundation: Card[][] = [[], [], [], []]
    return { tableau, foundation, stock, waste: [] }
  }

  function tryMove(state: KlondikeState, move: Move): KlondikeState | null {
    const { from, to, count } = move
    if (count < 1) return null
    if (from.zone === to.zone && from.index === to.index) return null
    if (from.zone === 'foundation') return null // cards never move back out of foundation

    const sourcePile = getPile(state, from)
    if (!sourcePile || sourcePile.length < count) return null

    if (from.zone === 'stock') return null // stock cards only move via drawStock

    // Only tableau moves may carry more than one card.
    if (count > 1 && from.zone !== 'tableau') return null

    const movingCards = sourcePile.slice(sourcePile.length - count)
    if (movingCards.some((c) => !c.faceUp)) return null

    if (from.zone === 'tableau' && count > 1) {
      if (!isDescendingAltColor(movingCards)) return null
    }

    const destPile = getPile(state, to)
    if (!destPile) return null

    if (to.zone === 'tableau') {
      if (!canPlaceOnTableau(destPile, movingCards)) return null
    } else if (to.zone === 'foundation') {
      if (count !== 1) return null
      const movingCard = movingCards[0]
      if (suitIndex(movingCard.suit) !== to.index) return null
      if (!canPlaceOnFoundation(destPile, movingCard)) return null
    } else if (to.zone === 'waste') {
      return null // cards never move onto waste via tryMove
    } else {
      return null
    }

    const next = cloneState(state)
    const nextSourcePile = getPile(next, from)!.slice()
    const nextDestPile = getPile(next, to)!.slice()
    setPile(next, from, nextSourcePile)
    setPile(next, to, nextDestPile)
    const moved = nextSourcePile.splice(nextSourcePile.length - count, count)
    nextDestPile.push(...moved)

    if (from.zone === 'tableau') {
      flipFaceUp(nextSourcePile)
    } else if (from.zone === 'waste') {
      // nothing extra needed; top of waste is simply whatever remains
    }

    return next
  }

  function drawStock(state: KlondikeState): KlondikeState | null {
    if (state.stock.length > 0) {
      const next = cloneState(state)
      const nextStock = next.stock.slice()
      const nextWaste = next.waste.slice()
      const n = Math.min(drawCount, nextStock.length)
      const drawn = nextStock.splice(nextStock.length - n, n)
      for (const c of drawn) {
        nextWaste.push(c.faceUp ? c : { ...c, faceUp: true })
      }
      setPile(next, { zone: 'stock', index: 0 }, nextStock)
      setPile(next, { zone: 'waste', index: 0 }, nextWaste)
      return next
    }
    if (state.waste.length > 0) {
      const next = cloneState(state)
      // Every recycled card's faceUp genuinely flips here (waste -> face-down stock) - unlike the
      // draw above, there's no untouched subset to preserve identity for; all of them really do
      // change.
      const recycled = state.waste
        .slice()
        .reverse()
        .map((c) => ({ ...c, faceUp: false }))
      setPile(next, { zone: 'stock', index: 0 }, recycled)
      setPile(next, { zone: 'waste', index: 0 }, [])
      return next
    }
    return null
  }

  function isWon(state: KlondikeState): boolean {
    return state.foundation.every((pile) => {
      const t = top(pile)
      return t !== undefined && t.rank === 13
    })
  }

  function legalMoves(state: KlondikeState): Move[] {
    const moves: Move[] = []

    const tryAdd = (from: PileRef, to: PileRef, count: number) => {
      const result = tryMove(state, { from, to, count })
      if (result) moves.push({ from, to, count })
    }

    // Waste top card -> foundation / tableau
    if (state.waste.length > 0) {
      const from: PileRef = { zone: 'waste', index: 0 }
      for (let f = 0; f < 4; f++) tryAdd(from, { zone: 'foundation', index: f }, 1)
      for (let t = 0; t < 7; t++) tryAdd(from, { zone: 'tableau', index: t }, 1)
    }

    // Tableau -> foundation (top card), tableau -> tableau (top card and full valid runs)
    for (let col = 0; col < 7; col++) {
      const pile = state.tableau[col]
      if (pile.length === 0) continue
      // find longest face-up run at the top
      let runStart = pile.length - 1
      while (runStart > 0 && pile[runStart - 1].faceUp) {
        // check if it forms a valid descending-alt-color run so far
        const candidate = pile.slice(runStart - 1)
        if (isDescendingAltColor(candidate)) {
          runStart -= 1
        } else {
          break
        }
      }
      const from: PileRef = { zone: 'tableau', index: col }
      // single top card -> foundation
      for (let f = 0; f < 4; f++) tryAdd(from, { zone: 'foundation', index: f }, 1)
      // various run lengths -> other tableau columns. Collapse straight to the single destination
      // autoMoveHint would also pick for this same (from, count) - same candidate filter, same
      // pickBestTableauTarget call - so a move surfaced here (e.g. for the Hint button) always
      // matches where tapping that card actually sends it. See autoMoveHint below for the identical
      // candidate-building logic.
      for (let count = 1; count <= pile.length - runStart; count++) {
        const movingCards = pile.slice(pile.length - count)
        const candidates = state.tableau
          .map((destPile, index) => ({ index, pile: destPile }))
          .filter((c) => c.index !== col)
          .filter((c) => canPlaceOnTableau(c.pile, movingCards))
        const best = pickBestTableauTarget(candidates, isDescendingAltColor)
        if (best) {
          moves.push({ from, to: { zone: 'tableau', index: best.index }, count })
        }
      }
    }

    return moves
  }

  function autoMoveHint(state: KlondikeState, from: PileRef, cardId: string): Move | null {
    const pile = getPile(state, from)
    if (!pile) return null
    const cardIndex = pile.findIndex((c) => c.id === cardId)
    if (cardIndex === -1) return null
    const movingCards = pile.slice(cardIndex)
    if (movingCards.some((c) => !c.faceUp)) return null
    const count = movingCards.length
    if (count > 1 && (from.zone !== 'tableau' || !isDescendingAltColor(movingCards))) return null

    if (count === 1) {
      const movingCard = movingCards[0]
      const f = suitIndex(movingCard.suit)
      if (canPlaceOnFoundation(state.foundation[f], movingCard)) {
        return { from, to: { zone: 'foundation', index: f }, count: 1 }
      }
    }

    const candidates = state.tableau
      .map((destPile, index) => ({ index, pile: destPile }))
      .filter((c) => !(from.zone === 'tableau' && from.index === c.index))
      .filter((c) => canPlaceOnTableau(c.pile, movingCards))
    const best = pickBestTableauTarget(candidates, isDescendingAltColor)
    if (!best) return null
    return { from, to: { zone: 'tableau', index: best.index }, count }
  }

  /** Every card currently reachable without drawing from stock - the waste top plus each tableau
   * column's top card - for the auto-play-to-foundation feature (see engine/autoFoundation.ts). */
  function accessibleCards(state: KlondikeState): AccessibleCard[] {
    const result: AccessibleCard[] = []
    const wasteTop = top(state.waste)
    if (wasteTop) result.push({ ref: { zone: 'waste', index: 0 }, card: wasteTop })
    state.tableau.forEach((pile, index) => {
      const t = top(pile)
      if (t && t.faceUp) result.push({ ref: { zone: 'tableau', index }, card: t })
    })
    return result
  }

  return {
    id: 'klondike',
    title: 'Klondike',
    newGame,
    legalMoves,
    tryMove,
    drawStock,
    isWon,
    autoMoveHint,
    accessibleCards,
    scoreHintMove
  }
}
