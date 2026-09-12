// Aces Up solitaire game rules & controller.
//
// Board: 4 piles, only the top card of each ever in play. Deal starts with 1 card face up on each
// pile (4 cards); the other 48 stay in the stock and get dealt in rounds of 4 (one more card onto
// each pile, including any pile that's currently empty) whenever the player likes - not gated
// behind being stuck, matching how the game is actually played, even though optimal play usually
// exhausts the current discards/moves first.
//
// Aces rank HIGHEST here (the game's namesake) - a pile's top card may be permanently discarded
// once any OTHER pile's top card is the same suit and a higher effective rank. A pile's top card
// may also move onto an empty pile (one card, one pile, at a time) - the only other legal action.
//
// Unlike every other game in this app, Aces Up has a genuine LOSS condition, not just an
// abandoned-deal outcome: once the stock is empty and no discard/move remains possible with more
// than just the 4 Aces left, the deal is unwinnable. Per this app's own established convention
// (see stores/statsEngine.ts), that lands in the exact same stats bucket as an abandoned deal - see
// games/shared/useStuckLossCheck.ts, which calls the same recordDealAbandoned every other game's
// "left mid-game" path already uses.

import { shuffledDeck } from '@/engine/deck'
import { GameController, Move, PileRef } from '@/engine/gameTypes'
import { top } from '@/engine/pile'
import { Card } from '@/engine/types'

export interface AcesUpState {
  /** 4 piles; only the top card of each is ever in play - everything under it is permanently
   * buried until it's the top itself. */
  piles: Card[][]
  /** 48 cards after the initial 4-card deal (one per pile), dealt out 4 at a time thereafter (one
   * more card onto each pile, including an empty one) - see drawStock. */
  stock: Card[]
  /** Every card ever discarded, in discard order (oldest first) - mirrors Pyramid's own `discard`
   * field. A won deal leaves exactly 4 cards (the Aces) outside this pile, everything else here. */
  discard: Card[]
}

const NUM_PILES = 4

/** Aces rank highest - the one place in this app's whole card vocabulary where rank 1 isn't low.
 * Kept local to this game rather than a shared engine/pile.ts export, since nothing else here
 * ever wants Aces-high comparisons. */
function effectiveRank(card: Card): number {
  return card.rank === 1 ? 14 : card.rank
}

// Shallow: a fresh outer `piles` array (so a caller can reassign state.piles[i] to a brand-new
// pile without touching the original state), but every pile and every card inside starts out as
// the exact SAME reference as `state`'s own (`stock`/`discard` themselves are carried over
// untouched too, for the same reason). tryMove/drawStock below replace only the specific pile(s) a
// move actually touches (via setPile), and clone an individual card only at the one spot its
// faceUp is actually flipped in place (see drawStock) - every card on a pile a given move doesn't
// touch keeps its exact pre-move object identity.
function cloneState(state: AcesUpState): AcesUpState {
  return {
    piles: state.piles.slice(),
    stock: state.stock,
    discard: state.discard
  }
}

/** Writes a (already-fresh, caller-owned) pile back into `state` at `ref`. */
function setPile(state: AcesUpState, ref: PileRef, pile: Card[]): void {
  switch (ref.zone) {
    case 'tableau':
      state.piles[ref.index] = pile
      break
    case 'stock':
      state.stock = pile
      break
    case 'discard':
      state.discard = pile
      break
  }
}

/** True if `pileIndex`'s own top card may be discarded - some OTHER pile's top card is the same
 * suit and a higher effective (Aces-high) rank. */
function canDiscard(piles: Card[][], pileIndex: number): boolean {
  const card = top(piles[pileIndex])
  if (!card) return false
  return piles.some((p, i) => {
    if (i === pileIndex) return false
    const other = top(p)
    return !!other && other.suit === card.suit && effectiveRank(other) > effectiveRank(card)
  })
}

/** True if `fromIndex`'s own top card may move to fill `toIndex` - `toIndex` must be a genuinely
 * empty pile, and moving a pile's own single card onto itself is never a real move. */
function canMoveToEmpty(piles: Card[][], fromIndex: number, toIndex: number): boolean {
  if (fromIndex === toIndex) return false
  if (piles[fromIndex].length === 0) return false
  return piles[toIndex].length === 0
}

function newGame(seed: number): AcesUpState {
  const deck = shuffledDeck(seed, 1)
  const piles: Card[][] = Array.from({ length: NUM_PILES }, () => [])
  for (let i = 0; i < NUM_PILES; i++) {
    piles[i].push({ ...deck[i], faceUp: true })
  }
  const stock: Card[] = deck.slice(NUM_PILES).map((c) => ({ ...c, faceUp: false }))
  return { piles, stock, discard: [] }
}

function tryMove(state: AcesUpState, move: Move): AcesUpState | null {
  const { from, to, count } = move
  if (count !== 1) return null
  if (from.zone !== 'tableau') return null
  if (!state.piles[from.index] || state.piles[from.index].length === 0) return null

  if (to.zone === 'discard') {
    if (!canDiscard(state.piles, from.index)) return null
    const next = cloneState(state)
    const nextSourcePile = state.piles[from.index].slice()
    const nextDiscard = state.discard.slice()
    const card = nextSourcePile.pop()!
    nextDiscard.push(card)
    setPile(next, from, nextSourcePile)
    setPile(next, to, nextDiscard)
    return next
  }

  if (to.zone === 'tableau') {
    if (!canMoveToEmpty(state.piles, from.index, to.index)) return null
    const next = cloneState(state)
    const nextSourcePile = state.piles[from.index].slice()
    const nextDestPile = state.piles[to.index].slice()
    const card = nextSourcePile.pop()!
    nextDestPile.push(card)
    setPile(next, from, nextSourcePile)
    setPile(next, to, nextDestPile)
    return next
  }

  return null
}

