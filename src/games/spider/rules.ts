import { pickBestTableauTarget } from '@/engine/autoMove'
import { shuffledDeck } from '@/engine/deck'
import { GameController, Move, PileRef } from '@/engine/gameTypes'
import { isDescendingSameSuit, top } from '@/engine/pile'
import { Card, SUITS } from '@/engine/types'

export interface SpiderState {
  tableau: Card[][]
  stock: Card[]
  /** One entry per completed King->Ace same-suit run, in completion order - the King itself,
   * which the screen shows in that sequence's "foundation" slot (see resolveCompletedSequence). */
  completed: Card[]
  /** One entry per completed run, same order/index as `completed` - the full 13-card run (King
   * first, Ace last), captured before resolveCompletedSequence's splice discards everything but
   * the King. Never read by any game rule, only by the win-cascade animation (see
   * components/winning/), which needs the whole run to chain through, not just its King. */
  completedRuns: Card[][]
}

const NUM_COLUMNS = 10
const DEAL_COUNTS = [6, 6, 6, 6, 5, 5, 5, 5, 5, 5] // 4 columns of 6, 6 columns of 5 = 54 cards

// Shallow: a fresh outer `tableau` array (so a caller can reassign state.tableau[i] to a
// brand-new column without touching the original state's array), but every column and every
// card inside starts out as the exact SAME reference as `state`'s own - `stock`/`completed`/
// `completedRuns` start out as the exact same array references too. tryMove/drawStock below
// replace only the specific column(s)/list(s) a move actually touches, and clone an individual
// card only at the one spot its faceUp is actually flipped in place (see resolveCompletedSequence
// and the flip sites in tryMove/drawStock) - every untouched card elsewhere on the board keeps
// its exact pre-move object identity.
function cloneState(state: SpiderState): SpiderState {
  return {
    tableau: state.tableau.slice(),
    stock: state.stock,
    completed: state.completed,
    completedRuns: state.completedRuns
  }
}

/** Check the top run of a column for a completed King->Ace same-suit sequence; if found, remove
 * it and return its King (the card the screen displays in that sequence's "foundation" slot)
 * along with the full run, King first through Ace last. `tableau` must already be an array the
 * caller owns (never shared with a pre-move state) - this only ever replaces `tableau[colIndex]`
 * wholesale with a fresh slice, it never mutates the column array that was there before. */
function resolveCompletedSequence(tableau: Card[][], colIndex: number): { king: Card; run: Card[] } | null {
  const col = tableau[colIndex]
  if (col.length < 13) return null
  const topRun = col.slice(col.length - 13)
  // topRun is in dealt order (index 0 = deepest of the run); King should be at index 0 (rank 13), Ace at end (rank 1).
  if (topRun[0].rank !== 13) return null
  if (!topRun.every((c) => c.faceUp)) return null
  if (!isDescendingSameSuit(topRun)) return null
  // It's a complete run - remove it. The cards left behind keep their exact identity except the
  // new top card, which is replaced with a face-up clone (never mutated in place) if it wasn't
  // face-up already.
  const remaining = col.slice(0, col.length - 13)
  const i = remaining.length - 1
  const c = remaining[i]
  if (c && !c.faceUp) remaining[i] = { ...c, faceUp: true }
  tableau[colIndex] = remaining
  return { king: topRun[0], run: topRun }
}

function computeLegalMoves(state: SpiderState): Move[] {
  const moves: Move[] = []
  for (let from = 0; from < NUM_COLUMNS; from++) {
    const col = state.tableau[from]
    if (col.length === 0) continue
    // Find the longest valid same-suit descending run starting from the top.
    let runLen = 1
    for (let i = col.length - 1; i > 0; i--) {
      const cur = col[i]
      const prev = col[i - 1]
      if (!cur.faceUp || !prev.faceUp) break
      if (prev.rank !== cur.rank + 1 || prev.suit !== cur.suit) break
      runLen++
    }
    for (let count = 1; count <= runLen; count++) {
      const group = col.slice(col.length - count)
      if (!isDescendingSameSuit(group)) continue
      const movingBottom = group[0] // deepest (highest-rank) card of the run - lands directly on dest's top
      // Collapse straight to the single destination autoMoveHint would also pick for this same
      // (from, count) - same candidate filter, same pickBestTableauTarget call - so a move surfaced
      // here (e.g. for the Hint button) always matches where tapping that card actually sends it.
      const candidates = state.tableau
        .map((pile, index) => ({ index, pile }))
        .filter((c) => c.index !== from)
        .filter((c) => {
          const destTop = top(c.pile)
          return destTop === undefined || (destTop.faceUp && destTop.rank === movingBottom.rank + 1)
        })
      const best = pickBestTableauTarget(candidates, isDescendingSameSuit)
      if (best) {
        moves.push({ from: { zone: 'tableau', index: from }, to: { zone: 'tableau', index: best.index }, count })
      }
    }
  }
  return moves
}

