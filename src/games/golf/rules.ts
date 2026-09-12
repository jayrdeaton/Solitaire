// Golf solitaire game rules & controller.
//
// Board: 7 tableau columns of 5 cards each, all dealt face up (35 cards) - no face-down tableau
// cards at all, unlike every other game here. A single build pile ("waste", reusing that zone name
// so components/StockWaste.tsx works unmodified) starts with one card flipped from the remaining
// 17; the other 16 are the stock. Any tableau column's top card may move onto the build pile if its
// rank is exactly one above or one below the build pile's current top card, regardless of suit or
// color - Ace and King are NOT adjacent (no wraparound), matching the most common Golf ruleset.
// Drawing from stock (draw-1, no redeals - once stock is empty it's empty for good, unlike every
// other game here, which allows recycling) replaces the build pile's top card with the next stock
// card, whether or not any tableau move was available. The game is won once every tableau column is
// empty (there is no suit-based foundation at all, so engine/autoFoundation.ts doesn't apply here).

import { shuffledDeck } from '@/engine/deck'
import { GameController, Move, PileRef } from '@/engine/gameTypes'
import { top } from '@/engine/pile'
import { Card, cloneCard } from '@/engine/types'

export interface GolfState {
  /** 7 tableau columns, 5 cards each at deal, all face up. */
  tableau: Card[][]
  /** The single build pile - top card is the current target rank. Starts with 1 card. */
  waste: Card[]
  /** Face-down draw pile, 16 cards at deal. No recycling once empty. */
  stock: Card[]
}

function cloneState(state: GolfState): GolfState {
  return {
    tableau: state.tableau.map((col) => col.map(cloneCard)),
    waste: state.waste.map(cloneCard),
    stock: state.stock.map(cloneCard)
  }
}

function newGame(seed: number): GolfState {
  const deck = shuffledDeck(seed, 1)
  let cursor = 0
  const tableau: Card[][] = []
  for (let col = 0; col < 7; col++) {
    const cards: Card[] = []
    for (let i = 0; i < 5; i++) {
      const card = deck[cursor++]
      cards.push({ ...card, faceUp: true })
    }
    tableau.push(cards)
  }
  const starter = deck[cursor++]
  const waste: Card[] = [{ ...starter, faceUp: true }]
  const stock: Card[] = deck.slice(cursor).map((c) => ({ ...c, faceUp: false }))
  return { tableau, waste, stock }
}

/** Adjacent by rank only, no suit/color requirement. Ace and King are also adjacent when
 * `wrapAceKing` is set (settings.golfRankWrap) - off by default, matching this game's original
 * hardcoded no-wrap behavior. */
function isAdjacentRank(a: Card, b: Card, wrapAceKing: boolean): boolean {
  if (Math.abs(a.rank - b.rank) === 1) return true
  return wrapAceKing && ((a.rank === 1 && b.rank === 13) || (a.rank === 13 && b.rank === 1))
}

function drawStock(state: GolfState): GolfState | null {
  if (state.stock.length === 0) return null // no recycling - a real dealer's stock runs out for good
  const next = cloneState(state)
  const card = next.stock.pop()!
  card.faceUp = true
  next.waste.push(card)
  return next
}

function isWon(state: GolfState): boolean {
  return state.tableau.every((col) => col.length === 0)
}

/** Closes over `wrapAceKing` (settings.golfRankWrap) - the only rule this game's move logic varies
 * by, so only the functions that actually consult isAdjacentRank move inside this factory;
 * newGame/drawStock/isWon are wrap-independent and stay as plain module-level functions above. */