/** Deals one more card onto each of the 4 piles (including any currently empty) - legal any time
 * the stock has cards, not gated behind being stuck (see this file's header comment). */
function drawStock(state: AcesUpState): AcesUpState | null {
  if (state.stock.length === 0) return null
  const next = cloneState(state)
  const nextStock = state.stock.slice()
  for (let i = 0; i < NUM_PILES; i++) {
    const card = nextStock.shift()
    if (!card) break // 48 is exactly divisible by 4, so this never actually happens in real play
    const nextPile = state.piles[i].slice()
    nextPile.push(card.faceUp ? card : { ...card, faceUp: true })
    setPile(next, { zone: 'tableau', index: i }, nextPile)
  }
  setPile(next, { zone: 'stock', index: 0 }, nextStock)
  return next
}

function isWon(state: AcesUpState): boolean {
  if (state.stock.length > 0) return false
  return state.piles.every((p) => p.length === 1 && p[0].rank === 1)
}

/** The single canonical move for `pileIndex`'s own top card, if it has one at all - discard first
 * (real, irreversible progress), else the first empty pile in ascending index order. Shared by
 * legalMoves and autoMoveHint below so the two can never disagree about what a given pile's card
 * actually does - see this file's own header comment on why that single-source-of-truth idiom
 * matters (the same reasoning Spider's rules.ts documents for its own pickBestTableauTarget).
 * Before this was factored out, legalMoves enumerated EVERY (pileIndex, emptyPileIndex) pair AND a
 * separate discard entry for any pile that qualified for both - so a board with, say, pile 0
 * dischargeable AND two empty piles produced multiple distinct "moves" for pile 0's own card even
 * though tapping that card can only ever do ONE of them. Hint's own skip-cycling (see
 * engine/hint.ts) would happily surface one of the others - e.g. "move pile 0 to pile 2" - while
 * tapping that exact highlighted card actually discarded it (or moved it to pile 1) instead, a
 * genuine Hint/tap-to-move mismatch confirmed via concrete boards during this game's hint-quality
 * pass, structurally the same defect class as Spider's own destination-mismatch bug even though it
 * surfaces through skip-cycling here rather than the base (skip 0) pick. */
function canonicalMoveFor(piles: Card[][], pileIndex: number): Move | null {
  if (piles[pileIndex].length === 0) return null
  if (canDiscard(piles, pileIndex)) {
    return { from: { zone: 'tableau', index: pileIndex }, to: { zone: 'discard', index: 0 }, count: 1 }
  }
  for (let j = 0; j < NUM_PILES; j++) {
    if (canMoveToEmpty(piles, pileIndex, j)) {
      return { from: { zone: 'tableau', index: pileIndex }, to: { zone: 'tableau', index: j }, count: 1 }
    }
  }
  return null
}

/** Every pile's own canonical move (see canonicalMoveFor), discards bucketed entirely ahead of
 * moves-to-empty - the same two-bucket shape this function always had, just deduplicated to one
 * entry per pile. That bucket order is what already gives Hint's skip-0 pick its "prefer real
 * progress" quality for free: ANY pile's available discard sorts ahead of ANY other pile's
 * move-to-empty, with no numeric scoreHintMove needed (see this game's own investigation notes -
 * a scorer wouldn't even fix the mismatch above, since it only reorders by category, it doesn't
 * deduplicate the redundant multi-destination entries that caused it). */
function legalMoves(state: AcesUpState): Move[] {
  const canonical: (Move | null)[] = []
  for (let i = 0; i < NUM_PILES; i++) canonical.push(canonicalMoveFor(state.piles, i))
  const discards = canonical.filter((m): m is Move => !!m && m.to.zone === 'discard')
  const moves = canonical.filter((m): m is Move => !!m && m.to.zone === 'tableau')
  return [...discards, ...moves]
}

/** Stock empty, not already won, and no discard/move remains - a genuine, common loss, unlike
 * every other game in this app (see this file's header comment and games/shared/useStuckLossCheck.ts). */
function isStuck(state: AcesUpState): boolean {
  return state.stock.length === 0 && !isWon(state) && legalMoves(state).length === 0
}

/** Prioritizes discarding the tapped card (direct progress toward winning) over moving it to fill
 * an empty pile (which only pays off indirectly, by exposing whatever's buried underneath) - see
 * canonicalMoveFor above, the single source of truth this and legalMoves both defer to. */
function autoMoveHint(state: AcesUpState, from: PileRef, cardId: string): Move | null {
  if (from.zone !== 'tableau') return null
  const card = top(state.piles[from.index])
  if (!card || card.id !== cardId) return null
  return canonicalMoveFor(state.piles, from.index)
}

export const AcesUpController: GameController<AcesUpState> = {
  id: 'acesup',
  title: 'Aces Up',
  newGame,
  legalMoves,
  tryMove,
  drawStock,
  isWon,
  isStuck,
  autoMoveHint
}
