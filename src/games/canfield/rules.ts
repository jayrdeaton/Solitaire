// Canfield solitaire game rules & controller.
//
// The Klondike-family game with the two rules that make it distinct: (1) the foundations don't
// start at Ace - the very first card dealt (from the top of the deck, before the tableau/reserve)
// sets a "Canfield rank" that all 4 foundations must start from and build up through, WRAPPING
// after King back to Ace until each suit's full 13-card cycle is complete; (2) the tableau's
// alternating-color descending runs ALSO wrap (an Ace may have a King placed on it to continue a
// run), unlike every other game in this app. A 13-card face-down reserve (only its top card face
// up) sits beside the tableau - its top card may be played to tableau or foundation like a second
// waste pile, and while ANY reserve card remains, an empty tableau column may ONLY be refilled from
// the reserve (not from waste or another tableau column) - once the reserve is exhausted, any single
// card may fill an empty column, same relaxed rule Yukon has from the start. Stock/waste is
// draw-3 with unlimited recycling, same convention as every other stock-pile game here.

import { FinishMove, isFullyAutoCompletable, nextAutoCompleteMove } from '@/engine/autoFoundation'
import { shuffledDeck } from '@/engine/deck'
import { AccessibleCard, GameController, Move, PileRef } from '@/engine/gameTypes'
import { top } from '@/engine/pile'
import { Card, cardColor, Rank, Suit, SUITS } from '@/engine/types'

export interface CanfieldState {
  /** 4 tableau columns, each dealt 1 card face up. */
  tableau: Card[][]
  /** 4 foundation piles, indexed to match engine/types SUITS order - each must start at
   * `foundationRank` and proceeds through a full 13-card cycle (wrapping King -> Ace). */
  foundation: Card[][]
  /** The rank every foundation starts from - set once, at deal, from the very first card cut from
   * the deck (which becomes that suit's first foundation card). */
  foundationRank: Rank
  /** 13 cards, only the last (top) face up - a second, single-card-at-a-time source alongside
   * waste, with its own empty-tableau-column priority (see canPlaceOnTableau). */
  reserve: Card[]
  stock: Card[]
  waste: Card[]
}

function suitIndex(suit: Suit): number {
  return SUITS.indexOf(suit)
}

/** The rank one below `rank` in a descending tableau run, wrapping Ace (1) to King (13) - unlike
 * every other game here, Canfield tableau runs don't stop at Ace. */
function cyclicPrevRank(rank: Rank): Rank {
  return (rank === 1 ? 13 : rank - 1) as Rank
}

/** The rank one above `rank` in an ascending foundation build, wrapping King (13) to Ace (1). */
function cyclicNextRank(rank: Rank): Rank {
  return (rank === 13 ? 1 : rank + 1) as Rank
}

/** Cyclic counterpart of engine/pile.ts's isDescendingAltColor - same alternating-color check, but
 * a step from Ace down to King is valid here, where it wouldn't be anywhere else in this app.
 * Exported so CanfieldScreen.tsx can pass it directly as the `isValidRun` predicate to
 * engine/pile.ts's runCountFrom (drag-run detection) and engine/autoMove.ts's pickBestTableauTarget,
 * rather than a second, independently-typed copy of the same cyclic-run check drifting out of sync
 * with this one - same reasoning TriPeaks' rules.ts exports childIndices for its own screen to reuse
 * directly instead of re-deriving. */
export function isDescendingAltColorCyclic(cards: Card[]): boolean {
  for (let i = 1; i < cards.length; i++) {
    const prev = cards[i - 1]
    const cur = cards[i]
    if (cur.rank !== cyclicPrevRank(prev.rank)) return false
    if (cardColor(cur.suit) === cardColor(prev.suit)) return false
  }
  return true
}

/** Cyclic counterpart of engine/foundation.ts's canPlaceOnFoundation - an empty pile needs
 * `foundationRank` specifically (not always Ace), and a step from King up to Ace is valid. */
function canPlaceOnFoundationCyclic(dest: Card[], moving: Card, foundationRank: Rank): boolean {
  const destTop = top(dest)
  if (destTop === undefined) return moving.rank === foundationRank
  return destTop.suit === moving.suit && moving.rank === cyclicNextRank(destTop.rank)
}

