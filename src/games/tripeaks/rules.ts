// TriPeaks solitaire game rules & controller.
//
// Board: 28 cards across 4 rows of widths [3, 6, 9, 10] (3 peaks sharing one 10-wide base row, each
// peak's own apex/row1/row2 a self-contained 3-row mini-pyramid over a 4-wide slice of that base -
// adjacent peaks' 4-wide base slices overlap by 1 shared column, so the 3 peaks' bases span 4+4+4-2
// = 10 columns, not 12), stored as a flat 28-length array like Pyramid's own `pyramid` field. Unlike
// Pyramid (whose whole 28 cards are dealt face up), only the bottom row (10 cards) starts face up -
// the 18 cards in the upper 3 rows are genuinely covered and only become playable, one card at a
// time, once BOTH cards directly beneath them (in the row below) have been removed - exactly
// Pyramid's own `isExposed` idea, generalized from Pyramid's uniform "+1 per row" triangle to
// TriPeaks' per-peak row widths. `faceUp` is not read for game logic here (kept `true` on every
// stored tableau card, same as Pyramid) - "exposed" is the single source of truth for both
// playability (this file) and face-up rendering (TriPeaksScreen.tsx), so there is no separate
// reveal/flip state to track.
//
// Move rule is Golf's, not Pyramid's: a single exposed tableau card may move onto the waste/build
// pile if its rank is exactly one above or below the pile's current top card (any suit, no
// Ace-King wraparound) - not Pyramid's "pairs summing to 13". The remaining 24 cards split into a
// 1-card waste starter and a 23-card stock; draw-1, no recycling once stock is empty, same as Golf.

import { shuffledDeck } from '@/engine/deck'
import { GameController, Move, PileRef } from '@/engine/gameTypes'
import { top } from '@/engine/pile'
import { Card } from '@/engine/types'

export interface TriPeaksState {
  /** Flat 28-slot board across 4 rows (widths 3,6,9,10 - see ROW_STARTS); `null` once removed. */
  tableau: (Card | null)[]
  /** The single build pile - top card is the current target rank. Starts with 1 card. */
  waste: Card[]
  /** Face-down draw pile, 23 cards at deal. No recycling once empty. */
  stock: Card[]
}

export const ROW_WIDTHS = [3, 6, 9, 10]
/** ROW_STARTS[row]..ROW_STARTS[row+1]-1 are that row's flat indices; ROW_STARTS[4] (28) is the total. */
const ROW_STARTS = [0, 3, 9, 18, 28]
const TOTAL = 28

/** Flat array index for the card at (row, col), 0-indexed, col from 0..ROW_WIDTHS[row]-1. */
export function flatIndex(row: number, col: number): number {
  return ROW_STARTS[row] + col
}

/** Inverse of flatIndex: which (row, col) a flat index corresponds to. */
export function rowColOf(index: number): { row: number; col: number } {
  let row = 0
  while (ROW_STARTS[row + 1] <= index) row++
  return { row, col: index - ROW_STARTS[row] }
}

/**
 * The two flat indices of the cards directly beneath (row, col) that must both be removed before
 * it's exposed - null for row 3 (the base row), which has nothing beneath it. Row 0 -> row 1 and
 * row 1 -> row 2 stay within one peak's own 1/2/3-wide mini-pyramid (peak = col / thisRowWidthPerPeak);
 * row 2 -> row 3 lands in that same peak's 4-wide base slice, which starts 3 columns (not 4) into
 * the shared base row - the source of the 1-column overlap between adjacent peaks' bases. Exported
 * so TriPeaksScreen.tsx can lay out each card at the horizontal midpoint of its own two children
 * (recursively, bottom-up from the base row) using this exact same adjacency, rather than a second,
 * independently-derived copy of the same peak math that could silently drift out of sync with it.
 */
export function childIndices(row: number, col: number): [number, number] | null {
  if (row === 3) return null
  if (row === 0) {
    // One apex per peak (col === peak index) sits over that peak's own first row-1 pair.
    return [flatIndex(1, col * 2), flatIndex(1, col * 2 + 1)]
  }
  if (row === 1) {
    const peak = Math.floor(col / 2)
    const local = col % 2
    const base = peak * 3 + local
    return [flatIndex(2, base), flatIndex(2, base + 1)]
  }
  // row === 2
  const peak = Math.floor(col / 3)
  const local = col % 3
  const base = peak * 3 + local
  return [flatIndex(3, base), flatIndex(3, base + 1)]
}