export function createGolfController(wrapAceKing: boolean): GameController<GolfState> {
  function tryMove(state: GolfState, move: Move): GolfState | null {
    const { from, to, count } = move
    if (count !== 1) return null // Golf never moves more than one card at a time
    if (from.zone !== 'tableau') return null
    if (to.zone !== 'waste' || to.index !== 0) return null

    const col = state.tableau[from.index]
    if (!col || col.length === 0) return null
    const movingCard = top(col)!
    const wasteTop = top(state.waste)
    if (!wasteTop) return null
    if (!isAdjacentRank(movingCard, wasteTop, wrapAceKing)) return null

    const next = cloneState(state)
    next.tableau[from.index].pop()
    next.waste.push({ ...movingCard })
    return next
  }

  function legalMoves(state: GolfState): Move[] {
    const moves: Move[] = []
    const wasteTop = top(state.waste)
    if (!wasteTop) return moves
    state.tableau.forEach((col, index) => {
      const t = top(col)
      if (t && isAdjacentRank(t, wasteTop, wrapAceKing)) {
        moves.push({ from: { zone: 'tableau', index }, to: { zone: 'waste', index: 0 }, count: 1 })
      }
    })
    return moves
  }

  /** True once no tableau move is available AND the stock is exhausted - unlike every other game
   * here, Golf has no recycling to fall back on, so this is a real, common way to lose. */
  function isStuck(state: GolfState): boolean {
    return state.stock.length === 0 && legalMoves(state).length === 0
  }

  /** Golf has exactly one possible destination (the build pile), so this either finds that it's
   * legal or that it isn't - no ranking between alternatives the way Klondike/Yukon need. */
  function autoMoveHint(state: GolfState, from: PileRef, cardId: string): Move | null {
    if (from.zone !== 'tableau') return null
    const col = state.tableau[from.index]
    const t = top(col)
    if (!t || t.id !== cardId) return null
    const wasteTop = top(state.waste)
    if (!wasteTop || !isAdjacentRank(t, wasteTop, wrapAceKing)) return null
    return { from, to: { zone: 'waste', index: 0 }, count: 1 }
  }

  /**
   * Optional Hint-quality scorer - see engine/hint.ts's findHint and this repo's own Spider
   * (src/games/spider/rules.ts) for the general shape/rationale of this field. Every legal Golf
   * move targets the same single destination (the build pile - see legalMoves/autoMoveHint above),
   * so unlike Spider there's no "which destination" question at all, only "which of several
   * currently-playable columns is the better one to play right now." Most of Spider's own design
   * doesn't transfer literally:
   *  - There's no "coherent run" to build or fragment - every Golf move is a single top card with
   *    no internal ordering constraint between cards at all (see tryMove above), so
   *    netRunStructureChange has no Golf equivalent.
   *  - There's no "reveals a hidden card" signal either - every Golf tableau card is dealt face up
   *    (see newGame above, and this file's own top doc comment: "no face-down tableau cards at all,
   *    unlike every other game here"), so the card sitting underneath a played card is already fully
   *    known before the move; there's nothing to "reveal."
   *
   * What Golf DOES have, that raw legalMoves() column-scan order is blind to: playing one column's
   * top card changes the build pile's own top rank, which can strand OTHER currently-legal cards a
   * move later, or unlock an immediate follow-up move from the very column just played. Concretely:
   * waste=6, column A top=5 (with a 4 right underneath), column B top=7 (with a King underneath) are
   * both legal right now. Playing A sets the build pile to 5 - which A's own newly-exposed 4 is
   * immediately adjacent to, a free follow-up move - while B's King underneath stays dead either
   * way. Playing B instead sets the build pile to 7, which stops BOTH A's un-played 5 (diff 2, now
   * illegal) and B's own newly-exposed King (diff 6) from being playable, forcing an early stock draw
   * where playing A first would have kept the board moving for free. This scorer gives Hint a way to
   * prefer A over B here via a one-ply lookahead (`followUpMoves`): how many tableau moves are legal
   * immediately after this one, across the whole board (not just the column just played, since
   * playing one column can also unlock or strand a completely different one).
   *
   * The other real Golf signal: a tableau column, once played down to empty, can never receive a
   * card again (no game here deals back onto the tableau) - emptying one is a permanent,
   * irreversible reduction in how many columns still need clearing before the win condition (isWon:
   * every column empty). That's weighted well above a single unit of `followUpMoves` (a flat, large
   * bonus, same shape as Spider's own `revealsHiddenCard` flat bonus) since it's a strictly bigger,
   * structural gain than any one extra follow-up move.
   *
   * The `+ 1` floor keeps every legal Golf move's score strictly positive - unlike Spider (where a
   * badly fragmenting move can legitimately score negative, tipping findHint toward suggesting a
   * stock draw instead), no single-card Golf move is ever actually WORSE than drawing: it always
   * removes a card from a column that can only ever shrink, and never spends the scarce,
   * non-recycling stock resource the way a draw does. So this scorer only ever RANKS among already-
   * legal moves - it must never cross zero and accidentally trip findHint's "every move scored
   * non-positive, suggest a stock draw instead" fallback while a tableau move is actually available.
   */
  function scoreHintMove(state: GolfState, move: Move): number {
    const next = tryMove(state, move)
    if (!next) return 0
    const fromCol = state.tableau[move.from.index]
    const emptiesColumn = fromCol.length === move.count
    const followUpMoves = legalMoves(next).length
    return 1 + followUpMoves * 10 + (emptiesColumn ? 100 : 0)
  }

  return {
    id: 'golf',
    title: 'Golf',
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
