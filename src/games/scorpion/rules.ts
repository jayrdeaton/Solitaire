// Scorpion solitaire game rules & controller.
//
// Board: 7 tableau columns, no foundations at all - the goal is to assemble all 4 suits into
// complete King-to-Ace runs INSIDE the tableau itself (see isWon below), not move them to a
// separate pile. Columns 0-3 each start with 7 cards: the bottom 3 face-down, the top 4 face-up.
// Columns 4-6 are all face-up from the start.
//
// Two deal variants, chosen by settings.scorpionAssistedStock:
//  - Assisted (default, true): columns 4-6 get only 7 face-up cards each at deal time (49 cards
//    dealt total), holding the other 3 back as a one-shot stock the player can deal in later - one
//    card onto the top of each of the last 3 columns, whenever they like, exactly once (see
//    drawStock). This gives the same eventual 7/7/7/7/8/8/8 column shape as the classic layout
//    below, just with 3 cards arriving as a player-triggered lifeline instead of face-up at once.
//  - Classic (false): the strict, harder original - columns 4-6 get 8 face-up cards each (52 cards
//    dealt total, no stock at all).
//
// Move rule (the hallmark that sets Scorpion apart from Spider, which it otherwise resembles):
// any face-up card, together with everything sitting on top of it, may be moved as one group onto
// another tableau card that is the SAME SUIT and exactly one rank higher - REGARDLESS of whether
// that group is itself a valid descending sequence. This is Yukon's "pick up any face-up group"
// permissiveness (see engine/pile.ts's alwaysValidRun, added for Yukon and reused here verbatim)
// combined with Spider's same-suit adjacency requirement on the destination, rather than either
// game's own move rule outright. Any face-up card/group may also start an empty column - no King
// restriction, same permissive convention Yukon already established in this app.

import { pickBestTableauTarget } from '@/engine/autoMove'
import { shuffledDeck } from '@/engine/deck'
import { GameController, Move, PileRef } from '@/engine/gameTypes'
import { alwaysValidRun, isDescendingSameSuit, top } from '@/engine/pile'
import { Card, cloneCard } from '@/engine/types'

export interface ScorpionState {
  /** 7 tableau columns. Columns 0-3 start 3 face-down + 4 face-up; columns 4-6 start all face-up
   * (7 or 8 cards each, depending on the assisted-stock variant - see this file's header comment). */
  tableau: Card[][]
  /** The assisted variant's one-shot held-back stock: 3 cards, or empty (classic variant, or
   * already dealt out - see drawStock). */
  stock: Card[]
}

const NUM_COLUMNS = 7
const FRONT_COLUMNS = 4 // columns 0-3, each with a face-down base
const FACE_DOWN_PER_FRONT_COLUMN = 3

function cloneState(state: ScorpionState): ScorpionState {
  return {
    tableau: state.tableau.map((col) => col.map(cloneCard)),
    stock: state.stock.map(cloneCard)
  }
}

/** Same suit, exactly one rank higher than `moving`'s own bottom (deepest) card - the card that
 * actually attaches to `dest`'s top. An empty column accepts any face-up card or group, no King
 * restriction (see this file's header comment). */
function canPlaceOnTableau(dest: Card[], moving: Card[]): boolean {
  if (moving.length === 0) return false
  const movingBottom = moving[0]
  const destTop = top(dest)
  if (destTop === undefined) return true
  if (!destTop.faceUp) return false
  return destTop.suit === movingBottom.suit && movingBottom.rank === destTop.rank - 1
}

function computeLegalMoves(state: ScorpionState): Move[] {
  const moves: Move[] = []
  for (let from = 0; from < NUM_COLUMNS; from++) {
    const col = state.tableau[from]
    // Every face-up card in this column is a legal group-start (see this file's header comment) -
    // unlike Spider, there's no "longest valid run" restriction narrowing which index a group may
    // start at, so each idx below yields its own distinct, fixed-count group (idx through the top).
    for (let idx = 0; idx < col.length; idx++) {
      if (!col[idx].faceUp) continue
      const group = col.slice(idx)
      const count = group.length
      // Collapse straight to the single destination autoMoveHint would also pick for this same
      // (from, count) - same candidate filter, same pickBestTableauTarget call - so a move surfaced
      // here (e.g. for the Hint button) always matches where tapping that card actually sends it.
      const candidates = state.tableau
        .map((destCol, index) => ({ index, pile: destCol }))
        .filter((c) => c.index !== from)
        .filter((c) => canPlaceOnTableau(c.pile, group))
      const best = pickBestTableauTarget(candidates, alwaysValidRun)
      if (best) {
        moves.push({ from: { zone: 'tableau', index: from }, to: { zone: 'tableau', index: best.index }, count })
      }
    }
  }
  return moves
}

