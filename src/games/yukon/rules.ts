// Yukon solitaire game rules & controller.
//
// Same tableau/foundation shape as Klondike (alternating-color descending runs, 4 ascending
// same-suit foundations) but with no stock/waste at all - the full deck is dealt into the tableau
// up front - and one looser tableau rule: a moving group need not already be a valid run. See
// engine/pile.ts's alwaysValidRun for why that needs no new engine code.

import { FinishMove, isFullyAutoCompletable, nextAutoCompleteMove } from '@/engine/autoFoundation'
import { pickBestTableauTarget } from '@/engine/autoMove'
import { shuffledDeck } from '@/engine/deck'
import { canPlaceOnFoundation, suitIndex } from '@/engine/foundation'
import { AccessibleCard, GameController, Move, PileRef } from '@/engine/gameTypes'
import { alwaysValidRun, top } from '@/engine/pile'
import { Card, cardColor } from '@/engine/types'

export interface YukonState {
  /** 7 tableau columns. */
  tableau: Card[][]
  /** 4 foundation piles, indexed to match engine/types SUITS order (clubs, diamonds, hearts, spades). */
  foundation: Card[][]
}

// Shallow: fresh outer tableau/foundation arrays (so a caller can reassign state.tableau[i] /
// state.foundation[i] to a brand-new pile without touching the original state), but every pile
// and every card inside starts out as the exact SAME reference as `state`'s own. tryMove below
// replaces only the specific pile(s) a move actually touches (via setPile), and clones an
// individual card only at the one spot its faceUp is actually flipped in place (see flipFaceUp) -
// every untouched card elsewhere on the board keeps its exact pre-move object identity.
function cloneState(state: YukonState): YukonState {
  return {
    tableau: state.tableau.slice(),
    foundation: state.foundation.slice()
  }
}

function getPile(state: YukonState, ref: PileRef): Card[] | null {
  switch (ref.zone) {
    case 'tableau':
      return state.tableau[ref.index] ?? null
    case 'foundation':
      return state.foundation[ref.index] ?? null
    default:
      return null
  }
}