/** Length of the maximal same-suit, consecutive-descending, face-up run currently sitting at the
 * top of a column - the "coherent asset" a player already holds there and could move as one unit.
 * 0 for an empty column. */
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
 * Ranks a legal tableau move for the Hint button (see engine/hint.ts's findHint) - Spider has no
 * foundation zone, so without this every legal move (including a pointless single-card shuffle
 * between two low columns) sorted in raw enumeration order, often well ahead of the multi-card run
 * move that's actually worth playing. Highest priority: completing a King->Ace run outright
 * (unconditional 1000, handled first).
 *
 * Below that, an opportunity-cost model: `R`, the length of the coherent run already sitting at
 * the top of the source column, is the "asset" a player holds there before this move. A move is
 * scored by `bestRunAfterMove - R` - the better of (a) the run this move creates at the
 * destination (extending an existing same-suit run there, if one exists) and (b) whatever coherent
 * run is left behind at the source when `count` is less than `R`. This is 0 for a move that just
 * relocates the whole existing run intact (nothing gained, nothing lost), positive when it builds
 * something longer than what was already there (e.g. extending a run, or feeding a longer run
 * elsewhere), and - critically - negative whenever the move only peels part of a coherent run onto
 * an unrelated card, fragmenting it into two pieces neither as long as the original, with nothing
 * gained to compensate. That last case was a real bug: the previous scorer rewarded a move purely
 * by how many cards it moved, so tearing the bottom card off a nice 4-card run to park it on some
 * unrelated matching card scored the same as any other harmless 1-card shuffle - never flagged as
 * the actively bad, run-destroying move it is. `netRunStructureChange` catches this without a
 * special-cased "is this a fragmentation" rule; it falls out of comparing what the move actually
 * builds against what was already there.
 *
 * Two more independent terms: `netEmptyDelta`, the actual before/after change in how many tableau
 * columns are empty (not a flat penalty for merely touching one) - freeing a new empty column is a
 * real, scarce gain; a purely lateral shuffle into the one empty column (source empties, that same
 * column stops being empty) nets to zero, exactly as it should. And `revealsHiddenCard`, kept as a
 * flat bonus since it can only ever be true when `count === R` (going deeper than the source's own
 * coherent run is the only way to expose something previously buried).
 *
 * The weights are bounds-checked, not curve-fit: `netRunStructureChange` cannot reach 12 without
 * either hitting the completion check above or getting within one card of it, so its realistic
 * ceiling (12*30=360) plus the empty-column term's ceiling (40) plus the tiny per-card tiebreak
 * (count*2, capped low) stays comfortably under the 500-point reveal bonus, which in turn stays
 * under the 1000-point completion - so completion always outranks a reveal, which always outranks
 * pure structural play, regardless of board specifics.
 */
function scoreHintMove(state: SpiderState, move: Move): number {
  if (move.from.zone !== 'tableau' || move.to.zone !== 'tableau') return 0
  const fromCol = state.tableau[move.from.index]
  const toCol = state.tableau[move.to.index]
  if (!fromCol || !toCol) return 0
  const group = fromCol.slice(fromCol.length - move.count)
  const merged = [...toCol, ...group]
  if (merged.length >= 13) {
    const topRun = merged.slice(merged.length - 13)
    if (topRun[0].rank === 13 && topRun.every((c) => c.faceUp) && isDescendingSameSuit(topRun)) return 1000
  }

  const runLen = runLengthAtTop(fromCol)
  const destRunLenBefore = runLengthAtTop(toCol)
  const sameSuitExtension = toCol.length > 0 && toCol[toCol.length - 1].suit === group[0].suit
  const newRunLenAtDest = move.count + (sameSuitExtension ? destRunLenBefore : 0)
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

export function createSpiderController(numSuits: 1 | 2 | 4): GameController<SpiderState> {
  return {
    id: 'spider',
    title: 'Spider',

    newGame(seed: number): SpiderState {
      const numDecks = 8 / numSuits
      const suitFilter = SUITS.slice(0, numSuits)
      const deck = shuffledDeck(seed, numDecks, suitFilter)

      const tableau: Card[][] = Array.from({ length: NUM_COLUMNS }, () => [])
      let cursor = 0
      for (let col = 0; col < NUM_COLUMNS; col++) {
        const count = DEAL_COUNTS[col]
        for (let i = 0; i < count; i++) {
          const card = deck[cursor++]
          card.faceUp = i === count - 1
          tableau[col].push(card)
        }
      }
      const stock = deck.slice(cursor).map((c) => ({ ...c, faceUp: false }))

      return { tableau, stock, completed: [], completedRuns: [] }
    },

    legalMoves(state: SpiderState): Move[] {
      return computeLegalMoves(state)
    },

    tryMove(state: SpiderState, move: Move): SpiderState | null {
      const { from, to, count } = move
      if (from.zone !== 'tableau' || to.zone !== 'tableau') return null
      if (from.index === to.index) return null
      const fromCol = state.tableau[from.index]
      const toCol = state.tableau[to.index]
      if (!fromCol || !toCol) return null
      if (count < 1 || count > fromCol.length) return null

      const group = fromCol.slice(fromCol.length - count)
      if (!group.every((c) => c.faceUp)) return null
      if (!isDescendingSameSuit(group)) return null

      const movingBottom = group[0] // deepest (highest-rank) card of the run - lands directly on dest's top
      if (toCol.length > 0) {
        const destTop = toCol[toCol.length - 1]
        if (!destTop.faceUp || destTop.rank !== movingBottom.rank + 1) return null
      }

      const next = cloneState(state)
      const nextFrom = next.tableau[from.index].slice()
      const nextTo = next.tableau[to.index].slice()
      const moved = nextFrom.splice(nextFrom.length - count, count)
      nextTo.push(...moved)
      next.tableau[from.index] = nextFrom
      next.tableau[to.index] = nextTo

      // Replace (never mutate) the newly-exposed source-column top card, if it wasn't face-up
      // already - every other card in nextFrom/nextTo keeps its exact pre-move identity.
      const topIndex = nextFrom.length - 1
      const newTop = nextFrom[topIndex]
      if (newTop && !newTop.faceUp) nextFrom[topIndex] = { ...newTop, faceUp: true }

      const completedSequence = resolveCompletedSequence(next.tableau, to.index)
      if (completedSequence) {
        next.completed = next.completed.concat(completedSequence.king)
        next.completedRuns = next.completedRuns.concat([completedSequence.run])
      }

      return next
    },

    drawStock(state: SpiderState): SpiderState | null {
      if (state.stock.length < NUM_COLUMNS) return null
      if (state.tableau.some((col) => col.length === 0)) return null

      const next = cloneState(state)
      const nextStock = next.stock.slice()
      for (let col = 0; col < NUM_COLUMNS; col++) {
        const card = nextStock.shift()!
        // Every dealt card genuinely flips face-up here (unlike the reveal above, there's no
        // untouched-vs-touched distinction for the drawn card itself) - but the rest of the
        // column it lands on is untouched, so build the new column via concat rather than a
        // deep clone, keeping every existing card's identity intact.
        const flipped = card.faceUp ? card : { ...card, faceUp: true }
        next.tableau[col] = next.tableau[col].concat(flipped)
      }
      next.stock = nextStock
      for (let col = 0; col < NUM_COLUMNS; col++) {
        const completedSequence = resolveCompletedSequence(next.tableau, col)
        if (completedSequence) {
          next.completed = next.completed.concat(completedSequence.king)
          next.completedRuns = next.completedRuns.concat([completedSequence.run])
        }
      }
      return next
    },

    isWon(state: SpiderState): boolean {
      return state.completed.length === 8
    },

    isStuck(state: SpiderState): boolean {
      const canDraw = state.stock.length >= NUM_COLUMNS && !state.tableau.some((col) => col.length === 0)
      if (canDraw) return false
      return computeLegalMoves(state).length === 0
    },

    autoMoveHint(state: SpiderState, from: PileRef, cardId: string): Move | null {
      if (from.zone !== 'tableau') return null
      const col = state.tableau[from.index]
      if (!col) return null
      const cardIndex = col.findIndex((c) => c.id === cardId)
      if (cardIndex === -1) return null
      const movingCards = col.slice(cardIndex)
      if (movingCards.some((c) => !c.faceUp)) return null
      if (!isDescendingSameSuit(movingCards)) return null
      const movingBottom = movingCards[0] // deepest card of the run - lands directly on dest's top
      const count = movingCards.length

      const candidates = state.tableau
        .map((destCol, index) => ({ index, pile: destCol }))
        .filter((c) => c.index !== from.index)
        .filter((c) => {
          const destTop = top(c.pile)
          return destTop === undefined || (destTop.faceUp && destTop.rank === movingBottom.rank + 1)
        })
      const best = pickBestTableauTarget(candidates, isDescendingSameSuit)
      if (!best) return null
      return { from, to: { zone: 'tableau', index: best.index }, count }
    },

    scoreHintMove
  }
}
