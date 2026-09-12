// Forty Thieves solitaire game rules & controller.
//
// Two decks (104 cards): 10 tableau columns of 4 face-up cards each (40 cards - the game's name),
// the rest a face-down stock. 8 foundation piles - two independent piles per suit, since each of
// the two decks' copies of a suit builds up separately - but NOT fixed one-suit-per-slot the way
// Klondike's 4 foundations are: a pile starts out unclaimed (empty) and only "becomes" a given
// suit's pile once its first Ace lands there (see findFoundationSlot below), the same way two
// physical foundation piles for the same suit are interchangeable on a real table.
//
// Tableau: build down by suit only (no alternating-color requirement, unlike Klondike/FreeCell/
// Yukon) - settings.fortyThievesRunMoves controls whether a valid same-suit descending run may
// move together as a shortcut, or (the classic default) only a single card may ever move at a
// time. Any single card may fill an empty column. Stock draws one card at a time onto a single
// waste pile, with NO redeal once it runs out - the same hard-classic convention Golf already
// established in this app.
//
// Auto-play-to-foundation (see isFullyAutoCompletable/nextAutoCompleteMove below) deliberately
// reimplements only "Mechanism B" from engine/autoFoundation.ts (auto-clear once the whole
// remaining game is trivially finishable via foundation moves alone) - that shared module hardcodes
// exactly one foundation pile per suit (via suitIndex), which doesn't fit this game's 8-pile,
// two-decks-per-suit layout, so it can't be reused as-is (unlike Canfield, which only changed the
// per-pile RANK rule, not the pile-per-suit COUNT, and so could still reuse it directly). The
// shared module's other half, "Mechanism A" (the continuous per-card "safe to send up early"
// heuristic), is NOT reimplemented here: it's derived from Klondike/FreeCell's alternating-COLOR
// tableau rule (a card is safe once both opposite-color foundations have caught up), which has no
// sound equivalent for a SAME-SUIT-building tableau like this one - inventing one risks auto-
// playing a card that's still genuinely needed, which is worse than never auto-playing it early.
// Auto-play here is therefore more conservative than Klondike/FreeCell/Yukon/Canfield's: it only
// ever fires once the deal is provably fully clearable, not continuously during ordinary play.

import { shuffledDeck } from '@/engine/deck'
import { AccessibleCard, GameController, Move, PileRef } from '@/engine/gameTypes'
import { isDescendingSameSuit, top } from '@/engine/pile'
import { Card } from '@/engine/types'

export interface FortyThievesState {
  /** 10 tableau columns, 4 cards each at deal, all face up. */
  tableau: Card[][]
  /** 8 independent foundation piles - see this file's header comment on why they aren't
   * fixed one-per-suit. */
  foundation: Card[][]
  /** 64-card face-down draw pile at deal. No recycling once empty. */
  stock: Card[]
  waste: Card[]
}

const NUM_COLUMNS = 10
const NUM_FOUNDATIONS = 8

// Shallow: fresh outer tableau/foundation arrays (so a caller can reassign state.tableau[i] /
// state.foundation[i] to a brand-new pile without touching the original state), but every pile
// and every card inside starts out as the exact SAME reference as `state`'s own. tryMove/
// drawStock below replace only the specific pile(s) a move actually touches (via setPile), and
// clone an individual card only at the one spot its faceUp is actually flipped in place (see
// drawStock's popped card) - every other untouched card elsewhere on the board keeps its exact
// pre-move object identity. Unlike Klondike, tryMove itself never needs to clone a card: this
// game's tableau is dealt entirely face up and only ever receives already-face-up cards (see this
// file's header comment), so there is no "reveal the newly-exposed card" flip to guard here.
function cloneState(state: FortyThievesState): FortyThievesState {
  return {
    tableau: state.tableau.slice(),
    foundation: state.foundation.slice(),
    stock: state.stock,
    waste: state.waste
  }
}