/** Length of the maximal same-suit, consecutive-descending, face-up run currently sitting at the
 * top of a column - the "coherent asset" a player already holds there and could move as one unit
 * cleanly (i.e. so its bottom card would itself validly continue onto any matching destination).
 * 0 for an empty column. Identical in spirit to Spider's own runLengthAtTop (same same-suit
 * descending definition, since that's this game's own destination-continuation rule too), but here
 * it does NOT bound how large a moved group can be - Scorpion's move rule lets a player drag along
 * whatever sits above a chosen card regardless of internal order (see this file's header comment),
 * so a moved group can extend past this run into incoherent territory below it. */
function runLengthAtTop(column: Card[]): number {
  if (column.length === 0) return 0
  if (!column[column.length - 1].faceUp) return 0
  let len = 1
  for (let i = column.length - 2; i >= 0; i--) {
    const cur = column[i]
    const next = column[i + 1]
    if (!cur.faceUp || cur.suit !== next.suit || cur.rank !== next.rank + 1) break
    len++
  }
  return len
}

/**
 * Ranks a legal tableau move for the Hint button (see engine/hint.ts's findHint) - Scorpion has no
 * foundation zone (same as Spider), so without this every legal move sorts in raw enumeration
 * order. Adapted from Spider's own scoreHintMove (see that file's doc comment for the full
 * "opportunity-cost run valuation" rationale) rather than copied verbatim, because Scorpion's move
 * rule is looser than Spider's: any face-up card plus everything stacked on it may move together
 * REGARDLESS of whether that group is itself a valid run (this file's header comment) - only the
 * group's own bottom card needs to continue the destination by suit/rank. So a moved group can be
 * "dirty": it may reach past the source's own coherent top run (`runLengthAtTop`) and drag along
 * cards that don't belong to any run at all. Spider can get away with a `count + destRunLenBefore`
 * shortcut for the destination's new run length because its groups are always internally valid by
 * construction; that shortcut would overcount here (crediting a dirty group as if every card in it
 * extended the run). Instead this measures the ACTUAL resulting run lengths directly -
 * `runLengthAtTop` on the merged destination pile, and on the leftover source remainder - which
 * collapses to the exact same numbers Spider's shortcut would produce whenever the moved group
 * happens to be clean (count <= the source's own runLen), and degrades gracefully (no false credit)
 * whenever it isn't.
 *
 * Highest priority: completing a full King->Ace same-suit run outright (unconditional 1000, same
 * threshold Spider uses for the same reason - there's no separate foundation zone to sort this move
 * first the way findHint does for games that have one). Unlike Spider, a completed run here isn't
 * spliced out into a separate `completed` list - it just stays put as the column's own permanent,
 * sealed contents (see this file's header comment and isWon) - but the check is otherwise identical:
 * did this move leave some column with exactly a face-up, King-to-Ace, same-suit run at its top.
 *
 * Below that, the same three terms Spider's scorer uses, weighted identically - `netRunStructureChange`
 * (best coherent run this move leaves behind anywhere, destination or source remainder, versus what
 * the source's own top run was worth before), `netEmptyDelta` (actual before/after change in how
 * many tableau columns are empty - Scorpion's only scarce maneuvering resource, no freecells here),
 * and a flat reveal bonus for exposing a previously face-down card. The same weight-bounding argument
 * from Spider's comment carries over unchanged: a same-suit descending run still caps at 13 cards
 * (ranks 1-13, no wraparound), so netRunStructureChange's realistic ceiling and the reveal/completion
 * gates stay in the same relative order regardless of board specifics.
 */