/** Unlike Klondike (Kings only) or Yukon (any card, always), an empty tableau column here is
 * reserve-priority: while the reserve still has cards, ONLY a reserve-sourced card may fill it -
 * once the reserve is exhausted, any single source (waste or another tableau's run) may. */
function canPlaceOnTableau(reserve: Card[], dest: Card[], moving: Card[], fromZone: string): boolean {
  if (moving.length === 0) return false
  const movingTop = moving[0]
  const destTop = top(dest)
  if (destTop === undefined) {
    return reserve.length > 0 ? fromZone === 'reserve' : true
  }
  if (!destTop.faceUp) return false
  return cardColor(movingTop.suit) !== cardColor(destTop.suit) && movingTop.rank === cyclicPrevRank(destTop.rank)
}

/** Length of the coherent movable group already sitting at the top of a tableau column - the
 * maximal suffix that's itself a valid isDescendingAltColorCyclic run (0 for an empty column, at
 * least 1 for any non-empty one since a single card is trivially its own run). Extracted out of
 * legalMoves's own inline version of this same scan so scoreHintMove (below) can reuse it without a
 * second, independently-drifting copy of "what counts as a run here." */
function runLengthAtTop(column: Card[]): number {
  if (column.length === 0) return 0
  let runStart = column.length - 1
  while (runStart > 0 && column[runStart - 1].faceUp) {
    if (!isDescendingAltColorCyclic(column.slice(runStart - 1))) break
    runStart -= 1
  }
  return column.length - runStart
}

// Shallow: fresh outer tableau/foundation arrays (so a caller can reassign state.tableau[i] /
// state.foundation[i] to a brand-new pile without touching the original state), but every pile
// and every card inside starts out as the exact SAME reference as `state`'s own. tryMove/
// drawStock below replace only the specific pile(s) a move actually touches (via setPile), and
// clone an individual card only at the one spot its faceUp is actually flipped in place (see
// flipFaceUp) - every untouched card elsewhere on the board keeps its exact pre-move object
// identity.
function cloneState(state: CanfieldState): CanfieldState {
  return {
    tableau: state.tableau.slice(),
    foundation: state.foundation.slice(),
    foundationRank: state.foundationRank,
    reserve: state.reserve,
    stock: state.stock,
    waste: state.waste
  }
}

function getPile(state: CanfieldState, ref: PileRef): Card[] | null {
  switch (ref.zone) {
    case 'tableau':
      return state.tableau[ref.index] ?? null
    case 'foundation':
      return state.foundation[ref.index] ?? null
    case 'reserve':
      return state.reserve
    case 'waste':
      return state.waste
    default:
      return null
  }
}

/** Writes a (already-fresh, caller-owned) pile back into `state` at `ref`. */
function setPile(state: CanfieldState, ref: PileRef, pile: Card[]): void {
  switch (ref.zone) {
    case 'tableau':
      state.tableau[ref.index] = pile
      break
    case 'foundation':
      state.foundation[ref.index] = pile
      break
    case 'reserve':
      state.reserve = pile
      break
    case 'waste':
      state.waste = pile
      break
    case 'stock':
      state.stock = pile
      break
  }
}

/** Replaces the last card of `pile` (mutated in place, since `pile` is always already a fresh
 * array the caller owns) with a face-up clone, if it isn't face-up already - never mutates the
 * card object itself. */
function flipFaceUp(pile: Card[]): void {
  const i = pile.length - 1
  const c = pile[i]
  if (c && !c.faceUp) pile[i] = { ...c, faceUp: true }
}

function newGame(seed: number): CanfieldState {
  const deck = shuffledDeck(seed, 1)
  let cursor = 0

  const starter = deck[cursor++]
  const foundation: Card[][] = [[], [], [], []]
  foundation[suitIndex(starter.suit)] = [{ ...starter, faceUp: true }]

  const tableau: Card[][] = []
  for (let col = 0; col < 4; col++) {
    tableau.push([{ ...deck[cursor++], faceUp: true }])
  }

  const reserve: Card[] = []
  for (let i = 0; i < 13; i++) {
    reserve.push({ ...deck[cursor++], faceUp: i === 12 })
  }

  const stock: Card[] = deck.slice(cursor).map((c) => ({ ...c, faceUp: false }))

  return { tableau, foundation, foundationRank: starter.rank, reserve, stock, waste: [] }
}