/** Writes a (already-fresh, caller-owned) pile back into `state` at `ref`. */
function setPile(state: YukonState, ref: PileRef, pile: Card[]): void {
  switch (ref.zone) {
    case 'tableau':
      state.tableau[ref.index] = pile
      break
    case 'foundation':
      state.foundation[ref.index] = pile
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

function canPlaceOnTableau(dest: Card[], moving: Card[]): boolean {
  if (moving.length === 0) return false
  const movingTop = moving[0] // first card of the run being moved (the one that lands on dest)
  const destTop = top(dest)
  if (destTop === undefined) {
    // Yukon: any face-up card (and its stack) may start an empty column - not Kings-only, unlike
    // Klondike.
    return true
  }
  if (!destTop.faceUp) return false
  const destColor = cardColor(destTop.suit)
  const movingColor = cardColor(movingTop.suit)
  return movingTop.rank === destTop.rank - 1 && destColor !== movingColor
}

/** Length of the maximal alternating-color, descending, face-up run currently sitting at the top
 * of a column - the genuinely-ordered "Klondike-style" structure a player has actually built there,
 * as distinct from Yukon's much looser "any face-up card plus everything above it" movable-group
 * rule (see canPlaceOnTableau/alwaysValidRun, and scoreHintMove's doc comment for why this distinct,
 * stricter measure is the one worth tracking for hint-quality purposes). 0 for an empty column. */
function altColorRunLengthAtTop(column: Card[]): number {
  if (column.length === 0) return 0
  if (!column[column.length - 1].faceUp) return 0
  let len = 1
  for (let i = column.length - 2; i >= 0; i--) {
    const cur = column[i]
    const next = column[i + 1]
    if (!cur.faceUp || cur.rank !== next.rank + 1 || cardColor(cur.suit) === cardColor(next.suit)) break
    len++
  }
  return len
}

/**
 * Ranks a legal tableau move for the Hint button (see engine/hint.ts's findHint). Yukon has no
 * foundation-run-completion special case the way Spider does - foundation moves are always
 * single-card and already sort first, unconditionally, in findHint - so this only ever ranks
 * tableau-to-tableau moves.
 *
 * Yukon's move rule is looser than Klondike/FreeCell/Spider's: ANY face-up card, plus everything
 * stacked above it, is a legal group to move, with no requirement that the group itself already be
 * a valid alternating-color run (see canPlaceOnTableau/alwaysValidRun - `moving[0]`, the card that
 * actually touches the destination, is the only card whose rank/color is ever checked). Taking
 * fewer than all of a column's face-up cards doesn't strand the remainder any less movable than it
 * already was - every face-up suffix stays just as liftable, at whatever depth, whether or not it
 * happens to be internally ordered. So Spider's "fragmenting a coherent run costs you something"
 * penalty has no direct analogue here: nothing about a card's future MOVE LEGALITY depends on how
 * the face-up region above it is ordered.
 *
 * What still matters is whether a move actually builds real alternating-color-descending structure
 * - a genuine Klondike-style run - since that's the arrangement that keeps feeding single cards in
 * usable descending order onto other piles (and eventually the foundation) without ever getting
 * stuck fishing for a lone stray card's one specific match. `altColorRunLengthAtTop` measures that
 * "coherent, foundation-feedable asset" - unlike Spider's `runLengthAtTop` (raw face-up count),
 * which isn't a scarce resource in Yukon at all, since any face-up count is already freely movable
 * regardless of order. The move is scored by comparing the best genuinely-valid run left standing
 * anywhere after the move (whatever it builds at the destination, or whatever coherent run is left
 * behind at the source once `count` cards leave) against what was already there before the move -
 * the same opportunity-cost shape Spider uses, just measuring a different asset. Because Yukon's own
 * moving group need not itself be internally valid (unlike Spider, where `tryMove` requires the
 * whole group to already be a same-suit run), this recomputes each run length directly off the
 * hypothetical resulting piles rather than assuming a simple `count + existing` sum - a jumbled
 * group (e.g. a black 8 with a red King sitting on top of it) only ever contributes its own
 * top-down valid prefix to whichever pile it lands in, not its full physical size. "Before" counts
 * BOTH touched columns (the destination's own run too), exactly like "after" does, so a move and its
 * exact reverse always score as opposites and a relocation that gains nothing scores 0: the old
 * version counted only the source's run before, so moving a card from one matching card to an equal
 * one scored above 0 both ways and Hint offered it, then offered moving it straight back.
 *
 * Reveal-of-a-hidden-card and empty-column economics both still apply exactly as they do everywhere
 * else in this app (long Yukon columns with several face-down cards, and only 7 scarce columns
 * total, make both matter a lot) - same shape and same weights as Spider's scorer for both terms.
 * The weights are bounds-checked the same way: Yukon's longest column ever reachable is 11 cards, so
 * `netRunStructureChange` (at most 11) times 30 tops out at 330 - comfortably under the 500-point
 * reveal bonus, so a reveal always outranks pure structural play regardless of board specifics. The
 * per-card size tiebreak is only added to a move that already gains something, so it never lifts a
 * relocation above 0.
 */
function scoreHintMove(state: YukonState, move: Move): number {
  if (move.from.zone !== 'tableau' || move.to.zone !== 'tableau') return 0
  const fromCol = state.tableau[move.from.index]
  const toCol = state.tableau[move.to.index]
  if (!fromCol || !toCol) return 0

  const group = fromCol.slice(fromCol.length - move.count)
  const remainder = fromCol.slice(0, fromCol.length - move.count)

  const runBefore = Math.max(altColorRunLengthAtTop(fromCol), altColorRunLengthAtTop(toCol))
  const runAfterDest = altColorRunLengthAtTop([...toCol, ...group])
  const runAfterRemainder = altColorRunLengthAtTop(remainder)
  const netRunStructureChange = Math.max(runAfterDest, runAfterRemainder) - runBefore

  const fromBecomesEmpty = move.count === fromCol.length
  const toWasEmpty = toCol.length === 0
  const netEmptyDelta = (fromBecomesEmpty ? 1 : 0) - (toWasEmpty ? 1 : 0)

  const newFromTop = remainder[remainder.length - 1]
  const revealsHiddenCard = newFromTop !== undefined && !newFromTop.faceUp

  let score = revealsHiddenCard ? 500 : 0
  score += netRunStructureChange * 30
  score += netEmptyDelta * 40
  // The size tiebreak only orders moves that already gain something.
  if (score <= 0) return score
  return score + move.count * 2
}

export function createYukonController(): GameController<YukonState> {
  function newGame(seed: number): YukonState {
    const deck = shuffledDeck(seed, 1)
    let cursor = 0
    const tableau: Card[][] = []

    // Phase 1: the Klondike-shaped base triangle - column `col` gets `col + 1` cards, only the
    // last one face up (28 cards total).
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

    // Phase 2: the remaining 24 cards, dealt face up, 4 more onto each of columns 2-7 (index
    // 1..6) - column 1 (the first) stays at its base size of 1. Final sizes: 1,6,7,8,9,10,11.
    for (let col = 1; col < 7; col++) {
      for (let i = 0; i < 4; i++) {
        const card = deck[cursor++]
        tableau[col].push({ ...card, faceUp: true })
      }
    }

    const foundation: Card[][] = [[], [], [], []]
    return { tableau, foundation }
  }

  function tryMove(state: YukonState, move: Move): YukonState | null {
    const { from, to, count } = move
    if (count < 1) return null
    if (from.zone === to.zone && from.index === to.index) return null
    // A foundation's top card may come back down onto the tableau, one card at a time (as in Klondike - see its tryMove).
    // Never onto another foundation, and legalMoves never offers it, so Hint can't suggest it.
    if (from.zone === 'foundation' && (to.zone !== 'tableau' || count !== 1)) return null

    const sourcePile = getPile(state, from)
    if (!sourcePile || sourcePile.length < count) return null

    // Only tableau moves may carry more than one card.
    if (count > 1 && from.zone !== 'tableau') return null

    const movingCards = sourcePile.slice(sourcePile.length - count)
    if (movingCards.some((c) => !c.faceUp)) return null

    // Unlike Klondike, no run-validity check here - Yukon lets you move any face-up card together
    // with everything stacked above it, in its current order, regardless of whether that stack is
    // itself a valid alternating-color run.

    const destPile = getPile(state, to)
    if (!destPile) return null

    if (to.zone === 'tableau') {
      if (!canPlaceOnTableau(destPile, movingCards)) return null
    } else if (to.zone === 'foundation') {
      if (count !== 1) return null
      const movingCard = movingCards[0]
      if (suitIndex(movingCard.suit) !== to.index) return null
      if (!canPlaceOnFoundation(destPile, movingCard)) return null
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
    }

    return next
  }

  function isWon(state: YukonState): boolean {
    return state.foundation.every((pile) => {
      const t = top(pile)
      return t !== undefined && t.rank === 13
    })
  }

  function legalMoves(state: YukonState): Move[] {
    const moves: Move[] = []

    const tryAdd = (from: PileRef, to: PileRef, count: number) => {
      const result = tryMove(state, { from, to, count })
      if (result) moves.push({ from, to, count })
    }

    for (let col = 0; col < 7; col++) {
      const pile = state.tableau[col]
      if (pile.length === 0) continue
      // The whole contiguous face-up region at the top is a legal group - no run-validity check,
      // unlike Klondike's equivalent walk.
      let runStart = pile.length - 1
      while (runStart > 0 && pile[runStart - 1].faceUp) {
        runStart -= 1
      }
      const from: PileRef = { zone: 'tableau', index: col }
      // single top card -> foundation
      for (let f = 0; f < 4; f++) tryAdd(from, { zone: 'foundation', index: f }, 1)
      // every group size through the face-up region -> the single best other tableau column, using
      // the exact same candidate filter + pickBestTableauTarget call autoMoveHint uses below, so a
      // move surfaced here (e.g. for the Hint button) always matches where tapping that card
      // actually sends it. Previously this enumerated EVERY legal destination column, which let
      // Hint highlight a different column than tap-to-move would pick for the same card.
      for (let count = 1; count <= pile.length - runStart; count++) {
        const movingCards = pile.slice(pile.length - count)
        const candidates = state.tableau
          .map((destPile, index) => ({ index, pile: destPile }))
          .filter((c) => c.index !== col)
          .filter((c) => canPlaceOnTableau(c.pile, movingCards))
        const best = pickBestTableauTarget(candidates, alwaysValidRun)
        if (best) tryAdd(from, { zone: 'tableau', index: best.index }, count)
      }
    }

    return moves
  }

  function autoMoveHint(state: YukonState, from: PileRef, cardId: string): Move | null {
    const pile = getPile(state, from)
    if (!pile) return null
    const cardIndex = pile.findIndex((c) => c.id === cardId)
    if (cardIndex === -1) return null
    const movingCards = pile.slice(cardIndex)
    if (movingCards.some((c) => !c.faceUp)) return null
    const count = movingCards.length
    if (count > 1 && from.zone !== 'tableau') return null

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
    const best = pickBestTableauTarget(candidates, alwaysValidRun)
    if (!best) return null
    return { from, to: { zone: 'tableau', index: best.index }, count }
  }

  /** Every card currently reachable - each tableau column's top card - for the
   * auto-play-to-foundation feature (see engine/autoFoundation.ts). No stock/waste in Yukon. */
  function accessibleCards(state: YukonState): AccessibleCard[] {
    const result: AccessibleCard[] = []
    state.tableau.forEach((pile, index) => {
      const t = top(pile)
      if (t && t.faceUp) result.push({ ref: { zone: 'tableau', index }, card: t })
    })
    return result
  }

  return {
    id: 'yukon',
    title: 'Yukon',
    newGame,
    legalMoves,
    tryMove,
    isWon,
    autoMoveHint,
    accessibleCards,
    scoreHintMove
  }
}

/**
 * True once the board is SOLVED - what lets the finish (games/shared/useAutoFinish) file the rest away on its own:
 * not won yet, nothing hidden (every tableau card face up; Yukon has no stock, waste or reserve), and every remaining
 * card able to go up by foundation moves alone. Each clause matters: isFullyAutoCompletable is true on a won board
 * (there is nothing left to do), and it PEEKS - its simulated moves turn each card they uncover face up, so on its own
 * it can say yes while face-down cards remain, and starting the finish then would give away what is under them.
 * `controller` is the screen's own (createYukonController).
 */
export function canAutoFinish(controller: GameController<YukonState>, state: YukonState): boolean {
  return !controller.isWon(state) && state.tableau.every((column) => column.every((c) => c.faceUp)) && isFullyAutoCompletable(controller, state)
}

/** The next card the finish sends up, and its own suit's foundation - or null if there is none (won, or not solved). */
export function nextFinishMove(controller: GameController<YukonState>, state: YukonState): FinishMove | null {
  if (!canAutoFinish(controller, state)) return null
  const entry = nextAutoCompleteMove(controller, state)
  return entry ? { entry, to: { zone: 'foundation', index: suitIndex(entry.card.suit) } } : null
}