function scoreHintMove(state: ScorpionState, move: Move): number {
  if (move.from.zone !== 'tableau' || move.to.zone !== 'tableau') return 0
  const fromCol = state.tableau[move.from.index]
  const toCol = state.tableau[move.to.index]
  if (!fromCol || !toCol) return 0
  const group = fromCol.slice(fromCol.length - move.count)
  const merged = [...toCol, ...group]
  if (merged.length === 13) {
    if (merged[0].rank === 13 && merged.every((c) => c.faceUp) && isDescendingSameSuit(merged)) return 1000
  }

  const runLen = runLengthAtTop(fromCol)
  const newRunLenAtDest = runLengthAtTop(merged)
  const remainder = fromCol.slice(0, fromCol.length - move.count)
  const remainderRunLen = runLengthAtTop(remainder)
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

export function createScorpionController(assistedStock: boolean): GameController<ScorpionState> {
  function newGame(seed: number): ScorpionState {
    const deck = shuffledDeck(seed, 1)
    let cursor = 0
    const tableau: Card[][] = []

    for (let col = 0; col < FRONT_COLUMNS; col++) {
      const cards: Card[] = []
      for (let i = 0; i < 7; i++) {
        const card = deck[cursor++]
        cards.push({ ...card, faceUp: i >= FACE_DOWN_PER_FRONT_COLUMN })
      }
      tableau.push(cards)
    }

    const backColumnCount = assistedStock ? 7 : 8
    for (let col = FRONT_COLUMNS; col < NUM_COLUMNS; col++) {
      const cards: Card[] = []
      for (let i = 0; i < backColumnCount; i++) {
        const card = deck[cursor++]
        cards.push({ ...card, faceUp: true })
      }
      tableau.push(cards)
    }

    const stock: Card[] = assistedStock ? deck.slice(cursor).map((c) => ({ ...c, faceUp: false })) : []
    return { tableau, stock }
  }

  function tryMove(state: ScorpionState, move: Move): ScorpionState | null {
    const { from, to, count } = move
    if (count < 1) return null
    if (from.zone !== 'tableau' || to.zone !== 'tableau') return null
    if (from.index === to.index) return null
    const fromCol = state.tableau[from.index]
    const toCol = state.tableau[to.index]
    if (!fromCol || !toCol) return null
    if (count > fromCol.length) return null

    const group = fromCol.slice(fromCol.length - count)
    if (!group.every((c) => c.faceUp)) return null
    // No internal-validity requirement on `group` itself - see this file's header comment.
    if (!canPlaceOnTableau(toCol, group)) return null

    const next = cloneState(state)
    const nextFrom = next.tableau[from.index]
    const nextTo = next.tableau[to.index]
    const moved = nextFrom.splice(nextFrom.length - count, count)
    nextTo.push(...moved)

    const newTop = nextFrom[nextFrom.length - 1]
    if (newTop && !newTop.faceUp) newTop.faceUp = true

    return next
  }

  /** Deals the whole held-back stock at once (always exactly 3 cards when non-empty - see
   * newGame), one card onto the top of each of the last 3 columns - the assisted variant's
   * one-shot lifeline. A no-op (returns null) for the classic variant, whose stock is always
   * empty. */
  function drawStock(state: ScorpionState): ScorpionState | null {
    if (state.stock.length === 0) return null
    const next = cloneState(state)
    for (let i = 0; i < next.stock.length; i++) {
      next.tableau[FRONT_COLUMNS + i].push({ ...next.stock[i], faceUp: true })
    }
    next.stock = []
    return next
  }

  function isWon(state: ScorpionState): boolean {
    return state.tableau.every((col) => col.length === 0 || (col.length === 13 && isDescendingSameSuit(col)))
  }

  function legalMoves(state: ScorpionState): Move[] {
    return computeLegalMoves(state)
  }

  function isStuck(state: ScorpionState): boolean {
    if (state.stock.length > 0) return false // the assisted stock is always a way out while it remains
    return computeLegalMoves(state).length === 0
  }

  function autoMoveHint(state: ScorpionState, from: PileRef, cardId: string): Move | null {
    if (from.zone !== 'tableau') return null
    const col = state.tableau[from.index]
    if (!col) return null
    const cardIndex = col.findIndex((c) => c.id === cardId)
    if (cardIndex === -1) return null
    const movingCards = col.slice(cardIndex)
    if (movingCards.some((c) => !c.faceUp)) return null
    const count = movingCards.length

    const candidates = state.tableau
      .map((destCol, index) => ({ index, pile: destCol }))
      .filter((c) => c.index !== from.index)
      .filter((c) => canPlaceOnTableau(c.pile, movingCards))
    // alwaysValidRun: every face-up group is liftable regardless of internal order (see this
    // file's header comment) - same "no run-validity requirement" reasoning Yukon's own
    // autoMoveHint uses this exact helper for.
    const best = pickBestTableauTarget(candidates, alwaysValidRun)
    if (!best) return null
    return { from, to: { zone: 'tableau', index: best.index }, count }
  }

  return {
    id: 'scorpion',
    title: 'Scorpion',
    newGame,
    legalMoves,
    tryMove,
    drawStock,
    isWon,
    isStuck,
    autoMoveHint,
    scoreHintMove
  }
}