function tryMove(state: CanfieldState, move: Move): CanfieldState | null {
  const { from, to, count } = move
  if (count < 1) return null
  if (from.zone === to.zone && from.index === to.index) return null
  // A foundation's top card may come back down onto the tableau, one card at a time (as in Klondike - see its tryMove;
  // the starter included, which leaves its foundation needing a foundationRank card again). Never onto another
  // foundation, and legalMoves never offers it, so Hint can't suggest it.
  if (from.zone === 'foundation' && (to.zone !== 'tableau' || count !== 1)) return null
  if (from.zone === 'stock') return null // stock cards only move via drawStock

  const sourcePile = getPile(state, from)
  if (!sourcePile || sourcePile.length < count) return null

  // Only tableau moves may carry more than one card - reserve/waste are single-card-at-a-time.
  if (count > 1 && from.zone !== 'tableau') return null

  const movingCards = sourcePile.slice(sourcePile.length - count)
  if (movingCards.some((c) => !c.faceUp)) return null

  if (from.zone === 'tableau' && count > 1) {
    if (!isDescendingAltColorCyclic(movingCards)) return null
  }

  const destPile = getPile(state, to)
  if (!destPile) return null

  if (to.zone === 'tableau') {
    if (!canPlaceOnTableau(state.reserve, destPile, movingCards, from.zone)) return null
  } else if (to.zone === 'foundation') {
    if (count !== 1) return null
    const movingCard = movingCards[0]
    if (suitIndex(movingCard.suit) !== to.index) return null
    if (!canPlaceOnFoundationCyclic(destPile, movingCard, state.foundationRank)) return null
  } else {
    return null // cards never move onto reserve or waste via tryMove
  }

  const next = cloneState(state)
  const nextSourcePile = getPile(next, from)!.slice()
  const nextDestPile = getPile(next, to)!.slice()
  setPile(next, from, nextSourcePile)
  setPile(next, to, nextDestPile)
  const moved = nextSourcePile.splice(nextSourcePile.length - count, count)
  nextDestPile.push(...moved)

  if (from.zone === 'reserve') {
    flipFaceUp(nextSourcePile)
  }

  return next
}

/** Closes over `drawCount` (1 or 3, per settings.canfieldDraw) - the only one of Canfield's
 * GameController methods that varies by it, same shape Klondike's own createKlondikeController
 * uses for its identical draw-count setting, just scoped to only this one function rather than the
 * whole controller (every other method here is drawCount-independent, so nesting them too would
 * only cost a large reindent for no behavioral gain). */