/**
 * A tableau card at (row, col) is exposed (removable, and rendered face up) once both cards
 * resting on it in the row below have been removed. Row 3 (the base row) is always exposed if
 * occupied - nothing rests on it.
 */
export function isExposed(tableau: (Card | null)[], row: number, col: number): boolean {
  const idx = flatIndex(row, col)
  if (!tableau[idx]) return false
  const children = childIndices(row, col)
  if (!children) return true
  const [a, b] = children
  return !tableau[a] && !tableau[b]
}

function isExposedAt(tableau: (Card | null)[], index: number): boolean {
  const { row, col } = rowColOf(index)
  return isExposed(tableau, row, col)
}

/**
 * How many currently-covered tableau cards would become newly exposed if the card at `index` were
 * removed right now. Not every exposed, rank-adjacent card unlocks the same amount of the board: a
 * parent card can be shared between two children (see childIndices' doc comment on the row1/row2
 * and row2/row3 overlaps) - removing one child flips a shared parent on only once its *other* child
 * is already gone, so a single removal can newly expose 0, 1, or 2 parents at once. Reuses
 * isExposedAt (this file's single source of truth for exposed/playable) by simulating the removal
 * and re-checking every remaining card's exposure before vs. after, rather than building a separate
 * parent-lookup table that could drift out of sync with childIndices.
 */
function countNewlyExposed(tableau: (Card | null)[], index: number): number {
  const after = tableau.slice()
  after[index] = null
  let count = 0
  for (let i = 0; i < TOTAL; i++) {
    if (i === index || !after[i]) continue
    if (!isExposedAt(tableau, i) && isExposedAt(after, i)) count++
  }
  return count
}

/**
 * Ranks legal moves by how much of the board they unlock, not just legalMoves()'s raw scan order.
 * TriPeaks has exactly one destination (the build pile - see the module doc comment and
 * autoMoveHint below), so unlike Spider there's no destination choice to collapse and no run to
 * fragment - the only thing that distinguishes one legal move from another is how many newly-
 * exposed cards it produces (see countNewlyExposed). Every legal move still scores strictly
 * positive (a flat +1 baseline) so this never trips findHint's "every move scored non-positive,
 * suggest a stock draw instead" fallback: unlike Spider, a zero-exposure TriPeaks play is never
 * harmful busywork - it still removes a card for free - so it should never lose to a stock draw,
 * which is TriPeaks' actually scarce, non-recycling resource. Only the ranking AMONG already-legal
 * tableau plays should reward exposure.
 */
function scoreHintMove(state: TriPeaksState, move: Move): number {
  if (move.from.zone !== 'tableau' || move.to.zone !== 'waste') return 0
  return 1 + countNewlyExposed(state.tableau, move.from.index)
}

/** Adjacent by rank only, no suit/color requirement - Golf's rule. Ace and King are also adjacent
 * when `wrapAceKing` is set (settings.tripeaksRankWrap) - off by default, matching this game's
 * original hardcoded no-wrap behavior. */
function isAdjacentRank(a: Card, b: Card, wrapAceKing: boolean): boolean {
  if (Math.abs(a.rank - b.rank) === 1) return true
  return wrapAceKing && ((a.rank === 1 && b.rank === 13) || (a.rank === 13 && b.rank === 1))
}

// Shallow: `state` itself is never mutated by the functions below, so a fresh top-level object
// (sharing the exact same tableau/waste/stock array references) is enough on its own - drawStock/
// tryMove each replace only the one or two pile arrays they actually touch (via fresh .slice()s),
// and clone an individual card only at the one spot its faceUp is actually flipped in place (see
// drawStock). Every untouched card - the other 22-27 tableau cards on a tableau move, the rest of
// the waste/stock piles either way - keeps its exact pre-move object identity.
function cloneState(state: TriPeaksState): TriPeaksState {
  return {
    tableau: state.tableau,
    waste: state.waste,
    stock: state.stock
  }
}

