// Klondike solitaire game rules & controller.

import { FinishMove, isFullyAutoCompletable, nextAutoCompleteMove } from '@/engine/autoFoundation'
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
 * Ranks a legal tableau or waste move onto the tableau for the Hint button (see engine/hint.ts's findHint).
 * Klondike has a real foundation zone - a foundation-bound move (the actual "completion" mechanic
 * here) already sorts first in findHint, unconditionally, so unlike Spider's synthetic 13-card
 * completion check, there is no completion case to special-case here at all; this only ever ranks
 * the remaining moves onto the tableau. A waste play scores like a one-card run plus a bonus for
 * leaving the waste: it used to score 0, and since findHint suggests a draw whenever nothing scores
 * above 0, Hint never suggested playing the waste card at all.
 *
 * Same opportunity-cost shape as Spider's scoreHintMove, adapted to Klondike's own run-validity
 * rule (alternating-color descending, not same-suit descending) and to a real difference in what
 * "legal" already guarantees: Spider's tableau-move legality only requires a matching rank at the
 * destination (suit is irrelevant to legality, only to whether it forms a genuine same-suit run),
 * so Spider had to separately check `sameSuitExtension` before crediting a destination-side
 * extension. Klondike's own canPlaceOnTableau already enforces the alternating-color-descending
 * relation as part of legality - so any legal move onto a non-empty column is, by construction,
 * already a coherent extension of whatever run sits there; no extra suit/color check is needed
 * before crediting the destination's run.
 *
 * The run term compares the longest run the move touches before and after it: positive if it builds
 * something longer (extending the destination's run), negative if it fragments the source's run for
 * no compensating gain, and 0 for a relocation, which then scores 0 overall (no size tiebreak), so
 * Hint never offers it or its reverse. `netEmptyDelta` is the actual before/after change in empty tableau columns
 * (freeing one is a real gain; a lateral shuffle into the one empty column nets to zero).
 * `revealsHiddenCard` is a flat bonus, only reachable when count === R (going past the source's own
 * run boundary is the only way to expose a face-down card underneath).
 */
function scoreHintMove(state: KlondikeState, move: Move): number {
  if (move.to.zone !== 'tableau') return 0
  if (move.from.zone !== 'tableau' && move.from.zone !== 'waste') return 0
  const fromWaste = move.from.zone === 'waste'
  const fromPile = fromWaste ? state.waste : state.tableau[move.from.index]
  const toCol = state.tableau[move.to.index]
  if (!fromPile || !toCol || fromPile.length < move.count) return 0

  // Measured the same way before and after the move, so a move and its exact reverse always score
  // as opposites and a relocation that gains nothing scores 0 (Hint used to offer it, then offer
  // moving it straight back). `a` is the run the moving group's base card was continuing at its
  // source (0 for the waste, or when the card below isn't part of its run), `b` the run it lands on
  // (0 for an empty column). A Klondike group is always a clean run, so it is the whole of `count`.
  const remainder = fromPile.slice(0, fromPile.length - move.count)
  const below = remainder[remainder.length - 1]
  const base = fromPile[fromPile.length - move.count]
  const linkedAtSource = !fromWaste && below !== undefined && below.faceUp && below.rank === base.rank + 1 && cardColor(below.suit) !== cardColor(base.suit)
  const a = linkedAtSource ? runLengthAtTop(remainder) : 0
  const b = runLengthAtTop(toCol)
  const netRunStructureChange = Math.max(move.count + b, a) - Math.max(move.count + a, b)

  const fromBecomesEmpty = !fromWaste && move.count === fromPile.length
  const toWasEmpty = toCol.length === 0
  const netEmptyDelta = (fromBecomesEmpty ? 1 : 0) - (toWasEmpty ? 1 : 0)

  const revealsHiddenCard = !fromWaste && below !== undefined && !below.faceUp

  let score = revealsHiddenCard ? 500 : 0
  // A waste card played to the tableau leaves the stock/waste for good. Worth more than an empty
  // column, since a Klondike empty column only ever takes a King.
  if (fromWaste) score += 50
  score += netRunStructureChange * 30
  score += netEmptyDelta * 40
  // The size tiebreak only orders moves that already gain something.
  if (score <= 0) return score
  return score + move.count * 2
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
    // A foundation's top card may come back down onto the tableau, one card at a time - the standard rule (Windows
    // Solitaire allowed it), occasionally the only way to free a column. Never onto another foundation. legalMoves never
    // offers it, so Hint can't suggest a card going up and straight back down.
    if (from.zone === 'foundation' && (to.zone !== 'tableau' || count !== 1)) return null

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

/** True once the board is SOLVED, so the finish (games/shared/useAutoFinish) may file the rest away on its own: not won yet,
 * nothing hidden (no face-down tableau card, an empty stock and waste) and every remaining card able to go up by foundation
 * moves alone. The hidden-card checks are not redundant: isFullyAutoCompletable is also true with face-down cards under the
 * cards that go up (they turn over on the way), and the draws-aware version with cards still in the stock - the finish must
 * never start on a card the player hasn't seen. A won board is false too (isFullyAutoCompletable is true there), so the
 * finish ends after its last card. `controller` is the screen's live one (it is recreated on New Game and restore), though
 * nothing read here depends on its draw count. */
export function canAutoFinish(controller: GameController<KlondikeState>, state: KlondikeState): boolean {
  if (state.stock.length > 0 || state.waste.length > 0) return false
  if (state.tableau.some((column) => column.some((c) => !c.faceUp))) return false
  return !controller.isWon(state) && isFullyAutoCompletable(controller, state)
}

/** The next card the finish should send up, and its own suit's foundation - null unless canAutoFinish. */
export function nextFinishMove(controller: GameController<KlondikeState>, state: KlondikeState): FinishMove | null {
  if (!canAutoFinish(controller, state)) return null
  const entry = nextAutoCompleteMove(controller, state)
  return entry ? { entry, to: { zone: 'foundation', index: suitIndex(entry.card.suit) } } : null
}