function makeDrawStock(drawCount: 1 | 3) {
  return function drawStock(state: CanfieldState): CanfieldState | null {
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
      // Every recycled card's faceUp genuinely flips here - unlike the draw above, there's no
      // untouched subset to preserve identity for; all of them really do change.
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
}

function isWon(state: CanfieldState): boolean {
  return state.foundation.every((pile) => pile.length === 13)
}

function legalMoves(state: CanfieldState): Move[] {
  const moves: Move[] = []
  const tryAdd = (from: PileRef, to: PileRef, count: number) => {
    if (tryMove(state, { from, to, count })) moves.push({ from, to, count })
  }

  if (state.waste.length > 0) {
    const from: PileRef = { zone: 'waste', index: 0 }
    for (let f = 0; f < 4; f++) tryAdd(from, { zone: 'foundation', index: f }, 1)
    for (let t = 0; t < 4; t++) tryAdd(from, { zone: 'tableau', index: t }, 1)
  }

  if (state.reserve.length > 0) {
    const from: PileRef = { zone: 'reserve', index: 0 }
    for (let f = 0; f < 4; f++) tryAdd(from, { zone: 'foundation', index: f }, 1)
    for (let t = 0; t < 4; t++) tryAdd(from, { zone: 'tableau', index: t }, 1)
  }

  for (let col = 0; col < 4; col++) {
    const pile = state.tableau[col]
    if (pile.length === 0) continue
    const runLen = runLengthAtTop(pile)
    const from: PileRef = { zone: 'tableau', index: col }
    for (let f = 0; f < 4; f++) tryAdd(from, { zone: 'foundation', index: f }, 1)
    for (let count = 1; count <= runLen; count++) {
      for (let t = 0; t < 4; t++) {
        if (t === col) continue
        tryAdd(from, { zone: 'tableau', index: t }, count)
      }
    }
  }

  return moves
}

function isStuck(state: CanfieldState): boolean {
  return state.stock.length === 0 && state.waste.length === 0 && legalMoves(state).length === 0
}

function autoMoveHint(state: CanfieldState, from: PileRef, cardId: string): Move | null {
  const pile = getPile(state, from)
  if (!pile) return null
  const cardIndex = pile.findIndex((c) => c.id === cardId)
  if (cardIndex === -1) return null
  const movingCards = pile.slice(cardIndex)
  if (movingCards.some((c) => !c.faceUp)) return null
  const count = movingCards.length
  if (count > 1 && (from.zone !== 'tableau' || !isDescendingAltColorCyclic(movingCards))) return null

  if (count === 1) {
    const movingCard = movingCards[0]
    const f = suitIndex(movingCard.suit)
    if (canPlaceOnFoundationCyclic(state.foundation[f], movingCard, state.foundationRank)) {
      return { from, to: { zone: 'foundation', index: f }, count: 1 }
    }
  }

  for (let t = 0; t < 4; t++) {
    if (from.zone === 'tableau' && from.index === t) continue
    if (canPlaceOnTableau(state.reserve, state.tableau[t], movingCards, from.zone)) {
      return { from, to: { zone: 'tableau', index: t }, count }
    }
  }
  return null
}

/** Ranks each of findHint's non-foundation legal moves so Hint stops treating "any legal move" as
 * equally good - engine/hint.ts's findHint already sorts foundation-bound moves first,
 * unconditionally, and only asks this to order the rest. Every non-foundation Canfield move lands on
 * a tableau column (waste/reserve are never move destinations - see tryMove), so `move.to` is always
 * `{ zone: 'tableau' }` here; `move.from` can be `tableau`, `waste`, or `reserve`.
 *
 * Adapted from Spider's own "opportunity-cost run valuation" scoreHintMove (see that file): the
 * longest isDescendingAltColorCyclic run either touched pile shows before the move against the
 * longest either shows after it. `a` is the run the moving group's base card was continuing at its
 * source and `b` the run it lands on, so before the move the source shows `count + a` and the
 * destination `b`, and after it the source shows `a` and the destination `count + b` - zero if the
 * group relocated intact onto nothing longer, positive if it built something longer, negative if it
 * tore a run into pieces for no compensating gain. Measured the same way on both sides, a move and
 * its exact reverse always score as opposites: the old version compared only the source's run before
 * with the better of the two after, and added the size tiebreak to every move, so moving a card from
 * one matching card to an equal one scored above 0 both ways and Hint offered it, then offered moving
 * it straight back. Two things differ from Spider's own version, both because Canfield's board looks
 * different:
 *
 * (1) `a` only exists for a tableau source - waste and reserve are single-card-at-a-time piles with
 * no internal run to protect (tryMove forbids count > 1 from either), so for those `a` is 0, which
 * makes every fragmentation term below a no-op for them. Neither can be moved back onto, so they
 * have no reverse to worry about either.
 *
 * (2) canPlaceOnTableau's legality rule (opposite color, one rank down, cyclically) is EXACTLY
 * isDescendingAltColorCyclic's own pairwise rule - unlike Spider, where a legal placement can land on
 * a different suit and so NOT extend a same-suit run, every legal Canfield tableau destination
 * necessarily extends its own top run by the full moving group. So there's no Spider-style suit gate
 * needed here: `b` is always the destination's whole top run.
 *
 * In place of Spider's face-down-card reveal bonus - Canfield's tableau has no face-down cards at
 * all, every tableau card is dealt or placed face up (see newGame/tryMove) - this rewards draining
 * the reserve instead (`fromZone === 'reserve'`): the reserve is this game's only pile that hides
 * cards behind its top one, so playing its top card is this game's real equivalent of "turning
 * unknown into known," and is also this game's own path toward the point an empty tableau column
 * stops being reserve-exclusive (see canPlaceOnTableau). Waste gets no such bonus - every waste card
 * below the top is already face up and already known, so exposing it reveals nothing new. */
function scoreHintMove(state: CanfieldState, move: Move): number {
  if (move.to.zone !== 'tableau') return 0
  const toCol = state.tableau[move.to.index]
  if (!toCol) return 0

  const fromPile = getPile(state, move.from)
  if (!fromPile || fromPile.length < move.count) return 0

  const fromZone = move.from.zone
  // A legal tableau group is always a clean run (see tryMove), so it is the whole of `count`.
  const remainder = fromPile.slice(0, fromPile.length - move.count)
  const below = remainder[remainder.length - 1]
  const base = fromPile[fromPile.length - move.count]
  const linkedAtSource = fromZone === 'tableau' && below !== undefined && below.faceUp && isDescendingAltColorCyclic([below, base])
  const a = linkedAtSource ? runLengthAtTop(remainder) : 0
  const b = runLengthAtTop(toCol)
  const netRunStructureChange = Math.max(move.count + b, a) - Math.max(move.count + a, b)

  const fromBecomesEmpty = fromZone === 'tableau' && move.count === fromPile.length
  const toWasEmpty = toCol.length === 0
  const netEmptyDelta = (fromBecomesEmpty ? 1 : 0) - (toWasEmpty ? 1 : 0)

  const depletesReserve = fromZone === 'reserve'

  let score = depletesReserve ? 500 : 0
  score += netRunStructureChange * 30
  score += netEmptyDelta * 40
  // The size tiebreak only orders moves that already gain something.
  if (score <= 0) return score
  return score + move.count * 2
}

/** Every card currently reachable without drawing from stock - waste top, reserve top, and each
 * tableau column's top card - for the auto-play-to-foundation feature (see isSafeAutoPlay below and
 * engine/autoFoundation.ts's isFullyAutoCompletable/nextAutoCompleteMove, both reused as-is). */
function accessibleCards(state: CanfieldState): AccessibleCard[] {
  const result: AccessibleCard[] = []
  const wasteTop = top(state.waste)
  if (wasteTop) result.push({ ref: { zone: 'waste', index: 0 }, card: wasteTop })
  const reserveTop = top(state.reserve)
  if (reserveTop) result.push({ ref: { zone: 'reserve', index: 0 }, card: reserveTop })
  state.tableau.forEach((pile, index) => {
    const t = top(pile)
    if (t && t.faceUp) result.push({ ref: { zone: 'tableau', index }, card: t })
  })
  return result
}

/** How many cards into its own foundation's 13-card cycle `rank` falls, given that cycle starts at
 * `foundationRank` - 0 for the starting rank itself, up to 12 for the rank just before it wraps
 * back around. Equal to that foundation pile's own length once `rank`'s card is on it, which is
 * what makes this comparable directly against another suit's foundation *length* below - the
 * cyclic-foundation counterpart of the plain "rank" comparison engine/autoFoundation.ts's
 * isSafeAutoPlay uses for the every other, Ace-starting game in this app. */
function cyclicPosition(rank: Rank, foundationRank: Rank): number {
  return (rank - foundationRank + 13) % 13
}

/** Cyclic-foundation counterpart of engine/autoFoundation.ts's isSafeAutoPlay: a card is safe to
 * send to its foundation once both opposite-color foundations have already placed as many cards as
 * this card's own cyclic position - i.e. every opposite-color card that could still land on top of
 * this one in a tableau run (cyclicPrevRank(card.rank), one position earlier in the same cycle) is
 * already on its own foundation. Kept local to this file rather than generalizing the shared
 * engine/autoFoundation.ts, which hardcodes Ace-start via raw rank comparison (`card.rank - 1`) -
 * that assumption is baked into every other game here and safe to leave alone; duplicating just the
 * cyclic-aware piece here carries zero risk to Klondike/FreeCell/Yukon's own auto-play behavior. */
export function isSafeAutoPlay(state: CanfieldState, card: Card): boolean {
  const oppositeColor = cardColor(card.suit) === 'red' ? 'black' : 'red'
  const oppositeSuits = SUITS.filter((s) => cardColor(s) === oppositeColor)
  const oppMinLength = Math.min(...oppositeSuits.map((s) => state.foundation[suitIndex(s)].length))
  return oppMinLength >= cyclicPosition(card.rank, state.foundationRank)
}

/** Cyclic-foundation counterpart of engine/autoFoundation.ts's findSafeAutoPlay - same shape, using
 * this file's own canPlaceOnFoundationCyclic/isSafeAutoPlay instead of the shared Ace-start ones. The
 * waste top is scanned like any other accessible card, but only a cascade the player's own play of a
 * card to a foundation set off ever runs this, and the player's next draw or other move stops it -
 * a card they just drew or uncovered is never played for them (see useAutoFoundationCascade). */
export function findSafeAutoPlay(state: CanfieldState, accessible: AccessibleCard[]): AccessibleCard | null {
  for (const entry of accessible) {
    const f = suitIndex(entry.card.suit)
    if (canPlaceOnFoundationCyclic(state.foundation[f], entry.card, state.foundationRank) && isSafeAutoPlay(state, entry.card)) {
      return entry
    }
  }
  return null
}

/** Whether the board is SOLVED, so the finish (games/shared/useAutoFinish) may file every remaining card away on its own,
 * after the player's play of a card to a foundation: not won yet, nothing hidden and nothing left to draw - the reserve (face-down under its
 * top), the stock (face-down) and the waste all empty, and no face-down card in the tableau (it never holds one, see
 * newGame/tryMove; checked anyway) - and every remaining card able to go up by foundation moves alone. The last part is
 * engine/autoFoundation.ts's plain isFullyAutoCompletable, which suits these wrapping foundations because it only ever moves
 * a card through this game's own cyclic tryMove. Deliberately NOT the draws-aware isFullyAutoCompletableWithDraws (the
 * screen's cascade uses that one, after a foundation play): it reads the face-down stock to decide, and the finish must
 * never give away a card the player can't see. isWon comes first because isFullyAutoCompletable is true on a won board.
 * The reserve and waste checks are load-bearing: the plain check plays their tops one after another, down to the cards
 * under them (tryMove turns each reserve card over as the one above it goes, so it would count on a card nobody has
 * seen). The stock and tableau face-down checks are belt-and-braces: the plain check can't reach isWon past either
 * (accessibleCards never offers a stock card or a face-down column top, and tryMove never moves a stock card or turns a
 * column card over), so they change no answer today and no test can show them doing anything. They keep the rule from
 * resting on those two facts.
 * `controller` is the screen's per-deal one; its draw count plays no part here. */
export function canAutoFinish(controller: GameController<CanfieldState>, state: CanfieldState): boolean {
  if (controller.isWon(state)) return false
  if (state.reserve.length > 0 || state.stock.length > 0 || state.waste.length > 0) return false
  if (state.tableau.some((column) => column.some((c) => !c.faceUp))) return false
  return isFullyAutoCompletable(controller, state)
}

/** The next card the finish sends up and the foundation it goes to (its own suit's - see tryMove), or null unless the
 * board is solved (canAutoFinish). */
export function nextFinishMove(controller: GameController<CanfieldState>, state: CanfieldState): FinishMove | null {
  if (!canAutoFinish(controller, state)) return null
  const entry = nextAutoCompleteMove(controller, state)
  return entry ? { entry, to: { zone: 'foundation', index: suitIndex(entry.card.suit) } } : null
}

export function createCanfieldController(drawCount: 1 | 3): GameController<CanfieldState> {
  return {
    id: 'canfield',
    title: 'Canfield',
    newGame,
    legalMoves,
    tryMove,
    drawStock: makeDrawStock(drawCount),
    isWon,
    isStuck,
    autoMoveHint,
    scoreHintMove,
    accessibleCards
  }
}