function newGame(seed: number): TriPeaksState {
  const deck = shuffledDeck(seed, 1)
  const tableau: (Card | null)[] = deck.slice(0, TOTAL).map((c) => ({ ...c, faceUp: true }))
  const starter = deck[TOTAL]
  const waste: Card[] = [{ ...starter, faceUp: true }]
  const stock: Card[] = deck.slice(TOTAL + 1).map((c) => ({ ...c, faceUp: false }))
  return { tableau, waste, stock }
}

export function cardAt(state: TriPeaksState, ref: PileRef): Card | null {
  if (ref.zone === 'tableau') return state.tableau[ref.index] ?? null
  if (ref.zone === 'waste') return top(state.waste) ?? null
  return null
}

function drawStock(state: TriPeaksState): TriPeaksState | null {
  if (state.stock.length === 0) return null // no recycling, same as Golf
  const next = cloneState(state)
  const nextStock = next.stock.slice()
  const nextWaste = next.waste.slice()
  const card = nextStock.pop()!
  // Stock cards are always dealt faceUp:false (see newGame) and only ever flip here, so this
  // always clones - the `faceUp` check just mirrors the defensive pattern used elsewhere rather
  // than assuming that invariant holds forever.
  nextWaste.push(card.faceUp ? card : { ...card, faceUp: true })
  next.stock = nextStock
  next.waste = nextWaste
  return next
}

function isWon(state: TriPeaksState): boolean {
  return state.tableau.every((c) => c === null)
}

/** Closes over `wrapAceKing` (settings.tripeaksRankWrap) - the only rule this game's move logic
 * varies by, so only the functions that actually consult isAdjacentRank move inside this factory;
 * newGame/drawStock/isWon are wrap-independent and stay as plain module-level functions above. */
export function createTriPeaksController(wrapAceKing: boolean): GameController<TriPeaksState> {
  function tryMove(state: TriPeaksState, move: Move): TriPeaksState | null {
    const { from, to, count } = move
    if (count !== 1) return null
    if (from.zone !== 'tableau') return null
    if (to.zone !== 'waste' || to.index !== 0) return null

    const card = state.tableau[from.index]
    if (!card) return null
    if (!isExposedAt(state.tableau, from.index)) return null
    const wasteTop = top(state.waste)
    if (!wasteTop) return null
    if (!isAdjacentRank(card, wasteTop, wrapAceKing)) return null

    const next = cloneState(state)
    const nextTableau = next.tableau.slice()
    const nextWaste = next.waste.slice()
    nextTableau[from.index] = null
    // `card` is relocated, not changed (tableau cards are always faceUp:true already - see the
    // module doc comment) - keep its exact object reference rather than cloning it.
    nextWaste.push(card)
    next.tableau = nextTableau
    next.waste = nextWaste
    return next
  }

  function legalMoves(state: TriPeaksState): Move[] {
    const moves: Move[] = []
    const wasteTop = top(state.waste)
    if (!wasteTop) return moves
    for (let i = 0; i < TOTAL; i++) {
      const card = state.tableau[i]
      if (card && isExposedAt(state.tableau, i) && isAdjacentRank(card, wasteTop, wrapAceKing)) {
        moves.push({ from: { zone: 'tableau', index: i }, to: { zone: 'waste', index: 0 }, count: 1 })
      }
    }
    return moves
  }

  /** True once no tableau move is available AND the stock is exhausted - same shape as Golf's. */
  function isStuck(state: TriPeaksState): boolean {
    return !isWon(state) && state.stock.length === 0 && legalMoves(state).length === 0
  }

  /** TriPeaks has exactly one possible destination (the build pile), same as Golf - no ranking
   * between alternatives. */
  function autoMoveHint(state: TriPeaksState, from: PileRef, cardId: string): Move | null {
    if (from.zone !== 'tableau') return null
    const card = state.tableau[from.index]
    if (!card || card.id !== cardId) return null
    if (!isExposedAt(state.tableau, from.index)) return null
    const wasteTop = top(state.waste)
    if (!wasteTop || !isAdjacentRank(card, wasteTop, wrapAceKing)) return null
    return { from, to: { zone: 'waste', index: 0 }, count: 1 }
  }

  return {
    id: 'tripeaks',
    title: 'TriPeaks',
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