/** Writes a (already-fresh, caller-owned) pile back into `state` at `ref`. */
function setPile(state: FortyThievesState, ref: PileRef, pile: Card[]): void {
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

function canPlaceOnFoundation(dest: Card[], moving: Card): boolean {
  const destTop = top(dest)
  if (destTop === undefined) return moving.rank === 1
  return destTop.suit === moving.suit && moving.rank === destTop.rank + 1
}

/** Same suit only, one rank lower - the classic Forty Thieves tableau rule (no alternating-color
 * requirement, unlike Klondike/FreeCell/Yukon). Any single card may fill an empty column. */
function canPlaceOnTableau(dest: Card[], moving: Card): boolean {
  const destTop = top(dest)
  if (destTop === undefined) return true
  return destTop.suit === moving.suit && moving.rank === destTop.rank - 1
}

/** Which foundation pile `card` belongs on: a non-empty pile of its own suit already waiting for
 * exactly this rank, or - failing that - an unclaimed (empty) pile, but only for an Ace (nothing
 * else may start a fresh pile). Returns null if neither exists (e.g. a non-Ace whose suit hasn't
 * been started at all yet, or whose two piles are both already ahead of or behind this rank). */
function findFoundationSlot(foundation: Card[][], card: Card): number | null {
  for (let f = 0; f < NUM_FOUNDATIONS; f++) {
    if (foundation[f].length > 0 && canPlaceOnFoundation(foundation[f], card)) return f
  }
  if (card.rank === 1) {
    const emptyIndex = foundation.findIndex((pile) => pile.length === 0)
    if (emptyIndex !== -1) return emptyIndex
  }
  return null
}

/** Length of the coherent same-suit descending run (isDescendingSameSuit's own rule) sitting at the
 * top of a column - the "asset" a player already holds there, for scoreHintMove below. Unlike
 * Spider's own version of this helper, no face-up check is needed: every FortyThieves tableau card
 * is dealt face up and only ever receives already-face-up cards from moves (see this file's header
 * comment) - a face-down tableau card never exists here at all. 0 for an empty column. */
function runLengthAtTop(column: Card[]): number {
  if (column.length === 0) return 0
  let len = 1
  for (let i = column.length - 2; i >= 0; i--) {
    const cur = column[i]
    const next = column[i + 1]
    if (cur.suit !== next.suit || cur.rank !== next.rank + 1) break
    len++
  }
  return len
}

function getPile(state: FortyThievesState, ref: PileRef): Card[] | null {
  switch (ref.zone) {
    case 'tableau':
      return state.tableau[ref.index] ?? null
    case 'foundation':
      return state.foundation[ref.index] ?? null
    case 'waste':
      return state.waste
    default:
      return null
  }
}

function newGame(seed: number): FortyThievesState {
  const deck = shuffledDeck(seed, 2)
  let cursor = 0
  const tableau: Card[][] = []
  for (let col = 0; col < NUM_COLUMNS; col++) {
    const cards: Card[] = []
    for (let i = 0; i < 4; i++) cards.push({ ...deck[cursor++], faceUp: true })
    tableau.push(cards)
  }
  const foundation: Card[][] = Array.from({ length: NUM_FOUNDATIONS }, () => [])
  const stock: Card[] = deck.slice(cursor).map((c) => ({ ...c, faceUp: false }))
  return { tableau, foundation, stock, waste: [] }
}

function drawStock(state: FortyThievesState): FortyThievesState | null {
  if (state.stock.length === 0) return null // no recycling - a real dealer's stock runs out for good
  const next = cloneState(state)
  const nextStock = next.stock.slice()
  const nextWaste = next.waste.slice()
  const card = nextStock.pop()!
  nextWaste.push(card.faceUp ? card : { ...card, faceUp: true })
  setPile(next, { zone: 'stock', index: 0 }, nextStock)
  setPile(next, { zone: 'waste', index: 0 }, nextWaste)
  return next
}

function isWon(state: FortyThievesState): boolean {
  return state.foundation.every((pile) => pile.length === 13)
}

/** Every card currently reachable without drawing from stock - waste top and each tableau
 * column's top card - for the auto-complete-to-foundation feature (see this file's header
 * comment). */
function accessibleCards(state: FortyThievesState): AccessibleCard[] {
  const result: AccessibleCard[] = []
  const wasteTop = top(state.waste)
  if (wasteTop) result.push({ ref: { zone: 'waste', index: 0 }, card: wasteTop })
  state.tableau.forEach((pile, index) => {
    const t = top(pile)
    if (t) result.push({ ref: { zone: 'tableau', index }, card: t })
  })
  return result
}

/** Closes over `runMoves` (settings.fortyThievesRunMoves) - the only rule this game's tableau move
 * logic varies by. */
export function createFortyThievesController(runMoves: boolean): GameController<FortyThievesState> {
  function tryMove(state: FortyThievesState, move: Move): FortyThievesState | null {
    const { from, to, count } = move
    if (count < 1) return null
    if (from.zone === to.zone && from.index === to.index) return null
    if (from.zone === 'foundation') return null // cards never move back out of foundation
    if (from.zone === 'stock') return null // stock cards only move via drawStock

    const sourcePile = getPile(state, from)
    if (!sourcePile || sourcePile.length < count) return null

    // Only a tableau-to-tableau move may carry more than one card, and only when runMoves is on -
    // the classic default is strictly one card at a time, everywhere.
    if (count > 1 && (from.zone !== 'tableau' || to.zone !== 'tableau' || !runMoves)) return null

    const movingCards = sourcePile.slice(sourcePile.length - count)
    if (movingCards.some((c) => !c.faceUp)) return null
    if (count > 1 && !isDescendingSameSuit(movingCards)) return null

    const destPile = getPile(state, to)
    if (!destPile) return null

    if (to.zone === 'tableau') {
      if (!canPlaceOnTableau(destPile, movingCards[0])) return null
    } else if (to.zone === 'foundation') {
      if (count !== 1) return null
      if (!canPlaceOnFoundation(destPile, movingCards[0])) return null
    } else {
      return null // cards never move onto waste via tryMove
    }

    const next = cloneState(state)
    const nextSourcePile = getPile(next, from)!.slice()
    const nextDestPile = getPile(next, to)!.slice()
    setPile(next, from, nextSourcePile)
    setPile(next, to, nextDestPile)
    const moved = nextSourcePile.splice(nextSourcePile.length - count, count)
    nextDestPile.push(...moved)
    return next
  }

  function legalMoves(state: FortyThievesState): Move[] {
    const moves: Move[] = []
    const tryAdd = (from: PileRef, to: PileRef, count: number) => {
      if (tryMove(state, { from, to, count })) moves.push({ from, to, count })
    }

    if (state.waste.length > 0) {
      const from: PileRef = { zone: 'waste', index: 0 }
      for (let f = 0; f < NUM_FOUNDATIONS; f++) tryAdd(from, { zone: 'foundation', index: f }, 1)
      for (let t = 0; t < NUM_COLUMNS; t++) tryAdd(from, { zone: 'tableau', index: t }, 1)
    }

    for (let col = 0; col < NUM_COLUMNS; col++) {
      const pile = state.tableau[col]
      if (pile.length === 0) continue
      const from: PileRef = { zone: 'tableau', index: col }
      for (let f = 0; f < NUM_FOUNDATIONS; f++) tryAdd(from, { zone: 'foundation', index: f }, 1)

      let runLen = 1
      if (runMoves) {
        for (let i = pile.length - 1; i > 0; i--) {
          const cur = pile[i]
          const prev = pile[i - 1]
          if (prev.rank !== cur.rank + 1 || prev.suit !== cur.suit) break
          runLen++
        }
      }
      for (let count = 1; count <= runLen; count++) {
        for (let t = 0; t < NUM_COLUMNS; t++) {
          if (t === col) continue
          tryAdd(from, { zone: 'tableau', index: t }, count)
        }
      }
    }

    return moves
  }

  /** No recycling once the stock is empty (see drawStock), so unlike Canfield/Klondike this never
   * needs to also check the waste - same shape Golf/TriPeaks use for their own no-recycle stock. */
  function isStuck(state: FortyThievesState): boolean {
    return state.stock.length === 0 && legalMoves(state).length === 0
  }

  function autoMoveHint(state: FortyThievesState, from: PileRef, cardId: string): Move | null {
    const pile = getPile(state, from)
    if (!pile) return null
    const cardIndex = pile.findIndex((c) => c.id === cardId)
    if (cardIndex === -1) return null
    const movingCards = pile.slice(cardIndex)
    if (movingCards.some((c) => !c.faceUp)) return null
    const count = movingCards.length
    if (count > 1 && (from.zone !== 'tableau' || !runMoves || !isDescendingSameSuit(movingCards))) return null

    if (count === 1) {
      const slot = findFoundationSlot(state.foundation, movingCards[0])
      if (slot !== null) return { from, to: { zone: 'foundation', index: slot }, count: 1 }
    }

    for (let t = 0; t < NUM_COLUMNS; t++) {
      if (from.zone === 'tableau' && from.index === t) continue
      if (canPlaceOnTableau(state.tableau[t], movingCards[0])) {
        return { from, to: { zone: 'tableau', index: t }, count }
      }
    }
    return null
  }

  /**
   * Ranks non-foundation legal moves for the Hint feature (see engine/hint.ts's findHint) -
   * foundation-bound moves already sort first there, unconditionally, so this is only ever asked
   * to rank the rest: tableau-to-tableau moves, and a waste card's choice of tableau column. Only
   * the tableau-to-tableau case gets a real score; a waste play has no "coherent group already
   * held" to weigh a tradeoff against (the waste is always exactly one card), so it scores 0, same
   * as Spider's own zone check.
   *
   * Adapted from Spider's scoreHintMove ("Opportunity-Cost Run Valuation") for this game's own
   * coherent-run rule - same predicate, same-suit descending (isDescendingSameSuit) - with two
   * differences that fall out of how this game actually differs from Spider:
   *
   *  - No foundation completion special-case: Spider's 1000-point "you just finished a King->Ace
   *    run" bonus doesn't exist here, because building a full run in the tableau isn't how this
   *    game is won - foundation moves already win the sort unconditionally upstream, so nothing
   *    needs to out-rank them from inside this function.
   *  - No "reveals a hidden card" bonus: every tableau card in this game is dealt face up and only
   *    ever receives already-face-up cards (see runLengthAtTop's own comment) - there is no
   *    face-down tableau card to ever reveal, so that whole term is dropped rather than kept as
   *    permanently-dead code.
   *
   * The remaining two terms need one real adaptation, not just a port: `settings.fortyThievesRunMoves`
   * (this function's own `runMoves` closure) gates whether a multi-card run may ever move as a
   * unit at all - off (the classic default) means every legal tableau move is forced to
   * count === 1, regardless of how long a same-suit run happens to be sitting at the top of the
   * source column. Scoring the SOURCE side against that column's real run length in that mode would
   * flag the only move actually on offer as "fragmentation" of a group that was never a real,
   * choosable alternative - so `runLen` (the source-side comparison point) degrades to `1` whenever
   * `runMoves` is off, zeroing that term out entirely while leaving the DESTINATION-side
   * `destRunLenBefore` computed for real either way: extending an existing same-suit run at the
   * destination is a genuine, achievable-one-card-at-a-time benefit under the strict rule too, so
   * it stays rewarded in both modes. `netEmptyDelta` (empty tableau columns - this game's only
   * scarce resource, no freecells/reserve) is untouched from Spider's own shape.
   */
  function scoreHintMove(state: FortyThievesState, move: Move): number {
    if (move.from.zone !== 'tableau' || move.to.zone !== 'tableau') return 0
    const fromCol = state.tableau[move.from.index]
    const toCol = state.tableau[move.to.index]
    if (!fromCol || !toCol) return 0
    const group = fromCol.slice(fromCol.length - move.count)

    const runLen = runMoves ? runLengthAtTop(fromCol) : 1
    const destRunLenBefore = runLengthAtTop(toCol)
    const sameSuitExtension = toCol.length > 0 && toCol[toCol.length - 1].suit === group[0].suit
    const newRunLenAtDest = move.count + (sameSuitExtension ? destRunLenBefore : 0)
    const remainderRunLen = move.count < runLen ? runLen - move.count : 0
    const netRunStructureChange = Math.max(newRunLenAtDest, remainderRunLen) - runLen

    const fromBecomesEmpty = move.count === fromCol.length
    const toWasEmpty = toCol.length === 0
    const netEmptyDelta = (fromBecomesEmpty ? 1 : 0) - (toWasEmpty ? 1 : 0)

    let score = netRunStructureChange * 30
    score += netEmptyDelta * 40
    score += move.count * 2
    return score
  }

  return {
    id: 'fortythieves',
    title: 'Forty Thieves',
    newGame,
    legalMoves,
    tryMove,
    drawStock,
    isWon,
    isStuck,
    autoMoveHint,
    accessibleCards,
    scoreHintMove
  }
}

/** Own reimplementation of engine/autoFoundation.ts's "Mechanism B" (findNextFoundationMove's own
 * shared inner loop), scoped to this game's 8-pile foundation layout - see this file's header
 * comment for why the shared version can't be reused directly. Shared by isFullyAutoCompletable's
 * own loop and nextAutoCompleteMove so the two can never disagree about which move comes next,
 * mirroring the shared module's own internal structure. */
function findNextFoundationMove(controller: Pick<GameController<FortyThievesState>, 'accessibleCards' | 'tryMove'>, state: FortyThievesState): AccessibleCard | null {
  if (!controller.accessibleCards) return null
  for (const entry of controller.accessibleCards(state)) {
    const slot = findFoundationSlot(state.foundation, entry.card)
    if (slot === null) continue
    const to: PileRef = { zone: 'foundation', index: slot }
    if (controller.tryMove(state, { from: entry.ref, to, count: 1 })) return entry
  }
  return null
}

/** True if the entire remaining game can be cleared via foundation moves alone, in some order -
 * see engine/autoFoundation.ts's own isFullyAutoCompletable for the full "why a plain greedy
 * simulation is correct here" reasoning, which applies unchanged to this game's own foundation
 * shape. */
export function isFullyAutoCompletable(controller: Pick<GameController<FortyThievesState>, 'isWon' | 'accessibleCards' | 'tryMove'>, state: FortyThievesState): boolean {
  if (!controller.accessibleCards) return false
  let cur = state
  while (!controller.isWon(cur)) {
    const entry = findNextFoundationMove(controller, cur)
    if (!entry) return false
    const slot = findFoundationSlot(cur.foundation, entry.card)!
    const result = controller.tryMove(cur, { from: entry.ref, to: { zone: 'foundation', index: slot }, count: 1 })
    if (!result) return false // unreachable - findNextFoundationMove only returns moves tryMove already accepted
    cur = result
  }
  return true
}

/** The next single move in a full auto-complete cascade - only meaningful once
 * isFullyAutoCompletable has confirmed true; each successive call (after applying the previous
 * move for real) advances the cascade by exactly one card. */
export function nextAutoCompleteMove(controller: Pick<GameController<FortyThievesState>, 'accessibleCards' | 'tryMove'>, state: FortyThievesState): AccessibleCard | null {
  return findNextFoundationMove(controller, state)
}

/** Exported for FortyThievesScreen.tsx's own fireAutoMove, which needs the resolved destination
 * slot to build the PileRef it animates the flight onto. */
export { findFoundationSlot }
